import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { updateRegistrationSchema } from '@/lib/schemas';
import { DEADLINE_HOURS } from '@/services/waitlist';
import { classStartInstant } from '@/lib/timezone';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      student: { select: { firstName: true, lastName: true } },
      class: { select: { teacherId: true, classType: true, date: true } },
    },
  });

  if (!registration) return respondError('Registration not found', 404);

  // Allow access if the user is the student or the class teacher
  const isStudent = session.userType === 'student' && registration.studentId === session.userId;
  const isTeacher = session.userType === 'teacher' && registration.class.teacherId === session.userId;

  if (!isStudent && !isTeacher) return respondError('Access denied', 403);

  return respondOk(registration);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (session.userType !== 'teacher') {
    return respondError('Only teachers can update attendance', 403);
  }

  const { id } = await params;

  const registration = await prisma.registration.findUnique({
    where: { id },
    include: { class: { select: { teacherId: true } } },
  });

  if (!registration) return respondError('Registration not found', 404);
  if (registration.class.teacherId !== session.userId) {
    return respondError('Not your class', 403);
  }

  const parsed = await parseBody(request, updateRegistrationSchema);
  if ('error' in parsed) return parsed.error;

  const updated = await prisma.registration.update({
    where: { id },
    data: { status: parsed.data.status },
  });

  return respondOk(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
  const isStudent = session.userType === 'student' && registration.studentId === session.userId;
  const isTeacher = session.userType === 'teacher' && registration.class.teacherId === session.userId;

  if (!isStudent && !isTeacher) return respondError('Access denied', 403);

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
      return respondOk(updated);
    }
  }

  // Before deadline or teacher cancelling — full cancel (not charged)
  const updated = await prisma.registration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });

  return respondOk(updated);
}
