import { formatDayHeader } from '@/lib/format';
import type { LastScheduledClass } from '@/services/class-template-lifecycle';

/**
 * Confirmation shown after pausing a template. Only ever called on the pause
 * direction: both `resolveTemplateConfirmation` and
 * `resolveStudioConfirmation` answer `null` for `active`.
 *
 * That used to be justified as "resuming needs no explanation", which was
 * true when resuming did nothing but flip a flag. It is not true any more:
 * since #94 resuming a studio template generates its four-week window on the
 * spot, as the class family already did. `resumeStudioMessage` below is the
 * studio side's answer to that (#119); the class family's resume still says
 * nothing, tracked on #116.
 */
export function pauseMessage(lastScheduled: LastScheduledClass | null): string {
  return lastScheduled
    ? `No new classes will be added to your schedule. The last one still scheduled is ${formatDayHeader(lastScheduled.date)} · ${lastScheduled.startTime}.`
    : 'No new classes will be added to your schedule. Nothing from this template is currently scheduled.';
}

/**
 * Confirmation shown after archiving a recurring template. Un-archiving
 * deletes nothing and needs no explanation, so this is only ever called on
 * the archiving direction.
 *
 * No pronoun on the "still N classes" branches ("cancel individually", not
 * "cancel them individually") — a pronoun would have to agree with `classWord`
 * too, and already drifted out of agreement once. The verb was the second
 * slip: "There are still 1 class" repeats the same mistake with "are" instead
 * of a pronoun. Rather than add a second branch to make the verb agree too,
 * the phrasing drops the verb entirely — "1 class still on the schedule" —
 * so there is nothing left that can fall out of agreement with `classWord`.
 */
export function archiveMessage(deleted: number, remaining: number): string {
  const classWord = remaining === 1 ? 'class' : 'classes';

  if (deleted === 0 && remaining === 0) return 'Nothing from this template was scheduled.';

  // Not "No unbooked classes to delete" — a class dated today is unbooked and
  // still spared by the delete's boundary, so that phrasing contradicts the
  // very count in the same sentence. "Nothing was withdrawn" is true whether
  // the survivors are booked or merely too close to their start.
  if (deleted === 0) {
    return `Nothing was withdrawn. ${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
  }

  if (remaining === 0) {
    return 'Classes on the schedule without bookings are now deleted. Nothing from this template is scheduled any more.';
  }

  return `Classes on the schedule without bookings are now deleted. ${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
}

/**
 * Confirmation shown after archiving a studio class template. Un-archiving
 * deletes nothing and needs no explanation, so this is only ever called on
 * the archiving direction — mirroring `archiveMessage`.
 *
 * `remaining` is not always 0 here: `archiveOrUnarchiveStudioTemplate`'s
 * delete deliberately spares a class dated today, but the count backing
 * `remaining` is keyed from the start of the teacher's today instead,
 * matching what they see on their schedule — so archiving on a class's own
 * day legitimately leaves that one class behind. Pausing a studio template
 * reuses `pauseMessage` as-is rather than duplicating it — its wording never
 * names "recurring" or "studio", so it already fits both template families.
 */
export function archiveStudioMessage(deleted: number, remaining: number): string {
  const classWord = remaining === 1 ? 'class' : 'classes';

  if (deleted === 0 && remaining === 0) return 'Nothing from this template was scheduled.';

  if (deleted === 0) {
    return `${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
  }

  const deletedWord = deleted === 1 ? 'class' : 'classes';

  if (remaining === 0) {
    return `Deleted ${deleted} scheduled studio ${deletedWord}. Nothing from this template is scheduled any more.`;
  }

  return `Deleted ${deleted} scheduled studio ${deletedWord}. ${remaining} ${classWord} still on the schedule — cancel individually if needed.`;
}

/**
 * Confirmation shown after resuming a studio class template (#119).
 *
 * Reports what the window *holds*, not only what this click *added* —
 * mirroring `archiveStudioMessage`'s `deleted`/`remaining` pair, because the
 * same asymmetry applies: the teacher is on Settings and the effect lands on
 * the Schedule tab, so a bare delta is unreadable without its baseline.
 *
 * Deliberately makes no "for the next 4 weeks" claim. `scheduled` is counted
 * with `scheduledWhere(templateId, { gte: today })` — the same unbounded
 * from-today predicate archive's `remaining` uses — so no upper boundary backs
 * such a phrase. Bounding the count to the window would mean re-deriving the
 * generator's date *set* as a *range*, and two boundaries that can disagree at
 * the edges is the gt/gte defect this codebase has already paid for twice.
 *
 * The `scheduled === 0` branch names no cause. It is reachable exactly when
 * every candidate date holds a cancelled row — `pause → archive → un-archive →
 * resume` at its limit, the sequence #119 was filed about. That inference is
 * sound today and rests on generator internals, so it stays out of the copy:
 * occupancy is checkable by whoever reads the message, cause is not.
 *
 * Argument order is delta-first, matching `archiveStudioMessage(deleted,
 * remaining)`, even though the sentence leads with the second argument. The
 * asymmetry that makes a transposition detectable is real — `(0, 4)` reads "4
 * classes on your schedule. Nothing needed adding." where `(4, 0)` reads
 * "Nothing is scheduled from this template." — but it only *guards* the sole
 * production call site if a test drives that site with unequal numbers.
 *
 * It did not, until PR review measured it: transposing the arguments at
 * `resolveStudioConfirmation` below left `tsc` clean and every test in this
 * file and both button files green, because each resolver-level fixture passed
 * `scheduled === added === 4`. The unit tests here pin this *function's*
 * parameter order, which was never the risk — #93 was a wrong-shape *call
 * site*. Both `resolveStudioConfirmation`'s test and the button's `activeOk`
 * fixture now use `scheduled: 4, added: 0`, so a swap fails them; keep at least
 * one resolver-level case unequal or this paragraph stops being true again.
 *
 * No verb after the count, for the reason `archiveMessage` records above:
 * nothing left that can fall out of agreement with `classWord`.
 */
export function resumeStudioMessage(added: number, scheduled: number): string {
  if (scheduled === 0) return 'Nothing is scheduled from this template.';

  const classWord = scheduled === 1 ? 'class' : 'classes';

  return added === 0
    ? `${scheduled} ${classWord} on your schedule. Nothing needed adding.`
    : `${scheduled} ${classWord} on your schedule.`;
}

/**
 * Confirmation shown after un-archiving a studio class template.
 *
 * A constant rather than a function, unlike its siblings above: there is
 * nothing to interpolate, because the `unarchived` arm carries no counts.
 *
 * Un-archiving is not the no-op the old `return null` implied. Both directions
 * of `archiveOrUnarchiveStudioTemplate` force `isActive: false` in the same
 * write, and the archive already deleted the future classes — so a teacher who
 * un-archives to get their weekly class back lands on a *paused* template with
 * an empty window, and before this the only signal was that a differently
 * labelled button appeared. That is #119's failure mode one arm over, found by
 * PR review in this same function.
 *
 * The class family has the identical gap — `archiveOrUnarchiveTemplate` forces
 * `isActive: false` too (`class-template-lifecycle.ts`, and its own comment
 * says so) — and `resolveTemplateConfirmation` still answers `null` there.
 * Deliberately not fixed alongside this; tracked with the rest of the
 * class-family reporting work on #116.
 */
export const UNARCHIVE_STUDIO_MESSAGE =
  'Un-archived. This template is paused — resume it to put classes back on your schedule.';

/**
 * The `data` payload of a successful PATCH on a class template.
 *
 * The `scheduled?: never; added?: never` brand on the collapsed arm is what
 * keeps this type and `StudioTemplateToggleResponse` from being
 * interchangeable. Without it the studio type is assignable *to* this one —
 * excess-property checking fires only on fresh object literals, never on a
 * value of a declared type, and the other arms match verbatim — so
 * `resolveTemplateConfirmation(studioPayload)` compiled clean. PR review
 * measured both slips that buys: swapping the resolver in
 * `toggle-studio-template-button.tsx` restores #119 exactly, and in
 * `archive-studio-template-button.tsx` it substitutes `archiveMessage` for
 * `archiveStudioMessage` — #93's wrong-shape bug, the very failure the studio
 * type's own docblock cites as its justification. Both were caught only by
 * string-equality component tests; neither by the compiler.
 *
 * Same brand idiom as `TransactionClientOnly` in `@/lib/db-locks` — see its
 * docblock for the reasoning. If #116 ever gives the class family's resume a
 * count, this brand is what it removes.
 */
export type TemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | { action: 'active' | 'unarchived' | 'unchanged'; scheduled?: never; added?: never };

/**
 * The `data` payload of a successful PATCH on a *studio* class template (#119).
 *
 * Split from `TemplateToggleResponse` rather than adding optional fields to its
 * shared `active` arm. The optional-field version is the smaller diff and
 * certifies nothing: the class family would carry `scheduled?`/`added?` it
 * never sets, and nothing would notice if the studio route stopped setting
 * them. That is the failure `resolveTemplateConfirmation` records below — #93's
 * wrong-shape bug, where `archiveStudioMessage` had the wrong signature and the
 * button silently discarded `remaining` — and the one #136's pins exist to
 * prevent.
 *
 * `scheduled` and `added` are required, not optional. The route sends both on
 * every `active` response; a type that allowed their absence would be
 * describing a payload the server cannot produce.
 */
export type StudioTemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | { action: 'active'; scheduled: number; added: number }
  | { action: 'unarchived' | 'unchanged' };

/**
 * Decides whether the button says anything, and what.
 *
 * `null` means "say nothing", which is the correct answer for three of the five
 * actions — and `unchanged` is the one that matters: it is what a stale second
 * tab and a retry-after-lost-response reach, so showing either confirmation
 * there would describe something that did not happen.
 *
 * Pure, and separated from the components for that reason: this is the seam the
 * #93 wrong-shape bug lived in (`archiveStudioMessage` had the wrong signature
 * and the button silently discarded `remaining`), and it was caught by review
 * rather than by a test because nothing here was testable.
 */
export function resolveTemplateConfirmation(data: TemplateToggleResponse): string | null {
  if (data.action === 'paused') {
    const last = data.lastScheduled;
    return pauseMessage(last ? { date: new Date(last.date), startTime: last.startTime } : null);
  }
  if (data.action === 'archived') return archiveMessage(data.deleted, data.remaining);
  return null;
}

/**
 * The studio sibling of `resolveTemplateConfirmation`. A separate function
 * rather than a parameter: the two families now differ in the archive wording
 * *and* in whether resuming says anything at all (#119), so threading a message
 * function through would put most of the English in the caller — and they are
 * kept parallel-but-separate throughout regardless.
 *
 * `null` is now the right answer for exactly one of the five actions, not the
 * class family's three: `active` speaks (#119) and so does `unarchived` (see
 * `UNARCHIVE_STUDIO_MESSAGE`). `unchanged` is the one that still must not — it
 * is what a stale second tab and a retry-after-lost-response reach, so a
 * confirmation there would describe something that did not happen.
 *
 * A `switch` with a `never` default rather than an if-chain, for the reason
 * `api/studio-class-templates/[id]/route.ts` records for its own: an if-chain
 * ending in `return null` is *accidentally* exhaustive, so a sixth arm on
 * `StudioTemplateToggleResponse` would compile clean and fall through to
 * silence — reproducing #119 by adding a field. Measured during PR review: a
 * fifth arm added to the type left `tsc` at exit 0. The route grew this guard
 * in the same PR; this is the layer #119's bug actually lived at.
 *
 * Nothing is said on **create**, and that is a decision rather than an
 * oversight to be tidied up later. Creating a weekly template means "put this
 * on my schedule weekly", so four classes appearing is the definition of the
 * thing working, not a consequence needing disclosure — and both families'
 * create forms navigate to their own settings list, where the teacher sees the
 * template they just made. The class family settled the same question for its
 * own POST: see
 * `docs/superpowers/specs/2026-07-23-template-generate-on-create-design.md`
 * ("Response shapes are unchanged … The front-end needs no changes").
 */
export function resolveStudioConfirmation(data: StudioTemplateToggleResponse): string | null {
  switch (data.action) {
    case 'paused': {
      const last = data.lastScheduled;
      return pauseMessage(last ? { date: new Date(last.date), startTime: last.startTime } : null);
    }
    case 'archived':
      return archiveStudioMessage(data.deleted, data.remaining);
    case 'active':
      // Checked rather than trusted, even though the type says `number`. Both
      // buttons reach this through an unchecked `as` on `res.json()`, so the
      // type constrains the server and nothing constrains the wire: a tab
      // holding this bundle against a rolled-back server receives
      // `{ action: 'active' }` with no counts, and `resumeStudioMessage`'s
      // template literal then renders "undefined classes on your schedule."
      // Saying nothing is the honest fallback — this function's whole contract
      // is that `null` means "say nothing".
      if (!Number.isInteger(data.added) || !Number.isInteger(data.scheduled)) return null;
      return resumeStudioMessage(data.added, data.scheduled);
    case 'unarchived':
      return UNARCHIVE_STUDIO_MESSAGE;
    case 'unchanged':
      return null;
    default: {
      const unhandled: never = data;
      void unhandled;
      return null;
    }
  }
}
