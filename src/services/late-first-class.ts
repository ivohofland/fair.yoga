import type { AutoCancelCheck, CancelDeadline } from '@/lib/prisma-client';
import { latePublishInstants, latePublishState, type LateFirstClass } from '@/lib/late-publish';
import { classStartInstant } from '@/lib/timezone';

/**
 * What the first class of a template faces if it becomes bookable at `at`:
 * `null` when its cancellation window has not opened or the class has started.
 */
export function lateFirstClass(args: {
  template: { cancelDeadline: CancelDeadline; autoCancelCheck: AutoCancelCheck; minStudents: number };
  entry: { date: Date; startTime: Date };
  timeZone: string;
  at: Date;
}): LateFirstClass | null {
  const { template, entry, timeZone, at } = args;
  const start = classStartInstant(entry, timeZone);
  const state = latePublishState({
    now: at,
    ...latePublishInstants({
      start,
      cancelDeadline: template.cancelDeadline,
      autoCancelCheck: template.autoCancelCheck,
    }),
  });
  if (state === 'none') return null;
  return { date: entry.date.toISOString().slice(0, 10), state, minStudents: template.minStudents };
}
