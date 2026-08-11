import { formatDayHeader } from '@/lib/format';
import type { LastScheduledClass } from '@/services/class-template-lifecycle';

/**
 * Confirmation shown after pausing a template. Only ever called on the pause
 * direction — both resolvers reach it solely from their `paused` arm.
 *
 * That used to be justified by "both resolvers answer `null` for `active`",
 * which is no longer true in either family: `resolveStudioConfirmation` has
 * answered with a sentence since #119, and `resolveTemplateConfirmation` does
 * too since #164/#192 gave the class family's resume counts of its own. The
 * conclusion survives its premise — this function is still only called from
 * the `paused` arm, which is checkable from the two call sites.
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
 * The cause clauses are measurements, not inferences. `blockedByCancelled` and
 * `slotTaken` are counted by `generateStudioInstancesForTemplate` and carried
 * over the wire, so the sentence can say *why* a number is short instead of
 * leaving it to the teacher to guess — see `resumeMessage` for the fuller
 * account.
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
 * The head of this sentence keeps `archiveMessage`'s no-verb-after-the-count
 * rule. The cause clauses `resumeMessage` appends do not — see its docblock for
 * which of them can fall out of agreement and which cannot.
 */
export function resumeStudioMessage(
  added: number,
  scheduled: number,
  blockedByCancelled: number,
  slotTaken: number,
): string {
  // Delegates rather than duplicates. The two families' resume sentences are
  // identical word for word — unlike `archiveMessage`/`archiveStudioMessage`,
  // which are split because their wording genuinely differs — and this file
  // already shares `pauseMessage` between both resolvers on exactly that
  // basis. Kept as a separate export so the studio resolver's call site stays
  // family-specific and a future divergence has somewhere to land; delegating
  // so that until it does, the two cannot drift apart unnoticed.
  return resumeMessage(added, scheduled, blockedByCancelled, slotTaken);
}

/**
 * The class family's resume sentence. Parallel to `resumeStudioMessage` and
 * separate from it for the reason `resolveTemplateConfirmation` records: the
 * two families are kept parallel-but-separate rather than parameterised.
 *
 * The cause clauses are measurements, not inferences. Until #164/#192 the
 * generator returned a bare count, so naming a cause here would have encoded a
 * guess about generator internals — which is exactly why the studio sibling
 * declined to. `blockedByCancelled` and `slotTaken` are now counted by the
 * generator and carried over the wire, so the sentence can say what happened.
 *
 * Every cause that applies is named, rather than one at a time. An earlier
 * draft claimed `blockedByCancelled` "cannot co-occur" with a non-zero
 * `scheduled`; it can, and the case it dismissed is the one #192 exists for.
 * `scheduled` counts only `SCHEDULED_STATUSES` — `draft` and `open`
 * (`class-template-lifecycle.ts`) — so a cancelled instance is excluded from it
 * while still producing `blocked_by_cancelled`. A window whose first two dates
 * hold live classes and whose last two the teacher cancelled reports
 * `scheduled: 2` and `blockedByCancelled: 2` together. Naming only the taken
 * slots there would leave two permanently unfillable dates unexplained, which
 * is the silence #192 was filed about.
 *
 * The cancelled clause carries its own verb agreement rather than a shared
 * `classWord`. Both clauses put a verb after the count — the shape
 * `archiveMessage` warns about above — but only this one's verb *inflects for
 * number*: "holds/hold" changes, while the slot clause's "had" reads the same
 * for one date and four. That is the distinction that carries the guarantee,
 * and missing it is how this read "1 cancelled class still hold those dates"
 * until a singular case was pinned.
 */
export function resumeMessage(
  added: number,
  scheduled: number,
  blockedByCancelled: number,
  slotTaken: number,
): string {
  // Assembled before the `scheduled === 0` branch, deliberately. An earlier
  // version built the causes only on the non-empty branch, so a teacher whose
  // every candidate date was taken by another class — `slotTaken: 4`, measured
  // correctly and carried the whole way over the wire — was told "Nothing is
  // scheduled from this template." and nothing else. That is #192's silence
  // reproduced one reason over, inside the function written to end it. Both
  // causes apply to both heads.
  const causes: string[] = [];
  if (slotTaken > 0) {
    const dateWord = slotTaken === 1 ? 'date' : 'dates';
    causes.push(`${slotTaken} ${dateWord} already had a class.`);
  }
  if (blockedByCancelled > 0) {
    causes.push(
      blockedByCancelled === 1
        ? '1 cancelled class still holds that date.'
        : `${blockedByCancelled} cancelled classes still hold those dates.`,
    );
  }

  const head =
    scheduled === 0
      ? 'Nothing is scheduled from this template.'
      : `${scheduled} ${scheduled === 1 ? 'class' : 'classes'} on your schedule.`;

  if (causes.length > 0) return [head, ...causes].join(' ');
  return scheduled > 0 && added === 0 ? `${head} Nothing needed adding.` : head;
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
 * The `scheduled?: never; added?: never` phantom on the old collapsed `active`
 * arm did this job until the class family's resume gained counts of its own —
 * the case this file's own text predicted (below). No phantom can separate two
 * structurally identical arms, so `templateKind` is the discriminator instead:
 * it is a literal on the `active` arm of each family's type, checkable at
 * runtime (which the phantom was not), and both resolvers already distrust the
 * wire. A union is assignable only if every arm is, so one non-assignable arm
 * still protects the whole type in both directions — that is what the
 * "not interchangeable" test pins, and swapping a resolver for its sibling
 * fails on `templateKind`'s literal rather than compiling clean the way the
 * phantom let it (#119, #93).
 */
export type TemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | {
      action: 'active';
      templateKind: 'class';
      scheduled: number;
      added: number;
      blockedByCancelled: number;
      slotTaken: number;
    }
  | { action: 'unarchived' | 'unchanged' };

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
 * `scheduled`/`added`/`blockedByCancelled`/`slotTaken` are required, not
 * optional. The route sends all four on every `active` response; a type that
 * allowed their absence would be describing a payload the server cannot
 * produce. `templateKind: 'studio'` is the literal that keeps this type and
 * `TemplateToggleResponse` non-interchangeable — see that type's docblock.
 */
export type StudioTemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | {
      action: 'active';
      templateKind: 'studio';
      scheduled: number;
      added: number;
      blockedByCancelled: number;
      slotTaken: number;
    }
  | { action: 'unarchived' | 'unchanged' };

/**
 * Decides whether the button says anything, and what.
 *
 * `null` means "say nothing", which is the correct answer for two of the five
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
  if (data.action === 'active') {
    // Checked rather than trusted, for the reason `resolveStudioConfirmation`'s
    // own `active` case records below — the type constrains the server and
    // nothing constrains the wire, so a counts-less `{ action: 'active' }`
    // must be answered with silence, not a sentence about undefined.
    if (
      !Number.isInteger(data.added) ||
      !Number.isInteger(data.scheduled) ||
      !Number.isInteger(data.blockedByCancelled) ||
      !Number.isInteger(data.slotTaken)
    ) {
      return null;
    }
    return resumeMessage(data.added, data.scheduled, data.blockedByCancelled, data.slotTaken);
  }
  return null;
}

/**
 * The studio sibling of `resolveTemplateConfirmation`. A separate function
 * rather than a parameter: the two families differ in the archive wording, so
 * threading a message function through would put most of the English in the
 * caller — and they are kept parallel-but-separate throughout regardless.
 *
 * They no longer differ in whether resuming says anything. That was true from
 * #119 until #164/#192 gave the class family counts too, and both resume
 * sentences are now word for word identical — `resumeStudioMessage` delegates,
 * and a test pins that they agree.
 *
 * `null` is now the right answer for exactly one of the five actions, not the
 * class family's two: `active` speaks (#119) and so does `unarchived` (see
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
      if (
        !Number.isInteger(data.added) ||
        !Number.isInteger(data.scheduled) ||
        !Number.isInteger(data.blockedByCancelled) ||
        !Number.isInteger(data.slotTaken)
      ) {
        return null;
      }
      return resumeStudioMessage(
        data.added,
        data.scheduled,
        data.blockedByCancelled,
        data.slotTaken,
      );
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
