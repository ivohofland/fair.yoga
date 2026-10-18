import type { Prisma } from '@/lib/prisma-client';
import { ATTEMPT_GRANT_SELECT, canRefundThroughGrant } from '@/lib/processor-liveness';
import { REFUND_STAGE, type RefundStage } from '@/lib/processor-refund-status';

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
  ...ATTEMPT_GRANT_SELECT,
} as const satisfies Prisma.ProcessorPaymentSelect;

export type TeacherAttempt = Prisma.ProcessorPaymentGetPayload<{ select: typeof TEACHER_ATTEMPT_SELECT }>;

/**
 * `TeacherAttempt` as a client component receives it: its amount a number,
 * and its connection read down to `grantHeld`, which is
 * `canRefundThroughGrant`'s answer.
 */
export type AttemptView = Omit<TeacherAttempt, 'amount' | 'connection'> & { amount: number; grantHeld: boolean };

export function toAttemptView(attempt: TeacherAttempt): AttemptView {
  const { connection, amount, ...rest } = attempt;
  return { ...rest, amount: amount.toNumber(), grantHeld: canRefundThroughGrant({ connection }) };
}

/**
 * What the teacher's row offers for one attempt. `refundable`: Mollie took
 * the money and no refund of it stands. `failed`: the same, after a refund
 * that failed. `pending`: a refund is on its way. `refunded`: it went back.
 * `none`: nothing to refund — Mollie never took the money, the student's
 * bank took it back, or fair.yoga can no longer refund through the
 * attempt's grant (`grantHeld`).
 */
export type AttemptRefundState = 'refundable' | 'failed' | 'pending' | 'refunded' | 'none';

export function attemptRefundState(attempt: Pick<AttemptView, 'status' | 'chargedBackAt' | 'refunds' | 'grantHeld'>): AttemptRefundState {
  if (attempt.status !== 'paid' || attempt.chargedBackAt !== null) return 'none';
  const stages = new Set<RefundStage>(attempt.refunds.map((r) => REFUND_STAGE[r.status]));
  if (stages.has('refunded')) return 'refunded';
  if (stages.has('live')) return 'pending';
  if (!attempt.grantHeld) return 'none';
  return stages.has('failed') ? 'failed' : 'refundable';
}

/**
 * The attempt that settled the payment while fair.yoga can still refund
 * through it: Decision 17's Refund stands where "Mark unpaid" would. Null
 * once that attempt's grant is gone, so the row offers "Mark unpaid" again.
 */
export function settlingAttempt<T extends Pick<AttemptView, 'settledPayment' | 'grantHeld'>>(attempts: readonly T[]): T | null {
  return attempts.find((a) => a.settledPayment && a.grantHeld) ?? null;
}
