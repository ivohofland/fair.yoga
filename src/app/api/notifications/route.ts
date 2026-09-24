import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondError,
  respondTyped,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import {
  NOTIFICATION_MAX_PAGE_SIZE,
  NOTIFICATION_PAGE_SIZE,
  decodeNotificationCursor,
} from '@/lib/notification-paging';
import { listNotificationPage, type NotificationPage } from '@/services/notifications';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const url = new URL(request.url);
  // A non-numeric limit is NaN, and Math.max(1, NaN) is NaN — degrade it to the
  // default rather than a 500.
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit = Number.isNaN(rawLimit)
    ? NOTIFICATION_PAGE_SIZE
    : Math.min(NOTIFICATION_MAX_PAGE_SIZE, Math.max(1, rawLimit));

  // A bad cursor is refused, not degraded to page one: a client that keeps
  // sending it would loop over the first page forever.
  const rawBefore = url.searchParams.get('before');
  const before = rawBefore === null ? undefined : decodeNotificationCursor(rawBefore);
  if (before === null) return respondError('Invalid cursor', 400);

  const rawType = url.searchParams.get('recipientType');
  if (rawType !== null && rawType !== 'teacher' && rawType !== 'student') {
    return respondError('Invalid recipientType', 400);
  }

  // A dual-role account reads both of its profiles' notifications.
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
