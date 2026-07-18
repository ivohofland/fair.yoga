import { NextRequest } from 'next/server';
import {
  verifyMagicLinkToken,
  createSession,
  setSessionCookie,
} from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import type { RecipientType } from '@prisma/client';
import { magicLinkVerifySchema, isSafeRelativePath } from '@/lib/schemas';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const parsed = await parseBody(request, magicLinkVerifySchema);
  if ('error' in parsed) return parsed.error;
  const { token } = parsed.data;

  const result = await verifyMagicLinkToken(prisma, token);
  if (!result) {
    return respondError('Invalid or expired magic link', 400);
  }

  const { email, redirectTo: tokenRedirect } = result;

  // Look up user: try Teacher first, then Student
  const teacher = await prisma.teacher.findUnique({ where: { email } });
  const student = teacher
    ? null
    : await prisma.student.findUnique({ where: { email } });
  const user = teacher ?? student;

  if (!user) {
    return respondError('Account not found', 400);
  }

  const userType: RecipientType = teacher ? 'teacher' : 'student';
  const sessionToken = await createSession(prisma, user.id, userType);
  // Prefer the destination stored with the token (booking flow), but only
  // relative paths — everything else falls back to the role default.
  const fallback = userType === 'teacher' ? '/' : '/bookings';
  const redirectTo =
    tokenRedirect && isSafeRelativePath(tokenRedirect) ? tokenRedirect : fallback;

  const response = respondOk({ userType, userId: user.id, redirectTo });
  setSessionCookie(response.headers, sessionToken);

  return response;
});
