/**
 * The result shape both instance generators return.
 *
 * Import-free on purpose. `template-action-messages.ts` is reached from
 * `'use client'` components, and this module's names travel that far; keeping it
 * free of imports means no future edit here can drag `@/lib/log` (pino,
 * server-only) into a client bundle. `src/lib/tiers.ts` and
 * `src/lib/class-fields.ts` exist for the same reason.
 */

/**
 * Why a candidate date produced no row. Four reasons, four distinct origins —
 * they are not interchangeable and the copy layer treats them differently.
 */
export type SkipReason =
  /** This template's own live instance is already on that date. Correct idempotency; never logged. */
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
