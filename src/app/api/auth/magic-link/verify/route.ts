import { NextRequest } from 'next/server';
import {
  verifyMagicLinkToken,
  createSession,
  setSessionCookie,
} from '@/lib/auth';
import { respondOk, respondError, parseBody } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import type { RecipientType } from '@prisma/client';
import { magicLinkVerifySchema } from '@/lib/schemas';

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, magicLinkVerifySchema);
  if ('error' in parsed) return parsed.error;
  const { token } = parsed.data;

  const result = await verifyMagicLinkToken(prisma, token);
  if (!result) {
    return respondError('Invalid or expired magic link', 400);
  }

  const { email } = result;

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
  const redirectTo = userType === 'teacher' ? '/' : '/bookings';

  const response = respondOk({ userType, userId: user.id, redirectTo });
  setSessionCookie(response.headers, sessionToken);

  return response;
}
