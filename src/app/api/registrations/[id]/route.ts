import { NextRequest, type NextResponse } from 'next/server';
import type { RegistrationStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondTyped,
  respondUnchanged,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateRegistrationSchema } from '@/lib/schemas';
import { transientDbFailure } from '@/lib/api-errors';
import { cancelDeadlineInstant, handleSpotFreed, SpotFreedError, spotFreedLoss } from '@/services/waitlist';
import { isPastCancelDeadline, freeCancelUntilFor } from '@/lib/cancel-deadline';
import { log } from '@/lib/log';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { createNotification, type CreateNotificationInput } from '@/services/notifications';

/** A PUT's response body, applied or unchanged. */
type AttendanceBody = { id: string; status: RegistrationStatus };

/** A DELETE's response body, applied or unchanged. */
type CancelledBooking = { id: string; status: 'cancelled' | 'late_cancel' };

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      class: {
        select: {
          calendarEntry: { select: { teacherId: true, classType: true, date: true } },
        },
      },
    },
  });

  if (!registration) return respondError('Registration not found', 404);

  const isStudent = registration.studentId === session.studentId;

  // The student's own read is not a disclosure boundary — their tier and
  // price are theirs. Only the teacher's view is projected (#167).
  //
  // Checked before the teacher-ownership check below: a dual-role account
  // reading its own booking in a class it also teaches is still a self-read.
  // `isStudent` and `registration.class.calendarEntry.teacherId === session.teacherId` can
  // both be true for the same request — ordering the teacher check first
  // would route that request into the projected view and silently strip the
  // very tier and price this branch exists to protect.
  if (isStudent) return respondOk(registration);

  const { teacherId } = session;
  if (teacherId === null || registration.class.calendarEntry.teacherId !== teacherId) {
    return respondError('Access denied', 403);
  }

  const student = await prisma.student.findUniqueOrThrow({
    where: { id: registration.studentId },
    select: studentVisibilitySelect(teacherId),
  });

  return respondOk({
    id: registration.id,
    classId: registration.classId,
    studentId: registration.studentId,
    status: registration.status,
    registeredAt: registration.registeredAt,
    cancelledAt: registration.cancelledAt,
    isWalkIn: registration.isWalkIn,
    class: registration.class.calendarEntry,
    student: projectStudentForTeacher(student, teacherId),
  });
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (!session.teacherId) {
    return respondError('Only teachers can update attendance', 403);
  }

  const { id } = await params;

  // `teacherId` only, deliberately. Ownership is a fact about the class that
  // this route cannot change and no concurrent writer moves, so reading it here
  // is safe. The class's STATUS is not read: testing it here would be a
  // read-then-write across `parseBody`'s await, so it belongs in the write's
  // own WHERE below and is deliberately absent from this select.
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
  });

  if (!registration) return respondError('This booking no longer exists.', 404, 'NOT_FOUND');
  if (registration.class.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const parsed = await parseBody(request, updateRegistrationSchema);
  if ('error' in parsed) return parsed.error;

  // #182. Every condition in the WHERE, none as a pre-check: this handler opens
  // no transaction, so anything read above and tested here is a read-then-write
  // that races. The DELETE branches below scope their writes for the same
  // reason.
  //
  // What the scope closes: `autoCancelClasses` (`class-transitions.ts`) counts
  // registrations in `ACTIVE_REGISTRATION_STATUSES` under its row lock, then
  // CASes. This route takes no `Class` lock, so it can commit between the two.
  // A registration moving INTO that set makes the count too LOW and cancels a
  // class that had enough students. Moves OUT are harmless — the count reads
  // too high and the class merely survives a sweep, a one-tick delay.
  //
  // TWO accepted transitions move INTO the set, not one: `late_cancel ->
  // attended` and `late_cancel -> no_show`, because `no_show` is in
  // `ACTIVE_REGISTRATION_STATUSES` too. That is why this scopes the SOURCE
  // rather than the target — keying it on `attended` would leave the other one
  // open with every test still green. Both are refused only while the class is
  // `open`, because that is the only window in which the race exists: `autoCancelClasses` both selects
  // and CASes on `status: 'open'`. Once the class has started, a student who
  // late-cancelled and turned up anyway is the teacher's call to record, and
  // costs nothing to allow — `late_cancel` and `attended` are both in
  // `CHARGED_STATUSES`, so the pricing divisor does not move and no price
  // changes for anyone. The check-in list renders those students deliberately
  // (`activeRegistrations`, `class/[id]/page.tsx`); refusing the write would
  // only stop a teacher recording what happened in their own room.
  //
  // `completed` is DELIBERATELY absent from the class clause. A teacher learns
  // the exact no-shows after the class, not during it. All three values
  // `updateRegistrationSchema` accepts are in `CHARGED_STATUSES`, so a
  // correction made after completion cannot change who is billed. There is a
  // test pinning this as a product requirement; #234 is the UI work that makes
  // it reachable.
  //
  // No guard on class TIME either: check-in renders on an `open` class within
  // 15 minutes of its start, so attendance before the class begins is the
  // designed flow, not an anomaly.
  //
  // A `Class` row lock would also close the race and is not used: this write
  // moves no money, and locking the hottest row in the app to protect a
  // one-tick scheduling delay is not proportionate.
  const requested = parsed.data.status;
  const updated = await prisma.registration.updateMany({
    where: {
      id,
      // The requested status too: a row already holding it is not rewritten,
      // and the re-read below answers it as unchanged.
      status: { notIn: ['cancelled', requested] },
      // The class's cancellation is an ENTRY column since #327, not a status.
      class: { calendarEntry: { cancelledAt: null } },
      // NOT(late_cancel AND class open), written as its contrapositive so each
      // arm is a plain condition Prisma can compile without a nested relation
      // negation.
      OR: [{ status: { not: 'late_cancel' } }, { class: { status: { not: 'open' } } }],
    },
    data: { status: requested },
  });

  if (updated.count === 0) {
    // The write has already failed, so there is nothing left to protect by not
    // reading — and the snapshot above was taken before `parseBody`'s await,
    // which makes naming a status from it the same staleness the sibling cancel
    // route had to fix separately. Decide from the WHERE, explain from a fresh
    // read.
    const current = await prisma.registration.findUnique({
      where: { id },
      select: {
        status: true,
        class: { select: { status: true, calendarEntry: { select: { cancelledAt: true } } } },
      },
    });
    if (!current) return respondError('This booking no longer exists.', 404, 'NOT_FOUND');
    if (current.class.calendarEntry.cancelledAt !== null) {
      return respondError(
        "This class has been cancelled, so attendance can't be recorded.",
        409,
        'CLASS_CANCELLED',
      );
    }
    if (current.status === requested) {
      return respondUnchanged<AttendanceBody>({ id, status: requested });
    }
    switch (current.status) {
      case 'late_cancel':
        return respondError(
          'This student cancelled late. Attendance can be recorded once the class has started.',
          409,
          'CLASS_NOT_STARTED',
        );
      case 'cancelled':
        return respondError(
          "This booking was cancelled, so attendance can't be recorded.",
          409,
          'REGISTRATION_CANCELLED',
        );
      case 'registered':
      case 'attended':
      case 'no_show':
        // A status the write would have matched: another write moved the row
        // between the two statements.
        return respondError(
          'This booking was just changed elsewhere. Refresh and try again.',
          409,
          'CONCURRENT_MODIFICATION',
        );
      default: {
        const unreachable: never = current.status;
        throw new Error(`unhandled registration status: ${String(unreachable)}`);
      }
    }
  }

  return respondTyped<AttendanceBody>({ id, status: requested });
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      class: {
        select: {
          status: true, maxStudents: true, id: true, cancelDeadline: true,
          calendarEntry: {
            select: {
              teacherId: true,
              classType: true,
              date: true,
              startTime: true,
              cancelledAt: true,
              teacher: { select: { defaultTimezone: true } },
            },
          },
        },
      },
    },
  });

  if (!registration) return respondError('This booking no longer exists.', 404, 'NOT_FOUND');

  // Allow cancellation by the student themselves or the class teacher
  const isStudent = registration.studentId === session.studentId;
  const isTeacher = registration.class.calendarEntry.teacherId === session.teacherId;

  if (!isStudent && !isTeacher) return respondError('Access denied', 403);

  // A cancelled class makes the request moot, so it is answered before the
  // booking's own state. A cancelled class is an entry column since #327.
  if (registration.class.calendarEntry.cancelledAt !== null) {
    return respondError('This class has been cancelled.', 409, 'CLASS_CANCELLED');
  }

  // Before the finished-class refusal: a cancel that already holds is done,
  // whatever happened to the class since. Branched on `isStudent`, as the
  // notice below is.
  const alreadyCancelled = answerForCancelledRow(id, registration.status, isStudent);
  if (alreadyCancelled) return alreadyCancelled;

  // Cancelling on a completed class would orphan its payment.
  if (registration.class.status === 'completed') {
    return respondError(
      "This class has finished, so the booking can't be cancelled.",
      409,
      'CLASS_TERMINAL',
    );
  }

  // Enforce cancellation deadline for students (teachers can always cancel).
  if (isStudent) {
    const deadline = cancelDeadlineInstant(
      registration.class.calendarEntry,
      registration.class.cancelDeadline,
      registration.class.calendarEntry.teacher.defaultTimezone,
    );

    // An auto-promoted student's free-cancel window extends past the bare
    // deadline for #236's grace (`freeCancelUntilFor`, `cancel-deadline.ts`):
    // the system placed them, so the clock the deadline copy promised them
    // wasn't the one they got to act on.
    const promotion = await prisma.waitlistEntry.findUnique({
      where: { registrationId: id },
      select: { status: true, promotedAt: true },
    });
    const until = freeCancelUntilFor(deadline, promotion);

    if (isPastCancelDeadline(until, new Date())) {
      // Past the free-cancel instant — mark as late_cancel (still charged).
      //
      // Status in the WHERE, not just the pre-check above: that pre-check is a
      // read-then-write and this handler opens no transaction, so two
      // concurrent cancels both pass it.
      //
      // The scope is for money, not to guard against a doubled waitlist
      // broadcast: `late_cancel` is in `CHARGED_STATUSES` (`class-lifecycle.ts`)
      // and `cancelled` is not, so an unscoped write here can land *after* a
      // teacher's free cancel and silently rewrite `cancelled` → `late_cancel`,
      // billing a student for a class the teacher had let them out of. The
      // scope also keeps the loser of two concurrent late cancels from writing
      // twice: it re-reads and is answered as unchanged, as the sibling
      // branch's is.
      const updated = await prisma.registration.updateMany({
        where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
        data: { status: 'late_cancel', cancelledAt: new Date() },
      });
      if (updated.count === 0) {
        return answerMissedCancel(id, isStudent);
      }
      // The seat is free even though the canceller is still charged.
      await promoteAfterCancel(registration.classId);
      await notifyCancellation({
        recipientType: 'student',
        recipientId: registration.studentId,
        relatedClassId: registration.classId,
        type: 'booking_cancelled',
        title: 'Booking cancelled',
        buildBody: (phrase) =>
          `Your booking for ${phrase} is cancelled. It was past the cancellation deadline, so this class is still charged.`,
      });
      return respondTyped<CancelledBooking>({ id, status: 'late_cancel' });
    }
  }

  // Before the free-cancel instant, or a teacher cancelling — full cancel
  // (not charged). "Before the free-cancel instant" covers both a student
  // ahead of the bare deadline and one still inside #236's grace.
  // Status in the WHERE for the same reason as the late-cancel branch above:
  // two concurrent cancels must not both reach the waitlist hook.
  const updated = await prisma.registration.updateMany({
    where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
  if (updated.count === 0) {
    return answerMissedCancel(id, isStudent);
  }

  // Hybrid waitlist promotion: auto-promote, broadcast, or stay frozen
  // depending on how close to the deadline we are.
  await promoteAfterCancel(registration.classId);

  // Layer 1+2 of the comms model, the pair booking sends inverted — except
  // that this direction tells only the student, deliberately. TWO types
  // because the delivery policy differs on them: a removal the student did
  // not ask for is essential, their own cancellation is not
  // (`services/notification-policy.ts` carries that reasoning).
  //
  // Branched on `isStudent`, not `isTeacher`: a dual-role account cancelling
  // its own booking is self-initiated even when it also teaches, the same
  // precedence the GET handler above applies for the same reason.
  await notifyCancellation(
    isStudent
      ? {
          recipientType: 'student',
          recipientId: registration.studentId,
          relatedClassId: registration.classId,
          type: 'booking_cancelled',
          title: 'Booking cancelled',
          buildBody: (phrase) => `Your booking for ${phrase} is cancelled. You won't be charged for it.`,
        }
      : {
          recipientType: 'student',
          recipientId: registration.studentId,
          relatedClassId: registration.classId,
          type: 'booking_removed',
          title: 'Booking cancelled by your teacher',
          buildBody: (phrase) =>
            `Your teacher cancelled your booking for ${phrase}. You won't be charged for it.`,
        },
  );

  return respondTyped<CancelledBooking>({ id, status: 'cancelled' });
});

/**
 * The answer to a cancel whose registration is already cancelled, or `null`
 * when the cancel still has work to do. Either cancelled status is what a
 * student's cancel asks for. A teacher's cancel is free: a `late_cancel` row
 * is still charged, so it is refused rather than reported done.
 */
function answerForCancelledRow(
  id: string,
  status: RegistrationStatus,
  byStudent: boolean,
): NextResponse | null {
  if (status === 'cancelled' || (byStudent && status === 'late_cancel')) {
    return respondUnchanged<CancelledBooking>({ id, status });
  }
  if (status === 'late_cancel') {
    return respondError(
      'This student already cancelled late, and the late-cancellation charge stands.',
      409,
      'ALREADY_LATE_CANCELLED',
    );
  }
  return null;
}

/**
 * A cancel whose scoped write matched nothing: after the read above, the row
 * left the cancellable statuses or was deleted. Decided from a fresh read.
 */
async function answerMissedCancel(id: string, byStudent: boolean): Promise<NextResponse> {
  const current = await prisma.registration.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!current) return respondError('This booking no longer exists.', 404, 'NOT_FOUND');
  return (
    answerForCancelledRow(id, current.status, byStudent) ??
    // Active again: a rebooking reactivated the row between the two statements.
    respondError(
      'This booking was just changed elsewhere. Refresh and try again.',
      409,
      'CONCURRENT_MODIFICATION',
    )
  );
}

/**
 * The class a cancellation notice is about, named the way every cancellation
 * notice names one: type, day, time. `startTime` is a `@db.Time` column, so
 * it arrives as a `Date` and needs rendering rather than interpolating.
 */
function classPhrase(entry: { classType: string; date: Date; startTime: Date }): string {
  return `${entry.classType} on ${formatDayHeader(entry.date)} at ${timeToHHmm(entry.startTime)}`;
}

/** What `notifyCancellation` needs from a call site: everything static about
 *  the notice, plus a way to phrase it once the fresh class read below is in
 *  hand. `body` is deliberately absent — `notifyCancellation` builds it, not
 *  the caller. */
type CancellationNoticeInput = Omit<CreateNotificationInput, 'body' | 'relatedClassId'> & {
  relatedClassId: string;
  buildBody: (phrase: string) => string;
};

/**
 * Sends the student their cancellation notice, after the cancel has committed.
 *
 * Swallowed for the same reason `promoteAfterCancel` swallows: the status
 * write has already landed, and a throw from here would answer 500 for a
 * cancellation that fully succeeded — the student would see an error, retry,
 * and be told their booking is already cancelled. That is also why the class
 * is re-read and the body is built HERE, inside this `try`, rather than by the
 * caller before calling in: `registration.class.calendarEntry` is read at the
 * top of the DELETE handler, before `promoteAfterCancel` can spend up to a 2s
 * lock timeout under contention, so a concurrent reschedule could make the
 * notice name the class's old day or time — and building the phrase outside
 * this `try` would let a throw from formatting it escape uncaught. Re-reading
 * here shrinks that window to this function's own runtime and keeps both the
 * read and the phrasing behind the swallow.
 *
 * `error` rather than `warn`, even for a transient failure, and unlike the
 * waitlist hook next door: nothing sweeps for missing notifications, so a loss
 * here is permanent. The student is simply never told.
 *
 * The inner `try`/`catch` around the `log.error` call is the same backstop
 * `promoteAfterCancel` below nests for its own diagnostic log, and for the
 * same reason — see the comment inside its inner `catch`.
 */
async function notifyCancellation(input: CancellationNoticeInput): Promise<void> {
  try {
    const cls = await prisma.class.findUniqueOrThrow({
      where: { id: input.relatedClassId },
      select: { calendarEntry: { select: { classType: true, date: true, startTime: true } } },
    });
    await createNotification(prisma, {
      recipientType: input.recipientType,
      recipientId: input.recipientId,
      relatedClassId: input.relatedClassId,
      type: input.type,
      title: input.title,
      body: input.buildBody(classPhrase(cls.calendarEntry)),
    });
  } catch (err) {
    try {
      log.error(
        { err, recipientId: input.recipientId, type: input.type, classId: input.relatedClassId },
        'cancellation notice not sent — the student was not told their booking ended',
      );
    } catch (loggingErr) {
      log.error(
        { err: loggingErr, recipientId: input.recipientId, classId: input.relatedClassId },
        'cancellation-notice diagnostic failed unexpectedly',
      );
    }
  }
}

/**
 * Runs the waitlist spot-freed hook after a cancel has committed. The cancel
 * already succeeded — a promotion failure must not turn it into a 500, so
 * errors are logged and swallowed here.
 *
 * **Split by transience since #212 made a lock timeout reachable here.** #212
 * put the BROADCAST branch behind `lockClassRow`, whose `SET LOCAL
 * lock_timeout = '2s'` raises `55P03` on a contended `Class` row — where the
 * old bare-client body could barely fail at all. #104 then put the
 * AUTO-PROMOTE branch behind the same helper, and that is the far larger
 * surface of the two: `getWaitlistWindow` returns `auto_promote` for
 * everything up to (cancel deadline − 1h), against exactly one hour of
 * `first_come_first_claimed`. Read this paragraph as being about both
 * branches. `api-errors.ts` states the
 * rule this obeys, with this exact scenario as its example: "`error` is the
 * level that pages someone, while a `lock_timeout` on a contended row is the
 * system doing what it was configured to do." Logging routine contention at
 * `error` gets the line tuned out, and then the genuine defect hides in the
 * noise it created.
 *
 * `waiting` is what makes either line actionable, and so now is WHICH branch
 * `handleSpotFreed` was in — it throws a `SpotFreedError` (`services/waitlist.ts`)
 * carrying the resolved window as `.window`, and `spotFreedLoss` turns that
 * into the phrase this catch logs. On the broadcast branch
 * (`first_come_first_claimed`) every student queued on this class was silently
 * not told a seat opened. On the auto-promote branch, which covers everything
 * up to (cancel deadline − 1h) and is therefore the commoner of the two by a
 * wide margin, the loss is narrower and sharper: ONE specific student who
 * should now hold that seat does not. Either way `waiting` sizes it — 0 is a
 * non-event, 12 is a seat that now goes unsold and reprices the class for
 * everyone left. A failure before the window resolves — `.window` still
 * `null` — falls back to `spotFreedLoss`'s general phrase, because there is
 * nothing yet to name; the payload's `branch` field is `'unknown'` for that
 * same case.
 *
 * The loss recorded here is RECOVERABLE. The `waitlist-reconciliation` sweep
 * (`services/waitlist-reconciliation.ts`, #220) re-runs this same hook on
 * every tick for any open class holding a free seat and a waiting queue — this
 * class, in exactly this state — so a drop here is repaired within a tick. Two
 * things follow. This line is a record of the live path failing rather than an
 * obituary — and adding a retry HERE is still the wrong fix, for the reason
 * the sweep exists: a `55P03` means the contending writer is still holding the
 * row, so an immediate retry loses the same race again.
 *
 * One case the sweep still cannot reach, stated because "repaired within a
 * tick" would otherwise read as unconditional: a drop in the last tick before
 * the cancel deadline. The class is `frozen` by the next tick and the sweep
 * will not promote past a deadline, so for that final tick this line is
 * still the only record. It is not the multi-cancel case — a broadcast dropped
 * after an earlier one succeeded IS repaired, because `Class.spotBroadcastAt`
 * is cleared by the claim that consumed the earlier seat.
 */
async function promoteAfterCancel(classId: string): Promise<void> {
  try {
    await handleSpotFreed(prisma, classId);
  } catch (err) {
    try {
      // `-1`, not `0`, and not a second silent failure: this runs inside a
      // handler that must not throw, and a count no real queue can take keeps
      // the line honest about not knowing rather than claiming nobody waited.
      //
      // What `-1` no longer distinguishes is WHY the count failed. #104 routes
      // materially more traffic into this catch — both branches of
      // `handleSpotFreed` can raise `55P03` now, not just the broadcast one — so
      // a `-1` here can be pool exhaustion or a second `lock_timeout` on the
      // count itself, and the error is discarded either way. One
      // `log.debug({ err }, …)` in this `.catch` restores that; it is left out
      // of a documentation-only pass on purpose, not by oversight.
      const waiting = await prisma.waitlistEntry
        .count({ where: { classId, status: 'waiting' } })
        .catch(() => -1);
      const failure = transientDbFailure(err);
      const transient = failure !== null;
      const window = err instanceof SpotFreedError ? err.window : null;
      log[failure?.level ?? 'error'](
        { err, classId, waiting, transient, transientKind: failure?.kind ?? null, branch: window ?? 'unknown' },
        transient
          ? `waitlist spot-freed hook hit a transient database failure after cancel — ${spotFreedLoss(window)}`
          : `waitlist spot-freed hook failed after cancel — ${spotFreedLoss(window)}`,
      );
    } catch (loggingErr) {
      // The cancel has ALREADY COMMITTED — `handleSpotFreed`'s own failure
      // above is a real (if now-unlogged) miss, but an UNCAUGHT throw from the
      // code handling it would reach `withErrorHandler` and answer 500 for a
      // cancellation that fully succeeded, which is the exact outcome this
      // function's swallow exists to prevent. The diagnostic read already
      // guards itself with `.catch()`; this is the backstop for what that
      // doesn't — `log.warn`/`log.error` itself, or a future addition to this
      // block. Same shape and same reason as `deleteStudentAccount`'s
      // post-commit loop (`services/gdpr.ts`, issue #242).
      log.error(
        { err: loggingErr, classId },
        'waitlist spot-freed hook diagnostic failed unexpectedly',
      );
    }
  }
}
