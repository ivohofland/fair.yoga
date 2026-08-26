import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createStudioClassSchema } from '@/lib/schemas';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { entryConflictMessage, probeConflictingEntry } from '@/lib/entry-conflict';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';

export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClasses = await prisma.studioClass.findMany({
    where: { calendarEntry: { teacherId: session.teacherId } },
    include: { calendarEntry: true },
    orderBy: { calendarEntry: { date: 'desc' } },
  });

  // The wire shape is unchanged by #327: the entry's columns are flattened
  // back onto the studio class, so a client still reads `classType`, `date`,
  // `startTime`, `cancelledAt` and `teacherId` where it always did.
  return respondOk(
    studioClasses.map(({ calendarEntry, ...sc }) => ({
      ...sc,
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

  const parsed = await parseBody(request, createStudioClassSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // Fields are named rather than spread. The spread was not the vulnerability —
  // Zod strips undeclared keys, so only declared keys ever rode it — but it did
  // make the two server-set keys of the day invisible: neither name appeared in
  // this handler, so grepping for them found nothing (#148). One of the two,
  // `templateId`, is not a column at all any more; `scheduleRuleId` on the
  // entry is what replaced it, and this handler never sets it either.
  try {
    // The ENTRY is the row created, with its studio class nested (#327).
    // `kind` is set once, on the parent: it is half of the composite foreign
    // key, so Prisma omits it from the nested child input and fills it from
    // here. `classType` moved with it, and `CalendarEntry.classType` carries
    // no `@default("")` — every studio write supplies one now.
    const entry = await prisma.calendarEntry.create({
      data: {
        teacherId: session.teacherId,
        kind: 'studio',
        classType: body.classType,
        date: new Date(body.date),
        startTime: hhmmToTime(body.startTime),
        durationMinutes: body.durationMinutes,
        studioClasses: {
          create: {
            location: body.location,
            hourlyRate: body.hourlyRate,
          },
        },
      },
      include: { studioClasses: true },
    });
    const studioClass = entry.studioClasses[0];
    if (!studioClass) {
      throw new Error('studio class create: the nested studio class row did not come back');
    }
    return respondOk(
      {
        ...studioClass,
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
    // manually logged class has no rule behind it), so it is NULL, and
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
      // LOGGED before responding, for the reason the five SERVICE sites carry:
      // `respondError` does not log and `withErrorHandler` never sees a response
      // that was RETURNED rather than thrown, so catching here is what removes
      // the server-side record.
      log.warn(
        { err, teacherId: session.teacherId, conflictEntryId: conflict?.id ?? null },
        'studio class create refused: another live entry holds that slot',
      );
      return respondError(
        entryConflictMessage(conflict, 'studio'),
        409,
        'DUPLICATE_STUDIO_SLOT',
      );
    }
    throw err;
  }
});
