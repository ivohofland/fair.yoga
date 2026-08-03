import { describe, it, expect, vi, afterEach } from 'vitest';
import { toIncomeTier, toIncomeTierOrThrow } from './tiers.server';
import { DEFAULT_INCOME_TIER } from './tiers';
import { log } from '@/lib/log';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toIncomeTier', () => {
  it('passes every in-range tier through unchanged', () => {
    expect([1, 2, 3, 4, 5].map((n) => toIncomeTier(n))).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not warn for a value the database permits', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    toIncomeTier(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to the default rather than throwing', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // A public SSR page renders this. Throwing here is a 500 on a teacher's
    // booking page; one wrong price is the lesser failure.
    expect(() => toIncomeTier(0)).not.toThrow();
    expect(toIncomeTier(0)).toBe(DEFAULT_INCOME_TIER);
    expect(toIncomeTier(6)).toBe(DEFAULT_INCOME_TIER);
  });

  it('warns with the offending value so a bypassed constraint is observable', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    toIncomeTier(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 0 }),
      expect.stringContaining('outside 1-5'),
    );
  });
});

describe('toIncomeTierOrThrow', () => {
  it('passes every in-range tier through unchanged', () => {
    expect([1, 2, 3, 4, 5].map((n) => toIncomeTierOrThrow(n))).toEqual([1, 2, 3, 4, 5]);
  });

  it('throws rather than guessing, naming the offending value', () => {
    // The billing path writes a Payment from this. A substituted tier is a
    // silent mis-charge; a throw rolls the transaction back instead.
    expect(() => toIncomeTierOrThrow(0)).toThrow(/0 is outside 1-5/);
    expect(() => toIncomeTierOrThrow(6)).toThrow(/6 is outside 1-5/);
  });

  it('does not warn — unlike its degrading sibling, the throw is the signal', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(() => toIncomeTierOrThrow(0)).toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
