import type { AutoCancelCheck, CancelDeadline } from '@prisma/client';
import { cancelDeadlineFrom, isPastCancelDeadline } from '@/lib/cancel-deadline';
import { cancelCheckFrom } from '@/lib/cancel-check';

export type LatePublishState = 'none' | 'past_deadline' | 'past_check';

/**
 * What a class's first bookers face if it becomes bookable at `now` (a draft
 * published, or an open class moved). `past_check`
 * names both consequences; that the check always follows the deadline is
 * pinned in `late-publish.test.ts`. A start that has passed reads `none`.
 */
export function latePublishState(args: {
  now: Date;
  start: Date;
  deadline: Date;
  checkAt: Date;
}): LatePublishState {
  const { now, start, deadline, checkAt } = args;
  if (now > start) return 'none';
  if (now >= checkAt) return 'past_check';
  if (isPastCancelDeadline(deadline, now)) return 'past_deadline';
  return 'none';
}

/**
 * The instants at which `latePublishState` can change. An unreadable instant
 * is left out, so every result serialises.
 */
export function latePublishRefreshInstants(args: {
  start: Date;
  deadline: Date;
  checkAt: Date;
}): Date[] {
  return [args.deadline, args.checkAt, args.start].filter((d) => !Number.isNaN(d.getTime()));
}

/** The three instants `latePublishState` reads, for a class that starts at `start`. */
export function latePublishInstants(args: {
  start: Date;
  cancelDeadline: CancelDeadline;
  autoCancelCheck: AutoCancelCheck;
}): { start: Date; deadline: Date; checkAt: Date } {
  const { start, cancelDeadline, autoCancelCheck } = args;
  return {
    start,
    deadline: cancelDeadlineFrom(start, cancelDeadline),
    checkAt: cancelCheckFrom(start, autoCancelCheck),
  };
}
