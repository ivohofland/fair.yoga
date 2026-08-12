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
import { updateClassSchema } from '@/lib/schemas';
import { updateClass, type ClassUpdateData } from '@/services/class-lifecycle';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      _count: { select: { registrations: true } },
    },
  });

  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

  return respondOk(cls);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

  const parsed = await parseBody(request, updateClassSchema);
  if ('error' in parsed) return parsed.error;
  // The schema validates date as a YYYY-MM-DD string; Prisma needs a Date
  // (UTC midnight, same as class creation). Latent until the edit UI —
  // nothing ever PUT a date before.
  const { date: dateString, ...rest } = parsed.data;
  const data: ClassUpdateData = {
    ...rest,
    ...(dateString !== undefined ? { date: new Date(dateString) } : {}),
  };

  const result = await updateClass(prisma, id, data);
  if (result.ok) return respondOk(result.cls);

  // Narrowed one reason at a time so the `locked` branch below can read
  // `result.fields` without a cast.
  if (result.reason === 'not_found') return respondError('Class not found', 404);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  if (result.reason === 'locked') {
    return respondError(
      `Cannot update economic fields when settings are locked: ${result.fields.join(', ')}`,
      409,
    );
  }
  // A reschedule (date/startTime) landed on a slot this teacher already
  // occupies with another live class (#196) — the same clash a `POST` into
  // that slot reports, reached here by a move instead of a create.
  if (result.reason === 'slot_conflict') {
    return respondError(
      'You already have a class at that date and time.',
      409,
      'DUPLICATE_CLASS_SLOT',
    );
  }
  // Exhaustiveness: a new UpdateClassResult variant becomes a compile error
  // here rather than being silently answered as though it were `locked`.
  const unhandled: never = result;
  return unhandled;
});
