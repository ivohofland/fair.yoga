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
import { updateTeacherRoomSchema } from '@/lib/schemas';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({
    where: { id },
    include: { room: true },
  });

  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  return respondOk(teacherRoom);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id } });
  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, updateTeacherRoomSchema);
  if ('error' in parsed) return parsed.error;
  const updateData = parsed.data;

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const updated = await prisma.teacherRoom.update({
    where: { id },
    data: updateData,
  });

  return respondOk(updated);
});

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id } });
  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  const updated = await prisma.teacherRoom.update({
    where: { id },
    data: { isArchived: !teacherRoom.isArchived },
  });

  return respondOk({ isArchived: updated.isArchived });
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id } });
  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  // Only allow hard delete if no classes use this room
  const classCount = await prisma.class.count({ where: { teacherRoomId: id } });
  if (classCount > 0) {
    return respondError('Cannot delete a room with class history. Archive it instead.', 409);
  }

  await prisma.teacherRoom.delete({ where: { id } });

  return respondOk({ deleted: true });
});
