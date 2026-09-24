import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondError,
  respondTyped,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { decodeNotificationCursor, parseLimit } from '@/lib/notification-paging';
import { listNotificationPage, type NotificationPage } from '@/services/notifications';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'));

  // A bad cursor is refused, not degraded to page one: a client that keeps
  // sending it would loop over the first page forever.
  const rawBefore = url.searchParams.get('before');
  const before = rawBefore === null ? undefined : decodeNotificationCursor(rawBefore);
  if (before === null) return respondError('Invalid cursor', 400);

  const rawType = url.searchParams.get('recipientType');
  if (rawType !== null && rawType !== 'teacher' && rawType !== 'student') {
    return respondError('Invalid recipientType', 400);
  }

  // Absent recipientType, a dual-role account reads both of its profiles' notifications.
  const profiles = [
    ...(session.teacherId
      ? [{ recipientType: 'teacher' as const, recipientId: session.teacherId }]
      : []),
    ...(session.studentId
      ? [{ recipientType: 'student' as const, recipientId: session.studentId }]
      : []),
  ];
  const recipients = profiles.filter((r) => rawType === null || r.recipientType === rawType);

  const page = await listNotificationPage(prisma, recipients, { limit, before });
  return respondTyped<NotificationPage>(page);
});
