import type { Currency } from '@prisma/client';
import type { BankScheme } from '@/lib/bank-details';

/**
 * Everything the app knows about one currency. Hand-written, never `Intl`:
 * ICU output differs between the server render and the browser.
 */
export type CurrencyInfo = {
  /** Before the amount: a symbol, or the code with its trailing space. */
  prefix: string;
  /** The currency in words, as the picker lists it. */
  name: string;
  scheme: BankScheme;
  /** What the bank-code field is called; null when the scheme takes none. */
  bankCodeLabel: string | null;
  accountLabel: string;
  /** IANA zones that suggest this currency; an entry ending in `/` matches as a prefix. */
  timeZones: readonly string[];
};

const ACCOUNT = 'Account number';

export const CURRENCY_INFO = {
  EUR: {
    prefix: '€', name: 'Euro', scheme: 'sepa', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: [
      'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Bratislava', 'Europe/Brussels',
      'Europe/Busingen', 'Europe/Dublin', 'Europe/Helsinki', 'Europe/Lisbon', 'Europe/Ljubljana',
      'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta', 'Europe/Mariehamn', 'Europe/Monaco',
      'Europe/Paris', 'Europe/Riga', 'Europe/Rome', 'Europe/San_Marino', 'Europe/Tallinn',
      'Europe/Vatican', 'Europe/Vienna', 'Europe/Vilnius', 'Europe/Zagreb', 'Europe/Andorra',
      'Atlantic/Azores', 'Atlantic/Canary', 'Atlantic/Madeira', 'Africa/Ceuta', 'Asia/Nicosia',
      'Asia/Famagusta', 'Europe/Nicosia',
    ],
  },
  GBP: {
    prefix: '£', name: 'Pound sterling', scheme: 'uk', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Europe/London', 'Europe/Belfast', 'Europe/Guernsey', 'Europe/Isle_of_Man', 'Europe/Jersey'],
  },
  USD: {
    prefix: '$', name: 'US dollar', scheme: 'us', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
      'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Nome', 'America/Yakutat',
      'America/Metlakatla', 'America/Adak', 'America/Boise', 'America/Detroit', 'America/Menominee',
      'America/Indiana/', 'America/Kentucky/', 'America/North_Dakota/', 'America/Puerto_Rico',
      'Pacific/Honolulu', 'US/',
    ],
  },
  CHF: {
    prefix: 'CHF ', name: 'Swiss franc', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Europe/Zurich', 'Europe/Vaduz'],
  },
  SEK: {
    prefix: 'SEK ', name: 'Swedish krona', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Europe/Stockholm'],
  },
  NOK: {
    prefix: 'NOK ', name: 'Norwegian krone', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Europe/Oslo', 'Arctic/Longyearbyen'],
  },
  DKK: {
    prefix: 'DKK ', name: 'Danish krone', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Europe/Copenhagen', 'Atlantic/Faroe', 'America/Nuuk'],
  },
  INR: {
    prefix: '₹', name: 'Indian rupee', scheme: 'local', bankCodeLabel: 'IFSC', accountLabel: ACCOUNT,
    timeZones: ['Asia/Kolkata', 'Asia/Calcutta'],
  },
  SGD: {
    prefix: 'S$', name: 'Singapore dollar', scheme: 'local', bankCodeLabel: 'Bank code', accountLabel: ACCOUNT,
    timeZones: ['Asia/Singapore', 'Singapore'],
  },
  AUD: {
    prefix: 'A$', name: 'Australian dollar', scheme: 'local', bankCodeLabel: 'BSB', accountLabel: ACCOUNT,
    timeZones: ['Australia/'],
  },
  CAD: {
    prefix: 'C$', name: 'Canadian dollar', scheme: 'local', bankCodeLabel: 'Institution & transit', accountLabel: ACCOUNT,
    timeZones: [
      'America/Toronto', 'America/Montreal', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg',
      'America/Regina', 'America/Swift_Current', 'America/Halifax', 'America/Glace_Bay', 'America/Moncton',
      'America/Goose_Bay', 'America/St_Johns', 'America/Whitehorse', 'America/Dawson', 'America/Dawson_Creek',
      'America/Fort_Nelson', 'America/Creston', 'America/Yellowknife', 'America/Inuvik', 'America/Cambridge_Bay',
      'America/Rankin_Inlet', 'America/Resolute', 'America/Iqaluit', 'America/Atikokan', 'America/Nipigon',
      'America/Thunder_Bay', 'America/Rainy_River', 'America/Pangnirtung', 'Canada/',
    ],
  },
  NZD: {
    prefix: 'NZ$', name: 'New Zealand dollar', scheme: 'local', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Pacific/Auckland', 'Pacific/Chatham', 'NZ'],
  },
  HKD: {
    prefix: 'HK$', name: 'Hong Kong dollar', scheme: 'local', bankCodeLabel: 'Bank code', accountLabel: ACCOUNT,
    timeZones: ['Asia/Hong_Kong', 'Hongkong'],
  },
  BRL: {
    prefix: 'R$', name: 'Brazilian real', scheme: 'local', bankCodeLabel: 'Bank & agency', accountLabel: ACCOUNT,
    timeZones: [
      'America/Sao_Paulo', 'America/Bahia', 'America/Fortaleza', 'America/Recife', 'America/Maceio',
      'America/Belem', 'America/Araguaina', 'America/Santarem', 'America/Manaus', 'America/Boa_Vista',
      'America/Porto_Velho', 'America/Rio_Branco', 'America/Eirunepe', 'America/Cuiaba',
      'America/Campo_Grande', 'America/Noronha', 'Brazil/',
    ],
  },
  MXN: {
    prefix: 'MX$', name: 'Mexican peso', scheme: 'local', bankCodeLabel: null, accountLabel: 'CLABE',
    timeZones: [
      'America/Mexico_City', 'America/Cancun', 'America/Merida', 'America/Monterrey', 'America/Matamoros',
      'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Ojinaga', 'America/Hermosillo',
      'America/Mazatlan', 'America/Bahia_Banderas', 'America/Tijuana', 'Mexico/',
    ],
  },
  ZAR: {
    prefix: 'ZAR ', name: 'South African rand', scheme: 'local', bankCodeLabel: 'Branch code', accountLabel: ACCOUNT,
    timeZones: ['Africa/Johannesburg'],
  },
  PLN: {
    prefix: 'PLN ', name: 'Polish złoty', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Europe/Warsaw', 'Poland'],
  },
  CZK: {
    prefix: 'CZK ', name: 'Czech koruna', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Europe/Prague'],
  },
  ILS: {
    prefix: 'ILS ', name: 'Israeli shekel', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Asia/Jerusalem', 'Asia/Tel_Aviv', 'Israel'],
  },
  AED: {
    prefix: 'AED ', name: 'UAE dirham', scheme: 'iban', bankCodeLabel: null, accountLabel: ACCOUNT,
    timeZones: ['Asia/Dubai'],
  },
} as const satisfies Record<Currency, CurrencyInfo>;

function matches(entry: string, timeZone: string): boolean {
  return entry.endsWith('/') ? timeZone.startsWith(entry) && timeZone.length > entry.length : entry === timeZone;
}

/** The currency `timeZone` suggests, or `null` when no currency claims it. */
export function suggestedCurrency(timeZone: string): Currency | null {
  for (const [currency, info] of Object.entries(CURRENCY_INFO) as [Currency, CurrencyInfo][]) {
    if (info.timeZones.some((entry) => matches(entry, timeZone))) return currency;
  }
  return null;
}
