import { startOfLocalDay } from '@/lib/timezone';

/**
 * What may still change on a logged studio class, and why the answer is a
 * function of one fact — the calendar date (issue 276, decision D1).
 *
 * The sibling of `studio-class-deletion.ts`, which settles REMOVAL; this file
 * settles EDITING. Same shape on purpose: pure predicate, injected `now` and
 * `timeZone`, parameter handed a fresh two-field literal by every call site,
 * never the Prisma row.
 *
 * THE RULE: a studio class whose calendar date is strictly before the
 * teacher's local today is an income record. Only its student count and its
 * cancellation remain writable. Today or later, the whole schedule is
 * editable.
 *
 *   scheduleEditable ⟺ NOT past
 *   dateEditable     ⟺ scheduleEditable AND templateId === null
 *
 * ── WHY A CALENDAR DATE AND NOT A START INSTANT ────────────────────────────
 *
 * `studio-class-deletion.ts` documents the stamp-vs-record argument at length;
 * the short form: a class's `startTime` is a stamp that may disagree with its
 * template's current one BY DESIGN, so any rule reading it answers from the
 * wrong source. The calendar comparison has no such seam — and unlike removal,
 * editing nothing here resurrects, so today-dated classes stay editable (a
 * teacher logs the student count after the class; freezing today would break
 * existing behaviour).
 *
 * ── WHY CANCELLATION GATES NOTHING ─────────────────────────────────────────
 *
 * A studio cancellation is recoverable — the API already un-cancels, and #275
 * wants a door to it. Freezing edits on a recoverable state would only force
 * an un-cancel round-trip before each correction. One predicate, one truth:
 * past vs not-past, cancelled or not.
 *
 * ── WHY A GENERATED ROW MAY NOT MOVE ITS DATE ──────────────────────────────
 *
 * Moving the row frees its `(templateId, date)` key, and the hourly sweep —
 * which counts any row of the template, cancelled included, as occupancy per
 * date — recreates the class on the old date within the hour. That is the
 * delete-resurrection race the deletion service exists to prevent, reached
 * through a different verb. Cancelling is what holds a date against the
 * sweep, so the refusal names cancel-plus-manual-recreate as the remedy.
 * (`dateEditable ⇒ scheduleEditable` holds by construction; the unit suite
 * sweeps the whole matrix for the counterexample cell.)
 *
 * THE PARAMETER TYPE IS THE GUARD, as in the sibling: callers pass
 * `{ templateId, date }` and nothing more, so a future edit that makes the
 * verdict read `cancelledAt` or template state is a visible signature change.
 */
export interface StudioClassEditVerdict {
  /** false ⇒ income record: only studentCount and cancelledAt remain writable */
  scheduleEditable: boolean;
  /** `date` may move: manual row, and not an income record */
  dateEditable: boolean;
}

export type StudioClassEditRefusal = 'income_record' | 'generated_date';

/**
 * One refusal per reason, each naming the remedy — the shape
 * `STUDIO_CLASS_REFUSALS` uses, and for the same reason: a `Record` keyed by
 * the union makes adding a member a compile error until it has a message and
 * code of its own. Prose, not developer strings — `(teacher)` pages render
 * `error.message` verbatim (#197).
 */
export const STUDIO_CLASS_EDIT_REFUSALS: Record<
  StudioClassEditRefusal,
  { readonly message: string; readonly code: string }
> = {
  income_record: {
    message:
      'This class is in the past, so only its student count and cancellation can still change.',
    code: 'STUDIO_CLASS_INCOME_RECORD',
  },
  generated_date: {
    message:
      'This class comes from a recurring template, so it cannot move to another date. Cancel it and log a manual class on the new date instead.',
    code: 'STUDIO_CLASS_GENERATED_DATE',
  },
};

export function studioClassEditability(
  sc: { templateId: string | null; date: Date },
  now: Date,
  timeZone: string,
): StudioClassEditVerdict {
  // FAIL CLOSED, EXPLICITLY — same redundant-today guard as the sibling's own
  // (`studio-class-deletion.ts`): without it `NaN > date` is false, an
  // unreadable date reads as "not past", and editing opens on a value nobody
  // could read. Deleting this line alone changes no other outcome; what it
  // defends against is the INVERSION below reading as equivalent while
  // silently re-opening unreadable rows. The NaN test pins the outcome; this
  // line pins it under refactor.

  if (Number.isNaN(sc.date.getTime())) return { scheduleEditable: false, dateEditable: false };

  // Two calendar dates, the only sound comparison against a `@db.Date`
  // column — `startOfLocalDay` returns midnight UTC of the teacher's local
  // date, the representation Prisma hands back for `sc.date`. Comparing
  // either side to a raw instant taxes the teacher's calendar with UTC's
  // (`timezone.ts`).
  const past = startOfLocalDay(now, timeZone) > sc.date;

  const scheduleEditable = !past;
  return { scheduleEditable, dateEditable: scheduleEditable && sc.templateId === null };
}
