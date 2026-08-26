import { startOfLocalDay } from '@/lib/timezone';

// Re-exported so SERVER consumers need only this module. Client surfaces must
// import `@/services/studio-class-edit-refusals` directly — reaching them
// through here would drag in this file's server-only chain (see that module's
// docblock).
export {
  STUDIO_CLASS_EDIT_REFUSALS,
  type StudioClassEditRefusal,
} from '@/services/studio-class-edit-refusals';

/**
 * What may still change on a logged studio class, and why the answer is a
 * function of one fact — the calendar date (issue 276, decision D1).
 *
 * The sibling of `studio-class-deletion.ts`, which settles REMOVAL; this file
 * settles EDITING. Same shape on purpose: pure predicate, injected `now` and
 * `timeZone`, and a two-field object built for it — never the Prisma row.
 *
 * THE RULE: a studio class whose calendar date is strictly before the
 * teacher's local today is an income record. Only its student count and its
 * cancellation remain writable. Today or later, the whole schedule is
 * editable.
 *
 *   scheduleEditable ⟺ NOT past
 *   dateEditable     ⟺ scheduleEditable AND scheduleRuleId === null
 *
 * ── WHY A CALENDAR DATE AND NOT A START INSTANT ────────────────────────────
 *
 * `studio-class-deletion.ts` documents the stamp-vs-record argument at length;
 * the short form: a class's `startTime` is a stamp that may disagree with its
 * template's current one BY DESIGN, so any rule reading it answers from the
 * wrong source. The calendar comparison has no such seam. Today-dated classes
 * stay editable because a teacher logs the student count after the class.
 *
 * ── WHY A GENERATED ROW MAY NOT MOVE ITS DATE ──────────────────────────────
 *
 * Moving the row frees its `(scheduleRuleId, date)` key, and the hourly sweep —
 * which counts any row of the template, cancelled included, as occupancy per
 * date — recreates the class on the old date within the hour. That is the
 * delete-resurrection race the deletion service exists to prevent, reached
 * through a different verb. Cancelling is what holds a date against the
 * sweep, so the refusal names cancel-plus-manual-recreate as the remedy. It is
 * also the one edit that CAN resurrect, which is why `dateEditable` exists
 * while nothing else here is gated on the sweep.
 *
 * Cancellation gates nothing — it is recoverable, so freezing edits on it
 * would only force an un-cancel round-trip before each correction. Reasoning
 * in the spec's §D1.
 *
 * ── WHAT THIS PREDICATE DOES NOT ANSWER ────────────────────────────────────
 *
 * It reads the STORED row, so it says whether a row is editable now — never
 * whether a row stays editable after a given write. A date move landing before
 * today is the case where those differ, and the route gates it separately
 * (`past_date`); see the gates in `api/studio-classes/[id]/route.ts`.
 *
 * THE PARAMETER IS NARROW ON PURPOSE: callers pass `{ scheduleRuleId, date }` and
 * nothing more, so the predicate is physically handed only what it may read.
 * That is a speed bump, not a wall — a REQUIRED new field breaks every call
 * site, an OPTIONAL one compiles silently at all of them. The alarm is the
 * `@ts-expect-error` case at the end of this file's test, as in the sibling.
 */
export type StudioClassEditVerdict =
  /** Income record: only `studentCount` and `cancelledAt` remain writable. */
  | { scheduleEditable: false; dateEditable: false }
  /** Not past: the whole schedule may change; `date` only on a manual row. */
  | { scheduleEditable: true; dateEditable: boolean };

/**
 * Is this calendar date strictly before the teacher's local today?
 *
 * One owner for the comparison, because two callers now ask it of two
 * different dates: the verdict below asks it of the STORED date ("is this row
 * an income record?"), and the route's `past_date` gate asks it of an INCOMING
 * one ("would this write make it one?"). Same rule, same fail-closed answer on
 * an unreadable value — an unparseable date reads as past, never as safe.
 */
export function studioClassDateIsPast(date: Date, now: Date, timeZone: string): boolean {
  // Every comparison against NaN is false, so an unreadable date would
  // otherwise read as "not past" and open what it cannot describe. See the
  // fail-closed cases in this file's test.
  if (Number.isNaN(date.getTime())) return true;

  // Two calendar dates, the only sound comparison against a `@db.Date`
  // column — `startOfLocalDay` returns midnight UTC of the teacher's local
  // date, the representation Prisma hands back for a `date` column. Comparing
  // either side to a raw instant taxes the teacher's calendar with UTC's
  // (`timezone.ts`).
  return startOfLocalDay(now, timeZone) > date;
}

export function studioClassEditability(
  sc: { scheduleRuleId: string | null; date: Date },
  now: Date,
  timeZone: string,
): StudioClassEditVerdict {
  // Fails closed on an unreadable date, which matters here in a way it does
  // not in the sibling `studio-class-deletion.ts`: there NaN falls through to
  // the refusal, already the safe answer, whereas an editability verdict
  // reached by the same fall-through would read "not past" and open the whole
  // schedule. `studioClassDateIsPast` owns that guard for both callers.
  if (studioClassDateIsPast(sc.date, now, timeZone)) {
    return { scheduleEditable: false, dateEditable: false };
  }
  return { scheduleEditable: true, dateEditable: sc.scheduleRuleId === null };
}
