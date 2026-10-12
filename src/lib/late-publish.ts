import { isPastCancelDeadline } from '@/lib/cancel-deadline';

export type LatePublishState = 'none' | 'past_deadline' | 'past_check';

/**
 * What publishing a draft at `now` would do to its first bookers. `past_check`
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
