import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import type { RegistrationStatus } from '@prisma/client';

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

interface UpdateRegistrationBody {
  status: 'attended' | 'no_show' | 'late_cancel';
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

  const body = await parseBody<UpdateRegistrationBody>(request);
  if (!body?.status) return respondError('Missing status field', 400);

  const validStatuses: RegistrationStatus[] = ['attended', 'no_show', 'late_cancel'];
  if (!validStatuses.includes(body.status)) {
    return respondError(`Invalid status. Must be one of: ${validStatuses.join(', ')}`, 400);
  }

  const updated = await prisma.registration.update({
    where: { id },
    data: { status: body.status },
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
    include: { class: { select: { teacherId: true, status: true, maxStudents: true, id: true } } },
  });

  if (!registration) return respondError('Registration not found', 404);

  // Allow cancellation by the student themselves or the class teacher
  const isStudent = session.userType === 'student' && registration.studentId === session.userId;
  const isTeacher = session.userType === 'teacher' && registration.class.teacherId === session.userId;

  if (!isStudent && !isTeacher) return respondError('Access denied', 403);

  // Cancel the registration
  const updated = await prisma.registration.update({
    where: { id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });

  // If class was 'full', check if it should go back to 'open'
  if (registration.class.status === 'full') {
    const activeCount = await prisma.registration.count({
      where: { classId: registration.class.id, status: { not: 'cancelled' } },
    });

    if (activeCount < registration.class.maxStudents) {
      await prisma.class.update({
        where: { id: registration.class.id },
        data: { status: 'open' },
      });
    }
  }

  return respondOk(updated);
}
