/**
 * The result shape both instance generators return.
 *
 * This module is import-free on purpose, and since #296 that is a REQUIREMENT
 * rather than the precaution it used to be. Two `'use client'` files now
 * VALUE-import it — `template-form.tsx` and `studio-template-form.tsx`, both
 * for `anyBlocked` — so this module is in the client bundle, and anything it
 * imported would ride along. `src/lib/tiers.ts`, `src/lib/class-fields.ts`,
 * `src/lib/client-errors.ts` and `src/lib/room-identity.ts` are in the same
 * position (`room-search.ts` says so about the last of those). Named as
 * EXAMPLES, not as a roster: an earlier version of this sentence said they
 * "were previously the only members of that category", which upgraded an
 * exemplar into an exhaustive list and was wrong within one commit — the exact
 * move the rest of this docblock exists to prevent. The membership is a check,
 * not a list: a module is in this category when a `'use client'` file
 * value-imports it and it VALUE-imports nothing itself.
 *
 * "Value-imports", not "imports", and the correction is itself worth a line.
 * The first version of this check said "imports nothing itself" and was
 * falsified by the first example under it — `tiers.ts:1` is
 * `import type { NoneOf } from '@/lib/type-pins'`. A type-only import is
 * erased at build, so the bundle conclusion held and only the predicate was
 * wrong. That is the third consecutive form this one sentence has failed in:
 * a roster, then a check too strict for its own examples.
 *
 * The census, re-derived rather than carried, with the check that produces it:
 *
 *   grep -rn "/generation'" src/ --include="*.ts" --include="*.tsx"
 *
 * NINE non-test importers outside this file, split three ways — plus
 * `generation.test.ts` by relative path, for ten in all. Stated as nine-plus-one
 * rather than ten, because the parenthetical counts below add to nine and a
 * reader doing the arithmetic the docblock invites should not land short.
 * The grep prints more lines than that, and neither excess is drift: two
 * importers take two lines each, a value import beside an `import type`, and
 * this docblock quotes the needle back at itself — the last paragraph here
 * says exactly where, and is the owner of that part.
 *
 *   VALUE, client (2)  `template-form.tsx`, `studio-template-form.tsx`
 *   VALUE, server (6)  `api/class-templates/route.ts`,
 *                      `api/studio-class-templates/route.ts`,
 *                      `class-template-lifecycle.ts`,
 *                      `studio-class-template-lifecycle.ts`,
 *                      `class-generator.ts`, `studio-class-generator.ts`
 *                      (the last two since #327 gave this module
 *                      `spansOverlap`; they were type-only before it)
 *   TYPE-ONLY (1)      `template-action-messages.ts` (erased at build, so it
 *                      adds nothing to any bundle)
 *
 * plus `generation.test.ts`, by relative path; a test is not a bundle. There
 * was an eleventh, `template-sync.ts`, until #194 deleted it.
 *
 * An earlier version of this paragraph concluded "None of those is a
 * `'use client'` file, so the client-bundle conclusion still holds" — the
 * sentence it also instructs the reader to re-check. #296 falsified it twice
 * over: first by adding two type-only client importers, then by turning both
 * into value importers when `anyBlocked` landed. The conclusion did not change
 * (this module still pulls in nothing), but the REASON did, from "no client
 * file imports it" to "client files import it and it imports nothing".
 *
 * The needle starts at the SLASH, and that is the whole of it. This line used
 * to prescribe `"lib/generation'"` and claim it was "wide enough to see the
 * relative-path importer" — it is not, and was not: `generation.test.ts`
 * imports `from './generation'`, which contains no `lib/` at all, so the
 * prescribed grep returned eight lines AT THAT TIME (it returns more now, and
 * the point survives) and silently omitted the one importer that does not go
 * through the `@/` alias. A docblock whose whole purpose is
 * "re-check this rather than trusting it" is worse than useless with a check
 * that cannot find what it is checking for.
 *
 * A leading `/` catches both spellings and still excludes `'class-generation'`
 * — `scheduler.ts`'s job name, which has no slash. Every hit outside this
 * docblock is an import; the hits inside it are this paragraph quoting the
 * grep and the two module specifiers back at itself, and are the only false
 * positives the check has.
 */

/**
 * Why a candidate date produced no row. Six reasons, six distinct origins —
 * they are not interchangeable and the copy layer treats them differently.
 */
export type SkipReason =
  /** This template's own non-cancelled instance is already on that date. Correct idempotency; never logged. Includes `completed`/`in_progress` rows, which the classification does not distinguish — only `cancelled` is split out, because only `cancelled` is what the copy needs to explain. */
  | 'already_generated'
  /** This template's own CANCELLED instance holds the date. `@@unique([scheduleRuleId, date])` on `CalendarEntry` is TOTAL rather than partial on liveness, which makes the date permanently unfillable (#192). */
  | 'blocked_by_cancelled'
  /** Another of this teacher's LIVE classes starts at that date + startTime (#196). */
  | 'slot_taken'
  /**
   * This template already has a class in the WEEK containing that date, on a
   * different date (#194). Distinct from `already_generated`, which is the
   * same template's class on the date ITSELF — and the distinction is the
   * whole diagnostic value: this reason can only arise when the template's
   * `dayOfWeek`/`startTime` moved and the previously generated classes still
   * hold those weeks.
   *
   * Counted with no liveness filter: a cancelled class holds its week. That is
   * deliberate and is the one place this codebase does NOT read cancelled as
   * free — see the spec's §3.2 for the flip-flop schedule the alternative
   * produces. Do not "fix" it for consistency with
   * `CalendarEntry_teacher_slot_excl`.
   */
  | 'already_this_week'
  /**
   * A LIVE entry of this teacher's OVERLAPS the candidate, and did not start
   * at the same minute (#296, widened and renamed by #327).
   *
   * With both families in one `CalendarEntry` table behind one RANGE
   * constraint, what a generator's pre-check can see is an overlap, and an
   * overlapping entry may be of either family. The copy still names the other
   * half of the teacher's schedule (`resumeMessage` and `resumeStudioMessage`,
   * `components/settings/template-action-messages.ts`), which is right for
   * the common case and wrong for a same-family class that merely runs into
   * the candidate — the conflation #288 is open about.
   *
   * Distinct from `slot_taken`, which means one of this teacher's own
   * SAME-family classes starts at exactly that minute. Kept separate because
   * the remedy differs: `slot_taken` is answered inside this family.
   */
  | 'blocked_by_overlap'
  /** The pre-check said free and `ON CONFLICT DO NOTHING` skipped it anyway — a concurrent insert landed in between (#164). */
  | 'raced';

export interface SkippedSlot {
  date: Date;
  reason: SkipReason;
}

/** `created + skipped.length` always equals the number of candidate dates. */
export interface GenerationResult {
  created: number;
  skipped: SkippedSlot[];
}

/**
 * The `SkipReason` counts `SkipCounts` carries for a caller to surface to a
 * teacher — `blockedByCancelled`, `slotTaken`, `alreadyThisWeek` and
 * `blockedByOverlap`. The fourth is the newest (#296) and is the only one
 * whose sentence differs between the two families, because each names the
 * opposite half of the teacher's schedule. The third (#194) is read the whole
 * way through:
 * `resumeMessage` names it as "N dates are still held by classes on your
 * previous day", which is what stops a resume after a day edit reporting
 * "4 classes on your schedule. Nothing needed adding." about four classes on
 * the weekday the teacher just abandoned. It is 0 on the studio side until
 * #284 gives that generator a week key — carried, not special-cased.
 * `already_generated` and `raced` are both deliberately
 * excluded, for different reasons: `already_generated` is the expected,
 * steady-state outcome of an idempotent re-run and saying so would be noise
 * (`logSkippedSlots` in `class-generator.ts` already treats it the same
 * way); `raced` is "a free date that did not come back" — a lost contention
 * race whose date will simply be picked up on the next run, and today
 * reaches no user anywhere.
 */
/**
 * A `type` rather than an `interface`, and the one word is load-bearing.
 *
 * An interface has no implicit index signature, so `Object.values(counts)` does
 * not match `values<T>(o: { [s: string]: T }): T[]` and falls through to the
 * `values(o: {}): any[]` overload — which made `anyBlocked` below reduce over
 * `any`, against CLAUDE.md's "no `any`, non-negotiable", and silently compare a
 * hypothetical non-numeric member against `0`. Measured: adding a `string`
 * member to this shape failed the build at `COUNT_KEYS`
 * (`template-action-messages.ts`) and at `countSkipReasons` below, and NOT at
 * `anyBlocked`, whose docblock claims to cover every count there will ever be.
 *
 * As a `type` alias the object literal type does get the index signature, the
 * overload matches, and the same mutation now fails at `anyBlocked` itself with
 * `TS2365: Operator '>' cannot be applied to types 'string | number' and
 * 'number'`. Nothing else in the tree changed.
 */
export type SkipCounts = {
  /** Candidate dates a cancelled instance of this template holds (#192). */
  blockedByCancelled: number;
  /** Candidate dates another of this teacher's classes holds (#196). */
  slotTaken: number;
  /** Candidate dates whose week this template already occupies (#194). */
  alreadyThisWeek: number;
  /** Candidate dates a live entry of this teacher's overlaps (#296, widened by #327). */
  blockedByOverlap: number;
};

/**
 * True when any count in the window is a date the teacher should be told about.
 *
 * Exists because the create gates in `template-form.tsx` and
 * `studio-template-form.tsx` were the one hop #296's nesting refactor did not
 * reach, and the reason is worth keeping: nesting protects a count that is
 * PASSED, and those two sites INSPECT. They hand-listed
 * `blockedByCancelled > 0 || slotTaken > 0`, and when
 * `blockedByOverlap` arrived — the first such reason THE GATE DID NOT
 * ALREADY LIST — both gates silently kept navigating away from a short window.
 * Not the first REACHABLE one: `slotTaken` has been reachable on create since
 * #196 and the gate listed it; `blockedByCancelled` and `alreadyThisWeek` are
 * the structurally-zero pair. That is #196's own silence, reproduced one reason later inside
 * the branch written to end it, and `template-form.tsx`'s comment had stated
 * the rule it broke: "If create ever CAN produce the reason, this gate must
 * gain the term in the same change."
 *
 * A fourth `||` would have closed that and reopened it at the fifth count.
 * Reducing over the object closes it for every count there will ever be.
 *
 * `alreadyThisWeek` is included and is provably 0 on create — a brand-new
 * template holds no week of its own. That costs nothing: a term that is
 * provably zero is free, where a term that is provably MISSING is this bug.
 */
export function anyBlocked(counts: SkipCounts): boolean {
  // `Object.values<number>`, with the type argument spelled out, and it is not
  // decoration. Without it the call resolves by overload: a `type` alias gets an
  // implicit index signature and matches `values<T>(o: { [s: string]: T }): T[]`,
  // an `interface` does not and falls through to `values(o: {}): any[]` — so
  // `count` silently becomes `any` and the comparison below stops meaning
  // anything. That made the fix for it a single KEYWORD on the declaration
  // above, which any tidy-the-conventions pass reverts without failing a thing
  // (`SkippedSlot` and `GenerationResult` twenty lines up are both still
  // `interface`). The explicit argument removes the `any[]` overload from
  // consideration, so the same revert now fails HERE, loudly: `TS2345 …
  // Index signature for type 'string' is missing in type 'SkipCounts'` — an
  // error that names the mechanism rather than hiding it.
  return Object.values<number>(counts).some((count) => count > 0);
}

/**
 * The one place `GenerationResult['skipped']` is reduced to the counts a
 * caller surfaces. Five call sites used to each filter two of four
 * `SkipReason` members by hand — `api/class-templates/route.ts`,
 * `api/studio-class-templates/route.ts`, `class-template-lifecycle.ts`,
 * `studio-class-template-lifecycle.ts` and `template-sync.ts` — so a fifth
 * `SkipReason` member would have compiled clean and vanished at every one of
 * them. The exhaustive `switch` below is what turns that into a single compile
 * error instead: this project already uses the `const unhandled: never` idiom
 * for exactly this shape (see the API routes' own `never` exhaustiveness
 * checks), and reducing once is what lets one instance of it cover every call
 * site rather than needing one each.
 *
 * EVERY NUMBER IN THE PARAGRAPH ABOVE IS THE PRE-#194 STATE, deliberately, and
 * must not be refreshed to today's. It is the roster the measurement was taken
 * against: five sites, because `template-sync.ts` still existed; four members
 * and two `SkipCounts` fields, because `already_this_week`/`alreadyThisWeek`
 * did not. A pass over this branch rewrote the member counts to today's and
 * left the call-site roster at yesterday's, and the result described a state
 * this repo was never in at any point.
 *
 * Today, for the avoidance of exactly that: FOUR value-importing call sites
 * (#194 deleted `template-sync.ts` — check with the grep in this file's header
 * docblock, which is also where its hits are split into value-imports,
 * type-only imports and the one test — note that is FOUR CALL SITES OF THIS
 * FUNCTION, not the eight value importers the header now counts: the two forms
 * value-import `anyBlocked` and the two generators value-import
 * `spansOverlap`, and none of the four calls this), SIX `SkipReason`
 * members and FOUR
 * `SkipCounts` fields. So the member that would vanish without the `switch`
 * below is now the SEVENTH, and
 * `class-template-lifecycle.ts`'s `PauseTemplateResult` cites this docblock
 * for that number.
 *
 * #296 added the sixth member — `blocked_by_overlap`, named
 * `blocked_by_other_family` until #327's rename — and the fourth count, and
 * both halves of this paragraph's warning played out as written. The
 * `switch` below failed the build at its `never` arm — measured by mutation
 * at #296, `Type '"blocked_by_other_family"' is not assignable to type
 * 'never'` — which is the half that works. The COUNT reached the wire, both
 * routes, both forms and the copy layer without a single one of them failing,
 * and that is NOT this guard working: it is #296's task 4a, which had already
 * made every one of those hops carry `SkipCounts` whole rather than its
 * members by name. Before that task the new count would have vanished at all
 * four, exactly as this paragraph predicts.
 */
export function countSkipReasons(skipped: readonly SkippedSlot[]): SkipCounts {
  let blockedByCancelled = 0;
  let slotTaken = 0;
  let alreadyThisWeek = 0;
  let blockedByOverlap = 0;
  for (const { reason } of skipped) {
    switch (reason) {
      case 'blocked_by_cancelled':
        blockedByCancelled += 1;
        break;
      case 'slot_taken':
        slotTaken += 1;
        break;
      case 'already_this_week':
        alreadyThisWeek += 1;
        break;
      case 'blocked_by_overlap':
        blockedByOverlap += 1;
        break;
      case 'already_generated':
      case 'raced':
        // Deliberately excluded — see `SkipCounts`'s own docblock.
        break;
      default: {
        const unhandled: never = reason;
        throw new Error(`countSkipReasons: unhandled SkipReason ${String(unhandled)}`);
      }
    }
  }
  return { blockedByCancelled, slotTaken, alreadyThisWeek, blockedByOverlap };
}

/**
 * Whether two same-date entries occupy overlapping minutes of the day.
 *
 * The shape `CalendarEntry_teacher_slot_excl` refuses, expressed in
 * TypeScript so the two generators can NAME a blocked date rather than
 * discovering it as a `23P01`. The constraint is the enforcement; this is the
 * pre-check that produces a `SkipReason`.
 *
 * Minutes since midnight on both sides, because `startTime` is a `@db.Time`
 * column and arrives as a `Date` pinned to 1970-01-01 UTC — the same
 * conversion `minutesSinceMidnight` (`lib/rule-slot-holder.ts`) makes for the
 * rule layer's `int4range`, one layer down.
 *
 * SAME-DATE ONLY, and the caller is what supplies that: both generators filter
 * their occupancy read to the candidate date before calling this. An entry
 * whose duration carries it past midnight overlaps a candidate on the NEXT
 * calendar date, and neither the caller's filter nor this function sees that —
 * the constraint still does, so such a candidate is refused at insert rather
 * than named here.
 */
export function spansOverlap(
  a: { startTime: Date; durationMinutes: number },
  b: { startTime: Date; durationMinutes: number },
): boolean {
  const aStart = a.startTime.getUTCHours() * 60 + a.startTime.getUTCMinutes();
  const bStart = b.startTime.getUTCHours() * 60 + b.startTime.getUTCMinutes();
  return aStart < bStart + b.durationMinutes && bStart < aStart + a.durationMinutes;
}
