import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody } from '@/lib/api-utils';
import { createTeacherSchema } from '@/lib/schemas';
import { checkRateLimit, clientIp } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  // Unauthenticated endpoint: throttle per IP so it cannot be used to
  // mass-create accounts or squat email addresses in bulk. Only applies
  // when a proxy forwarded a real address — see magic-link/send.
  // (Email-ownership verification at signup is tracked as follow-up work.)
  const ip = clientIp(request);
  if (ip !== 'unknown') {
    const ipCheck = checkRateLimit(`teacher-signup:${ip}`, 3, 60 * 60 * 1000);
    if (!ipCheck.allowed) {
      return respondError('Too many signup attempts. Try again later.', 429);
    }
  }

  const parsed = await parseBody(request, createTeacherSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, email, bio, pageSlug } = parsed.data;

  const existingEmail = await prisma.teacher.findUnique({ where: { email } });
  if (existingEmail) {
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
    },
  });

  return respondOk(teacher, 201);
}
