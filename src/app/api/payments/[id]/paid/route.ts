import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import { markPaymentPaid } from '@/services/payments';

interface MarkPaidBody {
  method: string;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  const body = await parseBody<MarkPaidBody>(request);
  if (!body?.method) return respondError('Missing method field', 400);

  const updated = await markPaymentPaid(prisma, id, body.method);
  return respondOk(updated);
}
