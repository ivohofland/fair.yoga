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
import { log } from '@/lib/log';
import {
  magicLinkVerifySchema,
  isSafeRelativePath,
  TEACHER_PROFILE_PATH,
  MAGIC_LINK_REFUSED_STATUS,
} from '@/lib/schemas';

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
    return respondError('Invalid or expired magic link', MAGIC_LINK_REFUSED_STATUS);
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
    // The token was real, unexpired and for this browser — and consuming it
    // has already deleted every other live token for the address. So the
    // reader is stranded behind a burned link and a fresh one burns the same
    // way, which is worth a line even though the client deliberately treats
    // every 400 here as ordinary. `purpose` and nothing else: the address is
    // the one thing an operator must not need, and `signupTicketFor`'s own
    // refusal one layer down logs the same way for the same reason.
    log.error(
      { purpose },
      'a magic link verified but its address has no account; the link is spent and the reader is stranded',
    );
    return respondError('Account not found', MAGIC_LINK_REFUSED_STATUS);
  }

  const sessionToken = await createSession(prisma, resolved.accountId);
  // Prefer the destination stored with the token (booking flow), but only
  // relative paths — everything else falls back to the role default;
  // dual-role accounts default to the teacher home.
  const fallback = resolved.teacherId ? '/schedule' : '/bookings';
  // Refused rather than defaulted: this destination would immediately bounce
  // an existing teacher back off `/signup/profile` (#431) — pinned by the
  // directional integration cases in teacher-signup-api.test.ts. The
  // identical guard on the device-handoff door (`magic-link/claim`) is
  // pinned the same way in magic-link-claim.test.ts. Directional: only
  // `teacherId !== null` is blocked, so a student's second-hat flow keeps
  // this destination.
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
