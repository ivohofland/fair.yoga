import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const url = new URL(request.url);
  // parseInt of a non-numeric param is NaN, and Math.max(1, NaN) is NaN —
  // guard so garbage pagination degrades to defaults instead of a 500.
  const rawPage = parseInt(url.searchParams.get('page') ?? '1', 10);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? '20', 10);
  const page = Number.isNaN(rawPage) ? 1 : Math.max(1, rawPage);
  const limit = Number.isNaN(rawLimit) ? 20 : Math.min(100, Math.max(1, rawLimit));
  const skip = (page - 1) * limit;

  const [notifications, total] = await Promise.all([
    prisma.notification.findMany({
      where: {
        recipientType: session.userType,
        recipientId: session.userId,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.notification.count({
      where: {
        recipientType: session.userType,
        recipientId: session.userId,
      },
    }),
  ]);

  return respondOk({ notifications, total, page, limit });
});
