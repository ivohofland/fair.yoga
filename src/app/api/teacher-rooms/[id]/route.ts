import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { updateTeacherRoomSchema } from '@/lib/schemas';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id } });
  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  await prisma.teacherRoom.delete({ where: { id } });

  return respondOk({ deleted: true });
}
