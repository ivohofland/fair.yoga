import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { studentSignupSchema } from '@/lib/schemas';
import { ensureOriginNonce, deliverSignInLink } from '@/lib/auth';
import { checkRateLimit, checkIpRateLimit, clientIp, rateLimitKey } from '@/lib/rate-limit';
import { log } from '@/lib/log';


/**
 * Email-only student signup, mirroring `teacher-signup` (#385, #399). Mints
 * and emails a magic link, marked `student_signup` for an address with no
 * account and a redirect to spend it on, or an ordinary `sign_in` link
 * otherwise — no `Student` or `Account` row is ever written here. The
 * response is identical whether the email was new, an existing student, or a
 * teacher — no account enumeration.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const ip = clientIp(request);
  const ipCheck = checkIpRateLimit('student-signup:ip', ip, 5, 60 * 60 * 1000, 'student-signup');
  if (!ipCheck.allowed) {
    return respondError('Too many signup attempts. Try again later.', 429);
  }
  const emailParsed = await parseBody(request, studentSignupSchema);
  if ('error' in emailParsed) return emailParsed.error;
  const { email, redirect } = emailParsed.data;

  const emailCheck = checkRateLimit(rateLimitKey('student-signup:email', email), 3, 15 * 60 * 1000);
  if (!emailCheck.allowed) {
    return respondError('Too many signup attempts. Try again later.', 429);
  }

  // An address that already has an account gets an ORDINARY sign-in link: the
  // signup marker is what lets verification create one, so handing it to a
  // stranger's address would push a real user down the signup path.
  //
  // And no marker without a redirect either. The marked link's only outcome is
  // a ticket, and this family's ticket is spent on the booking page the
  // redirect names — so minting one for a request that named no page would
  // hand back a credential with nowhere to go. The `Student` table is not
  // consulted: an unclaimed CRM row is claimed at verification, which is an
  // ordinary sign-in, so it never needed a branch here.
  const existing = await prisma.account.findUnique({ where: { email } });
  const purpose = !existing && redirect ? 'student_signup' : 'sign_in';

  const response = respondOk({ message: 'Check your inbox for a sign-in link.' });
  const nonce = ensureOriginNonce(request, response.headers);
  try {
    await deliverSignInLink(prisma, email, nonce, { redirectTo: redirect, purpose });
  } catch (err) {
    // The nonce cookie is already attached to `response` — an exception here
    // must not discard it and fall through to `withErrorHandler`'s cookie-less
    // error response.
    log.error({ err }, 'student signup: deliverSignInLink failed');
  }
  return response;
});
