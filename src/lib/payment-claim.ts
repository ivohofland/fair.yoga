import type { Payment, ProcessorPaymentStatus } from '@/lib/prisma-client';
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

/** What `inProgress` reads: the claim's columns and the payment's Mollie attempts. */
export type InProgressInput = Pick<Payment, 'status' | 'studentReportedAt'> & {
  readonly processorAttempts: readonly { readonly status: ProcessorPaymentStatus }[];
};

/** Mollie's statuses for a payment the student has made that has not yet arrived. */
const MOVING: ReadonlySet<ProcessorPaymentStatus> = new Set<ProcessorPaymentStatus>(['pending', 'authorized']);

/** Is an outstanding payment's Mollie attempt paid by the student and not yet confirmed? An `open` one is not: a tap is not a payment. */
export function attemptProcessing(payment: InProgressInput): boolean {
  return isOutstanding(payment.status) && payment.processorAttempts.some((a) => MOVING.has(a.status));
}

/**
 * Is the money for this payment on its way? A standing claim, or a Mollie
 * attempt that is processing: the same display state either way.
 */
export function inProgress(payment: InProgressInput): boolean {
  return isClaimStanding(payment) || attemptProcessing(payment);
}

/**
 * The rows whose payment is `inProgress` first, each group in its given
 * order: that money is already moving, so it leads the list it sits in.
 * Returns a new array.
 */
export function inProgressFirst<T>(rows: readonly T[], paymentOf: (row: T) => InProgressInput): T[] {
  const lifted = (row: T) => inProgress(paymentOf(row));
  return [...rows.filter(lifted), ...rows.filter((row) => !lifted(row))];
}
