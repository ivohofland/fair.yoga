import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { markPaymentNotCharged } from '@/services/payments';

/**
 * The teacher chooses not to collect — same ownership chain as /paid and
 * /unpaid. No request body: unlike /paid there is no `method` to record,
 * because no money moved.
 */
export const POST = withErrorHandler(async (
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
        include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
      },
    },
  });

  if (!payment) return respondError('Payment not found', 404);
  if (payment.registration.class.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const result = await markPaymentNotCharged(prisma, id);
  if (!result.ok) return respondError(result.error, 409);
  return respondOk(result.payment);
});
