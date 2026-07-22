import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { addToWaitlist, WaitlistJoinError } from '@/services/waitlist';
import { createWaitlistSchema } from '@/lib/schemas';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createWaitlistSchema);
  if ('error' in parsed) return parsed.error;

  const cls = await prisma.class.findUnique({
    where: { id: parsed.data.classId },
    select: { id: true },
  });
  if (!cls) return respondError('Class not found', 404);

  try {
    const entry = await addToWaitlist(prisma, parsed.data.classId, session.studentId);
    // Joining a waitlist implies tier choice (the route is self-only);
    // promotions and claims are covered transitively — nobody reaches
    // them without joining first. Null-guarded: first choice only.
    await prisma.student.updateMany({
      where: { id: session.studentId, tierSelectedAt: null },
      data: { tierSelectedAt: new Date() },
    });
    return respondOk(entry, 201);
  } catch (err) {
    if (err instanceof WaitlistJoinError) {
      return respondError(err.message, 409);
    }
    throw err;
  }
});
