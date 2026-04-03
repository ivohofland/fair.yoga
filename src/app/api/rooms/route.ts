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
import { createRoomSchema } from '@/lib/schemas';

export async function GET(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const rooms = await prisma.room.findMany({
    where: {
      OR: [{ isPublic: true }, { createdById: session.userId }],
    },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(rooms);
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createRoomSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  const room = await prisma.room.create({
    data: {
      venueName: body.venueName,
      address: body.address,
      city: body.city,
      postcode: body.postcode,
      floor: body.floor,
      roomName: body.roomName,
      maxCapacity: body.maxCapacity,
      equipment: (body.equipment as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      notes: body.notes,
      isPublic: body.isPublic ?? true,
      createdById: session.userId,
    },
  });

  return respondOk(room, 201);
}
