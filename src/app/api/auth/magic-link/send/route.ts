import { NextRequest } from 'next/server';
import { generateMagicLinkToken } from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { sendMagicLinkEmail } from '@/lib/email';
import { magicLinkSendSchema } from '@/lib/schemas';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';

const WINDOW_MS = 15 * 60 * 1000;
const PER_EMAIL_LIMIT = 3;
const PER_IP_LIMIT = 10;

export const POST = withErrorHandler(async (request: NextRequest) => {
  const parsed = await parseBody(request, magicLinkSendSchema);
  if ('error' in parsed) return parsed.error;
  const { email, redirect } = parsed.data;

  // Throttle before doing any work: each accepted request can trigger a
  // real email send, so an unthrottled endpoint is an email-bombing and
  // quota-exhaustion vector. The IP check only applies when a proxy
  // forwarded a real address — without one, all callers would share a
  // single bucket and lock each other out.
  const ip = clientIp(request);
  const ipCheck =
    ip === 'unknown'
      ? { allowed: true, retryAfterSeconds: 0 }
      : checkRateLimit(`magic-link:ip:${ip}`, PER_IP_LIMIT, WINDOW_MS);
  const emailCheck = checkRateLimit(
    `magic-link:email:${email.toLowerCase()}`,
    PER_EMAIL_LIMIT,
    WINDOW_MS,
  );
  if (!ipCheck.allowed || !emailCheck.allowed) {
    const retry = Math.max(ipCheck.retryAfterSeconds, emailCheck.retryAfterSeconds);
    return respondError(
      `Too many sign-in requests. Try again in ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''}.`,
      429,
    );
  }

  // Look up user in Teacher table first, then Student
  const teacher = await prisma.teacher.findUnique({ where: { email } });
  const user = teacher ?? (await prisma.student.findUnique({ where: { email } }));

  if (user) {
    const token = await generateMagicLinkToken(prisma, email, redirect);
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const magicLinkUrl = `${baseUrl}/verify?token=${token}`;
    await sendMagicLinkEmail(email, magicLinkUrl);
  }

  // Always return 200 to prevent email enumeration
  return respondOk({ message: 'If an account exists, a magic link has been sent.' });
});
