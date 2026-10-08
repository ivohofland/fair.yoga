import { describe, it, expect } from 'vitest';
import { formatDayHeader } from '@/lib/format';
import { hhmmToTime } from '@/lib/time-of-day';
import { PAYMENTS_PAUSED_COPY } from './payment-methods';
import { studentPaymentRequestBody, studentPaymentReminderBody } from './payment-request-copy';

const cls = { classType: 'Vinyasa', date: new Date('2026-10-06'), startTime: hhmmToTime('19:00') };
const when = `Vinyasa class on ${formatDayHeader(cls.date)} at 19:00`;
const TAIL_DIRECT = "Pay your teacher directly — if this isn't right, talk to your teacher.";
const TAIL_WITH_METHODS = "If this isn't right, talk to your teacher.";

describe('studentPaymentRequestBody', () => {
  describe('when the teacher has no payment method', () => {
    it.each(['registered', 'attended'] as const)('tells %s to pay the teacher directly', (status) => {
      expect(studentPaymentRequestBody(status, cls, 12.4, 'directly', 'EUR')).toBe(
        `Your price for ${when} is €12.40. Pay your teacher directly.`,
      );
    });

    it('opens a no-show with "We missed you" and explains the charge', () => {
      expect(studentPaymentRequestBody('no_show', cls, 12.4, 'directly', 'EUR')).toBe(
        `We missed you at ${when}. Booked spots share the class cost, so your price is €12.40. ${TAIL_DIRECT}`,
      );
    });

    it('tells a late cancel it was after the deadline', () => {
      expect(studentPaymentRequestBody('late_cancel', cls, 12.4, 'directly', 'EUR')).toBe(
        `You cancelled your booking for ${when} after the cancellation deadline. Booked spots share the class cost, so your price is €12.40. ${TAIL_DIRECT}`,
      );
    });
  });

  // The email carries a Pay now button instead, so the body does not send
  // the student around the pay page.
  describe('when the teacher has a payment method', () => {
    it.each(['registered', 'attended'] as const)('states only the price for %s', (status) => {
      expect(studentPaymentRequestBody(status, cls, 12.4, 'methods', 'EUR')).toBe(`Your price for ${when} is €12.40.`);
    });

    it('explains a no-show charge without "Pay your teacher directly"', () => {
      expect(studentPaymentRequestBody('no_show', cls, 12.4, 'methods', 'EUR')).toBe(
        `We missed you at ${when}. Booked spots share the class cost, so your price is €12.40. ${TAIL_WITH_METHODS}`,
      );
    });

    it('explains a late-cancel charge without "Pay your teacher directly"', () => {
      expect(studentPaymentRequestBody('late_cancel', cls, 12.4, 'methods', 'EUR')).toBe(
        `You cancelled your booking for ${when} after the cancellation deadline. Booked spots share the class cost, so your price is €12.40. ${TAIL_WITH_METHODS}`,
      );
    });
  });

  // The hold-off line replaces the payment instruction; a no-show or late
  // cancel keeps the line about talking to the teacher.
  describe('while the teacher has paused payments', () => {
    it.each(['registered', 'attended'] as const)('tells %s to hold off', (status) => {
      expect(studentPaymentRequestBody(status, cls, 12.4, 'hold_off', 'EUR')).toBe(
        `Your price for ${when} is €12.40. ${PAYMENTS_PAUSED_COPY}`,
      );
    });

    it('tells a no-show to hold off, not to pay directly', () => {
      expect(studentPaymentRequestBody('no_show', cls, 12.4, 'hold_off', 'EUR')).toBe(
        `We missed you at ${when}. Booked spots share the class cost, so your price is €12.40. ${PAYMENTS_PAUSED_COPY} ${TAIL_WITH_METHODS}`,
      );
    });

    it('tells a late cancel to hold off, not to pay directly', () => {
      expect(studentPaymentRequestBody('late_cancel', cls, 12.4, 'hold_off', 'EUR')).toBe(
        `You cancelled your booking for ${when} after the cancellation deadline. Booked spots share the class cost, so your price is €12.40. ${PAYMENTS_PAUSED_COPY} ${TAIL_WITH_METHODS}`,
      );
    });
  });

  it.each(['methods', 'directly', 'hold_off'] as const)('refuses a cancelled registration, which is never charged (%s)', (guidance) => {
    expect(() => studentPaymentRequestBody('cancelled', cls, 12.4, guidance, 'EUR')).toThrow(/not charged/);
  });
});

describe('studentPaymentReminderBody', () => {
  it('tells the student to pay directly when the teacher has no payment method', () => {
    expect(studentPaymentReminderBody(cls, 12.4, 'directly', 'EUR')).toBe(
      `€12.40 for ${when} is still open. Pay your teacher directly.`,
    );
  });

  it('states only what is open when the teacher has a payment method', () => {
    expect(studentPaymentReminderBody(cls, 12.4, 'methods', 'EUR')).toBe(`€12.40 for ${when} is still open.`);
  });

  it('tells the student to hold off while the teacher has paused payments', () => {
    expect(studentPaymentReminderBody(cls, 12.4, 'hold_off', 'EUR')).toBe(
      `€12.40 for ${when} is still open. ${PAYMENTS_PAUSED_COPY}`,
    );
  });

  it('keeps two decimals for a whole amount', () => {
    expect(studentPaymentReminderBody(cls, 15, 'methods', 'EUR')).toBe(`€15.00 for ${when} is still open.`);
  });
});

describe('currency', () => {
  it('renders a reminder in the class currency', () => {
    expect(studentPaymentReminderBody(cls, 12, 'methods', 'GBP')).toBe(`£12.00 for ${when} is still open.`);
  });

  it('renders a request in the class currency', () => {
    expect(studentPaymentRequestBody('attended', cls, 12, 'methods', 'CHF')).toBe(
      `Your price for ${when} is CHF 12.00.`,
    );
  });
});
