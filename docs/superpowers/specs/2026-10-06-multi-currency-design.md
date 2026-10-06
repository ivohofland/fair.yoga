# Multi-currency: amounts carry a currency, bank details per currency (#758)

## Problem, as measured

Issue #758 says the profile's currency picker changes nothing and student bank
payment assumes euro + EEA. Both hold. Measured on `origin/main` at `2fc540ac`:

- `Teacher.defaultCurrency String @default("EUR")` is read only by the profile
  settings page (to fill the form) and the GDPR export.
  `grep -rn "defaultCurrency" src | grep -v test` → schema validation, the form,
  the settings page, the signup route (writes `'EUR'`), `gdpr.ts`.
- Every amount shows a hard-coded euro sign. `grep -rl "€" src | grep -v test`
  lists 16 files. `formatCents`/`formatEuro` (`src/lib/format.ts`) emit `€` and
  have 42 call sites (`grep -rn "formatCents\|formatEuro" src | grep -v "\.test\." | wc -l`).
- `PaymentQr` encodes `EUR${amount}`; `paymentMethodsFor`
  (`src/lib/payment-methods.ts`) knows only an IBAN; there is no BIC field.

Two things the issue does not say, also measured:

- `updateTeacherSchema.defaultCurrency` is `z.string().optional()`
  (`src/lib/schemas.ts`), so the API stores any string, `"XYZ"` included.
- `bankIban` is not format-checked at all (`blankAsNull`), so "EEA-only" has
  nothing to attach to today.

The full surface census (render sites, sums, copies, bank consumers) was taken
for this spec and its counts are recorded in the PR bodies, not here.

## Decisions (agreed in brainstorming, 2026-10-06)

1. **Snapshot per record.** A teacher may switch currency at any time; amounts
   already frozen keep the currency they were written in.
2. **A switch relabels what is still editable.** Rows whose economics the
   teacher could still edit by hand move to the new currency with their numbers
   unchanged; frozen rows keep theirs.
3. **One bank account per currency.** A payment shows the methods for the
   account in *its own* currency.
4. **Two PRs from this one spec.** PR A: currency. PR B: bank accounts. #758
   closes on PR B.

## Part A — currency

### A1. Where currency lives

Rule: a row carries its own currency **only if it can be frozen while the
teacher's currency moves**. A row that is always editable would always be
relabelled by the switch, so a column on it could only ever repeat
`Teacher.currency`.

| Row | Own `currency` | Frozen when |
|---|---|---|
| `Class` | yes | `settingsLocked` (first registration) or terminal (`completed`, or entry `cancelledAt` set) |
| `StudioClass` | yes | entry date strictly before the teacher's today (`studioClassDateIsPast`, the #276 income-record rule) |
| `Registration.price`, `Payment.amount` | no — read through their `Class` | both are written by `completeClass`, after the class is already frozen |
| `TeacherRoom`, `ClassTemplate`, `StudioClassTemplate` | no — read `Teacher.currency` | never frozen |

- New Prisma enum `Currency { EUR GBP USD CHF SEK NOK DKK }`.
- `Teacher.defaultCurrency String` → `Teacher.currency Currency @default(EUR)`.
  The rename is deliberate: the field is no longer a default for anything, it
  is the teacher's live currency. Migration maps existing strings; any value
  outside the enum becomes `EUR` (nothing is in production; the seed's
  `GBP`/`USD` teachers map directly).
- `Class.currency Currency` and `StudioClass.currency Currency`, both NOT NULL,
  backfilled from their teacher in the migration.
- Every writer of a new `Class`/`StudioClass` stamps the teacher's currency:
  the two generators (`class-generator.ts`, `studio-class-generator.ts`) and
  the one-off create routes (`api/classes`, `api/studio-classes`).
- `updateTeacherSchema` takes `z.enum(Currency)`.

### A2. The switch

`PUT /api/teachers/[id]` with a `currency` different from the stored one runs
one transaction:

1. `Teacher` row `FOR UPDATE`.
2. Candidate `Class` ids: this teacher's, `settingsLocked = false`, not
   terminal. Lock them with `lockClassRowsOrdered`, then **re-filter under the
   lock** — a first registration may have flipped `settingsLocked` between the
   candidate read and the lock (`api/registrations` holds `lockClassRow` when it
   flips it).
3. `UPDATE "Class" SET currency` on the re-filtered set.
4. `StudioClass` rows of this teacher dated today-or-later in the teacher's
   timezone: `UPDATE ... SET currency`.
5. `UPDATE Teacher SET currency`.

The response carries `{ relabelled: { classes, studioClasses }, kept: { classes, studioClasses } }`
so the form can say "12 upcoming classes now show £; 3 booked classes keep €".
Same currency as stored → `respondUnchanged` (CLAUDE.md: already-done answers 200).

**The create race.** A class created while the switch runs could read the old
currency and commit after the switch, leaving an unlocked future row in the old
currency. Every `Class`/`StudioClass` creator takes `Teacher` `FOR SHARE` before
reading the currency, which the switch's `FOR UPDATE` excludes. Where `Teacher`
sits in the lock order (it must precede `Class`) is fixed in
`docs/lock-order.md` as part of the plan, with the census of creators that take
it; the photo-upload gate (`Teacher` before `TeacherPhoto`, #46) is the existing
precedent.

**Database guard.** A trigger `class_currency_frozen_guard` refuses a change to
`Class.currency` when the row is `settingsLocked` or terminal, and
`studio_class_currency_frozen_guard` refuses one on a `StudioClass` whose entry
date is in the past. Like `entry_frozen_schedule_guard`, it reads only the row
being written (plus, for the studio guard, its own entry) — never another
table's status — so it adds no lock edge. The guard exists because the switch
is a bulk `UPDATE`: any future script or route that relabels by `teacherId`
would otherwise silently rewrite a booked class.

`StudioClass` "past" needs the teacher's timezone, which a trigger cannot read
cheaply; the studio guard therefore compares against the entry date with a
one-day margin (`date < CURRENT_DATE - 1`) and the service applies the exact
rule. The margin can only let an edge row through to the service check, never
refuse a legitimate relabel.

### A3. Formatting

`formatMoney(amount: number | Prisma.Decimal, currency: Currency): string` in
`src/lib/format.ts` replaces `formatCents` and `formatEuro`, keeping their
rules: U+2212 for negatives, never `−€0.00` or `€-0.00`, two decimals, **no
thousands separator** — EUR output is byte-identical to today's and the
existing format tests keep pinning it.

The symbol comes from a hand-written table, not `Intl.NumberFormat`:

```ts
export const CURRENCY_PREFIX = {
  EUR: '€', GBP: '£', USD: '$', CHF: 'CHF ', SEK: 'SEK ', NOK: 'NOK ', DKK: 'DKK ',
} as const satisfies Record<Currency, string>;
```

- `Intl` output depends on the ICU build; server and browser can disagree, and a
  `'use client'` component's server render is what hydration keeps.
- `kr` (`narrowSymbol`) would be ambiguous across three currencies; the code
  prefix agrees with `Intl`'s `en` + `symbol` output for those four.
- The `satisfies` makes a new enum member a compile error until it has a
  prefix.

Input labels ("Room cost (€)") read the symbol from the same table via a
`currencyLabel(currency)` helper.

### A4. Threading

Every render site has its source row in hand and passes its currency:
`cls.currency`, `studioClass.currency`, the payment's `registration.class.currency`,
or `teacher.currency` for rooms, templates and the new-class/new-template
forms. Components that today take a bare amount (`amount: number`,
`tierPrices`, the pricing-preview numbers) get a **required**
`currency: Currency` prop, so a missed caller fails to compile.

Notification bodies (`payment-request-copy.ts`, the completion notice) are
rendered when the notification is created; they take the class's currency then,
which is correct because a frozen class's currency never moves.

### A5. Sums

No amount is ever added to an amount in another currency. The four cross-row
sums — reporting (`/settings/reporting`, including the per-month rollup), the
payments-overview totals, the student-detail outstanding total, and
`owedPhrase` (`student-archive-copy.ts`) — group by currency. A teacher with one
currency sees today's layout unchanged; a second currency adds one line per
currency where a single total stood, ordered by the teacher's current currency
first, then by `Currency` declaration order.

`owedPhrase` with two currencies reads "€40.00 and £12.00 across 3 payments".

### A6. Bank methods during Part A

Until Part B lands, bank methods exist only for EUR: a payment whose class
currency is not `EUR` gets no methods (`paymentMethodsFor` takes the currency
and returns `[]` otherwise). This is what stops a GBP payment from producing a
euro EPC QR in the interval between the two PRs.

### A7. GDPR export

Each exported amount gains a `currency` beside it: the teacher export's classes
and studio classes from their own column, rooms and templates from the teacher's;
the student export's payments and prices from the class.

## Part B — bank accounts

### B1. Table

```prisma
model TeacherBankAccount {
  id            String   @id @default(uuid())
  teacherId     String
  currency      Currency
  holderName    String
  iban          String?
  bic           String?
  sortCode      String?
  accountNumber String?
  routingNumber String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  teacher       Teacher  @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  @@unique([teacherId, currency])
}
```

A hand-authored CHECK pins the column set per currency (pattern:
`20260721061528_student_claim_link_check`):

| Currency | Scheme | Required | Must be null | Student methods |
|---|---|---|---|---|
| EUR | SEPA | `iban`; `bic` when the IBAN country is outside the EEA (service rule) | `sortCode`, `accountNumber`, `routingNumber` | transfer + EPC QR |
| GBP | UK | `sortCode` (6 digits), `accountNumber` (8 digits) | `iban`, `bic`, `routingNumber` | transfer |
| USD | US | `routingNumber` (9 digits), `accountNumber` (4–17 digits) | `iban`, `bic`, `sortCode` | transfer |
| CHF, SEK, NOK, DKK | IBAN | `iban`; `bic` optional | `sortCode`, `accountNumber`, `routingNumber` | transfer |

`holderName` is non-blank in every row (it replaces the
`teacher_bank_holder_name_check` pairing — Verification of Payee needs it for
every scheme).

The EEA-country rule for the BIC is a service rule, not a CHECK: the EEA list is
policy that changes, and a constraint naming it would need a migration per
change.

### B2. Validation (`src/lib/bank-details.ts`)

- IBAN: strip spaces, uppercase, per-country length table, ISO 7064 mod-97 = 1.
- BIC: 8 or 11 characters, `^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$`.
- EUR + IBAN country not in `EEA_COUNTRIES` + no BIC → refused with a
  registered code (`BIC_REQUIRED`, 400 — it is a validation failure, not a
  conflict).
- Sort code: six digits after stripping `-` and spaces.
- Routing number: nine digits passing the ABA checksum
  (`3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 mod 10`).

The TS side is a discriminated union `BankDetails` keyed by scheme;
`bankDetailsFromRow(row)` is the one parser from a row to the union and returns
`null` for a row the CHECK should have made impossible, logged.

### B3. Methods

```ts
export type PaymentMethod =
  | { kind: 'bank_transfer'; beneficiary: string; details: BankDetails }
  | { kind: 'epc_qr'; beneficiary: string; iban: string; bic: string | null };
```

`paymentMethodsFor(account: TeacherBankAccount | null)` returns transfer for
every scheme, plus `epc_qr` for EUR only. `PaymentQr` encodes version `002`
when `bic` is null and `001` with the BIC when present; the currency field
stays `EUR` because the type admits nothing else.

Every consumer looks the account up by the **payment's class currency**:
the pay page, the bookings page, `payment-reminders`, `payments.ts`,
`email-fallback`, and the completion notification in `class-lifecycle`.
No account in that currency → no methods; the pay page says to ask the teacher
how to pay (existing no-methods copy).

### B4. Settings

The bank block in the profile form edits the account for the teacher's
**current** currency, showing the fields for its scheme. Accounts in other
currencies that still exist are listed beneath it, each with a remove control,
so an old-currency payment stays payable until the teacher decides otherwise.
Onboarding's "bank details set" means an account exists in the current
currency.

### B5. Migration

`bankIban`/`bankAccountName` rows become `EUR` `TeacherBankAccount` rows (where
both are set), then the two columns and `teacher_bank_holder_name_check` are
dropped. The seed is updated (the GBP teacher's account becomes a UK sort-code
account). GDPR export includes the accounts; erasure deletes them.

## Testing

- Unit: `formatMoney` for every `Currency` member, negative and zero cases;
  IBAN/BIC/sort-code/routing validators, including one valid and one
  checksum-broken example per scheme; `paymentMethodsFor` per scheme; EPC payload
  version switch.
- Integration: the switch — relabels unlocked classes and future studio
  classes, keeps booked/terminal/past ones, returns the counts, answers
  unchanged on same currency; the registration race (hold the class row lock on
  a second connection, per the project's untestable-race pattern) proves a class
  booked mid-switch keeps its currency; the create race (hold `Teacher` on a
  second connection) proves a create waits and stamps the new currency; both
  triggers refuse a direct `UPDATE`; reporting groups by currency; pay page
  shows methods for the payment's currency and none when the account is
  missing; BIC required for a `CH` EUR IBAN.
- Every guard above gets a mutation step in the plan (break, record the exact
  failure, restore).

## Out of scope

- Swiss QR-bill, UK/US QR or payment-link schemes.
- Currencies beyond the seven, and any with other than two decimals.
- Level 2 processors — **#386 is unaffected**.
- Conversion between currencies; reporting never converts.
