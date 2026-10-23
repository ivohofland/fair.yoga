import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  isErrorResponse, parseBody, requireStudent, respondError, respondRefusal, respondTyped, withErrorHandler,
} from '@/lib/api-utils';
import { processorAttemptSchema } from '@/lib/schemas';
import { createAttempt } from '@/services/processor-attempts';
import { mollieDeps } from '@/services/mollie-deps';

/** Starts, or reuses, the student's Mollie payment for one of their payments and answers its checkout URL. */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;
  const body = await parseBody(request, processorAttemptSchema);
  if ('error' in body) return body.error;

  const { id } = await params;
  // Ownership is part of this lookup: it is keyed by the session's own `studentId`.
  const outcome = await createAttempt(prisma, mollieDeps(), { paymentId: id, studentId: session.studentId, method: body.data.method });
  switch (outcome.kind) {
    case 'checkout':
      return respondTyped<{ checkoutUrl: string }>({ checkoutUrl: outcome.checkoutUrl });
    case 'refused':
      return respondRefusal(outcome.refusal);
    case 'unavailable':
      return respondError('Paying online isn’t available right now. Try again, or choose another way to pay.', 503, 'PROCESSOR_UNAVAILABLE');
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled attempt outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});
