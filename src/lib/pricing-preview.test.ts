import { describe, it, expect } from 'vitest';
import { normalSpread, tierPrices, priceSpread, studentsIn } from './pricing-preview';

describe('normalSpread', () => {
  it.each([
    [2, { 1: 0, 2: 1, 3: 1, 4: 0, 5: 0 }],
    [7, { 1: 1, 2: 1, 3: 3, 4: 1, 5: 1 }],
    [8, { 1: 1, 2: 2, 3: 3, 4: 2, 5: 0 }],
    [12, { 1: 1, 2: 3, 3: 4, 4: 3, 5: 1 }],
  ])('spreads %i students as %j', (n, expected) => {
    expect(normalSpread(n)).toEqual(expected);
  });

  it('always places exactly n students', () => {
    for (let n = 1; n <= 40; n++) {
      expect(studentsIn(normalSpread(n))).toBe(n);
    }
  });
});

describe('studentsIn', () => {
  it('counts every tier', () => {
    expect(studentsIn({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 })).toBe(15);
  });
});

describe('tierPrices', () => {
  it('splits the total by tier ratio, rounded to the cent', () => {
    expect(tierPrices(85, { 1: 1, 2: 2, 3: 3, 4: 2, 5: 0 })).toEqual({
      1: 7.22,
      2: 8.89,
      3: 11.11,
      4: 13.33,
      5: 15,
    });
    expect(tierPrices(78.75, { 1: 1, 2: 1, 3: 3, 4: 1, 5: 1 })).toEqual({
      1: 7.31,
      2: 9,
      3: 11.25,
      4: 13.5,
      5: 15.19,
    });
  });

  it('prices nothing when nobody is in any tier', () => {
    expect(tierPrices(85, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  });
});

describe('priceSpread', () => {
  it('compares only tiers that have students', () => {
    expect(
      priceSpread({ 1: 7.22, 2: 8.89, 3: 11.11, 4: 13.33, 5: 15 }, { 1: 1, 2: 2, 3: 3, 4: 2, 5: 0 }),
    ).toBe('1.8');
  });

  it('has nothing to compare with a single occupied tier', () => {
    expect(priceSpread({ 1: 0, 2: 0, 3: 20, 4: 0, 5: 0 }, { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 })).toBeNull();
  });
});
