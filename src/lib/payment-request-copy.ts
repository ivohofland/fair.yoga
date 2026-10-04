import type { RegistrationStatus } from '@prisma/client';
import { formatDayHeader, formatEuro } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';

export interface PaymentRequestClass {
  classType: string;
  date: Date;
  startTime: Date;
}

const SHARED_COST = 'Booked spots share the class cost, so your price is';
const PAY_OR_ASK = "Pay your teacher directly — if this isn't right, talk to your teacher.";
const ASK = "If this isn't right, talk to your teacher.";

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
 * When the teacher has a payment method (`paymentMethodsFor`), only "Pay your
 * teacher directly" is dropped: a no-show or late cancel still ends "If this
 * isn't right, talk to your teacher."
 */
export function studentPaymentRequestBody(
  status: RegistrationStatus,
  cls: PaymentRequestClass,
  price: number,
  teacherHasPaymentMethods: boolean,
): string {
  const when = classPhrase(cls);
  const amount = formatEuro(price);
  const tail = teacherHasPaymentMethods ? ASK : PAY_OR_ASK;
  switch (status) {
    case 'registered':
    case 'attended':
      return teacherHasPaymentMethods
        ? `Your price for ${when} is ${amount}.`
        : `Your price for ${when} is ${amount}. Pay your teacher directly.`;
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
 * The student's overdue-payment `reminder` body. Says "Pay your teacher
 * directly" only when the teacher has no payment method (`paymentMethodsFor`).
 */
export function studentPaymentReminderBody(
  cls: PaymentRequestClass,
  amount: number,
  teacherHasPaymentMethods: boolean,
): string {
  const open = `€${amount.toFixed(2)} for ${classPhrase(cls)} is still open.`;
  return teacherHasPaymentMethods ? open : `${open} Pay your teacher directly.`;
}
