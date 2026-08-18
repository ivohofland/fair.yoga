import { NextRequest } from 'next/server';
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
 * Sharing a room — the only write in the app that can set `isPublic: true`.
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
 * src/app/api/rooms/route.ts:60-68: a `findFirst` guard in front would only
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

  try {
    const updated = await prisma.room.update({
      where: { id },
      data: { isPublic: true },
    });
    return respondOk(updated);
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
});
