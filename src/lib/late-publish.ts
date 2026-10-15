import type { AutoCancelCheck, CancelDeadline, ClassStatus } from '@/lib/prisma-client';
import { cancelDeadlineFrom, isPastCancelDeadline } from '@/lib/cancel-deadline';
import { cancelCheckFrom } from '@/lib/cancel-check';

export type LatePublishState = 'none' | 'past_deadline' | 'past_check';

/**
 * What a class's first bookers face if it becomes bookable at `now` (a draft
 * published, or an open class moved). `past_check` names both consequences;
 * that the check always follows the deadline is pinned in
 * `late-publish.test.ts`. A start that has passed reads `none`.
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

/** What the class edit form needs to tell a teacher that a move lands inside the class's cancellation window. */
export interface MoveWarning {
  timeZone: string;
  cancelDeadline: CancelDeadline;
  autoCancelCheck: AutoCancelCheck;
}

/**
 * The edit form's `moveWarning`: a value for an `open`, unlocked class — one
 * that is bookable now and can still move — and `null` for every other class.
 */
export function moveWarningFor(cls: {
  status: ClassStatus;
  settingsLocked: boolean;
  cancelDeadline: CancelDeadline;
  autoCancelCheck: AutoCancelCheck;
  timeZone: string;
}): MoveWarning | null {
  if (cls.status !== 'open' || cls.settingsLocked) return null;
  return {
    timeZone: cls.timeZone,
    cancelDeadline: cls.cancelDeadline,
    autoCancelCheck: cls.autoCancelCheck,
  };
}

/** What a template's first class faces when it starts inside the template's cancellation window. */
export type LateFirstClassState = Exclude<LatePublishState, 'none'>;

/**
 * The states `isLateFirstClass` accepts. `satisfies` makes a state added to or
 * dropped from `LateFirstClassState` a compile error here.
 */
const LATE_FIRST_CLASS_STATES = {
  past_deadline: true,
  past_check: true,
} satisfies Record<LateFirstClassState, true>;

export interface LateFirstClass {
  /** The class's calendar date, `YYYY-MM-DD`. */
  date: string;
  state: LateFirstClassState;
  minStudents: number;
}

export function isLateFirstClass(value: unknown): value is LateFirstClass {
  if (typeof value !== 'object' || value === null) return false;
  const { date, state, minStudents } = value as Record<string, unknown>;
  return (
    typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    typeof state === 'string' &&
    Object.hasOwn(LATE_FIRST_CLASS_STATES, state) &&
    typeof minStudents === 'number' &&
    Number.isInteger(minStudents) &&
    minStudents > 0
  );
}
