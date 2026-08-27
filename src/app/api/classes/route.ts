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
  // nested write in its own implicit transaction — measured on this branch:
  // `BEGIN`, `INSERT CalendarEntry`, `INSERT Class`, `SELECT`, `COMMIT` — so
  // this explicit `$transaction` PRESERVES that atomicity across the two
  // calls below rather than introducing it. Without it, each call would open
  // its own implicit transaction, leaving a window where a `CalendarEntry`
  // exists with no `Class`. It does not add a lock-holding path.
  //
  // No `setLockTimeout` here: issue 228 tracks that bound for the create
  // paths, and adding it alone would turn a wait that usually succeeds into a
  // generic 503 rather than a named one.
  const outcome = await prisma.$transaction(async (tx) => {
    // The ENTRY is inserted alone and first — it holds the slot constraint,
    // and `skipDuplicates` (`ON CONFLICT DO NOTHING`) makes it refuse with
    // zero rows rather than deadlock against a concurrent conflicting insert
    // (issue 331). Parent before child is forced by the composite
    // `(calendarEntryId, kind)` foreign key; this is a creation path, so
    // `docs/lock-order.md`'s `Class`-then-entry rule — which governs a write
    // to two EXISTING rows — does not apply.
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
    if (!entry) return { ok: false as const };

    const cls = await tx.class.create({
      data: {
        calendarEntryId: entry.id,
        kind: 'regular',
        teacherRoomId: body.teacherRoomId,
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
