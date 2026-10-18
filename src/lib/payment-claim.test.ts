import { describe, it, expect } from 'vitest';
import type { PaymentStatus, ProcessorPaymentStatus } from '@/lib/prisma-client';
import { inProgress, inProgressFirst, isClaimStanding, studentPaymentStateText } from './payment-claim';
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

describe('inProgress', () => {
  const at = new Date('2026-10-12T10:00:00Z');
  const p = (status: PaymentStatus, studentReportedAt: Date | null, attempts: ProcessorPaymentStatus[]) => ({
    status, studentReportedAt, processorAttempts: attempts.map((s) => ({ status: s })),
  });

  it.each<[string, ReturnType<typeof p>, boolean]>([
    ['a standing claim', p('pending', at, []), true],
    ['a pending Mollie payment', p('overdue', null, ['canceled', 'pending']), true],
    ['an authorized Mollie payment', p('pending', null, ['authorized']), true],
    ['an open Mollie payment (a tap is not a payment)', p('pending', null, ['open']), false],
    ['finished Mollie payments only', p('pending', null, ['canceled', 'expired', 'failed']), false],
    ['nothing', p('pending', null, []), false],
    ['a settled payment with a pending attempt', p('paid', null, ['pending']), false],
    ['a settled payment that keeps its report', p('not_charged', at, []), false],
  ])('%s → %s', (_label, payment, expected) => {
    expect(inProgress(payment)).toBe(expected);
  });
});

describe('inProgressFirst', () => {
  it('lifts claims and processing Mollie payments together, keeping the given order', () => {
    const at = new Date('2026-10-12T10:00:00Z');
    const rows = [
      { id: 'a', status: 'pending' as const, studentReportedAt: null, processorAttempts: [] },
      { id: 'b', status: 'pending' as const, studentReportedAt: null, processorAttempts: [{ status: 'pending' as const }] },
      { id: 'c', status: 'pending' as const, studentReportedAt: at, processorAttempts: [] },
      { id: 'd', status: 'pending' as const, studentReportedAt: null, processorAttempts: [{ status: 'open' as const }] },
    ];
    expect(inProgressFirst(rows, (r) => r).map((r) => r.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  // A paid row's `studentReportedAt` is the student's half of the record, not
  // a claim awaiting the teacher.
  it('does not lift a settled payment that keeps its report', () => {
    const at = new Date('2026-10-12T10:00:00Z');
    const rows = [
      { id: 'a', status: 'pending' as const, studentReportedAt: null, processorAttempts: [] },
      { id: 'b', status: 'paid' as const, studentReportedAt: at, processorAttempts: [] },
    ];
    expect(inProgressFirst(rows, (r) => r).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('leaves the input untouched', () => {
    const rows = [
      { id: 'a', status: 'pending' as const, studentReportedAt: null, processorAttempts: [] },
      { id: 'b', status: 'pending' as const, studentReportedAt: new Date('2026-10-12T10:00:00Z'), processorAttempts: [] },
    ];
    inProgressFirst(rows, (r) => r);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
