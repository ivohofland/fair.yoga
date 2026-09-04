import { NextRequest } from 'next/server';
import {
  claimWithCode,
  readOriginNonce,
  clearOriginNonceCookie,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  revokeRequestSession,
  resolveOrClaimAccount,
  mintSignupTicket,
  setSignupTicketCookie,
  clearSignupTicketCookie,
  signupTicketFor,
  liveSignupTicketEmail,
  SIGNUP_TICKET_COOKIE,
} from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { magicLinkClaimSchema, isSafeRelativePath, TEACHER_PROFILE_PATH } from '@/lib/schemas';
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

  // Must run before `claimWithCode` below, not after — see
  // `consumeTokenRow` (magic-link.ts) for why the ordering matters here.
  const strayTicket = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
  const strayTicketEmail = strayTicket
    ? await liveSignupTicketEmail(prisma, strayTicket)
    : null;

  const outcome = await claimWithCode(prisma, readOriginNonce(request), parsed.data.code);
  if (outcome.kind !== 'verified') {
    // One message for a wrong code, an unknown code and a spent budget: the
    // three are indistinguishable to a caller by design.
    return respondError('That code did not work. Ask for a new link.', 400);
  }

  const { email, redirectTo: tokenRedirect, purpose } = outcome;
  const resolved = await resolveOrClaimAccount(prisma, email);

  // Same `signupTicketFor` decision `magic-link/verify` makes — a code
  // redeemed here reached the same token row that route would have consumed
  // directly, so the two doors must agree on what it authorizes.
  const signupTicket = signupTicketFor(purpose, tokenRedirect);

  if (!resolved && signupTicket) {
    const ticket = await mintSignupTicket(prisma, email, signupTicket.family);
    // A session cookie surviving this response would block the very ticket it
    // just set, for that ticket's whole life (`ticketTokenFrom`) — so the
    // clear is what makes the ticket usable at all, not hygiene. Revoked as
    // well as cleared: the cookie ends the sign-in for this browser, the row
    // behind it decides whether that token still authenticates anywhere.
    const sessionEnded = await revokeRequestSession(prisma, request);
    const response = respondOk({
      redirectTo: signupTicket.dest,
      // This branch overwrites the ticket cookie, and a ticket's raw value
      // lives nowhere else — so a live ticket for ANOTHER address is a signup
      // that just became unreachable. The same address is this signup being
      // restarted, which is what the reader asked for and no cancellation.
      signupCancelled: strayTicketEmail !== null && strayTicketEmail !== email,
      sessionEnded,
    });
    setSignupTicketCookie(response.headers, ticket);
    clearOriginNonceCookie(response.headers);
    clearSessionCookie(response.headers);
    return response;
  }

  if (!resolved) return respondError('Account not found', 400);

  const sessionToken = await createSession(prisma, resolved.accountId);
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  // Refused rather than defaulted: this destination would immediately bounce
  // an existing teacher back off `/signup/profile` (#431) — pinned by the
  // directional integration cases in magic-link-claim.test.ts. The identical
  // guard on the direct-verify door (`magic-link/verify`) is pinned the same
  // way in teacher-signup-api.test.ts. Directional: only `teacherId !== null`
  // is blocked, so a student's second-hat flow keeps this destination.
  const bouncedTeacherForm =
    tokenRedirect === TEACHER_PROFILE_PATH && resolved.teacherId !== null;
  const redirectTo =
    tokenRedirect && isSafeRelativePath(tokenRedirect) && !bouncedTeacherForm
      ? tokenRedirect
      : fallback;

  const response = respondOk({
    accountId: resolved.accountId,
    redirectTo,
    // Any live ticket, whatever its address: signing in abandons the signup.
    signupCancelled: strayTicketEmail !== null,
  });
  setSessionCookie(response.headers, sessionToken);
  clearOriginNonceCookie(response.headers);
  // A browser that just received a session has no legitimate reason to keep
  // carrying a ticket cookie forward.
  clearSignupTicketCookie(response.headers);
  return response;
});
