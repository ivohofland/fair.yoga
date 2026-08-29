/**
 * The per-rule generation both entry families share: the date maths that turns
 * a `ScheduleRule` into calendar dates, and the generator that fills them —
 * the entry layer's counterpart to `rule-lifecycle.ts`, which holds the rule
 * layer's own "written once for both families" logic.
 *
 * One-way import direction, and that is the invariant worth stating — not
 * the roster of who currently imports it, which grows as more shared logic
 * lands here and would go stale the moment a file was added: this module
 * must never import anything that imports it, so nothing above it can
 * complete a cycle back through here. Check membership against the compiler
 * rather than against this comment:
 *
 *   grep -rl "from '\./entry-generation'\|from '@/services/entry-generation'" src/ tests/ \
 *     | grep -v "^src/services/entry-generation"
 *
 * The second filter excludes this file (and its own test, which shares the
 * same path prefix): the pattern the first grep matches on is quoted from
 * this very docblock, so without the filter the command always matches
 * itself and answers one line longer than the real importer list.
 *
 * Imports `@/lib/log` (pino) directly, and `@/lib/timezone`, which imports it
 * too — so this module is server-only. Nothing under `'use client'` may
 * value-import it.
 */

import { Prisma } from '@prisma/client';
import type { ClassFamily, PrismaClient, ScheduleRule } from '@prisma/client';
import { spansOverlap } from '@/lib/generation';
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
import { probeOverlappingCandidates } from '@/lib/entry-conflict';
import { LOCK_TIMEOUT_SQL, type TransactionClientOnly } from '@/lib/db-locks';
import { classStartInstant, mondayOf } from '@/lib/timezone';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';

/**
 * A `ScheduleRule` as every joined read in this module returns it: with the one
 * `Teacher` column the date boundaries need.
 */
export type JoinedRule = ScheduleRule & { teacher: { defaultTimezone: string } };

/**
 * A child template with the calendar identity its rule holds, plus the one
 * `Teacher` column the date boundaries below need.
 */
export type ChildWithRule<TChild> = TChild & {
  scheduleRuleId: string;
  scheduleRule: JoinedRule;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The rolling window, in occurrences — four weeks (`CLAUDE.md`).
 *
 * `generateEntriesForRule` below reads it directly, for both families.
 * Exported because each family's `update…Template` reads it too, to build the
 * horizon it hands `probeFirstEffectiveWeek`, which deliberately looks TWICE
 * this far.
 * The asymmetry is the point rather than a disagreement: when all four of the
 * generator's weeks are held by the superseded schedule, the honest answer to
 * "when does this edit take effect" is week five, and no window this
 * generator can see contains it. Derived there rather than restated, so a
 * change to the window moves the prediction with it.
 */
export const DEFAULT_WEEKS = 4;

// ---------------------------------------------------------------------------
// getNextOccurrences
// ---------------------------------------------------------------------------

/**
 * Returns the next `weeks` occurrences of a given day-of-week starting
 * from (and including) `from`.
 *
 * @param dayOfWeek Schema convention: 0=Monday, 1=Tuesday, ..., 6=Sunday
 * @param from      Start date (time portion is ignored)
 * @param weeks     Number of occurrences to generate
 * @returns Array of Date objects with time set to 00:00:00.000 UTC
 */
export function getNextOccurrences(
  dayOfWeek: number,
  from: Date,
  weeks: number,
): Date[] {
  // Schema convention: 0=Mon, 1=Tue, ..., 6=Sun
  // JS getUTCDay():    0=Sun, 1=Mon, ..., 6=Sat
  // Convert schema day to JS day: jsDayOfWeek = (dayOfWeek + 1) % 7
  const jsDayOfWeek = (dayOfWeek + 1) % 7;

  // Start from midnight UTC of `from`
  const start = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );

  // Find the first occurrence on or after `start`
  const currentJsDay = start.getUTCDay();
  const daysUntilTarget = (jsDayOfWeek - currentJsDay + 7) % 7;
  // daysUntilTarget === 0 means `from` is already the target day — include it

  const firstOccurrence = new Date(start);
  firstOccurrence.setUTCDate(firstOccurrence.getUTCDate() + daysUntilTarget);

  const dates: Date[] = [];
  for (let i = 0; i < weeks; i++) {
    const date = new Date(firstOccurrence);
    date.setUTCDate(date.getUTCDate() + i * 7);
    dates.push(date);
  }

  return dates;
}

/**
 * Whether a class of this template already holds the WEEK containing `date`
 * (#194).
 *
 * One line, and extracted anyway — not because the expression is long, but
 * because two callers must never disagree about what makes a week
 * unavailable, and they are the two halves of a single promise to the teacher:
 * `generateEntriesForRule` below decides which dates the hourly sweep
 * actually fills, and `firstFreeWeek` — through `probeFirstEffectiveWeek`
 * further below — decides which week the teacher is TOLD it will fill. Two
 * copies of `heldWeeks.has(mondayOf(date))` is precisely how a sentence and a
 * behaviour drift apart, and the drift is invisible from either side: both
 * halves keep passing their own tests while saying different things.
 *
 * It is the definition of "held" that is shared here, not the decision. The
 * generator must name a *reason* for every candidate date it declines, and a
 * `Date | null` cannot carry one — see `firstFreeWeek` below, which records
 * why the plan's "one decision function, two callers" was corrected rather
 * than upheld.
 *
 * `heldWeeks` is a set of `mondayOf` values, and the two call sites —
 * `generateEntriesForRule`'s own loop and `probeFirstEffectiveWeek`, both in
 * this file — build it the same way: a `scheduleRuleId`-keyed `findMany` over
 * `CalendarEntry` with NO liveness filter, because a cancelled entry holds its
 * week
 * (`docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md` §3.2,
 * and `SkipReason`'s `already_this_week` in `@/lib/generation`). That
 * construction is the one half of "held" this function cannot enforce for
 * them.
 */
export function isWeekHeld(date: Date, heldWeeks: ReadonlySet<number>): boolean {
  return heldWeeks.has(mondayOf(date));
}

/**
 * The first candidate date whose week no class of this template already holds,
 * or `null` if every candidate's week is taken (#194).
 *
 * Pure. Its caller is `probeFirstEffectiveWeek`, further below in this file —
 * called in turn by each family's `update…Template`, deciding what to tell the
 * teacher.
 *
 * `generateEntriesForRule` below does NOT call it, and the plan's
 * "one function, two callers" line is corrected here rather than upheld: the
 * generator has to name a reason for EVERY candidate date, not find the first
 * free one, so a function that returns a single date cannot express its
 * answer. What the two genuinely share is the definition of "held", and since
 * #194's task 6 they share it as CODE rather than as a convention —
 * `isWeekHeld` above is called from here and from the generator's loop, and it
 * exists for no other reason. `resumeMessage`'s docblock records what the
 * alternative cost, where copy guessed at generator internals it did not share
 * and guessed wrong.
 *
 * The probe passes a LONGER candidate list than the generator's own
 * four-occurrence window, and that is the point rather than an inconsistency:
 * when all four of those weeks are held the honest answer is week five —
 * outside anything the generator can see.
 */
export function firstFreeWeek(
  candidates: readonly Date[],
  heldWeeks: ReadonlySet<number>,
): Date | null {
  for (const date of candidates) {
    if (!isWeekHeld(date, heldWeeks)) return date;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GeneratorFamily
// ---------------------------------------------------------------------------

/**
 * The noun a family's log lines use. A union rather than `string`: the
 * messages composed from it are what an operator greps for, and some are
 * asserted verbatim, so the roster belongs to the compiler rather than to a
 * sentence naming its members.
 *
 * ITS REACH IS NOT THIS FILE, and the property is the honest way to say so:
 * the field rides `GeneratorFamily`, so every module that holds a family
 * descriptor composes lines from it — the claim and the generator below, and
 * the archive and pause/resume verbs in `rule-lifecycle.ts`, which reach the
 * same field through `TemplateFamily`. Re-derive the lines rather than trust
 * a roster here:
 *
 *   grep -rn 'logNoun}' src/services/*.ts
 */
export type GenerationLogNoun = 'recurring class' | 'studio class';

/**
 * Everything the shared claim and generator below need in order to run over
 * one family.
 *
 * A dispatch table, not a runtime discriminator: each family's entry is
 * complete on its own, and nothing in this module ever asks which family it is
 * holding. An `if (family.kind === <a ClassFamily literal>)` anywhere below is
 * the stop condition issue 284 names, not an implementation detail — the
 * literal is spelled out of line here on purpose, so that grepping this file
 * for one stays a clean signal.
 *
 * NO FIELD IS OPTIONAL, deliberately, for the reason `TemplateFamily`
 * (`rule-lifecycle.ts`) gives at greater length: an optional field is exactly
 * the hole where a third family is half-defined and nothing complains.
 *
 * `TChild` appears in a parameter position (`createChildren`'s) and inside
 * `ChildWithRule` in a return position (`readChildOrThrow`'s), so the type is
 * invariant in it. `TKind` appears only in a property position, so it is
 * covariant.
 *
 * `Readonly<>`, and it is a guard rather than a style: a descriptor is a
 * module-level constant read by the claim's raw `FOR UPDATE` and by both
 * shared lifecycle verbs, so `CLASS_FAMILY.childTable = 'StudioClassTemplate'`
 * would silently point every one of the class family's row locks at the other
 * family's table. Without this it compiles clean; with it, it does not
 * (`TS2540`). The existing constants still assign, the spread into
 * `TemplateFamily` (`rule-lifecycle.ts`) still works, and a readonly
 * descriptor still passes into every parameter position that takes one.
 */
export type GeneratorFamily<TChild, TKind extends ClassFamily = ClassFamily> = Readonly<{
  /**
   * The `CalendarEntry.kind` this family's entries carry. Written onto every
   * row the generator inserts, and the value its same-family `slot_taken`
   * pre-check compares an occupant against — the two must be the same literal
   * or a family reports its neighbour's entries as its own.
   */
  kind: TKind;
  logNoun: GenerationLogNoun;
  /**
   * The child's table, spliced as a raw identifier into every row lock that
   * takes one for whichever family it was handed — `claimRuleForGeneration`
   * below, and the two shared lifecycle verbs that reach this field through
   * `TemplateFamily` (`rule-lifecycle.ts`).
   * Narrowed to the template children rather than left at `Prisma.ModelName`,
   * which admits every model in the schema: the type here is the tether, so
   * nothing outside it can reach that splice, and a third family becomes a
   * deliberate edit here rather than a silent widening. Pinned by
   * `rule-lifecycle.test.ts`, `@ts-expect-error` on a model name that is not a
   * template child — a claim about what the compiler refuses is worth only the
   * pin that makes the compiler refuse it.
   */
  childTable: Extract<Prisma.ModelName, 'ClassTemplate' | 'StudioClassTemplate'>;
  readChildOrThrow: (
    tx: TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild>>;
  /**
   * Writes this family's children onto the entries that actually landed.
   *
   * `entries` is the `createManyAndReturn` result, so it is already the
   * structural subset of the requested dates that survived `ON CONFLICT DO
   * NOTHING` — there is no predicate left for this write to re-apply and
   * nothing here may conflict. Called only when that subset is non-empty.
   */
  createChildren: (
    db: PrismaClient | Prisma.TransactionClient,
    template: ChildWithRule<TChild>,
    entries: readonly { id: string; date: Date }[],
  ) => Promise<void>;
}>;

// ---------------------------------------------------------------------------
// claimRuleForGeneration
// ---------------------------------------------------------------------------

/**
 * Claims one template of either family for generation, or reports it is no
 * longer eligible. One function rather than a pair, so the two families cannot
 * lock differently.
 *
 * `FOR UPDATE OF tpl` is the point, not the `SELECT`. It locks the same child row
 * that this family's own template update and both shared verbs
 * (`archiveOrUnarchiveRule` and `pauseOrResumeRule`, `rule-lifecycle.ts`) each
 * take as their own first statement (issue 298 / #315, `docs/lock-order.md`,
 * "The child row is the lock node for the template families") — every one of
 * them a plain `SELECT … FOR UPDATE`, the same exclusive mode this statement
 * takes, so the sweep and any of the three serialise on that row rather than
 * interleaving:
 *
 *   - claim first  → the other statement's own `FOR UPDATE` waits; we
 *                    generate and commit; an archive that was the one waiting
 *                    then withdraws what we made — all but an entry dated
 *                    today, which the archive's own predicate spares and its
 *                    own count still reports (`TemplateFamily.deleteWhere` and
 *                    `standingWhere`, `rule-lifecycle.ts`, which own that
 *                    boundary and the reason the two differ). One publicly
 *                    bookable class under a just-archived template is this
 *                    interleaving's correct outcome, not a gap this lock
 *                    failed to close.
 *   - archive first → we wait on the child row, then re-verify eligibility
 *                    against a FRESH read once we hold it (see below) and
 *                    skip.
 *
 * A plain re-read would not do this. Under READ COMMITTED each statement takes
 * a fresh snapshot, so an archive committing between the re-read and the
 * `create` is invisible to the re-read and still lost. Do not "simplify" the
 * locking `SELECT` below into a plain `findUnique`.
 *
 * The `sr."isActive"`/`sr."isArchived"` predicate in that `SELECT` is a fast
 * path, not the guarantee, and the distinction is load-bearing rather than
 * pedantic. `FOR UPDATE OF tpl` locks only `tpl` — deliberately, per the
 * decision linked above, which rejected locking `sr` too — so when this
 * statement itself has to WAIT for that lock, Postgres's WHERE clause was
 * already evaluated against the snapshot taken when the statement STARTED,
 * before the wait. On unblock, `EvalPlanQual` re-verifies the columns of the
 * row actually being locked (`tpl`) if THAT row changed; it does not re-fetch
 * `sr` on `tpl`'s account, because `sr` was never part of the lock set. So a
 * `tpl` row that was eligible when this statement started, and still IS `tpl`
 * itself unchanged, can come back as a "match" via `rows.length === 1` even
 * though the archive that made it wait committed `sr."isArchived" = true`
 * while this statement was parked. Measured directly, isolated from Prisma: two throwaway tables shaped
 * like a template child and its rule, one session holding the child row `FOR
 * UPDATE` and updating (but never committing) the parent's flag, a second
 * session's joined `FOR UPDATE OF` blocking on the first and then unblocking
 * on commit — the second session's join predicate still read the PRE-commit
 * flag, in six of six runs, and stayed stale even when the first session also
 * issued a real `UPDATE` on the child row itself (to force `EvalPlanQual`)
 * rather than only locking it. `rows.length === 1` is therefore necessary but
 * not sufficient for eligibility whenever this statement actually waited —
 * which is exactly the interleaving above one finds itself needing "archive
 * first" to work.
 *
 * `family.readChildOrThrow` below is what closes it, because it is a SEPARATE
 * statement issued only after this one returns — i.e., only after the lock is
 * actually held, wait or no wait — and a separate statement takes its own
 * fresh READ COMMITTED snapshot regardless of what the statement before it
 * waited on. Its own `scheduleRule.isActive`/`isArchived` are re-checked
 * against THAT snapshot before this function trusts the row, which is what
 * "archive first → skip" above actually depends on, not the raw statement's
 * own `WHERE`.
 *
 * Must be called with a transaction client, never a bare `PrismaClient` —
 * `Prisma.TransactionClient` is structurally just `Omit<PrismaClient,
 * ITXClientDenyList>`, so a bare client type-checks without complaint. It
 * would make `SET LOCAL` a no-op (there is no transaction for "local" to scope
 * to) and release the row lock the instant the `SELECT` completes, which costs
 * two things at once: the row handed back would be authoritative of nothing
 * (#102), and `readChildOrThrow` would run unlocked too and can throw P2025 if
 * the row is deleted out from under it before that second statement runs.
 * `TransactionClientOnly`'s brand on `tx` is what refuses it.
 *
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` to stop blocking the
 * child-entry inserts `generateEntriesForRule` goes on to make — it looks like
 * a free optimisation but isn't. `FOR UPDATE` is what makes a concurrent
 * insert for this template impossible, because an insert's FK check takes `FOR
 * KEY SHARE` on this row, which `FOR UPDATE` conflicts with and `FOR NO KEY
 * UPDATE` does not. Measured on #164, both directions.
 *
 * That is a claim about races, not about correctness under one:
 * `generateEntriesForRule` below has no P2002 branch to be broken. Its `ON
 * CONFLICT DO NOTHING` makes a lost race cost one date and abort nothing, with
 * or without this lock. The lock still earns its place by keeping the values
 * this claim returns authoritative (#102).
 *
 * Returns the locked row rather than a boolean, so a caller cannot generate
 * from the snapshot its outer `findMany` read minutes earlier (#102). The raw
 * statement below still does the locking and a first-pass eligibility filter;
 * the Prisma read after it is what makes both the VALUES and the eligibility
 * VERDICT authoritative, for the reason above — and it is safe precisely
 * because the lock is still held when it runs. Two statements rather than one
 * `SELECT *` because a raw row does not hand back Prisma's `Decimal` for the
 * money columns a caller then does arithmetic on, and `readChildOrThrow` does.
 */
export async function claimRuleForGeneration<TChild>(
  tx: TransactionClientOnly,
  family: GeneratorFamily<TChild>,
  templateId: string,
): Promise<ChildWithRule<TChild> | null> {
  // `LOCK_TIMEOUT_SQL` (`@/lib/db-locks`) — shared with `lockClassRow`, which
  // takes the `Class` row lock this one deadlocks against, so the two waits
  // are the same length by construction rather than by coincidence. Its
  // docblock carries the reason `$executeRawUnsafe` is safe for it.
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  // `Prisma.raw` because a table name cannot be a bind parameter; `templateId`
  // still is one. What bounds the splice is `childTable`'s type, not this
  // comment. The alias is a fixed `tpl` for either family — nothing
  // downstream reads it, so there is no reason for the two to differ. It may
  // not be `c`: that is this codebase's alias for `Class`, and under it this
  // statement reads as a `Class` lock taken outside `db-locks.ts`. Nothing
  // enforces that — see `docs/lock-order.md`, "Ordering BETWEEN `Class` and
  // its `CalendarEntry`", which owns the censuses and the reason they cannot
  // see this statement's table name.
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT tpl."id" FROM ${Prisma.raw(`"${family.childTable}"`)} tpl
      JOIN "ScheduleRule" sr ON sr."id" = tpl."scheduleRuleId"
    WHERE tpl."id" = ${templateId}
      AND sr."isActive" = true
      AND sr."isArchived" = false
    FOR UPDATE OF tpl`;
  // Silent on purpose: this row's own `WHERE` did not match, which for the
  // sweep's caller is the ordinary "not selected" case — the pre-filter
  // `findMany` runs unlocked and is routinely minutes stale by the time this
  // statement executes. Logging every one of those would be noise, not
  // signal. The re-check below is the branch this comment's sibling exists
  // to distinguish from this one.
  if (rows.length !== 1) return null;

  // Under the lock taken above, so nothing can change `tpl` itself before we
  // commit. `OrThrow` because the row provably still exists: the `FOR UPDATE`
  // just matched it and no deleter can reach it without taking the same lock,
  // so an impossible `| null` would force every caller to pretend to handle
  // it.
  const fresh = await family.readChildOrThrow(tx, templateId);

  // The authoritative eligibility check — see this function's docblock for
  // why the raw statement's own `WHERE` cannot be trusted alone when it had
  // to wait. This read is a fresh statement taken under the lock, so it sees
  // whatever the row that made us wait actually committed.
  if (!fresh.scheduleRule.isActive || fresh.scheduleRule.isArchived) {
    // The signal the sweep's own `if (!fresh) return 0` cannot give: THIS
    // null is the measured `EvalPlanQual` race actually landing — the raw
    // statement above matched and waited, and what it waited on committed a
    // change the wait made it miss. `pauseOrResumeRule` (`rule-lifecycle.ts`)
    // reaches this function through `TemplateFamily.claim` and treats a null
    // as impossible, throwing right after; logging here first costs it
    // nothing and gives the sweep's silent `return 0` the trace it does not
    // otherwise get.
    log.warn(
      { templateId },
      `${family.logNoun} generation claim matched but found the row ineligible on re-check`,
    );
    return null;
  }

  return fresh;
}

// ---------------------------------------------------------------------------
// generateEntriesForRule
// ---------------------------------------------------------------------------

/**
 * Generates the rolling 4-week window for ONE template of either family,
 * reporting each candidate date it could not fill and why
 * (`GenerationResult`). One function rather than a pair, so the two families
 * cannot answer the same question differently.
 *
 * Keyed per WEEK, not per date (#194 for the class family, #284 for the studio
 * one). A template is a stamp, not a live link: editing `dayOfWeek` no longer
 * rewrites the classes already generated — the sync that did is deleted — so
 * without a week key, moving a template from Tuesday to Thursday would leave
 * four Tuesdays standing and create four Thursdays beside them. The
 * `heldWeeks` read below is what stops that, and `already_this_week` is what
 * tells the teacher it happened.
 *
 * Two mechanisms, each with a job the other cannot do:
 *
 *   - the occupancy `findMany` below names the *reason* a date is skipped, which
 *     is what lets the teacher be told something true and an operator grep for
 *     it. It is a read-then-write and so is not race-safe on its own;
 *   - `createManyAndReturn({ skipDuplicates: true })` on the ENTRY compiles to
 *     a BARE `ON CONFLICT DO NOTHING` — no conflict target, so it covers every
 *     conflict the row can raise, `CalendarEntry_teacher_slot_excl` (an
 *     EXCLUSION constraint, which a targeted `DO UPDATE` could not name)
 *     included alongside `@@unique([scheduleRuleId, date])`. That is what
 *     makes a clash cost only its own date, inside a transaction that then
 *     goes on to run another statement and commit. Pinned once per family, by
 *     "names a date lost to a concurrent insert by what still holds it" in
 *     `class-generator.test.ts` and in `studio-class-generator.test.ts` — a
 *     holder entry with `scheduleRuleId: null`, so the collision is isolated
 *     to the slot constraint rather than riding along on the rule-date key
 *     too.
 *
 * NOT idempotent by a caught `P2002`, and the constraint above rather than a
 * `catch` is the whole shape of this function for one reason: Prisma does not
 * savepoint individual queries inside an interactive transaction, so a caught
 * `P2002` leaves Postgres with an aborted transaction. The next statement
 * fails with
 * `25P02`, and if the clash landed on the *last* date there is no next
 * statement — `COMMIT` on an aborted transaction returns the `ROLLBACK` tag
 * with no error, so `$transaction` resolved successfully while every row it
 * reported was discarded (#164). That is not hypothetical here: every
 * production path into this function already runs inside an interactive
 * transaction, so the transaction a caught `P2002` would abort is the
 * CALLER'S. Stated as that property rather than as a roster of call sites: a
 * roster reaches past this file and has no owner here. The parameter type
 * still admits a bare `PrismaClient` because the generator suites drive this
 * function outside a transaction, where each statement is its own. Do not
 * reintroduce a `catch` here; there is nothing it can do that the constraint
 * does not.
 *
 * Accepts a transaction client so a route can create the template and its
 * window atomically.
 */
export async function generateEntriesForRule<TChild extends { id: string }>(
  db: PrismaClient | Prisma.TransactionClient,
  family: GeneratorFamily<TChild>,
  template: ChildWithRule<TChild>,
  from?: Date,
): Promise<GenerationResult> {
  const startDate = from ?? new Date();

  // The next 4 occurrences whose start is still ahead of startDate. A run
  // after today's start time must not create a class that already happened;
  // the window slides one week further instead.
  //
  // The start instants are computed once and kept, rather than recomputed in
  // the guard below: `classStartInstant` warns on every unreadable input, so
  // asking it a second time would double the log lines for the one case the
  // guard exists to report.
  //
  // `template.scheduleRule.startTime` is already a `@db.Time` `Date` — passed
  // straight through rather than round-tripped via `timeToHHmm`, which exists
  // for the wire boundary, not for a value that already carries the type
  // `classStartInstant` and `CalendarEntry.startTime` both want.
  const startTime = template.scheduleRule.startTime;
  const starts = getNextOccurrences(
    template.scheduleRule.dayOfWeek,
    startDate,
    DEFAULT_WEEKS + 1,
  ).map((date) => ({
    date,
    start: classStartInstant({ date, startTime }, template.scheduleRule.teacher.defaultTimezone),
  }));
  const dates = starts
    .filter(({ start }) => start > startDate)
    .map(({ date }) => date)
    .slice(0, DEFAULT_WEEKS);

  // `dates` CAN be empty, and the filter above is not what stops it. The
  // filter drops a candidate whose start is not strictly ahead of
  // `startDate`, and it can drop ALL FIVE: `classStartInstant`
  // (`@/lib/timezone`) fails soft by design, so an unparseable `startTime`
  // returns `new Date(NaN)` rather than throwing, and `NaN > startDate` is
  // `false` for every candidate at once.
  //
  // What keeps that out of reach is the WRITE path. Every route that sets a
  // template's `startTime` validates it with `timeHHmm` (`@/lib/schemas`), so
  // no stored row can carry a value `classStartInstant` cannot read, and no
  // path reaches the empty case today. That is a guarantee about the WRITERS —
  // wideable by a new route, a migration, or a manual `UPDATE` — and not a
  // property of this function.
  //
  // Guarded rather than asserted for a second, independent reason: the week
  // bounds below dereference both ends of the array, and under
  // `noUncheckedIndexedAccess` a `!` there would be a claim about a filter a
  // few lines up rather than a check. Returning the empty result is what the
  // loop below would have produced from an empty `dates` anyway.
  //
  // The `warn` tells the two ways of arriving here apart, and only one of them
  // is worth a line. A window that is genuinely empty — which needs
  // `getNextOccurrences` to start returning fewer dates than it is asked for —
  // is an ordinary outcome and stays silent, so this cannot become hourly
  // sweep noise on the legitimate case. A window emptied by an unreadable
  // start instant is the latent case above, and logs exactly once per call.
  // With `templateId` and `teacherId`, because `classStartInstant`'s own warn
  // carries `{ startTime }` and nothing else: an operator seeing it could tell
  // that A template was unreadable and not WHICH. That is the gap this closes,
  // and the only reason to log at all for a case nothing can currently reach.
  const windowStart = dates[0];
  const windowEnd = dates[dates.length - 1];
  if (windowStart === undefined || windowEnd === undefined) {
    if (starts.some(({ start }) => Number.isNaN(start.getTime()))) {
      log.warn(
        {
          templateId: template.id,
          teacherId: template.scheduleRule.teacherId,
          startTime: timeToHHmm(startTime),
        },
        `${family.logNoun} generation found no candidate dates because their start instants could not be read`,
      );
    }
    return { created: 0, skipped: [] };
  }

  // ONE query for the whole window, over `CalendarEntry` — which since #327 is
  // where both families' occupancy lives, so a single read answers the
  // same-family and the cross-family question at once and neither needs a scan
  // of its own. Scoped to this teacher because
  // `CalendarEntry_teacher_slot_excl` is `("teacherId" WITH =, span WITH &&)`,
  // so another teacher's entry can never block this one and must not be read.
  //
  // No `status` here, and none is reachable: `status` is a `Class` column,
  // carried by neither `CalendarEntry` nor the studio child at all, and every
  // question this loop asks — is the date this rule's own, is it cancelled,
  // does it overlap — is answered by the entry's own columns.
  // `durationMinutes` comes back because the constraint is a RANGE now, so the
  // pre-check has to compare spans rather than start times.
  const occupants = await db.calendarEntry.findMany({
    where: { teacherId: template.scheduleRule.teacherId, date: { in: dates } },
    select: {
      scheduleRuleId: true,
      kind: true,
      date: true,
      startTime: true,
      durationMinutes: true,
      cancelledAt: true,
    },
  });

  // Week occupancy for the whole window (#194). A SECOND read rather than a
  // widening of `occupants` above, and keyed on `scheduleRuleId` rather than
  // `teacherId`, for two reasons. The read above is scoped to the candidate
  // dates and structurally cannot see the entry that blocks a week from a
  // DIFFERENT date — which is the entire case this exists for. And keying on
  // `scheduleRuleId` rides `@@unique([scheduleRuleId, date])`, which
  // `CalendarEntry` carries for both families at once, so this does not widen
  // an unindexed scan (see
  // `docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md` §5;
  // it corrects a claim on #284 that said otherwise).
  //
  // No liveness filter, deliberately: a cancelled entry holds its week.
  // `docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md`
  // §3.2 has the flip-flop schedule the alternative produces — move a template
  // Tuesday→Thursday, cancel the Tuesday in week 2 only, and a filtered read
  // moves week 2 to Thursday while weeks 1, 3 and 4 stay Tuesday: a schedule
  // that changes slot and changes back. A week left empty is easier for a
  // teacher to read than that. Do not add a filter for consistency with
  // `CalendarEntry_teacher_slot_excl`, which reads cancelled as free for the
  // different and correct reason that its constraint is partial on
  // `cancelledAt IS NULL`.
  //
  // Bounds derived from `dates` itself, not computed independently — the read
  // and the loop below must not be able to disagree about which weeks are in
  // play. `mondayOf` takes a CALENDAR DATE and no timezone, which is what both
  // operands are: `CalendarEntry.date` is `@db.Date` and `getNextOccurrences`
  // builds UTC midnights. `startOfLocalWeek` is the wrong tool here — it
  // resolves an INSTANT through `Intl`, and west of UTC it returns the previous
  // day, which for a Monday is the previous week. The `+ 7 days` is plain
  // UTC-midnight arithmetic for the same reason: no local calendar, so no DST
  // to skew it.
  const weekStart = new Date(mondayOf(windowStart));
  const weekEnd = new Date(mondayOf(windowEnd) + 7 * 24 * 60 * 60 * 1000);
  const heldWeeks = new Set(
    (
      await db.calendarEntry.findMany({
        where: {
          scheduleRuleId: template.scheduleRuleId,
          date: { gte: weekStart, lt: weekEnd },
        },
        select: { date: true },
      })
    ).map((e) => mondayOf(e.date)),
  );

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  /** What every candidate in this window would occupy — the same for all of
   * them, since a template has one start time and one duration. */
  const candidateSpan = {
    startTime,
    durationMinutes: template.scheduleRule.durationMinutes,
  };

  for (const date of dates) {
    const onDate = occupants.filter((e) => e.date.getTime() === date.getTime());

    // At most one, by `@@unique([scheduleRuleId, date])`.
    const own = onDate.find((e) => e.scheduleRuleId === template.scheduleRuleId);
    if (own) {
      // A cancelled own row still holds the date: that unique key is TOTAL,
      // not partial on liveness, so the date is unfillable for good rather
      // than merely already filled. Telling those two apart is #192.
      skipped.push({
        date,
        reason: own.cancelledAt !== null ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // AFTER the own-date branch above, deliberately — and that half of the
    // order IS pinned: reversing it reddens the steady-state re-run case in
    // both families' test files, which is why it is stated as a guarantee
    // where the next paragraph is not. `heldWeeks` contains this candidate's
    // own week too, so checking week-first would mask `already_generated` on
    // every steady-state re-run — and the two are not interchangeable
    // downstream, since `countSkipReasons` counts `already_this_week` into a
    // number that reaches the teacher and deliberately ignores
    // `already_generated`. That chain is real for both families: the count
    // runs `pauseOrResumeTemplate`/`pauseOrResumeStudioTemplate` → the PATCH
    // `active` arm → `resumeMessage`/`resumeStudioMessage`, which renders it
    // as "N dates are still held by classes on your previous day".
    //
    // Before `slot_taken` below — a REPORTING PREFERENCE, not a guarantee, and
    // deliberately stated as one: nothing pins it. No fixture makes a single
    // date both week-held and slot-taken by an unrelated class, so swapping
    // these two branches fails no test today. The preference is that when a
    // day edit and an unrelated class both block a date, the systematic cause
    // is the one worth reporting.
    //
    // Not free to get wrong, either: the two reasons land in DIFFERENT
    // `SkipCounts` fields and reach a teacher as different clauses of
    // `resumeMessage` ("N dates already had a class" versus "N dates are still
    // held by classes on your previous day"). What bounds it is that both
    // branches `continue` — no class is created either way, the total is
    // unchanged, and `resumeMessage` appends every applicable clause before
    // choosing a head — so a reorder changes WHICH CLAUSE the teacher reads,
    // never whether the sentence is true. Closing it costs one fixture; until
    // someone spends it, this comment must not claim an order the suite does
    // not enforce.
    if (isWeekHeld(date, heldWeeks)) {
      skipped.push({ date, reason: 'already_this_week' });
      continue;
    }

    // Mirrors the partial predicate `CalendarEntry_teacher_slot_excl` carries
    // (`WHERE "cancelledAt" IS NULL`); the constraint backs it since #327;
    // this pre-check is what names the reason, not what enforces it. Widen or
    // narrow one without the other and this pre-check starts disagreeing with
    // the constraint that backs it — see
    // `docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md`
    // §4.1.
    const live = onDate.filter((e) => e.cancelledAt === null);

    // Exact start, this family — the report a teacher can act on without
    // leaving this half of their schedule. `family.kind` rather than a
    // literal, and it is the same one written onto the rows below: a family
    // that compared against the other's would report its neighbour's entries
    // as its own.
    if (
      live.some(
        (e) => e.kind === family.kind && e.startTime.getTime() === startTime.getTime(),
      )
    ) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    // AFTER `slot_taken`, deliberately: when this teacher holds the slot in
    // BOTH families, the same-family cause is the one worth reporting. A
    // reporting preference like the week-versus-slot one above — but unlike
    // that one it costs nothing to state, since both branches `continue` and
    // no row is created either way.
    //
    // Any live entry of this teacher whose span overlaps the candidate blocks
    // it here — a studio class at the same time, and equally a class of
    // either family that merely runs into this one. Which is why the sentence
    // a teacher reads (`resumeMessage`/`resumeStudioMessage`,
    // `components/settings/template-action-messages.ts`) names NO family: the
    // reason covers holders this branch cannot tell apart. `SkipReason`'s own
    // docblock (`@/lib/generation`) owns the enumeration.
    if (live.some((e) => spansOverlap(e, candidateSpan))) {
      skipped.push({ date, reason: 'blocked_by_overlap' });
      continue;
    }

    free.push(date);
  }

  // NO CATCH, and #296 is the second issue to reach for one here and be wrong.
  // THIS FUNCTION'S OWN docblock already says it: "Do not reintroduce a
  // `catch` here; there is nothing it can do that the constraint does not."
  //
  // A `catch` with a per-date retry shipped on this branch and was measured
  // non-functional. Everything in this paragraph is the TRIGGER era: the
  // `RAISE EXCEPTION` it turns on came from the cross-family guards #327
  // replaced, so read it as why a retry was wrong then, not as what an insert
  // does now. Every production caller passes a TRANSACTION client, Prisma
  // takes no savepoint per statement, and a `RAISE EXCEPTION` aborts the
  // Postgres transaction — so the first retried `create` returns `25P02
  // current transaction is aborted`, which `isCrossFamilySlotConflict`
  // correctly declines, and the rethrow costs the whole window anyway. It also
  // cost more than that: the escaping error stopped being the `YG001` that the
  // two template POST catches used to match, and the other generation-wrapping
  // callers let it reach `withErrorHandler`, where `classifyApiError` has no
  // arm for it and answers 500 — filed as #301. So a 409 the app knew how to
  // word became a 500 here too. Two template POSTs — not the count of
  // endpoints answering a cross-family 409, and not the count of route files
  // holding them. `docs/lock-order.md` owns that census; the three numbers are
  // not interchangeable.
  //
  // The mutation could not see it. The CROSS-FAMILY tests call this function
  // with a bare client, where every statement is its own transaction and the
  // retry works, so the mutation came back green in a configuration production
  // never uses. Other tests in the two generator test files DO drive this
  // through `$transaction`; none of them staged a cross-family collision
  // inside one, which is the gap rather than transactions being untested
  // generally. `generation-transaction.test.ts` now drives this path through a
  // real `$transaction` for that reason.
  //
  // WHAT A LOST RACE COSTS NOW, which is the half of that argument #327
  // changed: its own date, not the window. A row committing between the
  // pre-check above and this insert is absorbed by the `ON CONFLICT DO
  // NOTHING` below — the statement completes, the date simply does not come
  // back, and the loop after it reports that date as `'raced'`. The
  // transaction survives, so the remaining dates still land and still commit.
  // Nothing escapes to a caller, which is also why no route turns this into a
  // 409 any more: the `YG001` the two template POSTs used to catch has no
  // raiser left at all (`docs/lock-order.md`, "One teacher, one slot").
  //
  // TWO STATEMENTS SINCE #327, and only the first can conflict. The entry
  // carries every constraint — `CalendarEntry_scheduleRuleId_date_key` and the
  // `CalendarEntry_teacher_slot_excl` range — so `skipDuplicates` belongs
  // there; the children `family.createChildren` writes below are keyed on the
  // entry ids that actually landed, which is a structural subset rather than a
  // predicate, so nothing is left for a second `ON CONFLICT` to catch.
  //
  // `ON CONFLICT DO NOTHING` with NO conflict target covers the exclusion
  // constraint as well as the unique key — a targeted `DO UPDATE` could not,
  // since that form requires a unique index. That is what keeps a clash
  // costing only its own date inside a transaction that then goes on to run
  // another statement and commit.
  const inserted =
    free.length === 0
      ? []
      : await db.calendarEntry.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.scheduleRule.teacherId,
            kind: family.kind,
            classType: template.scheduleRule.classType,
            date,
            startTime,
            durationMinutes: template.scheduleRule.durationMinutes,
            scheduleRuleId: template.scheduleRuleId,
          })),
          skipDuplicates: true,
          select: { id: true, date: true },
        });

  if (inserted.length > 0) {
    await family.createChildren(db, template, inserted);
  }

  // A free date that did not come back was refused by a constraint the
  // pre-check said nothing about, and `ON CONFLICT DO NOTHING` swallowed the
  // `23P01`/`23505` rather than raising it. Before #164 this was the P2002 that
  // poisoned the transaction; it is an ordinary skipped date now, and the only
  // one whose cause is not in `occupants`.
  //
  // SO IT IS ASKED FOR, and that second look is not an optimisation. `raced` is
  // one of the two `SkipReason`s `countSkipReasons` drops, and it is dropped on
  // the argument that a race is TRANSIENT — "its date will simply be picked up
  // on the next run". A neighbour spilling past midnight makes that false: the
  // pre-check is minutes-since-midnight on one date and cannot see it, the
  // constraint can and refuses forever, and the date came back short every hour
  // while `anyBlocked` reduced over a `SkipCounts` that never heard about it.
  // `template-form.tsx` then navigated a teacher away from a window that
  // generated nothing, saying nothing — #196's silence, one reason further
  // over, for the third time.
  //
  // TWO OUTCOMES, NOT FOUR. `probeOverlappingCandidates` asks only the
  // constraint's own question — does a live entry of this teacher's still
  // overlap this span — so a still-held date is reported as `blocked_by_overlap`
  // and reaches the teacher through the clause that reason already owns. It
  // does NOT re-run the loop's finer classification, and the fidelity that
  // costs is bounded to genuine races: an own row on the date, or a same-family
  // neighbour at exactly this minute, is visible to the pre-check above unless
  // it committed while this function was running, so a short date is either a
  // midnight spill (where `blocked_by_overlap` is exactly right) or a race
  // (where it is coarser than `already_generated`/`slot_taken` would be, and
  // still true). Reporting a blocked date coarsely beats reporting it as
  // transient when it is not.
  //
  // `raced` survives, narrowed to what it always claimed to be: a short date
  // nothing live overlaps any more. The rule-date key
  // (`CalendarEntry_scheduleRuleId_date_key`) reaches it — a concurrent insert
  // of this rule's own row at a non-overlapping start refuses the date without
  // occupying the span.
  const landed = new Set(inserted.map((r) => r.date.getTime()));
  const short = free.filter((date) => !landed.has(date.getTime()));
  if (short.length > 0) {
    const stillHeld = await probeOverlappingCandidates(
      db,
      template.scheduleRule.teacherId,
      short,
      candidateSpan,
    );
    for (const date of short) {
      skipped.push({
        date,
        reason: stillHeld.has(date.getTime()) ? 'blocked_by_overlap' : 'raced',
      });
    }
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedEntries(family.logNoun, template.id, template.scheduleRule.teacherId, skipped);

  return { created: inserted.length, skipped };
}

/**
 * One line per generator call, never one per date — that ratio is the answer to
 * the noise question #192 raised, where per-date logging on an hourly sweep put
 * ~48 lines/day on a 2GB VPS for a teacher with two blocked dates. Per call it
 * is 24, and each is complete rather than a fragment.
 *
 * `already_generated` is excluded deliberately: it is the correct, expected
 * outcome of every steady-state run, and logging it *is* the noise.
 *
 * The noun leads the message so the two families stay greppable apart, and it
 * comes from `GenerationLogNoun` rather than from `family.kind`: `kind` is a
 * schema value that appears in log payloads and API responses, and a message
 * an operator greps for should not change when a schema label does.
 */
function logSkippedEntries(
  logNoun: GenerationLogNoun,
  templateId: string,
  teacherId: string,
  skipped: SkippedSlot[],
): void {
  const blocking = skipped.filter((s) => s.reason !== 'already_generated');
  if (blocking.length === 0) return;

  log.warn(
    {
      templateId,
      teacherId,
      skipped: blocking.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        reason: s.reason,
      })),
    },
    `${logNoun} generation could not fill every date in the window`,
  );
}

// ---------------------------------------------------------------------------
// probeFirstEffectiveWeek
// ---------------------------------------------------------------------------

/**
 * The noun an EDIT-PATH log line uses — a separate vocabulary from
 * `GenerationLogNoun` ('recurring class' | 'studio class') above, which every
 * line composed from a family DESCRIPTOR uses instead: the claim and generator
 * lines here, and the archive and pause/resume lines `rule-lifecycle.ts`
 * builds from the same field. Never compose one from the other: every
 * edit-path line in `studio-class-template-lifecycle.ts` already reads
 * "studio template edit …", so a line built from `GenerationLogNoun` would
 * read "studio class edit …" instead and be the odd one out beside its own
 * siblings. Re-derive the sibling lines rather than trust a count here:
 *
 *   grep -rhn "edit refused\|edit lost a lock race\|edit saved" src/services/*.ts
 *
 * (spec `docs/superpowers/specs/2026-08-29-studio-week-keyed-generation-design.md`
 * §3.7, which also names the third, teacher-facing vocabulary this module
 * never touches.)
 */
export type EditLogNoun = 'recurring class' | 'studio template';

/**
 * The probe behind each family's `firstEffective`
 * (`UpdateClassTemplateResult`, #194; `UpdateStudioClassTemplateResult`,
 * #284): the Monday of the first week in `horizon` whose candidate date
 * `generateEntriesForRule` would actually fill, GIVEN that the template is
 * eligible to generate at all.
 *
 * ONE PROBE FOR BOTH FAMILIES, matching the one generator it predicts. That
 * is what keeps a prediction and a behaviour from drifting apart per family,
 * and the family enters here only through `editNoun`, which reaches nothing
 * but the failure warn below. Do not add a family parameter to the reads:
 * every question this function asks is answered by `CalendarEntry` columns
 * both families share.
 *
 * That precondition is the caller's, not this function's, and it is stated in
 * the contract rather than assumed because it is not a `SkipReason` and so
 * cannot appear in the enumeration below. `generateEntriesForRule` refuses
 * candidate DATES; the eligibility rule — `isActive` true and `isArchived`
 * false on the `ScheduleRule` — refuses whole TEMPLATES, one layer up, before
 * any candidate is considered, at each family's sweep `findMany` and again
 * under the row lock in `claimRuleForGeneration`. `@/lib/template-selection`
 * owns that rule's canonical spelling and the state name each caller reports
 * it under. For a paused or archived
 * template the generator is never called, no date is ever declined, and every
 * answer this function could give would name a week nothing will fill. Each
 * family's `update…Template` therefore calls it only when
 * `templateGenerationState` answers `'active'` and reports the other two
 * states as themselves; a reader completing the bullet list below would still
 * be missing that case, which is why it is up here and not in it.
 *
 * Read-only, and it must stay that way — this endpoint creates no class, so
 * everything in the sentence it feeds is a prediction about the sweep.
 *
 * ## Which of the generator's refusals this reproduces, and which it does not
 *
 * The generator declines a candidate date on six named grounds (`SkipReason`,
 * `@/lib/generation`, whose own header says "Six reasons, six distinct
 * origins" — one number, derived from the type, not two conventions counting
 * the same union). Stated one at a time rather than as a parity claim, because
 * the parity claim is what this docblock said before `slot_taken` was found
 * missing — and a reader who trusted it had no way to check it. Named rather
 * than numbered, because "the Nth ground" resolves against no ordering anyone
 * has written down:
 *
 *   - `already_generated` and `blocked_by_cancelled` — this template's own row
 *     on the date itself, live or cancelled. Both reproduced by the FIRST read:
 *     a row on a date is a row in that date's week, and the read carries no
 *     status filter, so a cancelled row holds its week too. That absent filter
 *     is deliberate and is the one place this codebase does not read cancelled
 *     as free —
 *     `docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md`
 *     §3.2 has the flip-flop schedule the alternative produces.
 *   - `already_this_week` — the same read, and the same `isWeekHeld` the
 *     generator's loop decides with. That sharing is the point of the
 *     function existing.
 *   - `slot_taken` (#196) and `blocked_by_overlap` (#296) — somebody
 *     ELSE's row: another LIVE entry of this teacher whose SPAN overlaps the
 *     candidate's. Invisible to a rule-keyed read, which is why there
 *     is a SECOND read. Missing it made the prediction land EARLIER than the
 *     sweep delivers, which is the dishonest direction: rule 1 of #194 leaves
 *     a moved-off template's instances standing, so a second template edited
 *     onto that day and time finds its own weeks empty and every date
 *     occupied. The two reasons took two reads until #327 put both families
 *     in one `CalendarEntry`; they take one now, and the probe does not tell
 *     them apart because the answer it gives is the same either way.
 *
 *     Overlap rather than an identical start time, and that distinction is
 *     #327's: the constraint behind both reasons is a RANGE now. A read keyed
 *     on `startTime` reproduced neither reason fully, and erred in the
 *     dishonest direction while this bullet claimed it reproduced both.
 *   - `raced` — **not reproduced, and not reproducible.** It is a concurrent
 *     insert landing between the generator's pre-check and its write, so at
 *     probe time it has not happened yet and there is nothing to read. Its
 *     effect on this prediction is bounded and self-correcting: the sweep loses
 *     that one date and picks the template up again on its next run, so the
 *     class arrives late rather than never. This is the one divergence, and it
 *     is the only one that errs later-than-promised.
 *
 * The two facts are kept apart rather than merged into one set, because they
 * are not the same fact: a WEEK this template already occupies versus a single
 * DATE whose slot another entry holds. Slot-taken dates are removed from the
 * candidate list; `firstFreeWeek` then answers the week question over what is
 * left. BOTH reads are bounded by `horizon` itself — its first and last weeks
 * for the week read, its own members for the slot read — so nothing here can
 * disagree with anything else about which dates are in play.
 *
 * Answers `null` rather than throwing, on both of the ways it can fail: a read
 * that raises, and the week arithmetic that runs on what the reads returned.
 * The edit has already committed by the time this runs, so a probe failure
 * must not turn a saved template into a 500 — and `templateUpdatedMessage`
 * already has a `null` branch that says nothing about weeks rather than
 * something unfounded.
 *
 * TWO GUARDS RATHER THAN ONE, and two different warn lines. A failed read is a
 * question about the database; a throw from the arithmetic is a bug in this
 * function, and one shared message would send an operator to a healthy
 * database to look for it. Both are logged, so the silence is never also
 * invisible.
 */
export async function probeFirstEffectiveWeek(
  db: PrismaClient,
  // A structural literal, not `ClassTemplateWithSlot`
  // (`class-template-lifecycle.ts`): naming the five fields this function
  // actually reads is what lets both families' `WithSlot` types satisfy it
  // without a type parameter — `startTime` in the `WithSlot` "HH:MM" spelling,
  // not the `@db.Time` `Date` the column holds.
  template: {
    id: string;
    scheduleRuleId: string;
    teacherId: string;
    startTime: string;
    durationMinutes: number;
  },
  horizon: readonly Date[],
  // The noun THIS function's own failure warn composes from — deliberately
  // `EditLogNoun`, not `GeneratorFamily.logNoun`. See `EditLogNoun`'s own
  // docblock above for why the two must never be composed from one another;
  // this is the parameter to read before reaching for `logNoun` here instead.
  editNoun: EditLogNoun,
): Promise<Date | null> {
  // Guarded rather than `!`-asserted: under `noUncheckedIndexedAccess` a `!`
  // here would be a claim about `getNextOccurrences` and its filter several
  // lines away, and both ends are dereferenced below.
  const first = horizon[0];
  const last = horizon[horizon.length - 1];
  if (first === undefined || last === undefined) return null;

  // The `catch` is on the READS and nothing else, which is what the docblock
  // above promises. Wrapping the whole body instead reports a programming
  // error in `mondayOf`, `hhmmToTime`, `spansOverlap` or `firstFreeWeek` as
  // "the probe failed", sending an operator to look at a healthy database
  // while the week arithmetic is the bug. That arithmetic is guarded
  // separately below and answers `null` too, so narrowing this `catch` does
  // not put a throw back on the caller — it only stops the two faults sharing
  // one sentence.
  //
  // The two `mondayOf` calls in the first read's `where` sit inside neither
  // guard: the argument object is built before `Promise.all` is entered, so a
  // throw there escapes synchronously. Both operands come from
  // `getNextOccurrences` and are `undefined`-guarded immediately above, which
  // is what keeps that gap closed.
  const reads = await Promise.all([
    // The weeks this template already occupies. Keyed on `scheduleRuleId`,
    // which rides `@@unique([scheduleRuleId, date])`, and bounded by the
    // horizon's own first and last weeks. No liveness filter — see the
    // docblock.
    db.calendarEntry.findMany({
      where: {
        scheduleRuleId: template.scheduleRuleId,
        date: {
          gte: new Date(mondayOf(first)),
          lt: new Date(mondayOf(last) + 7 * 24 * 60 * 60 * 1000),
        },
      },
      select: { date: true },
    }),
    // This teacher's LIVE entries on the candidate dates, whatever their
    // start time — the SPAN comparison happens below, in `spansOverlap`, the
    // same function the generator's own pre-check decides with.
    // `cancelledAt: null` rather than no filter, matching
    // `CalendarEntry_teacher_slot_excl`'s partial scope (`WHERE
    // "cancelledAt" IS NULL`) — the opposite of the read above, and for the
    // opposite reason: a cancelled entry does not hold a slot, and a
    // cancelled entry does hold a week. `date: { in: … }` over the horizon
    // itself rather than a second pair of bounds, so the two reads cannot
    // drift apart about the range; `@@index([teacherId, date])` backs it.
    //
    // ONE READ FOR BOTH FAMILIES (#327), and it must stay unnarrowed. No
    // `kind` filter belongs here: a probe blind to the other family counts a
    // cross-family date as a free candidate and names a week the sweep then
    // skips, landing EARLIER than delivered — the dishonest direction this
    // function's own docblock names. `CalendarEntry` holds both families'
    // occupancy, so that blindness is not expressible unless someone adds it
    // back.
    //
    // OVERLAP, NOT EXACT START, and that is the SAME defect one shape over.
    // #327 made `CalendarEntry_teacher_slot_excl` a RANGE constraint, so a
    // generator declines a candidate that merely runs into a neighbour. An
    // exact-start read here counts such a date as free, names a week the
    // sweep then skips, and lands EARLIER than delivered — the dishonest
    // direction again, and #194's original failure. Erring the other way is
    // not on offer: matching the generator exactly is what makes the answer
    // right rather than merely safe.
    db.calendarEntry.findMany({
      where: {
        teacherId: template.teacherId,
        cancelledAt: null,
        date: { in: [...horizon] },
      },
      select: { date: true, startTime: true, durationMinutes: true },
    }),
  ]).catch((err: unknown) => {
    log.warn(
      { err, templateId: template.id },
      `${editNoun} edit saved, but the first-effective-week probe failed — the confirmation will not name a week`,
    );
    return null;
  });
  if (reads === null) return null;
  const [ownRows, slotHolders] = reads;

  // THE SECOND GUARD. Everything from here on is arithmetic over rows already
  // in hand, so a throw is a defect in this function rather than a database
  // fault — but the caller is past its commit either way, and the contract
  // above is `null`, not 500. Its own message, so the log still tells the two
  // apart.
  try {
    const heldWeeks = new Set(ownRows.map((e) => mondayOf(e.date)));
    // What every candidate would occupy — one span for the whole horizon,
    // since a template has one start time and one duration. Built exactly as
    // `generateEntriesForRule` above builds its own `candidateSpan`, so the
    // two cannot disagree about which dates are reachable.
    const candidateSpan = {
      startTime: hhmmToTime(template.startTime),
      durationMinutes: template.durationMinutes,
    };
    // Both families' slot holders in one set, which is now what the table is
    // rather than something this function assembles. They are not told apart,
    // and deliberately: a date is unreachable for the same reason whichever
    // family holds it. The GENERATOR tells them apart, because its two reasons
    // carry two different remedies for the teacher.
    //
    // `spansOverlap` is same-date-only and the read above supplies that. It
    // therefore misses a neighbour spilling over midnight into a candidate,
    // exactly as the generator's pre-check does — so the two agree on that
    // case too, and the constraint refuses it at insert either way.
    const takenDates = new Set(
      slotHolders
        .filter((e) => spansOverlap(e, candidateSpan))
        .map((e) => e.date.getTime()),
    );

    // Removed from the candidates rather than folded into `heldWeeks`. Folding
    // would be shorter and would say something false: a taken slot does not
    // make the WEEK unavailable to this template in general, it makes this
    // one date unfillable — and since a weekly template has exactly one
    // candidate per week, the week is lost as a consequence, not as a
    // definition. The generator draws the same distinction, which is why it
    // reports two different reasons.
    const candidates = horizon.filter((date) => !takenDates.has(date.getTime()));

    const free = firstFreeWeek(candidates, heldWeeks);
    // Converted to the WEEK's Monday before leaving this function, not left as
    // the candidate date — see either family's `firstEffective` note for why
    // the conversion cannot live in the copy layer.
    return free === null ? null : new Date(mondayOf(free));
  } catch (err: unknown) {
    log.warn(
      { err, templateId: template.id },
      `${editNoun} edit saved, but the first-effective-week probe's own week arithmetic threw — the confirmation will not name a week`,
    );
    return null;
  }
}
