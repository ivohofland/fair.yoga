import { NextRequest } from 'next/server';
import { invalidateAccountSessions, clearSessionCookie } from '@/lib/auth';
import { respondOk, requireSession, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';

/**
 * Sign out everywhere: every session of the caller's account, this one
 * included. Not gated on recent sign-in — it can only lock someone out.
 */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  await invalidateAccountSessions(prisma, session.accountId);

  const response = respondOk({ message: 'Signed out everywhere' });
  clearSessionCookie(response.headers);
  return response;
});
