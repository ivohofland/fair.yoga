import type { ClassStatus, PricingMode, RegistrationStatus } from '@/lib/prisma-client';
import { logDegraded } from '@/lib/degradation';
import { formatInstantInZone, startOfLocalDay } from '@/lib/timezone';
import { formatDateShort } from '@/lib/format';
import { CHARGED_STATUSES } from '@/services/class-lifecycle';
import type { PaidMethod } from '@/services/payments';
import type { PaymentMethod } from '@/lib/payment-methods';

/**
 * How the pay page names a payment's settling: "Paid" when Mollie confirmed
 * it (nobody marked anything), "Marked paid" when the teacher did, or when
 * the column holds no `PaidMethod`.
 */
function paidVerb(method: string | null): string {
  if (method !== 'manual' && method !== 'mollie') return 'Marked paid';
  const paidBy: PaidMethod = method;
  switch (paidBy) {
    case 'manual':
      return 'Marked paid';
    case 'mollie':
      return 'Paid';
    default: {
      const unhandled: never = paidBy;
      throw new Error(`unhandled paid method: ${String(unhandled)}`);
    }
  }
}

/**
 * The pay page's line for a paid payment, worded by `Payment.method`
 * (`paidVerb`). A `paid` payment always has its `paidAt`, since marking it
 * paid writes both; one without is recorded as
 * `PAYMENT_PAID_WITHOUT_TIMESTAMP` (`docs/degradation-sites.md`) and named
 * without a date.
 */
export function markedPaidLine(paidAt: Date | null, method: string | null, timeZone: string, paymentId: string): string {
  const verb = paidVerb(method);
  if (paidAt !== null) return `${verb} ${formatInstantInZone(paidAt, timeZone)}.`;
  logDegraded(
    'PAYMENT_PAID_WITHOUT_TIMESTAMP',
    { paymentId },
    'paid payment has no paidAt; the pay page names no date',
  );
  return `${verb}.`;
}

/**
 * Whether the pay page offers "I've sent it": some row is paid outside
 * Mollie, which the teacher then confirms by hand, or a claim already stands
 * and the student may withdraw it. A Mollie row settles itself.
 */
export function offersSentClaim(methods: readonly PaymentMethod[], reportedAt: Date | null): boolean {
  return reportedAt !== null || methods.some((m) => m.kind !== 'processor');
}

/**
 * The pay page's line for a standing "I've sent it": the day, in the
 * teacher's zone like `markedPaidLine`, through `startOfLocalDay`'s zone
 * fallback.
 */
export function sentClaimLine(reportedAt: Date, timeZone: string): string {
  return `You marked this as sent on ${formatDateShort(startOfLocalDay(reportedAt, timeZone))}.`;
}

/**
 * Records a registration the pay page found without a payment, when it should
 * have one: completion creates a payment for every charged registration, so a
 * charged one on a completed class without a payment is recorded as
 * `CHARGED_REGISTRATION_WITHOUT_PAYMENT` (`docs/degradation-sites.md`). Any
 * other registration without a payment is ordinary and records nothing.
 */
export function reportMissingPayment(found: {
  classId: string;
  registrationId: string;
  registrationStatus: RegistrationStatus;
  classStatus: ClassStatus;
  pricingMode: PricingMode;
}): void {
  // A donation class never has a payment (#912).
  if (found.pricingMode === 'donation') return;
  if (found.classStatus !== 'completed' || !CHARGED_STATUSES.includes(found.registrationStatus)) return;
  logDegraded(
    'CHARGED_REGISTRATION_WITHOUT_PAYMENT',
    { classId: found.classId, registrationId: found.registrationId },
    'charged registration on a completed class has no payment; the pay page answered not found',
  );
}
