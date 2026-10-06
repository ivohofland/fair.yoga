# Multi-currency, Part A (currency) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every amount carries the right currency: `Class` and `StudioClass` snapshot it, everything else reads the teacher's, and a teacher's switch relabels what is still editable.

**Architecture:** A Prisma `Currency` enum; `Teacher.currency` replaces the inert `defaultCurrency` string; `Class.currency`/`StudioClass.currency` are snapshots guarded by triggers. One deterministic formatter (`formatMoney`) replaces `formatCents`/`formatEuro`. The switch is one transaction under the lock order `Teacher → ClassTemplate → StudioClassTemplate → Class`, which teacher erasure is reordered to match.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (unit / components / integration projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-multi-currency-design.md` — Part A only. Part B (bank accounts) gets its own plan after this merges.

## Global Constraints

- `Currency` members, in this declaration order: `EUR GBP USD CHF SEK NOK DKK`.
- Prefixes: `EUR: '€'`, `GBP: '£'`, `USD: '$'`, `CHF: 'CHF '`, `SEK: 'SEK '`, `NOK: 'NOK '`, `DKK: 'DKK '` — a `satisfies Record<Currency, string>` table, never `Intl.NumberFormat`.
- `formatMoney` keeps today's rules: U+2212 `−` before the prefix for negatives, zero is `€0.00` (never `−€0.00`), two decimals, no thousands separator. EUR output must be byte-identical to today's `formatCents`/`formatEuro`.
- No amount is ever added to an amount in another currency.
- Lock order: `Teacher` is the first lock of every transaction that takes it; then `ClassTemplate`, `StudioClassTemplate`, then `Class` (existing rules from `docs/lock-order.md` below that).
- Migrations: hand-written directory, SQL from `pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`, applied with `pnpm exec prisma migrate deploy` (`migrate dev` refuses a non-interactive shell). Any `UPDATE`/`DELETE` in a migration sits in a `DO $$` block with `GET DIAGNOSTICS` + `RAISE NOTICE` (`src/lib/migration-remediation-trace.test.ts` enforces it). Migration comments describe only their own SQL.
- Refusals use a registered code (`src/lib/api-error-codes.ts`); tests assert the code, not the message. Already-done answers `respondUnchanged`.
- Comment Discipline (CLAUDE.md): no counts or rosters in comments; tether membership to the compiler.
- Stage exact paths; quote paths containing `(teacher)`/`(student)`/`(public)`.
- Not in production: migrations map seed data only; no backfill concerns beyond `NOT NULL` defaults.
- Every guard gets a mutation step: break it, record the exact failure text in the task report, restore, re-run green, and end with `git status` clean.

## Review Focus

1. **A class booked while the switch runs** — the teacher switches EUR→GBP at the same moment a student books an unbooked class; the class must keep EUR (booking won) or be GBP with the booking after (switch won), never GBP-relabelled after its economics locked. Pinned in Task 6 (held-lock race test).
2. **A generated week landing mid-switch** — the hourly sweep generates for a template while the teacher switches; no new class may commit in the old currency after the switch commits. Pinned in Task 6 (held template lock).
3. **A teacher with two currencies opening reporting** — nothing sums across currencies; each currency gets its own total line, and a single-currency teacher sees today's layout. Pinned in Task 4.
4. **A cancelled or completed class with zero bookings** — `settingsLocked` is false but the class is terminal; the switch must keep its currency and the trigger must refuse a direct update. Pinned in Tasks 6 and 7.
5. **A GBP class's payment on the pay page before Part B** — must show no bank methods (no euro EPC QR). Pinned in Task 3.

## Task order

Tasks 1 → 2 → 3 → 4 are a chain (schema, formatter, threading, sums). **Task 5 (erasure reorder) must land before Task 6 (the switch)** — the switch introduces the `Teacher → Class` edge that erasure currently reverses; landing Task 6 first leaves a deadlock on the branch. Task 7 (triggers) may land any time after Task 1; it is placed after Task 6 so its mutation step can use the switch's own tests as a second witness. Task 8 is docs and export last.

---

### Task 1: `Currency` enum, `Teacher.currency`, snapshot columns, stamping

**Files:**
- Modify: `prisma/schema.prisma` (Teacher `defaultCurrency` → `currency`; `Class`, `StudioClass` gain `currency`; new `enum Currency`)
- Create: `prisma/migrations/20261006120000_currency_enum_and_snapshots/migration.sql`
- Modify: `src/lib/schemas.ts` (`updateTeacherSchema`)
- Modify: `src/app/api/account/teacher-profile/route.ts` (signup writes `currency: 'EUR'`)
- Modify: `src/app/(teacher)/settings/profile/page.tsx`, `src/components/settings/profile-form.tsx` (field rename; options typed by `Currency`)
- Modify: `src/services/class-generator.ts`, `src/services/studio-class-generator.ts` (stamp from the template's teacher)
- Modify: `src/app/api/classes/route.ts`, `src/app/api/studio-classes/route.ts` (stamp from the teacher)
- Modify: `src/services/gdpr.ts` (export key `defaultCurrency` → `currency`)
- Modify: `prisma/seed.ts`
- Test: `tests/integration/currency-stamping.test.ts` (create); update existing tests that name `defaultCurrency` (`grep -rln defaultCurrency src tests`)

**Interfaces:**
- Produces: `import { Currency } from '@prisma/client'` (enum, values above); `Teacher.currency: Currency`; `Class.currency: Currency`; `StudioClass.currency: Currency`.

- [ ] **Step 1: Write the failing integration test** — `tests/integration/currency-stamping.test.ts`. Seed a teacher with `currency: 'GBP'` (direct Prisma), then (a) `POST /api/classes` a draft and assert the created `Class.currency === 'GBP'`; (b) `POST /api/studio-classes` and assert `StudioClass.currency === 'GBP'`; (c) create a class template via its API route and assert every generated `Class` has `currency: 'GBP'`; (d) same for a studio template; (e) `PUT /api/teachers/[id]` with `{ currency: 'XYZ' }` answers 400. Follow an existing integration file for session/teacher seeding (`seedSession`, `freshIp`, `teardownTeacher` from `tests/helpers.ts`; `tests/integration/teachers-api.test.ts` is the nearest model).

- [ ] **Step 2: Run it, expect failure** — `pnpm exec vitest run --project integration tests/integration/currency-stamping.test.ts` → fails to compile/insert (`currency` unknown on `Teacher`).

- [ ] **Step 3: Schema.**

```prisma
enum Currency {
  EUR
  GBP
  USD
  CHF
  SEK
  NOK
  DKK
}
```

On `Teacher`, replace `defaultCurrency String @default("EUR")` with `currency Currency @default(EUR)`. On `Class` and `StudioClass` add `currency Currency` (no default — every writer must stamp it; the migration backfills).

- [ ] **Step 4: Migration.** Generate the diff SQL (Global Constraints), then hand-edit so the data survives: create the enum; add `Teacher.currency` from the old column (`USING CASE WHEN "defaultCurrency" IN ('EUR','GBP','USD','CHF','SEK','NOK','DKK') THEN "defaultCurrency"::"Currency" ELSE 'EUR' END` via add-column-then-update-then-drop); add `Class.currency`/`StudioClass.currency` nullable, backfill from the teacher through `CalendarEntry."teacherId"`, then `SET NOT NULL`. Every `UPDATE` inside a `DO $$ … GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE … $$` block. Apply with `pnpm exec prisma migrate deploy`, then `pnpm exec prisma generate`.

- [ ] **Step 5: Validation and writers.**
  - `src/lib/schemas.ts`: `currency: z.enum(Currency).optional()` (import `Currency` from `@prisma/client`, the same way `ReminderTiming` is imported for `classReminder`); drop `defaultCurrency`.
  - Signup route: `currency: 'EUR'`.
  - Profile form + page: rename the field; type the options as `ReadonlyArray<{ value: Currency; label: string }>` and derive each label from `CURRENCY_PREFIX` once Task 2 exists — for this task keep the existing label strings.
  - `CLASS_GENERATOR.readChildOrThrow` / the studio equivalent: extend the teacher `select` with `currency: true`; `createChildren` writes `currency: template.scheduleRule.teacher.currency`. Widen `TemplateWithTimezone` (and the studio twin) accordingly.
  - `api/classes` and `api/studio-classes` POST: read the teacher's currency inside the transaction (Task 6 adds the `FOR SHARE` in front of this read) and write it into the `create` data.
  - `gdpr.ts`: `currency: teacher.currency`.
  - Seed: `currency:` on each teacher (`EUR`, `GBP`, `USD` as today).

- [ ] **Step 6: Run the test, expect pass**; then `pnpm run typecheck` — fix every `defaultCurrency` reference the compiler names.

- [ ] **Step 7: Mutation.** Delete `currency: template.scheduleRule.teacher.currency` from `CLASS_GENERATOR.createChildren`. Expected: typecheck fails (required field) — record the error. Restore. Then replace it with the literal `'EUR'`; expected: test (c) fails with `expected 'EUR' to be 'GBP'`. Restore; `git status` clean apart from this task's edits.

- [ ] **Step 8: Commit** — `feat: Currency enum, Teacher.currency, Class/StudioClass currency snapshots (#758)`.

---

### Task 2: `formatMoney` and the prefix table

**Files:**
- Modify: `src/lib/format.ts`
- Test: `src/lib/format.test.ts`

**Interfaces:**
- Consumes: `Currency` (Task 1).
- Produces:
  - `export const CURRENCY_PREFIX: { readonly [C in Currency]: string }` (declared with `as const satisfies Record<Currency, string>`)
  - `export function formatMoney(amount: number | Prisma.Decimal, currency: Currency): string` — `amount` in major units (euros, pounds), as `formatEuro` takes today
  - `export function formatMoneyCents(cents: number, currency: Currency): string`
  - `export function currencyLabel(currency: Currency): string` — the bare symbol for input labels: `€`, `£`, `$`, `CHF`, `SEK`, `NOK`, `DKK` (the prefix, trimmed)

`format.ts` is imported by client components; `Prisma.Decimal` must come in as a **type-only** import (`import type { Prisma } from '@prisma/client'`), with the runtime branch `typeof amount === 'number' ? amount : amount.toNumber()`.

- [ ] **Step 1: Failing tests** in `format.test.ts`:

```ts
describe('formatMoney', () => {
  it.each([
    ['EUR', 15.2, '€15.20'], ['GBP', 15.2, '£15.20'], ['USD', 15.2, '$15.20'],
    ['CHF', 15.2, 'CHF 15.20'], ['SEK', 15.2, 'SEK 15.20'],
    ['NOK', 15.2, 'NOK 15.20'], ['DKK', 15.2, 'DKK 15.20'],
  ] as const)('%s', (currency, amount, expected) => {
    expect(formatMoney(amount, currency)).toBe(expected);
  });
  it('puts the minus before the prefix', () => {
    expect(formatMoney(-3.5, 'CHF')).toBe('−CHF 3.50');
  });
  it('never signs zero', () => {
    expect(formatMoney(-0.004, 'GBP')).toBe('£0.00');
  });
  it('has no thousands separator', () => {
    expect(formatMoney(1234.5, 'EUR')).toBe('€1234.50');
  });
  it('accepts a Decimal', () => {
    expect(formatMoney(new Prisma.Decimal('7.05'), 'EUR')).toBe('€7.05');
  });
  it('rejects non-finite', () => {
    expect(() => formatMoney(Number.NaN, 'EUR')).toThrow(RangeError);
  });
});
describe('currencyLabel', () => {
  it('trims the code prefixes', () => {
    expect(currencyLabel('SEK')).toBe('SEK');
    expect(currencyLabel('EUR')).toBe('€');
  });
});
```

The test file may import `Prisma` as a value. Keep every existing `formatCents`/`formatEuro` test — they pin the EUR byte-identity until Task 3 deletes those functions and moves their cases onto `formatMoney(…, 'EUR')`.

- [ ] **Step 2: Run** `pnpm exec vitest run --project unit src/lib/format.test.ts` → fails (`formatMoney` not exported).

- [ ] **Step 3: Implement.**

```ts
export const CURRENCY_PREFIX = {
  EUR: '€', GBP: '£', USD: '$', CHF: 'CHF ', SEK: 'SEK ', NOK: 'NOK ', DKK: 'DKK ',
} as const satisfies Record<Currency, string>;

export function formatMoneyCents(cents: number, currency: Currency): string {
  if (!Number.isFinite(cents)) {
    throw new RangeError(`formatMoneyCents: expected finite number, received ${cents}`);
  }
  const rounded = Math.round(cents);
  const abs = Math.abs(rounded);
  const units = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${rounded < 0 ? '−' : ''}${CURRENCY_PREFIX[currency]}${units}.${rest}`;
}

export function formatMoney(amount: number | Prisma.Decimal, currency: Currency): string {
  const n = typeof amount === 'number' ? amount : amount.toNumber();
  return formatMoneyCents(Math.round(n * 100), currency);
}

export function currencyLabel(currency: Currency): string {
  return CURRENCY_PREFIX[currency].trim();
}
```

Re-implement `formatCents(c)` as `formatMoneyCents(c, 'EUR')` and `formatEuro(e)` as `formatMoney(e, 'EUR')` so their tests keep running against the new code until Task 3 removes them. `Currency` is imported as a type (`import type { Currency } from '@prisma/client'`) — a string-literal union at runtime needs no value import.

- [ ] **Step 4: Run** → pass (old and new tests).
- [ ] **Step 5: Mutation.** Add a `JPY: '¥'` entry to `CURRENCY_PREFIX` → typecheck fails (`satisfies`: object literal may only specify known properties). Remove the `DKK` entry → typecheck fails (property `DKK` missing). Record both errors; restore.
- [ ] **Step 6: Commit** — `feat: formatMoney with a per-currency prefix table (#758)`.

---

### Task 3: Thread the currency to every amount, and gate bank methods to EUR

**Files** (render sites from the census taken for the spec; the compiler finds any it missed once the old formatters are deleted):
- Teacher UI: `src/app/(teacher)/settings/payments/page.tsx`, `src/components/class/outstanding-payment-row.tsx`, `received-payment-row.tsx`, `not-charged-payment-row.tsx`, `payment-checklist.tsx`, `pricing-breakdown.tsx`, `pricing-preview.tsx`, `pricing-preview-table.tsx`, `class-edit-form.tsx`, `src/app/(teacher)/class/new/page.tsx`, `src/app/(teacher)/class/[id]/(overview)/page.tsx`, `src/app/(teacher)/class/[id]/edit/page.tsx`, `src/app/(teacher)/studio-class/[id]/page.tsx`, `src/app/(teacher)/studio-class/new/page.tsx`, `src/components/studio-class/delete-studio-class-button.tsx`, `studio-class-edit-form.tsx`, `src/components/settings/room-list.tsx`, `studio-template-list.tsx`, `template-form.tsx`, `studio-template-form.tsx`, `edit-room-form.tsx`, `room-settings-step.tsx`, `edit-teacher-room-form.tsx`, `src/components/students/student-payment-list.tsx`, `src/app/(teacher)/students/[id]/page.tsx`
- Student/public: `src/app/(student)/bookings/page.tsx`, `src/app/(student)/bookings/[classId]/pay/page.tsx`, `src/components/student/payment-qr.tsx`, `payment-breakdown.tsx`, `src/lib/payment-breakdown.ts`, `src/components/booking/price-range.tsx`, `booking-flow.tsx`, `src/lib/price-line.ts`, `src/app/(public)/[slug]/page.tsx`, `src/app/(public)/[slug]/book/[classId]/page.tsx`
- Copy: `src/lib/payment-request-copy.ts`, `src/services/class-lifecycle.ts` (completion notice), `src/services/payment-reminders.ts`, `src/services/payments.ts`
- Methods: `src/lib/payment-methods.ts` and its callers
- Delete: `formatCents`, `formatEuro` from `src/lib/format.ts`; move their test cases onto `formatMoney(…, 'EUR')` / `formatMoneyCents(…, 'EUR')`
- Tests: component tests beside each changed component (`*.test.tsx`), `src/lib/payment-methods.test.ts`, `src/lib/payment-request-copy.test.ts`, `tests/integration/pay-page.test.ts`

**Interfaces:**
- Consumes: `formatMoney`, `formatMoneyCents`, `currencyLabel` (Task 2); `Class.currency`, `StudioClass.currency`, `Teacher.currency` (Task 1).
- Produces:
  - every component that renders a bare amount takes a **required** `currency: Currency` prop
  - `paymentMethodsFor(teacher: { bankIban: string | null; bankAccountName: string | null }, currency: Currency): PaymentMethod[]` — returns `[]` unless `currency === 'EUR'`
  - `studentPaymentRequestBody(…, currency: Currency)` and `studentPaymentReminderBody(…, currency: Currency)` gain a trailing currency argument

**Where each currency comes from:** a `Class` row → `cls.currency`; a `Payment`/`Registration` → its class's `currency` (widen the Prisma `select` to include `class: { select: { currency: true } }` where the census showed only `calendarEntry` selected — `students/[id]/page.tsx`, `payment-reminders.ts`, `payments.ts`); a `StudioClass` → its own; rooms, templates, and the new-class/new-template/new-studio-class forms → the teacher's `currency`, read by the page and passed down. Input labels: `` `Room cost (${currencyLabel(currency)})` `` — and the forms that today have no symbol in their label (census: `class/new`, `studio-class/new`, the room forms, the template forms) gain one the same way.

- [ ] **Step 1: Failing tests.**
  - `payment-methods.test.ts`: `paymentMethodsFor({ bankIban: 'NL91ABNA0417164300', bankAccountName: 'A' }, 'GBP')` → `[]`; same with `'EUR'` → two methods (existing expectation).
  - `payment-request-copy.test.ts`: reminder body with `'GBP'` contains `£12.00`.
  - One component test per bare-prop component (`outstanding-payment-row`, `booking-flow`, `price-range`, `pricing-preview-table`, `payment-breakdown`): render with `currency="CHF"` and assert `CHF ` appears and `€` does not.
  - `tests/integration/pay-page.test.ts`: a GBP class's completed payment, teacher with an IBAN → the page shows the amount as `£…` and renders neither "Bank transfer" nor the QR (the existing no-methods copy instead).
- [ ] **Step 2: Run** the touched unit/component files and the pay-page integration file → fail.
- [ ] **Step 3: Implement.** Delete `formatCents`/`formatEuro` first, then follow the compiler: every call site becomes `formatMoney(x, currency)` with `currency` from the row as above; every literal `€`/`&euro;` with `toFixed(2)` becomes `formatMoney`. `PaymentQr` keeps `EUR` in its payload — it is only reached for an `epc_qr` method, which `paymentMethodsFor` now produces only for EUR; its alt text uses `formatMoney(amount, 'EUR')`. Thread `cls.currency` into every `paymentMethodsFor` call (`bookings/page.tsx`, `pay/page.tsx`, `class-lifecycle.ts`, `payment-reminders.ts`, `payments.ts`, `email-fallback.ts`; `onboarding.ts` passes the teacher's own `currency`).
- [ ] **Step 4: Sweep** — `grep -rn "€\|&euro;" src | grep -v "\.test\."` must return only comments and `CURRENCY_PREFIX`; give each surviving hit a verdict in the task report. `grep -rn "formatCents\|formatEuro" src` must return nothing.
- [ ] **Step 5: Run** `pnpm run typecheck`, `pnpm run lint`, the unit and components projects, and the pay-page integration file → pass.
- [ ] **Step 6: Mutation.** In `paymentMethodsFor`, remove the currency gate → the GBP unit test and the pay-page integration test fail; record both messages. Restore. In `outstanding-payment-row.tsx`, render `formatMoney(amount, 'EUR')` instead of the prop → its CHF test fails; restore.
- [ ] **Step 7: Commit** — `feat: every amount renders in its row's currency; bank methods only for EUR until Part B (#758)`.

---

### Task 4: Sums group by currency

**Files:**
- Create: `src/lib/money-totals.ts`
- Modify: `src/app/(teacher)/settings/reporting/page.tsx`, `src/app/(teacher)/settings/payments/page.tsx`, `src/app/(teacher)/students/[id]/page.tsx`, `src/components/students/archive-student-button.tsx`, `src/services/student-archive-copy.ts`, `src/services/student-archive.ts`
- Test: `src/lib/money-totals.test.ts`, `src/services/student-archive-copy.test.ts`, `tests/integration/reporting-currency.test.ts` (create)

**Interfaces:**
- Consumes: `formatMoney` (Task 2), `Currency`.
- Produces:

```ts
/** One total per currency present, never across currencies. */
export type MoneyTotals = ReadonlyArray<{ currency: Currency; cents: number }>;

/**
 * Sums `items` per currency in whole cents. Order: `first` (the teacher's
 * current currency) when present, then the rest in `Currency` declaration order.
 */
export function totalsByCurrency(
  items: Iterable<{ currency: Currency; amount: number | Prisma.Decimal }>,
  first: Currency,
): MoneyTotals;

/** "€40.00", or "€40.00 and £12.00", or "€1.00, £2.00 and $3.00"; "" for none. */
export function formatTotals(totals: MoneyTotals): string;
```

Declaration order comes from `Object.values(Currency)` (the Prisma enum object), so it follows the schema without a second list.

- [ ] **Step 1: Failing unit tests** for `totalsByCurrency` (mixed input sums per currency in cents without float drift — `0.1 + 0.2` in EUR → 30 cents; ordering with `first: 'GBP'` puts GBP first, then EUR before USD) and `formatTotals` (empty, one, two, three). `owedPhrase` with payments in EUR and GBP → `"€40.00 and £12.00 across 3 payments"`.
- [ ] **Step 2: Failing integration test** `tests/integration/reporting-currency.test.ts`: a teacher with a completed EUR class (non-zero `totalRevenue`) and a completed GBP class, fetch `/settings/reporting` with the teacher's session and assert both `€` and `£` totals appear and that no line shows their numeric sum. A second teacher with only EUR classes: the page's total section renders exactly one total line (assert on the same markup today's page renders, e.g. by `data-testid` — add a `data-testid="report-total"` to the line if none exists).
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement.** Reporting: the class/studio/room-cost totals and the per-month rollup each become `MoneyTotals` (by month: `Map<monthKey, MoneyTotals>`); render one line per currency where one line stood. Payments overview: `outstandingTotal`/`receivedTotal` become `MoneyTotals`. Student page: the outstanding sum becomes `MoneyTotals`, `ArchiveStudentButton` takes `outstanding: { totals: MoneyTotals; count: number }` and renders `formatTotals`. `student-archive.ts` selects the class currency alongside `{ id, amount }`; `owedPhrase` uses `totalsByCurrency` + `formatTotals`.
- [ ] **Step 5: Run** → pass; typecheck; lint.
- [ ] **Step 6: Mutation.** Make `totalsByCurrency` key every item under `first` → unit tests and the reporting integration test fail; record; restore.
- [ ] **Step 7: Commit** — `feat: reporting, payment and owed totals group by currency (#758)`.

---

### Task 5: Teacher erasure takes `Teacher` first

**Must land before Task 6.**

**Files:**
- Modify: `src/lib/db-locks.ts` (add `lockTeacherForNoKeyUpdate`)
- Modify: `src/services/gdpr.ts` (`deleteTeacherAccount`)
- Modify: `docs/lock-order.md` (new section: "The `Teacher` row is the first lock (#758)")
- Test: `src/services/gdpr-lock-order.test.ts`, `src/lib/db-locks.test.ts`, and whichever census test names lock helpers (`src/lib/db-locks-verdict-census.test.ts`, `src/lib/db-locks-lock-order.test.ts` — read both first; they encode the rules for adding a helper)

**Interfaces:**
- Produces: `export async function lockTeacherForNoKeyUpdate(tx: TransactionClientOnly, teacherId: string): Promise<{ currency: Currency; defaultTimezone: string } | null>` — `SET LOCAL lock_timeout` via `setLockTimeout`, then `SELECT currency, "defaultTimezone" FROM "Teacher" WHERE id = $1 AND "deletedAt" IS NULL FOR NO KEY UPDATE`; `null` when absent or erased. `FOR NO KEY UPDATE`, not `FOR UPDATE`: a `CalendarEntry` insert's foreign-key check takes `KEY SHARE` on the teacher, and the generator inserts entries while holding its template row (spec A2). Also `export async function lockTeacherForShare(tx, teacherId): Promise<{ currency: Currency } | null>` — same shape, `FOR SHARE` (Task 6's creators use it; `lockLiveTeacher` stays as is for the photo gate).

- [ ] **Step 1: Read** `docs/lock-order.md` sections "`Class` is the real gate", "The `Teacher` row is the photo upload's gate (#46)", and `deleteTeacherAccount` from its `$transaction` to the `teacher.updateMany`. Note in the task report every lock statement in order.
- [ ] **Step 2: Failing test** in `gdpr-lock-order.test.ts`, following that file's existing lock-sequence pattern: the first lock statement of `deleteTeacherAccount`'s transaction is a `FOR NO KEY UPDATE` on `"Teacher"`, before any `FOR UPDATE OF ct`. Plus a held-lock test in the project's pattern (memory: "hold the other side's row lock on a second connection"): a second connection holds `SELECT … FROM "Teacher" WHERE id = $1 FOR SHARE`; `deleteTeacherAccount` must not have locked any `ClassTemplate` row while it waits (probe a `ClassTemplate` row with `FOR UPDATE NOWAIT` from a third connection → succeeds).
- [ ] **Step 3: Run** → fail.
- [ ] **Step 4: Implement** the two helpers; call `lockTeacherForNoKeyUpdate` as the first statement inside `deleteTeacherAccount`'s transaction (before the `ct`/`sct` pre-locks); leave the final `updateMany` as is (it now writes a row this transaction holds). Update the comments around the pre-locks that state the order, replacing — not annotating — any sentence the new first lock falsifies.
- [ ] **Step 5: `docs/lock-order.md`.** New section stating: `Teacher` is the first lock of every transaction that takes it; the sites (`deleteTeacherAccount` `FOR NO KEY UPDATE`; photo upload `FOR SHARE`; Task 6's switch `FOR NO KEY UPDATE` and creators `FOR SHARE` — written in Task 6), with the re-derivation command `grep -rn "lockTeacherForNoKeyUpdate\|lockTeacherForShare\|lockLiveTeacher" src | grep -v "\.test\."`. Fix the photo-upload section if it claims erasure writes `Teacher` last.
- [ ] **Step 6: Run** the lock-order, gdpr and census tests, then `pnpm exec vitest run --project integration` for any `gdpr`/`erasure` integration files → pass.
- [ ] **Step 7: Mutation.** Move the `lockTeacherForNoKeyUpdate` call to after the `ct` pre-lock → the lock-sequence test fails; record; restore.
- [ ] **Step 8: Commit** — `fix: teacher erasure takes the Teacher row first (#758)`.

---

### Task 6: The currency switch

**Files:**
- Create: `src/services/currency-switch.ts`
- Modify: `src/app/api/teachers/[id]/route.ts`
- Modify: `src/app/api/classes/route.ts`, `src/app/api/studio-classes/route.ts`, `src/services/class-template-lifecycle.ts` (`createClassTemplate`), `src/services/studio-class-template-lifecycle.ts` (`createStudioClassTemplate`) — `lockTeacherForShare` as the first lock of each transaction, and stamp from its result
- Modify: `src/components/settings/profile-form.tsx` (show the switch's counts)
- Modify: `docs/lock-order.md` (the section from Task 5 gains the switch and creators)
- Test: `src/services/currency-switch.test.ts` or `tests/integration/currency-switch.test.ts` (match where `room-switch` tests live), `src/components/settings/profile-form.test.tsx`, census tests that list `lockClassRowsOrdered` call sites (`db-locks-verdict-census.test.ts` — a new call site needs its verdict entry)

**Interfaces:**
- Consumes: `lockTeacherForNoKeyUpdate`, `lockTeacherForShare` (Task 5); `lockClassRowsOrdered`, `CLASS_TO_ENTRY_JOIN` (`db-locks.ts`); `studioClassDateIsPast` (`src/services/studio-class-editability.ts`).
- Produces:

```ts
export type CurrencySwitchResult = {
  relabelled: { classes: number; studioClasses: number };
  kept: { classes: number; studioClasses: number };
};

/** Runs inside the caller's transaction. Caller has not yet locked anything. */
export async function switchTeacherCurrency(
  tx: TransactionClientOnly,
  teacherId: string,
  currency: Currency,
): Promise<CurrencySwitchResult | 'unchanged' | 'teacher_gone'>;
```

Sequence (spec A2): `lockTeacherForNoKeyUpdate` → `null` ⇒ `'teacher_gone'`; equal currency ⇒ `'unchanged'`; `SELECT … FROM "ClassTemplate" ct JOIN "ScheduleRule" r … WHERE r."teacherId" = $1 ORDER BY ct.id FOR UPDATE OF ct`, then the same for `StudioClassTemplate`; `lockClassRowsOrdered(tx, { join: CLASS_TO_ENTRY_JOIN, where: Prisma.sql\`e."teacherId" = ${teacherId} AND NOT c."settingsLocked" AND c.status <> 'completed' AND c."entryLive"\` })`; `tx.class.updateMany({ where: { id: { in: ids } }, data: { currency } })`; studio rows: fetch the teacher's `StudioClass` ids with their entry dates, keep those where `!studioClassDateIsPast(date, now, timezone)`, `updateMany`; `kept` counts are the teacher's remaining rows of each family not in the relabelled sets; finally `tx.teacher.update({ data: { currency } })`.

Route: when `updateData.currency` is present, the whole PUT runs in one `prisma.$transaction`: `switchTeacherCurrency` first, then the existing `teacher.update` with the remaining fields (on `tx`). `'unchanged'` with no other fields ⇒ `respondUnchanged`; `'teacher_gone'` ⇒ 404. Response body: the teacher, plus `currencySwitch: CurrencySwitchResult` when a switch happened. Profile form: after a save whose response has `currencySwitch`, show one line — "12 upcoming classes now show £. 3 classes keep €, because they're booked or finished." (omit either clause when its count is zero; studio classes counted in with classes).

- [ ] **Step 1: Failing tests.**
  - Relabel set: a teacher (EUR) with one draft, one open unbooked, one open booked (`settingsLocked: true`), one completed with zero registrations, one cancelled unbooked (`entryLive: false` via cancelling the entry), a studio class dated yesterday and one dated tomorrow (teacher in `UTC` — memory: real-time fixtures need a UTC teacher). `PUT { currency: 'GBP' }` → draft, open-unbooked and tomorrow's studio class are GBP; the rest EUR; `currencySwitch` = `{ relabelled: { classes: 2, studioClasses: 1 }, kept: { classes: 3, studioClasses: 1 } }`; `Teacher.currency === 'GBP'`.
  - Same currency again → 200 unchanged shape (`respondUnchanged`), nothing written.
  - Another teacher's classes are untouched (cross-owner decoy — the `lockClassRowsOrdered` docblock and `docs/superpowers/specs/2026-09-05-pre-lock-scope-decoys-design.md` require one).
  - **Booking race (Review Focus 1):** a second connection holds `lockClassRow`-equivalent `SELECT … FROM "Class" WHERE id = $1 FOR UPDATE` on the open unbooked class, then sets `settingsLocked = true` and commits after the switch request has started waiting (follow the existing held-lock tests in `room-switch-lock-order.test.ts` / registrations `route-lock-order.test.ts` for the handshake). The class must end EUR.
  - **Generation race (Review Focus 2):** a second connection holds the teacher's `ClassTemplate` row `FOR UPDATE` and inserts a new entry + `Class` (`currency: 'EUR'`) for it, commits after the switch starts waiting → that class ends GBP.
  - **Create race:** a second connection holds `Teacher … FOR NO KEY UPDATE` (standing in for the switch); `POST /api/classes` must not complete until it is released, and after the holder sets `currency = 'GBP'` and commits, the created class is GBP.
- [ ] **Step 2: Run** → fail.
- [ ] **Step 3: Implement** the service, the route branch, the creators' `lockTeacherForShare` (first lock statement in each transaction; stamp from its returned `currency`, replacing Task 1's plain read), the form line, the census verdict entry, and the `docs/lock-order.md` additions.
- [ ] **Step 4: Run** the new tests, the lock-order and census tests, typecheck, lint → pass.
- [ ] **Step 5: Mutations** (one at a time; record each failure; restore):
  1. Drop `AND NOT c."settingsLocked"` → relabel-set test fails (booked class becomes GBP).
  2. Drop the `ClassTemplate` `FOR UPDATE` → generation-race test fails (class stays EUR).
  3. Remove `lockTeacherForShare` from `POST /api/classes` → create-race test fails.
  4. Replace `!studioClassDateIsPast(…)` with `true` → yesterday's studio class becomes GBP; test fails.
  End with `git status` showing only this task's intended edits.
- [ ] **Step 6: Commit** — `feat: switching currency relabels what is still editable (#758)`.

---

### Task 7: Database guards on the snapshot columns

**Files:**
- Create: `prisma/migrations/20261006130000_currency_frozen_guards/migration.sql`
- Modify: `src/lib/api-errors.ts` only if the trigger message needs classifying (see Step 4)
- Test: `tests/integration/currency-frozen-guards.test.ts` (create)

- [ ] **Step 1: Failing test.** Direct Prisma `update` of `Class.currency` on (a) a `settingsLocked` class, (b) a completed class, (c) a cancelled class → each rejects with a Postgres error whose message contains `cannot change its currency`; (d) an unlocked open class → succeeds. `StudioClass.currency` on a studio class dated three days ago → rejects; dated tomorrow → succeeds.
- [ ] **Step 2: Run** → fail (updates succeed).
- [ ] **Step 3: Migration** (wrapped in `BEGIN; … COMMIT;` like `20260826182710_entry_completion_marker_guard`; comments describe only this SQL):

```sql
CREATE OR REPLACE FUNCTION class_reject_frozen_currency_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NEW;
  END IF;
  IF OLD."settingsLocked" OR OLD.status = 'completed' OR NOT OLD."entryLive" THEN
    RAISE EXCEPTION 'Class % is booked or terminal and cannot change its currency', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_currency_frozen_guard
  BEFORE UPDATE OF currency ON "Class"
  FOR EACH ROW EXECUTE FUNCTION class_reject_frozen_currency_change();

CREATE OR REPLACE FUNCTION studio_class_reject_frozen_currency_change()
RETURNS TRIGGER AS $$
DECLARE
  entry_date date;
BEGIN
  IF NEW.currency IS NOT DISTINCT FROM OLD.currency THEN
    RETURN NEW;
  END IF;
  SELECT e.date INTO entry_date FROM "CalendarEntry" e WHERE e.id = OLD."calendarEntryId";
  IF entry_date < CURRENT_DATE - 1 THEN
    RAISE EXCEPTION 'Studio class % is a past income record and cannot change its currency', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER studio_class_currency_frozen_guard
  BEFORE UPDATE OF currency ON "StudioClass"
  FOR EACH ROW EXECUTE FUNCTION studio_class_reject_frozen_currency_change();
```

Check the existing triggers' `ERRCODE` choice and message conventions first (`grep -rn "RAISE EXCEPTION" prisma/migrations`) and match them; the `UPDATE OF` caveat in `20260826182710_entry_completion_marker_guard` (fires on a column's presence in the SET list) is fine here because only `currency` is guarded and no other column write can change what it guards against into a permitted state — say so in the migration comment only if it is about this SQL.

Apply with `pnpm exec prisma migrate deploy`; confirm `pnpm exec prisma migrate status` is clean.
- [ ] **Step 4: Classification.** The switch never trips these (its `where` matches the trigger's predicate). If `classifyApiError` would log an unexpected `check_violation` at `error`, that is the right level (an unguarded writer appeared); no route maps it to a 409. Confirm by reading `src/lib/api-errors.ts`; change nothing unless a test shows a wrong status.
- [ ] **Step 5: Run** → pass. Re-run Task 6's tests → still pass.
- [ ] **Step 6: Mutation.** `CREATE OR REPLACE` the class function without `OR NOT OLD."entryLive"` via `psql` in the `fairyoga-db-1` container (or the worktree's DB) → test (c) fails; record; restore by re-running the original `CREATE OR REPLACE`. Then confirm `migrate status` still clean.
- [ ] **Step 7: Commit** — `feat: triggers refuse a currency change on a frozen class or past studio class (#758)`.

---

### Task 8: GDPR export, docs, CLAUDE.md

**Files:**
- Modify: `src/services/gdpr.ts` (export), `src/services/gdpr.test.ts`
- Modify: `docs/data-model.md` (Currency enum; `Teacher.currency`; `Class.currency`, `StudioClass.currency`, the freeze rule), `CLAUDE.md` (Data Model: one bullet on where currency lives, linking the spec), `docs/product-concept.md` and `docs/information-architecture.md` only where they state amounts are euro (census lines: `product-concept.md:203,225,227`, `information-architecture.md:210`)

- [ ] **Step 1: Failing test** in `gdpr.test.ts`: the teacher export's classes carry `currency` from the class, studio classes from theirs, rooms and templates the teacher's; the student export's payments and prices carry their class's currency.
- [ ] **Step 2: Run** → fail. **Step 3: Implement.** **Step 4: Run** → pass.
- [ ] **Step 5: Docs.** Replace (not annotate) any sentence the change falsifies. No counts in comments; counts in `docs/` ship with their command.
- [ ] **Step 6:** `pnpm run verify` (worktree: `pnpm run worktree:up` first). Record the per-project test counts for the PR body.
- [ ] **Step 7: Commit** — `docs: currency in the data model; GDPR export carries currency (#758)`.
