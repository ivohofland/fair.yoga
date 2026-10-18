import { describe, it, expect } from 'vitest';
import { MOLLIE_METHODS, isAllowedMollieMethod, orderOffered, exclusionReason, LONGEST_METHOD_EXPIRY_MINUTES } from './processor-methods';

describe('the allowlist', () => {
  it('holds no pay-later method', () => {
    for (const id of ['klarna', 'in3', 'riverty', 'billie', 'billink', 'alma', 'klarnapaylater', 'klarnasliceit']) {
      expect(isAllowedMollieMethod(id)).toBe(false);
    }
  });
  it('holds neither Mollie bank transfer nor googlepay', () => {
    expect(isAllowedMollieMethod('banktransfer')).toBe(false);
    expect(isAllowedMollieMethod('googlepay')).toBe(false);
  });
  it('holds no PayPal, whose checkout can offer pay-later (Decision 3)', () => {
    expect(isAllowedMollieMethod('paypal')).toBe(false);
  });
  it('lists iDEAL and Wero as separate rows', () => {
    expect(MOLLIE_METHODS.ideal.label).toBe('iDEAL');
    expect(MOLLIE_METHODS.wero.label).toBe('Wero');
  });
  it('is not fooled by prototype keys', () => {
    expect(isAllowedMollieMethod('toString')).toBe(false);
    expect(isAllowedMollieMethod('__proto__')).toBe(false);
  });
});

describe('orderOffered', () => {
  it('keeps allowlisted ids in allowlist order and reports the rest', () => {
    expect(orderOffered(['twint', 'klarna', 'ideal', 'paypal', 'newmethod'])).toEqual({
      offered: ['ideal', 'twint'], excluded: ['klarna', 'paypal', 'newmethod'],
    });
  });
});

describe('orderOffered duplicates', () => {
  it('reports a repeated id once on both sides', () => {
    expect(orderOffered(['ideal', 'ideal', 'newmethod', 'newmethod'])).toEqual({
      offered: ['ideal'], excluded: ['newmethod'],
    });
  });
});

describe('exclusionReason', () => {
  it.each(['klarna', 'klarnapaylater', 'klarnasliceit', 'klarnapaynow', 'in3', 'riverty', 'billie', 'billink', 'alma'])(
    'names %s as pay-later',
    (id) => {
      expect(exclusionReason(id)).toBe('pay_later');
    },
  );
  it('names pay-later for credit products and not-offered for the rest', () => {
    expect(exclusionReason('klarna')).toBe('pay_later');
    expect(exclusionReason('banktransfer')).toBe('not_offered');
  });
});

it('the longest expiry is an hour', () => {
  expect(LONGEST_METHOD_EXPIRY_MINUTES).toBe(60);
});
