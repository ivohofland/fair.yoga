import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
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
});
