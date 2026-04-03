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

interface CreateRegistrationBody {
  classId: string;
  studentId?: string;
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const body = await parseBody<CreateRegistrationBody>(request);
  if (!body?.classId) return respondError('Missing classId', 400);

  const isTeacher = session.userType === 'teacher';
  const studentId = isTeacher ? body.studentId : session.userId;

  if (!studentId) {
    return respondError('studentId is required when teacher adds a registration', 400);
  }

  // Look up the class
  const cls = await prisma.class.findUnique({ where: { id: body.classId } });
  if (!cls) return respondError('Class not found', 404);

  // Check class status
  if (cls.status !== 'open' && cls.status !== 'full') {
    return respondError(`Cannot register for a class with status "${cls.status}"`, 409);
  }

  // Count current registrations (non-cancelled)
  const registrationCount = await prisma.registration.count({
    where: { classId: body.classId, status: { not: 'cancelled' } },
  });

  const isWalkIn = isTeacher && cls.teacherId === session.userId;

  // If class is full and not a walk-in by the teacher, reject
  if (cls.status === 'full' && !isWalkIn) {
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

  // If registration count reaches maxStudents, transition to 'full'
  const newCount = registrationCount + 1;
  if (newCount >= cls.maxStudents && cls.status === 'open') {
    await prisma.class.update({
      where: { id: body.classId },
      data: { status: 'full' },
    });
  }

  return respondOk(registration, 201);
});
