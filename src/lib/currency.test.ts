import { describe, it, expect } from 'vitest';
import { Currency } from '@/lib/prisma-client';
import { CURRENCY_INFO, labelInSentence, suggestedCurrency } from './currency';
import { CURRENCY_PREFIX } from './format';
import { SCHEME_FOR_CURRENCY } from './bank-details';

describe('CURRENCY_INFO', () => {
  it('is the source of CURRENCY_PREFIX and SCHEME_FOR_CURRENCY', () => {
    for (const c of Object.values(Currency)) {
      expect(CURRENCY_PREFIX[c]).toBe(CURRENCY_INFO[c].prefix);
      expect(SCHEME_FOR_CURRENCY[c]).toBe(CURRENCY_INFO[c].scheme);
    }
  });

  it('gives a bank-code label to the local currencies that route by one, and none to NZD and MXN', () => {
    const withCode = (['AUD', 'CAD', 'INR', 'SGD', 'HKD', 'ZAR', 'BRL'] as const).map((c) => CURRENCY_INFO[c].bankCodeLabel);
    expect(withCode.every((l) => l !== null)).toBe(true);
    expect(CURRENCY_INFO.NZD.bankCodeLabel).toBeNull();
    expect(CURRENCY_INFO.MXN.bankCodeLabel).toBeNull();
    expect(CURRENCY_INFO.MXN.accountLabel).toBe('CLABE');
  });

  it('leaves the bank code off exactly NZD and MXN among the local currencies', () => {
    const local = Object.values(Currency).filter((c) => CURRENCY_INFO[c].scheme === 'local');
    expect(local.filter((c) => CURRENCY_INFO[c].bankCodeLabel === null)).toEqual(['NZD', 'MXN']);
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
    ['Europe/Amsterdam', 'EUR'], ['Europe/Sofia', 'EUR'], ['Europe/Podgorica', 'EUR'],
    ['Europe/London', 'GBP'],
    ['America/New_York', 'USD'],
    ['America/Indiana/Indianapolis', 'USD'],
    ['Europe/Zurich', 'CHF'],
    ['Europe/Stockholm', 'SEK'],
    ['Europe/Oslo', 'NOK'],
    ['Europe/Copenhagen', 'DKK'],
    ['Australia/Sydney', 'AUD'], ['Australia/Perth', 'AUD'], ['America/Toronto', 'CAD'],
    ['America/Vancouver', 'CAD'], ['Asia/Kolkata', 'INR'], ['Asia/Singapore', 'SGD'],
    ['Pacific/Auckland', 'NZD'], ['Asia/Hong_Kong', 'HKD'], ['America/Sao_Paulo', 'BRL'],
    ['America/Mexico_City', 'MXN'], ['Africa/Johannesburg', 'ZAR'], ['Europe/Warsaw', 'PLN'],
    ['Europe/Prague', 'CZK'], ['Asia/Jerusalem', 'ILS'], ['Asia/Dubai', 'AED'],
  ] as const)('suggests %s → %s', (zone, currency) => {
    expect(suggestedCurrency(zone)).toBe(currency);
  });

  it.each(['Etc/UTC', 'Antarctica/Troll', '', 'Europe/'])('suggests nothing for %j', (zone) => {
    expect(suggestedCurrency(zone)).toBeNull();
  });
});

describe('labelInSentence', () => {
  it('keeps an acronym and lowercases words', () => {
    expect(labelInSentence('BSB')).toBe('BSB');
    expect(labelInSentence('CLABE')).toBe('CLABE');
    expect(labelInSentence('Account number')).toBe('account number');
    expect(labelInSentence('Institution & transit')).toBe('institution & transit');
  });
});
