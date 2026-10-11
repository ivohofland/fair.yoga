import { describe, it, expect } from 'vitest';
import { vatPercentViolation } from './vat';

describe('vatPercentViolation', () => {
  it.each([0, 9, 21, 8.1, 14.975, 100])('accepts %s', (v) => {
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
  it('refuses a non-finite number', () => {
    expect(vatPercentViolation(Number.NaN)).toBe('Use at most 3 decimals for VAT.');
  });
});
