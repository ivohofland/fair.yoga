import { describe, it, expect } from 'vitest';
import { Prisma, type Payment } from '@prisma/client';
import { respondPaymentOutcome } from './shared';
import { PAYMENT_GONE, type PaymentRefusal } from '@/services/payments';
import { expectApplied, expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';

const payment: Payment = {
  id: 'pay-1',
  registrationId: 'reg-1',
  amount: new Prisma.Decimal('12.50'),
  status: 'paid',
  method: 'cash',
  processorRef: null,
  reminderSentAt: null,
  paidAt: new Date('2026-09-01T10:00:00.000Z'),
  notChargedAt: null,
  createdAt: new Date('2026-09-01T09:00:00.000Z'),
  updatedAt: new Date('2026-09-01T10:00:00.000Z'),
};

describe('respondPaymentOutcome', () => {
  it('answers an applied action 200 with the row and no outcome', async () => {
    const data = await expectApplied(respondPaymentOutcome({ kind: 'applied', payment }));
    expect(data).toMatchObject({ id: 'pay-1', status: 'paid', method: 'cash' });
  });

  it('answers an unchanged action 200 with the row and outcome unchanged', async () => {
    const data = await expectUnchanged(respondPaymentOutcome({ kind: 'unchanged', payment }));
    expect(data).toMatchObject({ id: 'pay-1', status: 'paid', method: 'cash' });
  });

  it('answers a vanished payment 404 NOT_FOUND', async () => {
    await expectRefusal(respondPaymentOutcome({ kind: 'refused', refusal: PAYMENT_GONE }), 'NOT_FOUND');
  });

  /**
   * Every `PaymentRefusal` code other than `NOT_FOUND`, which has its own test
   * above. The `Record<..., true>` ties this roster to `PaymentRefusal['code']`
   * in both directions: a code added to the union without a key here fails to
   * compile, and `Exclude<>` names `NOT_FOUND`'s omission as a decision rather
   * than leaving it invisible to a reader (or the compiler) as a member the
   * list simply forgot.
   */
  const OTHER_REFUSAL_CODES = {
    CONCURRENT_MODIFICATION: true,
    PAYMENT_ALREADY_PAID: true,
    PAYMENT_SETTLED: true,
    PAYMENT_WAIVED: true,
  } as const satisfies Record<Exclude<PaymentRefusal['code'], 'NOT_FOUND'>, true>;

  it.each(Object.keys(OTHER_REFUSAL_CODES) as (keyof typeof OTHER_REFUSAL_CODES)[])(
    'answers a %s refusal at its registered status',
    async (code) => {
      await expectRefusal(
        respondPaymentOutcome({ kind: 'refused', refusal: { code, message: 'Words.' } }),
        code,
      );
    },
  );
});
