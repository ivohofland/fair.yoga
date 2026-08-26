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
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
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
      return respondError(
        'You already have a studio class at that date and time.',
        409,
        'DUPLICATE_STUDIO_SLOT',
      );
    }
    // The OTHER family holds it (#296) — a `YG001` from the cross-family
    // trigger, which is not a P2002 and so passes straight through the branch
    // above. Same status, deliberately different sentence: that clash is fixed
    // within this family, this one sends the teacher to the other half of
    // their schedule.
    // LOGGED before responding, for the reason the five SERVICE sites now carry:
    // `respondError` does not log and `withErrorHandler` never sees a response
    // that was RETURNED rather than thrown, so catching here is what removes
    // the server-side record. The first fix for this asymmetry moved it rather
    // than closing it — it logged the two service returns and left five route
    // catches silent.
    if (isCrossFamilySlotConflict(err)) {
      log.warn(
        { err, teacherId: session.teacherId },
        'studio class create refused: the class family holds that slot',
      );
      return respondError(
        'You already have a class at that date and time.',
        409,
        'CROSS_FAMILY_CLASS_SLOT',
      );
    }
    throw err;
  }
});
