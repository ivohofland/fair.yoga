import { startOfLocalDay } from '@/lib/timezone';

/**
 * The calendar day a student marked a payment sent, in the teacher's zone,
 * as `PaymentClaimLine` takes it; null when they have not. Server-side
 * because `startOfLocalDay` is, so a client row receives the day ready made.
 */
export function claimDay(studentReportedAt: Date | null, timeZone: string): Date | null {
  return studentReportedAt === null ? null : startOfLocalDay(studentReportedAt, timeZone);
}
