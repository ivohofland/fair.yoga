import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { updateRoomSchema } from '@/lib/schemas';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);

  if (!room.isPublic && room.createdById !== session.userId) {
    return respondError('Access denied', 403);
  }

  return respondOk(room);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);

  if (room.createdById !== session.userId) {
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

  const updated = await prisma.room.update({
    where: { id },
    data: updateData,
  });

  return respondOk(updated);
}
