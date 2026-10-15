import type { Prisma } from '@/lib/prisma-client';
import { isPastCancelCheck } from '@/lib/auto-cancel-check';

const DECISION_SELECT = {
  status: true,
  settingsLocked: true,
  autoCancelCheck: true,
  autoCancelDecidedAt: true,
  calendarEntry: {
    select: { date: true, startTime: true, cancelledAt: true, teacher: { select: { defaultTimezone: true } } },
  },
} as const satisfies Prisma.ClassSelect;

/**
 * Marks the auto-cancel decision as made for an open, live, undecided class
 * whose check time has already been reached: a teacher who publishes a class
 * inside its own check window has chosen to run it, so the sweep must not
 * judge it. Resolves to `true` when it stamped the class and `false` when it
 * left the class alone. Precondition: the caller holds `classId`'s row lock.
 */
export async function stampIfPastCancelCheck(
  tx: Prisma.TransactionClient,
  classId: string,
  now: Date,
): Promise<boolean> {
  const cls = await tx.class.findUnique({ where: { id: classId }, select: DECISION_SELECT });
  if (!cls || cls.status !== 'open' || cls.autoCancelDecidedAt !== null) return false;
  if (cls.calendarEntry.cancelledAt !== null) return false;
  if (!isPastCancelCheck(cls.calendarEntry, cls.autoCancelCheck, cls.calendarEntry.teacher.defaultTimezone, now)) {
    return false;
  }
  await tx.class.update({ where: { id: classId }, data: { autoCancelDecidedAt: now } });
  return true;
}

/**
 * Re-decides an open, live, unbooked class after its start moved, because its
 * check time moved with it. A new check time already reached is the teacher
 * choosing to run the class inside its window, so an undecided class is
 * stamped and a decided one stays decided. A new check time still ahead clears
 * the marker, and the sweep judges the class when it arrives. A draft has no
 * decision to make, and a booked class (`settingsLocked`) is left as it is.
 * Resolves to nothing; the marker is the result. Precondition: the caller
 * holds `classId`'s row lock.
 */
export async function redecideAfterMove(
  tx: Prisma.TransactionClient,
  classId: string,
  now: Date,
): Promise<void> {
  const cls = await tx.class.findUnique({ where: { id: classId }, select: DECISION_SELECT });
  if (!cls || cls.status !== 'open' || cls.settingsLocked || cls.calendarEntry.cancelledAt !== null) return;
  const past = isPastCancelCheck(cls.calendarEntry, cls.autoCancelCheck, cls.calendarEntry.teacher.defaultTimezone, now);
  if (past && cls.autoCancelDecidedAt === null) {
    await tx.class.update({ where: { id: classId }, data: { autoCancelDecidedAt: now } });
  } else if (!past && cls.autoCancelDecidedAt !== null) {
    await tx.class.update({ where: { id: classId }, data: { autoCancelDecidedAt: null } });
  }
}
