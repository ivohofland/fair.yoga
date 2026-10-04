import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import { formatInstantInZone } from '@/lib/timezone';
import { markedPaidLine, reportMissingPayment } from './pay-page.server';

describe('markedPaidLine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names when the payment was marked paid, and reports nothing', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const paidAt = new Date('2026-06-05T10:00:00.000Z');
    expect(markedPaidLine(paidAt, 'UTC', 'pay-1')).toBe(`Marked paid ${formatInstantInZone(paidAt, 'UTC')}.`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says only "Marked paid." without a timestamp, and reports PAYMENT_PAID_WITHOUT_TIMESTAMP', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(markedPaidLine(null, 'UTC', 'pay-1')).toBe('Marked paid.');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PAYMENT_PAID_WITHOUT_TIMESTAMP', paymentId: 'pay-1' }),
      'paid payment has no paidAt; the pay page names no date',
    );
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
      reportMissingPayment({ ...IDS, registrationStatus, classStatus: 'completed' });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'CHARGED_REGISTRATION_WITHOUT_PAYMENT', classId: 'class-1', registrationId: 'reg-1' }),
        'charged registration on a completed class has no payment; the pay page answered not found',
      );
    },
  );

  it('reports nothing for a cancelled registration, which is never charged', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    reportMissingPayment({ ...IDS, registrationStatus: 'cancelled', classStatus: 'completed' });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['draft', 'open', 'in_progress'] as const)('reports nothing on a %s class, which has no payments yet', (classStatus) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    reportMissingPayment({ ...IDS, registrationStatus: 'attended', classStatus });
    expect(warn).not.toHaveBeenCalled();
  });
});
