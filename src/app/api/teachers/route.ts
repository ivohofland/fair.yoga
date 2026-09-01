import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
import { createTeacherSchema } from '@/lib/schemas';
import { checkIpRateLimit, clientIp } from '@/lib/rate-limit';

export const POST = withErrorHandler(async (request: NextRequest) => {
  // Unauthenticated endpoint: throttle per IP so it cannot be used to
  // mass-create accounts or squat email addresses in bulk. There is no
  // per-email backstop here — an unclaimed email is exactly what a legitimate
  // signup submits — so this IP check is this route's only defense; see
  // checkIpRateLimit for what happens when the IP can't be resolved.
  // (Email-ownership verification at signup is tracked as follow-up work.)
  const ip = clientIp(request);
  const ipCheck = checkIpRateLimit('teacher-signup', ip, 3, 60 * 60 * 1000, 'teachers');
  if (!ipCheck.allowed) {
    return respondError('Too many signup attempts. Try again later.', 429);
  }

  const parsed = await parseBody(request, createTeacherSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, email, bio, pageSlug } = parsed.data;

  // Any existing account blocks unauthenticated signup — attaching a
  // teacher profile to someone's account requires their session, and a
  // silent shadowing teacher used to lock students out of their bookings.
  // Known edge: an UNCLAIMED CRM student's email has no account and passes
  // this check; the new teacher account then shadows the claim path for
  // that row. Resolving that needs the email-ownership verification this
  // route already tracks as follow-up work.
  const existingAccount = await prisma.account.findUnique({ where: { email } });
  if (existingAccount) {
    return respondError('Email already in use', 409, 'EMAIL_TAKEN');
  }

  const existingSlug = await prisma.teacher.findUnique({ where: { pageSlug } });
  if (existingSlug) {
    return respondError('Page slug already in use', 409, 'SLUG_TAKEN');
  }

  // Both pre-checks above are plain reads, so a concurrent signup passes them
  // and loses here. Answering with the pre-check's own code is what keeps the
  // two paths indistinguishable — and it matters more here than elsewhere:
  // the settings form renders an inline error against the offending field, so
  // a code-less 409 says something is taken without saying which (#161).
  //
  // Three keys are reachable. `Account.email` and `Teacher.email` both report
  // `['email']` and are deliberately not told apart: they mean the same thing
  // to the caller, and the `Account` model's header comment records that they
  // cannot disagree — the profile email is a denormalized copy set at link
  // time and there is no email-change flow. `Teacher.accountId` cannot
  // collide; the nested create mints a fresh account.
  try {
    const teacher = await prisma.teacher.create({
      data: {
        firstName,
        lastName,
        email,
        bio,
        pageSlug,
        defaultCurrency: 'EUR',
        defaultTimezone: 'Europe/Amsterdam',
        account: { create: { email } },
      },
    });
    return respondOk(teacher, 201);
  } catch (err) {
    if (isUniqueConflictOn(err, ['email'])) {
      return respondError('Email already in use', 409, 'EMAIL_TAKEN');
    }
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      return respondError('Page slug already in use', 409, 'SLUG_TAKEN');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with a
    // code-less 409, which is the defect this catch exists to remove.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // `error`, not `warn` as in api-errors.ts's generic P2002 fallback:
      // this route's census of reachable unique keys is exhaustive, so an
      // unrecognised P2002 here means schema drift or a bug, not an
      // ordinary lost race.
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher signup hit a unique constraint that is neither the email nor the slug key',
      );
      throw new Error('teacher signup: unrecognised unique constraint');
    }
    throw err;
  }
});
