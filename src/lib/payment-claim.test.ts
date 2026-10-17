import { describe, it, expect } from 'vitest';
import type { PaymentStatus } from '@/lib/prisma-client';
import { isClaimStanding } from './payment-claim';

describe('isClaimStanding', () => {
  const reportedAt = new Date('2026-10-12T10:00:00Z');

  it.each<[PaymentStatus, Date | null, boolean]>([
    ['pending', reportedAt, true],
    ['overdue', reportedAt, true],
    ['paid', reportedAt, false],
    ['not_charged', reportedAt, false],
    ['pending', null, false],
    ['overdue', null, false],
    ['paid', null, false],
    ['not_charged', null, false],
  ])('%s with studentReportedAt %s → %s', (status, studentReportedAt, expected) => {
    expect(isClaimStanding({ status, studentReportedAt })).toBe(expected);
  });
});
