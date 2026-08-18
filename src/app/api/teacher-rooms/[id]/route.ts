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
import { updateTeacherRoomSchema, archiveStateQuerySchema } from '@/lib/schemas';
import { setTeacherRoomArchived, describeRoomBlockers } from '@/services/room-archive';

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

  if (teacherRoom.teacherId !== session.teacherId) {
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

  if (teacherRoom.teacherId !== session.teacherId) {
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

  const parsed = archiveStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of archived or unarchived is required', 400);
  }

  const result = await setTeacherRoomArchived(
    prisma, id, session.teacherId, parsed.data.state,
  );

  if (result.ok) {
    return respondOk({ isArchived: result.isArchived, action: result.action });
  }

  if (result.reason === 'not_found') return respondError('Teacher-room not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'in_use') {
    // 409, matching the sibling DELETE below: a conflict with current state,
    // not a malformed request.
    return respondError(describeRoomBlockers(result.blockers), 409, 'ROOM_IN_USE');
  }

  // Exhaustiveness: a new ArchiveRoomResult reason becomes a compile error
  // here rather than being silently answered with the wrong status. Same
  // discipline as `class-templates/[id]/route.ts`.
  const unhandled: never = result;
  return unhandled;
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

  if (teacherRoom.teacherId !== session.teacherId) {
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
