import { classStartInstant } from '@/lib/timezone';

/**
 * When a studio class may be removed, and why the answer is not "whenever the
 * teacher asks" (issue 279).
 *
 * The sibling of `room-deletion.ts`, and deliberately shaped like it: that file
 * exists because archiving and deleting ask different questions and must answer
 * them differently. Here the two doors are CANCEL and REMOVE.
 *
 * THE RULE: a studio class may be removed when removal is STABLE — when nothing
 * will create it again.
 *
 *   removable ⟺ templateId === null            (manual: no generator owns it)
 *             ∨ its start instant has passed   (never a generation candidate)
 *
 * The second clause is not a preference. It is read off the generator's own
 * candidate filter, `src/services/studio-class-generator.ts:138-143`, which
 * keeps only occurrences whose `classStartInstant(...)` is still AHEAD of now.
 * A class whose start has passed can never be regenerated, so removing it
 * sticks.
 *
 * Removing a FUTURE GENERATED class would release its `(templateId, date)` key
 * and the hourly sweep would recreate it — within the hour, silently, forever.
 * That is the same failure that made issue 275 withdraw "narrow the unique
 * index to live rows" as a remedy. A delete that quietly reverses itself reads
 * as the app ignoring the teacher, so this door refuses and names the one that
 * works. Cancel is the correct operation there, and it already exists.
 *
 * ── THE PARAMETER TYPE IS THE GUARD. DO NOT WIDEN IT. ──────────────────────
 *
 * `sc` carries three fields and no more, which makes two wrong edits
 * unrepresentable rather than merely discouraged:
 *
 *   1. TEMPLATE STATE (`isActive`, `isArchived`). Tempting, because an archived
 *      template generates nothing, so a future class under one looks safe to
 *      remove. It is not: template state is REVERSIBLE. Un-archive → resume →
 *      generation restarts, and a date released under the archived reading is
 *      refilled. A predicate that reads reversible state is a predicate that
 *      can flip. `room-deletion.ts:14-21` gives this exact warning one model
 *      over — "the single most likely wrong edit here: it compiles, it passes
 *      any test written against a live template".
 *
 *   2. `cancelledAt`. Removability is about whether the sweep brings the class
 *      back, and the sweep counts a cancelled own-row as occupancy either way
 *      (`studio-class-generator.ts:166`, `blocked_by_cancelled`). Making
 *      cancellation a precondition would force the teacher to create the litter
 *      before they could clear it.
 *
 * Adding either read requires widening this signature, which breaks every call
 * site and every test at once. That is the intended cost.
 *
 * ── AFTER WEEK-KEYED GENERATION (issue 284) ────────────────────────────────
 *
 * Issue 284 makes occupancy per `(template, week)` rather than per
 * `(template, date)`, cancelled rows included. A PAST class occupies its week
 * just as a future one does, so removing a past GENERATED class can free that
 * week and let the sweep fill a still-future candidate in the same week — for
 * instance a template moved Tuesday → Thursday mid-week.
 *
 * The rule does not change and this predicate does not narrow. What changes is
 * the sentence above: removal never resurrects the removed class, but under
 * week-keying it may free that class's WEEK, which is the week rule working as
 * specified. A manual class belongs to no template's week and is unaffected in
 * either era. See the spec's §5 for the worked path.
 */
export type StudioClassDeletability =
  | { deletable: true }
  | { deletable: false; reason: 'regenerates' };

/**
 * One refusal, naming the remedy — the shape `ROOM_DELETE_BLOCKED_MESSAGE`
 * uses ("This room is still in use and cannot be deleted. Archive it
 * instead."). Prose, not a developer string: `src/app/(teacher)` renders
 * `error.message` verbatim, which is what issue 197 is about.
 */
export const STUDIO_CLASS_REGENERATES_MESSAGE =
  'This class has not started yet and comes from a recurring template, so removing it would only create it again. Cancel it instead.';

/**
 * Asserted by the integration cases, so a route that stops consulting the
 * predicate reddens them rather than silently answering 200 — the property
 * `ROOM_IN_USE_CODE`'s docblock was added to buy for its own door.
 */
export const STUDIO_CLASS_REGENERATES_CODE = 'STUDIO_CLASS_REGENERATES';

export function studioClassDeletability(
  sc: { templateId: string | null; date: Date; startTime: string },
  now: Date,
  timeZone: string,
): StudioClassDeletability {
  if (sc.templateId === null) return { deletable: true };
  if (classStartInstant(sc.date, sc.startTime, timeZone) <= now) return { deletable: true };
  return { deletable: false, reason: 'regenerates' };
}
