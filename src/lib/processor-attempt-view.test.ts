import { describe, it, expect } from 'vitest';
import { Prisma, type ProcessorPaymentStatus, type ProcessorRefundStatus } from '@/lib/prisma-client';
import { attemptRefundState, settlingAttempt, toAttemptView, type AttemptView } from './processor-attempt-view';
import { isRefundStatus } from './processor-refund-status';

/** `attempt()` as the loader reads it, before `toAttemptView`. */
function stored(connection: { revokedAt: Date | null } | null, amount: string) {
  const { id, method, status, settledPayment, chargedBackAt, currency, refunds } = attempt();
  return { id, method, status, settledPayment, chargedBackAt, currency, refunds, amount: new Prisma.Decimal(amount), connection };
}

function attempt(over: Partial<AttemptView> = {}): AttemptView {
  return {
    id: 'att-1', method: 'ideal', status: 'paid', settledPayment: true, chargedBackAt: null, grantHeld: true, amount: 10, currency: 'EUR', refunds: [],
    ...over,
  };
}

const refunds = (...statuses: ProcessorRefundStatus[]) => statuses.map((status) => ({ status }));

describe('attemptRefundState', () => {
  it('offers nothing to refund once the grant is gone', () => {
    expect(attemptRefundState(attempt({ grantHeld: false }))).toBe('none');
    expect(attemptRefundState(attempt({ grantHeld: false, refunds: refunds('failed') }))).toBe('none');
  });

  it('still shows a refund that stands after the grant is gone', () => {
    expect(attemptRefundState(attempt({ grantHeld: false, refunds: refunds('refunded') }))).toBe('refunded');
    expect(attemptRefundState(attempt({ grantHeld: false, refunds: refunds('pending') }))).toBe('pending');
  });

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

  it('is null when the settling attempt’s grant is gone, so the row offers Mark unpaid', () => {
    expect(settlingAttempt([attempt({ grantHeld: false })])).toBeNull();
  });
});

describe('toAttemptView', () => {
  it('carries the amount as a number', () => {
    const view = toAttemptView(stored({ revokedAt: null }, '12.50'));
    expect(view.amount).toBe(12.5);
  });

  it.each([
    ['an unrevoked connection', { revokedAt: null }, true],
    ['a revoked connection', { revokedAt: new Date() }, false],
    ['no connection', null, false],
  ] as const)('holds the grant with %s: %s', (_label, connection, held) => {
    const view = toAttemptView(stored(connection, '10.00'));
    expect(view.grantHeld).toBe(held);
    expect(view).not.toHaveProperty('connection');
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
