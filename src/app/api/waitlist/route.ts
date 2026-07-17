import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { addToWaitlist } from '@/services/waitlist';
import { createWaitlistSchema } from '@/lib/schemas';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createWaitlistSchema);
  if ('error' in parsed) return parsed.error;

  const entry = await addToWaitlist(prisma, parsed.data.classId, session.userId);
  return respondOk(entry, 201);
});
