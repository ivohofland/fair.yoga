import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireTeacher, parseBody, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { markPaymentPaid } from '@/services/payments';
import { markPaidSchema } from '@/lib/schemas';
import { loadOwnedPayment, respondPaymentOutcome } from '../shared';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const owned = await loadOwnedPayment(id, session.teacherId);
  if (!owned.ok) return owned.response;

  const parsed = await parseBody(request, markPaidSchema);
  if ('error' in parsed) return parsed.error;

  // Ownership is settled above; only past it may the service answer `unchanged`.
  return respondPaymentOutcome(await markPaymentPaid(prisma, id, parsed.data.method));
});
