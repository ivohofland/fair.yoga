import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  requireSession,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { clearSessionCookie } from '@/lib/auth';
import { deleteStudentAccount, deleteTeacherAccount } from '@/services/gdpr';

/**
 * GDPR account erasure (Art. 17). Personal data is anonymized; financial
 * records the other party is entitled to keep stay behind, attributed to a
 * deleted account. Signs the caller out.
 */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (session.userType === 'student') {
    await deleteStudentAccount(prisma, session.userId);
  } else {
    await deleteTeacherAccount(prisma, session.userId);
  }

  const response = respondOk({ deleted: true });
  clearSessionCookie(response.headers);
  return response;
});
