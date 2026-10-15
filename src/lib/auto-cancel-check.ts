import type { AutoCancelCheck } from '@/lib/prisma-client';
import { classStartInstant } from '@/lib/timezone';
import { cancelCheckFrom } from '@/lib/cancel-check';

/** The instant a class is judged for auto-cancel: its local start minus its check hours. */
export function cancelCheckInstant(
  entry: { date: Date; startTime: Date },
  autoCancelCheck: AutoCancelCheck,
  timezone: string,
): Date {
  return cancelCheckFrom(classStartInstant(entry, timezone), autoCancelCheck);
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
