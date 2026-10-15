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
