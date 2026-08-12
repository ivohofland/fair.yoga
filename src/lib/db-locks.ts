import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';

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
 *   adopt  `lockClassRow`, `setLockTimeout` and `lockAnnouncementSlot` below.
 *   adopt  `claimTemplateForGeneration` (`class-generator.ts`) and
 *          `claimStudioTemplateForGeneration` (`studio-class-generator.ts`) —
 *          each issues `LOCK_TIMEOUT_SQL` and then a `FOR UPDATE`.
 *   adopt  `withdrawWaitingEntriesForTeacher` (`waitlist.ts`) — `FOR UPDATE
 *          OF c` inside the statement that selects the rows, with the
 *          `updateMany` and reorder that lock exists to protect after it.
 *   skip   `activateRegistration`, `hasActiveRegistration` and
 *          `reorderWaitingEntries` (`waitlist.ts`), and
 *          `resolveInvitationOnLink` (`link-consent.ts`) — none issues a
 *          `SET LOCAL` or a row lock, so none has anything that can
 *          evaporate. They still belong inside their callers' transactions.
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
 * `Class` row lock deadlock against each other today (`docs/lock-order.md`,
 * "The two that do not"), and reasoning about which side loses that race
 * assumes both sides wait the same length of time.
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
 * which needs the bound whether or not it ends up locking anything: its
 * lock loop runs only when the erased student is waiting in at least one
 * class, so before this existed, a student waiting in zero classes got an
 * UNBOUNDED wait on a contended `registration.updateMany` — and that
 * asymmetry made the transaction's own `Math.min` ceiling a wish rather than
 * a guarantee, since Prisma's interactive-transaction timeout cannot roll
 * back a statement already blocked inside Postgres, only refuse to start a
 * new one.
 */
export async function setLockTimeout(tx: TransactionClientOnly): Promise<void> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
}

/**
 * Takes the `Class` row lock with a bounded wait.
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
 * every statement left in that transaction, not just the `FOR UPDATE`
 * immediately below it, and resets on `COMMIT` or `ROLLBACK` regardless of
 * how the transaction ends — the same effect `studio-class-template-
 * lifecycle.ts` documents around its own `SET LOCAL lock_timeout`. In
 * `completeClass` that also caps the `registration.update` / `payment.create`
 * loop that follows, which is harmless — those never wait on a lock. Verified
 * in psql that a second `SET LOCAL lock_timeout` later in the same
 * transaction simply overwrites the first rather than erroring or stacking,
 * so calling this helper more than once per transaction is safe on that
 * axis. It is not free on every axis: a caller that calls it in a loop puts
 * each iteration's own lock wait under the same 2s cap inside a transaction
 * Prisma itself caps at 5s by default, so a handful of contended iterations
 * can exhaust the transaction's whole budget well before any single one of
 * them hits its own timeout. `deleteStudentAccount` (`gdpr.ts`) is exactly
 * this caller, added in #174 Task 5 — its call site sizes the erasure
 * transaction's own `timeout` to the number of classes it is about to lock
 * rather than trusting the 5s default; the arithmetic lives there, not
 * here.
 *
 * The bound itself is `LOCK_TIMEOUT_SQL` above, shared with the two
 * template-claim sites (`claimTemplateForGeneration`,
 * `claimStudioTemplateForGeneration`) — the only other bounded lock waits in
 * the codebase, and the ones this lock deadlocks against.
 *
 * Five pre-existing `FOR UPDATE` sites deliberately do NOT use this and keep
 * their inline SQL: four in `waitlist.ts` (`addToWaitlist`, `promoteNext`,
 * `claimSpot`, `withdrawWaitingEntriesForTeacher`), one in `POST
 * /api/registrations`. All five take an unbounded wait, which is #104's
 * subject, and retrofitting them from here would blur what that issue is
 * accountable for. This helper takes the bound instead because not every
 * caller that will end up sharing it can afford an unbounded one:
 * `deleteStudentAccount`'s erasure transaction is time-bound by GDPR's own
 * clock, and an unbounded block there on a row the 60-second transitions
 * sweep can hold would hang a legally time-bound operation. That caller
 * landed in #174 Task 5. The three call sites this issue's plan intended for
 * this helper all exist: `completeClass` below was the first,
 * `removeFromWaitlist` (`waitlist.ts`) picked it up next, and
 * `deleteStudentAccount` (`gdpr.ts`) — called once per class it is about to
 * renumber — was the last of the three. A fourth arrived afterward, outside
 * the plan: `autoCancelClasses` (`class-transitions.ts`), added by #174 Task
 * 6's round 1 review once moving its registration count inside the
 * transaction turned a CAS-only decision into one that reads more state
 * under the lock. Not the only callers this helper exists to serve, either:
 * nothing about it restricts it to these four.
 *
 * Must be given a transaction client for the lock to have anywhere to live —
 * see the brand paragraph above for what enforces that at compile time.
 */
export async function lockClassRow(tx: TransactionClientOnly, classId: string): Promise<void> {
  await setLockTimeout(tx);
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
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
 * module is safe to import from a test because it pulls in only `crypto` and a
 * Prisma type — never `@/lib/log`, which is pino and server-only.
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

/** The low 32 bits of a SHA-256, signed, so it fits Postgres's `int4`. */
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
 * reason this is a lock and not a unique index on a hashed column:
 * `Announcement.message` is `@db.Text` and cannot be a btree key, so an
 * index-based design would have to key on the hash, where a collision silently
 * rejects a legitimate announcement instead. A time-bucketed index leaks
 * differently again — two sends straddling a bucket edge both pass.
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
 * and it is safe only because it has exactly one caller: nothing else can hold
 * a `Class` lock and then wait here. See "The announcement advisory lock"
 * there before adding a second call site.
 *
 * The lock call is wrapped in a subselect and the outer projection is a
 * literal, which is not styling: `pg_advisory_xact_lock` returns `void`, and
 * selecting that column directly fails at the client with
 * `P2010 … Failed to deserialize column of type 'void'` — measured, not
 * guessed. A tagged `$queryRaw` is still the right tool (the two ints are
 * bound parameters, so nothing here is interpolated); only the column it
 * hands back had to change.
 */
export async function lockAnnouncementSlot(
  tx: TransactionClientOnly,
  key: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM (
      SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE.announcement}::int4, ${hash32(key)}::int4)
    ) AS taken`;
}
