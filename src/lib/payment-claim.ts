import type { Payment } from '@/lib/prisma-client';
import { isOutstanding } from '@/lib/payment-status';

/**
 * Is the student's "I've sent it" still awaiting the teacher's confirmation?
 * Derived, never stored: the payment is still owed and its student has marked
 * it sent. A paid payment keeps `studentReportedAt` as the student's half of
 * the record, so the timestamp alone does not answer this.
 *
 * The Prisma import is type-only, so a client component can import this.
 */
export function isClaimStanding(payment: Pick<Payment, 'status' | 'studentReportedAt'>): boolean {
  return isOutstanding(payment.status) && payment.studentReportedAt !== null;
}
