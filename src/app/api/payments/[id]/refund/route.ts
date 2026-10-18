import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  isErrorResponse, parseBody, requireTeacher, respondError, respondRefusal, respondTyped, withErrorHandler,
} from '@/lib/api-utils';
import type { Payment, ProcessorRefundStatus } from '@/lib/prisma-client';
import { refundSchema } from '@/lib/schemas';
import { mollieDeps } from '@/services/mollie-deps';
import { refundAttempt } from '@/services/processor-refunds';
import { loadOwnedPayment } from '../shared';

/** Refunds one Mollie attempt of the teacher's own payment in full, and answers the refund's status and the payment as it now stands. */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  const body = await parseBody(request, refundSchema);
  if ('error' in body) return body.error;

  const { id } = await params;
  const owned = await loadOwnedPayment(id, session.teacherId);
  if (!owned.ok) return owned.response;

  const result = await refundAttempt(prisma, mollieDeps(), { paymentId: id, attemptId: body.data.attemptId, choice: body.data.choice });
  switch (result.kind) {
    case 'requested': {
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id } });
      return respondTyped<{ refundStatus: ProcessorRefundStatus; outcomeApplied: boolean; payment: Payment }>({
        refundStatus: result.refundStatus,
        outcomeApplied: result.outcomeApplied,
        payment,
      });
    }
    case 'invalid':
      return respondError(result.message, 400);
    case 'refused':
      return respondRefusal(result.refusal);
    case 'unavailable':
      return respondError('Mollie can’t be reached right now. Try the refund again in a moment.', 503, 'PROCESSOR_UNAVAILABLE');
    default: {
      const unhandled: never = result;
      throw new Error(`unhandled refund result: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});
