import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, parseBody, withErrorHandler } from '@/lib/api-utils';
import { studentSignupSchema } from '@/lib/schemas';
import { ensureOriginNonce, deliverSignInLink } from '@/lib/auth';
import { checkRateLimit, checkIpRateLimit, clientIp, rateLimitKey, respondRateLimited } from '@/lib/rate-limit';
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
    // No address in the log line, for the same non-enumeration reason the
    // comment below gives for skipping the `Student` table: this route
    // never confirms or denies an address to an unauthenticated caller.
    log.warn({ route: 'student-signup', bucket: 'ip' }, 'student signup refused by IP rate limit');
    return respondRateLimited(ipCheck, 'Too many signup attempts.');
  }
  const emailParsed = await parseBody(request, studentSignupSchema);
  if ('error' in emailParsed) return emailParsed.error;
  const { email, redirect } = emailParsed.data;

  const emailCheck = checkRateLimit(rateLimitKey('student-signup:email', email), 3, 15 * 60 * 1000);
  if (!emailCheck.allowed) {
    log.warn({ route: 'student-signup', bucket: 'email' }, 'student signup refused by per-address rate limit');
    return respondRateLimited(emailCheck, 'Too many signup attempts.');
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

  // The nonce cookie is built on its own `Headers` first, ahead of the
  // delivery attempt below, so it survives regardless of that attempt's
  // outcome — copied onto whichever response body this route ends up
  // returning, rather than tying it to one response built before the
  // outcome is known.
  const cookieHeaders = new Headers();
  const nonce = ensureOriginNonce(request, cookieHeaders);

  // `delivered` carries the true outcome in the body: `BookingNameStep`'s
  // 401-resend branch keys its `expired`/`expired-stuck` copy on this field,
  // not on the response status, since this route answers 200 either way —
  // a swallowed send failure must not read as "we've emailed you a fresh
  // link" when no email went out.
  let delivered = true;
  try {
    await deliverSignInLink(prisma, email, nonce, { redirectTo: redirect, purpose });
  } catch (err) {
    delivered = false;
    log.error({ err }, 'student signup: deliverSignInLink failed');
  }

  const response = respondOk({
    message: delivered ? 'Check your inbox for a sign-in link.' : "We couldn't send the email just now.",
    delivered,
  });
  cookieHeaders.forEach((value, key) => response.headers.append(key, value));
  return response;
});
