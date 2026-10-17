import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireStudent, isErrorResponse, withErrorHandler } from '@/lib/api-utils';
import { reportPaymentSent, withdrawPaymentReport } from '@/services/payments';
import { respondStudentPaymentOutcome } from '../shared';

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  // No ownership gate here: the service scopes the payment to `session.studentId`.
  return respondStudentPaymentOutcome(await reportPaymentSent(prisma, id, session.studentId));
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  // No ownership gate here: the service scopes the payment to `session.studentId`.
  return respondStudentPaymentOutcome(await withdrawPaymentReport(prisma, id, session.studentId));
});
