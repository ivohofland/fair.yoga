import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { markAsRead } from '@/services/notifications';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification) return respondError('Notification not found', 404);

  // Verify the notification belongs to one of this account's profiles
  const owns =
    (notification.recipientType === 'teacher' &&
      notification.recipientId === session.teacherId) ||
    (notification.recipientType === 'student' &&
      notification.recipientId === session.studentId);
  if (!owns) {
    return respondError('Access denied', 403);
  }

  await markAsRead(prisma, id);
  return respondOk({ message: 'Marked as read' });
});
