import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { sendPaymentReminder } from '@/services/payments';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  // Verify teacher owns the payment via registration chain
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        include: { class: { select: { teacherId: true } } },
      },
    },
  });

  if (!payment) return respondError('Payment not found', 404);
  if (payment.registration.class.teacherId !== session.userId) {
    return respondError('Access denied', 403);
  }

  const updated = await sendPaymentReminder(prisma, id);
  return respondOk(updated);
});
