import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { isUniqueConflictOn } from '@/lib/unique-conflict';

/**
 * Sharing a room — the only write that can flip an EXISTING room from
 * private to shared.
 *
 * Not the only write that can set `isPublic: true` at all: `POST /api/rooms`
 * still accepts the field, because whether a room is born shared is
 * legitimately the creator's call (`createRoomSchema`, and the checkbox in
 * `room-create-step.tsx`). A policy added to sharing — verified teachers
 * only, an audit trail, a rate limit — has to go on BOTH doors.
 *
 * `updateRoomSchema` deliberately does not accept the field, so a generic
 * field update cannot flip it as a side effect. That was #73: the flip was
 * reachable from `PUT /api/rooms/[id]`, and a shared room is read-only and
 * undeletable for everyone including its creator (#52/#60), so one careless
 * body permanently froze a teacher's own room.
 *
 * GUARD ORDER IS THE INVERSE OF PUT's AND DELETE's, ON PURPOSE. Those ask
 * `isPublic?` first: a shared room is community property regardless of who
 * asks, and the creator may have left the platform. This route asks
 * `createdById?` first: only the creator may donate a room to the commons.
 * Reordering these to "match" the neighbours would answer a non-creator's
 * request about an already-shared room with ALREADY_SHARED instead of
 * NOT_ROOM_CREATOR — pinned in tests/integration/rooms-publish-api.test.ts.
 *
 * No pre-check for the duplicate, for the reason `POST /api/rooms` states at
 * src/app/api/rooms/route.ts:86-94: a `findFirst` guard in front would only
 * make this catch reachable under a race, and untestable except by one.
 *
 * ONE index shape, not two. The row is private on the way in and shared on
 * the way out, so it can only ever collide on `Room_public_identity_unique`;
 * `Room_private_identity_unique` is the index it leaves.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404, 'NOT_FOUND');

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can share this room', 403, 'NOT_ROOM_CREATOR');
  }

  if (room.isPublic) {
    return respondError('This room is already shared', 409, 'ALREADY_SHARED');
  }

  // The three guards above are repeated in this write's `where`, closing the
  // window between the read at :53 and the write. `prisma.room.update` here
  // would raise P2025 if a concurrent `DELETE /api/rooms/[id]` removed the
  // row first — and `classifyApiError` has no P2025 branch, so losing that
  // race would answer 500 and page someone. `DeleteRoomButton` renders on the
  // same page as this control, so the race is single-user reachable.
  //
  // `count` rather than the row, so one statement both guards and writes —
  // following `updateClass` (src/services/class-lifecycle.ts:1132).
  let result: Prisma.BatchPayload;
  try {
    result = await prisma.room.updateMany({
      where: { id, isPublic: false, createdById: session.teacherId },
      data: { isPublic: true },
    });
  } catch (err) {
    if (isUniqueConflictOn(err, ['address', 'floor', 'roomName'])) {
      return respondError(
        'A shared room at this address already exists',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }

  if (result.count === 0) {
    // Check which predicate failed rather than naming one. The order here
    // mirrors the guards above — creator before shared — so a lost race
    // answers the same code the fast path would have.
    const current = await prisma.room.findUnique({
      where: { id },
      select: { isPublic: true, createdById: true },
    });
    if (!current) return respondError('Room not found', 404, 'NOT_FOUND');
    if (current.createdById !== session.teacherId) {
      return respondError('Only the room creator can share this room', 403, 'NOT_ROOM_CREATOR');
    }
    return respondError('This room is already shared', 409, 'ALREADY_SHARED');
  }

  const updated = await prisma.room.findUnique({ where: { id } });
  if (!updated) return respondError('Room not found', 404, 'NOT_FOUND');
  return respondOk(updated);
});
