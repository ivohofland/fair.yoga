import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { completeClass } from '@/services/class-lifecycle';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

  // `finishedEarly`: this endpoint IS the teacher ending a class early, which
  // is why it does not pass a clock to check against.
  const result = await completeClass(prisma, id, { finishedEarly: true });
  if (!result.ok) return respondError(result.error, 409);

  return respondOk(result);
});
