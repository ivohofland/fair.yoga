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
import { updateStudioClassSchema } from '@/lib/schemas';
import { Prisma } from '@prisma/client';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { isCrossFamilySlotConflict } from '@/lib/cross-family-conflict';
import { isRecordNotFound } from '@/lib/api-errors';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { log } from '@/lib/log';
import {
  studioClassDeletability,
  STUDIO_CLASS_REFUSALS,
  STUDIO_CLASS_REMOVAL_FACTS_SELECT,
} from '@/services/studio-class-deletion';
import {
  studioClassEditability,
  studioClassDateIsPast,
  STUDIO_CLASS_EDIT_REFUSALS,
} from '@/services/studio-class-editability';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: {
      calendarEntry: {
        include: { scheduleRule: { include: { studioClassTemplates: true } } },
      },
    },
  });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // The wire shape is unchanged by #327, `template` included: a studio class
  // reaches its template through the entry's rule now, and a rule carries at
  // most one template per family.
  const { calendarEntry, ...sc } = studioClass;
  return respondOk({
    ...sc,
    teacherId: calendarEntry.teacherId,
    classType: calendarEntry.classType,
    date: calendarEntry.date,
    startTime: timeToHHmm(calendarEntry.startTime),
    durationMinutes: calendarEntry.durationMinutes,
    cancelledAt: calendarEntry.cancelledAt,
    scheduleRuleId: calendarEntry.scheduleRuleId,
    template: calendarEntry.scheduleRule?.studioClassTemplates[0] ?? null,
  });
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    include: { calendarEntry: true },
  });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, updateStudioClassSchema);
  if ('error' in parsed) return parsed.error;

  if (Object.keys(parsed.data).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  // The editability verdict (issue 276, D1): past ⇒ income record (only the
  // student count and the cancellation remain writable); `date` moves only on
  // a manual row that is not an income record. A fresh two-field literal, not
  // `studioClass` — the predicate is handed only what it may read.
  //
  // One `now` for all three gates below. Reading the clock per gate would let a
  // request that straddles local midnight answer two gates from two different
  // todays, which is a state no test could reproduce and no reader expects.
  const now = new Date();
  const verdict = studioClassEditability(
    {
      scheduleRuleId: studioClass.calendarEntry.scheduleRuleId,
      date: studioClass.calendarEntry.date,
    },
    now,
    session.defaultTimezone,
  );

  const { cancelledAt, studentCount, date: dateString, ...gated } = parsed.data;

  // Gate 1 — the past freezes the schedule. `studentCount` and `cancelledAt`
  // are destructured above and so never sit in `gated`; anything else present
  // refuses the WHOLE request, so a count smuggled into the same body cannot
  // partially apply. `.strict()` makes `Object.keys(gated)` total: every key
  // the client sent is either in this destructure or in `gated`.
  if (!verdict.scheduleEditable && Object.keys(gated).length > 0) {
    return respondError(
      STUDIO_CLASS_EDIT_REFUSALS.income_record.message,
      409,
      STUDIO_CLASS_EDIT_REFUSALS.income_record.code,
    );
  }

  // Gate 2 — a generated row holds its `(scheduleRuleId, date)` key against the
  // sweep (D2): moving it would free the date and the hourly sweep would
  // recreate the class there. Cancel plus manual re-create is the remedy the
  // refusal names. Presence, not difference: re-sending the unchanged date of
  // a generated row refuses too, which is what keeps the form honest.
  //
  // WHICH refusal depends on WHY `dateEditable` is false, and both reasons
  // reach here. A past MANUAL row fails it by D1's invariant, not by template,
  // and telling that teacher their hand-logged class "comes from a recurring
  // template" is a false sentence — one rendered verbatim, since `(teacher)`
  // pages print `error.message` (#197). Gate 1 does not cover it: a body of
  // `{ date }` alone leaves `gated` empty and falls through to here.
  if (dateString !== undefined && !verdict.dateEditable) {
    const refusal = verdict.scheduleEditable
      ? STUDIO_CLASS_EDIT_REFUSALS.generated_date
      : STUDIO_CLASS_EDIT_REFUSALS.income_record;
    return respondError(refusal.message, 409, refusal.code);
  }

  // Gate 3 — a date may not move BACKWARDS across today. The verdict above
  // reads the stored row and so cannot see this: the row is legitimately
  // editable, and the write is what ends that. Landing before today makes it an
  // income record on arrival, so gate 1 freezes the very typo that caused
  // it — the teacher cannot undo a mistyped year through this editor, only by
  // removing the row and re-logging it.
  //
  // The mirror of the `Class` family's #249 rule ("a write may not newly place
  // a class's start in the past", `class-lifecycle.ts`). Nothing is taken away:
  // logging a class that already happened stays open at `/studio-class/new`,
  // which bounds its date field at neither end.
  if (dateString !== undefined
      && studioClassDateIsPast(new Date(dateString), now, session.defaultTimezone)) {
    return respondError(
      STUDIO_CLASS_EDIT_REFUSALS.past_date.message,
      409,
      STUDIO_CLASS_EDIT_REFUSALS.past_date.code,
    );
  }

  // `startTime` stays inside `gated` — Gate 1's `Object.keys(gated)` check
  // (above) needs its presence, not its wire shape — so the "HH:MM" → `Date`
  // conversion happens here instead of at the destructure, after the field
  // has already done its job of tripping (or not tripping) that gate. It is
  // destructured OUT of `gated` below rather than probed at runtime: if a
  // future change pulls it out of the parsed body the way `date`,
  // `cancelledAt` and `studentCount` already are, that destructure stops
  // compiling, where a `typeof ... === 'string'` probe would go quietly dead.
  //
  // SPLIT ACROSS THE TWO TABLES since #327. `location` and `hourlyRate` are
  // the studio class's own economics; `classType`, `date`, `startTime`,
  // `durationMinutes` and `cancelledAt` are the calendar identity and live on
  // the entry. `studentCount` stays on the child, which is why the gate above
  // could exempt it.
  const { location, hourlyRate, classType, startTime, durationMinutes } = gated;
  const studioData: Prisma.StudioClassUncheckedUpdateInput = {
    location,
    hourlyRate,
    ...(studentCount !== undefined ? { studentCount } : {}),
  };
  const entryData: Prisma.CalendarEntryUncheckedUpdateInput = {
    classType,
    durationMinutes,
    // The schema validates `date` as a YYYY-MM-DD string; Prisma needs a Date
    // (UTC midnight, same as creation). Same transform as
    // src/app/api/classes/[id]/route.ts.
    ...(dateString !== undefined ? { date: new Date(dateString) } : {}),
    ...(startTime !== undefined ? { startTime: hhmmToTime(startTime) } : {}),
    ...(cancelledAt !== undefined
      ? { cancelledAt: cancelledAt ? new Date(cancelledAt) : null }
      : {}),
  };

  // `CalendarEntry_teacher_slot_excl` is `EXCLUDE USING gist ("teacherId"
  // WITH =, span WITH &&) WHERE ("cancelledAt" IS NULL)` (#327). FOUR writes
  // here re-enter it and can collide with another live entry of this teacher:
  // changing `startTime`, changing `durationMinutes` (the span is generated
  // from it), clearing `cancelledAt` back to null on a previously cancelled
  // class, or moving `date`. The constraint does not care which family the
  // holder belongs to — one table now — and it is RANGE-based, so an overlap
  // collides where before only an identical start time did.
  //
  // NO RULE-DATE CATCH ARM, deliberately (spec §D2) — but note WHICH premise
  // carries that. `scheduleRuleId` is never written here, and gate 2 lets
  // `date` move only on rows whose `scheduleRuleId` is null, which PostgreSQL
  // treats as distinct. Both together are what make a P2002 on
  // `@@unique([scheduleRuleId, date])` unreachable; relax gate 2 and this arm
  // becomes necessary, or a real collision escapes as a 500.
  try {
    // Child then parent, matching the direction `lockClassRow` fixes for the
    // regular family (`db-locks.ts`): every writer that touches both takes the
    // class row before its entry — when both actually run. A body that edits
    // only entry fields leaves `studioData` all-`undefined`; Prisma then
    // issues no `StudioClass` write at all, so this transaction takes only
    // the entry lock and no ordering question arises for it. The order below
    // matters for the body that touches both.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.studioClass.update({ where: { id }, data: studioData });
      const entry = await tx.calendarEntry.update({
        where: { id: studioClass.calendarEntryId },
        data: entryData,
      });
      const sc = await tx.studioClass.findUniqueOrThrow({ where: { id } });
      return { ...sc, entry };
    });
    const { entry, ...sc } = updated;
    return respondOk({
      ...sc,
      teacherId: entry.teacherId,
      classType: entry.classType,
      date: entry.date,
      startTime: timeToHHmm(entry.startTime),
      durationMinutes: entry.durationMinutes,
      cancelledAt: entry.cancelledAt,
    });
  } catch (err) {
    if (isExclusionConflictOn(err, 'CalendarEntry_teacher_slot_excl')) {
      // LOGGED for the reason the cross-family arm below states in full:
      // `respondError` does not log, and `withErrorHandler` never sees a
      // response that was RETURNED rather than thrown, so catching here is
      // what removes the server-side record — the `classifyApiError` warn this
      // P2002 would otherwise have produced on its way out.
      log.warn(
        { err, studioClassId: id, teacherId: session.teacherId },
        'studio class edit refused: another studio class holds that slot',
      );
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
        // `studioClassId` too: this is the only one of the five route sites
        // where a row identifier is in scope, and every service-side sibling
        // logs one. The stated purpose of these lines is making a teacher's
        // report traceable, which wants the row.
        { err, studioClassId: id, teacherId: session.teacherId },
        'studio class edit refused: the class family holds that slot',
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

/**
 * Remove a studio class outright (issue 279). The policy lives in
 * `studio-class-deletion.ts`; this handler is the thin wrapper CLAUDE.md asks
 * for, and its gate order matches the `GET` and `PUT` above.
 *
 * NO CHECK-TO-DELETE RACE TO BACKSTOP, DELIBERATELY, and this is where the
 * obvious wrong edit is: `room-deletion.ts` is the model for this file and it
 * carries an FK backstop, so copying one here looks like diligence. There is
 * nothing to back stop. Neither disjunct of the predicate can flip
 * `removable → not removable`: the entry's `scheduleRuleId` is written once at
 * creation, and a calendar date already past cannot become un-past. The
 * archive door's `deleteMany` is keyed on a concrete `scheduleRuleId` and
 * filters `cancelledAt: null` with `date: { gt: today }` — see
 * `scheduledWhere` and the `deleteMany` it feeds in
 * `studio-class-template-lifecycle.ts` — so it can match neither a manual row
 * nor a past one. (Cited by symbol, not by line:
 * the line numbers this docblock first carried were stale within the same PR,
 * broken by an edit to that file's header.) The only real race is a second
 * click, and `isRecordNotFound` answers it the way `DELETE /api/waitlist/[id]`
 * answers its own — as never having had the row.
 */
export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // `STUDIO_CLASS_REMOVAL_FACTS_SELECT` rather than a hand-written projection,
  // so this handler fetches nothing the predicate should not see. The PAGE does
  // not share it — it renders the template and so queries wider; what keeps the
  // two call sites honest is that both build a fresh two-field literal below.
  // `teacherId` is added for gate 4 only, and is never passed on.
  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    select: {
      calendarEntryId: true,
      calendarEntry: { select: { teacherId: true, ...STUDIO_CLASS_REMOVAL_FACTS_SELECT } },
    },
  });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // A fresh two-field literal, not `studioClass`. Not for excess-property
  // checking — an optional widening defeats that — but so the predicate is
  // physically handed only what it may read, whatever this handler's `select`
  // grows to later.
  const verdict = studioClassDeletability(
    {
      scheduleRuleId: studioClass.calendarEntry.scheduleRuleId,
      date: studioClass.calendarEntry.date,
    },
    new Date(),
    session.defaultTimezone,
  );
  if (!verdict.deletable) {
    const refusal = STUDIO_CLASS_REFUSALS[verdict.reason];
    log.info(
      {
        studioClassId: id,
        teacherId: session.teacherId,
        scheduleRuleId: studioClass.calendarEntry.scheduleRuleId,
        reason: verdict.reason,
      },
      'studio class removal refused',
    );
    return respondError(refusal.message, 409, refusal.code);
  }

  try {
    // The ENTRY is what goes (#327), and the studio class rides its cascade.
    // Deleting the child alone would leave the entry standing, still holding
    // its slot and its `(scheduleRuleId, date)` key — a removed class that
    // still blocks the calendar.
    await prisma.calendarEntry.delete({ where: { id: studioClass.calendarEntryId } });
  } catch (err) {
    // The one outcome of this handler that used to leave no trace at all. The
    // docblock above argues no race can reach here; `studio-class-template-
    // lifecycle.ts` makes the same argument for its own write and logs anyway,
    // with the reason spelled out there — hinging observability on a census
    // nothing keeps honest is the mistake. By that same census this cannot
    // fire, so it cannot flood anything either.
    if (isRecordNotFound(err)) {
      log.warn(
        { err, studioClassId: id, teacherId: session.teacherId },
        'studio class vanished between the ownership read and the delete',
      );
      // Not "not found": the teacher answered "yes, remove it" and the row is
      // gone, which is the end state they asked for. A red "Studio class not
      // found" under a successful removal reads as failure — the second half of
      // the confirm-then-silence family the button's docblock names.
      return respondError('That class is already gone.', 404);
    }
    throw err;
  }

  // The only record this removal leaves, and deliberately the only one — see
  // the spec's §6.4. The app has no audit-log table, `withdrawnCount` exists
  // because an ARCHIVE removes rows the teacher never sees, and a `deletedAt`
  // column would re-create the tombstone removal exists to clear.
  log.info(
    {
      studioClassId: id,
      teacherId: session.teacherId,
      scheduleRuleId: studioClass.calendarEntry.scheduleRuleId,
    },
    'studio class removed',
  );
  return respondOk({ deleted: true });
});
