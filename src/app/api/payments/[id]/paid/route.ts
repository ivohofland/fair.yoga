import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { markPaymentPaid } from '@/services/payments';
import { markPaidSchema } from '@/lib/schemas';

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
  if (payment.registration.class.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, markPaidSchema);
  if ('error' in parsed) return parsed.error;

  const result = await markPaymentPaid(prisma, id, parsed.data.method);
  if (!result.ok) return respondError(result.error, 409);
  return respondOk(result.payment);
});
