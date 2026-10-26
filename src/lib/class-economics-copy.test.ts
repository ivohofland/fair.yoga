import { describe, it, expect } from 'vitest';
import type { EconomicsRule } from './class-economics';
import { economicsMessage, isEconomicsMessage } from './class-economics-copy';

const RULES = ['students_order', 'rate_order', 'room_subsidy'] as const satisfies readonly EconomicsRule[];

describe('economicsMessage (#912)', () => {
  it('(#912) words a tiered violation as the field the teacher sees', () => {
    expect(economicsMessage('rate_order', { pricingMode: 'tiered', minRate: 5, online: false }, 'EUR')).toBe(
      'Min rate cannot exceed target rate',
    );
  });

  it('(#912) names the saved rates for a donation class, with the room cost they need', () => {
    expect(economicsMessage('room_subsidy', { pricingMode: 'donation', minRate: -20, online: false }, 'EUR')).toBe(
      'Your saved tiered rates need a room cost of at least €20.00. Switch to Tiered to change them.',
    );
    expect(economicsMessage('rate_order', { pricingMode: 'donation', minRate: 0, online: false }, 'EUR')).toBe(
      'Your saved tiered rates are out of order. Switch to Tiered to change them.',
    );
  });

  it('(#912) keeps the class-size rule in its tiered wording on a donation class', () => {
    expect(economicsMessage('students_order', { pricingMode: 'donation', minRate: 0, online: false }, 'EUR')).toBe(
      'Min students cannot exceed max students',
    );
  });

  it('(#912) words the room rule for an online class without a room cost, in either mode', () => {
    expect(economicsMessage('room_subsidy', { pricingMode: 'tiered', minRate: -5, online: true }, 'EUR')).toBe(
      'Min rate cannot be negative for an online class — prices would go negative',
    );
    expect(economicsMessage('room_subsidy', { pricingMode: 'donation', minRate: -5, online: true }, 'EUR')).toBe(
      'Your saved tiered rates have a negative min rate, which an online class cannot have. Switch to Tiered to change them.',
    );
  });

  it('(#912) recognises every message it can produce, in either mode', () => {
    for (const rule of RULES) {
      for (const pricingMode of ['tiered', 'donation'] as const) {
        for (const online of [false, true]) {
          for (const minRate of [-5, 0, 12.5]) {
            expect(isEconomicsMessage(economicsMessage(rule, { pricingMode, minRate, online }, 'EUR'))).toBe(true);
          }
        }
      }
    }
    expect(isEconomicsMessage('Room cost cannot be negative')).toBe(false);
  });
});
