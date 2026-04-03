import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody } from '@/lib/api-utils';
import { createTeacherSchema } from '@/lib/schemas';

export async function POST(request: NextRequest) {
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
