import { isPastCancelDeadline } from '@/lib/cancel-deadline';

export type LatePublishState = 'none' | 'past_deadline' | 'past_check';

/**
 * What publishing a draft at `now` would do to its first bookers. `past_check`
 * implies `past_deadline`: the check runs after the deadline. The start
 * instant itself still publishes; only strictly after it is `none`.
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

/** The instants at which `latePublishState` can change: deadline, checkAt, start. */
export function latePublishRefreshInstants(args: {
  start: Date;
  deadline: Date;
  checkAt: Date;
}): Date[] {
  return [args.deadline, args.checkAt, args.start];
}
