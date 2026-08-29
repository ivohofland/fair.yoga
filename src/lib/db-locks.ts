import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * A Prisma client that must be an interactive transaction client, never the
 * bare `PrismaClient`.
 *
 * See `lockClassRow`'s docblock for what the brand is doing and why
 * `Prisma.TransactionClient` alone does not do it. The rule that follows from
 * it: a function needs this brand when it issues a statement whose effect is
 * scoped to the surrounding transaction — `SET LOCAL`, a row lock or a
 * transaction-scoped advisory lock — since that is the thing a bare client
 * makes evaporate silently. Sufficient, not necessary: a helper that only
 * reads can still be wrong on a bare client, by reading around its caller's
 * uncommitted writes. Decided per site, not uniformly:
 *
 *   adopt  `lockClassRow`, `lockClassRowsOrdered`, `setLockTimeout` and
 *          `lockAnnouncementSlot` below.
 *   adopt  `claimRuleForGeneration` (`entry-generation.ts`) — issues
 *          `LOCK_TIMEOUT_SQL` and then a `FOR UPDATE`, for either template
 *          family from the one statement.
 *   adopt  `claimTemplateForGeneration` (`class-generator.ts`) and
 *          `claimStudioTemplateForGeneration` (`studio-class-generator.ts`)
 *          — the two per-family names for the entry above, one line each.
 *          Branded even though neither issues anything itself: they pass
 *          `tx` straight on, so a bare client reaching either evaporates the
 *          lock one call deeper, where the brand can no longer refuse it.
 *   adopt  `withdrawWaitingEntriesForTeacher` (`waitlist.ts`) — calls
 *          `lockClassRowsOrdered` below, `FOR UPDATE
 *          OF c` inside the statement that selects the rows, with the
 *          `updateMany` and reorder that lock exists to protect after it.
 *   adopt  `readSeatCount` (`services/capacity.ts`) — the exception to the
 *          rule above and the reason the rule says "decided per site": it
 *          issues no transaction-scoped statement, only reads. It is branded
 *          because its whole purpose is counting UNDER the caller's lock, and
 *          on a bare client it would count outside it — the "reading around
 *          its caller's uncommitted writes" case this register names.
 *   adopt  `closeQueueOnStart` (`waitlist.ts`) — issues no `SET LOCAL` and
 *          takes no row lock of its own, which is exactly why it is branded:
 *          it is a WRITE that trusts its caller to be holding the `Class` row
 *          lock already (`lockClassRow`, or the CAS `UPDATE` in
 *          `transitionClass`). On a bare client that trust is silently void —
 *          the close would commit in its own autocommit transaction, separate
 *          from the status flip it must be atomic with.
 *   skip   `activateRegistration`, `hasActiveRegistration` and
 *          `reorderWaitingEntries` (`waitlist.ts`), and
 *          `resolveInvitationOnLink` (`link-consent.ts`) — none issues a
 *          `SET LOCAL` or a row lock, so none has anything that can
 *          evaporate. They still belong inside their callers' transactions.
 *   skip   `createBulkNotifications` (`notifications.ts`) — one `createMany`
 *          and a bus emit, no transaction-scoped statement, so the rule says
 *          leave it unbranded. Named here rather than left out because this
 *          register is read as complete: it takes `PrismaClient |
 *          Prisma.TransactionClient` and is called BOTH ways — inside the
 *          announcement transaction beside `lockAnnouncementSlot` (#196) and
 *          on the bare client elsewhere — so its absence would read as an
 *          oversight rather than a decision. Branding it would break every
 *          bare-client caller for no protection gained.
 *   skip   `generateInstancesForTemplate` (`class-generator.ts`) and
 *          `generateStudioInstancesForTemplate` (`studio-class-generator.ts`)
 *          — same signature shape as the entry above and called both ways, so
 *          they belong here for the same "read as complete" reason. Neither
 *          issues a `SET LOCAL` or a row lock ITSELF; each delegates that to
 *          the claim helper above it, which is branded. Added when #212's
 *          review found the register naming one of the three
 *          `PrismaClient | Prisma.TransactionClient` helpers and not the other
 *          two — the completeness failure this entry's own wording warns about.
 *
 * `waitlist.ts` reaches its own helpers through a module-local alias. The
 * parameter is changed at the one adopting site rather than re-pointing that
 * alias, which would have branded the three skipped ones by side effect.
 */
export type TransactionClientOnly = Prisma.TransactionClient & { $transaction?: never };

/**
 * How long any bounded wait in this project waits for a row lock before
 * giving up.
 *
 * A literal, not a bound parameter: Postgres does not accept bind parameters
 * in `SET`. It is interpolated from this constant only — never from input —
 * which is why the `$executeRawUnsafe` below is safe.
 *
 * Lives here rather than in each caller because it had drifted into three
 * separate copies of the same string literal (this module and the two
 * template-claim sites), and a bound that is silently different in one place
 * is worse than one that is uniformly wrong: the two template claims and the
 * `Class` row lock are ordered in opposite directions (`docs/lock-order.md`,
 * "Known violation, not fixed here" — the `{Class, ClassTemplate}`
 * inversion), and reasoning about which side loses that race assumes both
 * sides wait the same length of time.
 */
export const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";

/**
 * Bounds every remaining statement in `tx` to the shared lock timeout,
 * without taking any lock itself.
 *
 * `SET LOCAL` is transaction-scoped, so this governs the whole rest of the
 * transaction and resets on `COMMIT` or `ROLLBACK` however it ends. Calling
 * it more than once is safe — verified in psql that a later `SET LOCAL
 * lock_timeout` overwrites the earlier one rather than erroring or stacking
 * — which is what lets `lockClassRow` below issue it per call while a caller
 * also issues it once up front.
 *
 * Split out from `lockClassRow` for `deleteStudentAccount` (`gdpr.ts`),
 * which needs the bound whether or not it ends up locking anything: before
 * #216/#182 replaced its per-class `lockClassRow` loop with the ordered
 * statement `lockClassRowsOrdered` issues below, that loop's body ran only
 * when the erased student was waiting in at least one class, so a student
 * waiting in zero classes got an UNBOUNDED wait on a contended
 * `registration.updateMany` — and that asymmetry made the transaction's
 * own budget a wish rather than a guarantee, since Prisma's
 * interactive-transaction timeout cannot roll back a statement already
 * blocked inside Postgres, only refuse to start a new one.
 */
export async function setLockTimeout(tx: TransactionClientOnly): Promise<void> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
}

/**
 * Takes the `Class` row lock AND its `CalendarEntry` row lock, in that order,
 * each with a bounded wait.
 *
 * BOTH, because #327 moved `date`, `startTime` and `durationMinutes` off
 * `Class` and onto its entry. `completeClass` (`class-lifecycle.ts`) decides
 * `NOT_ENDED_YET` from those three, and `updateClass` used to serialise
 * against that decision for free — it took no lock, but its plain `UPDATE`
 * landed on the same row the completion held. After the split that free lock
 * covers the wrong table, and #182 comes back: a class completed against a
 * start time it no longer had, with `Payment` rows to show for it. `updateClass`
 * now calls this helper rather than relying on that emergent order.
 *
 * TWO STATEMENTS NAMING TWO TABLES, not one join. `FOR UPDATE OF e` on a joined
 * query locks only `e`, and a statement that waited on the join's non-locked
 * member has already evaluated its predicate against the pre-wait snapshot —
 * `EvalPlanQual` re-fetches locked rows only. Stage A measured that 6/6.
 *
 * `Class` first, then `CalendarEntry`. Every writer that takes both must take
 * them in this order, `class_sync_entry_completed` (the trigger, which fires on
 * `Class` and writes the entry) included; `docs/lock-order.md` carries the rule.
 *
 * `tx`'s type carries an extra `{ $transaction?: never }` brand on top of
 * `Prisma.TransactionClient`, and that brand is load-bearing, not
 * decorative: `Prisma.TransactionClient` is `Omit<PrismaClient,
 * ITXClientDenyList>`, and `Omit` only drops members from the *type* — a
 * bare `PrismaClient` still has every one of them at runtime, so it remains
 * structurally assignable to `Prisma.TransactionClient` with no cast. Passing
 * one in would compile cleanly and fail silently: on a bare `PrismaClient`
 * each statement is its own autocommit transaction, so `SET LOCAL` and `FOR
 * UPDATE` would each apply to a transaction that no longer exists by the time
 * the caller's next statement runs, protecting nothing. A real interactive
 * transaction client has no `$transaction` method at all (that is what
 * `ITXClientDenyList` removes), so `$transaction?: never` costs it nothing;
 * `PrismaClient` has one, and a method is never assignable to `never`, so
 * `lockClassRow(prisma, classId)` — the full client — is now a compile
 * error: `Argument of type 'PrismaClient<...>' is not assignable to
 * parameter of type 'TransactionClient & { $transaction?: undefined; }'`.
 * That was originally verified with a throwaway call site that was then
 * deleted, which threw the verification away with it; `db-locks.test.ts`
 * now keeps it permanently, as a `// @ts-expect-error` on a never-called
 * function — `tsconfig.json` includes every `.ts` file in the repo, test
 * files among them, so weakening the brand is a failing `tsc --noEmit`
 * rather than a silently-passing suite.
 *
 * `SET LOCAL` scopes the timeout to the calling transaction: it governs
 * every statement left in that transaction, not just the two `FOR UPDATE`s
 * below it, and resets on `COMMIT` or `ROLLBACK` regardless of
 * how the transaction ends — the same effect `studio-class-template-
 * lifecycle.ts` documents around its own `SET LOCAL lock_timeout`. In
 * `completeClass` that also caps the `registration.update` / `payment.create`
 * loop that follows, which is harmless — those never wait on a lock. Verified
 * in psql that a second `SET LOCAL lock_timeout` later in the same
 * transaction simply overwrites the first rather than erroring or stacking,
 * so calling this helper more than once per transaction is safe on that
 * axis. It is not free on every axis: a caller that called it in a loop
 * would put each iteration's own lock wait under the same 2s cap inside one
 * transaction, so a handful of contended iterations could exhaust that
 * transaction's whole budget well before any single one of them hit its own
 * timeout. No caller does that today, and the near-miss is worth naming:
 * `autoCancelClasses` and its sibling sweep (`class-transitions.ts`) walk
 * many classes, but give each its OWN transaction, so nothing accumulates —
 * see that file's docblock, which argues the same point from the other
 * side. `deleteStudentAccount` (`gdpr.ts`) WAS this caller, from #174 Task 5
 * until #216/#182 replaced the loop with one ordered statement; it now
 * takes its locks through `lockClassRowsOrdered` below and carries a flat
 * `{ timeout: 20_000 }` rather than a budget sized from a count (#240
 * removed the sizing term, because it counted `waiting` entries while the
 * lock set spans every status, and priced none of the reorder loop). The
 * reasoning lives there, not here.
 *
 * The bound itself is `LOCK_TIMEOUT_SQL` above, shared with every other site
 * that bounds a lock wait — `claimRuleForGeneration` (`entry-generation.ts`)
 * among them, which is the one this lock deadlocks against. No roster here;
 * derive it, and derive it FILTERED, for the reason the `FOR UPDATE` check
 * below spells out about its own filters — unfiltered, the needle is mostly
 * test files, prose, and this docblock quoting itself:
 *
 *   grep -rn 'setLockTimeout\|LOCK_TIMEOUT_SQL' src/ --include='*.ts' \
 *     | grep -v "\.test\.ts:" \
 *     | grep -vE ":[0-9]+: *(\*|//)" \
 *     | grep -vE ":[0-9]+:import "
 *
 * The comment filter is what drops this paragraph's own quotation; the
 * `import` one drops the lines that name the helper without issuing it. What
 * survives is the constant, the helper that issues it, and the call sites —
 * which is the question a reader has. The expected line count lives in
 * `docs/lock-order.md`, "Every site that bounds a lock wait", which runs the
 * identical command and owns its figure; the same division of labour the
 * `FOR UPDATE` check below already uses.
 *
 * Every `SELECT … FOR UPDATE` on a `Class` or `CalendarEntry` row goes through
 * this function or `lockClassRowsOrdered` below now — no site keeps its own
 * inline statement. The check, with the template tables filtered OUT rather
 * than counted alongside, because they are what an unfiltered grep is mostly
 * made of. No total over both is kept here — `docs/lock-order.md`, "How that
 * enumeration was derived", owns that figure and ships the command that
 * re-derives it:
 *
 *   grep -rn "FOR UPDATE" src/ --include='*.ts' | grep -v "\.test\.ts:" \
 *     | grep -vE ":[0-9]+: *(\*|//)" \
 *     | grep -vE 'OF (ct|sct|tpl)`|"ClassTemplate"|"StudioClassTemplate"|family\.childTable'
 *
 * That last alternative earns its place: `archiveOrUnarchiveRule` and
 * `pauseOrResumeRule` (`rule-lifecycle.ts`) each lock the child template row
 * for both families from one statement, splicing the table name in from the
 * family descriptor, so the literal table names never appear at those sites
 * and the filter has to match the splice instead. Qualified —
 * `family.childTable`, not the bare token — so the alternative matches that
 * splice as written and nothing else: a bare one would also swallow a `FOR
 * UPDATE` line that merely mentions a same-named property somewhere else,
 * which is a hit this register exists to show rather than hide. Without the
 * alternative at all, a template-row lock shows up here as if it were a
 * `Class` one.
 *
 * `tpl` in the FIRST alternative is the same problem one statement further on:
 * `claimRuleForGeneration` (`entry-generation.ts`) splices its table name in
 * too, several lines above its own `FOR UPDATE OF`, so the alias is all this
 * line-by-line filter has left to match on — which is why that statement may
 * not call its child row `c`. `ct` and `sct` are the aliases `gdpr.ts`'s bulk
 * archive still uses for the same two tables.
 *
 * What that settles is a PROPERTY, not a number: every `Class` and
 * `CalendarEntry` row lock in `src/` is one of this file's own statements —
 * this helper's two and `lockClassRowsOrdered`'s two. A hit in another file is
 * a site that took one of those locks without going through either helper,
 * bar one standing exception that this line-by-line filter cannot exclude and
 * that is not a `Class` lock at all. The expected line count and that
 * exception both live in `docs/lock-order.md`, "Ordering BETWEEN `Class` and
 * its `CalendarEntry`", which runs the identical command and owns its figures.
 * Deliberately not a list of the CALL SITES, which is what went stale the last
 * time this paragraph carried one.
 *
 * `withdrawWaitingEntriesForTeacher` (`waitlist.ts`) adopting
 * `lockClassRowsOrdered` below (#237) was a real behaviour change on the
 * unlink path, worth keeping on record: `unlinkTeacher` (`invitations.ts`) is
 * the single production caller, so `DELETE /api/teacher-links/[teacherId]`
 * can now answer 503 where it used to block and succeed. Acceptable on the
 * same argument `api-errors.ts` already makes for the "leave waitlist" tap —
 * `withErrorHandler` routes the `55P03` through `isTransientDbError` to a
 * retryable 503 with advice, which beats an unbounded block on a row the
 * 60-second transitions sweep can hold.
 *
 * This helper takes the bound instead because not every
 * caller that will end up sharing it can afford an unbounded one:
 * `deleteStudentAccount`'s erasure transaction is time-bound by GDPR's own
 * clock, and an unbounded block there on a row the 60-second transitions
 * sweep can hold would hang a legally time-bound operation.
 *
 * Its callers are not listed here any more, and the reason is the point of
 * #237. They were, and the list went stale the way every list in this
 * codebase's lock documentation has: `deleteStudentAccount` was named as a
 * caller long after #216/#182 replaced its `lockClassRow` loop with a single
 * ordered statement, and `autoTransitionToInProgress` was never named at all.
 * The COUNT stayed five throughout — five names, five call sites — so nothing
 * that counted could catch it; only re-deriving the names could. Grep for
 * `lockClassRow(` when you need them.
 *
 * Must be given a transaction client for the lock to have anywhere to live —
 * see the brand paragraph above for what enforces that at compile time.
 */
export async function lockClassRow(tx: TransactionClientOnly, classId: string): Promise<void> {
  await setLockTimeout(tx);
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
  await tx.$queryRaw`
    SELECT e.id FROM "CalendarEntry" e
    JOIN "Class" c ON c."calendarEntryId" = e.id
    WHERE c.id = ${classId}
    FOR UPDATE OF e`;
}

/**
 * Locks many `Class` rows in one statement, ascending by id, with a bounded
 * wait — and hands back the ids it holds.
 *
 * This is the only production `SELECT … FOR UPDATE OF c` in `src/`. Before
 * #237 there were four, plus a fifth site that took its locks through a
 * per-class CAS loop, and which sites those were was tracked in prose:
 * a five-row table in `docs/lock-order.md` and the register above. That table
 * was corrected about its own membership four times — most recently by the
 * round that filed this issue, which added `deleteStudentAccount`'s statement
 * to the table and not to the derivation below it. A convention tracked by
 * prose goes stale; this function is the convention.
 *
 * FOUR things are deliberately here rather than at the call sites, because
 * each is a thing a call site got wrong at least once in this codebase's
 * history:
 *
 *   `ORDER BY c.id` — two transactions taking the same pair of `Class` rows
 *     in opposite sequences is an AB-BA cycle, and Postgres resolves it by
 *     killing one side with `40P01`. Reproduced for real in issue 180 and
 *     again in #174's whole-branch review. Pinned by
 *     `db-locks-lock-order.test.ts`, which contends two DIFFERENT query plans
 *     over the same rows — two callers sharing one predicate produce one plan,
 *     scan one physical order, and serialise with or without this clause, so
 *     a same-predicate pairing could never have pinned it.
 *
 *   `FOR UPDATE OF c` — never a bare `FOR UPDATE`, which on a joined query
 *     also locks the `WaitlistEntry` rows and adds wait edges
 *     `docs/lock-order.md` does not model.
 *
 *   `setLockTimeout` — the shared 2s bound, so no adopting transaction can
 *     block indefinitely on a row the 60-second transitions sweep holds. It
 *     governs the whole rest of the caller's transaction, not just this
 *     statement; `SET LOCAL` is transaction-scoped and resets on COMMIT or
 *     ROLLBACK however the transaction ends. Callers that also issue it
 *     themselves are safe — a later `SET LOCAL lock_timeout` overwrites the
 *     earlier one rather than stacking.
 *
 *     PER ACQUISITION, NOT PER STATEMENT, and a caller sizing a transaction
 *     budget around this needs the difference. Postgres arms `lock_timeout`
 *     separately for each lock this statement waits on, so locking N contended
 *     rows here can spend up to N × 2s in total while no single wait ever
 *     exceeds the bound. Measured on 2026-08-16: two rows held by sessions
 *     releasing at 1.5s and 3.0s, one waiter at `lock_timeout='2s'` taking
 *     both in one statement, succeeded after 2.67s. "Bounded" here means no
 *     wait is unbounded — it does NOT mean the statement is O(1) in N. What
 *     this helper collapses to O(1) is ROUND TRIPS, not waiting.
 *
 *   the dedupe — Postgres refuses `DISTINCT` alongside `FOR UPDATE`, so a
 *     join matching one class twice hands back two ids for one locked row.
 *     Order is preserved: `Set` iterates in insertion order and the rows
 *     arrive ascending.
 *
 * The predicate is a composed `Prisma.Sql`, not a typed selector, and that was
 * the decision this issue existed to make. A union of typed selectors cannot
 * go stale — the compiler forces a member per site — but it IS the five-row
 * table re-expressed as a type, and it would make this module know every one
 * of its callers by name and carry their domain types. The predicate was never
 * what went stale; the site list was. A fragment is also not a loophole: a
 * caller that references `w.` without supplying a `join`, or writes its own
 * `ORDER BY` or `FOR UPDATE`, gets a SQL error, not a silently wrong lock.
 * Parameters are bound — `Prisma.sql` tagged templates merge their values into
 * this statement in source order, verified against Postgres — so nothing here
 * is interpolated unless a caller reaches for `Prisma.raw`, which in `src/` is
 * used only to render frozen, hard-coded status lists — never input. Grep
 * `Prisma.raw` rather than trusting a count here: an earlier version of this
 * sentence said "used once, for a frozen constant
 * (`SCHEDULED_STATUSES_SQL`)", and #237 added the second one
 * (`CANCELLABLE_STATUSES_SQL`, `gdpr.ts`) in the same commit that wrote the
 * sentence. The membership changed while the shape of the claim held, which is
 * the one error nothing that counts can catch.
 *
 * Returning the ids is not a convenience. It lets a caller scope its write to
 * `id: { in: … }` so the write set is a structural SUBSET of the lock set,
 * rather than a predicate re-evaluated later against whatever the table looks
 * like when the write runs — the difference `docs/lock-order.md` draws between
 * `withdrawWaitingEntriesForTeacher` (`waitlist.ts`), whose `updateMany` is
 * keyed on the ids this helper handed back, and the recurring-class archive,
 * whose `deleteMany` re-evaluates its own predicate when it runs. The archive
 * is two files: the call to this helper is in `CLASS_FAMILY.withdraw.around`
 * (`class-template-lifecycle.ts`), and the delete it brackets is the shared
 * one in `archiveOrUnarchiveRule` (`rule-lifecycle.ts`). Callers that do
 * not need them may ignore the return value; the lock is the point.
 *
 * `entries: true` ADDS the `CalendarEntry` rows, in a second statement, after
 * every `Class` lock — the same order and for the same reason `lockClassRow`
 * above takes its two. It is OPT-IN rather than automatic because widening
 * every call site by reflex adds wait edges nothing needs, and because the
 * answer is per-caller: ask it of the whole TRANSACTION, not of this
 * statement — does anything in it read or write the entry's `date`,
 * `startTime`, `durationMinutes` or `cancelledAt`?
 *
 * NO ROSTER HERE, for the reason the register above spends a paragraph on:
 * a caller list kept in this file goes stale, and nothing that counts can
 * catch it. Every call site instead carries its own written verdict, beside
 * the transaction the question is actually about. Re-derive the set —
 *
 *     grep -rn 'VERDICT (#327)' src
 *
 * — one hit per call site, plus the line above quoting its own needle.
 *
 * The second statement is scoped to the ids the FIRST one returned — a
 * structural subset, not a predicate re-evaluated later — so its join member
 * is a row this transaction already holds. That matters: `FOR UPDATE OF e`
 * locks only `e`, and a joined predicate over a non-locked member is
 * evaluated against a pre-wait snapshot that `EvalPlanQual` will not re-fetch.
 * Here there is nothing to re-fetch, because the `Class` side cannot change.
 *
 * NOT for single-row locks — use `lockClassRow` above. One row cannot be
 * ordered against itself, and that helper's signature says so.
 *
 * Branded `TransactionClientOnly` per this module's rule: on a bare client the
 * `SET LOCAL` and the `FOR UPDATE` would each land in their own autocommit
 * transaction and protect nothing. See `lockClassRow`'s docblock for why
 * `Prisma.TransactionClient` alone does not enforce that.
 */
export async function lockClassRowsOrdered(
  tx: TransactionClientOnly,
  source: { join?: Prisma.Sql; where: Prisma.Sql; entries?: boolean },
): Promise<string[]> {
  await setLockTimeout(tx);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM "Class" c
    ${source.join ?? Prisma.empty}
    WHERE ${source.where}
    ORDER BY c.id
    FOR UPDATE OF c
  `;
  const ids = [...new Set(rows.map((row) => row.id))];
  if (source.entries === true && ids.length > 0) {
    await tx.$queryRaw`
      SELECT e.id
      FROM "CalendarEntry" e
      JOIN "Class" c ON c."calendarEntryId" = e.id
      WHERE c.id IN (${Prisma.join(ids)})
      ORDER BY e.id
      FOR UPDATE OF e
    `;
  }
  return ids;
}

/**
 * How long an identical announcement suppresses a second send of itself.
 *
 * Two minutes: long enough to absorb a double-click and a retried request from
 * a flaky connection, short enough that a teacher who genuinely wants to say
 * the same thing again is not told no. The same quantity as
 * `MANUAL_REMIND_COOLDOWN_MS` (`services/payments.ts`), deliberately — one
 * concept, not two.
 *
 * It lives here, beside the lock that makes it enforceable, rather than in the
 * route: `tests/integration/announcements-api.test.ts` backdates a first send
 * by exactly this to prove a later identical one still goes out, and a test
 * that hard-codes `120000` drifts silently the day the window changes. This
 * module is safe to import from a test because it pulls in only `crypto`
 * and `@prisma/client` — never `@/lib/log`, which is pino and server-only. The
 * `Prisma` import became a VALUE import in #237 (`Prisma.empty`, spliced by
 * `lockClassRowsOrdered`), so this module now pulls the generated client into
 * whatever imports it. Checked at that time: no `'use client'` component
 * imports `@/lib/db-locks` — every importer is a service, an API route or a
 * test. Re-check before importing this module from a client component; a
 * bundled Prisma client is the same class of failure as a bundled pino.
 */
export const ANNOUNCEMENT_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Namespace for this project's advisory locks — the first argument of
 * Postgres's two-int `pg_advisory_xact_lock(int4, int4)`, which exists for
 * exactly this.
 *
 * Advisory locks share one global key space per database, so an unnamespaced
 * key is a key every future advisory lock in this codebase can collide with by
 * accident. Namespacing means a collision is only ever possible between two
 * users of the SAME namespace, where the consequence is understood.
 */
const ADVISORY_NAMESPACE = { announcement: 196 } as const;

/**
 * The LEADING 32 bits of a SHA-256, read big-endian and signed, so it fits
 * Postgres's `int4`. Bytes 0-3, not the low end — which matters only to
 * someone recomputing the key by hand to look a lock up in `pg_locks`.
 */
function hash32(value: string): number {
  return createHash('sha256').update(value).digest().readInt32BE(0);
}

/**
 * Serialises concurrent sends of one `(teacher, class, message)` for the rest
 * of the calling transaction.
 *
 * `pg_advisory_xact_lock`, never `pg_advisory_lock`: the transaction-scoped
 * variant releases on commit or rollback however the transaction ends, while
 * the session-scoped one would leak a held lock onto a pooled connection and
 * eventually wedge an unrelated request that never asked for it.
 *
 * The hash is used ONLY for mutual exclusion — the caller compares the real
 * message text afterwards — so a collision inside the namespace costs a few
 * milliseconds of needless serialisation and nothing else. That is the whole
 * reason this is a lock and not a unique index on a hashed column.
 * `Announcement.message` is `@db.Text` — indexable in principle, but a btree
 * entry cannot exceed roughly 2704 bytes and `createAnnouncementSchema`
 * (`lib/schemas.ts`) sets no maximum length, so a long announcement would fail
 * to index at insert time. An index-based design would therefore have to key
 * on a hash, where a collision silently rejects a legitimate announcement
 * instead of merely serialising it. A time-bucketed index leaks differently
 * again — two sends straddling a bucket edge both pass.
 *
 * Branded `TransactionClientOnly` per this module's rule: on a bare client the
 * lock would be taken and released by its own autocommit transaction before
 * the caller's next statement ran, protecting nothing.
 *
 * It is NOT free of the ordering obligation in `docs/lock-order.md`, and the
 * plan for #196 predicted it would be. Its transaction goes on to insert a
 * `Notification` carrying `relatedClassId` and an `Announcement` carrying
 * `classId`, each of which takes `FOR KEY SHARE` on the parent `Class` row —
 * that document's "fourth path". So this lock sits ABOVE `Class` in the order,
 * and it is safe only because it has exactly one PRODUCTION call site
 * (`api/announcements/route.ts`; `db-locks.test.ts` holds the rest, and none
 * of those takes a `Class` lock): nothing else can hold a `Class` lock and
 * then wait here. See "The announcement advisory lock" there before adding a
 * second one.
 *
 * The `FOR KEY SHARE` reasoning covers the worst case, which is the
 * class-scoped send. An all-students announcement carries `classId === null`
 * on both inserts and takes no `Class` lock at all.
 *
 * The lock call is wrapped in a subselect and the outer projection is a
 * literal, which is not styling: `pg_advisory_xact_lock` returns `void`, and
 * selecting that column directly fails at the client with
 * `P2010 … Failed to deserialize column of type 'void'` — measured, not
 * guessed. A tagged `$queryRaw` is still the right tool (the two ints are
 * bound parameters, so nothing here is interpolated); only the column it
 * hands back had to change.
 *
 * `slot` is the tuple, not a pre-composed key, and that is the point of the
 * signature. The caller's dedupe compare is a `findFirst` on exactly these
 * three columns, so the key and that predicate have to describe the same
 * thing — and when the caller composed the key itself, nothing said so.
 * Changing the composition without changing the predicate would have given
 * two identical sends two DIFFERENT locks: neither waits, each reads an empty
 * compare, and both fan out — the exact failure this lock exists to prevent,
 * reintroduced by an edit that looks local. Composing it here puts the
 * coupling in one place. The separator makes the key ambiguous for a message
 * containing `|`, which costs nothing: the key is only ever a mutual-exclusion
 * hash (see above), and the caller still compares the real column values.
 */
export async function lockAnnouncementSlot(
  tx: TransactionClientOnly,
  slot: { teacherId: string; classId: string | null; message: string },
): Promise<void> {
  const key = `${slot.teacherId}|${slot.classId ?? ''}|${slot.message}`;
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM (
      SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE.announcement}::int4, ${hash32(key)}::int4)
    ) AS taken`;
}
