import { describe, it, expect, vi, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { resolveReportedPaymentBreakdown } from './payment-breakdown.server';

const d = (v: string) => new Prisma.Decimal(v);
const COMPLETED = {
  classStatus: 'completed' as const,
  roomCost: d('40.00'),
  totalRevenue: d('56.25'),
  totalStudents: 9,
  payment: { status: 'pending' as const, amount: d('7.50') },
};
const IDS = { classId: 'class-1', registrationId: 'reg-1' };

describe('resolveReportedPaymentBreakdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports PAYMENT_SNAPSHOT_MISSING with the row ids when a completed class has no snapshot', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const result = resolveReportedPaymentBreakdown({ ...COMPLETED, totalRevenue: null }, IDS);
    expect(result).toEqual({ kind: 'snapshot_missing' });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PAYMENT_SNAPSHOT_MISSING', classId: 'class-1', registrationId: 'reg-1' }),
      'completed class has no pricing snapshot; payment breakdown not rendered',
    );
  });

  it('reports nothing when the snapshot is there', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(resolveReportedPaymentBreakdown(COMPLETED, IDS).kind).toBe('shown');
    expect(warn).not.toHaveBeenCalled();
  });
});
