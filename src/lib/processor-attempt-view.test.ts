import { describe, it, expect } from 'vitest';
import { Prisma, type ProcessorPaymentStatus, type ProcessorRefundStatus } from '@/lib/prisma-client';
import { attemptRefundState, settlingAttempt, toAttemptView, type AttemptView } from './processor-attempt-view';
import { isRefundStatus } from './processor-refund-status';

function attempt(over: Partial<AttemptView> = {}): AttemptView {
  return {
    id: 'att-1', method: 'ideal', status: 'paid', settledPayment: true, chargedBackAt: null, amount: 10, currency: 'EUR', refunds: [],
    ...over,
  };
}

const refunds = (...statuses: ProcessorRefundStatus[]) => statuses.map((status) => ({ status }));

describe('attemptRefundState', () => {
  it('offers a refund on a paid attempt with no refund', () => {
    expect(attemptRefundState(attempt())).toBe('refundable');
  });

  it.each(['queued', 'pending', 'processing'] as const)('is pending while a refund is %s', (status) => {
    expect(attemptRefundState(attempt({ refunds: refunds('failed', status) }))).toBe('pending');
  });

  it('is refunded once a refund is refunded', () => {
    expect(attemptRefundState(attempt({ settledPayment: false, refunds: refunds('failed', 'refunded') }))).toBe('refunded');
  });

  it('offers the refund again after one failed', () => {
    expect(attemptRefundState(attempt({ refunds: refunds('failed') }))).toBe('failed');
  });

  it('offers the refund again, without saying it failed, after Mollie canceled one', () => {
    expect(attemptRefundState(attempt({ refunds: refunds('canceled') }))).toBe('refundable');
  });

  it('offers nothing on a charged-back attempt', () => {
    expect(attemptRefundState(attempt({ settledPayment: false, chargedBackAt: new Date() }))).toBe('none');
  });

  it.each(['open', 'pending', 'authorized', 'canceled', 'expired', 'failed'] as const satisfies readonly ProcessorPaymentStatus[])(
    'offers nothing on an attempt that is %s',
    (status) => {
      expect(attemptRefundState(attempt({ status, settledPayment: false }))).toBe('none');
    },
  );
});

describe('settlingAttempt', () => {
  it('names the attempt that settled the payment', () => {
    const settling = attempt({ id: 'att-2' });
    expect(settlingAttempt([attempt({ id: 'att-1', settledPayment: false }), settling])).toBe(settling);
  });

  it('is null when no attempt settled it, a charged-back one included', () => {
    expect(settlingAttempt([attempt({ settledPayment: false, chargedBackAt: new Date() })])).toBeNull();
  });
});

describe('toAttemptView', () => {
  it('carries the amount as a number', () => {
    const view = toAttemptView({ ...attempt(), amount: new Prisma.Decimal('12.50') });
    expect(view.amount).toBe(12.5);
  });
});

describe('isRefundStatus', () => {
  it.each(['queued', 'refunded', 'canceled'])('accepts %s', (status) => {
    expect(isRefundStatus(status)).toBe(true);
  });

  it.each(['toString', 'done', 3, null])('refuses %s', (value) => {
    expect(isRefundStatus(value)).toBe(false);
  });
});
