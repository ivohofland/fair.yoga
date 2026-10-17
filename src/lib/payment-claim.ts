import type { Payment } from '@/lib/prisma-client';
import { isOutstanding } from '@/lib/payment-status';
import { paymentStateText } from '@/lib/format';

/**
 * Is the student's "I've sent it" still awaiting the teacher's confirmation?
 * Derived, never stored: the payment is still owed and its student has marked
 * it sent. The timestamp alone does not answer this, because it outlives
 * settlement (`docs/data-model.md`, Payment).
 *
 * The Prisma import is type-only, so a client component can import this.
 */
export function isClaimStanding(payment: Pick<Payment, 'status' | 'studentReportedAt'>): boolean {
  return isOutstanding(payment.status) && payment.studentReportedAt !== null;
}

/**
 * The payment state as the student reads it. A standing claim replaces the
 * status: the student has done their part, so the row says that instead of
 * asking again.
 */
export function studentPaymentStateText(
  payment: Pick<Payment, 'status' | 'studentReportedAt'>,
): { label: string; className: string } {
  if (isClaimStanding(payment)) return { label: 'Marked as sent', className: 'text-brown' };
  return paymentStateText(payment.status);
}

/**
 * The rows whose payment has a standing claim first, each group in its given
 * order: a claim is the payment a teacher can settle by checking their bank,
 * so it leads the list it sits in. Returns a new array.
 */
export function claimedFirst<T>(
  rows: readonly T[],
  paymentOf: (row: T) => Pick<Payment, 'status' | 'studentReportedAt'>,
): T[] {
  const claimed = (row: T) => isClaimStanding(paymentOf(row));
  return [...rows.filter(claimed), ...rows.filter((row) => !claimed(row))];
}
