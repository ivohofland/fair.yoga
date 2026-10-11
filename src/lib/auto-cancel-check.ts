import type { AutoCancelCheck } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';

/** Hours before the start at which each `autoCancelCheck` value judges a class. */
export const CANCEL_CHECK_HOURS = {
  HOURS_4: 4,
  HOURS_2: 2,
  HOURS_1: 1,
} as const satisfies Record<AutoCancelCheck, number>;

export const DEFAULT_CANCEL_CHECK_HOURS = CANCEL_CHECK_HOURS.HOURS_2;

export const MAX_CANCEL_CHECK_HOURS = Math.max(...Object.values(CANCEL_CHECK_HOURS));

const HOUR_MS = 60 * 60 * 1000;

/** The instant a class is judged for auto-cancel: its local start minus its check hours. */
export function cancelCheckInstant(
  entry: { date: Date; startTime: Date },
  autoCancelCheck: AutoCancelCheck,
  timezone: string,
): Date {
  const start = classStartInstant(entry, timezone);
  return new Date(start.getTime() - CANCEL_CHECK_HOURS[autoCancelCheck] * HOUR_MS);
}

/** Whether `at` has reached the class's check time. */
export function isPastCancelCheck(
  entry: { date: Date; startTime: Date },
  autoCancelCheck: AutoCancelCheck,
  timezone: string,
  at: Date,
): boolean {
  return at >= cancelCheckInstant(entry, autoCancelCheck, timezone);
}
