import type { Prisma, ProcessorRefundStatus } from '@/lib/prisma-client';

/** The attempt columns a teacher's payment row shows: what Mollie took, and what became of it. */
export const TEACHER_ATTEMPT_SELECT = {
  id: true,
  method: true,
  status: true,
  settledPayment: true,
  chargedBackAt: true,
  amount: true,
  currency: true,
  refunds: { select: { status: true } },
} as const satisfies Prisma.ProcessorPaymentSelect;

export type TeacherAttempt = Prisma.ProcessorPaymentGetPayload<{ select: typeof TEACHER_ATTEMPT_SELECT }>;

/** `TeacherAttempt` as a client component receives it, its amount a number. */
export type AttemptView = Omit<TeacherAttempt, 'amount'> & { amount: number };

export function toAttemptView(attempt: TeacherAttempt): AttemptView {
  return { ...attempt, amount: attempt.amount.toNumber() };
}

/**
 * What the teacher's row offers for one attempt. `refundable`: Mollie took
 * the money and no refund of it stands. `failed`: the same, after a refund
 * that failed. `pending`: a refund is on its way. `refunded`: it went back.
 * `none`: nothing to refund — Mollie never took the money, or the student's
 * bank took it back.
 */
export type AttemptRefundState = 'refundable' | 'failed' | 'pending' | 'refunded' | 'none';

type RefundStage = 'live' | 'refunded' | 'failed' | 'canceled';

const STAGE_OF = {
  queued: 'live',
  pending: 'live',
  processing: 'live',
  refunded: 'refunded',
  failed: 'failed',
  canceled: 'canceled',
} as const satisfies Record<ProcessorRefundStatus, RefundStage>;

/** Whether `value` is a `ProcessorRefundStatus`, as a client reads one off the wire. */
export function isRefundStatus(value: unknown): value is ProcessorRefundStatus {
  return typeof value === 'string' && Object.hasOwn(STAGE_OF, value);
}

export function attemptRefundState(attempt: Pick<AttemptView, 'status' | 'chargedBackAt' | 'refunds'>): AttemptRefundState {
  if (attempt.status !== 'paid' || attempt.chargedBackAt !== null) return 'none';
  const stages = new Set<RefundStage>(attempt.refunds.map((r) => STAGE_OF[r.status]));
  if (stages.has('refunded')) return 'refunded';
  if (stages.has('live')) return 'pending';
  return stages.has('failed') ? 'failed' : 'refundable';
}

/** The attempt that settled the payment, while one does: Decision 17's Refund stands where "Mark unpaid" would. */
export function settlingAttempt<T extends Pick<AttemptView, 'settledPayment'>>(attempts: readonly T[]): T | null {
  return attempts.find((a) => a.settledPayment) ?? null;
}
