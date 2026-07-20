import { NextRequest } from 'next/server';
import {
  getSessionToken,
  invalidateSession,
  clearSessionCookie,
} from '@/lib/auth';
import {
  respondOk,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  return respondOk({
    accountId: session.accountId,
    teacherId: session.teacherId,
    studentId: session.studentId,
  });
});

export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const token = getSessionToken(request);

  if (token) {
    try {
      await invalidateSession(prisma, token);
    } catch {
      // Session may already be deleted — that's fine
    }
  }

  const response = respondOk({ message: 'Logged out' });
  clearSessionCookie(response.headers);

  return response;
});
