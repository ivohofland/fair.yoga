import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  requireSession,
  isErrorResponse,
} from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '20', 10)));
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
}
