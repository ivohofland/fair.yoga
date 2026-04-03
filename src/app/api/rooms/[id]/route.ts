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

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);

  if (!room.isPublic && room.createdById !== session.userId) {
    return respondError('Access denied', 403);
  }

  return respondOk(room);
}

const ROOM_ALLOWED_FIELDS = [
  'venueName',
  'address',
  'city',
  'postcode',
  'floor',
  'roomName',
  'maxCapacity',
  'equipment',
  'notes',
  'isPublic',
] as const;

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

  const body = await parseBody<Record<string, unknown>>(request);
  if (!body) return respondError('Invalid request body', 400);

  const updateData = pick(body, ROOM_ALLOWED_FIELDS);

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const updated = await prisma.room.update({
    where: { id },
    data: updateData,
  });

  return respondOk(updated);
}
