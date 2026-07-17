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
import { createRoomSchema, roomSearchQuerySchema } from '@/lib/schemas';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = roomSearchQuerySchema.safeParse(params);
  if (!parsed.success) {
    return respondError('Invalid query parameters', 400);
  }
  const { postcode, street } = parsed.data;

  // When both postcode and street provided, search public rooms
  if (postcode && street) {
    const normalized = postcode.replace(/\s/g, '');
    const rooms = await prisma.room.findMany({
      where: {
        isPublic: true,
        postcode: { contains: normalized, mode: 'insensitive' },
        address: { contains: street, mode: 'insensitive' },
      },
      orderBy: { createdAt: 'desc' },
    });
    return respondOk(rooms);
  }

  // Default: all public rooms + teacher's private rooms
  const rooms = await prisma.room.findMany({
    where: {
      OR: [{ isPublic: true }, { createdById: session.userId }],
    },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(rooms);
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createRoomSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  const isPublic = body.isPublic ?? true;

  // Only check duplicates against public rooms
  if (isPublic) {
    const existing = await prisma.room.findFirst({
      where: {
        isPublic: true,
        address: body.address,
        floor: body.floor,
        roomName: body.roomName,
      },
    });
    if (existing) {
      return respondError('A public room at this address already exists', 409, 'DUPLICATE_ROOM');
    }
  }

  const room = await prisma.room.create({
    data: {
      venueName: body.venueName,
      address: body.address,
      city: body.city,
      postcode: body.postcode.replace(/\s/g, ''),
      floor: body.floor,
      roomName: body.roomName,
      maxCapacity: body.maxCapacity,
      equipment: body.equipment,
      notes: body.notes,
      isPublic,
      createdById: session.userId,
    },
  });

  return respondOk(room, 201);
});
