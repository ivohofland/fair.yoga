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
export const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22,
  BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18,
  FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27,
  GT: 28, HN: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26,
  IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20,
  LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20,
  MR: 27, MT: 31, MU: 30, NI: 28, NL: 18, NO: 15, OM: 23, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, SO: 23, ST: 25,
  SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
  YE: 30,
} as const satisfies Record<string, number>;

export type BankDetailsInput = {
  iban?: string | null;
  bic?: string | null;
  sortCode?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
};
/** Every scheme column of a stored account, `null` where the scheme does not use it. */
export type BankAccountColumns = { [K in keyof BankDetailsInput]-?: string | null };

/** Each refusal, and the field it names. */
type FieldFor = {
  iban_invalid: 'iban';
  bic_invalid: 'bic';
  bic_required: 'bic';
  sort_code_invalid: 'sortCode';
  account_number_invalid: 'accountNumber';
  routing_number_invalid: 'routingNumber';
  field_not_in_scheme: keyof BankDetailsInput;
};

export type BankDetailsError = keyof FieldFor;

/** A refusal paired with the field it names; no other pairing is representable. */
export type BankDetailsFailure = { [E in BankDetailsError]: { error: E; field: FieldFor[E] } }[BankDetailsError];

export type ParseResult =
  | { ok: true; details: BankDetails }
  | { ok: false; failure: BankDetailsFailure };

const FIELDS = ['iban', 'bic', 'sortCode', 'accountNumber', 'routingNumber'] as const satisfies readonly (keyof BankDetailsInput)[];

const BIC_PATTERN = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** Blank counts as absent. */
function present(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function fail(failure: BankDetailsFailure): ParseResult {
  return { ok: false, failure };
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
  if (foreign) return fail({ error: 'field_not_in_scheme', field: foreign });

  const rawIban = present(input.iban);
  if (rawIban === null) return fail({ error: 'iban_invalid', field: 'iban' });
  const iban = normaliseIban(rawIban);
  const country = ibanCountry(iban);
  if (country === null) return fail({ error: 'iban_invalid', field: 'iban' });

  const bic = parseBic(present(input.bic));
  if (!bic.ok) return fail({ error: 'bic_invalid', field: 'bic' });
  if (scheme === 'sepa' && bic.bic === null && !EEA_COUNTRIES.has(country)) return fail({ error: 'bic_required', field: 'bic' });

  return { ok: true, details: { scheme, iban, bic: bic.bic } };
}

function parseUk(input: BankDetailsInput): ParseResult {
  const foreign = firstForeignField(input, ['sortCode', 'accountNumber']);
  if (foreign) return fail({ error: 'field_not_in_scheme', field: foreign });

  const sortCode = (present(input.sortCode) ?? '').replace(/[-\s]/g, '');
  if (!/^[0-9]{6}$/.test(sortCode)) return fail({ error: 'sort_code_invalid', field: 'sortCode' });
  const accountNumber = (present(input.accountNumber) ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{8}$/.test(accountNumber)) return fail({ error: 'account_number_invalid', field: 'accountNumber' });

  return { ok: true, details: { scheme: 'uk', sortCode, accountNumber } };
}

function parseUs(input: BankDetailsInput): ParseResult {
  const foreign = firstForeignField(input, ['routingNumber', 'accountNumber']);
  if (foreign) return fail({ error: 'field_not_in_scheme', field: foreign });

  const routingNumber = (present(input.routingNumber) ?? '').replace(/\s+/g, '');
  if (!/^[0-9]{9}$/.test(routingNumber) || !abaChecksumHolds(routingNumber)) return fail({ error: 'routing_number_invalid', field: 'routingNumber' });
  const accountNumber = (present(input.accountNumber) ?? '').replace(/[-\s]/g, '');
  if (!/^[0-9]{4,17}$/.test(accountNumber)) return fail({ error: 'account_number_invalid', field: 'accountNumber' });

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

/**
 * The one parser from a stored row to the union. Structural only: the scheme's
 * required columns are present and non-blank and every column outside the
 * scheme is null; no checksum, length table or BIC policy runs. Null means the
 * row is malformed, and the caller logs it (`docs/data-model.md`,
 * TeacherBankAccount).
 */
export function bankDetailsFromRow(row: { currency: Currency } & BankAccountColumns): BankDetails | null {
  const scheme = SCHEME_FOR_CURRENCY[row.currency];
  // Blank or whitespace-only counts as absent.
  const has = (v: string | null): v is string => v !== null && v.trim() !== '';
  const only = (allowed: readonly (keyof BankDetailsInput)[]): boolean =>
    FIELDS.every((f) => allowed.includes(f) || row[f] === null);
  switch (scheme) {
    case 'sepa':
    case 'iban':
      if (!only(['iban', 'bic']) || !has(row.iban)) return null;
      return { scheme, iban: row.iban, bic: has(row.bic) ? row.bic : null };
    case 'uk':
      if (!only(['sortCode', 'accountNumber']) || !has(row.sortCode) || !has(row.accountNumber)) return null;
      return { scheme, sortCode: row.sortCode, accountNumber: row.accountNumber };
    case 'us':
      if (!only(['routingNumber', 'accountNumber']) || !has(row.routingNumber) || !has(row.accountNumber)) return null;
      return { scheme, routingNumber: row.routingNumber, accountNumber: row.accountNumber };
    default: {
      const unhandled: never = scheme;
      throw new Error(`unhandled bank scheme ${String(unhandled)}`);
    }
  }
}

/**
 * A stored account's identifier as four bullets and its last four characters:
 * the IBAN, or the account number when there is no IBAN.
 */
export function maskedIdentifier(row: { iban: string | null; accountNumber: string | null }): string {
  return `•••• ${(row.iban ?? row.accountNumber ?? '').slice(-4)}`;
}
