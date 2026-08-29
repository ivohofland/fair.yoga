import { startOfLocalDay } from '@/lib/timezone';

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
 *   removable ⟺ scheduleRuleId === null      (manual: no generator owns it)
 *             ∨ its calendar date is strictly before the teacher's today
 *
 * ── WHY A CALENDAR DATE AND NOT A START INSTANT ────────────────────────────
 *
 * The obvious reading — "removable once it has started" — is wrong, and was
 * the shipped rule until PR #295's review caught it.
 *
 * A class's `startTime` is a STAMP, and nothing that picks the candidate dates
 * reads it. `generateEntriesForRule` (`entry-generation.ts`) derives its
 * candidate span from `template.scheduleRule.startTime` — the TEMPLATE's
 * current value — and drops the dates whose start, computed from THAT, has
 * already passed; its `occupants` read then measures the same
 * template-derived span against whatever standing entries hold. One generator
 * serves both families since #284, so both of those names are in shared code,
 * not the studio adapter. Editing a template moves the template's value and
 * leaves every standing class untouched — "a template is a stamp, not a live
 * link", CLAUDE.md — so the two disagree BY DESIGN, and a start-instant rule
 * answers from the wrong one.
 *
 * Worked: template moved Wed 09:00 → 19:00; the standing class keeps 09:00. At
 * 10:30 its own start has passed, so the old rule allowed removal — and the
 * sweep, filtering on 19:00, found that instant still ahead, found
 * `(scheduleRuleId, date)` released by the removal, and re-inserted on the same
 * date within the hour. A delete that undid itself, which is precisely what
 * this file exists to prevent.
 *
 * The calendar-date rule is IMMUNE to that divergence rather than careful about
 * it. The latest instant any start time can name on a date is 23:59 local,
 * which precedes the next local midnight. So if the date is strictly before the
 * teacher's today, every start time on it has already passed, and the
 * generator's `> now` filter drops the date whatever the template now says.
 * No `startTime` is read here, which is why the parameter no longer carries one.
 *
 * The cost is deliberate and small: a generated class dated TODAY is not
 * removable until tomorrow, however long ago it started. Cancel is available
 * today, and the refusal names it. Refusing a removal the teacher could have
 * had is recoverable; granting one the sweep reverses is not.
 *
 * Removing a FUTURE GENERATED class would release its `(scheduleRuleId, date)` key
 * and the hourly sweep would recreate it — within the hour, silently, and again
 * on every sweep until that date's start passes. Bounded, not unbounded: the
 * generator's window is four occurrences, so at most ~4 weeks of a delete that
 * undoes itself. Issue 275's own first comment makes exactly that correction to
 * the word "forever", and it is repeated here rather than re-inherited.
 *
 * ── THE PARAMETER TYPE IS THE GUARD. DO NOT WIDEN IT. ──────────────────────
 *
 * `sc` carries two fields and no more, which makes two wrong edits expensive:
 *
 *   1. TEMPLATE STATE (`isActive`, `isArchived`). Tempting, because an archived
 *      template generates nothing, so a future class under one looks safe to
 *      remove. It is not: template state is REVERSIBLE. Un-archive → resume →
 *      generation restarts, and a date released under the archived reading is
 *      refilled. A predicate that reads reversible state is a predicate that
 *      can flip. `room-deletion.ts` gives this exact warning one model
 *      over — "the single most likely wrong edit here: it compiles, it passes
 *      any test written against a live template".
 *
 *   2. `cancelledAt`. Removability is about whether the sweep brings the class
 *      back, and the sweep counts a cancelled own-row as occupancy either way
 *      (`generateEntriesForRule`'s own-row branch, which reports
 *      `blocked_by_cancelled` rather than leaving the date free). Making
 *      cancellation a precondition would force the teacher to create the litter
 *      before they could clear it.
 *
 * HOW STRONG THAT GUARD ACTUALLY IS — stated precisely, because the earlier
 * wording ("unrepresentable", "breaks every call site at once") was measured
 * false in review and is worth no reader's trust:
 *
 *   - A REQUIRED new field breaks both production call sites and every test.
 *   - An OPTIONAL one (`template?: …`) breaks none of them. Excess-property
 *     checking cannot help: an optional field IS part of the widened type, so
 *     supplying it is legal and omitting it is legal, at a literal as much as at
 *     a variable. Every production call site stays green by construction.
 *
 * So the type is a speed bump, not a wall, and ONE thing carries the rest: the
 * `@ts-expect-error` case at the end of the test file. Under a widening it stops
 * being an error, and an unused directive is itself `TS2578` — so `tsc` fails
 * there and nowhere else. Measured: widening this parameter produces exactly one
 * error, and it is that line. **Watch for a `?` in review, and never delete that
 * case.**
 *
 * ── AFTER WEEK-KEYED GENERATION (issue 284) ────────────────────────────────
 *
 * Issue 284 makes occupancy per `(template, week)` rather than per
 * `(template, date)`, cancelled rows included. A PAST class occupies its week
 * just as a future one does, so removing a past GENERATED class can free that
 * week and let the sweep fill a still-future candidate in the same week — for
 * instance a template moved Tuesday → Thursday mid-week.
 *
 * The rule does not change and this predicate does not narrow: removal never
 * resurrects the removed class, but under week-keying it may free that
 * class's WEEK, which is the week rule working as specified, not a defect.
 * A manual class belongs to no template's week and is unaffected. See the
 * spec's §5 for the worked path.
 *
 * Pinned by `studio-class-deletion.test.ts`, "a removed past generated class
 * frees its week (issue 284)" — both halves asserted: the `already_this_week`
 * skip before the removal, and the created row after. The first is what makes
 * the second mean anything — a generator degraded back to a per-DATE key
 * creates that same row on that same call, removal or not.
 */
export type StudioClassRefusal = 'regenerates';

export type StudioClassDeletability =
  | { deletable: true }
  | { deletable: false; reason: StudioClassRefusal };

/**
 * The only facts removability may rest on, as a Prisma `select`.
 *
 * USED BY THE ROUTE, which needs a projection anyway and should fetch nothing
 * more. **The page does NOT use it, and cannot**: it renders the template's
 * name and link, so its query is legitimately wider
 * (`include: { template: true }`).
 *
 * That asymmetry is the hazard this file has to name rather than paper over.
 * The page once handed its whole row to the predicate, so a widening that read
 * template state was inert in the route (whose `select` omitted it) and LIVE on
 * the page — the page offered "Remove this class" and the API refused it 409, a
 * dead-end control no test could see. What prevents that now is NOT this
 * constant: it is that both call sites build a fresh two-field literal and pass
 * that, never the row. Keep it that way. A future field added here reaches the
 * route only, so read the call sites, not this list, to know what the predicate
 * can see.
 */
export const STUDIO_CLASS_REMOVAL_FACTS_SELECT = {
  scheduleRuleId: true,
  date: true,
} as const;

/**
 * One refusal per reason, each naming the remedy — the shape
 * `ROOM_DELETE_BLOCKED_MESSAGE` uses ("This room is still in use and cannot be
 * deleted. Archive it instead."). Prose, not a developer string:
 * `src/app/(teacher)` renders `error.message` verbatim, which is what issue 197
 * is about.
 *
 * A `Record` keyed by the union rather than two loose constants, so the
 * exhaustiveness is the compiler's problem: adding a member to
 * `StudioClassRefusal` fails to compile here until it has a message and a code
 * of its own. Before this, no caller read `reason` at all — a second refusal
 * would silently have inherited the regenerates message and logged that the
 * sweep would recreate a class when it would not.
 */
export const STUDIO_CLASS_REFUSALS: Record<
  StudioClassRefusal,
  { readonly message: string; readonly code: string }
> = {
  regenerates: {
    message:
      'This class comes from a recurring template and is not yet past, so removing it would only create it again. Cancel it instead.',
    code: 'STUDIO_CLASS_REGENERATES',
  },
};

export function studioClassDeletability(
  sc: { scheduleRuleId: string | null; date: Date },
  now: Date,
  timeZone: string,
): StudioClassDeletability {
  if (sc.scheduleRuleId === null) return { deletable: true };

  // FAIL CLOSED, EXPLICITLY — and this line is REDUNDANT TODAY, on purpose.
  // Without it the refusal is still correct, but only by the polarity of the
  // comparison below: `NaN > date` is false, so an unreadable date falls through
  // to the refusal. Delete this line alone and no test reddens, because the
  // outcome is unchanged. What it defends against is the INVERSION — rewriting
  // the tail as `if (today <= sc.date) refuse; return allow;`, which reads as
  // equivalent and silently removes classes with an unreadable date. With this
  // guard the inversion stays safe; without it, the NaN test catches it. So the
  // test pins the OUTCOME and this line pins it under a refactor — neither pins
  // the other, which is why both are here.
  if (Number.isNaN(sc.date.getTime())) return { deletable: false, reason: 'regenerates' };

  // Two calendar dates, which is the only sound comparison against a `@db.Date`
  // column — `startOfLocalDay` returns midnight UTC of the teacher's local date,
  // the same representation Prisma hands back for `sc.date`. Comparing either
  // one to a raw instant treats the teacher's calendar as UTC's, wrong in both
  // directions away from offset 0 — `startOfLocalDay`'s own docblock argues it.
  if (startOfLocalDay(now, timeZone) > sc.date) return { deletable: true };

  return { deletable: false, reason: 'regenerates' };
}
