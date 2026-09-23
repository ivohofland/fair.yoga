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

/**
 * The student's `payment_request` body. A student marked absent, or who
 * cancelled after the deadline, is told why they are still charged; an
 * unmarked `registered` row gets the neutral wording, because nobody has
 * recorded an absence. Exhaustive over `RegistrationStatus`, so a new status
 * does not compile until its wording is decided.
 */
export function studentPaymentRequestBody(
  status: RegistrationStatus,
  cls: PaymentRequestClass,
  price: number,
): string {
  const when = `${cls.classType} class on ${formatDayHeader(cls.date)} at ${timeToHHmm(cls.startTime)}`;
  const amount = formatEuro(price);
  switch (status) {
    case 'registered':
    case 'attended':
      return `Your price for ${when} is ${amount}. Pay your teacher directly.`;
    case 'no_show':
      return `We missed you at ${when}. ${SHARED_COST} ${amount}. ${PAY_OR_ASK}`;
    case 'late_cancel':
      return `You cancelled ${when} after the cancellation deadline. ${SHARED_COST} ${amount}. ${PAY_OR_ASK}`;
    case 'cancelled':
      throw new Error('A cancelled registration is not charged and gets no payment request.');
    default: {
      const unreachable: never = status;
      throw new Error(`unhandled registration status: ${String(unreachable)}`);
    }
  }
}
