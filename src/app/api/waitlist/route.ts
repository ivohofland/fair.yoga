import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireStudent,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { addToWaitlist } from '@/services/waitlist';

interface WaitlistBody {
  classId: string;
}

export async function POST(request: NextRequest) {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const body = await parseBody<WaitlistBody>(request);
  if (!body?.classId) return respondError('Missing classId', 400);

  const entry = await addToWaitlist(prisma, body.classId, session.userId);
  return respondOk(entry, 201);
}
