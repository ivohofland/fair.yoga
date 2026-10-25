import type { NotificationType, PrismaClient } from '@/lib/prisma-client';
import { VIDEO_LINK_EMAIL_TYPES } from '@/lib/notification-links';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';

/**
 * The video link a notification's email may carry, read when the email is
 * sent rather than when the notification was written (#911): a link the
 * teacher replaced since is never emailed, and a student who cancelled since
 * gets none.
 *
 * `null` unless the recipient is a student, the type is in
 * `VIDEO_LINK_EMAIL_TYPES`, and the related class is online with a link, not
 * terminal, and holds a live registration of the recipient's.
 */
export async function videoLinkForEmail(
  db: PrismaClient,
  n: { recipientType: string; recipientId: string; type: NotificationType; relatedClassId: string | null },
): Promise<string | null> {
  if (n.recipientType !== 'student' || n.relatedClassId === null || !VIDEO_LINK_EMAIL_TYPES.has(n.type)) {
    return null;
  }
  const cls = await db.class.findFirst({
    where: {
      id: n.relatedClassId,
      format: 'online',
      videoUrl: { not: null },
      // Terminal is a status or the entry's `cancelledAt` (#327).
      status: { notIn: [...TERMINAL_CLASS_STATUSES] },
      calendarEntry: { cancelledAt: null },
      registrations: { some: { studentId: n.recipientId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } } },
    },
    select: { videoUrl: true },
  });
  return cls?.videoUrl ?? null;
}
