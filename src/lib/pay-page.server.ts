import type { ClassStatus, RegistrationStatus } from '@/lib/prisma-client';
import { logDegraded } from '@/lib/degradation';
import { formatInstantInZone } from '@/lib/timezone';
import { CHARGED_STATUSES } from '@/services/class-lifecycle';

/**
 * The pay page's line for a paid payment. A `paid` payment always has its
 * `paidAt`, since marking it paid writes both; one without is recorded as
 * `PAYMENT_PAID_WITHOUT_TIMESTAMP` (`docs/degradation-sites.md`) and named
 * without a date.
 */
export function markedPaidLine(paidAt: Date | null, timeZone: string, paymentId: string): string {
  if (paidAt !== null) return `Marked paid ${formatInstantInZone(paidAt, timeZone)}.`;
  logDegraded(
    'PAYMENT_PAID_WITHOUT_TIMESTAMP',
    { paymentId },
    'paid payment has no paidAt; the pay page names no date',
  );
  return 'Marked paid.';
}

/**
 * The pay page's line for a standing "I've sent it": the day, in the
 * teacher's zone like `markedPaidLine`. Takes the day part of
 * `formatInstantInZone` ("Thu 17 Oct 14:15"), so the zone fallback is its own.
 */
export function sentClaimLine(reportedAt: Date, timeZone: string): string {
  const day = formatInstantInZone(reportedAt, timeZone).split(' ').slice(1, 3).join(' ');
  return `You marked this as sent on ${day}.`;
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
}): void {
  if (found.classStatus !== 'completed' || !CHARGED_STATUSES.includes(found.registrationStatus)) return;
  logDegraded(
    'CHARGED_REGISTRATION_WITHOUT_PAYMENT',
    { classId: found.classId, registrationId: found.registrationId },
    'charged registration on a completed class has no payment; the pay page answered not found',
  );
}
