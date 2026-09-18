import { NextRequest } from 'next/server';
import {
  revokeRequestSession,
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
  await revokeRequestSession(prisma, request);

  const response = respondOk({ message: 'Logged out' });
  clearSessionCookie(response.headers);

  return response;
});
