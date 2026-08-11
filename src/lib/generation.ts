/**
 * The result shape both instance generators return.
 *
 * Import-free on purpose, but note what that claim rests on: today the only
 * importers are the two server-side generators, both via `import type`. It is
 * not, at present, load-bearing for any client bundle — unlike `src/lib/tiers.ts`
 * and `src/lib/class-fields.ts`, which each name real `'use client'` files that
 * *value*-import them.
 *
 * The rule is kept anyway because these names are meant to reach the copy layer
 * — `template-action-messages.ts` takes the counts as bare numbers now, and a
 * later change that hands it a `SkipReason` should not have to relocate this
 * module first. Being import-free is what keeps that option open; it is a
 * precaution, not a fix for an existing bundle problem.
 */

/**
 * Why a candidate date produced no row. Four reasons, four distinct origins —
 * they are not interchangeable and the copy layer treats them differently.
 */
export type SkipReason =
  /** This template's own non-cancelled instance is already on that date. Correct idempotency; never logged. Includes `completed`/`in_progress` rows, which the classification does not distinguish — only `cancelled` is split out, because only `cancelled` is what the copy needs to explain. */
  | 'already_generated'
  /** This template's own CANCELLED instance holds the date. `@@unique([templateId, date])` makes it permanently unfillable (#192). */
  | 'blocked_by_cancelled'
  /** Another of this teacher's classes holds that date + startTime (#196). */
  | 'slot_taken'
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
