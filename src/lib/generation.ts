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
 * falsified by the first example under it — `tiers.ts` imports
 * `import type { NoneOf } from '@/lib/type-pins'`. A type-only import is
 * erased at build, so the bundle conclusion held and only the predicate was
 * wrong. That is the third consecutive form this one sentence has failed in:
 * a roster, then a check too strict for its own examples.
 *
 * The importer LIST is not kept here, and its absence is the point. What this
 * module has to hold is a one-way invariant — it imports nothing — and that is
 * a fact about this file, visible immediately below this docblock. A roster of
 * importers is a fact about a dozen other files, and the person who
 * invalidates it is editing one of those.
 *
 * When you do need to know who imports it — to judge a bundle question, or
 * before changing an exported shape — derive it rather than read it:
 *
 *   grep -rl "/generation'" src/ tests/ --include="*.ts" --include="*.tsx" \
 *     | grep -vE '/generation(\.test)?\.ts$'
 *
 * `src/ tests/`, not `src/` alone: scoped to both trees so an importer that
 * lives only under `tests/` cannot hide from the check. `-l`, not `-n`: one
 * line per importer, where `-n` runs ahead of it because an importer may split
 * a value and a type across two lines and because this docblock quotes the
 * needle back at itself.
 * The filter drops this file and its own test; every line left is a real
 * importer, tests included, and a test is not a bundle.
 *
 * The needle starts at the SLASH, and that is the whole of it. `lib/generation'`
 * misses `generation.test.ts`, whose specifier is `'./generation'` and carries
 * no `lib/` at all. A bare `generation'` overshoots the other way, onto
 * `'class-generation'` (`scheduler.ts`'s job name) and `'./entry-generation'`
 * (a different module). The leading `/` catches both real spellings and
 * neither of those.
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
   * A LIVE entry of this teacher's OVERLAPS the candidate (#296, widened and
   * renamed by #327). From the PRE-CHECK, also not at the same minute — that
   * qualifier belongs to the two conditions below rather than to the member,
   * because the post-insert probe further down reaches it without asking.
   *
   * With both families in one `CalendarEntry` table behind one RANGE
   * constraint, what a generator's pre-check can see is an overlap, and an
   * overlapping entry may be of EITHER family. TWO CONDITIONS reach this
   * member: an OTHER-family entry overlapping, at an identical start or not,
   * and a SAME-family one overlapping at a start that is not identical (an
   * identical one is `slot_taken`). Whether the holder was generated or logged
   * by hand makes no difference to either — a manual row is an entry like any
   * other. So the copy names no family (`resumeMessage`/`resumeStudioMessage`,
   * `components/settings/template-action-messages.ts`, whose clause reads "N
   * dates overlap other classes on your schedule"), because one sentence has
   * to be true for both. Under #296's exact-start cross-family key only the
   * first condition was reachable and only at an identical start, and the copy
   * named the other family; #327 made the rest reachable and the sentence
   * false. Naming a specific holder happens at the ROUTE layer instead, where
   * a teacher can act on it — `lib/entry-conflict.ts` probes for the actual
   * row.
   *
   * A THIRD CONDITION REACHES IT, AND NOT FROM THE PRE-CHECK. A neighbour
   * spilling past midnight is invisible to the generator's occupancy read —
   * that read is `date: { in: dates }` and compares with `spansOverlap` below,
   * which is minutes-since-midnight on ONE date, so a neighbour carried into a
   * candidate from the PREVIOUS calendar date cannot be seen there
   * (`spansOverlap`'s own docblock says so). The constraint catches it at
   * insert and `ON CONFLICT DO NOTHING` absorbs it, so the date comes back
   * short; `probeOverlappingCandidates` (`@/lib/entry-conflict`) then re-asks
   * the constraint's own question about it and the date reaches the teacher
   * here rather than as `raced`. It used to reach them as `raced`, which
   * `countSkipReasons` drops — silently discarding a window that generated
   * nothing, forever, since a midnight spill is not the transient thing that
   * exclusion assumes.
   *
   * That post-insert probe answers only "does a live entry still overlap", so
   * it does NOT tell an own row or an exact-start same-family neighbour apart
   * from any other holder. Both of those are visible to the pre-check unless
   * they committed mid-generation, so the coarseness is bounded to genuine
   * races — see the generators' own note above their `landed` set.
   *
   * Distinct from `slot_taken`, which means one of this teacher's own
   * SAME-family classes starts at exactly that minute. Kept separate because
   * the remedy differs: `slot_taken` is answered inside this family.
   */
  | 'blocked_by_overlap'
  /** The pre-check said free, `ON CONFLICT DO NOTHING` skipped it anyway, AND the post-insert probe found nothing live overlapping it — a concurrent insert landed in between and left no standing holder (#164). Both conjuncts, since #327: without the second this member also absorbed the permanent midnight-spill case, and `countSkipReasons` drops it. */
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
 * `blockedByOverlap`. The fourth is the newest (#296); its sentence differed
 * between the two families for one release and no longer does, because #327
 * made its condition one no family owns — see the member's own docblock above.
 * The third (#194) is read the whole
 * way through:
 * `resumeMessage` names it as "N dates are still held by classes on your
 * previous day", which is what stops a resume after a day edit reporting
 * "4 classes on your schedule. Nothing needed adding." about four classes on
 * the weekday the teacher just abandoned. Both families produce it: one
 * generator keys both on the week (#194, #284), so this count is a real
 * measurement on either side rather than a field one of them always leaves at
 * 0. `already_generated` and `raced` are both deliberately
 * excluded, for different reasons: `already_generated` is the expected,
 * steady-state outcome of an idempotent re-run and saying so would be noise
 * (`logSkippedEntries` in `entry-generation.ts` already treats it the same
 * way); `raced` is "a free date that did not come back AND that nothing live
 * overlaps any more" — a lost contention race whose date will simply be picked
 * up on the next run.
 *
 * THE SECOND HALF OF THAT SENTENCE IS LOAD-BEARING, and #327 is why it is
 * spelled out. The exclusion of `raced` rests entirely on a race being
 * TRANSIENT. A neighbour spilling past midnight is not: the pre-check cannot
 * see it and the constraint refuses it every hour, forever. While `raced` meant
 * only "did not come back", that permanent case landed in the one reason
 * nothing surfaces, and `template-form.tsx` navigated a teacher away from a
 * window that generated nothing without a word. The generator re-asks the
 * database about a short date (`probeOverlappingCandidates`,
 * `@/lib/entry-conflict`) and reports a still-held one as `blocked_by_overlap`,
 * so what is left under `raced` is transient by construction rather than by
 * assumption. Do not widen it back.
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
 * Today, for the avoidance of exactly that: SIX `SkipReason` members and FOUR
 * `SkipCounts` fields. Both are tethered rather than asserted — the members by
 * the exhaustive `switch` below, the fields by `SkipCounts` itself — so
 * neither can go the way the roster above did. The CALL SITES are not counted
 * here at all, because nothing tethers a count of them; derive them:
 *
 *   grep -rn "import .*countSkipReasons.*'@/lib/generation'" src/ \
 *     --include='*.ts' --include='*.tsx' \
 *     | grep -vE '\.test\.ts:|^src/lib/generation\.ts:'
 *
 * The second filter drops this docblock, which quotes its own needle back at
 * itself. What is left is callers of THIS FUNCTION, which is narrower than
 * importers of this module: `anyBlocked` and `spansOverlap` are exported from
 * here too, and importing either is not calling this.
 *
 * So the member that would vanish without the `switch` below is now the
 * SEVENTH, and `api/class-templates/route.ts` cites this docblock for that
 * number rather than recounting it — the one site that spells the ordinal
 * out.
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
 * TypeScript so the generator can NAME a blocked date rather than
 * discovering it as a `23P01`. The constraint is the enforcement; this is the
 * pre-check that produces a `SkipReason`.
 *
 * Minutes since midnight on both sides, because `startTime` is a `@db.Time`
 * column and arrives as a `Date` pinned to 1970-01-01 UTC — the same
 * conversion `minutesSinceMidnight` (`lib/rule-slot-holder.ts`) makes for the
 * rule layer's `int4range`, one layer down.
 *
 * SAME-DATE ONLY, and the caller is what supplies that: the generator filters
 * its occupancy read to the candidate date before calling this. An entry
 * whose duration carries it past midnight overlaps a candidate on the NEXT
 * calendar date, and neither the caller's filter nor this function sees that —
 * the constraint still does, so such a candidate is refused at insert rather
 * than named here. What names it is the second look the generator takes
 * afterwards (`probeOverlappingCandidates`, `@/lib/entry-conflict`), which asks
 * the database with the constraint's own range instead of re-deriving one here.
 * Widening this function to reach across midnight is NOT the fix: it would need
 * the previous date's occupancy, which the caller's single read does not
 * fetch, and it would still be a second spelling of the constraint.
 */
export function spansOverlap(
  a: { startTime: Date; durationMinutes: number },
  b: { startTime: Date; durationMinutes: number },
): boolean {
  const aStart = a.startTime.getUTCHours() * 60 + a.startTime.getUTCMinutes();
  const bStart = b.startTime.getUTCHours() * 60 + b.startTime.getUTCMinutes();
  return aStart < bStart + b.durationMinutes && bStart < aStart + a.durationMinutes;
}
