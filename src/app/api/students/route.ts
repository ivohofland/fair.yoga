import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { respondOk, respondError, parseBody } from '@/lib/api-utils';

interface CreateStudentBody {
  firstName: string;
  lastName: string;
  email: string;
  incomeTier?: number;
}

export async function POST(request: NextRequest) {
  const body = await parseBody<CreateStudentBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const { firstName, lastName, email, incomeTier } = body;

  if (!firstName || !lastName || !email) {
    return respondError('Missing required fields: firstName, lastName, email', 400);
  }

  const tier = incomeTier ?? 3;
  if (tier < 1 || tier > 5 || !Number.isInteger(tier)) {
    return respondError('Income tier must be an integer between 1 and 5', 400);
  }

  const existing = await prisma.student.findUnique({ where: { email } });
  if (existing) {
    return respondError('Email already in use', 409, 'EMAIL_TAKEN');
  }

  const student = await prisma.student.create({
    data: {
      firstName,
      lastName,
      email,
      incomeTier: tier,
    },
  });

  return respondOk(student, 201);
}
