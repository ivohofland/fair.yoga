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
} from '@/lib/api-utils';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest) {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  return respondOk({
    userId: session.userId,
    userType: session.userType,
  });
}

export async function DELETE(request: NextRequest) {
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
}
