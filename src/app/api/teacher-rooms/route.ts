import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { createTeacherRoomSchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRooms = await prisma.teacherRoom.findMany({
    where: { teacherId: session.userId },
    include: { room: true },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(teacherRooms);
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createTeacherRoomSchema);
  if ('error' in parsed) return parsed.error;
  const { roomId, capacityOverride, rentalRate, equipmentNotes } = parsed.data;

  // Check for duplicate
  const existing = await prisma.teacherRoom.findUnique({
    where: {
      teacherId_roomId: {
        teacherId: session.userId,
        roomId,
      },
    },
  });

  if (existing) {
    return respondError('Teacher-room link already exists', 409, 'DUPLICATE');
  }

  const teacherRoom = await prisma.teacherRoom.create({
    data: {
      teacherId: session.userId,
      roomId,
      capacityOverride,
      rentalRate,
      equipmentNotes: equipmentNotes ?? undefined,
    },
  });

  return respondOk(teacherRoom, 201);
}
