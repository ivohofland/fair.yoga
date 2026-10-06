import { describe, it, expect } from 'vitest';
import { formatDayHeader } from '@/lib/format';
import { hhmmToTime } from '@/lib/time-of-day';
import { studentPaymentRequestBody, studentPaymentReminderBody } from './payment-request-copy';

const cls = { classType: 'Vinyasa', date: new Date('2026-10-06'), startTime: hhmmToTime('19:00') };
const when = `Vinyasa class on ${formatDayHeader(cls.date)} at 19:00`;
const TAIL_DIRECT = "Pay your teacher directly — if this isn't right, talk to your teacher.";
const TAIL_WITH_METHODS = "If this isn't right, talk to your teacher.";

describe('studentPaymentRequestBody', () => {
  describe('when the teacher has no payment method', () => {
    it.each(['registered', 'attended'] as const)('tells %s to pay the teacher directly', (status) => {
      expect(studentPaymentRequestBody(status, cls, 12.4, false, 'EUR')).toBe(
        `Your price for ${when} is €12.40. Pay your teacher directly.`,
      );
    });

    it('opens a no-show with "We missed you" and explains the charge', () => {
      expect(studentPaymentRequestBody('no_show', cls, 12.4, false, 'EUR')).toBe(
        `We missed you at ${when}. Booked spots share the class cost, so your price is €12.40. ${TAIL_DIRECT}`,
      );
    });

    it('tells a late cancel it was after the deadline', () => {
      expect(studentPaymentRequestBody('late_cancel', cls, 12.4, false, 'EUR')).toBe(
        `You cancelled your booking for ${when} after the cancellation deadline. Booked spots share the class cost, so your price is €12.40. ${TAIL_DIRECT}`,
      );
    });
  });

  // The email carries a Pay now button instead, so the body does not send
  // the student around the pay page.
  describe('when the teacher has a payment method', () => {
    it.each(['registered', 'attended'] as const)('states only the price for %s', (status) => {
      expect(studentPaymentRequestBody(status, cls, 12.4, true, 'EUR')).toBe(`Your price for ${when} is €12.40.`);
    });

    it('explains a no-show charge without "Pay your teacher directly"', () => {
      expect(studentPaymentRequestBody('no_show', cls, 12.4, true, 'EUR')).toBe(
        `We missed you at ${when}. Booked spots share the class cost, so your price is €12.40. ${TAIL_WITH_METHODS}`,
      );
    });

    it('explains a late-cancel charge without "Pay your teacher directly"', () => {
      expect(studentPaymentRequestBody('late_cancel', cls, 12.4, true, 'EUR')).toBe(
        `You cancelled your booking for ${when} after the cancellation deadline. Booked spots share the class cost, so your price is €12.40. ${TAIL_WITH_METHODS}`,
      );
    });
  });

  it.each([true, false])('refuses a cancelled registration, which is never charged (methods: %s)', (hasMethods) => {
    expect(() => studentPaymentRequestBody('cancelled', cls, 12.4, hasMethods, 'EUR')).toThrow(/not charged/);
  });
});

describe('studentPaymentReminderBody', () => {
  it('tells the student to pay directly when the teacher has no payment method', () => {
    expect(studentPaymentReminderBody(cls, 12.4, false, 'EUR')).toBe(
      `€12.40 for ${when} is still open. Pay your teacher directly.`,
    );
  });

  it('states only what is open when the teacher has a payment method', () => {
    expect(studentPaymentReminderBody(cls, 12.4, true, 'EUR')).toBe(`€12.40 for ${when} is still open.`);
  });

  it('keeps two decimals for a whole amount', () => {
    expect(studentPaymentReminderBody(cls, 15, true, 'EUR')).toBe(`€15.00 for ${when} is still open.`);
  });
});

describe('currency', () => {
  it('renders a reminder in the class currency', () => {
    expect(studentPaymentReminderBody(cls, 12, true, 'GBP')).toBe(`£12.00 for ${when} is still open.`);
  });

  it('renders a request in the class currency', () => {
    expect(studentPaymentRequestBody('attended', cls, 12, true, 'CHF')).toBe(
      `Your price for ${when} is CHF 12.00.`,
    );
  });
});
