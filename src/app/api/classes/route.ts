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
import { createClassSchema } from '@/lib/schemas';
import { entryConflictMessage, probeConflictingEntry } from '@/lib/entry-conflict';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  // `teacherId` and `date` both scope through the entry now (#327). Typed
  // rather than `Record<string, unknown>`, which is what let the old shape
  // build a filter Prisma would silently ignore.
  const entryWhere: Prisma.CalendarEntryWhereInput = { teacherId: session.teacherId };
  if (from || to) {
    const dateFilter: Prisma.DateTimeFilter = {};
    if (from) {
      const fromDate = new Date(from);
      if (Number.isNaN(fromDate.getTime())) return respondError('Invalid "from" date', 400);
      dateFilter.gte = fromDate;
    }
    if (to) {
      const toDate = new Date(to);
      if (Number.isNaN(toDate.getTime())) return respondError('Invalid "to" date', 400);
      dateFilter.lte = toDate;
    }
    entryWhere.date = dateFilter;
  }

  const classes = await prisma.class.findMany({
    where: { calendarEntry: entryWhere },
    include: {
      calendarEntry: true,
      _count: { select: { registrations: true } },
    },
    orderBy: { calendarEntry: { date: 'asc' } },
  });

  // The wire shape is unchanged by #327: the entry's columns are flattened
  // back onto the class, so a client still reads `classType`, `date`,
  // `startTime` and `teacherId` where it always did. `cancelledAt` is new
  // beside them, because `status` can no longer carry it.
  return respondOk(
    classes.map(({ calendarEntry, ...cls }) => ({
      ...cls,
      teacherId: calendarEntry.teacherId,
      classType: calendarEntry.classType,
      date: calendarEntry.date,
      startTime: timeToHHmm(calendarEntry.startTime),
      durationMinutes: calendarEntry.durationMinutes,
      cancelledAt: calendarEntry.cancelledAt,
    })),
  );
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createClassSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Verify teacherRoomId belongs to this teacher
  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id: body.teacherRoomId } });
  if (!teacherRoom || teacherRoom.teacherId !== session.teacherId) {
    return respondError('Invalid teacher room', 400);
  }

  // Two Prisma calls, not one nested `create`. Prisma already wraps a single
  // nested write in its own implicit transaction — the same five-statement
  // shape as the studio sibling's nested create (`studio-classes/route.ts`,
  // measured there): `BEGIN`, `INSERT CalendarEntry`, `INSERT Class`,
  // `SELECT`, `COMMIT` — so this explicit `$transaction` PRESERVES that
  // atomicity across the two calls below rather than introducing it. Without
  // it, each call would open its own implicit transaction, leaving a window
  // where a `CalendarEntry` exists with no `Class`. It does not add a
  // lock-holding path.
  //
  // No `setLockTimeout` here: issue 228 tracks that bound for the create
  // paths, and adding it alone would turn a wait that usually succeeds into a
  // generic 503 rather than a named one. An explicit `$transaction` also
  // imports Prisma's interactive-transaction defaults — `maxWait: 2000`,
  // `timeout: 5000` — that the implicit nested write it replaces did not
  // carry, so contention here can already surface that same generic,
  // code-less 503 before any `setLockTimeout` is added.
  const outcome = await prisma.$transaction(async (tx) => {
    // The room's CURRENT `isArchived`, read inside the transaction and held.
    // `Class.roomArchived` is one column of a composite foreign key, so a
    // value that disagrees with the room is refused with `23503` rather than
    // stored — and the ownership read above is outside this transaction, so
    // its value can be stale by now. A draft in an archived room is LEGAL
    // (that is the asymmetry with `ClassTemplate`, which asserts `false`
    // instead), so the value has to be accurate rather than assumed.
    //
    // `FOR KEY SHARE` is the weakest lock that conflicts with the archive:
    // `isArchived` became part of an FK-referenced unique key in issue 272,
    // so flipping it is a KEY update and takes `FOR UPDATE`. It does not
    // conflict with the `KEY SHARE` the insert below takes on the same row,
    // nor with the generator's.
    const [room] = await tx.$queryRaw<{ isArchived: boolean }[]>`
      SELECT "isArchived" FROM "TeacherRoom"
       WHERE "id" = ${body.teacherRoomId}
       FOR KEY SHARE`;
    // Discriminated from the entry's own `{ ok: false }` below: this room
    // existed at the ownership check above but is gone by now — a race with
    // a concurrent delete, not a slot conflict — and the caller answers it
    // the same way the ownership check itself would have, not as a
    // DUPLICATE_CLASS_SLOT. Reachable only for a room's very first class:
    // once any class exists, `Class_teacherRoomId_roomArchived_fkey`
    // RESTRICTs the delete.
    if (!room) return { ok: false as const, reason: 'room_not_found' as const };

    // The ENTRY is inserted alone and first — it holds the slot constraint,
    // and `skipDuplicates` (`ON CONFLICT DO NOTHING`) makes it refuse with
    // zero rows rather than deadlock against a concurrent conflicting insert
    // (issue 331). `ON CONFLICT DO NOTHING` carries no conflict target, so a
    // zero-row skip could in principle be any constraint on `CalendarEntry`
    // — it can only be this slot exclusion here because this handler never
    // sets `scheduleRuleId`, leaving `@@unique([scheduleRuleId, date])`'s
    // column NULL, and Postgres treats NULLs as distinct. Parent before
    // child is forced by the composite `(calendarEntryId, kind)` foreign
    // key; this is a creation path, so `docs/lock-order.md`'s `Class`-then-
    // entry rule — which governs a write to two EXISTING rows — does not
    // apply.
    const [entry] = await tx.calendarEntry.createManyAndReturn({
      data: [{
        teacherId: session.teacherId,
        kind: 'regular' as const,
        classType: body.classType,
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
      }],
      skipDuplicates: true,
    });
    if (!entry) return { ok: false as const, reason: 'slot_conflict' as const };

    const cls = await tx.class.create({
      data: {
        calendarEntryId: entry.id,
        kind: 'regular',
        teacherRoomId: body.teacherRoomId,
        // COPIED, not asserted: see the transaction's opening comment. A
        // draft may legally sit in an archived room, so the value has to be
        // the room's actual current one rather than the Prisma default
        // (`false`).
        roomArchived: room.isArchived,
        description: body.description ?? null,
        roomCost: body.roomCost,
        minRate: body.minRate,
        targetRate: body.targetRate,
        minStudents: body.minStudents,
        maxStudents: body.maxStudents,
        cancelDeadline: body.cancelDeadline,
        autoCancelCheck: body.autoCancelCheck,
        status: 'draft',
      },
    });
    return { ok: true as const, entry, cls };
  });

  if (!outcome.ok) {
    if (outcome.reason === 'room_not_found') {
      // The room existed at the ownership check above but is gone by the
      // time this transaction re-read it — the same failure the ownership
      // check itself reports, just discovered later by a race with a
      // concurrent delete. Same message and status for the same reason;
      // this is not a slot conflict and must not be probed or logged as one.
      // LOGGED before responding, for the reason every refusal returned from a
      // service carries: `respondError` does not log and `withErrorHandler`
      // never sees a response that was RETURNED rather than thrown, so this
      // line is what leaves a server-side record of the refusal.
      log.warn(
        { teacherId: session.teacherId, teacherRoomId: body.teacherRoomId },
        'class create refused: the room was deleted while the create was parked on it',
      );
      return respondError('Invalid teacher room', 400);
    }
    // WHICH entry, asked of the database, because a zero row count does not
    // say — and either family can be the answer, since both live in one
    // table now. On `prisma`, never on a transaction client: the one above
    // has closed.
    const conflict = await probeConflictingEntry(prisma, session.teacherId, {
      date: new Date(body.date),
      startTime: hhmmToTime(body.startTime),
      durationMinutes: body.durationMinutes,
    });
    // LOGGED before responding, for the reason every refusal returned from a
    // service carries: `respondError` does not log and `withErrorHandler`
    // never sees a response that was RETURNED rather than thrown, so this
    // line is what leaves a server-side record of the refusal.
    log.warn(
      { teacherId: session.teacherId, conflictEntryId: conflict?.id ?? null },
      'class create refused: another live entry holds that slot',
    );
    return respondError(entryConflictMessage(conflict, 'regular'), 409, 'DUPLICATE_CLASS_SLOT');
  }
  const { entry, cls } = outcome;

  return respondOk(
    {
      ...cls,
      teacherId: entry.teacherId,
      classType: entry.classType,
      date: entry.date,
      startTime: timeToHHmm(entry.startTime),
      durationMinutes: entry.durationMinutes,
      cancelledAt: entry.cancelledAt,
    },
    201,
  );
});
