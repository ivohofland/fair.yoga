import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { resolvePaymentBreakdown, type ResolvePaymentBreakdownInput } from './payment-breakdown';

const d = (value: string) => new Prisma.Decimal(value);

const COMPLETED: ResolvePaymentBreakdownInput = {
  classStatus: 'completed',
  roomCost: d('40.00'),
  totalRevenue: d('56.25'),
  totalStudents: 9,
  payment: { status: 'pending', amount: d('7.50') },
};

describe('resolvePaymentBreakdown', () => {
  it('shows every line from the snapshot, in cents', () => {
    expect(resolvePaymentBreakdown(COMPLETED)).toEqual({
      kind: 'shown',
      lines: { roomCents: 4000, teacherCents: 1625, totalCents: 5625, students: 9, shareCents: 750 },
    });
  });

  it.each(['pending', 'paid', 'overdue'] as const)('shows the breakdown for a %s payment', (status) => {
    const result = resolvePaymentBreakdown({ ...COMPLETED, payment: { status, amount: d('7.50') } });
    expect(result.kind).toBe('shown');
  });

  it('hides the breakdown for a not_charged payment', () => {
    const result = resolvePaymentBreakdown({
      ...COMPLETED,
      payment: { status: 'not_charged', amount: d('7.50') },
    });
    expect(result).toEqual({ kind: 'hidden' });
  });

  it.each(['draft', 'open', 'in_progress'] as const)('hides the breakdown on a %s class', (classStatus) => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, classStatus })).toEqual({ kind: 'hidden' });
  });

  it('hides the breakdown when the registration has no payment', () => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, payment: null })).toEqual({ kind: 'hidden' });
  });

  it('reports a completed class with no totalRevenue as a missing snapshot', () => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, totalRevenue: null })).toEqual({ kind: 'snapshot_missing' });
  });

  it('reports a completed class with no totalStudents as a missing snapshot', () => {
    expect(resolvePaymentBreakdown({ ...COMPLETED, totalStudents: null })).toEqual({ kind: 'snapshot_missing' });
  });

  it('reports a missing snapshot even on a row that would hide its breakdown', () => {
    expect(
      resolvePaymentBreakdown({
        ...COMPLETED,
        totalRevenue: null,
        payment: { status: 'not_charged', amount: d('7.50') },
      }),
    ).toEqual({ kind: 'snapshot_missing' });
  });

  it('does not report a missing snapshot on a class that is not completed', () => {
    expect(
      resolvePaymentBreakdown({ ...COMPLETED, classStatus: 'open', totalRevenue: null, totalStudents: null }),
    ).toEqual({ kind: 'hidden' });
  });

  it('derives the teacher line as total minus room, negative when the teacher covered part of the room', () => {
    const result = resolvePaymentBreakdown({ ...COMPLETED, roomCost: d('42.60'), totalRevenue: d('38.60') });
    expect(result).toMatchObject({ kind: 'shown', lines: { teacherCents: -400 } });
  });

  it('keeps cents exact where float subtraction drifts', () => {
    // In floating point, 56.30 - 40.10 is 16.199999999999996.
    const result = resolvePaymentBreakdown({ ...COMPLETED, roomCost: d('40.10'), totalRevenue: d('56.30') });
    expect(result).toMatchObject({
      kind: 'shown',
      lines: { roomCents: 4010, teacherCents: 1620, totalCents: 5630 },
    });
  });
});
