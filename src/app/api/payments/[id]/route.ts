import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';

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
        include: {
          student: { select: { firstName: true, lastName: true, email: true } },
          class: { select: { teacherId: true, classType: true, date: true } },
        },
      },
    },
  });

  if (!payment) return respondError('Payment not found', 404);

  // Verify teacher owns the class via registration chain
  if (payment.registration.class.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  return respondOk(payment);
});
