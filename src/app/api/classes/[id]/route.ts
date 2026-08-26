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
import { updateClassSchema } from '@/lib/schemas';
import { updateClass, type ClassUpdateData } from '@/services/class-lifecycle';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      calendarEntry: true,
      _count: { select: { registrations: true } },
    },
  });

  if (!cls) return respondError('Class not found', 404);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  // Flattened back onto one wire object, as `GET /api/classes` does: the
  // entry's columns are where they always were from a client's point of view.
  const { calendarEntry, ...rest } = cls;
  return respondOk({
    ...rest,
    teacherId: calendarEntry.teacherId,
    classType: calendarEntry.classType,
    date: calendarEntry.date,
    startTime: timeToHHmm(calendarEntry.startTime),
    durationMinutes: calendarEntry.durationMinutes,
    cancelledAt: calendarEntry.cancelledAt,
  });
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { calendarEntry: true },
  });
  if (!cls) return respondError('Class not found', 404);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const parsed = await parseBody(request, updateClassSchema);
  if ('error' in parsed) return parsed.error;
  // The schema validates date as a YYYY-MM-DD string and startTime as
  // "HH:MM"; Prisma needs a Date for each (`@db.Date` UTC midnight,
  // `@db.Time` respectively). Latent until the edit UI — nothing ever PUT
  // either field before.
  const { date: dateString, startTime: startTimeString, ...rest } = parsed.data;
  const data: ClassUpdateData = {
    ...rest,
    ...(dateString !== undefined ? { date: new Date(dateString) } : {}),
    ...(startTimeString !== undefined ? { startTime: hhmmToTime(startTimeString) } : {}),
  };

  const result = await updateClass(prisma, id, data);
  if (result.ok) {
    const { calendarEntry, ...updated } = result.cls;
    return respondOk({
      ...updated,
      teacherId: calendarEntry.teacherId,
      classType: calendarEntry.classType,
      date: calendarEntry.date,
      startTime: timeToHHmm(calendarEntry.startTime),
      durationMinutes: calendarEntry.durationMinutes,
      cancelledAt: calendarEntry.cancelledAt,
    });
  }

  // Narrowed one reason at a time so the `locked` branch below can read
  // `result.fields` without a cast.
  if (result.reason === 'not_found') return respondError('Class not found', 404);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  if (result.reason === 'locked') {
    return respondError(
      `Cannot update economic fields when settings are locked: ${result.fields.join(', ')}`,
      409,
    );
  }
  // #247. Not a `locked` variant with a different field set — the two freezes
  // differ in scope and in trigger point, and `updateClass`'s docblock owns
  // that argument. Restated here once already and it went stale within the
  // branch, so it is cited rather than copied.
  //
  // Route-local decision, which is the part that does belong here: 409 rather
  // than 403, because the request is well-formed and the teacher does own the
  // class — ownership was settled above — so this conflicts with a state the
  // class has reached rather than with who is asking. Coded like the two 409s
  // below it, so a client can tell "frozen" from "slot taken" without
  // matching on English.
  if (result.reason === 'terminal') {
    return respondError(`Cannot edit a class that is ${result.state}`, 409, 'CLASS_TERMINAL');
  }
  // #327. The ENTRY refused it, not the class row — its schedule is frozen. A
  // sibling of `CLASS_TERMINAL` rather than a widening of it: that one is
  // about the class's own lifecycle, this one about when the class sits in the
  // calendar, and the two statements guard two different rows. Reached only by
  // losing the race the entry's CAS exists to lose — a completion or a
  // cancellation committing between this handler's read and the write — since
  // a visibly frozen class is answered as `terminal` above.
  if (result.reason === 'frozen') {
    return respondError(
      'This class was completed or cancelled while you were editing it, so its schedule can no longer change.',
      409,
      'CLASS_SCHEDULE_FROZEN',
    );
  }
  // A reschedule (date/startTime) landed on a slot this teacher already
  // occupies with another live class (#196) — the same clash a `POST` into
  // that slot reports, reached here by a move instead of a create.
  if (result.reason === 'slot_conflict') {
    return respondError(
      'You already have a class at that date and time.',
      409,
      'DUPLICATE_CLASS_SLOT',
    );
  }
  // The OTHER family holds it (#296). Same status as the branch above and a
  // deliberately different sentence: that clash is fixed among this teacher's
  // classes, this one sends them to their studio classes. A shared message
  // would be the same status for two different remedies.
  if (result.reason === 'cross_family_slot_conflict') {
    return respondError(
      'You already have a studio class at that date and time.',
      409,
      'CROSS_FAMILY_STUDIO_SLOT',
    );
  }
  // The `@@unique([scheduleRuleId, date])` key, not the slot constraint above
  // — reachable only from a reschedule, and only when the entry carries a
  // `scheduleRuleId` (`updateClass`'s own comment names why). Distinct message
  // and code: the slot 409 names a date AND time; this collision can fire
  // with the two classes' times entirely different, so naming the time back
  // to the teacher here would describe a clash that didn't happen.
  if (result.reason === 'template_date_conflict') {
    return respondError(
      'That recurring class already has a class on that date.',
      409,
      'TEMPLATE_INSTANCE_DATE_CONFLICT',
    );
  }
  // #249. Not a validation failure: `isoDate` accepted the value and the
  // calendar has that day. 409 for the same reason `terminal` is 409 and this
  // handler already argues above — the request is well-formed and the teacher
  // owns the class, so it conflicts with where the class sits in time rather
  // than with the shape of the input. Coded like its neighbours so a client can
  // tell "already started" from "frozen" and from "slot taken" without matching
  // on English.
  if (result.reason === 'past_start') {
    return respondError(
      'Cannot move a class to a date and time that has already passed.',
      409,
      'CLASS_STARTS_IN_PAST',
    );
  }
  // Exhaustiveness: a new UpdateClassResult variant becomes a compile error
  // here rather than being silently answered as though it were `locked`.
  const unhandled: never = result;
  return unhandled;
});
