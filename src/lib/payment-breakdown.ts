import type { ClassStatus, PaymentStatus, Prisma } from '@prisma/client';

/** The lines of a completed class's breakdown, in whole cents. */
export interface PaymentBreakdownLines {
  roomCents: number;
  teacherCents: number;
  totalCents: number;
  students: number;
  shareCents: number;
}

export type PaymentBreakdownResult =
  | { kind: 'shown'; lines: PaymentBreakdownLines }
  | { kind: 'hidden' }
  | { kind: 'snapshot_missing' };

export interface ResolvePaymentBreakdownInput {
  classStatus: ClassStatus;
  roomCost: Prisma.Decimal;
  totalRevenue: Prisma.Decimal | null;
  totalStudents: number | null;
  payment: { status: PaymentStatus; amount: Prisma.Decimal } | null;
}

/**
 * Whether a payment in this status shows the class's breakdown. A waived
 * payment does not. Exhaustive over the enum, so a new status is a compile
 * error here until it is decided.
 */
const SHOWS_BREAKDOWN = {
  pending: true,
  paid: true,
  overdue: true,
  not_charged: false,
} as const satisfies Record<PaymentStatus, boolean>;

/** A value with at most two decimal places, as whole cents; `mul` keeps it exact. */
function toCents(value: Prisma.Decimal): number {
  return value.mul(100).toNumber();
}

/**
 * Whether a past-class row shows where the student's payment went, and the
 * lines it shows — read from the completion snapshot, never recomputed.
 *
 * The snapshot check sits before the payment checks so a completed class with
 * no snapshot is reported whatever its payment's status. Why the teacher line
 * is a subtraction, and why a missing snapshot is a defect rather than a
 * hidden row: docs/superpowers/specs/2026-09-14-past-class-payment-breakdown-design.md.
 */
export function resolvePaymentBreakdown(input: ResolvePaymentBreakdownInput): PaymentBreakdownResult {
  const { classStatus, roomCost, totalRevenue, totalStudents, payment } = input;

  if (classStatus !== 'completed') return { kind: 'hidden' };
  if (totalRevenue === null || totalStudents === null) return { kind: 'snapshot_missing' };
  if (payment === null || !SHOWS_BREAKDOWN[payment.status]) return { kind: 'hidden' };

  const roomCents = toCents(roomCost);
  const totalCents = toCents(totalRevenue);
  return {
    kind: 'shown',
    lines: {
      roomCents,
      teacherCents: totalCents - roomCents,
      totalCents,
      students: totalStudents,
      shareCents: toCents(payment.amount),
    },
  };
}
