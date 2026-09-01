import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, parseBody, withErrorHandler } from '@/lib/api-utils';
import { teacherSignupSchema } from '@/lib/schemas';
import { generateMagicLinkToken } from '@/lib/auth';
import { sendMagicLinkEmail } from '@/lib/email';
import { checkRateLimit, checkIpRateLimit, clientIp, rateLimitKey, respondRateLimited } from '@/lib/rate-limit';

/**
 * Email-only teacher signup (#385). Mints and emails a magic link, marked
 * `teacher_signup` for an address with no account yet, or an ordinary
 * `sign_in` link for one that already has one — no rows are ever written
 * here. Uniform 200 either way, same non-enumeration contract as
 * `student-signup`.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  // Throttled before parsing: each accepted request can send a real email,
  // so an unthrottled endpoint is an email-bombing vector.
  const ip = clientIp(request);
  const ipCheck = checkIpRateLimit('teacher-signup', ip, 5, 60 * 60 * 1000, 'teacher-signup');
  if (!ipCheck.allowed) return respondRateLimited(ipCheck);

  const parsed = await parseBody(request, teacherSignupSchema);
  if ('error' in parsed) return parsed.error;
  const { email } = parsed.data;

  const emailCheck = checkRateLimit(rateLimitKey('teacher-signup:email', email), 3, 15 * 60 * 1000);
  if (!emailCheck.allowed) return respondRateLimited(emailCheck);

  // An address that already has an account gets an ORDINARY sign-in link.
  // The signup marker is what lets verification create an account, so
  // handing it to a stranger's address would let them push a real user down
  // the signup path.
  const existing = await prisma.account.findUnique({ where: { email } });
  const purpose = existing ? 'sign_in' : 'teacher_signup';
  const token = await generateMagicLinkToken(prisma, email, {
    redirectTo: existing ? undefined : '/signup/profile',
    purpose,
  });

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  await sendMagicLinkEmail(email, `${baseUrl}/verify?token=${token}`);

  // Uniform 200 whatever the address turned out to be — same
  // non-enumeration contract as `student-signup`.
  return respondOk({ message: 'Check your inbox for a link.' });
});
