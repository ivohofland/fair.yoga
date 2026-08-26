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
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
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

  try {
    // The ENTRY is the row created, with its class nested (#327). `kind` is
    // set once, on the parent: it is half of the composite foreign key, so
    // Prisma omits it from the nested child input and fills it from here.
    const entry = await prisma.calendarEntry.create({
      data: {
        teacherId: session.teacherId,
        kind: 'regular',
        classType: body.classType,
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
        classes: {
          create: {
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
        },
      },
      include: { classes: true },
    });
    const cls = entry.classes[0];
    if (!cls) throw new Error('class create: the nested class row did not come back');
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
  } catch (err) {
    // The slot constraint, not the rule-date key. `@@unique([scheduleRuleId,
    // date])` cannot raise here — this create never sets `scheduleRuleId` (a
    // manually created class has no rule behind it), so it is NULL, and
    // Postgres treats NULLs as distinct.
    //
    // `isExclusionConflictOn`, not `isUniqueConflictOn`: since #327 the slot
    // is an `EXCLUDE USING gist` raising `23P01`, which has no `meta.target`
    // column list for the unique matcher to compare. It is also RANGE-based,
    // so a create that merely OVERLAPS a live class of this teacher collides
    // where before only an identical start time did.
    if (isExclusionConflictOn(err, 'CalendarEntry_teacher_slot_excl')) {
      // WHICH entry, asked of the database, because the `23P01` does not say —
      // and either family can be the answer, since both live in one table now.
      // On `prisma`, never on a transaction client: this handler opens none,
      // and the implicit one behind the nested `create` above was rolled back
      // and closed before this catch ran.
      const conflict = await probeConflictingEntry(prisma, session.teacherId, {
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
      });
      // LOGGED before responding, for the reason every refusal returned from a
      // service carries: `respondError` does not log and `withErrorHandler` never
      // sees a response that was RETURNED rather than thrown, so catching here is
      // what removes the server-side record.
      log.warn(
        { err, teacherId: session.teacherId, conflictEntryId: conflict?.id ?? null },
        'class create refused: another live entry holds that slot',
      );
      return respondError(
        entryConflictMessage(conflict, 'regular'),
        409,
        'DUPLICATE_CLASS_SLOT',
      );
    }
    throw err;
  }
});
