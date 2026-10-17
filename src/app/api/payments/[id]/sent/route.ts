import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireStudent, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { reportPaymentSent, withdrawPaymentReport } from '@/services/payments';
import { respondPaymentOutcome } from '../shared';

// Ownership is the services' to decide; see `reportPaymentSent`.

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  return respondPaymentOutcome(await reportPaymentSent(prisma, id, session.studentId));
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  return respondPaymentOutcome(await withdrawPaymentReport(prisma, id, session.studentId));
});
