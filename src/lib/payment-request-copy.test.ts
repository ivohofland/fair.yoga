import { describe, it, expect } from 'vitest';
import { formatDayHeader } from '@/lib/format';
import { hhmmToTime } from '@/lib/time-of-day';
import { studentPaymentRequestBody } from './payment-request-copy';

const cls = { classType: 'Vinyasa', date: new Date('2026-10-06'), startTime: hhmmToTime('19:00') };
const when = `Vinyasa class on ${formatDayHeader(cls.date)} at 19:00`;
const TAIL = "Pay your teacher directly — if this isn't right, talk to your teacher.";

describe('studentPaymentRequestBody', () => {
  it.each(['registered', 'attended'] as const)('keeps the neutral wording for %s', (status) => {
    expect(studentPaymentRequestBody(status, cls, 12.4)).toBe(
      `Your price for ${when} is €12.40. Pay your teacher directly.`,
    );
  });

  it('opens a no-show with "We missed you" and explains the charge', () => {
    expect(studentPaymentRequestBody('no_show', cls, 12.4)).toBe(
      `We missed you at ${when}. Booked spots share the class cost, so your price is €12.40. ${TAIL}`,
    );
  });

  it('tells a late cancel it was after the deadline', () => {
    expect(studentPaymentRequestBody('late_cancel', cls, 12.4)).toBe(
      `You cancelled ${when} after the cancellation deadline. Booked spots share the class cost, so your price is €12.40. ${TAIL}`,
    );
  });

  it('refuses a cancelled registration, which is never charged', () => {
    expect(() => studentPaymentRequestBody('cancelled', cls, 12.4)).toThrow(/not charged/);
  });
});
