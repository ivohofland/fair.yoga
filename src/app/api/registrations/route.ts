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
import { createRegistrationSchema } from '@/lib/schemas';

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

  // Check class status
  if (cls.status !== 'open') {
    return respondError(`Cannot register for a class with status "${cls.status}"`, 409);
  }

  // Count current registrations (non-cancelled)
  const registrationCount = await prisma.registration.count({
    where: { classId: body.classId, status: { not: 'cancelled' } },
  });

  const isWalkIn = isTeacher && cls.teacherId === session.userId;

  // If class is full and not a walk-in by the teacher, reject
  if (registrationCount >= cls.maxStudents && !isWalkIn) {
    return respondError('Class is full', 409);
  }

  // Look up the student to get incomeTier
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return respondError('Student not found', 404);

  // Create registration
  const registration = await prisma.registration.create({
    data: {
      classId: body.classId,
      studentId,
      tierAtBooking: student.incomeTier,
      isWalkIn,
      status: 'registered',
    },
  });

  // If this is the first registration, lock settings
  if (!cls.settingsLocked) {
    await prisma.class.update({
      where: { id: body.classId },
      data: { settingsLocked: true },
    });
  }

  return respondOk(registration, 201);
});
