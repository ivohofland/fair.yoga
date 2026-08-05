import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(session.teacherId) },
          class: { select: { teacherId: true, classType: true, date: true } },
        },
      },
    },
  });

  if (!payment) return respondError('Payment not found', 404);

  // Verify teacher owns the class via registration chain
  if (payment.registration.class.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  return respondOk({
    ...payment,
    registration: {
      ...payment.registration,
      student: projectStudentForTeacher(payment.registration.student),
    },
  });
});
