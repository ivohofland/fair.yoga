import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
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
import {
  countRoomDeleteBlockers,
  isRoomDeleteBlocked,
  ROOM_DELETE_BLOCKED_MESSAGE,
  ROOM_IN_USE_CODE,
  ROOM_IN_USE_RACE_CODE,
} from '@/services/room-deletion';

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);

  if (room.isPublic) {
    return respondError('Shared rooms cannot be deleted', 403);
  }

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can delete this room', 403);
  }

  // Across every link on the room, since the delete takes them all. The 400
  // this replaced implied a clearable condition and named no way out; a room
  // with class history is permanently undeletable BY DESIGN — archiving is the
  // end state (issue 76). A template blocker is equally permanent, because a
  // ClassTemplate is never hard-deleted (issue 103), which is why one message
  // serves both. 409, a conflict with current state rather than a malformed
  // request.
  const blockers = await countRoomDeleteBlockers(prisma, id);
  if (blockers.classes > 0 || blockers.templates > 0) {
    log.info(
      { roomId: id, teacherId: session.teacherId, blockers },
      'room delete refused: the room is still in use',
    );
    return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_CODE);
  }

  // ONE TRANSACTION, not two statements. Un-transacted, a failure between them
  // leaves the teacher's TeacherRoom rows — and the private rentalRate
  // CLAUDE.md says is "never shared between teachers" — deleted with the room
  // still standing.
  //
  // TWO REDUNDANCIES LIVE IN THIS BLOCK AND THEY POINT OPPOSITE WAYS. Read
  // both before deleting either.
  //
  // 1. The `deleteMany` IS redundant and may go. `TeacherRoom_roomId_fkey` is
  //    ON DELETE CASCADE (`20260403092044_init/migration.sql:333`), so the
  //    room delete alone takes every link. It stays as an explicit statement
  //    of what the delete removes, and the transaction is what makes keeping
  //    it free.
  //
  //    IF YOU DO REMOVE IT, the P2003 this handler catches changes shape.
  //    Today the `deleteMany` refuses first and reports
  //    `modelName: "TeacherRoom"`; without it, `room.delete` refuses through
  //    the CASCADE and reports `modelName: "Room"` (both measured, both
  //    pinned in `room-deletion.test.ts`). `isRoomDeleteBlocked` reads only
  //    `meta.constraint`, so the edit is safe — but a matcher narrowed to the
  //    model would pass every test today and 500 this route afterwards.
  //
  // 2. THE CHECK ABOVE IS NOT REDUNDANT WITH THE CATCH BELOW, AND REMOVING IT
  //    REOPENS A DEADLOCK. The RESTRICT triggers take `FOR KEY SHARE` on
  //    referencing ClassTemplate rows, which cycles against the generator
  //    sweep's `FOR UPDATE` on a template plus its `Class` insert's
  //    `FOR KEY SHARE` on this room's links. The catch runs after those locks
  //    are taken; only not issuing the DELETE avoids the cycle.
  //    `docs/lock-order.md` carries the edge.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.teacherRoom.deleteMany({ where: { roomId: id } });
      await tx.room.delete({ where: { id } });
    });
  } catch (err) {
    // A template OR a class created in the gap — both foreign keys land here.
    if (isRoomDeleteBlocked(err)) {
      // `warn`, not the pre-check's `info`. See the twin in
      // `teacher-rooms/[id]`: reaching here means the pre-check did not stop
      // this delete, and a drifted pre-check is otherwise silent because this
      // branch answers identically.
      // `err` under that key deliberately: `log.ts` asks for it so pino
      // serializes the stack, the sibling catch at `invitations/[id]:88` does
      // the same, and WHICH constraint fired is what separates the two causes
      // this message names — ClassTemplate_ means a template appeared in the
      // gap, Class_ means a class did. Without it the line poses the question
      // and drops the answer.
      log.warn(
        { err, roomId: id, teacherId: session.teacherId },
        'room delete refused by the FK backstop: the pre-check said it was clear',
      );
      return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_RACE_CODE);
    }
    throw err;
  }

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
  // against a row read at :135; `POST /api/rooms/[id]/publish` can commit
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
    // :135-144.
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
