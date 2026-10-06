import { NextRequest } from 'next/server';
import { clearSessionCookie } from '@/lib/auth';
import { signOutEverywhere } from '@/services/account-sign-out';
import { respondOk, requireSession, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';

/**
 * Sign out everywhere: every session and push subscription of the caller's
 * account, this session included. Not gated on recent sign-in — it can only lock someone out.
 */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  await signOutEverywhere(prisma, session.accountId);

  const response = respondOk({ message: 'Signed out everywhere' });
  clearSessionCookie(response.headers);
  return response;
});
