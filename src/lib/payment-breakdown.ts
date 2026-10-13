import { teacherEarningsCents } from '@/lib/teacher-earnings';
import type { ClassStatus, PaymentStatus, Prisma } from '@prisma/client';

/** The lines of a completed class's breakdown, in whole cents. */
export interface PaymentBreakdownLines {
  roomCents: number;
  vatCents: number;
  /** Whether the class charges VAT, which its VAT line can round to nothing under. */
  chargesVat: boolean;
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
  vatTotal: Prisma.Decimal | null;
  /** The class's VAT percentage; what decides whether the breakdown names VAT. */
  vatPercent: number;
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

/** Converts a value with at most two decimal places to whole cents; `mul` keeps it exact. */
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
  const { classStatus, roomCost, totalRevenue, vatTotal, vatPercent, totalStudents, payment } = input;

  if (classStatus !== 'completed') return { kind: 'hidden' };
  if (totalRevenue === null || vatTotal === null || totalStudents === null) return { kind: 'snapshot_missing' };
  if (payment === null || !SHOWS_BREAKDOWN[payment.status]) return { kind: 'hidden' };

  const roomCents = toCents(roomCost);
  const totalCents = toCents(totalRevenue);
  const vatCents = toCents(vatTotal);
  return {
    kind: 'shown',
    lines: {
      roomCents,
      vatCents,
      chargesVat: vatPercent > 0,
      teacherCents: teacherEarningsCents({ totalCents, roomCents, vatCents }),
      totalCents,
      students: totalStudents,
      shareCents: toCents(payment.amount),
    },
  };
}
