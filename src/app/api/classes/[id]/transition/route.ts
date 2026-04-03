import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { transitionClass } from '@/services/class-lifecycle';
import type { ClassStatus } from '@prisma/client';

interface TransitionBody {
  status: ClassStatus;
}

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.userId) return respondError('Not your class', 403);

  const body = await parseBody<TransitionBody>(request);
  if (!body?.status) return respondError('Missing status field', 400);

  const result = await transitionClass(prisma, id, body.status);
  if (!result.ok) return respondError(result.error, 409);

  return respondOk(result);
});
