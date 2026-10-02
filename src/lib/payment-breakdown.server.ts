import { logDegraded } from '@/lib/degradation';
import {
  resolvePaymentBreakdown,
  type PaymentBreakdownResult,
  type ResolvePaymentBreakdownInput,
} from '@/lib/payment-breakdown';

/**
 * `resolvePaymentBreakdown`, with a missing snapshot recorded as
 * `PAYMENT_SNAPSHOT_MISSING` (`docs/degradation-sites.md`) against the row it
 * was found on. Completion writes the snapshot in the same transaction that
 * marks the class completed, so a completed class without one means that write
 * was bypassed; the row renders without its breakdown either way.
 */
export function resolveReportedPaymentBreakdown(
  input: ResolvePaymentBreakdownInput,
  ids: { classId: string; registrationId: string },
): PaymentBreakdownResult {
  const result = resolvePaymentBreakdown(input);
  if (result.kind === 'snapshot_missing') {
    logDegraded(
      'PAYMENT_SNAPSHOT_MISSING',
      ids,
      'completed class has no pricing snapshot; payment breakdown not rendered',
    );
  }
  return result;
}
