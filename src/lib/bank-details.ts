import type { Currency } from '@prisma/client';

export type BankDetails =
  | { scheme: 'sepa'; iban: string; bic: string | null }
  | { scheme: 'iban'; iban: string; bic: string | null }
  | { scheme: 'uk'; sortCode: string; accountNumber: string }
  | { scheme: 'us'; routingNumber: string; accountNumber: string };

export const SCHEME_FOR_CURRENCY = {
  EUR: 'sepa', GBP: 'uk', USD: 'us', CHF: 'iban', SEK: 'iban', NOK: 'iban', DKK: 'iban',
} as const satisfies Record<Currency, BankDetails['scheme']>;

/** EU member states plus Iceland, Liechtenstein and Norway. */
export const EEA_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
]);

// Total IBAN length per country, from the SWIFT IBAN registry.
const IBAN_LENGTHS = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26,
  IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28,
  PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
} as const satisfies Record<string, number>;

export type BankDetailsInput = {
  iban?: string | null;
  bic?: string | null;
  sortCode?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
};
export type BankDetailsError =
  | 'iban_invalid'
  | 'bic_invalid'
  | 'bic_required'
  | 'sort_code_invalid'
  | 'account_number_invalid'
  | 'routing_number_invalid'
  | 'field_not_in_scheme';

type ParseResult =
  | { ok: true; details: BankDetails }
  | { ok: false; error: BankDetailsError; field: keyof BankDetailsInput };

const FIELDS = ['iban', 'bic', 'sortCode', 'accountNumber', 'routingNumber'] as const satisfies readonly (keyof BankDetailsInput)[];

const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** Blank counts as absent. */
function present(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim() === '' ? null : value;
}

function fail(error: BankDetailsError, field: keyof BankDetailsInput): ParseResult {
  return { ok: false, error, field };
}

function isKnownIbanCountry(country: string): country is keyof typeof IBAN_LENGTHS {
  return Object.hasOwn(IBAN_LENGTHS, country);
}

/** The IBAN's country when `iban` (already normalised) is well formed and its mod-97 check holds. */
function ibanCountry(iban: string): string | null {
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return null;
  const country = iban.slice(0, 2);
  if (!isKnownIbanCountry(country) || iban.length !== IBAN_LENGTHS[country]) return null;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1 ? country : null;
}

function normaliseIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

function parseBic(raw: string | null): { ok: true; bic: string | null } | { ok: false } {
  if (raw === null) return { ok: true, bic: null };
  const bic = raw.replace(/\s+/g, '').toUpperCase();
  return BIC_PATTERN.test(bic) ? { ok: true, bic } : { ok: false };
}

/** A weighted ABA checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
function abaChecksumHolds(routing: string): boolean {
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = weights.reduce((acc, w, i) => acc + w * Number(routing.charAt(i)), 0);
  return sum % 10 === 0;
}

/** The first field the input supplied non-blank that `allowed` does not list. */
function firstForeignField(input: BankDetailsInput, allowed: readonly (keyof BankDetailsInput)[]): keyof BankDetailsInput | null {
  for (const f of FIELDS) {
    if (!allowed.includes(f) && present(input[f]) !== null) return f;
  }
  return null;
}

function parseIbanScheme(scheme: 'sepa' | 'iban', input: BankDetailsInput): ParseResult {
  const foreign = firstForeignField(input, ['iban', 'bic']);
  if (foreign) return fail('field_not_in_scheme', foreign);

  const rawIban = present(input.iban);
  if (rawIban === null) return fail('iban_invalid', 'iban');
  const iban = normaliseIban(rawIban);
  const country = ibanCountry(iban);
  if (country === null) return fail('iban_invalid', 'iban');

  const bic = parseBic(present(input.bic));
  if (!bic.ok) return fail('bic_invalid', 'bic');
  if (scheme === 'sepa' && bic.bic === null && !EEA_COUNTRIES.has(country)) return fail('bic_required', 'bic');

  return { ok: true, details: { scheme, iban, bic: bic.bic } };
}

function parseUk(input: BankDetailsInput): ParseResult {
  const foreign = firstForeignField(input, ['sortCode', 'accountNumber']);
  if (foreign) return fail('field_not_in_scheme', foreign);

  const sortCode = (present(input.sortCode) ?? '').replace(/[-\s]/g, '');
  if (!/^[0-9]{6}$/.test(sortCode)) return fail('sort_code_invalid', 'sortCode');
  const accountNumber = (present(input.accountNumber) ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{8}$/.test(accountNumber)) return fail('account_number_invalid', 'accountNumber');

  return { ok: true, details: { scheme: 'uk', sortCode, accountNumber } };
}

function parseUs(input: BankDetailsInput): ParseResult {
  const foreign = firstForeignField(input, ['routingNumber', 'accountNumber']);
  if (foreign) return fail('field_not_in_scheme', foreign);

  const routingNumber = (present(input.routingNumber) ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{9}$/.test(routingNumber) || !abaChecksumHolds(routingNumber)) return fail('routing_number_invalid', 'routingNumber');
  const accountNumber = (present(input.accountNumber) ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{4,17}$/.test(accountNumber)) return fail('account_number_invalid', 'accountNumber');

  return { ok: true, details: { scheme: 'us', routingNumber, accountNumber } };
}

/** Normalises and validates `input` against `currency`'s scheme. */
export function parseBankDetails(currency: Currency, input: BankDetailsInput): ParseResult {
  const scheme = SCHEME_FOR_CURRENCY[currency];
  switch (scheme) {
    case 'sepa':
    case 'iban':
      return parseIbanScheme(scheme, input);
    case 'uk':
      return parseUk(input);
    case 'us':
      return parseUs(input);
    default: {
      const unhandled: never = scheme;
      throw new Error(`unhandled bank scheme ${String(unhandled)}`);
    }
  }
}

/** The one parser from a stored row to the union; null (caller logs) for a row the CHECK should have made impossible. */
export function bankDetailsFromRow(
  row: { currency: Currency } & Required<{ [K in keyof BankDetailsInput]: string | null }>,
): BankDetails | null {
  const result = parseBankDetails(row.currency, row);
  return result.ok ? result.details : null;
}
