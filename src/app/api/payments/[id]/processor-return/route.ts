import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isErrorResponse, requireStudent, withErrorHandler } from '@/lib/api-utils';
import { syncAttempt } from '@/services/processor-attempts';
import { mollieDeps } from '@/services/mollie-deps';

/**
 * Where Mollie sends the student back. Applies the attempt's status as the
 * webhook would, since the webhook may not have arrived, then sends the
 * student to the pay page naming the attempt; a sync that could not reach
 * Mollie still redirects. Both lookups are keyed by the session's own
 * student: another student's attempt is not synced, and another student's
 * payment sends them to their bookings.
 */
export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;
  const { id } = await params;
  const attemptId = request.nextUrl.searchParams.get('attempt');

  const payment = await prisma.payment.findFirst({
    where: { id, registration: { studentId: session.studentId } },
    select: { registration: { select: { classId: true } } },
  });
  if (payment === null) return NextResponse.redirect(new URL('/bookings', request.url), 303);

  const payPage = new URL(`/bookings/${encodeURIComponent(payment.registration.classId)}/pay`, request.url);
  if (attemptId === null) return NextResponse.redirect(payPage, 303);
  payPage.searchParams.set('attempt', attemptId);

  const attempt = await prisma.processorPayment.findFirst({
    where: { id: attemptId, paymentId: id, payment: { registration: { studentId: session.studentId } } },
    select: { processorPaymentId: true },
  });
  if (attempt !== null) await syncAttempt(prisma, mollieDeps(), attempt.processorPaymentId);
  return NextResponse.redirect(payPage, 303);
});
