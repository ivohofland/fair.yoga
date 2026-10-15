import { describe, it, expect, expectTypeOf } from 'vitest';
import type { Currency } from '@prisma/client';
import type { z } from 'zod';
import type { bankAccountSchema } from '@/lib/schemas';
import {
  parseBankDetails,
  bankDetailsFromRow,
  maskedIdentifier,
  SCHEME_FOR_CURRENCY,
  EEA_COUNTRIES,
  IBAN_LENGTHS,
  type BankDetails,
  type BankDetailsFailure,
  type BankDetailsInput,
} from '@/lib/bank-details';

function ok(currency: Currency, input: BankDetailsInput): BankDetails {
  const r = parseBankDetails(currency, input);
  if (!r.ok) throw new Error(`expected ok, got ${r.failure.error} on ${r.failure.field}`);
  return r.details;
}

describe('parseBankDetails', () => {
  describe('EUR (sepa)', () => {
    it('accepts an EEA IBAN without a BIC', () => {
      expect(ok('EUR', { iban: 'NL91ABNA0417164300' })).toEqual({ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null });
      expect(ok('EUR', { iban: 'DE89370400440532013000' })).toEqual({ scheme: 'sepa', iban: 'DE89370400440532013000', bic: null });
    });

    it('normalises case and spaces', () => {
      expect(ok('EUR', { iban: 'nl91 abna 0417 1643 00' })).toEqual({ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null });
    });

    it('accepts a non-EEA IBAN with a BIC', () => {
      expect(ok('EUR', { iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' })).toEqual({
        scheme: 'sepa', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A',
      });
      expect(ok('EUR', { iban: 'GB82WEST12345698765432', bic: 'NWBKGB2L' })).toEqual({
        scheme: 'sepa', iban: 'GB82WEST12345698765432', bic: 'NWBKGB2L',
      });
    });

    it('requires a BIC for a non-EEA IBAN', () => {
      expect(parseBankDetails('EUR', { iban: 'CH9300762011623852957' })).toEqual({ ok: false, failure: { error: 'bic_required', field: 'bic' } });
    });

    it('accepts a Norwegian IBAN without a BIC because NO is in the EEA', () => {
      expect(ok('EUR', { iban: 'NO9386011117947' })).toEqual({ scheme: 'sepa', iban: 'NO9386011117947', bic: null });
    });

    it('rejects a bad checksum and a bad length', () => {
      expect(parseBankDetails('EUR', { iban: 'NL91ABNA0417164301' })).toEqual({ ok: false, failure: { error: 'iban_invalid', field: 'iban' } });
      expect(parseBankDetails('EUR', { iban: 'NL91ABNA041716430' })).toEqual({ ok: false, failure: { error: 'iban_invalid', field: 'iban' } });
    });

    it('rejects an unknown country and a missing IBAN', () => {
      expect(parseBankDetails('EUR', { iban: 'ZZ91ABNA0417164300' })).toEqual({ ok: false, failure: { error: 'iban_invalid', field: 'iban' } });
      expect(parseBankDetails('EUR', {})).toEqual({ ok: false, failure: { error: 'iban_invalid', field: 'iban' } });
      expect(parseBankDetails('EUR', { iban: '   ' })).toEqual({ ok: false, failure: { error: 'iban_invalid', field: 'iban' } });
    });

    it('rejects a malformed BIC', () => {
      expect(parseBankDetails('EUR', { iban: 'NL91ABNA0417164300', bic: 'DEUTDEF' })).toEqual({ ok: false, failure: { error: 'bic_invalid', field: 'bic' } });
    });

    it('normalises a BIC and treats a blank one as absent', () => {
      expect(ok('EUR', { iban: 'NL91ABNA0417164300', bic: 'abnanl2a' })).toEqual({ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' });
      expect(ok('EUR', { iban: 'NL91ABNA0417164300', bic: '  ' })).toEqual({ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null });
    });

    it('refuses a bank code on an IBAN account', () => {
      expect(parseBankDetails('EUR', { iban: 'NL91ABNA0417164300', bankCode: '062000' }))
        .toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'bankCode' } });
    });

    it('refuses fields from another scheme', () => {
      expect(parseBankDetails('EUR', { iban: 'NL91ABNA0417164300', sortCode: '123456' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'sortCode' } });
      expect(parseBankDetails('EUR', { iban: 'NL91ABNA0417164300', accountNumber: '1' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'accountNumber' } });
      expect(parseBankDetails('EUR', { iban: 'NL91ABNA0417164300', routingNumber: '021000021' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'routingNumber' } });
    });
  });

  describe('iban currencies', () => {
    it('accepts an IBAN as CHF without needing a BIC', () => {
      expect(ok('CHF', { iban: 'CH9300762011623852957' })).toEqual({ scheme: 'iban', iban: 'CH9300762011623852957', bic: null });
      expect(ok('CHF', { iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' })).toEqual({
        scheme: 'iban', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A',
      });
    });

    it.each(['SEK', 'NOK', 'DKK'] as const)('%s yields the iban scheme', (c) => {
      expect(ok(c, { iban: 'NO9386011117947' }).scheme).toBe('iban');
    });

    it('accepts registry countries outside the EEA, such as a Faroese DKK account', () => {
      expect(ok('DKK', { iban: 'FO6264600001631634' })).toEqual({ scheme: 'iban', iban: 'FO6264600001631634', bic: null });
    });

    it('requires a BIC for EUR with Montenegro, which is not in the EEA', () => {
      expect(parseBankDetails('EUR', { iban: 'ME25505000012345678951' })).toEqual({ ok: false, failure: { error: 'bic_required', field: 'bic' } });
      expect(ok('EUR', { iban: 'ME25505000012345678951', bic: 'CKBCMEPG' })).toEqual({ scheme: 'sepa', iban: 'ME25505000012345678951', bic: 'CKBCMEPG' });
    });

    it('rejects an invalid IBAN', () => {
      expect(parseBankDetails('CHF', { iban: 'CH9300762011623852958' })).toEqual({ ok: false, failure: { error: 'iban_invalid', field: 'iban' } });
    });

    it('refuses UK fields', () => {
      expect(parseBankDetails('CHF', { iban: 'CH9300762011623852957', sortCode: '123456' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'sortCode' } });
    });
  });

  describe('GBP (uk)', () => {
    it('strips dashes from the sort code', () => {
      expect(ok('GBP', { sortCode: '12-34-56', accountNumber: '12345678' })).toEqual({ scheme: 'uk', sortCode: '123456', accountNumber: '12345678' });
      expect(ok('GBP', { sortCode: '12 34 56', accountNumber: '12345678' })).toEqual({ scheme: 'uk', sortCode: '123456', accountNumber: '12345678' });
    });

    it('rejects a short sort code and a bad account number', () => {
      expect(parseBankDetails('GBP', { sortCode: '12345', accountNumber: '12345678' })).toEqual({ ok: false, failure: { error: 'sort_code_invalid', field: 'sortCode' } });
      expect(parseBankDetails('GBP', { sortCode: '123456', accountNumber: '1234567' })).toEqual({ ok: false, failure: { error: 'account_number_invalid', field: 'accountNumber' } });
      expect(parseBankDetails('GBP', { sortCode: '123456' })).toEqual({ ok: false, failure: { error: 'account_number_invalid', field: 'accountNumber' } });
    });

    it('refuses an IBAN', () => {
      expect(parseBankDetails('GBP', { sortCode: '123456', accountNumber: '12345678', iban: 'GB82WEST12345698765432' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'iban' } });
      expect(parseBankDetails('GBP', { iban: 'GB82WEST12345698765432' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'iban' } });
    });

    it.each(['GBP', 'USD'] as const)('refuses a bank code on a %s account', (currency) => {
      const input = currency === 'GBP'
        ? { sortCode: '123456', accountNumber: '12345678', bankCode: '062000' }
        : { routingNumber: '021000021', accountNumber: '1234567', bankCode: '062000' };
      expect(parseBankDetails(currency, input)).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'bankCode' } });
    });

    it('refuses a BIC and a routing number', () => {
      expect(parseBankDetails('GBP', { sortCode: '123456', accountNumber: '12345678', bic: 'NWBKGB2L' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'bic' } });
      expect(parseBankDetails('GBP', { sortCode: '123456', accountNumber: '12345678', routingNumber: '021000021' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'routingNumber' } });
    });

    it('treats blank foreign fields as absent', () => {
      expect(ok('GBP', { sortCode: '123456', accountNumber: '12345678', iban: '', bic: '  ', routingNumber: null })).toEqual({
        scheme: 'uk', sortCode: '123456', accountNumber: '12345678',
      });
    });
  });

  describe('USD (us)', () => {
    it('accepts valid ABA routing numbers', () => {
      expect(ok('USD', { routingNumber: '021000021', accountNumber: '1234567' })).toEqual({ scheme: 'us', routingNumber: '021000021', accountNumber: '1234567' });
      expect(ok('USD', { routingNumber: '011000015', accountNumber: '1234567' })).toEqual({ scheme: 'us', routingNumber: '011000015', accountNumber: '1234567' });
    });

    it('rejects a routing number with a bad checksum or length', () => {
      expect(parseBankDetails('USD', { routingNumber: '021000022', accountNumber: '1234567' })).toEqual({ ok: false, failure: { error: 'routing_number_invalid', field: 'routingNumber' } });
      expect(parseBankDetails('USD', { routingNumber: '02100002', accountNumber: '1234567' })).toEqual({ ok: false, failure: { error: 'routing_number_invalid', field: 'routingNumber' } });
    });

    it('bounds the account number to 4-17 digits', () => {
      expect(ok('USD', { routingNumber: '021000021', accountNumber: '1234' }).scheme).toBe('us');
      expect(ok('USD', { routingNumber: '021000021', accountNumber: '12345678901234567' }).scheme).toBe('us');
      expect(parseBankDetails('USD', { routingNumber: '021000021', accountNumber: '123' })).toEqual({ ok: false, failure: { error: 'account_number_invalid', field: 'accountNumber' } });
      expect(parseBankDetails('USD', { routingNumber: '021000021', accountNumber: '123456789012345678' })).toEqual({ ok: false, failure: { error: 'account_number_invalid', field: 'accountNumber' } });
      expect(parseBankDetails('USD', { routingNumber: '021000021', accountNumber: '12a4567' })).toEqual({ ok: false, failure: { error: 'account_number_invalid', field: 'accountNumber' } });
    });

    it('strips dashes and spaces from the account number', () => {
      expect(ok('USD', { routingNumber: '021000021', accountNumber: '1234-5678 90' })).toEqual({ scheme: 'us', routingNumber: '021000021', accountNumber: '1234567890' });
    });

    it('refuses an IBAN or sort code', () => {
      expect(parseBankDetails('USD', { routingNumber: '021000021', accountNumber: '1234567', iban: 'NL91ABNA0417164300' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'iban' } });
      expect(parseBankDetails('USD', { routingNumber: '021000021', accountNumber: '1234567', sortCode: '123456' })).toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'sortCode' } });
    });
  });
});

describe('the local scheme', () => {
  it('accepts a BSB and account number, trimmed, the code uppercased', () => {
    expect(parseBankDetails('AUD', { bankCode: ' 062-000 ', accountNumber: ' 12345678 ' })).toEqual({
      ok: true, details: { scheme: 'local', currency: 'AUD', bankCode: '062-000', accountNumber: '12345678' },
    });
    expect(parseBankDetails('INR', { bankCode: 'sbin0001234', accountNumber: '123456789012' })).toEqual({
      ok: true, details: { scheme: 'local', currency: 'INR', bankCode: 'SBIN0001234', accountNumber: '123456789012' },
    });
  });

  it('refuses an AUD account with no BSB', () => {
    expect(parseBankDetails('AUD', { accountNumber: '12345678' }))
      .toEqual({ ok: false, failure: { error: 'bank_code_invalid', field: 'bankCode' } });
  });

  it.each(['NZD', 'MXN'] as const)('refuses a bank code for %s', (currency) => {
    expect(parseBankDetails(currency, { bankCode: '062000', accountNumber: '012345678901234567' }))
      .toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'bankCode' } });
  });

  it('accepts an NZD account number on its own', () => {
    expect(parseBankDetails('NZD', { accountNumber: '12-3456-7890123-00' })).toEqual({
      ok: true, details: { scheme: 'local', currency: 'NZD', bankCode: null, accountNumber: '12-3456-7890123-00' },
    });
  });

  it('refuses an IBAN on a local account', () => {
    expect(parseBankDetails('AUD', { bankCode: '062000', accountNumber: '12345678', iban: 'NL91ABNA0417164300' }))
      .toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'iban' } });
  });

  it.each([
    ['a character outside letters, digits, spaces and dashes', { bankCode: '062/000', accountNumber: '12345678' }, 'bankCode'],
    ['an account number under four characters', { bankCode: '062000', accountNumber: '123' }, 'accountNumber'],
    ['an account number over 34 characters', { bankCode: '062000', accountNumber: '1'.repeat(35) }, 'accountNumber'],
    ['a bank code over 20 characters', { bankCode: '1'.repeat(21), accountNumber: '12345678' }, 'bankCode'],
  ] as const)('refuses %s', (_label, input, field) => {
    const result = parseBankDetails('AUD', input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.field).toBe(field);
  });

  it('reads a stored AUD row and an NZD row, and refuses an AUD row with no BSB', () => {
    const base = { iban: null, bic: null, sortCode: null, routingNumber: null };
    expect(bankDetailsFromRow({ ...base, currency: 'AUD', bankCode: '062000', accountNumber: '12345678' }))
      .toEqual({ scheme: 'local', currency: 'AUD', bankCode: '062000', accountNumber: '12345678' });
    expect(bankDetailsFromRow({ ...base, currency: 'NZD', bankCode: null, accountNumber: '123456789012345' }))
      .toEqual({ scheme: 'local', currency: 'NZD', bankCode: null, accountNumber: '123456789012345' });
    expect(bankDetailsFromRow({ ...base, currency: 'AUD', bankCode: null, accountNumber: '12345678' })).toBeNull();
    expect(bankDetailsFromRow({ ...base, currency: 'NZD', bankCode: '062000', accountNumber: '12345678' })).toBeNull();
  });

  it('accepts a Polish IBAN under the iban scheme', () => {
    expect(parseBankDetails('PLN', { iban: 'PL61109010140000071219812874' }))
      .toEqual({ ok: true, details: { scheme: 'iban', iban: 'PL61109010140000071219812874', bic: null } });
  });
});

describe('BankDetailsFailure', () => {
  it('pairs each refusal with the field it names', () => {
    const paired: BankDetailsFailure = { error: 'sort_code_invalid', field: 'sortCode' };
    // @ts-expect-error iban_invalid names the iban field, never another
    const mispaired: BankDetailsFailure = { error: 'iban_invalid', field: 'sortCode' };
    expect([paired, mispaired]).toHaveLength(2);
  });
});

describe('BankDetailsInput', () => {
  it('is the scheme half of the body bankAccountSchema accepts', () => {
    expectTypeOf<Omit<z.infer<typeof bankAccountSchema>, 'holderName'>>().toEqualTypeOf<BankDetailsInput>();
  });
});

describe('scheme tables', () => {
  it('maps every currency to its scheme', () => {
    expect(SCHEME_FOR_CURRENCY).toEqual({
      EUR: 'sepa', GBP: 'uk', USD: 'us', CHF: 'iban', SEK: 'iban', NOK: 'iban', DKK: 'iban',
      INR: 'local', SGD: 'local', AUD: 'local', CAD: 'local', NZD: 'local', HKD: 'local',
      BRL: 'local', MXN: 'local', ZAR: 'local', PLN: 'iban', CZK: 'iban', ILS: 'iban', AED: 'iban',
    });
  });

  it('holds exactly the EU member states plus IS, LI and NO', () => {
    const eu27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
    expect([...EEA_COUNTRIES].sort()).toEqual([...eu27, 'IS', 'LI', 'NO'].sort());
  });

  it('knows the IBAN length of every EEA country', () => {
    const missing = [...EEA_COUNTRIES].filter((c) => !Object.hasOwn(IBAN_LENGTHS, c));
    expect(missing).toEqual([]);
  });

  // Each is the example IBAN the SWIFT IBAN registry publishes for its country.
  it.each([
    'FR7630006000011234567890189',
    'IT60X0542811101000000123456',
    'ES9121000418450200051332',
    'BE68539007547034',
    'AT611904300234573201',
    'IE29AIBK93115212345678',
    'PT50000201231234567890154',
    'PL61109010140000071219812874',
    'SE4550000000058398257466',
    'DK5000400440116243',
    'FI2112345600000785',
    'LU280019400644750000',
  ])('accepts the registry example %s in euros', (iban) => {
    expect(ok('EUR', { iban })).toEqual({ scheme: 'sepa', iban, bic: null });
  });

  it('holds the EEA members that matter for the BIC rule', () => {
    for (const c of ['NL', 'DE', 'NO', 'IS', 'LI', 'HR']) expect(EEA_COUNTRIES.has(c)).toBe(true);
    for (const c of ['CH', 'GB', 'MC', 'SM', 'AD', 'VA', 'GI']) expect(EEA_COUNTRIES.has(c)).toBe(false);
  });
});

describe('bankDetailsFromRow', () => {
  const blank = { iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null, bankCode: null };

  it('refuses a stored row that sets a bank code outside its scheme', () => {
    expect(bankDetailsFromRow({
      currency: 'GBP', iban: null, bic: null, sortCode: '123456', accountNumber: '12345678', routingNumber: null, bankCode: '062000',
    })).toBeNull();
  });

  it('round-trips each scheme', () => {
    expect(bankDetailsFromRow({ ...blank, currency: 'EUR', iban: 'NL91ABNA0417164300' })).toEqual({ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null });
    expect(bankDetailsFromRow({ ...blank, currency: 'CHF', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' })).toEqual({ scheme: 'iban', iban: 'CH9300762011623852957', bic: 'UBSWCHZH80A' });
    expect(bankDetailsFromRow({ ...blank, currency: 'GBP', sortCode: '123456', accountNumber: '12345678' })).toEqual({ scheme: 'uk', sortCode: '123456', accountNumber: '12345678' });
    expect(bankDetailsFromRow({ ...blank, currency: 'USD', routingNumber: '021000021', accountNumber: '1234567' })).toEqual({ scheme: 'us', routingNumber: '021000021', accountNumber: '1234567' });
  });

  it('returns null for a row the CHECK should have made impossible', () => {
    expect(bankDetailsFromRow({ ...blank, currency: 'GBP', sortCode: '123456', accountNumber: '12345678', iban: 'GB82WEST12345698765432' })).toBeNull();
    expect(bankDetailsFromRow({ ...blank, currency: 'EUR' })).toBeNull();
    expect(bankDetailsFromRow({ ...blank, currency: 'USD', routingNumber: '021000021' })).toBeNull();
  });

  it('returns null for a whitespace-only required column', () => {
    expect(bankDetailsFromRow({ ...blank, currency: 'EUR', iban: '   ' })).toBeNull();
    expect(bankDetailsFromRow({ ...blank, currency: 'GBP', sortCode: '\t', accountNumber: '12345678' })).toBeNull();
    expect(bankDetailsFromRow({ ...blank, currency: 'USD', routingNumber: '021000021', accountNumber: ' ' })).toBeNull();
  });

  it('reads a whitespace-only BIC as no BIC', () => {
    expect(bankDetailsFromRow({ ...blank, currency: 'EUR', iban: 'NL91ABNA0417164300', bic: '  ' })).toEqual({ scheme: 'sepa', iban: 'NL91ABNA0417164300', bic: null });
  });

  it('is structural: it applies no checksum and no BIC policy to a stored row', () => {
    expect(bankDetailsFromRow({ ...blank, currency: 'USD', routingNumber: '021000022', accountNumber: '1234567' })).toEqual({ scheme: 'us', routingNumber: '021000022', accountNumber: '1234567' });
    expect(bankDetailsFromRow({ ...blank, currency: 'EUR', iban: 'CH9300762011623852957' })).toEqual({ scheme: 'sepa', iban: 'CH9300762011623852957', bic: null });
  });
});

describe('maskedIdentifier', () => {
  it('shows only the last four characters of the IBAN or account number', () => {
    expect(maskedIdentifier({ iban: 'NL91ABNA0417164300', accountNumber: null })).toBe('•••• 4300');
    expect(maskedIdentifier({ iban: null, accountNumber: '12345678' })).toBe('•••• 5678');
  });
});
