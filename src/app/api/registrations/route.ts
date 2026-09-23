import { NextRequest } from 'next/server';
import type { RegistrationStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import {
  respondTyped,
  respondUnchanged,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createRegistrationSchema } from '@/lib/schemas';
import { createBulkNotifications } from '@/services/notifications';
import { activateRegistration, reorderWaitingEntries } from '@/services/waitlist';
import { resolveInvitationOnLink } from '@/services/link-consent';
import { linkTeacherStudent } from '@/services/roster-link';
import { classStartInstant } from '@/lib/timezone';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { CLAIMABLE_WAITLIST_STATUSES } from '@/lib/waitlist-status';
import { readSeatCount } from '@/services/capacity';
import { lockClassRow, lockLiveStudent, StudentErasedError } from '@/lib/db-locks';
import { transientDbFailure } from '@/lib/api-errors';
import { log } from '@/lib/log';

/** Thrown inside the registration transaction when the class is at capacity. */
class ClassFullError extends Error {}

/** Thrown inside the transaction when the locked class row does not exist. */
class ClassNotFoundError extends Error {}

/** Thrown inside the transaction when the caller does not own the class. */
class NotYourClassError extends Error {}

/**
 * Thrown inside the transaction when the class cannot take this booking.
 * `refusal` names the case, and the `catch` answers each with its own code.
 */
class ClassStatusError extends Error {
  constructor(readonly refusal: 'cancelled' | 'not_bookable') {
    super(`class refuses the booking: ${refusal}`);
  }
}

/** The booking a response names, applied or unchanged. */
type BookingBody = { id: string; status: RegistrationStatus };

/** What the transaction did: wrote the booking, or found it already held. */
type BookingOutcome = {
  readonly outcome: 'applied' | 'unchanged';
  readonly booking: BookingBody;
};

/**
 * How long before a class starts a teacher-added registration counts as a
 * walk-in — someone showing up at the door — rather than a normal booking.
 */
const WALK_IN_WINDOW_MS = 15 * 60 * 1000;

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createRegistrationSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  // body.studentId marks a teacher acting on their roster; without it the
  // caller registers themselves as a student. A dual-role account books
  // itself through the student path like anyone else.
  const rosterStudentId = body.studentId;
  const actingTeacherId = rosterStudentId !== undefined ? session.teacherId : null;
  if (rosterStudentId !== undefined && !actingTeacherId) {
    return respondError('Teacher access required', 403);
  }
  const studentId = rosterStudentId ?? session.studentId;
  if (!studentId) {
    return respondError('Student access required', 403);
  }
  const isTeacher = actingTeacherId !== null;

  // The student read and the roster-link read concern the student, not the
  // class, so they stay outside the transaction — holding the class lock across
  // them would widen it for nothing. One consequence, accepted: a request with
  // a student-side problem — an unknown student, or, the case this suite
  // actually exercises, a roster link the acting teacher doesn't hold — and an
  // unusable class now answers about the student first, where it used to answer
  // about the class. This changed what one existing test proved: a cross-
  // teacher request used to reach the ownership check — which now lives inside
  // the transaction, but sat at the top of the handler before this fix — and
  // now dies at the roster-link check instead, so that test's meaning shifted
  // and it was supplemented with one that reaches the ownership check directly
  // (a teacher's own roster student, posted into another teacher's class).
  //
  // Look up the student to get incomeTier
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return respondError('Student not found', 404);

  // A teacher can only register students in their own roster.
  if (actingTeacherId) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: actingTeacherId, studentId } },
    });
    if (!link) return respondError('Student is not in your roster', 403);
  }

  try {
    const result = await prisma.$transaction(async (tx): Promise<BookingOutcome> => {
      // The booked student's row first, before the class row, on both paths.
      // A booking and an erasure of this student serialise here, and a
      // booking that waited reads the erasure's committed `deletedAt` and
      // refuses before writing anything. Modes and order: `docs/lock-order.md`,
      // "The `Student` row is the erasure's gate".
      await lockLiveStudent(tx, studentId);

      // Serialize concurrent registrations for this class: without the row
      // lock, two simultaneous requests both count below max and both insert.
      const lock = await lockClassRow(tx, body.classId);

      // Read the class UNDER that lock, and decide everything from this row.
      // #107: this read used to happen before the transaction, so `status`,
      // `maxStudents` and the walk-in window were decided from a snapshot the
      // lock did not protect — a class cancelled or re-capped in the gap was
      // booked anyway. `waitlist.ts` READS the class under this same lock in
      // four places — `addToWaitlist`, `promoteNext`, `claimSpot` and the #212
      // broadcast — each via `lockClassRow`, which issues the identical
      // statement. This is the fifth. Reading under the lock is the property
      // that matters here, and it is what picks those four out: a bare
      // `grep 'lockClassRow(' src/services/waitlist.ts` returns FIVE, because
      // `removeFromWaitlist` takes the same lock and renumbers under it
      // without deciding anything from the class row. Before #104 the four
      // were separable another way — three inline plus one through the helper
      // — and that distinction is gone now, so it is stated rather than
      // implied.
      //
      // `findUnique`, not `findUniqueOrThrow`: unlike the generator claims in
      // #102, the id here comes from the request body, so a missing class is
      // the ordinary 404 path rather than an impossible branch.
      const cls = await tx.class.findUnique({
        where: { id: body.classId },
        include: {
          calendarEntry: { include: { teacher: { select: { defaultTimezone: true } } } },
        },
      });
      if (!cls) throw new ClassNotFoundError();

      // Teachers may only manage registrations for their own classes —
      // registering also locks the class's economic settings.
      if (actingTeacherId && cls.calendarEntry.teacherId !== actingTeacherId) {
        throw new NotYourClassError();
      }

      // A cancelled class keeps whatever status it had (#327), so it is a check
      // of its own. It comes before the booking check below: a booked student
      // retrying on a cancelled class is told the class is off.
      if (cls.calendarEntry.cancelledAt !== null) {
        throw new ClassStatusError('cancelled');
      }

      // The booking this request asks for already exists. Checked before the
      // status and capacity refusals below, so a retry is never refused for a
      // state its own first attempt created. A cancelled registration keeps its
      // row (unique per class+student) and is reactivated further down.
      const existing = await tx.registration.findUnique({
        where: { classId_studentId: { classId: body.classId, studentId } },
        select: { id: true, status: true },
      });
      if (existing && ACTIVE_REGISTRATION_STATUSES.includes(existing.status)) {
        return { outcome: 'unchanged', booking: existing };
      }

      // Students book open classes; the teacher can also add someone who
      // shows up while the class is in progress.
      const allowedStatuses = isTeacher ? ['open', 'in_progress'] : ['open'];
      if (!allowedStatuses.includes(cls.status)) {
        throw new ClassStatusError('not_bookable');
      }

      // Walk-ins are a class-time phenomenon: someone shows up at the door and
      // the teacher lets them in — those may exceed max_students (the teacher
      // rate stays capped at target; extra students lower prices). A teacher
      // adding a student well before class is a normal registration and
      // respects capacity like everyone else.
      const classStart = classStartInstant(
        cls.calendarEntry,
        cls.calendarEntry.teacher.defaultTimezone,
      );
      const isWalkIn =
        isTeacher &&
        (cls.status === 'in_progress' || Date.now() >= classStart.getTime() - WALK_IN_WINDOW_MS);

      const { isFull } = await readSeatCount(tx, lock);

      if (isFull && !isWalkIn) {
        throw new ClassFullError();
      }

      const reg = await activateRegistration(tx, {
        classId: body.classId,
        studentId,
        tierAtBooking: student.incomeTier,
        isWalkIn,
      });

      // Booking directly while on the waitlist resolves the entry — otherwise
      // the stale entry poisons future promotions of this queue.
      //
      // `CLAIMABLE_WAITLIST_STATUSES`, not a list written out here. This is one
      // of the two sites that must agree on that set — the other is the count
      // rendered beside the **Add walk-in** button — and they disagreed once
      // already, which is why the set has a name. See `lib/waitlist-status.ts`
      // for why `removed` is excluded from it and `expired` is not.
      const waitingEntry = await tx.waitlistEntry.findFirst({
        where: {
          classId: body.classId,
          studentId,
          status: { in: [...CLAIMABLE_WAITLIST_STATUSES] },
        },
      });
      if (waitingEntry) {
        await tx.waitlistEntry.update({
          where: { id: waitingEntry.id },
          data: { status: 'claimed', promotedAt: new Date(), registrationId: reg.id },
        });
        await reorderWaitingEntries(tx, body.classId);
      }

      // First registration locks economic settings — same transaction, so a
      // concurrent settings edit cannot slip between create and lock.
      if (!cls.settingsLocked) {
        await tx.class.update({
          where: { id: body.classId },
          data: { settingsLocked: true },
        });
      }

      // A self-booking student joins the teacher's roster: this link is how
      // the CRM sees them and how per-teacher privacy gets its scope.
      if (!isTeacher) {
        const linkOutcome = await linkTeacherStudent(tx, {
          teacherId: cls.calendarEntry.teacherId,
          studentId,
        });

        // #166: only the student's own booking is consent — this call sits
        // inside `!isTeacher` on purpose, so a roster add or a walk-in never
        // launders itself into acceptance. It clears a decline, which is one
        // of the two routes back from one (joining a waitlist,
        // `addToWaitlist` in services/waitlist.ts, is the other).
        //
        // `linkOutcome` is what the link write above actually did, and it
        // decides the `pending` half: a booking by someone this teacher
        // already has on their roster resolves no `pending` row (#418). The
        // rule, and why the two halves differ, are in `docs/data-model.md`
        // (Invitation).
        await resolveInvitationOnLink(tx, {
          teacherId: cls.calendarEntry.teacherId,
          studentEmail: student.email,
          linkOutcome,
        });

        // Layer 1+2 of the comms model: confirmation for the student,
        // heads-up for the teacher. Email fallback picks these up if unread.
        await createBulkNotifications(tx, [
          {
            recipientType: 'student',
            recipientId: studentId,
            type: 'booking_confirmed',
            title: 'Booking confirmed',
            body: `You're booked for ${cls.calendarEntry.classType}. The final price settles after class.`,
            relatedClassId: cls.id,
          },
          {
            recipientType: 'teacher',
            recipientId: cls.calendarEntry.teacherId,
            type: 'booking_confirmed',
            title: 'New booking',
            body: `${student.firstName} booked ${cls.calendarEntry.classType}.`,
            relatedClassId: cls.id,
          },
        ]);
      }

      return { outcome: 'applied', booking: { id: reg.id, status: reg.status } };
    });

    if (result.outcome === 'unchanged') {
      return respondUnchanged<BookingBody>(result.booking);
    }
    const registration = result.booking;

    // Booking implies tier choice — but only the student's own booking.
    // Roster adds and walk-ins must not consume the income-selection
    // moment. Null-guarded: the marker records the first choice.
    //
    // Written after the transaction commits, as a statement of its own. The
    // transaction holds this student's row `FOR SHARE` from its first
    // lock, so an update inside it would upgrade that lock: it would
    // wait on any other gated writer's share of this student, and two
    // bookings of one student upgrading at once deadlock. Scoped to a live
    // profile because an erasure can commit while this write waits on the
    // row. Both rules: `docs/lock-order.md`, "The `Student` row is the
    // erasure's gate".
    //
    // A failure is logged and the booking still answered 201, because the
    // booking has committed. What a lost write costs: `tierSelectedAt` stays
    // null, so the student keeps the first-booking tier prompt and the
    // anonymous price line until a later write sets it — their next
    // self-booking or join, or a tier change. `error` unless the failure's
    // kind logs at `warn` — `TRANSIENT_KIND_LEVEL` (`lib/api-errors.ts`) is
    // the authority.
    if (!rosterStudentId) {
      try {
        await prisma.student.updateMany({
          where: { id: studentId, tierSelectedAt: null, deletedAt: null },
          data: { tierSelectedAt: new Date() },
        });
      } catch (err) {
        const failure = transientDbFailure(err);
        log[failure?.level ?? 'error'](
          {
            err,
            studentId,
            classId: body.classId,
            registrationId: registration.id,
            transient: failure !== null,
            transientKind: failure?.kind ?? null,
          },
          'booking committed but its tierSelectedAt write failed',
        );
      }
    }

    return respondTyped<BookingBody>(registration, 201);
  } catch (err) {
    if (err instanceof ClassNotFoundError) {
      return respondError('This class no longer exists.', 404, 'NOT_FOUND');
    }
    if (err instanceof StudentErasedError) {
      return respondError(
        isTeacher ? "This student's account no longer exists." : 'This account has been deleted.',
        409,
        'STUDENT_ERASED',
      );
    }
    if (err instanceof NotYourClassError) {
      return respondError('Not your class', 403);
    }
    if (err instanceof ClassStatusError) {
      return err.refusal === 'cancelled'
        ? respondError('This class has been cancelled.', 409, 'CLASS_CANCELLED')
        : respondError("This class isn't taking bookings.", 409, 'CLASS_NOT_BOOKABLE');
    }
    if (err instanceof ClassFullError) {
      return respondError('This class is full.', 409, 'CLASS_FULL');
    }
    // This check matches the column set of `Registration @@unique([classId,
    // studentId])`, met when a twin request booked this student into this
    // class first. Re-read outside the rolled-back transaction; an active row
    // is the booking this request asks for. A violation matching some other
    // column set, or a twin no longer active, falls through to
    // `withErrorHandler`, which answers 409 and logs `warn` naming
    // `meta.target`.
    if (isUniqueConflictOn(err, ['classId', 'studentId'])) {
      const twin = await prisma.registration.findUnique({
        where: { classId_studentId: { classId: body.classId, studentId } },
        select: { id: true, status: true },
      });
      if (twin && ACTIVE_REGISTRATION_STATUSES.includes(twin.status)) {
        return respondUnchanged<BookingBody>(twin);
      }
    }
    throw err;
  }
});
