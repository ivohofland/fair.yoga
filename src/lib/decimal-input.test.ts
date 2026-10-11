import { describe, it, expect } from 'vitest';
import { parseDecimal } from './decimal-input';
import { MONEY_DECIMALS } from './input-bounds';

describe('parseDecimal', () => {
  it.each([
    ['4,5', 4.5],
    ['4.5', 4.5],
    ['45.', 45],
    [',5', 0.5],
    ['.5', 0.5],
    ['5,', 5],
    ['-4,5', -4.5],
    ['0,00', 0],
    ['  4,5  ', 4.5],
  ])('reads %j as %d', (text, expected) => {
    expect(parseDecimal(text, MONEY_DECIMALS)).toBe(expected);
  });

  it.each(['4,555', '1.000', '1,000'])('refuses %j at 2 decimals', (text) => {
    expect(parseDecimal(text, 2)).toBeNaN();
  });

  it('reads 4,555 at 3 decimals', () => {
    expect(parseDecimal('4,555', 3)).toBe(4.555);
  });

  it('puts no limit on decimals at Infinity', () => {
    expect(parseDecimal('8,1234', Infinity)).toBe(8.1234);
  });

  it.each(['1.000,5', '1 000', '-', '4e', '4,5,6', '', '   '])(
    'refuses %j',
    (text) => {
      expect(parseDecimal(text, MONEY_DECIMALS)).toBeNaN();
    },
  );

  it('exports MONEY_DECIMALS as 2', () => {
    expect(MONEY_DECIMALS).toBe(2);
  });
});
