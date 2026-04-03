import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody } from '@/lib/api-utils';

interface CreateTeacherBody {
  firstName: string;
  lastName: string;
  email: string;
  bio: string;
  pageSlug: string;
}

export async function POST(request: NextRequest) {
  const body = await parseBody<CreateTeacherBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const { firstName, lastName, email, bio, pageSlug } = body;

  if (!firstName || !lastName || !email || !bio || !pageSlug) {
    return respondError('Missing required fields: firstName, lastName, email, bio, pageSlug', 400);
  }

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
