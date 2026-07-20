import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { createRegistrationSchema } from '@/lib/schemas';
import { createBulkNotifications } from '@/services/notifications';
import { activateRegistration, reorderWaitingEntries } from '@/services/waitlist';
import { classStartInstant } from '@/lib/timezone';

/** Thrown inside the registration transaction when the class is at capacity. */
class ClassFullError extends Error {}

/** Thrown inside the transaction when the student already holds a spot. */
class AlreadyRegisteredError extends Error {}

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

  // Look up the class
  const cls = await prisma.class.findUnique({
    where: { id: body.classId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!cls) return respondError('Class not found', 404);

  // Teachers may only manage registrations for their own classes —
  // registering also locks the class's economic settings.
  if (actingTeacherId && cls.teacherId !== actingTeacherId) {
    return respondError('Not your class', 403);
  }

  // Check class status. Students book open classes; the teacher can also
  // add someone who shows up while the class is in progress.
  const allowedStatuses = isTeacher ? ['open', 'in_progress'] : ['open'];
  if (!allowedStatuses.includes(cls.status)) {
    return respondError(`Cannot register for a class with status "${cls.status}"`, 409);
  }

  // Look up the student to get incomeTier
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return respondError('Student not found', 404);

  // A teacher can only register students in their own roster.
  if (isTeacher) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: actingTeacherId!, studentId } },
    });
    if (!link) return respondError('Student is not in your roster', 403);
  }

  // Walk-ins are a class-time phenomenon: someone shows up at the door and
  // the teacher lets them in — those may exceed max_students (the teacher
  // rate stays capped at target; extra students lower prices). A teacher
  // adding a student well before class is a normal registration and
  // respects capacity like everyone else.
  const WALK_IN_WINDOW_MS = 15 * 60 * 1000;
  const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const isWalkIn =
    isTeacher &&
    (cls.status === 'in_progress' || Date.now() >= classStart.getTime() - WALK_IN_WINDOW_MS);

  try {
    const registration = await prisma.$transaction(async (tx) => {
      // Serialize concurrent registrations for this class: without the row
      // lock, two simultaneous requests both count below max and both insert.
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${body.classId} FOR UPDATE`;

      // Count active registrations (cancelled and late_cancel freed their spot)
      const registrationCount = await tx.registration.count({
        where: { classId: body.classId, status: { in: ['registered', 'attended', 'no_show'] } },
      });

      if (registrationCount >= cls.maxStudents && !isWalkIn) {
        throw new ClassFullError();
      }

      // A cancelled registration keeps its row (unique per class+student), so
      // rebooking must reactivate it — a plain create would 409 forever.
      const existing = await tx.registration.findUnique({
        where: { classId_studentId: { classId: body.classId, studentId } },
        select: { status: true },
      });
      if (existing && ['registered', 'attended', 'no_show'].includes(existing.status)) {
        throw new AlreadyRegisteredError();
      }

      const reg = await activateRegistration(tx, {
        classId: body.classId,
        studentId,
        tierAtBooking: student.incomeTier,
        isWalkIn,
      });

      // Booking directly while on the waitlist resolves the waiting entry —
      // otherwise the stale entry poisons future promotions of this queue.
      const waitingEntry = await tx.waitlistEntry.findFirst({
        where: { classId: body.classId, studentId, status: 'waiting' },
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
        await tx.teacherStudent.upsert({
          where: { teacherId_studentId: { teacherId: cls.teacherId, studentId } },
          update: {},
          create: { teacherId: cls.teacherId, studentId },
        });

        // Layer 1+2 of the comms model: confirmation for the student,
        // heads-up for the teacher. Email fallback picks these up if unread.
        await createBulkNotifications(tx, [
          {
            recipientType: 'student',
            recipientId: studentId,
            type: 'booking_confirmed',
            title: 'Booking confirmed',
            body: `You're booked for ${cls.classType}. The final price settles after class.`,
            relatedClassId: cls.id,
          },
          {
            recipientType: 'teacher',
            recipientId: cls.teacherId,
            type: 'booking_confirmed',
            title: 'New booking',
            body: `${student.firstName} booked ${cls.classType}.`,
            relatedClassId: cls.id,
          },
        ]);
      }

      return reg;
    });

    return respondOk(registration, 201);
  } catch (err) {
    if (err instanceof ClassFullError) {
      return respondError('Class is full', 409);
    }
    if (
      err instanceof AlreadyRegisteredError ||
      (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
    ) {
      return respondError('Student is already registered for this class', 409);
    }
    throw err;
  }
});
