import { describe, it, expect } from 'vitest';
import { Currency } from '@prisma/client';
import { CURRENCY_INFO, suggestedCurrency } from './currency';
import { CURRENCY_PREFIX } from './format';
import { SCHEME_FOR_CURRENCY } from './bank-details';

describe('CURRENCY_INFO', () => {
  it('is the source of CURRENCY_PREFIX and SCHEME_FOR_CURRENCY', () => {
    for (const c of Object.values(Currency)) {
      expect(CURRENCY_PREFIX[c]).toBe(CURRENCY_INFO[c].prefix);
      expect(SCHEME_FOR_CURRENCY[c]).toBe(CURRENCY_INFO[c].scheme);
    }
  });

  it('gives a bank-code label exactly to the local scheme’s currencies that take one', () => {
    for (const c of Object.values(Currency)) {
      const scheme: string = CURRENCY_INFO[c].scheme;
      if (scheme !== 'local') expect(CURRENCY_INFO[c].bankCodeLabel).toBeNull();
    }
  });

  it('claims each time zone for at most one currency', () => {
    const seen = new Map<string, Currency>();
    for (const c of Object.values(Currency)) {
      for (const z of CURRENCY_INFO[c].timeZones) {
        expect(seen.get(z), `${z} claimed twice`).toBeUndefined();
        seen.set(z, c);
      }
    }
  });
});

describe('suggestedCurrency', () => {
  it.each([
    ['Europe/Amsterdam', 'EUR'],
    ['Europe/London', 'GBP'],
    ['America/New_York', 'USD'],
    ['America/Indiana/Indianapolis', 'USD'],
    ['Europe/Zurich', 'CHF'],
    ['Europe/Stockholm', 'SEK'],
    ['Europe/Oslo', 'NOK'],
    ['Europe/Copenhagen', 'DKK'],
  ] as const)('suggests %s → %s', (zone, currency) => {
    expect(suggestedCurrency(zone)).toBe(currency);
  });

  it.each(['Etc/UTC', 'Antarctica/Troll', '', 'Europe/'])('suggests nothing for %j', (zone) => {
    expect(suggestedCurrency(zone)).toBeNull();
  });
});
