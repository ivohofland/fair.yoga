import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateRegistrationSchema } from '@/lib/schemas';
import { isTransientDbError } from '@/lib/api-errors';
import { DEADLINE_HOURS, handleSpotFreed } from '@/services/waitlist';
import { classStartInstant } from '@/lib/timezone';
import { log } from '@/lib/log';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';

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
      class: { select: { teacherId: true, classType: true, date: true } },
    },
  });

  if (!registration) return respondError('Registration not found', 404);

  const isStudent = registration.studentId === session.studentId;

  // The student's own read is not a disclosure boundary — their tier and
  // price are theirs. Only the teacher's view is projected (#167).
  //
  // Checked before the teacher-ownership check below: a dual-role account
  // reading its own booking in a class it also teaches is still a self-read.
  // `isStudent` and `registration.class.teacherId === session.teacherId` can
  // both be true for the same request — ordering the teacher check first
  // would route that request into the projected view and silently strip the
  // very tier and price this branch exists to protect.
  if (isStudent) return respondOk(registration);

  const { teacherId } = session;
  if (teacherId === null || registration.class.teacherId !== teacherId) {
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
    class: registration.class,
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

  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { class: { select: { teacherId: true, status: true } } },
  });

  if (!registration) return respondError('Registration not found', 404);
  if (registration.class.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  // #182. A cancelled class has no attendance to record.
  //
  // `completed` is DELIBERATELY absent from this check. A teacher learns the
  // exact no-shows after the class, not during it — someone arrives a minute
  // late, is let in, and nobody stops to tap a checkbox. All three values
  // `updateRegistrationSchema` accepts are in `CHARGED_STATUSES`
  // (`class-lifecycle.ts`), so a correction made after completion cannot
  // change who is billed. There is a test pinning this; it is a product
  // requirement, not an oversight.
  //
  // The UI cannot reach this allowance yet — `AttendanceList` only renders
  // under `showCheckin` (`(teacher)/class/[id]/page.tsx`), which goes false
  // within about a minute of the class ending, once `autoCompleteClasses`
  // flips it to `completed`. That gap is UI work, filed separately as issue
  // #234 — this guard is what makes building it safe, not evidence the
  // allowance was never used.
  //
  // No guard on class TIME either, and that is also deliberate: check-in
  // renders on an `open` class within 15 minutes of its start
  // (`(teacher)/class/[id]/page.tsx`), so attendance before the class begins
  // is the designed flow.
  if (registration.class.status === 'cancelled') {
    return respondError('Cannot record attendance on a cancelled class', 409);
  }

  const parsed = await parseBody(request, updateRegistrationSchema);
  if ('error' in parsed) return parsed.error;

  // Status in the WHERE, not just a pre-check, for the same reason both DELETE
  // branches below scope their writes: this handler opens no transaction, so a
  // read-then-write races.
  //
  // What it closes: `autoCancelClasses` (`class-transitions.ts`) counts
  // registrations in `ACTIVE_REGISTRATION_STATUSES` under its row lock, then
  // CASes. This route takes no `Class` lock, so it can commit between the two.
  // A registration moving INTO that set — `late_cancel -> attended` — makes
  // the count too LOW and cancels a class that had enough students. Scoping
  // the SOURCE means a registration can only ever move WITHIN the counted set,
  // so the count cannot rise. Moves OUT stay possible and are harmless: they
  // make the count too high, and the class merely survives a sweep it might
  // have been cancelled in — a one-tick delay.
  //
  // A `Class` row lock would also close it, and is not used: this write moves
  // no money (`no_show` is in both `ACTIVE_REGISTRATION_STATUSES` and
  // `CHARGED_STATUSES`, so attendance changes no seat count and no price), and
  // locking the hottest row in the app to protect it is not proportionate.
  const updated = await prisma.registration.updateMany({
    where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
    data: { status: parsed.data.status },
  });
  if (updated.count === 0) {
    return respondError('Cannot record attendance on a cancelled registration', 409);
  }

  return respondOk({ id, status: parsed.data.status });
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
          teacherId: true, status: true, maxStudents: true, id: true,
          date: true, startTime: true, cancelDeadline: true,
          teacher: { select: { defaultTimezone: true } },
        },
      },
    },
  });

  if (!registration) return respondError('Registration not found', 404);

  // Allow cancellation by the student themselves or the class teacher
  const isStudent = registration.studentId === session.studentId;
  const isTeacher = registration.class.teacherId === session.teacherId;

  if (!isStudent && !isTeacher) return respondError('Access denied', 403);

  // A registration can only be cancelled while the class is still upcoming;
  // cancelling on a completed class would orphan its payment.
  if (registration.class.status === 'completed' || registration.class.status === 'cancelled') {
    return respondError(
      `Cannot cancel a registration on a ${registration.class.status} class`,
      409,
    );
  }
  if (registration.status === 'cancelled' || registration.status === 'late_cancel') {
    return respondError('Registration is already cancelled', 409);
  }

  // Enforce cancellation deadline for students (teachers can always cancel).
  // The deadline is computed from the class start in the teacher's timezone.
  if (isStudent) {
    const hours = DEADLINE_HOURS[registration.class.cancelDeadline] ?? 24;
    const classStart = classStartInstant(
      registration.class.date,
      registration.class.startTime,
      registration.class.teacher.defaultTimezone,
    );
    const deadline = new Date(classStart.getTime() - hours * 60 * 60 * 1000);

    if (new Date() > deadline) {
      // Past deadline — mark as late_cancel (still charged).
      //
      // Status in the WHERE, not just the pre-check above: that pre-check is a
      // read-then-write and this handler opens no transaction, so two
      // concurrent cancels both pass it.
      //
      // NOT for the doubled broadcast the full-cancel branch below guards
      // against — this branch is reached only when `now > deadline`, and
      // `getWaitlistWindow` returns `frozen` for exactly that, so
      // `handleSpotFreed` sends nothing here. It is for money. `late_cancel`
      // is in `CHARGED_STATUSES` (`class-lifecycle.ts`) and `cancelled` is
      // not, so an unscoped write here can land *after* a teacher's free
      // cancel and silently rewrite `cancelled` → `late_cancel`, billing a
      // student for a class the teacher had let them out of. The scope also
      // gives the loser of two concurrent late cancels the 409 the sibling
      // branch already gives, instead of a second 200.
      const updated = await prisma.registration.updateMany({
        where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
        data: { status: 'late_cancel', cancelledAt: new Date() },
      });
      if (updated.count === 0) {
        return respondError('Registration is already cancelled', 409);
      }
      // The seat is free even though the canceller is still charged.
      await promoteAfterCancel(registration.classId);
      return respondOk({ id, status: 'late_cancel' });
    }
  }

  // Before deadline or teacher cancelling — full cancel (not charged).
  // Status in the WHERE for the same reason as the late-cancel branch above:
  // two concurrent cancels must not both reach the waitlist hook.
  const updated = await prisma.registration.updateMany({
    where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
  if (updated.count === 0) {
    return respondError('Registration is already cancelled', 409);
  }

  // Hybrid waitlist promotion: auto-promote, broadcast, or stay frozen
  // depending on how close to the deadline we are.
  await promoteAfterCancel(registration.classId);

  return respondOk({ id, status: 'cancelled' });
});

/**
 * Runs the waitlist spot-freed hook after a cancel has committed. The cancel
 * already succeeded — a promotion failure must not turn it into a 500, so
 * errors are logged and swallowed here.
 *
 * **Split by transience since #212 made a lock timeout reachable here.** The
 * broadcast branch now opens a transaction on `lockClassRow`, whose `SET LOCAL
 * lock_timeout = '2s'` raises `55P03` on a contended `Class` row — where the
 * old bare-client body could barely fail at all. `api-errors.ts` states the
 * rule this obeys, with this exact scenario as its example: "`error` is the
 * level that pages someone, while a `lock_timeout` on a contended row is the
 * system doing what it was configured to do." Logging routine contention at
 * `error` gets the line tuned out, and then the genuine defect hides in the
 * noise it created.
 *
 * `waiting` is what makes either line actionable. The failure means every
 * student queued on this class was silently not told a seat opened — 0 is a
 * non-event, 12 is a seat that now goes unsold and reprices the class for
 * everyone left.
 *
 * It used to say the loss could never be recovered, because nobody would know
 * to look. That is no longer true: the `waitlist-reconciliation` sweep
 * (`services/waitlist-reconciliation.ts`, #220) re-runs this same hook every
 * minute on any open class holding a free seat and a waiting queue, so a drop
 * here is repaired within a tick. Two things follow. This line is now a record
 * of the live path failing rather than an obituary — and adding a retry HERE
 * is still the wrong fix, for the reason the sweep exists: a `55P03` means the
 * contending writer is still holding the row, so an immediate retry loses the
 * same race again.
 *
 * One case the sweep still cannot reach, stated because "repaired within a
 * tick" would otherwise read as unconditional: a drop in the final minute
 * before the cancel deadline. The class is `frozen` by the next tick and the
 * sweep will not promote past a deadline, so for that one minute this line is
 * still the only record. It is not the multi-cancel case — a broadcast dropped
 * after an earlier one succeeded IS repaired, because `Class.spotBroadcastAt`
 * is cleared by the claim that consumed the earlier seat.
 */
async function promoteAfterCancel(classId: string): Promise<void> {
  try {
    await handleSpotFreed(prisma, classId);
  } catch (err) {
    // `-1`, not `0`, and not a second silent failure: this runs inside a
    // handler that must not throw, and a count no real queue can take keeps
    // the line honest about not knowing rather than claiming nobody waited.
    const waiting = await prisma.waitlistEntry
      .count({ where: { classId, status: 'waiting' } })
      .catch(() => -1);
    const transient = isTransientDbError(err);
    log[transient ? 'warn' : 'error'](
      { err, classId, waiting, transient },
      transient
        ? 'waitlist spot-freed hook lost a lock race after cancel — waiting students were not notified'
        : 'waitlist spot-freed hook failed after cancel',
    );
  }
}
