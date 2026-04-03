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
import { transitionClassSchema } from '@/lib/schemas';

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

  const parsed = await parseBody(request, transitionClassSchema);
  if ('error' in parsed) return parsed.error;

  const result = await transitionClass(prisma, id, parsed.data.status);
  if (!result.ok) return respondError(result.error, 409);

  return respondOk(result);
});
