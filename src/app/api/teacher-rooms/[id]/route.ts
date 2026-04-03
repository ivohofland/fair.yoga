import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  pick,
} from '@/lib/api-utils';

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

const TEACHER_ROOM_ALLOWED_FIELDS = [
  'capacityOverride',
  'rentalRate',
  'equipmentNotes',
] as const;

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

  const body = await parseBody<Record<string, unknown>>(request);
  if (!body) return respondError('Invalid request body', 400);

  const updateData = pick(body, TEACHER_ROOM_ALLOWED_FIELDS);

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
