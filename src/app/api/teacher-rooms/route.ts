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
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { log } from '@/lib/log';
import { createTeacherRoomSchema } from '@/lib/schemas';

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
  if (!room) return respondError('Room not found', 404);

  if (!room.isPublic && room.createdById !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // Check for duplicate
  const existing = await prisma.teacherRoom.findUnique({
    where: {
      teacherId_roomId: {
        teacherId: session.teacherId,
        roomId,
      },
    },
  });

  if (existing) {
    return respondError('Teacher-room link already exists', 409, 'DUPLICATE');
  }

  // The pre-check above is a plain read, so a concurrent attach to the same
  // (teacher, room) passes it and one of the two loses here. Answering with
  // the pre-check's own code keeps the two paths indistinguishable to a
  // client, which is the whole point: without it a race reaches
  // `withErrorHandler` and returns 409 with no `code` at all (#161).
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
      return respondError('Teacher-room link already exists', 409, 'DUPLICATE');
    }
    // Not rethrown as a P2002: `classifyApiError` answers any P2002 with the
    // code-less 409 this catch exists to remove, so rethrowing would deliver
    // the same defect through the other door. Same reasoning, same shape as
    // `auth/student-signup`'s catch.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      log.error(
        { err, rawTarget: err.meta?.target },
        'teacher-room create hit a unique constraint that is not the link key',
      );
      throw new Error('teacher-room create: unrecognised unique constraint');
    }
    throw err;
  }
});
