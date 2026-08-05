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
    student: projectStudentForTeacher(student),
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
    include: { class: { select: { teacherId: true } } },
  });

  if (!registration) return respondError('Registration not found', 404);
  if (registration.class.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const parsed = await parseBody(request, updateRegistrationSchema);
  if ('error' in parsed) return parsed.error;

  const updated = await prisma.registration.update({
    where: { id },
    data: { status: parsed.data.status },
  });

  return respondOk({ id: updated.id, status: updated.status });
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
      // Past deadline — mark as late_cancel (still charged)
      const updated = await prisma.registration.update({
        where: { id },
        data: { status: 'late_cancel', cancelledAt: new Date() },
      });
      // The seat is free even though the canceller is still charged.
      await promoteAfterCancel(registration.classId);
      return respondOk({ id: updated.id, status: updated.status });
    }
  }

  // Before deadline or teacher cancelling — full cancel (not charged)
  const updated = await prisma.registration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });

  // Hybrid waitlist promotion: auto-promote, broadcast, or stay frozen
  // depending on how close to the deadline we are.
  await promoteAfterCancel(registration.classId);

  return respondOk({ id: updated.id, status: updated.status });
});

/**
 * Runs the waitlist spot-freed hook after a cancel has committed. The cancel
 * already succeeded — a promotion failure must not turn it into a 500, so
 * errors are logged and swallowed here.
 */
async function promoteAfterCancel(classId: string): Promise<void> {
  try {
    await handleSpotFreed(prisma, classId);
  } catch (err) {
    log.error({ err, classId }, 'waitlist spot-freed hook failed after cancel');
  }
}
