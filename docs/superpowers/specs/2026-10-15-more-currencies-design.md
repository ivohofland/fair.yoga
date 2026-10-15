# More currencies: thirteen more, one generic bank scheme, a suggested picker

## Problem, as measured

The `Currency` enum (`prisma/schema.prisma`) holds the seven currencies the
multi-currency work (#758, `2026-10-06-multi-currency-design.md`) shipped:
EUR, GBP, USD, CHF, SEK, NOK, DKK. Teachers outside Europe and the US cannot
price in their own currency. Measured on `main` at `a93e4478`:

- Every per-currency table is tethered to the enum by `satisfies
  Record<Currency, …>`: `CURRENCY_PREFIX` and `CURRENCIES` (`src/lib/format.ts`),
  `SCHEME_FOR_CURRENCY` (`src/lib/bank-details.ts`), `CURRENCY_OPTION_LABELS`
  (`src/components/settings/profile-form.tsx`). Adding an enum member fails the
  build at each until it is filled.
- `TeacherBankAccount_scheme_check`
  (`20261007120000_teacher_bank_accounts/migration.sql`) names each currency's
  columns and refuses a currency it does not name (`ELSE false`).
- Bank transfer is offered for every scheme; only the EPC QR is euro-only
  (`EPC_QR_CURRENCY`, `src/lib/payment-methods.ts`).
- Amounts are whole cents throughout (`formatMoneyCents`, the pricing engine),
  so only two-decimal currencies fit without further work.

## Decisions (agreed in brainstorming, 2026-10-15)

1. **Thirteen new currencies, 20 in all.** INR, SGD, AUD, CAD, NZD, HKD, BRL,
   MXN, ZAR, PLN, CZK, ILS, AED. All are two-decimal per ISO 4217.
2. **Out of scope:** zero-decimal currencies (JPY, KRW, ISK) and HUF, which ISO
   lists with two decimals but is paid in whole forints. They wait for
   whole-unit support in pricing and formatting.
3. **Extend the enum** (not a `String` + ISO list): the compiler tethers above
   stay the checklist.
4. **One `CURRENCY_INFO` record** holds every per-currency fact; the existing
   tables derive from it.
5. **IBAN countries reuse the `iban` scheme**: PLN, CZK, ILS, AED.
6. **Everything else gets one generic `local` scheme**: an optional bank code
   plus an account number, loosely validated. Per-country checksums can follow
   for a currency that needs them.
7. **The picker suggests from the teacher's time zone**, not the browser
   locale: it is already stored, means more, and renders the same on server
   and client.

## 1. Enum and `CURRENCY_INFO`

`Currency` gains the thirteen members, appended after `DKK` in decision 1's
order. `CURRENCIES` keeps enum declaration order (held by
`money-totals.test.ts`).

A new `src/lib/currency.ts`:

```ts
export const CURRENCY_INFO = {
  EUR: { prefix: '€', name: 'Euro', scheme: 'sepa', bankCodeLabel: null, timeZones: [...] },
  AUD: { prefix: 'A$', name: 'Australian dollar', scheme: 'local', bankCodeLabel: 'BSB', timeZones: ['Australia/'] },
  ...
} as const satisfies Record<Currency, CurrencyInfo>;
```

`CURRENCY_PREFIX`, `SCHEME_FOR_CURRENCY` and the picker's option labels derive
from it; their exported names and shapes stay, so call sites do not change.
All strings are hand-written, never `Intl`, for the reason `CURRENCY_INFO`'s
docblock gives (ICU output differs between server and browser).

Prefixes for the new members:

| Currency | Prefix | Currency | Prefix |
|---|---|---|---|
| INR | `₹` | BRL | `R$` |
| SGD | `S$` | MXN | `MX$` |
| AUD | `A$` | ZAR | `ZAR ` |
| CAD | `C$` | PLN | `PLN ` |
| NZD | `NZ$` | CZK | `CZK ` |
| HKD | `HK$` | ILS | `ILS ` |
| | | AED | `AED ` |

Formatting rules from #758 are unchanged: two decimals, U+2212 for negatives,
no thousands separator.

`MONEY_MAX` (100,000, #769) holds for every new currency: in the weakest, INR,
it is still about €1,000 for one class's room cost or rate. The currency pin in
`schemas.test.ts` lists the twenty.

## 2. Bank details: the `local` scheme

```ts
| { scheme: 'local'; currency: Currency; bankCode: string | null; accountNumber: string }
```

`TeacherBankAccount` gains one nullable column, `bankCode`; `accountNumber` is
reused. `CURRENCY_INFO[c].bankCodeLabel` decides whether the currency takes a
bank code and what the form and the student's payment page call it:

| Currency | `bankCodeLabel` | Account field label |
|---|---|---|
| AUD | `BSB` | Account number |
| CAD | `Institution & transit` | Account number |
| INR | `IFSC` | Account number |
| SGD, HKD | `Bank code` | Account number |
| ZAR | `Branch code` | Account number |
| BRL | `Bank & agency` | Account number |
| NZD | `null` | Account number |
| MXN | `null` | CLABE |

The account-field label is a second `CURRENCY_INFO` entry (`accountLabel`).

**Validation (`parseBankDetails`).** Allowed characters letters, digits,
spaces and dashes; spaces and dashes are stripped before storing, so a copied
value pastes whole; each value holds at least one digit; `bankCode` 1–20
characters once stripped, uppercased, and required exactly when
`bankCodeLabel` is non-null; `accountNumber` 4–34 characters once stripped,
case kept. A refusal names the field by its label ("Enter a valid IFSC.",
"Enter a valid CLABE."). A
`bankCode` sent for NZD or MXN, or any `iban`/`bic`/`sortCode`/
`routingNumber`, is `field_not_in_scheme`. New errors:
`bank_code_invalid` (field `bankCode`); `account_number_invalid` is reused.
No checksums.

**Row parser (`bankDetailsFromRow`)** follows its existing rule: required
columns present and non-blank, the rest null, no format checks.

**CHECK.** `TeacherBankAccount_scheme_check` is replaced. The IBAN branch adds
PLN, CZK, ILS, AED; GBP and USD add `"bankCode" IS NULL`; two new branches:
- AUD, CAD, INR, SGD, HKD, ZAR, BRL: `bankCode` and `accountNumber` non-blank,
  `iban`, `bic`, `sortCode`, `routingNumber` null.
- NZD, MXN: `accountNumber` non-blank, every other scheme column null.
`ELSE false` stays.

**Three migrations.** `bank_code_column` lands first: it adds the column and
replaces the CHECK so the existing schemes hold `bankCode` null. Postgres
refuses to use an enum value in the transaction that added it, so
`add_currencies` adds the values and `local_bank_scheme` replaces the CHECK
again with the new currencies' branches. Prisma applies each migration in its
own transaction; applying `local_bank_scheme` after `add_currencies` succeeded.

**Consumers.** `BankAccountData`, `bankAccountDataSelect` and
`BankDetailsInput` gain `bankCode` (the `_bankAccountDataIsEveryDetailColumn`
tether enforces it). `bank-account-form.tsx` renders the code field when the
currency has a label. `payment-details.tsx` and the resume-payments screen show the code and
account under their labels. `maskedIdentifier` already falls back to `accountNumber`. The
GDPR export reads `bankAccountDataSelect`, so it carries `bankCode` without
further change; its test's expected rows gain `bankCode: null`.

**Proxy-key payments.** Brazil (PIX) and Singapore (PayNow) mostly pay by
proxy key; the teacher's existing `paymentLink` is shown beside the bank
method, as it is today. No new field.

## 3. Picker

The profile's currency `<select>` stays native and gets two `<optgroup>`s,
like the time-zone select beside it:

```
Suggested
  Australian dollar (A$)
─────────
All currencies
  Australian dollar (A$)
  Brazilian real (R$)
  …  (sorted by name)
```

Option label: `name (prefix)`, prefix trimmed.
`suggestedCurrency(timeZone: string): Currency | null` (`src/lib/currency.ts`)
returns the currency whose `timeZones` entry matches the zone, an entry ending
in `/` matching as a prefix. The "Suggested" group is left out when it returns
`null` or the teacher's current currency. The suggestion never changes the
saved value.

`timeZones` entries per currency are a hint, not a census: they cover each
country's main zones (`Australia/`, `Pacific/Auckland`, `Asia/Kolkata`,
`Asia/Singapore`, `Asia/Hong_Kong`, the Canadian `America/` zones, the
Brazilian and Mexican ones, `Africa/Johannesburg`, `Europe/Warsaw`,
`Europe/Prague`, `Asia/Jerusalem`, `Asia/Dubai`, and the existing seven's).
A zone two currencies could claim (none among these) would return the first in
`CURRENCY_INFO` key order.

## Testing

Written first, each failing before its implementation:

- `format.test.ts`: `formatMoneyCents` for each new prefix (`A$12.50`,
  `₹12.50`, `PLN 12.50`, `−A$12.50`); `currencyLabel` for a symbol and a code
  prefix.
- `bank-details.test.ts`: `SCHEME_FOR_CURRENCY`'s new expectation; `local`
  parsing accepts BSB + account, refuses a missing BSB for AUD, refuses
  `bankCode` for NZD and MXN, refuses a foreign `iban`, refuses a bad
  character; `bankDetailsFromRow` for both `local` shapes and a malformed row.
- `currency.test.ts`: `suggestedCurrency` for a prefix match, an exact match,
  an unknown zone (`null`).
- Integration, bank-accounts route: an AUD account round-trips through PUT/GET;
  the CHECK refuses a raw insert of an AUD row without `bankCode` and an NZD
  row with one.
- Student payment page: an AUD payment shows "BSB" and the account number.
- `profile-form` test: the Suggested group appears for `Australia/Sydney` on
  a EUR teacher and not on an AUD one.
- `gdpr.test.ts`: expected rows carry `bankCode`.

## Docs

`docs/data-model.md` (TeacherBankAccount): the `bank_code` row and the `local`
scheme. CLAUDE.md's Data Model line on bank methods says they exist only for
EUR payments; correct it to "the EPC QR exists only for EUR payments".

## Out of scope

- Zero-decimal currencies and HUF (decision 2).
- Per-country checksum validation for the `local` scheme.
- Locale-dependent number formatting (thousands separators, comma decimals).
- Level 2 processor support for the new currencies.
