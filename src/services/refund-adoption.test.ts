import { describe, it, expect } from 'vitest';
import { Prisma } from '@/lib/prisma-client';
import { ADOPT_AFTER_MS, adoptionFor, refundMatches } from './refund-adoption';

const now = new Date('2026-10-18T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const row = (id: string, ageMs: number, value = '10.00') => ({ id, amount: new Prisma.Decimal(value), requestedAt: ago(ageMs) });
const refund = (value = '10.00', currency = 'EUR') => ({ amount: { value, currency } });

describe('refundMatches', () => {
  it('matches the amount as a decimal, in the same currency', () => {
    expect(refundMatches(refund('10.0'), new Prisma.Decimal('10.00'), 'EUR')).toBe(true);
    expect(refundMatches(refund('10.00', 'GBP'), new Prisma.Decimal('10.00'), 'EUR')).toBe(false);
    expect(refundMatches(refund('9.99'), new Prisma.Decimal('10.00'), 'EUR')).toBe(false);
  });
});

describe('adoptionFor', () => {
  it('ignores a refund when no row awaits an id', () => {
    expect(adoptionFor([], refund(), 'EUR', now)).toEqual({ kind: 'ignore' });
  });

  it('defers while every awaiting row is younger than ADOPT_AFTER_MS', () => {
    expect(adoptionFor([row('a', ADOPT_AFTER_MS - 1)], refund(), 'EUR', now)).toEqual({ kind: 'defer' });
  });

  it('adopts the oldest old-enough row whose amount matches', () => {
    const rows = [row('young', 1_000), row('newer', ADOPT_AFTER_MS + 1_000), row('older', ADOPT_AFTER_MS + 5_000), row('other', ADOPT_AFTER_MS + 9_000, '4.00')];
    expect(adoptionFor(rows, refund(), 'EUR', now)).toEqual({ kind: 'adopt', row: rows[2] });
  });

  it('ignores a refund no old-enough row matches', () => {
    expect(adoptionFor([row('a', ADOPT_AFTER_MS, '4.00')], refund(), 'EUR', now)).toEqual({ kind: 'ignore' });
  });
});
