import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isErrorResponse, requireStudent, withErrorHandler } from '@/lib/api-utils';
import { log } from '@/lib/log';
import { syncAttempt } from '@/services/processor-attempts';
import { mollieDeps } from '@/services/mollie-deps';

/**
 * Where Mollie sends the student back. Always redirects. With the student's
 * session it applies the attempt's status as the webhook would, since the
 * webhook may not have arrived, then sends the student to the pay page,
 * naming the attempt only when it is theirs. A sync that fails is logged and
 * still redirects: the webhook settles the payment. Without a student
 * session it sends the visitor to sign in, returning to that pay page when
 * the attempt names this payment and to their bookings otherwise.
 */
export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const attemptId = request.nextUrl.searchParams.get('attempt');
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url), 303);

  const session = await requireStudent(request);
  if (isErrorResponse(session)) {
    const named = attemptId === null
      ? null
      : await prisma.processorPayment.findFirst({
          where: { id: attemptId, paymentId: id },
          select: { payment: { select: { registration: { select: { classId: true } } } } },
        });
    const back = named === null || attemptId === null
      ? '/bookings'
      : payPagePath(named.payment.registration.classId, attemptId);
    return to(`/login?redirect=${encodeURIComponent(back)}`);
  }

  const payment = await prisma.payment.findFirst({
    where: { id, registration: { studentId: session.studentId } },
    select: { registration: { select: { classId: true } } },
  });
  if (payment === null) return to('/bookings');
  const classId = payment.registration.classId;

  const attempt = attemptId === null
    ? null
    : await prisma.processorPayment.findFirst({
        where: { id: attemptId, paymentId: id, payment: { registration: { studentId: session.studentId } } },
        select: { processorPaymentId: true },
      });
  if (attempt === null || attemptId === null) return to(payPagePath(classId, null));

  try {
    await syncAttempt(prisma, mollieDeps(), attempt.processorPaymentId);
  } catch (err) {
    log.error({ err, paymentId: id, attemptId }, 'syncing a Mollie attempt on return failed; the webhook will settle it');
  }
  return to(payPagePath(classId, attemptId));
});

function payPagePath(classId: string, attemptId: string | null): string {
  const path = `/bookings/${encodeURIComponent(classId)}/pay`;
  return attemptId === null ? path : `${path}?attempt=${encodeURIComponent(attemptId)}`;
}
