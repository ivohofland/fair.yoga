import { NextRequest } from 'next/server';
import {
  verifyWithHandoff,
  readOriginNonce,
  clearOriginNonceCookie,
  createSession,
  setSessionCookie,
  resolveOrClaimAccount,
  mintSignupTicket,
  setSignupTicketCookie,
  clearSignupTicketCookie,
  signupTicketFor,
  signupTicketIsLive,
  SIGNUP_TICKET_COOKIE,
} from '@/lib/auth';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { magicLinkVerifySchema, isSafeRelativePath } from '@/lib/schemas';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const parsed = await parseBody(request, magicLinkVerifySchema);
  if ('error' in parsed) return parsed.error;
  const { token } = parsed.data;

  // Must run before `verifyWithHandoff` below, not after — see
  // `consumeTokenRow` (magic-link.ts) for why the ordering matters here.
  // Checked against the database rather than cookie presence alone, so an
  // expired or already-consumed cookie still reads as "no live ticket"
  // rather than as evidence of a cancellation.
  const strayTicket = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
  const signupCancelled = strayTicket ? await signupTicketIsLive(prisma, strayTicket) : false;

  const outcome = await verifyWithHandoff(prisma, token, readOriginNonce(request));

  if (outcome.kind !== 'verified') {
    if (outcome.kind === 'handoff') {
      // Nothing was consumed. The client shows the code; the browser that
      // requested the link trades it for a session at /claim.
      return respondOk({ handoffCode: outcome.code });
    }
    return respondError('Invalid or expired magic link', 400);
  }

  const { email, redirectTo: tokenRedirect, purpose } = outcome;

  const resolved = await resolveOrClaimAccount(prisma, email);

  const signupTicket = signupTicketFor(purpose, tokenRedirect);

  // A signup token whose address still has no account: hand back a ticket,
  // NOT a session. `validateSession` deletes any session whose account has no
  // live profile, and `SessionUser` cannot represent one — so the account is
  // created later, together with the profile.
  if (!resolved && signupTicket) {
    const ticket = await mintSignupTicket(prisma, email, signupTicket.family);
    const response = respondOk({ redirectTo: signupTicket.dest });
    setSignupTicketCookie(response.headers, ticket);
    clearOriginNonceCookie(response.headers);
    return response;
  }

  if (!resolved) {
    return respondError('Account not found', 400);
  }

  const sessionToken = await createSession(prisma, resolved.accountId);
  // Prefer the destination stored with the token (booking flow), but only
  // relative paths — everything else falls back to the role default;
  // dual-role accounts default to the teacher home.
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  const redirectTo =
    tokenRedirect && isSafeRelativePath(tokenRedirect) ? tokenRedirect : fallback;

  const response = respondOk({ accountId: resolved.accountId, redirectTo, signupCancelled });
  setSessionCookie(response.headers, sessionToken);
  clearOriginNonceCookie(response.headers);
  // A browser that just received a session has no legitimate reason to keep
  // carrying a stray ticket cookie forward: `student-profile`'s ticket path
  // would otherwise read it on the very next request this session makes.
  clearSignupTicketCookie(response.headers);

  return response;
});
