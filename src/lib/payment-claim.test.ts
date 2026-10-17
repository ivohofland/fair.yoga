import { describe, it, expect } from 'vitest';
import type { PaymentStatus } from '@/lib/prisma-client';
import { claimedFirst, isClaimStanding, studentPaymentStateText } from './payment-claim';
import { paymentStateText } from '@/lib/format';

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

describe('claimedFirst', () => {
  const at = new Date('2026-10-12T10:00:00Z');
  const row = (id: string, status: PaymentStatus, studentReportedAt: Date | null) => ({ id, status, studentReportedAt });

  it('moves standing claims ahead, keeping the given order within each group', () => {
    const rows = [
      row('a', 'pending', null),
      row('b', 'overdue', at),
      row('c', 'overdue', null),
      row('d', 'pending', at),
      row('e', 'pending', null),
    ];
    expect(claimedFirst(rows, (r) => r).map((r) => r.id)).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  // A paid row's `studentReportedAt` is the student's half of the record, not
  // a claim awaiting the teacher.
  it('does not lift a settled payment that keeps its report', () => {
    const rows = [row('a', 'pending', null), row('b', 'paid', at)];
    expect(claimedFirst(rows, (r) => r).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('leaves the input untouched', () => {
    const rows = [row('a', 'pending', null), row('b', 'pending', at)];
    claimedFirst(rows, (r) => r);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('studentPaymentStateText', () => {
  const reportedAt = new Date('2026-10-12T10:00:00Z');

  it.each<PaymentStatus>(['pending', 'overdue'])('reads "Marked as sent" in brown for a %s payment with a standing claim', (status) => {
    expect(studentPaymentStateText({ status, studentReportedAt: reportedAt })).toEqual({
      label: 'Marked as sent',
      className: 'text-brown',
    });
  });

  it.each<[PaymentStatus, Date | null]>([
    ['pending', null],
    ['overdue', null],
    ['paid', reportedAt],
    ['not_charged', reportedAt],
  ])('reads the status itself for %s with claim %s', (status, studentReportedAt) => {
    expect(studentPaymentStateText({ status, studentReportedAt })).toEqual(paymentStateText(status));
  });
});
