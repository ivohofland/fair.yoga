import type { TransactionClientOnly } from '@/lib/db-locks';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';

/**
 * Tells the students who hold a seat that a class's video link was added or
 * changed (#911). Notifies no one when the link is cleared or did not change.
 *
 * Neither the title nor the body carries the link: the email reads the class's
 * current link when it is sent (`videoLinkForEmail`).
 *
 * Awaited: it inserts inbox rows (and emits them to the in-process bus), with
 * no provider whose latency or failure could reach the caller. Takes a
 * transaction client so the rows commit or roll back with the edit; the
 * inserts' `relatedClassId` takes `FOR KEY SHARE` on the class, so the caller
 * holds that class's row lock first.
 *
 * Returns the number of students notified.
 */
export async function notifyVideoLinkChanged(
  db: TransactionClientOnly,
  input: { classId: string; previous: string | null; next: string | null },
): Promise<number> {
  if (input.next === null || input.next === input.previous) return 0;

  const cls = await db.class.findUnique({
    where: { id: input.classId },
    select: {
      calendarEntry: { select: { classType: true, date: true, startTime: true } },
      registrations: {
        where: { status: { in: [...ACTIVE_REGISTRATION_STATUSES] }, student: { deletedAt: null } },
        select: { studentId: true },
      },
    },
  });
  if (!cls || cls.registrations.length === 0) return 0;

  const { classType, date, startTime } = cls.calendarEntry;
  const notifications: CreateNotificationInput[] = cls.registrations.map((r) => ({
    recipientType: 'student',
    recipientId: r.studentId,
    type: 'video_link_updated',
    title: `Video link for ${classType}`,
    body: `${classType} on ${formatDayHeader(date)} at ${timeToHHmm(startTime)}: the video link is on your booking.`,
    relatedClassId: input.classId,
  }));
  return createBulkNotifications(db, notifications);
}
