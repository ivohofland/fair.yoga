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
    return respondError('Shared rooms cannot be deleted', 403);
  }

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can delete this room', 403);
  }

  const hasClasses = room.teacherRooms.some((tr) => tr._count.classes > 0);
  if (hasClasses) {
    // Matches the sibling refusal in `teacher-rooms/[id]:141` in both status
    // and wording. The 400 this replaces implied a clearable condition and
    // named no way out; a room with class history is permanently undeletable
    // BY DESIGN — archiving is the end state (issue 76), and hard deletion is
    // reserved for rooms that were never used. 409, because it is a conflict
    // with current state rather than a malformed request.
    return respondError('Cannot delete a room with class history. Archive it instead.', 409);
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
    return respondError('Shared rooms cannot be edited', 403);
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

  // `room.isPublic` is `false` here unconditionally — the guard above refused
  // a currently-shared room — and `updateRoomSchema` no longer accepts
  // `isPublic` at all (#73), so this write cannot change it. The row is
  // private going in and private coming out, which leaves exactly one index
  // it can collide on: `Room_private_identity_unique`.
  //
  // `Room_public_identity_unique` was reachable here until #73, because the
  // same PUT that edited an address could flip the room shared. That flip now
  // lives in `POST /api/rooms/[id]/publish`, and the public-shape catch went
  // with it — the catch follows the capability.
  //
  // THE GUARDS ABOVE ARE REPEATED IN THIS WRITE'S `where`, AND THAT IS NOT
  // BELT-AND-BRACES — it closes a race #73 itself opened. The guards ran
  // against a row read at :75; `POST /api/rooms/[id]/publish` can commit
  // `isPublic: true` between that read and this write. It needs no second
  // device: the room detail page renders `EditRoomForm` and `ShareRoomButton`
  // on the same screen. Without the predicate here, the edit lands on a
  // now-shared row and answers 200 — silently falsifying the notice the
  // teacher just accepted, for every other teacher using that room.
  //
  // `count` rather than the row, so the same statement both guards and
  // writes. Following `updateClass` (src/services/class-lifecycle.ts:1193).
  let result: Prisma.BatchPayload;
  try {
    result = await prisma.room.updateMany({
      where: { id, isPublic: false, createdById: session.teacherId },
      data: updateData,
    });
  } catch (err) {
    if (isUniqueConflictOn(err, ['createdById', 'address', 'floor', 'roomName'])) {
      return respondError(
        // `floor`/`roomName` both default to `""` and are optional free-text,
        // so two genuinely different private rooms at one address, both left
        // blank, collide here too — names the way out, not just the collision.
        'You already have a room at this address. Add a floor or room name to tell them apart.',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }

  if (result.count === 0) {
    // Find out which of the three predicates stopped it rather than asserting
    // one — #72 was exactly this branch naming a cause it had not checked.
    // Reaching here means the row changed under us, since all three held at
    // :75-84.
    const current = await prisma.room.findUnique({
      where: { id },
      select: { isPublic: true, createdById: true },
    });
    if (!current) return respondError('Room not found', 404);
    if (current.isPublic) {
      return respondError('This room has just been shared and can no longer be edited', 409, 'NOW_SHARED');
    }
    return respondError('Only the room creator can update this room', 403);
  }

  const updated = await prisma.room.findUnique({ where: { id } });
  if (!updated) return respondError('Room not found', 404);
  return respondOk(updated);
});
