import { NextRequest } from 'next/server';
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
import { updateTeacherRoomSchema, archiveStateQuerySchema } from '@/lib/schemas';
import { setTeacherRoomArchived, describeRoomBlockers } from '@/services/room-archive';
import {
  countTeacherRoomDeleteBlockers,
  isRoomDeleteBlocked,
  ROOM_DELETE_BLOCKED_MESSAGE,
  ROOM_IN_USE_CODE,
  ROOM_IN_USE_RACE_CODE,
} from '@/services/room-deletion';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({
    where: { id },
    include: { room: true },
  });

  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  return respondOk(teacherRoom);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id } });
  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, updateTeacherRoomSchema);
  if ('error' in parsed) return parsed.error;
  const updateData = parsed.data;

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const updated = await prisma.teacherRoom.update({
    where: { id },
    data: updateData,
  });

  return respondOk(updated);
});

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = archiveStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of archived or unarchived is required', 400);
  }

  const result = await setTeacherRoomArchived(
    prisma, id, session.teacherId, parsed.data.state,
  );

  if (result.ok) {
    // A `switch` with a `never` default rather than one `if`, because the
    // `never` guard at the bottom of this handler closes only the `ok: false`
    // half of the union. Proved at PR review: adding a fourth `ok: true` arm
    // with its own payload compiled clean, exit 0, and was answered 200 with
    // that payload silently dropped — while deleting an `ok: false` arm did
    // error. `class-templates/[id]/route.ts:163-170` records the same failure
    // class and closes both halves; this handler cited that discipline while
    // implementing half of it.
    switch (result.action) {
      case 'archived':
      case 'unarchived':
      case 'unchanged':
        return respondOk({ isArchived: result.isArchived, action: result.action });
      default: {
        const unhandledSuccess: never = result.action;
        return unhandledSuccess;
      }
    }
  }

  if (result.reason === 'not_found') return respondError('Teacher-room not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'in_use') {
    // 409, matching the sibling DELETE below: a conflict with current state,
    // not a malformed request.
    return respondError(describeRoomBlockers(result.blockers), 409, 'ROOM_IN_USE');
  }

  // Exhaustiveness for the `ok: false` half: a new ArchiveRoomResult reason
  // becomes a compile error here rather than being silently answered with the
  // wrong status. The `ok: true` half is closed separately, above — this guard
  // structurally cannot see it, which is the gap the switch exists to fill.
  const unhandled: never = result;
  return unhandled;
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id } });
  if (!teacherRoom) return respondError('Teacher-room not found', 404);

  if (teacherRoom.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // Both blockers in one read. `Class` was already guarded; `ClassTemplate`
  // was not, and a room referenced only by a template answered a raw P2003 as
  // a 500 (issue 103).
  const blockers = await countTeacherRoomDeleteBlockers(prisma, id);
  if (blockers.classes > 0 || blockers.templates > 0) {
    log.info(
      { teacherRoomId: id, teacherId: session.teacherId, blockers },
      'room delete refused: the room is still in use',
    );
    return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_CODE);
  }

  // THE CHECK ABOVE IS NOT REDUNDANT WITH THE CATCH BELOW, AND REMOVING IT
  // REOPENS A DEADLOCK — with every test in this repo still green.
  //
  // `DELETE FROM "TeacherRoom"` locks the row, then the RESTRICT triggers take
  // `FOR KEY SHARE` on referencing `ClassTemplate` rows. The generator sweep
  // holds `FOR UPDATE` on a template (`claimTemplateForGeneration`) while its
  // `Class` insert needs `FOR KEY SHARE` on this `TeacherRoom` — a genuine
  // AB-BA cycle, `40P01`. The catch runs AFTER the DELETE has taken its locks,
  // so it cannot prevent the cycle; only never issuing the statement can, and
  // that is what this check does. `docs/lock-order.md` carries the full edge.
  try {
    await prisma.teacherRoom.delete({ where: { id } });
  } catch (err) {
    // A template OR a class created in the gap — both foreign keys land here,
    // so do not narrow this comment to templates and then narrow the list to
    // match it. Same answer as the check, rather than the 500 a bare P2003
    // falls through to.
    if (isRoomDeleteBlocked(err)) {
      // `warn`, not the `info` the pre-check uses, and NOT optional: reaching
      // here means the pre-check did NOT stop this delete. Either we lost the
      // race, or the pre-check's predicate has drifted from the foreign key's
      // — and the second is otherwise completely silent, because this branch
      // answers with the same status, body and code the pre-check does. It is
      // also the branch that reopens the deadlock edge above.
      // `err` under that key deliberately: `log.ts` asks for it so pino
      // serializes the stack, the sibling catch at `invitations/[id]:88` does
      // the same, and WHICH constraint fired is what separates the two causes
      // this message names — ClassTemplate_ means a template appeared in the
      // gap, Class_ means a class did. Without it the line poses the question
      // and drops the answer.
      log.warn(
        { err, teacherRoomId: id, teacherId: session.teacherId },
        'room delete refused by the FK backstop: the pre-check said it was clear',
      );
      return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, ROOM_IN_USE_RACE_CODE);
    }
    throw err;
  }

  return respondOk({ deleted: true });
});
