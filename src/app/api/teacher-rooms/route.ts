import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';

interface CreateTeacherRoomBody {
  roomId: string;
  capacityOverride: number;
  rentalRate: number;
  equipmentNotes?: string;
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const body = await parseBody<CreateTeacherRoomBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const { roomId, capacityOverride, rentalRate } = body;

  if (!roomId || capacityOverride === undefined || rentalRate === undefined) {
    return respondError('Missing required fields: roomId, capacityOverride, rentalRate', 400);
  }

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
      equipmentNotes: body.equipmentNotes,
    },
  });

  return respondOk(teacherRoom, 201);
}
