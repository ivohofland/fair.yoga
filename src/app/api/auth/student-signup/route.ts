import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { studentSignupSchema } from '@/lib/schemas';
import { generateMagicLinkToken } from '@/lib/auth';
import { sendMagicLinkEmail } from '@/lib/email';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';


/**
 * Student self-signup from the public booking flow.
 *
 * Creates the account (claimedAt set — the student registered themselves)
 * and sends a magic link that returns them to where they were booking.
 * The response is identical whether the email was new, an existing
 * student, or a teacher — no account enumeration.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const ip = clientIp(request);
  if (ip !== 'unknown') {
    const ipCheck = checkRateLimit(`student-signup:${ip}`, 5, 60 * 60 * 1000);
    if (!ipCheck.allowed) {
      return respondError('Too many signup attempts. Try again later.', 429);
    }
  }
  const emailParsed = await parseBody(request, studentSignupSchema);
  if ('error' in emailParsed) return emailParsed.error;
  const { firstName, lastName, email, redirect } = emailParsed.data;

  const emailCheck = checkRateLimit(`student-signup:email:${email}`, 3, 15 * 60 * 1000);
  if (!emailCheck.allowed) {
    return respondError('Too many signup attempts. Try again later.', 429);
  }

  const existingAccount = await prisma.account.findUnique({ where: { email } });
  const existingStudent = await prisma.student.findUnique({ where: { email } });

  // Fresh email: account + claimed student, atomically. Every other state
  // just gets the link — an unclaimed CRM row claims at verify, and a
  // profile never attaches to an existing account without its session.
  if (!existingAccount && !existingStudent) {
    try {
      await prisma.student.create({
        data: {
          firstName,
          lastName,
          email,
          claimedAt: new Date(),
          account: { create: { email } },
        },
      });
    } catch (err) {
      // Both pre-checks above are plain reads, so a concurrent signup for the
      // same fresh address passes both and one of them loses on
      // `Student.email`/`Account.email`. Losing means the account now exists
      // — which is precisely the state the unconditional mint-and-send below
      // already handles correctly (there is no `else`; every state that is not
      // a fresh email simply falls through to it). Rethrowing would surface a 409
      // "Resource already exists", failing a legitimate signup AND telling an
      // anonymous caller the address is taken, which this route's identical
      // 200 exists to prevent.
      //
      // Narrowed to the EMAIL uniques and logged, rather than swallowing every
      // P2002 in silence. `P2002` alone is "some unique constraint" — a future
      // one on this create (a slug, an id) would be swallowed here with the
      // same reasoning attached to it, and reasoning that only holds for the
      // email keys must not be applied by accident to a constraint nobody has
      // thought about.
      //
      // `isUniqueConflictOn` rather than a local matcher: it is the measured
      // one. Its docblock records that Prisma reports `meta.target` as the
      // column-name ARRAY even for indexes it cannot see, so the raw-string
      // shape a hand-rolled version defends against does not arrive; and it
      // compares the column set exactly, where a `includes('email')` substring
      // would quietly swallow a future `billingEmail` key under this same
      // reasoning. `Student.email` and `Account.email` both key on `['email']`,
      // so one predicate covers both halves of the race.
      //
      // An unrecognised P2002 must not rethrow AS a P2002 either.
      // `classifyApiError` answers P2002 with 409 "Resource already exists" —
      // which is the disclosure the paragraph above is about, arriving through
      // the other door. So it is rethrown as an ordinary error instead: a 500
      // tells an anonymous caller nothing, and `error` is the right level for
      // a constraint on this create that nobody has accounted for.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      if (!isUniqueConflictOn(err, ['email'])) {
        log.error(
          { err, rawTarget: err.meta?.target },
          'student signup hit a unique constraint that is not one of the email keys',
        );
        throw new Error('student signup: unrecognised unique constraint on create');
      }
      // No address in the log line, on purpose: the uniform 200 above exists
      // so an anonymous caller cannot learn whether an address has an account,
      // and a log naming it hands that same fact to everyone with log access.
      // `modelName` rather than the target columns: both halves of this race
      // key on `['email']`, so the column set cannot tell `Student` from
      // `Account` — and which of the two lost is the only detail worth having
      // here.
      log.warn(
        { model: err.meta?.modelName },
        'student signup lost a create race on an existing email; falling through to the magic link',
      );
    }
  }
  const token = await generateMagicLinkToken(prisma, email, redirect);
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  await sendMagicLinkEmail(email, `${baseUrl}/verify?token=${token}`);

  return respondOk({ message: 'Check your inbox for a sign-in link.' });
});
