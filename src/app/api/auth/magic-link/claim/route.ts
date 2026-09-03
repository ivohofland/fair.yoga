import { NextRequest } from 'next/server';
import {
  claimWithCode,
  readOriginNonce,
  createSession,
  setSessionCookie,
  resolveOrClaimAccount,
  mintSignupTicket,
  setSignupTicketCookie,
} from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { magicLinkClaimSchema, isSafeRelativePath } from '@/lib/schemas';
import { checkIpRateLimit, clientIp, RateLimitResult } from '@/lib/rate-limit';

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 30;

function tooManyRequests(result: RateLimitResult) {
  const retry = result.retryAfterSeconds;
  return respondError(
    `Too many attempts. Try again in ${Math.ceil(retry / 60)} minute${retry > 60 ? 's' : ''}.`,
    429,
  );
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const ipCheck = checkIpRateLimit(
    'magic-link:claim', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'magic-link/claim',
  );
  if (!ipCheck.allowed) return tooManyRequests(ipCheck);

  const parsed = await parseBody(request, magicLinkClaimSchema);
  if ('error' in parsed) return parsed.error;

  const outcome = await claimWithCode(prisma, readOriginNonce(request), parsed.data.code);
  if (outcome.kind !== 'verified') {
    // One message for a wrong code, an unknown code and a spent budget: the
    // three are indistinguishable to a caller by design.
    return respondError('That code did not work. Ask for a new link.', 400);
  }

  const { email, redirectTo: tokenRedirect, purpose } = outcome;
  const resolved = await resolveOrClaimAccount(prisma, email);

  if (!resolved && purpose === 'teacher_signup') {
    const ticket = await mintSignupTicket(prisma, email);
    const response = respondOk({ redirectTo: '/signup/profile' });
    setSignupTicketCookie(response.headers, ticket);
    return response;
  }

  if (!resolved) return respondError('Account not found', 400);

  const sessionToken = await createSession(prisma, resolved.accountId);
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  const redirectTo =
    tokenRedirect && isSafeRelativePath(tokenRedirect) ? tokenRedirect : fallback;

  const response = respondOk({ accountId: resolved.accountId, redirectTo });
  setSessionCookie(response.headers, sessionToken);
  return response;
});
