/**
 * Pure and free of runtime imports, so a client component can import it
 * directly.
 */
import type { AutoCancelCheck } from '@/lib/prisma-client';

/** Hours before the start at which each `autoCancelCheck` value judges a class. */
export const CANCEL_CHECK_HOURS = {
  HOURS_4: 4,
  HOURS_2: 2,
  HOURS_1: 1,
} as const satisfies Record<AutoCancelCheck, number>;

export const DEFAULT_CANCEL_CHECK_HOURS = CANCEL_CHECK_HOURS.HOURS_2;

export const MAX_CANCEL_CHECK_HOURS = Math.max(...Object.values(CANCEL_CHECK_HOURS));

const HOUR_MS = 60 * 60 * 1000;

/** The instant a class starting at `start` is judged for auto-cancel: the start minus its check hours. */
export function cancelCheckFrom(start: Date, autoCancelCheck: AutoCancelCheck): Date {
  return new Date(start.getTime() - CANCEL_CHECK_HOURS[autoCancelCheck] * HOUR_MS);
}
