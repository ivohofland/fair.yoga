import { describe, it, expect } from 'vitest';
import { addedVatCents, includedVatCents, vatPercentViolation, vatThousandths, withVat } from './vat';

describe('vatPercentViolation', () => {
  it.each([0, 9, 21, 8.1, 1.001, 14.975, 100])('accepts %s', (v) => {
    expect(vatPercentViolation(v)).toBeNull();
  });
  it('refuses a negative rate', () => {
    expect(vatPercentViolation(-0.001)).toBe("VAT can't be negative.");
  });
  it('refuses more than 100', () => {
    expect(vatPercentViolation(100.001)).toBe('Keep VAT to 100% or less.');
  });
  it('refuses four decimals rather than letting the column round them', () => {
    expect(vatPercentViolation(8.1234)).toBe('Use at most 3 decimals for VAT.');
  });
  it('refuses a fourth decimal too small for a loose tolerance to see', () => {
    expect(vatPercentViolation(8.0000000004)).toBe('Use at most 3 decimals for VAT.');
  });
  it('asks for a number when given a non-finite one', () => {
    expect(vatPercentViolation(Number.NaN)).toBe('Enter a number for VAT.');
    expect(vatPercentViolation(Number.POSITIVE_INFINITY)).toBe('Enter a number for VAT.');
  });
});

describe('vatThousandths', () => {
  it.each([[0, 0], [9, 9000], [8.1, 8100], [14.975, 14975], [100, 100000]])(
    '%s%% is %s thousandths, exactly',
    (percent, expected) => expect(vatThousandths(percent)).toBe(expected),
  );
});

describe('withVat', () => {
  it('is the identity at 0%, bit for bit', () => {
    for (const amount of [0, 0.1, 46.666666666666664, 110, 1234.56]) {
      expect(withVat(amount, 0)).toBe(amount);
    }
  });
  it('adds 9% to the issue example', () => {
    expect(Math.round(withVat(110, 9000) * 100)).toBe(11990);
  });
  it('adds 14.975%', () => {
    expect(Math.round(withVat(100, 14975) * 100)).toBe(11498); // 114.975 → 11497.5 → half up
  });
});

describe('addedVatCents', () => {
  it('is 0 at 0%', () => expect(addedVatCents(11000, 0)).toBe(0));
  it('is 990 cents on €110 at 9%', () => expect(addedVatCents(11000, 9000)).toBe(990));
});

describe('includedVatCents', () => {
  it('is 0 at 0%', () => expect(includedVatCents(11990, 0)).toBe(0));
  it('takes the VAT back out of a VAT-inclusive price', () => {
    expect(includedVatCents(11990, 9000)).toBe(990);
  });
  it('never exceeds the price', () => {
    for (let cents = 0; cents <= 5000; cents++) {
      for (const t of [100, 9000, 14975, 21000, 100000]) {
        expect(includedVatCents(cents, t)).toBeLessThanOrEqual(cents);
      }
    }
  });
});
