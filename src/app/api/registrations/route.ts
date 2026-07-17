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

/** Thrown inside the registration transaction when the class is at capacity. */
class ClassFullError extends Error {}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createRegistrationSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  const isTeacher = session.userType === 'teacher';
  const studentId = isTeacher ? body.studentId : session.userId;

  if (!studentId) {
    return respondError('studentId is required when teacher adds a registration', 400);
  }

  // Look up the class
  const cls = await prisma.class.findUnique({ where: { id: body.classId } });
  if (!cls) return respondError('Class not found', 404);

  // Teachers may only manage registrations for their own classes —
  // registering also locks the class's economic settings.
  if (isTeacher && cls.teacherId !== session.userId) {
    return respondError('Not your class', 403);
  }

  // Check class status
  if (cls.status !== 'open') {
    return respondError(`Cannot register for a class with status "${cls.status}"`, 409);
  }

  // Look up the student to get incomeTier
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return respondError('Student not found', 404);

  // A teacher can only register students in their own roster.
  if (isTeacher) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.userId, studentId } },
    });
    if (!link) return respondError('Student is not in your roster', 403);
  }

  // Teacher-added registrations are walk-ins: they may exceed max_students
  // (the teacher rate stays capped at target; extra students lower prices).
  const isWalkIn = isTeacher;

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

      const reg = await tx.registration.create({
        data: {
          classId: body.classId,
          studentId,
          tierAtBooking: student.incomeTier,
          isWalkIn,
          status: 'registered',
        },
      });

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
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return respondError('Student is already registered for this class', 409);
    }
    throw err;
  }
});
