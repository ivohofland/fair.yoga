import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { unmarkPaymentPaid } from '@/services/payments';

/** Undo for a mistaken "mark paid" — same ownership chain as /paid. */
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
        include: { class: { select: { teacherId: true } } },
      },
    },
  });

  if (!payment) return respondError('Payment not found', 404);
  if (payment.registration.class.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const result = await unmarkPaymentPaid(prisma, id);
  if (!result.ok) return respondError(result.error, 409);
  return respondOk(result.payment);
});
