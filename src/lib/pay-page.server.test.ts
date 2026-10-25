import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import { formatInstantInZone } from '@/lib/timezone';
import { markedPaidLine, offersSentClaim, reportMissingPayment, sentClaimLine } from './pay-page.server';

describe('markedPaidLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names when the payment was marked paid, and reports nothing', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const paidAt = new Date('2026-06-05T10:00:00.000Z');
    expect(markedPaidLine(paidAt, 'manual', 'UTC', 'pay-1')).toBe(`Marked paid ${formatInstantInZone(paidAt, 'UTC')}.`);
    expect(markedPaidLine(paidAt, null, 'UTC', 'pay-1')).toBe(`Marked paid ${formatInstantInZone(paidAt, 'UTC')}.`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says "Paid <date>." for a payment Mollie settled, since nobody marked it', () => {
    const paidAt = new Date('2026-06-05T10:00:00.000Z');
    expect(markedPaidLine(paidAt, 'mollie', 'UTC', 'pay-1')).toBe(`Paid ${formatInstantInZone(paidAt, 'UTC')}.`);
  });

  it('says only "Marked paid." without a timestamp, and reports PAYMENT_PAID_WITHOUT_TIMESTAMP', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(markedPaidLine(null, 'manual', 'UTC', 'pay-1')).toBe('Marked paid.');
    expect(markedPaidLine(null, 'mollie', 'UTC', 'pay-2')).toBe('Paid.');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PAYMENT_PAID_WITHOUT_TIMESTAMP', paymentId: 'pay-1' }),
      'paid payment has no paidAt; the pay page names no date',
    );
  });
});

describe('offersSentClaim', () => {
  const ideal = { kind: 'processor', method: 'ideal' } as const;
  const link = { kind: 'payment_link', url: 'https://pay.example/anna', host: 'pay.example' } as const;

  it('offers it beside a row paid outside Mollie', () => {
    expect(offersSentClaim([ideal, link], null)).toBe(true);
  });

  it('does not offer it when every row is Mollie, which settles itself', () => {
    expect(offersSentClaim([ideal], null)).toBe(false);
  });

  it('still shows a claim that stands, so it can be withdrawn', () => {
    expect(offersSentClaim([ideal], new Date())).toBe(true);
  });
});

describe('sentClaimLine', () => {
  it('names the day in the given zone, not the time', () => {
    const at = new Date('2026-10-17T23:30:00.000Z');
    expect(sentClaimLine(at, 'UTC')).toBe('You marked this as sent on 17 Oct.');
    expect(sentClaimLine(at, 'Europe/Amsterdam')).toBe('You marked this as sent on 18 Oct.');
  });
});

describe('reportMissingPayment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const IDS = { classId: 'class-1', registrationId: 'reg-1' };

  it.each(['registered', 'attended', 'no_show', 'late_cancel'] as const)(
    'reports CHARGED_REGISTRATION_WITHOUT_PAYMENT for a %s registration on a completed class',
    (registrationStatus) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      reportMissingPayment({ ...IDS, registrationStatus, classStatus: 'completed', pricingMode: 'tiered' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'CHARGED_REGISTRATION_WITHOUT_PAYMENT', classId: 'class-1', registrationId: 'reg-1' }),
        'charged registration on a completed class has no payment; the pay page answered not found',
      );
    },
  );

  it('reports nothing for a cancelled registration, which is never charged', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    reportMissingPayment({ ...IDS, registrationStatus: 'cancelled', classStatus: 'completed', pricingMode: 'tiered' });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['draft', 'open', 'in_progress'] as const)('reports nothing on a %s class, which has no payments yet', (classStatus) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    reportMissingPayment({ ...IDS, registrationStatus: 'attended', classStatus, pricingMode: 'tiered' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('records nothing for a donation class, which never has a payment (#912)', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    reportMissingPayment({ classId: 'c', registrationId: 'r', registrationStatus: 'attended', classStatus: 'completed', pricingMode: 'donation' });
    expect(warn).not.toHaveBeenCalled();
  });
});
