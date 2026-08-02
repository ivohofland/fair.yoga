import { describe, it, expect } from 'vitest';
import { INCOME_TIERS, isIncomeTier, DEFAULT_INCOME_TIER } from './tiers';

describe('isIncomeTier', () => {
  it('accepts every tier in range', () => {
    expect([1, 2, 3, 4, 5].every(isIncomeTier)).toBe(true);
  });

  it('rejects both boundaries and beyond', () => {
    // 0 is the value tests/integration/account-api.test.ts used to inject a
    // failure with; 6 is the other side of the range.
    expect([0, 6, -1, 100].some(isIncomeTier)).toBe(false);
  });

  it('rejects non-integers and NaN', () => {
    expect(isIncomeTier(3.5)).toBe(false);
    expect(isIncomeTier(NaN)).toBe(false);
  });
});

describe('INCOME_TIERS', () => {
  it('is every tier, in order, and nothing else', () => {
    expect([...INCOME_TIERS]).toEqual([1, 2, 3, 4, 5]);
  });

  it('contains only values isIncomeTier accepts', () => {
    expect(INCOME_TIERS.every(isIncomeTier)).toBe(true);
  });
});

describe('DEFAULT_INCOME_TIER', () => {
  it('is the median tier and is itself a valid tier', () => {
    expect(DEFAULT_INCOME_TIER).toBe(3);
    expect(isIncomeTier(DEFAULT_INCOME_TIER)).toBe(true);
  });
});
