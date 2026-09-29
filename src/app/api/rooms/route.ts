import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondTyped,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createRoomSchema, roomSearchQuerySchema } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import type { RoomResult } from '@/lib/room-search';

/**
 * The columns the shared-room search returns: exactly `RoomResult`'s keys.
 *
 * `satisfies Record<keyof RoomResult, true>` refuses a key `RoomResult` does
 * not name, and that is what keeps other teachers' `createdById`, `notes` and
 * timestamps out of the browser. `respondTyped<RoomResult[]>` below cannot:
 * the query result is not a fresh literal, so it gets no excess-property
 * check; what it adds is refusing a column whose type no longer matches
 * `RoomResult`. Pass this object to `select` as is — spreading extra
 * columns in beside it at the call site escapes both.
 */
const ROOM_SEARCH_SELECT = {
  id: true,
  venueName: true,
  roomName: true,
  address: true,
  city: true,
  postcode: true,
  floor: true,
  maxCapacity: true,
} satisfies Record<keyof RoomResult, true>;

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
      select: ROOM_SEARCH_SELECT,
    });
    return respondTyped<RoomResult[]>(rooms);
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

  // No pre-check here on purpose. `Room` has exactly two identity indexes —
  // `Room_public_identity_unique` and `Room_private_identity_unique` (plus
  // `Room_pkey` on `id`, which this create cannot collide on) — and
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
        isPublic: body.isPublic,
        createdById: session.teacherId,
      },
    });
    return respondTyped<RoomResult>(room, 201);
  } catch (err) {
    // Two indexes, two shapes: public rooms are unique across the whole
    // shared namespace, private rooms only within their creator.
    if (
      isUniqueConflictOn(err, ['address', 'floor', 'roomName']) ||
      isUniqueConflictOn(err, ['createdById', 'address', 'floor', 'roomName'])
    ) {
      return respondError(
        body.isPublic
          ? 'A shared room at this address already exists'
          // `floor`/`roomName` both default to `""` and are optional
          // free-text, so two genuinely different private rooms at one
          // address, both left blank, collide here too — names the way out,
          // not just the collision.
          : 'You already have a room at this address. Add a floor or room name to tell them apart.',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }
});
