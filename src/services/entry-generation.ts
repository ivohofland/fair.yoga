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
 *   grep -rl "from '\./entry-generation'\|from '@/services/entry-generation'" src/ tests/
 *
 * Imports `@/lib/log` (pino) directly, and `@/lib/timezone`, which imports it
 * too — so this module is server-only. Nothing under `'use client'` may
 * value-import it.
 */

import type { ClassFamily, Prisma, PrismaClient, ScheduleRule } from '@prisma/client';
import { spansOverlap } from '@/lib/generation';
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
import { probeOverlappingCandidates } from '@/lib/entry-conflict';
import type { TransactionClientOnly } from '@/lib/db-locks';
import { classStartInstant, mondayOf } from '@/lib/timezone';
import { timeToHHmm } from '@/lib/time-of-day';
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
 * Exported since #194 for `updateClassTemplate`'s probe, which deliberately
 * looks TWICE this far. The asymmetry is the point rather than a
 * disagreement: when all four of the generator's weeks are held by the
 * superseded schedule, the honest answer to "when does this edit take effect"
 * is week five, and no window this generator can see contains it. Derived
 * there rather than restated, so a change to the window moves the prediction
 * with it.
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
 * actually fills, and `firstFreeWeek` — through `updateClassTemplate`'s probe
 * — decides which week the teacher is TOLD it will fill. Two copies of
 * `heldWeeks.has(mondayOf(date))` is precisely how a sentence and a behaviour
 * drift apart, and the drift is invisible from either side: both halves keep
 * passing their own tests while saying different things.
 *
 * It is the definition of "held" that is shared here, not the decision. The
 * generator must name a *reason* for every candidate date it declines, and a
 * `Date | null` cannot carry one — see `firstFreeWeek` below, which records
 * why the plan's "one decision function, two callers" was corrected rather
 * than upheld.
 *
 * `heldWeeks` is a set of `mondayOf` values, and both call sites build it the
 * same way: a `scheduleRuleId`-keyed `findMany` over `CalendarEntry` with NO
 * liveness filter, because a cancelled entry holds its week
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
 * Pure. Its caller is the template-edit endpoint's probe — `updateClassTemplate`
 * in `class-template-lifecycle.ts` — deciding what to tell the teacher.
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
// generateEntriesForRule
// ---------------------------------------------------------------------------

/**
 * The noun this family's generation log lines use. A union rather than
 * `string`, matching `TemplateFamily.logNoun` (`rule-lifecycle.ts`): the
 * messages composed from it below are what an operator greps for, so the
 * roster belongs to the compiler rather than to a sentence naming its members.
 */
export type GenerationLogNoun = 'recurring class' | 'studio class';

/**
 * Everything the shared generator below needs in order to run over one family.
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
 * `readChildOrThrow` is declared here and called nowhere yet, so that the two
 * descriptors are written once rather than grown a field at a time.
 *
 * `TChild` appears in a parameter position (`createChildren`'s) and inside
 * `ChildWithRule` in a return position (`readChildOrThrow`'s), so the type is
 * invariant in it. `TKind` appears only in a property position, so it is
 * covariant.
 */
export type GeneratorFamily<TChild, TKind extends ClassFamily = ClassFamily> = {
  /**
   * The `CalendarEntry.kind` this family's entries carry. Written onto every
   * row the generator inserts, and the value its same-family `slot_taken`
   * pre-check compares an occupant against — the two must be the same literal
   * or a family reports its neighbour's entries as its own.
   */
  kind: TKind;
  logNoun: GenerationLogNoun;
  /**
   * The child's table. Narrowed to the template children rather than left at
   * `Prisma.ModelName`, which admits every model in the schema, so a third
   * family becomes a deliberate edit here rather than a silent widening —
   * `TemplateFamily.childTable` (`rule-lifecycle.ts`) carries the same
   * narrowing and the pin that proves the compiler enforces it.
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
};

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
 * roster reaches past this file and has no owner here. Both generators' own
 * test files do call this with a bare `prisma`, which is why the parameter
 * type admits one. Do not reintroduce a `catch` here; there is nothing it can
 * do that the constraint does not.
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

  // `dates` CAN be empty. The sentence that used to be here said it could not
  // — "the filter above can only drop the first of five" — and that holds only
  // while every start instant is READABLE. `classStartInstant`
  // (`@/lib/timezone`) fails soft by design: an unparseable `startTime`
  // returns `new Date(NaN)` rather than throwing, `NaN > startDate` is
  // `false`, and the filter drops all five.
  //
  // What actually keeps that out of reach is the WRITE path, not this filter.
  // Every route that sets a template's `startTime` validates it with
  // `timeHHmm` (`@/lib/schemas`), so no stored row can carry a value
  // `classStartInstant` cannot read, and no path reaches the empty case today.
  // But that is a guarantee about the WRITERS — wideable by a new route, a
  // migration, or a manual `UPDATE` — where the old sentence claimed one about
  // this function, which was never there.
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
  // where both families' occupancy lives. It replaces two reads per family: the
  // per-family child scan this used to be, and the separate cross-family read
  // beside it that named the cross-family reason. Scoped to this teacher because
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
    // the constraint that backs it — see the spec's §4.1.
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
