/**
 * The result shape both instance generators return.
 *
 * This module is import-free on purpose — it declares no dependency of its
 * own — but note what that claim rests on: it is not, at present, load-bearing
 * for any client bundle, unlike `src/lib/tiers.ts` and `src/lib/class-fields.ts`,
 * which each name real `'use client'` files that *value*-import them. Today's
 * importers are two server-side generators (`import type` only) and, since
 * `countSkipReasons` below, five more server-only services and routes that
 * *value*-import it: `api/class-templates/route.ts`,
 * `api/studio-class-templates/route.ts`, `class-template-lifecycle.ts`,
 * `studio-class-template-lifecycle.ts`, `template-sync.ts`. None of those is a
 * `'use client'` file, so the client-bundle conclusion still holds — but the
 * "only importers" half of this sentence should be re-checked before being
 * trusted, the same way this paragraph corrects it now.
 *
 * The import-free rule is kept anyway because these names are meant to reach
 * the copy layer — `template-action-messages.ts` takes the counts as bare
 * numbers now, and a later change that hands it a `SkipReason` should not have
 * to relocate this module first. Being import-free is what keeps that option
 * open; it is a precaution, not a fix for an existing bundle problem.
 */

/**
 * Why a candidate date produced no row. Five reasons, five distinct origins —
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
 * teacher — `blockedByCancelled`, `slotTaken`, and `alreadyThisWeek`. The
 * third is the newest (#194): counted from this file outward starting now,
 * but as of this writing no caller's copy layer reads it yet — that wiring
 * is separate work. `already_generated` and `raced` are both deliberately
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
}

/**
 * The one place `GenerationResult['skipped']` is reduced to the counts a
 * caller surfaces. Five call sites used to each filter three of five
 * `SkipReason` members by hand — `api/class-templates/route.ts`,
 * `api/studio-class-templates/route.ts`, `class-template-lifecycle.ts`,
 * `studio-class-template-lifecycle.ts`, `template-sync.ts` — so a sixth
 * `SkipReason` member would have compiled clean and vanished at every one of
 * them. The exhaustive `switch` below is what turns that into a single
 * compile error instead: this project already uses the `const unhandled:
 * never` idiom for exactly this shape (see the API routes' own `never`
 * exhaustiveness checks), and reducing once is what lets one instance of it
 * cover all five call sites rather than needing five.
 */
export function countSkipReasons(skipped: readonly SkippedSlot[]): SkipCounts {
  let blockedByCancelled = 0;
  let slotTaken = 0;
  let alreadyThisWeek = 0;
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
  return { blockedByCancelled, slotTaken, alreadyThisWeek };
}
