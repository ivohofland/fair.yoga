import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody } from '@/lib/api-utils';
import { createStudentSchema } from '@/lib/schemas';

export async function POST(request: NextRequest) {
  const parsed = await parseBody(request, createStudentSchema);
  if ('error' in parsed) return parsed.error;
  const { firstName, lastName, email, incomeTier } = parsed.data;

  const existing = await prisma.student.findUnique({ where: { email } });
  if (existing) {
    return respondError('Email already in use', 409, 'EMAIL_TAKEN');
  }

  const student = await prisma.student.create({
    data: {
      firstName,
      lastName,
      email,
      incomeTier,
    },
  });

  return respondOk(student, 201);
}
