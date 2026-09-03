import { NextRequest } from 'next/server';
import { ensureOriginNonce, deliverSignInLink } from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { magicLinkSendSchema } from '@/lib/schemas';
import { checkRateLimit, checkIpRateLimit, clientIp, rateLimitKey, RateLimitResult } from '@/lib/rate-limit';
import { log } from '@/lib/log';

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

  // The nonce is established for EVERY accepted request, before the user
  // lookup below. This route answers a uniform 200 either way so an anonymous
  // caller cannot learn whether an address is registered; setting the cookie
  // only inside `if (user)` would put that same fact back into `Set-Cookie`.
  const response = respondOk({ message: 'If an account exists, a magic link has been sent.' });
  const nonce = ensureOriginNonce(request, response.headers);

  const teacher = await prisma.teacher.findUnique({ where: { email } });
  const user = teacher ?? (await prisma.student.findUnique({ where: { email } }));

  if (user) {
    try {
      await deliverSignInLink(prisma, email, nonce, { redirectTo: redirect });
    } catch (err) {
      // The nonce cookie is already attached to `response` below — an
      // exception here must not discard it, or a send failure for one
      // specific registered address would answer differently (500, no
      // cookie) than an unregistered address's identical-looking request,
      // reopening the enumeration channel this route's uniform 200 exists
      // to close.
      log.error({ err }, 'magic-link send: deliverSignInLink failed');
    }
  }

  return response;
});
