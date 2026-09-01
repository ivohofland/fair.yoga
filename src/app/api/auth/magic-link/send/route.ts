import { NextRequest } from 'next/server';
import { generateMagicLinkToken } from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { sendMagicLinkEmail } from '@/lib/email';
import { magicLinkSendSchema } from '@/lib/schemas';
import { checkRateLimit, checkIpRateLimit, clientIp, rateLimitKey, RateLimitResult } from '@/lib/rate-limit';

const WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL_LIMIT = 3;
const PER_IP_LIMIT = 10;

function tooManyRequests(result: RateLimitResult) {
  const retry = result.retryAfterSeconds;
  return respondError(
    `Too many sign-in requests. Try again in ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''}.`,
    429,
  );
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Throttle before doing any work: each accepted request can trigger a
  // real email send, so an unthrottled endpoint is an email-bombing and
  // quota-exhaustion vector. Checked before parsing the body so a flood is
  // rejected as cheaply as possible.
  const ip = clientIp(request);
  const ipCheck = checkIpRateLimit('magic-link:ip', ip, PER_IP_LIMIT, WINDOW_MS, 'magic-link/send');
  if (!ipCheck.allowed) return tooManyRequests(ipCheck);

  const parsed = await parseBody(request, magicLinkSendSchema);
  if ('error' in parsed) return parsed.error;
  const { email, redirect } = parsed.data;

  // Must return above on an IP block rather than falling through — a
  // fall-through would let an IP-blocked caller still consume a hit from
  // an arbitrary target email's own budget.
  const emailCheck = checkRateLimit(rateLimitKey('magic-link:email', email), PER_EMAIL_LIMIT, WINDOW_MS);
  if (!emailCheck.allowed) return tooManyRequests(emailCheck);

  // Look up user in Teacher table first, then Student
  const teacher = await prisma.teacher.findUnique({ where: { email } });
  const user = teacher ?? (await prisma.student.findUnique({ where: { email } }));

  if (user) {
    const token = await generateMagicLinkToken(prisma, email, { redirectTo: redirect });
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const magicLinkUrl = `${baseUrl}/verify?token=${token}`;
    await sendMagicLinkEmail(email, magicLinkUrl);
  }

  // Always return 200 to prevent email enumeration
  return respondOk({ message: 'If an account exists, a magic link has been sent.' });
});
