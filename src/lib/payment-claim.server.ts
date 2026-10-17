import { startOfLocalDay } from '@/lib/timezone';

/**
 * The calendar day a student marked a payment sent, in the teacher's zone,
 * as `PaymentClaimLine` takes it; null when they have not.
 */
export function claimDay(studentReportedAt: Date | null, timeZone: string): Date | null {
  return studentReportedAt === null ? null : startOfLocalDay(studentReportedAt, timeZone);
}
