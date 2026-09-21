import { NextRequest, type NextResponse } from 'next/server';
import { Prisma, type TeacherRoom } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondUnchanged,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
import { createTeacherRoomSchema } from '@/lib/schemas';
import { compareExistingLink, type RequestedLinkValues } from '@/services/teacher-room-attach';

/**
 * The answer to an attach request that finds the teacher's link to this room
 * already there, whether at the pre-check or at a create that lost to a twin.
 */
function answerExistingLink(existing: TeacherRoom, requested: RequestedLinkValues): NextResponse {
  const verdict = compareExistingLink(existing, requested);
  switch (verdict) {
    case 'archived':
      return respondError(
        'This room is in your archived rooms. Unarchive it to use it again.',
        409,
        'ROOM_ARCHIVED',
      );
    case 'unchanged':
      return respondUnchanged<TeacherRoom>(existing);
    case 'differs':
      return respondError(
        'This room is already in your rooms. Edit it there to change its details.',
        409,
        'ROOM_ALREADY_LISTED',
      );
    default: {
      const unhandled: never = verdict;
      return unhandled;
    }
  }
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRooms = await prisma.teacherRoom.findMany({
    where: { teacherId: session.teacherId },
    include: { room: true },
    orderBy: { createdAt: 'desc' },
  });

  return respondOk(teacherRooms);
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createTeacherRoomSchema);
  if ('error' in parsed) return parsed.error;
  const { roomId, capacityOverride, rentalRate, equipmentNotes } = parsed.data;

  // A teacher may attach to a room that is public, or to one they created —
  // nothing else (#77). This is the same rule `GET /api/rooms/[id]` already
  // applies verbatim; this route simply never applied it, so any teacher could
  // attach to a private room whose id they knew. That mattered less for what it
  // exposed — `TeacherRoom` holds the teacher's OWN rate, so nothing of the
  // creator's leaked — than for what it enabled: adding a class through that
  // link permanently blocks the creator from deleting their own room, because
  // the delete guard in `rooms/[id]` is deliberately cross-teacher.
  //
  // Fetching the room is also what turns an unknown id into a 404 rather than a
  // foreign-key violation surfacing as a 500.
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { isPublic: true, createdById: true },
  });
  if (!room) return respondError('This room no longer exists.', 404, 'NOT_FOUND');

  if (!room.isPublic && room.createdById !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // After the room gates above, so an unchanged answer is never given for a
  // room this teacher may not attach to.
  const linkKey = { teacherId_roomId: { teacherId: session.teacherId, roomId } };
  const existing = await prisma.teacherRoom.findUnique({ where: linkKey });
  if (existing) return answerExistingLink(existing, parsed.data);

  // The pre-check above is a plain read, so a concurrent attach to the same
  // (teacher, room) passes it and one of the two loses here. The loser
  // re-reads the link that won and answers as the pre-check would have for
  // it, so a client cannot tell the two paths apart (#161).
  //
  // Matched on the column set rather than on `P2002` alone. `TeacherRoom`
  // also declares `@@unique([id, isArchived])`, which this create cannot
  // collide on — `id` is a fresh uuid — but a bare code check would swallow
  // that key and any key added later under reasoning established only for
  // this one.
  try {
    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId: session.teacherId,
        roomId,
        capacityOverride,
        rentalRate,
        equipmentNotes: equipmentNotes ?? undefined,
      },
    });
    return respondOk(teacherRoom, 201);
  } catch (err) {
    if (isUniqueConflictOn(err, ['teacherId', 'roomId'])) {
      // The unique violation is raised only once the winner has committed, so
      // this read sees it.
      const winner = await prisma.teacherRoom.findUnique({ where: linkKey });
      if (winner) return answerExistingLink(winner, parsed.data);
      // The winner was removed again before this read. No link exists, and a
      // retry can create one.
      return respondError('The system was busy and could not finish that. Please try again.', 503);
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with the
    // code-less 409 this catch exists to remove, so rethrowing would deliver
    // the same defect through the other door.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // `error`, not `warn` as in api-errors.ts's generic P2002 fallback:
      // this route's census of reachable unique keys is exhaustive, so an
      // unrecognised P2002 here means schema drift or a bug, not an
      // ordinary lost race.
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher-room create hit a unique constraint that is not the link key',
      );
      throw new Error('teacher-room create: unrecognised unique constraint');
    }
    throw err;
  }
});
