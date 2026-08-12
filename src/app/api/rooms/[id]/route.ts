import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateRoomSchema } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({
    where: { id },
    include: { teacherRooms: { include: { _count: { select: { classes: true } } } } },
  });
  if (!room) return respondError('Room not found', 404);

  if (room.isPublic) {
    return respondError('Public rooms cannot be deleted', 403);
  }

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can delete this room', 403);
  }

  const hasClasses = room.teacherRooms.some((tr) => tr._count.classes > 0);
  if (hasClasses) {
    return respondError('Cannot delete a room that has classes', 400);
  }

  // Delete teacher-rooms first, then the room
  await prisma.teacherRoom.deleteMany({ where: { roomId: id } });
  await prisma.room.delete({ where: { id } });

  return respondOk({ deleted: true });
});

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);

  if (!room.isPublic && room.createdById !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  return respondOk(room);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);

  if (room.isPublic) {
    return respondError('Public rooms cannot be edited', 403);
  }

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can update this room', 403);
  }

  const parsed = await parseBody(request, updateRoomSchema);
  if ('error' in parsed) return parsed.error;
  const { equipment, ...rest } = parsed.data;

  const updateData: Record<string, unknown> = { ...rest };
  if (equipment !== undefined) {
    updateData.equipment = equipment as Prisma.InputJsonValue;
  }

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  // `room.isPublic` is `false` here unconditionally — the guard above already
  // refused a currently-public room — but `updateRoomSchema` still accepts
  // `isPublic`, so this PUT can flip a private room to public in the very
  // write that also edits its address/floor/roomName. That means either
  // identity index can be the one this write collides with (#196):
  // `Room_private_identity_unique` if it stays private,
  // `Room_public_identity_unique` if `isPublic: true` rides along — the same
  // two-shape catch `POST /api/rooms` already carries, for the same reason.
  try {
    const updated = await prisma.room.update({
      where: { id },
      data: updateData,
    });
    return respondOk(updated);
  } catch (err) {
    if (
      isUniqueConflictOn(err, ['address', 'floor', 'roomName']) ||
      isUniqueConflictOn(err, ['createdById', 'address', 'floor', 'roomName'])
    ) {
      return respondError(
        parsed.data.isPublic === true
          ? 'A public room at this address already exists'
          : 'You already have a room at this address',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }
});
