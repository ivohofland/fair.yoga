import type { ProcessorRefundStatus } from '@/lib/prisma-client';

/**
 * Where a refund stands. `live`: Mollie has not finished it, so a webhook is
 * still owed. `refunded`: the money went back. `failed` and `canceled`: it
 * ended at Mollie with no money moved.
 */
export type RefundStage = 'live' | 'refunded' | 'failed' | 'canceled';

/** Every `ProcessorRefundStatus` and its stage; the groupings below read only this map. */
export const REFUND_STAGE = {
  queued: 'live',
  pending: 'live',
  processing: 'live',
  refunded: 'refunded',
  failed: 'failed',
  canceled: 'canceled',
} as const satisfies Record<ProcessorRefundStatus, RefundStage>;

const STATUSES = Object.keys(REFUND_STAGE) as ProcessorRefundStatus[];

/** Whether `value` is a `ProcessorRefundStatus`, as Mollie's answer or a client reads one off the wire. */
export function isRefundStatus(value: unknown): value is ProcessorRefundStatus {
  return typeof value === 'string' && Object.hasOwn(REFUND_STAGE, value);
}

/** Whether Mollie still owes a webhook for a refund in this status. */
export function refundIsLive(status: ProcessorRefundStatus): boolean {
  return REFUND_STAGE[status] === 'live';
}

/** The statuses `refundIsLive` holds for, as a query's `in` list. */
export const LIVE_REFUND_STATUSES: readonly ProcessorRefundStatus[] = STATUSES.filter(refundIsLive);

/** Whether a stored row in this status never moves again: its outcome applied, the teacher was told it failed, or Mollie canceled it. */
export function refundIsFinal(status: ProcessorRefundStatus): boolean {
  return REFUND_STAGE[status] !== 'live';
}

/**
 * Whether a refund in this status ended at Mollie with no money moved. These
 * are the statuses the partial unique index `ProcessorRefund_one_live_per_attempt`
 * leaves out, so every other refund of an attempt counts against it.
 */
export function refundEndedAtMollie(status: ProcessorRefundStatus): boolean {
  const stage = REFUND_STAGE[status];
  return stage === 'failed' || stage === 'canceled';
}
