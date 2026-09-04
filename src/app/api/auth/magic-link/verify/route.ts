import { NextRequest } from 'next/server';
import {
  verifyWithHandoff,
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
import { magicLinkVerifySchema, isSafeRelativePath, TEACHER_PROFILE_PATH } from '@/lib/schemas';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const parsed = await parseBody(request, magicLinkVerifySchema);
  if ('error' in parsed) return parsed.error;
  const { token } = parsed.data;

  // Must run before `verifyWithHandoff` below, not after — see
  // `consumeTokenRow` (magic-link.ts) for why the ordering matters here.
  const strayTicket = request.cookies.get(SIGNUP_TICKET_COOKIE)?.value;
  const strayTicketEmail = strayTicket
    ? await liveSignupTicketEmail(prisma, strayTicket)
    : null;

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

  if (!resolved) {
    return respondError('Account not found', 400);
  }

  const sessionToken = await createSession(prisma, resolved.accountId);
  // Prefer the destination stored with the token (booking flow), but only
  // relative paths — everything else falls back to the role default;
  // dual-role accounts default to the teacher home.
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  // One destination is refused rather than merely defaulted (#431): the
  // teacher profile form, for an account that already teaches. That page's
  // own first line sends such a browser to `/schedule`, and `/verify`'s copy
  // reads this path — so honouring it here promises a page the reader is
  // about to be bounced from, out loud, and costs a hop saying it.
  //
  // Scoped to this one path. Every other destination a token can carry is
  // usable by whoever receives it, and `teacher-signup/route.ts` is right to
  // send this one unconditionally: whether the ADDRESS has an account is not
  // the question, and whether it has a TEACHER PROFILE is knowable only
  // here. The condition is `resolved.teacherId`, never the path alone —
  // a student-only account keeps this destination, which is the second-hat
  // flow.
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
