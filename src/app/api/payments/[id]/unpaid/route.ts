import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireTeacher, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { reopenPayment } from '@/services/payments';
import { loadOwnedPayment, respondPaymentOutcome } from '../shared';

/** Undo for a mistaken "mark paid" or "not charged" — same ownership chain as /paid. */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const owned = await loadOwnedPayment(id, session.teacherId);
  if (!owned.ok) return owned.response;

  // Ownership is settled above; only past it may the service answer `unchanged`.
  return respondPaymentOutcome(await reopenPayment(prisma, id));
});
