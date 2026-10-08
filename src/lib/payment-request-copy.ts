import type { Currency, RegistrationStatus } from '@prisma/client';
import { formatDayHeader, formatMoney } from '@/lib/format';
import { PAYMENTS_PAUSED_COPY, type PayGuidance } from '@/lib/payment-methods';
import { timeToHHmm } from '@/lib/time-of-day';

export interface PaymentRequestClass {
  classType: string;
  date: Date;
  startTime: Date;
}

const SHARED_COST = 'Booked spots share the class cost, so your price is';
const PAY_OR_ASK = "Pay your teacher directly — if this isn't right, talk to your teacher.";
const ASK = "If this isn't right, talk to your teacher.";

/** The closing line of a charge that needs explaining, by what the student is told about paying. */
const EXPLAINED_TAIL = {
  directly: PAY_OR_ASK,
  methods: ASK,
  hold_off: `${PAYMENTS_PAUSED_COPY} ${ASK}`,
} as const satisfies Record<PayGuidance, string>;

/** What follows the price when nothing about the charge needs explaining. */
const PLAIN_TAIL = {
  directly: ' Pay your teacher directly.',
  methods: '',
  hold_off: ` ${PAYMENTS_PAUSED_COPY}`,
} as const satisfies Record<PayGuidance, string>;

function classPhrase(cls: PaymentRequestClass): string {
  return `${cls.classType} class on ${formatDayHeader(cls.date)} at ${timeToHHmm(cls.startTime)}`;
}

/**
 * The student's `payment_request` body. A student marked absent, or who
 * cancelled after the deadline, is told why they are still charged; an
 * unmarked `registered` row gets the neutral wording, because nobody has
 * recorded an absence. A `cancelled` row is not charged and throws, so
 * callers pass only charged registrations. Exhaustive over
 * `RegistrationStatus`, so a new status does not compile until its wording is
 * decided.
 *
 * `guidance` (`payGuidanceFor`) decides only the payment instruction: "Pay
 * your teacher directly" with no method, nothing beside one, and the hold-off
 * line while the teacher has paused payments. A no-show or late cancel always
 * ends "If this isn't right, talk to your teacher."
 */
export function studentPaymentRequestBody(
  status: RegistrationStatus,
  cls: PaymentRequestClass,
  price: number,
  guidance: PayGuidance,
  currency: Currency,
): string {
  const when = classPhrase(cls);
  const amount = formatMoney(price, currency);
  const tail = EXPLAINED_TAIL[guidance];
  switch (status) {
    case 'registered':
    case 'attended':
      return `Your price for ${when} is ${amount}.${PLAIN_TAIL[guidance]}`;
    case 'no_show':
      return `We missed you at ${when}. ${SHARED_COST} ${amount}. ${tail}`;
    case 'late_cancel':
      return `You cancelled your booking for ${when} after the cancellation deadline. ${SHARED_COST} ${amount}. ${tail}`;
    case 'cancelled':
      throw new Error('A cancelled registration is not charged and gets no payment request.');
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled registration status: ${String(unreachable)}`);
    }
  }
}

/**
 * The student's outstanding-payment `reminder` body, with the same payment
 * instruction as the request (`guidance`, from `payGuidanceFor`).
 */
export function studentPaymentReminderBody(
  cls: PaymentRequestClass,
  amount: number,
  guidance: PayGuidance,
  currency: Currency,
): string {
  return `${formatMoney(amount, currency)} for ${classPhrase(cls)} is still open.${PLAIN_TAIL[guidance]}`;
}
