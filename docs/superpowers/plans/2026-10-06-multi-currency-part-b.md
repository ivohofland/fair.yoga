# Multi-currency, Part B (bank accounts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher keeps one bank account per currency, in that currency's scheme, and a student paying a payment sees the methods for the account in that payment's currency.

**Architecture:** A pure validation module (`src/lib/bank-details.ts`) owns every scheme's rules and the `BankDetails` union. A new `TeacherBankAccount` table (one row per teacher and currency, a CHECK per currency) replaces `Teacher.bankIban`/`bankAccountName`. `paymentMethodsFor(account)` derives methods from one account; every consumer looks the account up by the payment's class currency. Accounts are written through their own endpoint, gated by `Teacher FOR SHARE` against erasure.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (unit / components / integration), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-multi-currency-design.md` — Part B (B1–B6). Part A is merged (PR #774).

## Global Constraints

- One `TeacherBankAccount` per `(teacherId, currency)`; `holderName` non-blank in every row.
- Scheme per currency (spec B1 table): EUR → IBAN, BIC required iff the IBAN country is outside the EEA; GBP → sort code (6 digits) + account number (8 digits); USD → routing number (9 digits, ABA checksum) + account number (4–17 digits); CHF/SEK/NOK/DKK → IBAN, BIC optional. Columns not in a currency's scheme are NULL (CHECK).
- `EEA_COUNTRIES`: EU-27 (AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE) plus IS LI NO — a `ReadonlySet` in `bank-details.ts`, the one place it is written.
- Methods: `bank_transfer` for every scheme; `epc_qr` only for EUR, currency typed `EPC_QR_CURRENCY = 'EUR'`; EPC payload version `002` without BIC, `001` with BIC.
- Account lookup is always by the **payment's class currency**, never the teacher's current currency (except onboarding and the settings form, which use the teacher's current currency).
- Account writes: first lock `lockTeacherForShare` (null → 404). Erasure deletes accounts after its `Teacher` lock.
- Refusals: `BIC_REQUIRED` registered at 400 in `src/lib/api-error-codes.ts`; other invalid details are the existing validation 400 shape. Tests assert codes, not messages. DELETE of an absent account → `respondUnchanged`.
- Migrations: hand-written directory; SQL from `pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`; applied with `pnpm exec prisma migrate deploy`. Any `INSERT … SELECT`/`UPDATE`/`DELETE` of data sits in a `DO $$ … GET DIAGNOSTICS … RAISE NOTICE` block. Comments describe only their own SQL. Never edit an applied migration.
- Comment Discipline (CLAUDE.md): no counts/rosters in comments; tether membership to the compiler (`satisfies Record<Currency, …>`, exhaustive `switch` with `never`).
- Every guard gets a mutation step: break it, record the exact failure, restore, re-run green.
- Not in production: the migration maps seed data only.

## Review Focus

1. **A teacher who switched EUR→GBP with an outstanding EUR payment** — the student's pay page shows the EUR (IBAN/QR) account, never the GBP sort code. Pinned in Task 2.
2. **A non-EEA euro IBAN (`CH…`, `GB…`) saved without a BIC** — refused with `BIC_REQUIRED`; with a BIC, the QR is version `001` and carries it. Pinned in Tasks 1, 2, 3.
3. **A bank-account save racing the teacher's erasure** — no account survives on the erased teacher; the save answers 404. Pinned in Task 3.
4. **Pasted details with spaces, dashes, lowercase** (`nl91 abna 0417 1643 00`, `12-34-56`) — accepted and stored normalised. Pinned in Task 1.
5. **A teacher whose current currency has no account** — getting-started lists the bank step as not done; payments in that currency show the existing no-methods copy. Pinned in Tasks 2 and 3.

## Task order

1 → 2 → 3 → 4. Task 2 removes the `Teacher` bank columns and must switch every reader in the same task (the compiler finds them). Task 3 restores the ability to *enter* details (Task 2 removes the old form fields); no environment ships between them.

---

### Task 1: `bank-details.ts` — schemes, validation, the `BankDetails` union

**Files:**
- Create: `src/lib/bank-details.ts`, `src/lib/bank-details.test.ts`

**Interfaces:**
- Consumes: `Currency` (`@prisma/client`, type-only — this module is imported by client code).
- Produces:

```ts
export type BankDetails =
  | { scheme: 'sepa'; iban: string; bic: string | null }        // EUR
  | { scheme: 'iban'; iban: string; bic: string | null }        // CHF SEK NOK DKK
  | { scheme: 'uk'; sortCode: string; accountNumber: string }   // GBP
  | { scheme: 'us'; routingNumber: string; accountNumber: string }; // USD

export const SCHEME_FOR_CURRENCY = { EUR: 'sepa', GBP: 'uk', USD: 'us', CHF: 'iban', SEK: 'iban', NOK: 'iban', DKK: 'iban' }
  as const satisfies Record<Currency, BankDetails['scheme']>;

export const EEA_COUNTRIES: ReadonlySet<string>;

export type BankDetailsInput = { iban?: string | null; bic?: string | null; sortCode?: string | null; accountNumber?: string | null; routingNumber?: string | null };
export type BankDetailsError = 'iban_invalid' | 'bic_invalid' | 'bic_required' | 'sort_code_invalid' | 'account_number_invalid' | 'routing_number_invalid' | 'field_not_in_scheme';

/** Normalises and validates `input` against `currency`'s scheme. */
export function parseBankDetails(currency: Currency, input: BankDetailsInput):
  { ok: true; details: BankDetails } | { ok: false; error: BankDetailsError; field: keyof BankDetailsInput };

/** The one parser from a stored row to the union; null (caller logs) for a row the CHECK should have made impossible. */
export function bankDetailsFromRow(row: { currency: Currency } & Required<{ [K in keyof BankDetailsInput]: string | null }>): BankDetails | null;
```

Rules (spec B2): IBAN — strip spaces, uppercase, two-letter country with a known length (table from the SWIFT IBAN registry, `satisfies Record<string, number>`, the registry named in a one-line comment), ISO 7064 mod-97 = 1. BIC — strip spaces, uppercase, `^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$`. EUR with IBAN country ∉ `EEA_COUNTRIES` and no BIC → `bic_required`. Sort code — strip `-` and spaces, six digits. UK account number — eight digits. Routing — nine digits, `3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)`. US account number — 4–17 digits. A field outside the currency's scheme supplied non-blank → `field_not_in_scheme`. Blank strings count as absent.

- [ ] **Step 1: Failing tests** — valid: `NL91ABNA0417164300`, `DE89370400440532013000` (EUR, no BIC), `CH9300762011623852957` + `UBSWCHZH80A` (EUR → sepa with BIC; and as CHF → iban), `GB82WEST12345698765432` + `NWBKGB2L` (EUR, non-EEA), lowercase/spaced `nl91 abna 0417 1643 00` normalised to `NL91ABNA0417164300`; sort code `12-34-56` → `123456` with account `12345678`; routing `021000021`, `011000015` with account `1234567`. Invalid: `NL91ABNA0417164301` (checksum) → `iban_invalid`; `NL91ABNA041716430` (length) → `iban_invalid`; `CH9300762011623852957` as EUR without BIC → `bic_required`; `DEUTDEF` → `bic_invalid`; sort code `12345` → `sort_code_invalid`; routing `021000022` → `routing_number_invalid`; GBP with an `iban` → `field_not_in_scheme`. `bankDetailsFromRow` round-trips each scheme and returns null for a GBP row carrying an IBAN.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit src/lib/bank-details.test.ts` → fails (module missing).
- [ ] **Step 3: Implement.** Exhaustive `switch` on `SCHEME_FOR_CURRENCY[currency]` with a `never` default.
- [ ] **Step 4: Run** → pass; typecheck; lint.
- [ ] **Step 5: Mutations** (record each, restore): IBAN check `% 97 === 1` → `=== 0` (valid examples fail); drop `NO` from `EEA_COUNTRIES` (add a test: `NO9386011117947` EUR without BIC accepted — it fails); ABA weights `3,7,1` → `1,3,7` (`021000021` fails).
- [ ] **Step 6: Commit** — `feat: bank-details validation for every currency's scheme (#758)`.

---

### Task 2: `TeacherBankAccount`, migration, methods by the payment's currency

**Files:**
- Modify: `prisma/schema.prisma`; Create: `prisma/migrations/20261007120000_teacher_bank_accounts/migration.sql`; Modify: `prisma/seed.ts`
- Modify: `src/lib/payment-methods.ts` (+ test), `src/components/student/payment-qr.tsx` (+ test), `src/components/student/payment-details.tsx` (+ test)
- Modify every reader the compiler names once the columns are gone (census on `main`: `grep -rln "bankIban\|bankAccountName" src prisma/seed.ts` — pay page, bookings page, schedule overview, profile settings page, onboarding route + `src/lib/onboarding.ts`, teachers PUT route, profile form, schemas, class-lifecycle, email-fallback, gdpr, payment-reminders, payments), and their tests
- Test: `tests/integration/pay-page.test.ts`, `tests/integration/bank-accounts-migration.test.ts` (create) or a check in the migration task report (see Step 4)

**Interfaces:**
- Consumes: Task 1's `BankDetails`, `bankDetailsFromRow`, `SCHEME_FOR_CURRENCY`.
- Produces:
  - Prisma model `TeacherBankAccount` exactly as spec B1; `Teacher.bankAccounts TeacherBankAccount[]`.
  - `export const EPC_QR_CURRENCY = 'EUR' as const satisfies Currency;` (replaces `BANK_METHOD_CURRENCY`; `bankMethodsAvailable` deleted).
  - `export type PaymentMethod = { kind: 'bank_transfer'; beneficiary: string; details: BankDetails } | { kind: 'epc_qr'; beneficiary: string; iban: string; bic: string | null; currency: typeof EPC_QR_CURRENCY };`
  - `export function paymentMethodsFor(account: StoredBankAccount | null): PaymentMethod[]` where `StoredBankAccount` is the row shape `bankDetailsFromRow` takes plus `holderName`. Null or unparsable → `[]` (unparsable is logged by the caller-side parser's contract — log in `paymentMethodsFor` with `console.error`, as `paymentStateText` does, since the module is client-reachable).
  - Prisma select fragment `bankAccountSelect` (exported from `payment-methods.ts` as a plain object typed `satisfies Prisma.TeacherBankAccountSelect` via a type-only import) so every consumer selects the same columns: `teacher: { select: { bankAccounts: { where: { currency: cls.currency }, select: bankAccountSelect } } }` — or read all and pick by currency where the query cannot filter on a sibling column.

- [ ] **Step 1: Failing tests.**
  - `payment-methods.test.ts`: GBP account → one `bank_transfer` with `{ scheme: 'uk', … }`, no QR; EUR account without BIC → transfer + `epc_qr` with `bic: null`; null → `[]`.
  - `payment-qr.test.tsx`: payload line 2 is `002` and BIC line empty without BIC; `001` and the BIC with one.
  - `payment-details.test.tsx`: renders IBAN (+ BIC when present) for sepa/iban; "Sort code" + "Account number" for uk; "Routing number" + "Account number" for us — each with its copy control as the IBAN row has today.
  - `pay-page.test.ts` (Review Focus 1): teacher now GBP with a GBP sort-code account AND a EUR account; a completed EUR class's payment shows the IBAN and QR, never the sort code; a completed GBP class's payment shows sort code + account number and no QR; a CHF class with no CHF account shows the existing no-methods copy.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Schema + migration.** Add the model and relation; drop `Teacher.bankIban`/`bankAccountName`. Migration: create table + unique index + FK; hand-written CHECK `TeacherBankAccount_scheme_check` (holderName non-blank; per-currency required/null columns per spec B1 table — BIC-required-outside-EEA stays a service rule); `DO $$` block copying `Teacher` rows with both fields non-blank into `EUR` accounts (`iban` uppercased with spaces removed, `holderName` trimmed) with `RAISE NOTICE` of the count; then drop `Teacher_bank_holder_name_check` and the two columns. Apply with `migrate deploy`; `prisma generate`.
- [ ] **Step 4: Verify the data move.** Before applying, note how many seed teachers have both fields; after, assert that many `EUR` accounts exist with equal IBAN/holder. Record both numbers and the query in the task report (no NOTICE output is printed by `migrate deploy`).
- [ ] **Step 5: Seed.** EUR teacher keeps its IBAN as an EUR account; the GBP teacher gets a UK sort-code account (`12-34-56` / `12345678`); the USD teacher gets a US account (`021000021` / `1234567`).
- [ ] **Step 6: Methods and consumers.** Implement the new `payment-methods.ts`, `PaymentQr` (v001/v002), `PaymentDetails` (per-scheme rows). Then follow the compiler through every reader: each payment-facing reader selects the teacher's account **in the class's currency** and calls `paymentMethodsFor(account)`; the profile settings page and form drop the bank block for now (Task 3 restores it through the new endpoint); `updateTeacherSchema` drops `bankIban`/`bankAccountName`; the teachers PUT route drops the holder-name pre-check and its CHECK catch (`BANK_HOLDER_NAME_REQUIRED_MESSAGE` goes if unused — grep); `teacher-profile.ts` drops anything bank-specific; `onboarding.ts` takes `bankAccountInCurrentCurrency: boolean` (or the account) instead of the two fields, `isApplicable('bank')` returns true for every teacher, done = an account exists in the teacher's current currency; GDPR export lists the teacher's accounts (currency, scheme fields, holder); erasure deletes them after its `Teacher` lock (`tx.teacherBankAccount.deleteMany({ where: { teacherId } })`).
- [ ] **Step 7: Sweep** — `grep -rn "bankIban\|bankAccountName\|BANK_METHOD_CURRENCY\|bankMethodsAvailable\|BANK_HOLDER_NAME_REQUIRED" src tests prisma/seed.ts docs --include='*.ts' --include='*.tsx' --include='*.md'` → every hit gets a verdict in the report (docs hits are Task 4's).
- [ ] **Step 8: Run** typecheck, lint, unit + components, the pay-page and bookings integration files, the onboarding and gdpr tests → pass.
- [ ] **Step 9: Mutations** (record, restore): in the pay page's account lookup, use the teacher's current currency instead of the class's → the EUR-payment-after-switch case fails; `PaymentQr` always `002` → the BIC case fails; erasure without the account `deleteMany` → a gdpr erasure test (add: erased teacher has zero accounts) fails.
- [ ] **Step 10: Commit** (may be several commits) — `feat: TeacherBankAccount per currency; methods come from the payment's currency (#758)`.

---

### Task 3: Account endpoint and the settings bank block

**Files:**
- Create: `src/app/api/teachers/[id]/bank-accounts/[currency]/route.ts` (+ unit/route tests), `src/services/bank-accounts.ts` (+ tests)
- Modify: `src/lib/api-error-codes.ts` (`BIC_REQUIRED: 400`), `src/components/settings/profile-form.tsx` or a new `src/components/settings/bank-account-form.tsx` (+ tests), `src/app/(teacher)/settings/profile/page.tsx`
- Modify: `docs/lock-order.md` ("The `Teacher` row is the first lock (#758)": add the two account sites; erasure's account delete)
- Test: `tests/integration/bank-accounts-api.test.ts` (create); a held-lock test beside `src/app/api/teachers/[id]/route-lock-order.test.ts`

**Interfaces:**
- Consumes: `parseBankDetails` (Task 1); `lockTeacherForShare` (`src/lib/db-locks.ts`); `TeacherBankAccount` (Task 2).
- Produces:

```ts
// src/services/bank-accounts.ts — framework-agnostic
export async function saveBankAccount(db: PrismaClient, teacherId: string, currency: Currency,
  input: BankDetailsInput & { holderName: string }):
  Promise<{ kind: 'saved'; account: TeacherBankAccount } | { kind: 'invalid'; error: BankDetailsError | 'holder_required'; field: string } | { kind: 'teacher_gone' }>;
export async function removeBankAccount(db: PrismaClient, teacherId: string, currency: Currency):
  Promise<{ kind: 'removed' } | { kind: 'absent' } | { kind: 'teacher_gone' }>;
```

Both open a transaction whose first lock is `lockTeacherForShare` (null → `teacher_gone`), then upsert/delete on `(teacherId, currency)`. Route: `requireTeacher`, 403 when `session.teacherId !== id`, `currency` path segment validated with `z.enum(Currency)` (404 for an unknown segment), body via a zod schema; `invalid` → 400 (`BIC_REQUIRED` code for `bic_required`, the existing validation-error shape with the field for the others); `teacher_gone` → 404, logged; `absent` → `respondUnchanged`; success → 200 with the account.

Settings: the bank block shows the teacher's **current** currency's scheme fields (labels: "IBAN", "BIC (needed for an IBAN outside the EEA)" for sepa; "BIC (optional)" for iban; "Sort code", "Account number" for uk; "Routing number", "Account number" for us) plus "Account holder name", saved with its own button to the PUT. Accounts in other currencies are listed beneath as rows (currency + masked identifier, e.g. last four characters) with a "Remove" control → DELETE. Errors show inline on the field the response names. Design system: existing `Input`/button components, `type-*` styles only, no new colours.

- [ ] **Step 1: Failing tests.**
  - Service: save EUR valid → saved and normalised; EUR `CH…` without BIC → `invalid`/`bic_required`; GBP valid sort code → saved; replacing an existing EUR account updates it (one row); remove existing → removed; remove absent → absent.
  - Integration (`bank-accounts-api.test.ts`): PUT 200 / 400 `BIC_REQUIRED` / 403 another teacher / 404 unknown currency segment; DELETE 200 / unchanged; teardown guarded against unset ids.
  - Held-lock (Review Focus 3): a second connection holds the teacher `FOR NO KEY UPDATE`, sets `deletedAt`, deletes accounts, commits after the PUT is verified parked → PUT answers 404 and the teacher has zero accounts.
  - Component: the block renders the scheme's fields for EUR, GBP, USD, CHF; saving posts to the currency's URL; the other-currency rows render and Remove calls DELETE; a `BIC_REQUIRED` response marks the BIC field.
  - Onboarding: a teacher with an account in their current currency has the bank step done; switching currency (Part A switch) leaves it not done until an account exists in the new one.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** service, route, error code, form, page wiring.
- [ ] **Step 4: `docs/lock-order.md`** — add both sites to the Teacher-first section and its census command's expected output; re-run the command and record it.
- [ ] **Step 5: Run** typecheck, lint, unit + components, the new integration file, the lock-order tests serially → pass.
- [ ] **Step 6: Mutations** (record, restore): remove `lockTeacherForShare` from `saveBankAccount` → held-lock test fails (account survives / 200); map `bic_required` to the generic 400 → the code assertion fails; save with the teacher's current currency instead of the path's → a test saving a non-current currency fails (add one: a GBP teacher saving a EUR account stores currency EUR).
- [ ] **Step 7: Commit** — `feat: bank accounts saved per currency from settings (#758)`.

---

### Task 4: Docs, CLAUDE.md, verify

**Files:**
- Modify: `docs/data-model.md` (TeacherBankAccount table; Teacher loses the two fields; bank-methods condition), `docs/product-concept.md` and `docs/information-architecture.md` (bank-method statements Part A edited — now per currency), `docs/visual/data-model.html` (Teacher fields; the new table), `CLAUDE.md` (Payment Model: Level 1 bank details per currency, one line), `docs/superpowers/specs/2026-10-06-multi-currency-design.md` only if a Part B sentence is false against the code.

- [ ] **Step 1:** `grep -rnE "bankIban|bankAccountName|IBAN|euro payments|BANK_METHOD" docs CLAUDE.md --include='*.md' --include='*.html' | grep -v superpowers/plans` → replace every sentence the branch falsified (replace, don't annotate); verdict per hit in the report.
- [ ] **Step 2:** `pnpm run verify` (worktree: `pnpm run worktree:up` first). Record per-invocation counts.
- [ ] **Step 3: Commit** — `docs: bank accounts per currency in the data model and product docs (#758)`.
