# More Currencies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add thirteen two-decimal currencies (20 in all), a generic `local` bank scheme for the non-IBAN ones, and a currency picker that suggests from the teacher's time zone.

**Architecture:** Every per-currency fact moves into one `CURRENCY_INFO` record (`src/lib/currency.ts`) tethered to the Prisma `Currency` enum; `CURRENCY_PREFIX`, `SCHEME_FOR_CURRENCY` and the picker labels derive from it. `TeacherBankAccount` gains a nullable `bankCode` column; the `BankDetails` union gains a `local` member. The database CHECK is replaced twice: once to hold `bankCode` null on the existing schemes, once to admit the new currencies.

**Tech Stack:** Next.js 16, TypeScript strict, Prisma + PostgreSQL 16, Vitest (projects `unit`, `components`, `integration`), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-15-more-currencies-design.md`

**Deviations from the spec, decided while planning:**
- The `local` member carries its currency — `{ scheme: 'local'; currency: Currency; bankCode: string | null; accountNumber: string }` — because `PaymentDetails` receives only `details` and must look up the BSB/IFSC/CLABE labels. Task 3 amends the spec's type line.
- Three migrations, not two: `bank_code_column` (Task 2) lands the column ahead of any new currency so it can be threaded and tested on its own; `add_currencies` and `local_bank_scheme` (Task 3) are the spec's two. The enum value still never meets its first use in one transaction. Task 3 amends the spec's "Two migrations" paragraph.

## Global Constraints

- Node 24: run pnpm through the nvm v24 bin (`export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep '^v24' | tail -1)/bin:$PATH"`).
- New currencies, in this enum order after `DKK`: `INR, SGD, AUD, CAD, NZD, HKD, BRL, MXN, ZAR, PLN, CZK, ILS, AED`. No HUF, JPY, KRW, ISK.
- IBAN scheme: `CHF, SEK, NOK, DKK, PLN, CZK, ILS, AED`. Local with bank code: `AUD, CAD, INR, SGD, HKD, ZAR, BRL`. Local without: `NZD, MXN`.
- Prefixes and labels: hand-written strings, never `Intl` (`CURRENCY_PREFIX` docblock gives the reason).
- Migrations via `pnpm exec prisma migrate dev --name <name>` (`--create-only` when hand-editing SQL). An applied migration is never edited again, comments included.
- Comments annotate the code they sit on; no counts or member lists in prose (CLAUDE.md, Comment Discipline).
- Every 409 names a registered code; this work adds 400s only, which keep `formatIssues`' `path: message` shape.
- Test-first: every step that writes code is preceded by a failing test.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A teacher switches currency from EUR to AUD with a saved EUR account.** The EUR account must remain and keep showing on EUR payments; the AUD block starts empty with BSB + Account number fields. → Task 3, Step 1 (service test "keeps the euro account when an AUD one is added").
2. **A BSB typed with a dash or spaces (`062-000`, `062 000`).** It should be accepted and stored as typed minus surrounding whitespace, uppercased. → Task 3, Step 1 (parse test).
3. **Changing only the BSB is a new payout destination** (#786 alert must say the identifier changed). → Task 2, Step 1 (`identifierChanged` test).
4. **A stored zone the suggestion table does not know** (`Etc/UTC`, `Antarctica/Troll`). No Suggested group, no crash. → Task 4, Step 1.
5. **The GDPR export of a teacher with an AUD account** carries `bankCode`. → Task 2, Step 1 (gdpr expectation) and Task 3, Step 1 (AUD row).

---

### Task 1: `CURRENCY_INFO` and `suggestedCurrency` for the existing seven

A refactor with no visible change, plus one new pure function.

**Files:**
- Create: `src/lib/currency.ts`
- Create: `src/lib/currency.test.ts`
- Modify: `src/lib/format.ts` (`CURRENCY_PREFIX` derives from `CURRENCY_INFO`)
- Modify: `src/lib/bank-details.ts:9-11` (`SCHEME_FOR_CURRENCY` derives)

**Interfaces:**
- Produces:
  ```ts
  export type CurrencyInfo = {
    prefix: string;                         // '€', 'A$', 'CHF ' (code prefixes carry their space)
    name: string;                           // 'Australian dollar'
    scheme: BankScheme;                     // from bank-details
    bankCodeLabel: string | null;           // 'BSB'; null when the scheme takes no bank code
    accountLabel: string;                   // 'Account number' | 'CLABE'
    timeZones: readonly string[];           // IANA ids; an entry ending in '/' matches as a prefix
  };
  export const CURRENCY_INFO: { readonly [C in Currency]: CurrencyInfo };
  export function suggestedCurrency(timeZone: string): Currency | null;
  ```
  `bank-details.ts` exports `type BankScheme = BankDetails['scheme']`.

- [ ] **Step 1: Write the failing test** — `src/lib/currency.test.ts`

```ts
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
      if (CURRENCY_INFO[c].scheme !== 'local') expect(CURRENCY_INFO[c].bankCodeLabel).toBeNull();
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/currency.test.ts`
Expected: FAIL — `Cannot find module './currency'`.

- [ ] **Step 3: Implement** — `src/lib/currency.ts`

```ts
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
```

In `src/lib/bank-details.ts`, export the scheme type and derive the map (keep the exported name and its `satisfies`):

```ts
import { CURRENCY_INFO } from '@/lib/currency';

export type BankScheme = BankDetails['scheme'];

export const SCHEME_FOR_CURRENCY = Object.fromEntries(
  Object.entries(CURRENCY_INFO).map(([c, info]) => [c, info.scheme]),
) as { readonly [C in Currency]: (typeof CURRENCY_INFO)[C]['scheme'] };
```

In `src/lib/format.ts`, replace the `CURRENCY_PREFIX` literal (keep its docblock's first sentence; the ICU reason now lives on `CurrencyInfo`):

```ts
import { CURRENCY_INFO } from '@/lib/currency';

/** Each currency's prefix, from `CURRENCY_INFO`. */
export const CURRENCY_PREFIX = Object.fromEntries(
  Object.entries(CURRENCY_INFO).map(([c, info]) => [c, info.prefix]),
) as { readonly [C in Currency]: (typeof CURRENCY_INFO)[C]['prefix'] };
```

The `currency.ts` → `bank-details.ts` import is type-only, so there is no runtime cycle.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run --project unit src/lib/currency.test.ts src/lib/format.test.ts src/lib/bank-details.test.ts src/lib/money-totals.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/currency.ts src/lib/currency.test.ts src/lib/format.ts src/lib/bank-details.ts
git commit -m "refactor: one CURRENCY_INFO record per currency, and suggestedCurrency from a time zone"
```

---

### Task 2: The `bankCode` column, held null on every existing scheme

Threads the new column through every consumer before any currency uses it.

**Files:**
- Modify: `prisma/schema.prisma` (`TeacherBankAccount`: `bankCode String?` after `routingNumber`)
- Create: `prisma/migrations/<ts>_bank_code_column/migration.sql`
- Modify: `src/lib/bank-details.ts` (`BankDetailsInput`, `FIELDS`, `bankDetailsFromRow`'s `only` lists)
- Modify: `src/lib/schemas.ts:353-360` (`bankCode: bankField`)
- Modify: `src/lib/payment-methods.ts` (`bankAccountDataSelect.bankCode`)
- Modify: `src/services/bank-accounts.ts` (`STORED_KEYS`, `IDENTIFIER_COLUMNS.bankCode: true`, `columnsFor` → `bankCode: null`)
- Modify: `src/app/api/teachers/[id]/bank-accounts/[currency]/route.ts` (`FIELD_IN_WORDS.bankCode: 'a bank code'`)
- Modify: `src/app/(teacher)/settings/resume-payments/page.tsx` (`DETAIL_LABELS.bankCode: 'Bank code'`)
- Modify: `src/app/(teacher)/settings/profile/page.tsx` (`initial.bankCode`)
- Modify: `src/components/settings/bank-account-form.tsx` (`EMPTY_BANK_ACCOUNT.bankCode: ''`)
- Test: `tests/integration/teachers-api.test.ts`, `src/lib/bank-details.test.ts`, `src/services/bank-accounts.test.ts`, `src/services/gdpr.test.ts`, `src/components/settings/bank-account-form.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `BankDetailsInput.bankCode?: string | null`; `BankAccountColumns.bankCode: string | null`; `TeacherBankAccount.bankCode: string | null`; `bankAccountSchema` accepts `bankCode`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/teachers-api.test.ts`, in `'the database holds each currency to its scheme'`: add `bankCode: null` to `blank`, and to the refusal table:

```ts
      ['a EUR account with a bank code', { currency: 'EUR', holderName: 'H. Teacher', iban: 'NL91ABNA0417164300', bankCode: '062000' }],
      ['a GBP account with a bank code', { currency: 'GBP', holderName: 'H. Teacher', sortCode: '123456', accountNumber: '12345678', bankCode: '062000' }],
      ['a USD account with a bank code', { currency: 'USD', holderName: 'H. Teacher', routingNumber: '021000021', accountNumber: '1234567', bankCode: '062000' }],
```

`src/lib/bank-details.test.ts`:

```ts
  it('refuses a bank code on an IBAN account', () => {
    expect(parseBankDetails('EUR', { iban: 'NL91ABNA0417164300', bankCode: '062000' }))
      .toEqual({ ok: false, failure: { error: 'field_not_in_scheme', field: 'bankCode' } });
  });

  it('refuses a stored row that sets a bank code outside its scheme', () => {
    expect(bankDetailsFromRow({
      currency: 'GBP', iban: null, bic: null, sortCode: '123456', accountNumber: '12345678', routingNumber: null, bankCode: '062000',
    })).toBeNull();
  });
```

`src/services/bank-accounts.test.ts`: extend `storedAccounts`' select with `bankCode: true`, and add every existing expected row's `bankCode: null` (the type now demands it). In `src/services/gdpr.test.ts:3633-3636`, add `bankCode: null` to both expected rows. In `bank-account-form.test.tsx`'s `storedRow`, add `bankCode: null` to `data`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/bank-details.test.ts` and `pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts`
Expected: FAIL — type errors on `bankCode`, and Prisma "Unknown argument `bankCode`".

- [ ] **Step 3: Migration**

Add `bankCode String?` to `TeacherBankAccount` in `prisma/schema.prisma`, then `pnpm exec prisma migrate dev --create-only --name bank_code_column` and replace the generated SQL with:

```sql
-- AlterTable
ALTER TABLE "TeacherBankAccount" ADD COLUMN "bankCode" TEXT;

-- Each currency sets exactly its scheme's columns, the required ones
-- non-blank, the others NULL; no existing scheme uses a bank code.
ALTER TABLE "TeacherBankAccount" DROP CONSTRAINT "TeacherBankAccount_scheme_check";
ALTER TABLE "TeacherBankAccount" ADD CONSTRAINT "TeacherBankAccount_scheme_check" CHECK (
  btrim("holderName") <> ''
  AND ("bic" IS NULL OR btrim("bic") <> '')
  AND CASE
    WHEN "currency" IN ('EUR', 'CHF', 'SEK', 'NOK', 'DKK') THEN
      "iban" IS NOT NULL AND btrim("iban") <> ''
      AND "sortCode" IS NULL AND "accountNumber" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    WHEN "currency" = 'GBP' THEN
      "sortCode" IS NOT NULL AND btrim("sortCode") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    WHEN "currency" = 'USD' THEN
      "routingNumber" IS NOT NULL AND btrim("routingNumber") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL AND "bankCode" IS NULL
    ELSE false
  END
);
```

Run `pnpm exec prisma migrate dev` to apply it and regenerate the client.

- [ ] **Step 4: Thread the column**

`src/lib/bank-details.ts`: add `bankCode?: string | null;` to `BankDetailsInput`; add `'bankCode'` to `FIELDS`. `bankDetailsFromRow`'s `only([...])` already refuses any non-null column outside its list, so the GBP-with-bank-code test passes once `FIELDS` names it. Add `bank_code_invalid: 'bankCode';` to `FieldFor` now (Task 3 uses it); the route's `INVALID_MESSAGES` then needs `bank_code_invalid: 'Enter a valid bank code.'`.

`src/lib/schemas.ts`: `bankCode: bankField,` after `routingNumber`.
`src/lib/payment-methods.ts`: `bankCode: true,` in `bankAccountDataSelect`.
`src/services/bank-accounts.ts`: `bankCode: true` in `STORED_KEYS` and `IDENTIFIER_COLUMNS` (a new BSB is a new destination); every `columnsFor` branch returns `bankCode: null`.
`route.ts`: `bankCode: 'a bank code',` in `FIELD_IN_WORDS`.
`resume-payments/page.tsx`: `bankCode: 'Bank code',` in `DETAIL_LABELS` (Task 3 replaces it with the currency's own label if the page shows one; check there).
`profile/page.tsx`: `bankCode: current?.bankCode ?? '',` in `initial`.
`bank-account-form.tsx`: `bankCode: ''` in `EMPTY_BANK_ACCOUNT`.

Every one of these is a compile error until done (`satisfies Record<…>` and `_bankAccountDataIsEveryDetailColumn`); `pnpm typecheck` is the checklist.

- [ ] **Step 5: Run the tests**

Run: `pnpm typecheck && pnpm exec vitest run --project unit --project components && pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts src/services/bank-accounts.test.ts src/services/gdpr.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma src tests
git commit -m "feat: TeacherBankAccount.bankCode, held null by every existing scheme"
```

---

### Task 3: Thirteen currencies and the `local` scheme

**Files:**
- Modify: `prisma/schema.prisma` (`enum Currency` + 13 members)
- Create: `prisma/migrations/<ts>_add_currencies/migration.sql` (generated)
- Create: `prisma/migrations/<ts>_local_bank_scheme/migration.sql` (hand-written)
- Modify: `src/lib/currency.ts` (13 entries)
- Modify: `src/lib/format.ts:242` (`CURRENCIES`)
- Modify: `src/lib/bank-details.ts` (union member, `parseLocal`, both switches)
- Modify: `src/services/bank-accounts.ts` (`columnsFor` `local` branch)
- Modify: `src/components/settings/bank-account-form.tsx` (fields per currency)
- Modify: `src/components/student/payment-details.tsx` (`local` branch)
- Modify: `docs/superpowers/specs/2026-10-15-more-currencies-design.md` (the `local` type line gains `currency: Currency`)
- Test: `src/lib/format.test.ts`, `src/lib/bank-details.test.ts`, `src/lib/currency.test.ts`, `src/services/bank-accounts.test.ts`, `tests/integration/teachers-api.test.ts`, `src/components/settings/bank-account-form.test.tsx`, `src/components/student/payment-details.test.tsx`

**Interfaces:**
- Consumes: `CURRENCY_INFO`, `CurrencyInfo`, `BankScheme` (Task 1); `bankCode` column and input (Task 2).
- Produces: `BankDetails` member `{ scheme: 'local'; currency: Currency; bankCode: string | null; accountNumber: string }`.

- [ ] **Step 1: Write the failing tests**

`src/lib/format.test.ts`:

```ts
describe('formatMoneyCents in the added currencies', () => {
  it.each([
    ['INR', '₹12.50'], ['SGD', 'S$12.50'], ['AUD', 'A$12.50'], ['CAD', 'C$12.50'],
    ['NZD', 'NZ$12.50'], ['HKD', 'HK$12.50'], ['BRL', 'R$12.50'], ['MXN', 'MX$12.50'],
    ['ZAR', 'ZAR 12.50'], ['PLN', 'PLN 12.50'], ['CZK', 'CZK 12.50'], ['ILS', 'ILS 12.50'], ['AED', 'AED 12.50'],
  ] as const)('%s → %s', (currency, shown) => {
    expect(formatMoneyCents(1250, currency)).toBe(shown);
  });

  it('puts the minus before a symbol prefix', () => {
    expect(formatMoneyCents(-1250, 'AUD')).toBe('−A$12.50');
  });

  it('labels a symbol currency by its symbol and a code currency by its code', () => {
    expect(currencyLabel('INR')).toBe('₹');
    expect(currencyLabel('PLN')).toBe('PLN');
  });
});
```

`src/lib/currency.test.ts`, extend the `suggestedCurrency` table:

```ts
    ['Australia/Sydney', 'AUD'], ['Australia/Perth', 'AUD'], ['America/Toronto', 'CAD'],
    ['America/Vancouver', 'CAD'], ['Asia/Kolkata', 'INR'], ['Asia/Singapore', 'SGD'],
    ['Pacific/Auckland', 'NZD'], ['Asia/Hong_Kong', 'HKD'], ['America/Sao_Paulo', 'BRL'],
    ['America/Mexico_City', 'MXN'], ['Africa/Johannesburg', 'ZAR'], ['Europe/Warsaw', 'PLN'],
    ['Europe/Prague', 'CZK'], ['Asia/Jerusalem', 'ILS'], ['Asia/Dubai', 'AED'],
```

and add:

```ts
  it('gives a bank-code label to the local currencies that route by one, and none to NZD and MXN', () => {
    const withCode = (['AUD', 'CAD', 'INR', 'SGD', 'HKD', 'ZAR', 'BRL'] as const).map((c) => CURRENCY_INFO[c].bankCodeLabel);
    expect(withCode.every((l) => l !== null)).toBe(true);
    expect(CURRENCY_INFO.NZD.bankCodeLabel).toBeNull();
    expect(CURRENCY_INFO.MXN.bankCodeLabel).toBeNull();
    expect(CURRENCY_INFO.MXN.accountLabel).toBe('CLABE');
  });
```

`src/lib/bank-details.test.ts` — replace the `SCHEME_FOR_CURRENCY` expectation (line 184) with:

```ts
    expect(SCHEME_FOR_CURRENCY).toEqual({
      EUR: 'sepa', GBP: 'uk', USD: 'us', CHF: 'iban', SEK: 'iban', NOK: 'iban', DKK: 'iban',
      INR: 'local', SGD: 'local', AUD: 'local', CAD: 'local', NZD: 'local', HKD: 'local',
      BRL: 'local', MXN: 'local', ZAR: 'local', PLN: 'iban', CZK: 'iban', ILS: 'iban', AED: 'iban',
    });
```

and add:

```ts
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
```

`src/services/bank-accounts.test.ts`:

```ts
  it('saves an AUD account by BSB and keeps the euro account beside it', async () => {
    const teacherId = await makeTeacher('AUD');
    await saveBankAccount(prisma, teacherId, 'EUR', { holderName: 'B. Teacher', iban: 'NL91ABNA0417164300' });
    const outcome = await saveBankAccount(prisma, teacherId, 'AUD', { holderName: 'B. Teacher', bankCode: '062-000', accountNumber: '12345678' });
    expect(outcome.kind).toBe('saved');
    expect(await storedAccounts(teacherId)).toEqual([
      { currency: 'EUR', holderName: 'B. Teacher', iban: 'NL91ABNA0417164300', bic: null, sortCode: null, accountNumber: null, routingNumber: null, bankCode: null },
      { currency: 'AUD', holderName: 'B. Teacher', iban: null, bic: null, sortCode: null, accountNumber: '12345678', routingNumber: null, bankCode: '062-000' },
    ]);
  });

  it('records a changed identifier when only the BSB moves', async () => {
    const teacherId = await makeTeacher('AUD');
    await saveBankAccount(prisma, teacherId, 'AUD', { holderName: 'B. Teacher', bankCode: '062000', accountNumber: '12345678' });
    const outcome = await saveBankAccount(prisma, teacherId, 'AUD', { holderName: 'B. Teacher', bankCode: '063000', accountNumber: '12345678' });
    if (outcome.kind !== 'saved') throw new Error(`expected saved, got ${outcome.kind}`);
    const event = await prisma.payoutChangeEvent.findUniqueOrThrow({ where: { id: outcome.eventId } });
    expect(event.identifierChanged).toBe(true);
  });
```

`tests/integration/teachers-api.test.ts`, the CHECK tables. Stores:

```ts
      ['a PLN IBAN', { currency: 'PLN', holderName: 'H. Teacher', iban: 'PL61109010140000071219812874' }],
      ['an AED IBAN', { currency: 'AED', holderName: 'H. Teacher', iban: 'AE070331234567890123456' }],
      ['an AUD BSB and account number', { currency: 'AUD', holderName: 'H. Teacher', bankCode: '062000', accountNumber: '12345678' }],
      ['an INR IFSC and account number', { currency: 'INR', holderName: 'H. Teacher', bankCode: 'SBIN0001234', accountNumber: '123456789012' }],
      ['an NZD account number', { currency: 'NZD', holderName: 'H. Teacher', accountNumber: '123456789012345' }],
      ['an MXN CLABE', { currency: 'MXN', holderName: 'H. Teacher', accountNumber: '012345678901234567' }],
```

Refusals:

```ts
      ['an AUD account with no BSB', { currency: 'AUD', holderName: 'H. Teacher', accountNumber: '12345678' }],
      ['an AUD BSB of only spaces', { currency: 'AUD', holderName: 'H. Teacher', bankCode: '  ', accountNumber: '12345678' }],
      ['an AUD account with an IBAN', { currency: 'AUD', holderName: 'H. Teacher', bankCode: '062000', accountNumber: '12345678', iban: 'NL91ABNA0417164300' }],
      ['an AUD account with a BIC', { currency: 'AUD', holderName: 'H. Teacher', bankCode: '062000', accountNumber: '12345678', bic: 'CTBAAU2S' }],
      ['an NZD account with a bank code', { currency: 'NZD', holderName: 'H. Teacher', bankCode: '062000', accountNumber: '123456789012345' }],
      ['an MXN account with no CLABE', { currency: 'MXN', holderName: 'H. Teacher' }],
      ['a PLN account with a bank code', { currency: 'PLN', holderName: 'H. Teacher', iban: 'PL61109010140000071219812874', bankCode: '062000' }],
```

`src/components/settings/bank-account-form.test.tsx`:

```ts
  it.each([
    ['AUD', ['BSB', 'Account number', 'Account holder']],
    ['INR', ['IFSC', 'Account number', 'Account holder']],
    ['NZD', ['Account number', 'Account holder']],
    ['MXN', ['CLABE', 'Account holder']],
    ['PLN', ['IBAN', 'BIC (optional)', 'Account holder']],
  ] as const)('shows %s’s own fields', (currency, labels) => {
    renderForm(currency);
    expect(fieldLabels()).toEqual(labels);
  });
```

Before writing it, read the holder-name label the existing tests expect (`fieldLabels()` for `GBP`) and use that exact string in place of `'Account holder'` if it differs.

`src/components/student/payment-details.test.tsx`:

```ts
  it('shows an Australian account’s BSB and account number under their own labels', () => {
    renderScheme({ scheme: 'local', currency: 'AUD', bankCode: '062000', accountNumber: '12345678' });
    expect(screen.getByText('BSB')).toBeInTheDocument();
    expect(screen.getByText('062000')).toBeInTheDocument();
    expect(screen.getByText('Account number')).toBeInTheDocument();
  });

  it('shows a Mexican account as its CLABE alone', () => {
    renderScheme({ scheme: 'local', currency: 'MXN', bankCode: null, accountNumber: '012345678901234567' });
    expect(screen.getByText('CLABE')).toBeInTheDocument();
    expect(screen.queryByText('Account number')).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/format.test.ts src/lib/bank-details.test.ts src/lib/currency.test.ts`
Expected: FAIL — type errors (`'AUD'` is not a `Currency`).

- [ ] **Step 3: Migrations**

Add the thirteen members to `enum Currency` in `prisma/schema.prisma`, in Global Constraints' order after `DKK`. Run `pnpm exec prisma migrate dev --name add_currencies`; check the generated SQL is only `ALTER TYPE "Currency" ADD VALUE …` lines.

Then `pnpm exec prisma migrate dev --create-only --name local_bank_scheme` and write:

```sql
-- Each currency sets exactly its scheme's columns, the required ones
-- non-blank, the others NULL. A currency this CHECK does not name is refused.
ALTER TABLE "TeacherBankAccount" DROP CONSTRAINT "TeacherBankAccount_scheme_check";
ALTER TABLE "TeacherBankAccount" ADD CONSTRAINT "TeacherBankAccount_scheme_check" CHECK (
  btrim("holderName") <> ''
  AND ("bic" IS NULL OR btrim("bic") <> '')
  AND CASE
    WHEN "currency" IN ('EUR', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'ILS', 'AED') THEN
      "iban" IS NOT NULL AND btrim("iban") <> ''
      AND "sortCode" IS NULL AND "accountNumber" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    WHEN "currency" = 'GBP' THEN
      "sortCode" IS NOT NULL AND btrim("sortCode") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    WHEN "currency" = 'USD' THEN
      "routingNumber" IS NOT NULL AND btrim("routingNumber") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL AND "bankCode" IS NULL
    WHEN "currency" IN ('AUD', 'CAD', 'INR', 'SGD', 'HKD', 'ZAR', 'BRL') THEN
      "bankCode" IS NOT NULL AND btrim("bankCode") <> ''
      AND "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL AND "routingNumber" IS NULL
    WHEN "currency" IN ('NZD', 'MXN') THEN
      "accountNumber" IS NOT NULL AND btrim("accountNumber") <> ''
      AND "iban" IS NULL AND "bic" IS NULL AND "sortCode" IS NULL AND "routingNumber" IS NULL AND "bankCode" IS NULL
    ELSE false
  END
);
```

Apply with `pnpm exec prisma migrate dev`. If it fails with `unsafe use of new value`, Prisma ran both migrations in one transaction: stop and report; do not merge or reorder the migrations.

- [ ] **Step 4: `CURRENCY_INFO` and `CURRENCIES`**

Append to `CURRENCY_INFO` in `src/lib/currency.ts`:

```ts
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
```

`src/lib/format.ts:242`:

```ts
export const CURRENCIES = [
  'EUR', 'GBP', 'USD', 'CHF', 'SEK', 'NOK', 'DKK',
  'INR', 'SGD', 'AUD', 'CAD', 'NZD', 'HKD', 'BRL', 'MXN', 'ZAR', 'PLN', 'CZK', 'ILS', 'AED',
] as const satisfies readonly Currency[];
```

- [ ] **Step 5: The `local` scheme in `src/lib/bank-details.ts`**

Union member: `| { scheme: 'local'; currency: Currency; bankCode: string | null; accountNumber: string }`.

```ts
const LOCAL_PART = /^[A-Za-z0-9 -]+$/;

function parseLocal(currency: Currency, input: BankDetailsInput): ParseResult {
  const takesCode = CURRENCY_INFO[currency].bankCodeLabel !== null;
  const foreign = firstForeignField(input, takesCode ? ['bankCode', 'accountNumber'] : ['accountNumber']);
  if (foreign) return fail({ error: 'field_not_in_scheme', field: foreign });

  let bankCode: string | null = null;
  if (takesCode) {
    const raw = present(input.bankCode);
    if (raw === null || raw.length > 20 || !LOCAL_PART.test(raw)) return fail({ error: 'bank_code_invalid', field: 'bankCode' });
    bankCode = raw.toUpperCase();
  }
  const accountNumber = present(input.accountNumber) ?? '';
  if (accountNumber.length < 4 || accountNumber.length > 34 || !LOCAL_PART.test(accountNumber)) {
    return fail({ error: 'account_number_invalid', field: 'accountNumber' });
  }
  return { ok: true, details: { scheme: 'local', currency, bankCode, accountNumber } };
}
```

`parseBankDetails`: `case 'local': return parseLocal(currency, input);`.
`bankDetailsFromRow`:

```ts
    case 'local': {
      const takesCode = CURRENCY_INFO[row.currency].bankCodeLabel !== null;
      if (!only(takesCode ? ['bankCode', 'accountNumber'] : ['accountNumber']) || !has(row.accountNumber)) return null;
      if (takesCode && !has(row.bankCode)) return null;
      return { scheme, currency: row.currency, bankCode: takesCode ? row.bankCode : null, accountNumber: row.accountNumber };
    }
```

Note `takesCode ? row.bankCode : null` — TypeScript narrows `row.bankCode` to `string` only through `has`; write it as `bankCode: takesCode && has(row.bankCode) ? row.bankCode : null` if the narrowing does not carry.

- [ ] **Step 6: Consumers**

`src/services/bank-accounts.ts`, `columnsFor`:

```ts
    case 'local':
      return { iban: null, bic: null, sortCode: null, accountNumber: details.accountNumber, routingNumber: null, bankCode: details.bankCode };
```

`src/components/settings/bank-account-form.tsx`: `SCHEME_FIELDS` stays for the fixed schemes; add `local: []` to satisfy its `Record`, and compute the shown fields per currency:

```ts
/** The fields `currency`'s account takes, in the order the block shows them. */
function fieldsFor(currency: Currency): readonly { key: Exclude<BankAccountField, 'holderName'>; label: string }[] {
  const scheme = SCHEME_FOR_CURRENCY[currency];
  if (scheme !== 'local') return SCHEME_FIELDS[scheme];
  const { bankCodeLabel, accountLabel } = CURRENCY_INFO[currency];
  return [
    ...(bankCodeLabel === null ? [] : [{ key: 'bankCode' as const, label: bankCodeLabel }]),
    { key: 'accountNumber' as const, label: accountLabel },
  ];
}
```

and replace `const fields = SCHEME_FIELDS[SCHEME_FOR_CURRENCY[currency]];` with `const fields = fieldsFor(currency);`.

`src/components/student/payment-details.tsx`, before `default`:

```ts
    case 'local': {
      const { bankCodeLabel, accountLabel } = CURRENCY_INFO[details.currency];
      return [
        ...(bankCodeLabel === null || details.bankCode === null
          ? []
          : [{ key: 'bank code', label: bankCodeLabel, shown: details.bankCode, copied: details.bankCode }]),
        { key: 'account number', label: accountLabel, shown: details.accountNumber, copied: details.accountNumber },
      ];
    }
```

`resume-payments/page.tsx`: read how `DETAIL_LABELS` is used. If it lists a row's non-null columns, keep `bankCode: 'Bank code'` (it labels a column, not a currency's field). Leave as Task 2 set it unless the page renders per-currency.

Amend the spec: the `local` type line becomes `{ scheme: 'local'; currency: Currency; bankCode: string | null; accountNumber: string }`, and "Two migrations" becomes three, `bank_code_column` landing first (Task 2).

- [ ] **Step 7: Run the tests**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. The existing `profile-form` test "offers every Currency, in declaration order" still passes here (the picker changes in Task 4).

- [ ] **Step 8: Commit**

```bash
git add prisma src tests docs/superpowers/specs/2026-10-15-more-currencies-design.md
git commit -m "feat: thirteen more currencies, and a local bank scheme for the ones without IBAN"
```

---

### Task 4: The picker suggests from the time zone

**Files:**
- Modify: `src/components/settings/profile-form.tsx:69-84, 290-300`
- Test: `src/components/settings/profile-form.test.tsx`

**Interfaces:**
- Consumes: `CURRENCY_INFO`, `suggestedCurrency` (Task 1), `currencyLabel` (`format.ts`).
- Produces: nothing used later.

- [ ] **Step 1: Write the failing tests** — replace `'offers every Currency, in declaration order'` with:

```ts
  function currencyGroups(): { label: string; values: string[] }[] {
    const select = screen.getByLabelText('Currency') as HTMLSelectElement;
    return [...select.querySelectorAll('optgroup')].map((g) => ({
      label: g.label,
      values: [...g.querySelectorAll('option')].map((o) => o.value),
    }));
  }

  it('lists every Currency once under All currencies, by name', () => {
    renderForm();
    const all = currencyGroups().find((g) => g.label === 'All currencies');
    expect(all?.values.slice().sort()).toEqual(Object.values(Currency).slice().sort());
    const names = [...(screen.getByLabelText('Currency') as HTMLSelectElement).querySelectorAll('optgroup[label="All currencies"] option')]
      .map((o) => o.textContent ?? '');
    expect(names).toEqual(names.slice().sort());
  });

  it('labels each currency by name and prefix', () => {
    renderForm();
    expect(screen.getByRole('option', { name: 'Australian dollar (A$)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Swiss franc (CHF)' })).toBeInTheDocument();
  });

  it('suggests the currency of the teacher’s time zone when it is not already theirs', () => {
    renderForm({ defaultTimezone: 'Australia/Sydney', currency: 'EUR' });
    expect(currencyGroups()[0]).toEqual({ label: 'Suggested', values: ['AUD'] });
  });

  it('suggests nothing when the time zone’s currency is already theirs', () => {
    renderForm({ defaultTimezone: 'Australia/Sydney', currency: 'AUD' });
    expect(currencyGroups().map((g) => g.label)).toEqual(['All currencies']);
  });

  it('suggests nothing for a zone no currency claims', () => {
    renderForm({ defaultTimezone: 'Etc/UTC' });
    expect(currencyGroups().map((g) => g.label)).toEqual(['All currencies']);
  });

  it('follows the time zone the teacher picks before saving', () => {
    renderForm({ defaultTimezone: 'Europe/Amsterdam', currency: 'EUR' });
    fireEvent.change(timezoneSelect(), { target: { value: 'Asia/Kolkata' } });
    expect(currencyGroups()[0]).toEqual({ label: 'Suggested', values: ['INR'] });
  });
```

If `Asia/Kolkata` is not among the offered `timeZoneOptions` for `NOW`, pick a zone the select does offer from `timezone-options` (check with `timeZoneOptions('Europe/Amsterdam', NOW)`).

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx`
Expected: FAIL — no `optgroup` under Currency.

- [ ] **Step 3: Implement** — in `profile-form.tsx` replace `CURRENCY_OPTION_LABELS`, `CURRENCY_OPTIONS` and `isCurrency` with:

```ts
/** Every currency as the picker lists it, `Name (prefix)`, sorted by name. */
const CURRENCY_OPTIONS = (Object.keys(CURRENCY_INFO) as Currency[])
  .map((currency) => [currency, `${CURRENCY_INFO[currency].name} (${currencyLabel(currency)})`] as const)
  .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));

function isCurrency(value: string): value is Currency {
  return Object.hasOwn(CURRENCY_INFO, value);
}
```

(A code-point comparison, not `localeCompare`, so server and browser sort alike.) Drop the now-unused `CURRENCIES` import if nothing else in the file uses it.

The select body:

```tsx
          {suggestion !== null && (
            <optgroup label="Suggested">
              <option value={suggestion}>{suggestionLabel}</option>
            </optgroup>
          )}
          <optgroup label="All currencies">
            {CURRENCY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </optgroup>
```

with, in the component body:

```ts
  const suggested = suggestedCurrency(form.defaultTimezone);
  const suggestion = suggested !== null && suggested !== form.currency ? suggested : null;
  const suggestionLabel = CURRENCY_OPTIONS.find(([c]) => c === suggestion)?.[1] ?? '';
```

The Suggested option duplicates a value in All currencies; a `<select>` with `value={form.currency}` selects the first match, which is the teacher's own currency and never the suggestion (the suggestion is hidden when equal), so the duplicate cannot be the selected one.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx
git commit -m "feat: the currency picker lists by name and suggests from the teacher's time zone"
```

---

### Task 5: Docs, and the whole suite

**Files:**
- Modify: `docs/data-model.md` (TeacherBankAccount table and paragraph)
- Modify: `CLAUDE.md` (Data Model, Currency bullet)

- [ ] **Step 1: `docs/data-model.md`**

In the TeacherBankAccount table, after `routing_number`, add:

```markdown
| bank_code | string, nullable | The `local` scheme's bank, branch or routing code (a BSB, IFSC, institution & transit, …), required for the currencies whose `CURRENCY_INFO` entry names a `bankCodeLabel` and null everywhere else. Stored trimmed and uppercased; no checksum. |
```

In the paragraph after it, extend the parse sentence: `parseBankDetails` validates "… ABA routing checksum; for the `local` scheme only character set and length)". Update the `account_number` row to say it is also the `local` scheme's account number or CLABE.

- [ ] **Step 2: `CLAUDE.md`**

In Data Model, the Currency bullet ends "…and bank methods exist only for EUR payments". Change that clause to "and the EPC QR exists only for EUR payments".

- [ ] **Step 3: The whole suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS. Then `pnpm exec prisma migrate status` → "Database schema is up to date".

- [ ] **Step 4: Commit**

```bash
git add docs/data-model.md CLAUDE.md
git commit -m "docs: the local bank scheme's column, and the EPC QR as the one euro-only method"
```
