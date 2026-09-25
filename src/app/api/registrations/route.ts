import { NextRequest, NextResponse } from 'next/server';
import type { RegistrationStatus, Student } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import {
  respondTyped,
  respondUnchanged,
  respondError,
  respondRefusal,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { codedRefusal, type CodedRefusal } from '@/lib/api-error-codes';
import { createRegistrationSchema, type CreateRegistrationBody } from '@/lib/schemas';
import { checkStudentWriteLimit, respondRateLimited } from '@/lib/rate-limit';
import type { SessionUser } from '@/lib/types';
import { formatDayHeader } from '@/lib/format';
import { createBulkNotifications } from '@/services/notifications';
import { activateRegistration, reorderWaitingEntries } from '@/services/waitlist';
import { resolveInvitationOnLink } from '@/services/link-consent';
import { linkTeacherStudent } from '@/services/roster-link';
import {
  resolveWalkInStudent,
  completeWalkIn,
  WalkInRefusedError,
  type ResolvedWalkIn,
  type WalkInRefusal,
  type WalkInSubject,
} from '@/services/walk-ins';
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

/**
 * Thrown inside the transaction when a walk-in subject meets a class outside
 * the walk-in window.
 */
class WalkInWindowClosedError extends Error {}

const WALK_IN_REFUSALS: Record<WalkInRefusal, CodedRefusal> = {
  NOT_FOUND: codedRefusal('NOT_FOUND', 'Contact not found.'),
  INVITATION_ERASED: codedRefusal('INVITATION_ERASED', "This contact's account has been deleted."),
  DECLINED: codedRefusal('DECLINED', 'This person declined your invitation.'),
  WALK_IN_REFUSED: codedRefusal('WALK_IN_REFUSED', "This person can't be added to your classes."),
};

/** Who the body asks to book. Decided once, here; everything else reads it. */
type Subject =
  | { kind: 'self' }
  | { kind: 'roster'; studentId: string }
  | { kind: 'walkIn'; walkIn: WalkInSubject };

function subjectOf(body: CreateRegistrationBody): Subject {
  if ('studentId' in body) return { kind: 'roster', studentId: body.studentId };
  if ('invitationId' in body) {
    return { kind: 'walkIn', walkIn: { kind: 'invitation', invitationId: body.invitationId } };
  }
  if ('newContact' in body) return { kind: 'walkIn', walkIn: { kind: 'newContact', ...body.newContact } };
  return { kind: 'self' };
}

/**
 * The subject, checked against the session, with its student as far as it is
 * known before the transaction opens. A walk-in's student is not: it is
 * resolved, and possibly created, inside the transaction.
 */
type Target =
  | { kind: 'self'; student: Student }
  | { kind: 'roster'; teacherId: string; student: Student }
  | { kind: 'walkIn'; teacherId: string; walkIn: WalkInSubject };

/**
 * The checks that concern the subject rather than the class. The student
 * read and the roster-link read stay outside the transaction — holding the
 * class lock across them would widen it for nothing. The accepted
 * consequence: a request with a student-side problem — an unknown student,
 * or a roster link the acting teacher doesn't hold — and an unusable class
 * answers about the student first. A cross-teacher roster request therefore
 * dies at the roster-link check; the ownership check inside the transaction
 * is reached by a teacher's own roster student posted into another teacher's
 * class, or by a walk-in, which has no roster link to check.
 */
async function targetOf(subject: Subject, session: SessionUser): Promise<Target | NextResponse> {
  // A dual-role account books itself through the student path like anyone
  // else: only a subject in the body makes this a teacher's request.
  if (subject.kind === 'self') {
    if (!session.studentId) return respondError('Student access required', 403);
    const student = await prisma.student.findUnique({ where: { id: session.studentId } });
    if (!student) return respondError('Student not found', 404);
    return { kind: 'self', student };
  }

  const teacherId = session.teacherId;
  if (!teacherId) return respondError('Teacher access required', 403);

  if (subject.kind === 'roster') {
    const student = await prisma.student.findUnique({ where: { id: subject.studentId } });
    if (!student) return respondError('Student not found', 404);
    // A teacher can only register students in their own roster.
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: student.id } },
    });
    if (!link) return respondError('Student is not in your roster', 403);
    return { kind: 'roster', teacherId, student };
  }

  // A new contact is a student write, so it spends the CRM's spam brake. An
  // invitation was spent against it when it was created.
  if (subject.walkIn.kind === 'newContact') {
    const limit = checkStudentWriteLimit(teacherId);
    if (!limit.allowed) {
      log.warn({ teacherId }, 'walk-in refused: rate limit exceeded');
      return respondRateLimited(limit, 'Too many new contacts.');
    }
  }
  return { kind: 'walkIn', teacherId, walkIn: subject.walkIn };
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

  const target = await targetOf(subjectOf(body), session);
  if (target instanceof NextResponse) return target;
  const isTeacher = target.kind !== 'self';
  const actingTeacherId = target.kind === 'self' ? null : target.teacherId;

  // The booked student, once the transaction knows it: the `catch` below
  // re-reads a twin booking by it, and a walk-in's is resolved inside. A
  // holder rather than a `let`, because the compiler does not see a write
  // made inside the transaction's callback and would read the `let` as
  // still null in the `catch`.
  const bookedStudent: { id: string | null } = { id: null };

  try {
    const result = await prisma.$transaction(async (tx): Promise<BookingOutcome> => {
      // A walk-in's student is resolved before any lock is taken, because on
      // the new-contact branch it may be INSERTed, and `Student` heads the
      // lock order. A refusal here has written nothing.
      let resolved: ResolvedWalkIn | null = null;
      let booked: { id: string; incomeTier: number };
      if (target.kind === 'walkIn') {
        resolved = await resolveWalkInStudent(tx, { teacherId: target.teacherId, subject: target.walkIn });
        booked = { id: resolved.studentId, incomeTier: resolved.incomeTier };
      } else {
        booked = target.student;
      }
      const studentId = booked.id;
      bookedStudent.id = studentId;

      // The booked student's row first, before the class row, on every path.
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
          calendarEntry: {
            include: { teacher: { select: { defaultTimezone: true, firstName: true, lastName: true } } },
          },
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

      // An invitee or a new person is booked only with them at the door —
      // their presence is what stands for their acceptance. A roster student
      // may still be added ahead of time. Outside the window such a request is
      // not a walk-in at all, so this refusal makes its goal moot and comes
      // before the `existing` check below: an address already booked here is
      // refused exactly like any other, and answers nothing about who it is.
      if (resolved && !isWalkIn) {
        throw new WalkInWindowClosedError();
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

      const { isFull } = await readSeatCount(tx, lock);

      if (isFull && !isWalkIn) {
        throw new ClassFullError();
      }

      const reg = await activateRegistration(tx, lock, {
        classId: body.classId,
        studentId,
        tierAtBooking: booked.incomeTier,
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

      // A walk-in links the person, accepts their invitation and tells them
      // they are booked, after `Registration` in the lock order.
      if (resolved) {
        await completeWalkIn(tx, {
          teacherId: cls.calendarEntry.teacherId,
          classId: cls.id,
          resolved,
          notice: {
            teacherName: `${cls.calendarEntry.teacher.firstName} ${cls.calendarEntry.teacher.lastName}`.trim(),
            classType: cls.calendarEntry.classType,
            dateLabel: formatDayHeader(cls.calendarEntry.date),
          },
        });
      }

      // A self-booking student joins the teacher's roster: this link is how
      // the CRM sees them and how per-teacher privacy gets its scope.
      if (target.kind === 'self') {
        const linkOutcome = await linkTeacherStudent(tx, {
          teacherId: cls.calendarEntry.teacherId,
          studentId,
        });

        // #166: only the student's own booking is consent, so this call sits
        // in the self-booking branch on purpose: it clears a decline and
        // lifts its block, which is one of the two routes back from one
        // (joining a waitlist, `addToWaitlist` in services/waitlist.ts, is
        // the other). A roster add resolves no invitation; a walk-in resolves
        // its own in `completeWalkIn` above, without lifting a block. The
        // rule: `docs/data-model.md` (Invitation, "Walk-ins").
        //
        // `linkOutcome` is what the link write above actually did, and it
        // decides the `pending` half: a booking by someone this teacher
        // already has on their roster resolves no `pending` row (#418). The
        // rule, and why the two halves differ, are in `docs/data-model.md`
        // (Invitation).
        await resolveInvitationOnLink(tx, {
          teacherId: cls.calendarEntry.teacherId,
          studentEmail: target.student.email,
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
            body: `${target.student.firstName} booked ${cls.calendarEntry.classType}.`,
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
    if (target.kind === 'self') {
      const studentId = target.student.id;
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
    if (err instanceof WalkInRefusedError) {
      return respondRefusal(WALK_IN_REFUSALS[err.refusal]);
    }
    if (err instanceof WalkInWindowClosedError) {
      return respondError('Walk-ins can be added once the class is about to start.', 409, 'WALK_IN_WINDOW_CLOSED');
    }
    // This check matches the column set of `Registration @@unique([classId,
    // studentId])`, met when a twin request booked this student into this
    // class first. Re-read outside the rolled-back transaction; an active row
    // is the booking this request asks for. A violation matching some other
    // column set, or a twin no longer active, or one met before the
    // transaction knew its student, falls through to `withErrorHandler`,
    // which answers 409 and logs `warn` naming `meta.target`.
    const studentId = bookedStudent.id;
    if (studentId !== null && isUniqueConflictOn(err, ['classId', 'studentId'])) {
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
