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

interface CreateRoomBody {
  venueName: string;
  address: string;
  city: string;
  postcode: string;
  floor: string;
  roomName: string;
  maxCapacity: number;
  equipment?: Prisma.InputJsonValue;
  notes?: string;
  isPublic?: boolean;
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const body = await parseBody<CreateRoomBody>(request);
  if (!body) return respondError('Invalid request body', 400);

  const { venueName, address, city, postcode, floor, roomName, maxCapacity } = body;

  if (!venueName || !address || !city || !postcode || !floor || !roomName || !maxCapacity) {
    return respondError(
      'Missing required fields: venueName, address, city, postcode, floor, roomName, maxCapacity',
      400,
    );
  }

  const room = await prisma.room.create({
    data: {
      venueName,
      address,
      city,
      postcode,
      floor,
      roomName,
      maxCapacity,
      equipment: body.equipment ?? Prisma.JsonNull,
      notes: body.notes,
      isPublic: body.isPublic ?? true,
      createdById: session.userId,
    },
  });

  return respondOk(room, 201);
}
