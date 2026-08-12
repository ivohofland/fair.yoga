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
import { isUniqueConflictOn } from '@/lib/unique-conflict';

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
      OR: [{ isPublic: true }, { createdById: session.teacherId }],
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

  // No pre-check here on purpose. `Room` has exactly two unique indexes —
  // `Room_public_identity_unique` and `Room_private_identity_unique` — and
  // the catch below matches both column shapes, so no `P2002` this create
  // can raise ever reaches the generic fallback in `withErrorHandler`
  // (`classifyApiError`'s `warn`, src/lib/api-errors.ts). A `findFirst`
  // guard in front would only make the catch reachable under a race — and
  // untestable except by one, since a sequential duplicate would never get
  // that far.
  try {
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
        createdById: session.teacherId,
      },
    });
    return respondOk(room, 201);
  } catch (err) {
    // Two indexes, two shapes: public rooms are unique across the whole
    // shared namespace, private rooms only within their creator.
    if (
      isUniqueConflictOn(err, ['address', 'floor', 'roomName']) ||
      isUniqueConflictOn(err, ['createdById', 'address', 'floor', 'roomName'])
    ) {
      return respondError(
        isPublic
          ? 'A public room at this address already exists'
          : 'You already have a room at this address',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }
});
