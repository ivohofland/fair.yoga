import type { Prisma } from '@prisma/client';
import { isPastCancelCheck } from '@/lib/auto-cancel-check';

/**
 * Marks the auto-cancel decision as made for an open, live, undecided class
 * whose check time has already been reached. A teacher who publishes or
 * reschedules a class inside its own check window has chosen to run it, so the
 * sweep must not judge it. The caller holds the class row lock.
 */
export async function stampIfPastCancelCheck(
  tx: Prisma.TransactionClient,
  classId: string,
  now: Date,
): Promise<boolean> {
  const cls = await tx.class.findUnique({
    where: { id: classId },
    select: {
      status: true,
      autoCancelCheck: true,
      autoCancelDecidedAt: true,
      calendarEntry: {
        select: { date: true, startTime: true, cancelledAt: true, teacher: { select: { defaultTimezone: true } } },
      },
    },
  });
  if (!cls || cls.status !== 'open' || cls.autoCancelDecidedAt !== null) return false;
  if (cls.calendarEntry.cancelledAt !== null) return false;
  if (!isPastCancelCheck(cls.calendarEntry, cls.autoCancelCheck, cls.calendarEntry.teacher.defaultTimezone, now)) {
    return false;
  }
  await tx.class.update({ where: { id: classId }, data: { autoCancelDecidedAt: now } });
  return true;
}
