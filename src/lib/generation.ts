/**
 * The result shape both instance generators return.
 *
 * This module is import-free on purpose — it declares no dependency of its
 * own — but note what that claim rests on: it is not, at present, load-bearing
 * for any client bundle, unlike `src/lib/tiers.ts` and `src/lib/class-fields.ts`,
 * which each name real `'use client'` files that *value*-import them. Today's
 * importers are two server-side generators (`import type` only —
 * `class-generator.ts`, `studio-class-generator.ts`) and, since
 * `countSkipReasons` below, four more server-only services and routes that
 * *value*-import it: `api/class-templates/route.ts`,
 * `api/studio-class-templates/route.ts`, `class-template-lifecycle.ts`,
 * `studio-class-template-lifecycle.ts`. (`generation.test.ts` value-imports it
 * too, by relative path; a test is not a bundle.) There was a fifth,
 * `template-sync.ts`, until #194 deleted it. None of those is a `'use client'`
 * file, so the client-bundle conclusion still holds — but the "only importers"
 * half of this sentence should be re-checked before being trusted, the same
 * way this paragraph corrects it now. The check is
 * `grep -rn "/generation'" src/ --include="*.ts" --include="*.tsx"`.
 *
 * The needle starts at the SLASH, and that is the whole of it. This line used
 * to prescribe `"lib/generation'"` and claim it was "wide enough to see the
 * relative-path importer" — it is not, and was not: `generation.test.ts`
 * imports `from './generation'`, which contains no `lib/` at all, so the
 * prescribed grep returned eight lines and silently omitted the one importer
 * that does not go through the `@/` alias. A docblock whose whole purpose is
 * "re-check this rather than trusting it" is worse than useless with a check
 * that cannot find what it is checking for.
 *
 * A leading `/` catches both spellings and still excludes `'class-generation'`
 * — `scheduler.ts`'s job name, which has no slash. Every hit outside this
 * docblock is an import; the hits inside it are this paragraph quoting both
 * the grep and the two module specifiers back at itself, and are the only
 * false positives the check has.
 *
 * The import-free rule is kept anyway because these names are meant to reach
 * the copy layer, and since #296 they DO: `template-action-messages.ts` now
 * type-imports `SkipCounts` from here, so this module is reached from a file
 * the client bundle includes. Type-only, so nothing rides in at runtime — but
 * that is now a property of the import KIND rather than of the import graph,
 * and a later change that hands the copy layer a `SkipReason` as a value would
 * make it load-bearing for real. Being import-free is what keeps that option
 * open; it is a precaution, not a fix for an existing bundle problem.
 */

/**
 * Why a candidate date produced no row. Six reasons, six distinct origins —
 * they are not interchangeable and the copy layer treats them differently.
 */
export type SkipReason =
  /** This template's own non-cancelled instance is already on that date. Correct idempotency; never logged. Includes `completed`/`in_progress` rows, which the classification does not distinguish — only `cancelled` is split out, because only `cancelled` is what the copy needs to explain. */
  | 'already_generated'
  /** This template's own CANCELLED instance holds the date. `@@unique([templateId, date])` makes it permanently unfillable (#192). */
  | 'blocked_by_cancelled'
  /** Another of this teacher's classes holds that date + startTime (#196). */
  | 'slot_taken'
  /**
   * This template already has a class in the WEEK containing that date, on a
   * different date (#194). Distinct from `already_generated`, which is the
   * same template's class on the date ITSELF — and the distinction is the
   * whole diagnostic value: this reason can only arise when the template's
   * `dayOfWeek`/`startTime` moved and the previously generated classes still
   * hold those weeks.
   *
   * Counted with no status filter: a cancelled class holds its week. That is
   * deliberate and is the one place this codebase does NOT read cancelled as
   * free — see the spec's §3.2 for the flip-flop schedule the alternative
   * produces. Do not "fix" it for consistency with `Class_teacher_slot_unique`.
   */
  | 'already_this_week'
  /**
   * A LIVE class from the OTHER family holds this teacher's slot (#296).
   *
   * Distinct from `slot_taken`, which means one of this teacher's own
   * SAME-family classes holds it. Kept separate because the remedy differs:
   * `slot_taken` is answered inside this family, and this one sends the
   * teacher to the other half of their schedule. Folding the two would make
   * one member carry two situations with two remedies — the conflation #288
   * is open about.
   *
   * It is the one member whose copy is not shared between the families, since
   * each has to name the opposite half: see `resumeMessage` and
   * `resumeStudioMessage` (`components/settings/template-action-messages.ts`),
   * which delegated wholesale until this member existed.
   */
  | 'blocked_by_other_family'
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
 * `blockedByOtherFamily`. The fourth is the newest (#296) and is the only one
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
export interface SkipCounts {
  /** Candidate dates a cancelled instance of this template holds (#192). */
  blockedByCancelled: number;
  /** Candidate dates another of this teacher's classes holds (#196). */
  slotTaken: number;
  /** Candidate dates whose week this template already occupies (#194). */
  alreadyThisWeek: number;
  /** Candidate dates a live class from the OTHER family holds (#296). */
  blockedByOtherFamily: number;
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
 * type-only imports and the one test), SIX `SkipReason` members and FOUR
 * `SkipCounts` fields. So the member that would vanish without the `switch`
 * below is now the SEVENTH, and
 * `class-template-lifecycle.ts`'s `PauseTemplateResult` cites this docblock
 * for that number.
 *
 * #296 added the sixth member (`blocked_by_other_family`) and the fourth
 * count, and both halves of this paragraph's warning played out as written.
 * The `switch` below failed the build at its `never` arm — measured by
 * mutation, `Type '"blocked_by_other_family"' is not assignable to type
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
  let blockedByOtherFamily = 0;
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
      case 'blocked_by_other_family':
        blockedByOtherFamily += 1;
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
  return { blockedByCancelled, slotTaken, alreadyThisWeek, blockedByOtherFamily };
}
