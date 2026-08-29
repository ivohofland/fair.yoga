/**
 * The date maths both template families share when turning a `ScheduleRule`
 * into calendar dates — the entry layer's counterpart to `rule-lifecycle.ts`,
 * which holds the rule layer's own "written once for both families" logic.
 *
 * Imported BY `class-generator.ts`, `studio-class-generator.ts` and
 * `rule-lifecycle.ts`. The direction is one-way and must stay that way: this
 * module imports none of the three, so nothing here can complete a cycle back
 * through a generator or through the shared rule lifecycle.
 *
 * Imports `@/lib/timezone` (`mondayOf`), which itself imports `@/lib/log`
 * (pino) — so this module is server-only through that chain. Nothing under
 * `'use client'` may value-import it.
 */

import type { ScheduleRule } from '@prisma/client';
import { mondayOf } from '@/lib/timezone';

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
 * `generateInstancesForTemplate` below decides which dates the hourly sweep
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
 * `generateInstancesForTemplate` below does NOT call it, and the plan's
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
