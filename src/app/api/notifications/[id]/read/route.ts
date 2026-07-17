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

  // Verify the notification belongs to this user
  if (
    notification.recipientType !== session.userType ||
    notification.recipientId !== session.userId
  ) {
    return respondError('Access denied', 403);
  }

  await markAsRead(prisma, id);
  return respondOk({ message: 'Marked as read' });
});
