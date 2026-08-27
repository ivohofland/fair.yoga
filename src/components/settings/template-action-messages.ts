import { formatDayHeader } from '@/lib/format';
import type { LastScheduledClass } from '@/services/class-template-lifecycle';
// Type-only, but it would be safe as a value import too: `template-selection.ts`
// is import-free on purpose, so nothing server-only rides in with it. The rule
// itself is evaluated on the server and arrives here as a string on the wire —
// this file must never re-derive it from `isActive`/`isArchived`.
import type { TemplateGenerationState } from '@/lib/template-selection';
// Type-only, and safe as a value import too for the same reason as the line
// above: `generation.ts` is import-free on purpose. See its header docblock,
// which keeps a grep for exactly this question.
import type { SkipCounts } from '@/lib/generation';

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
 * deletes nothing, so this is only ever called on the archiving direction.
 *
 * That clause used to read "deletes nothing and needs no explanation". The
 * second half is false and this file now disproves it twice over —
 * `UNARCHIVE_STUDIO_MESSAGE` and, since #116, `UNARCHIVE_MESSAGE` exist
 * precisely because un-archiving forces `isActive: false` onto a template
 * whose future classes the archive already deleted, and saying nothing let a
 * teacher leave believing the class was restored. The conclusion survives on
 * the first half alone: this function reports DELETED COUNTS, and un-archiving
 * deletes nothing.
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
 * deletes nothing, so this is only ever called on the archiving direction —
 * mirroring `archiveMessage`, including why the "needs no explanation" half of
 * that clause had to go; see there.
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
  counts: SkipCounts,
): string {
  // Shares an implementation rather than duplicating one, and shares the WHOLE
  // of it: the two families' resume sentences are identical word for word.
  // A separate entry point anyway, so that a resolver's call site stays
  // family-specific and a future divergence has somewhere to land.
  //
  // #296 was that divergence for one release and #327 took it back. Its clause
  // named the OTHER family — "held by a studio class" — on a condition that was
  // then "the other family holds this exact minute". `CalendarEntry_teacher_
  // slot_excl` made the condition an OVERLAP of either family, so the sentence
  // was false for a teacher whose own one-off class merely ran into the
  // candidate. The clause is neutral now, and neutral is the same word on both
  // sides. What a teacher can act on is named at the route layer instead, by
  // the conflict probe (`lib/entry-conflict.ts`), which reads the actual
  // holder.
  return buildResumeSentence(added, scheduled, counts);
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
 * until a singular case was pinned. `alreadyThisWeek`'s clause is in the
 * inflecting family too, and doubly so — "is/are" AND "a class/classes" both
 * change with number.
 *
 * `alreadyThisWeek` (#194) is THIRD of the four causes — `blockedByOverlap`
 * (#296, neutral wording since #327) was appended after it — and the order is not
 * arbitrary: every sentence pinned before it keeps the prefix it already had,
 * so the existing tests stay meaningful rather than being rewritten around a
 * new clause. It is also the reason the count is carried at all. A teacher who
 * moves a template Tuesday→Thursday and resumes has four Tuesdays holding the
 * four candidate weeks; without this clause the sentence read "4 classes on
 * your schedule. Nothing needed adding." about four classes on the weekday
 * they had just abandoned — #194's own "8 classes" failure at half the number,
 * inside the branch that exists to end it.
 *
 * "your previous day" rather than a weekday name. The name is not on the wire:
 * the template row now holds only the NEW day, and the old one survives
 * nowhere but on the classes themselves. Naming it would mean either another
 * query or a guess, and this file's rule is that a clause says only what its
 * arguments measure.
 */
export function resumeMessage(added: number, scheduled: number, counts: SkipCounts): string {
  return buildResumeSentence(added, scheduled, counts);
}

/**
 * Everything the two families' resume sentences share, which is all of it.
 *
 * Private: the two exported entry points above are what callers use, so a
 * resolver's call site stays family-specific even though the copy is not.
 */
function buildResumeSentence(
  added: number,
  scheduled: number,
  counts: SkipCounts,
): string {
  const { blockedByCancelled, slotTaken, alreadyThisWeek, blockedByOverlap } = counts;
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
  if (alreadyThisWeek > 0) {
    causes.push(
      alreadyThisWeek === 1
        ? '1 date is still held by a class on your previous day.'
        : `${alreadyThisWeek} dates are still held by classes on your previous day.`,
    );
  }
  // Last, after the three that predate it (#296). The order is a copy decision
  // and is pinned by a test, not left to how the `if`s happen to be stacked.
  //
  // NAMES NO FAMILY, and that is the whole of what #327 changed here. The
  // reason this clause reports covers two conditions — an entry of the OTHER
  // family overlapping, and an entry of THIS one overlapping at a start time
  // that is not identical — and one sentence has to be true for both. "held by
  // a studio class" was true for the first and false for the second.
  // `SkipReason`'s docblock (`@/lib/generation`) owns that enumeration and the
  // case that looks like a third and is not.
  //
  // Number agreement follows `alreadyThisWeek`'s clause, the nearest
  // neighbour in shape: the subject, the agent and the verb all inflect.
  // Matching it rather than inventing a second convention is this file's rule.
  if (blockedByOverlap > 0) {
    causes.push(
      blockedByOverlap === 1
        ? '1 date overlaps another class on your schedule.'
        : `${blockedByOverlap} dates overlap other classes on your schedule.`,
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
 * The class family now has `UNARCHIVE_MESSAGE`; the two differ only in the
 * noun ("recurring class" vs "template"), matching each family's own copy.
 */
export const UNARCHIVE_STUDIO_MESSAGE =
  'Un-archived. This template is paused — resume it to put classes back on your schedule.';

/**
 * The class family's twin of `UNARCHIVE_STUDIO_MESSAGE`, and the same failure
 * one arm over: `archiveOrUnarchiveTemplate` forces `isActive: false` on both
 * directions — the shared body it calls, `archiveOrUnarchiveRule`
 * (`rule-lifecycle.ts`), says so in its docblock — and the archive has already
 * deleted the future classes. So a teacher who un-archives to get their weekly class
 * back lands on a paused template with an empty window, and until #116 the
 * only signal was that a differently-labelled button appeared.
 *
 * "recurring class" rather than the studio wording's "template": that is what
 * this family calls the thing throughout its own copy.
 */
export const UNARCHIVE_MESSAGE =
  'Un-archived. This recurring class is paused — resume it to put classes back on your schedule.';

/**
 * Shown after a template edit (#194). The edit changes nothing that already
 * exists, so this sentence carries the whole of what happened.
 *
 * `firstEffective` is the Monday of the first week the new schedule reaches —
 * computed by `updateClassTemplate`'s probe from the same `isWeekHeld` the
 * generator decides with, so the sentence cannot claim a week the sweep will
 * not fill. `null` when no free week is in the probe's horizon: the clause is
 * dropped rather than a date invented, matching this file's rule that saying
 * nothing beats saying something unfounded.
 *
 * A MONDAY, not the candidate class date, and the conversion deliberately
 * happens in the service rather than here — `mondayOf` lives in
 * `@/lib/timezone`, which imports pino, and `template-form.tsx` (`'use
 * client'`) value-imports this file. `formatDayHeader` is reused rather than a
 * bare day-and-month formatter being added, and the sentence says "week
 * *starting* Monday" so the weekday it renders reads as intentional rather
 * than as noise.
 *
 * The closing clause is deliberately conditional in tone ("if needed") rather
 * than a promise. `settingsLocked` refuses economic edits on a booked class,
 * so "change existing classes individually" is not universally available —
 * true before #194 too, since the deleted sync skipped those same instances,
 * but this sentence is new and must not over-promise. It is kept on all four
 * forms below, the archived one included: archiving withdraws only the
 * unbooked future window, so a booked class of a shelved template can still
 * be sitting on the schedule for a teacher to change.
 *
 * ## Why `generationState` is a second argument and not an inference
 *
 * `firstEffective` alone cannot carry this. `null` from a live template means
 * "no free week inside the probe's horizon" and drops the clause; `null` from
 * a paused or archived one means the sweep will not run at all. Rendering the
 * dated sentence for the second case is the failure this argument exists to
 * end — a confirmation naming a week that would never be filled, for 100% of
 * edits to a paused or archived recurring class.
 *
 * `paused` and `archived` get DIFFERENT sentences rather than one "not
 * currently generating" clause, because the remedies differ and the sentence
 * is only useful if it names the right one. Un-archiving does not resume:
 * `archiveOrUnarchiveTemplate` forces `isActive: false` on both directions,
 * which is the whole reason `UNARCHIVE_MESSAGE` above exists. A teacher told
 * "un-archive it" would do that, see nothing appear, and be exactly where
 * #119 found them.
 *
 * Register borrowed from `UNARCHIVE_MESSAGE` — state, em-dash, remedy — but
 * not its words: that constant describes what just happened to a template,
 * and these describe when a change will reach the schedule.
 */
export function templateUpdatedMessage(
  firstEffective: Date | null,
  generationState: TemplateGenerationState,
): string {
  const head = 'Template updated. It takes effect for newly generated classes';
  const tail = 'Change existing classes individually if needed.';
  switch (generationState) {
    case 'active':
      if (!firstEffective) return `${head}. ${tail}`;
      return `${head} — your first class on the new schedule is the week starting ${formatDayHeader(firstEffective)}. ${tail}`;
    case 'paused':
      return `${head} — this recurring class is paused, so nothing is generated until you resume it. ${tail}`;
    case 'archived':
      return `${head} — this recurring class is archived, so nothing is generated until you un-archive and resume it. ${tail}`;
    default: {
      // The `const unhandled: never` idiom this file already uses at both
      // resolvers. A fourth state on `TemplateGenerationState` would compile
      // clean here and silently take the `active` branch's shape if this were
      // an `if`/`else` chain, which is how the sentence and the service drift.
      const unhandled: never = generationState;
      throw new Error(`templateUpdatedMessage: unhandled generation state ${String(unhandled)}`);
    }
  }
}

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
      /**
       * One field rather than three re-listed `number`s, and the difference is
       * the same guarantee `class-template-lifecycle.ts` documents at its own
       * `counts`: a fourth `SkipCounts` member reaches this payload with no
       * edit here, at the route that builds it, or at the form that reads it.
       * `alreadyThisWeek` (#194) is the count that arrived after this arm was
       * first written, and it had to be threaded through by hand at every hop —
       * which is how it came to stop at the route for a while.
       */
      counts: SkipCounts;
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
 * `scheduled`, `added` and `counts` are required, not optional. The route
 * sends all three on every `active` response; a type that allowed their
 * absence would be describing a payload the server cannot produce. (It was
 * five fields until the counts became one — the count members themselves are
 * required by `SkipCounts`, unchanged.) `templateKind: 'studio'` is the literal that keeps this type
 * and `TemplateToggleResponse` non-interchangeable — see that type's docblock.
 */
export type StudioTemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | {
      action: 'active';
      templateKind: 'studio';
      scheduled: number;
      added: number;
      /**
       * `counts.alreadyThisWeek` is always 0 today, and that is not a bug.
       * `countSkipReasons` returns all four counts for both families, so the
       * value flows through the studio chain by the same route the other three
       * do — but nothing on the studio side PRODUCES `already_this_week` yet:
       * `generateStudioInstancesForTemplate` has no week key, which is #284.
       * Carried rather than hard-coded to 0 precisely so that when #284 lands,
       * the count arrives here with no wiring left to remember.
       *
       * Carrying the whole `SkipCounts` rather than its members one by one is
       * that same argument generalised: it is what makes the next count's
       * arrival free instead of merely cheap.
       */
      counts: SkipCounts;
    }
  | { action: 'unarchived' | 'unchanged' };

/**
 * The `SkipCounts` members, tethered so a new one cannot be forgotten here.
 *
 * `satisfies Record<keyof SkipCounts, true>` binds in both directions — the
 * same tether `ROOM_SEARCH_SELECT` (`api/rooms/route.ts`) uses, and for the
 * same reason. Add a member to `SkipCounts` and this object is missing a key;
 * remove one and the extra key is not in `keyof SkipCounts`. Either way the
 * build fails HERE rather than the guard below silently validating a subset.
 *
 * That is not hypothetical. This was a hand-written three-term `&&` chain, and
 * its docblock promised "that is also where a fourth `SkipCounts` member's
 * validation lands — one edit, not two". #296 added the fourth member and the
 * edit did not happen, leaving a type predicate that asserted
 * `counts is SkipCounts` while checking three quarters of it.
 */
const COUNT_KEYS = {
  blockedByCancelled: true,
  slotTaken: true,
  alreadyThisWeek: true,
  blockedByOverlap: true,
} satisfies Record<keyof SkipCounts, true>;

/**
 * True when `counts` is a `SkipCounts` whose every member is really an integer
 * — every member, enforced by `COUNT_KEYS` above rather than by a list kept in
 * step by hand.
 *
 * Both resolvers below reach their `active` arm through an unchecked `as` on
 * `res.json()`, so the type constrains the SERVER and nothing constrains the
 * WIRE: a tab holding this bundle against a rolled-back server receives
 * `{ action: 'active' }` with no counts, and a template literal then renders
 * "undefined classes on your schedule." Saying nothing is the honest fallback —
 * `resolveTemplateConfirmation`'s whole contract is that `null` means "say
 * nothing".
 *
 * Nesting the counts (#296) added a failure mode the three flat fields did not
 * have, and it is why this is a function rather than more `||` clauses: a
 * payload with no `counts` object at all makes every member read THROW a
 * TypeError, where a missing flat field merely read `undefined` and failed
 * `Number.isInteger`. The object check has to come first, and a type guard is
 * what lets it narrow for the call rather than being re-asserted with a cast.
 *
 * Members are checked even where the server cannot currently produce them —
 * `alreadyThisWeek` until #284 gives the studio generator a week key. The guard
 * is about what the WIRE carries, not about what the server counts today, and
 * an `active` payload missing a field is a bundle-vs-server mismatch either
 * way. One guard for both families.
 *
 * EXPORTED since PR #300's third review pass, and the reason is a measurement
 * rather than tidiness. It was module-private, so the CREATE path — which reads
 * the same untrusted `res.json()` from a different route — could not reach it
 * and validated nothing. Measured against the real `anyBlocked`:
 * `anyBlocked(JSON.parse('{}'))` returns `false`, so a payload whose `counts`
 * arrived without members made both create forms navigate away in silence: the
 * #296 failure this whole issue exists to fix, surviving at the one boundary
 * its type does not cover.
 *
 * That said "a truncated payload" until PR #300's fourth pass, contradicting
 * the rolled-back-server paragraph above. A body that will not parse reaches
 * this guard from nowhere: `res.json()` sits inside a `try` in all six
 * components that lead here — the two create forms, which call this directly,
 * and the four toggle/archive buttons, which reach it through the two
 * resolvers below — and every one of those six catches sets "Network error".
 * That mismatch is the whole of what this guard defends against.
 *
 * "Both callers" is what this paragraph said when it was first corrected, and
 * it was wrong in the same direction as the sentence it was fixing: this
 * function has FOUR direct call sites, not two. Counted, not assumed.
 *
 * Note the direction the two guards reduce in, because it is the difference
 * that matters. This one iterates `COUNT_KEYS` — the SCHEMA's members — so a
 * payload missing one fails. `anyBlocked` iterates the PAYLOAD's own values, so
 * `{}` reduces to `false` and an unknown extra member would count. Only the
 * first survives untrusted input, which is why the create path is gated on this
 * before `anyBlocked` is consulted at all.
 */
export function hasIntegerCounts(counts: unknown): counts is SkipCounts {
  if (typeof counts !== 'object' || counts === null) return false;
  const candidate = counts as Record<string, unknown>;
  return Object.keys(COUNT_KEYS).every((key) => Number.isInteger(candidate[key]));
}

/**
 * Decides whether the button says anything, and what.
 *
 * `null` means "say nothing", which is the correct answer for exactly one of
 * the five actions — `unchanged`. It is what a stale second tab and a
 * retry-after-lost-response reach, so showing a confirmation there would
 * describe something that did not happen.
 *
 * A `switch` with a `never` default rather than an if-chain, for the reason
 * `resolveStudioConfirmation` records: an if-chain ending in `return null` is
 * *accidentally* exhaustive, so a sixth arm on `TemplateToggleResponse` would
 * compile clean and fall through to silence.
 *
 * Pure, and separated from the components for that reason: this is the seam the
 * #93 wrong-shape bug lived in (`archiveStudioMessage` had the wrong signature
 * and the button silently discarded `remaining`), and it was caught by review
 * rather than by a test because nothing here was testable.
 */
export function resolveTemplateConfirmation(data: TemplateToggleResponse): string | null {
  switch (data.action) {
    case 'paused': {
      const last = data.lastScheduled;
      return pauseMessage(last ? { date: new Date(last.date), startTime: last.startTime } : null);
    }
    case 'archived':
      return archiveMessage(data.deleted, data.remaining);
    case 'active': {
      // Checked rather than trusted — see `hasIntegerCounts` above for why the
      // wire is distrusted here and what a counts-less payload would otherwise
      // render.
      if (
        !Number.isInteger(data.added) ||
        !Number.isInteger(data.scheduled) ||
        !hasIntegerCounts(data.counts)
      ) {
        return null;
      }
      return resumeMessage(data.added, data.scheduled, data.counts);
    }
    case 'unarchived':
      return UNARCHIVE_MESSAGE;
    case 'unchanged':
      return null;
    default: {
      const unhandled: never = data;
      void unhandled;
      return null;
    }
  }
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
 * This resolver is never called on **create** — create's POST response has no
 * `action` field for a `switch` to dispatch on, so the create forms
 * (`template-form.tsx`, `studio-template-form.tsx`) call `resumeMessage`/
 * `resumeStudioMessage` directly instead when the window came back short.
 * That is new: creating a weekly template used to say nothing at all —
 * "put this on my schedule weekly", four classes appearing, was taken as the
 * definition of the thing working, not a consequence needing disclosure, and
 * both families' create forms navigated straight to their own settings list
 * (see `docs/superpowers/specs/2026-07-23-template-generate-on-create-design.md`,
 * "Response shapes are unchanged … The front-end needs no changes"). #196
 * made that decision incomplete rather than wrong: `slotTaken` is now
 * reachable on create, and a live template with an empty window and a silent
 * redirect is not "the thing working". The happy path still navigates
 * straight through and says nothing, matching the design note above; only a
 * window that came back short now stays on the page and speaks — through the
 * same two functions this file already uses for the resume PATCH, not
 * through this resolver.
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
      // Checked rather than trusted, even though the type says `number` — see
      // `hasIntegerCounts` above, which both families share.
      if (
        !Number.isInteger(data.added) ||
        !Number.isInteger(data.scheduled) ||
        !hasIntegerCounts(data.counts)
      ) {
        return null;
      }
      return resumeStudioMessage(data.added, data.scheduled, data.counts);
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
