import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { studentSignupSchema } from '@/lib/schemas';
import { generateMagicLinkToken } from '@/lib/auth';
import { sendMagicLinkEmail } from '@/lib/email';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';

/**
 * Student self-signup from the public booking flow.
 *
 * Creates the account (claimedAt set — the student registered themselves)
 * and sends a magic link that returns them to where they were booking.
 * The response is identical whether the email was new, an existing
 * student, or a teacher — no account enumeration.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const ip = clientIp(request);
  if (ip !== 'unknown') {
    const ipCheck = checkRateLimit(`student-signup:${ip}`, 5, 60 * 60 * 1000);
    if (!ipCheck.allowed) {
      return respondError('Too many signup attempts. Try again later.', 429);
    }
  }
  const emailParsed = await parseBody(request, studentSignupSchema);
  if ('error' in emailParsed) return emailParsed.error;
  const { firstName, lastName, email, redirect } = emailParsed.data;

  const emailCheck = checkRateLimit(`student-signup:email:${email.toLowerCase()}`, 3, 15 * 60 * 1000);
  if (!emailCheck.allowed) {
    return respondError('Too many signup attempts. Try again later.', 429);
  }

  const existingTeacher = await prisma.teacher.findUnique({ where: { email } });
  const existingStudent = await prisma.student.findUnique({ where: { email } });

  if (!existingTeacher && !existingStudent) {
    await prisma.student.create({
      data: { firstName, lastName, email, claimedAt: new Date() },
    });
  }

  // Existing student (or teacher) simply gets a sign-in link — same outcome
  // from the caller's perspective.
  const token = await generateMagicLinkToken(prisma, email, redirect);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  await sendMagicLinkEmail(email, `${baseUrl}/verify?token=${token}`);

  return respondOk({ message: 'Check your inbox for a sign-in link.' });
});
