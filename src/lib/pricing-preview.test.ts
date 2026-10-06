import { describe, it, expect } from 'vitest';
import { normalSpread, tierPrices, priceSpread } from './pricing-preview';

describe('normalSpread', () => {
  it.each([
    [2, [0, 1, 1, 0, 0]],
    [7, [1, 1, 3, 1, 1]],
    [8, [1, 2, 3, 2, 0]],
    [12, [1, 3, 4, 3, 1]],
  ])('spreads %i students as %j', (n, expected) => {
    expect(normalSpread(n)).toEqual(expected);
  });

  it('always places exactly n students', () => {
    for (let n = 1; n <= 40; n++) {
      expect(normalSpread(n).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });
});

describe('tierPrices', () => {
  it('splits the total by tier ratio, rounded to the cent', () => {
    expect(tierPrices(85, [1, 2, 3, 2, 0])).toEqual([7.22, 8.89, 11.11, 13.33, 15]);
    expect(tierPrices(78.75, [1, 1, 3, 1, 1])).toEqual([7.31, 9, 11.25, 13.5, 15.19]);
  });

  it('prices nothing when nobody is in any tier', () => {
    expect(tierPrices(85, [0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('priceSpread', () => {
  it('compares only tiers that have students', () => {
    expect(priceSpread([7.22, 8.89, 11.11, 13.33, 15], [1, 2, 3, 2, 0])).toBe('1.8');
  });

  it('has nothing to compare with a single occupied tier', () => {
    expect(priceSpread([0, 0, 20, 0, 0], [0, 0, 1, 0, 0])).toBeNull();
  });
});
