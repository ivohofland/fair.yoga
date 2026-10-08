# Payment Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can save one open-ended `https://` payment link (Tikkie, PayPal.me, Revolut…). Students see it as one more Level 1 method on the pay page, after bank transfer and QR. A link alone counts as payout details everywhere the app asks "does this teacher have a way to be paid".

**Architecture:** The link is a nullable `Teacher.paymentLink` column, guarded by a CHECK. A client-safe parser in `src/lib/payment-link.ts` validates it. The `payment_link` member of the `PaymentMethod` union is produced by `paymentMethodsFor`, whose input now requires the link, so all six call sites must read it to compile. A dedicated `PUT`/`DELETE /api/teachers/[id]/payment-link` route and a small settings form handle editing.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, zod, Vitest (unit / components / integration projects), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-08-payment-link-design.md` — read it before your task.

## Global Constraints

- TypeScript `strict`, no `any`, no non-null `!` assertions on parsed input.
- `PAYMENT_LINK_MAX = 500` (in `src/lib/input-bounds.ts`). The migration's CHECK repeats the literal `500`.
- Only `https:` is accepted. There is no allowlist of hosts and no amount templating.
- The host shown is `URL.hostname` with one leading `www.` removed. The button reads exactly `Pay via {host}`.
- The anchor is `target="_blank"` and `rel="noopener noreferrer"`.
- Method order: `bank_transfer`, `epc_qr` (EUR SEPA only), `payment_link`.
- Comment Discipline (CLAUDE.md): no counts or member rosters in comments, and no "previously" history.
- Never edit an applied migration. Create the new one with `pnpm exec prisma migrate dev --create-only --name teacher_payment_link`, then append the CHECK by hand before applying (`docs/solve-issue-lessons.md`, migrations; if `migrate dev` refuses as non-interactive, write the migration directory by hand with a `YYYYMMDDHHMMSS` name later than `20261007140000` and apply with `pnpm exec prisma migrate deploy`).
- Stage exact paths; quote paths containing parentheses. Never `git add -A`.
- Worktree: integration tests run against this worktree's app (`pnpm run worktree:up` first). Use Node 24 (`PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`).
- A guard's mutation step: break it, run the named test, record the exact failure text in your report, restore, re-run green, and confirm `git status` is clean apart from intended edits.

## Review Focus

1. **A pasted link with surrounding whitespace or a trailing newline.** Expected: it is trimmed and saved. Pinned in Task 1's parser tests.
2. **A link typed without a scheme (`paypal.me/name`) or with `HTTPS://` in capitals.** Expected: the first is refused with the "start with https://" message. The second is accepted and stored lowercase-scheme. Pinned in Task 1.
3. **A teacher with only a link, no bank account.** Expected: emails and the bookings list still offer "Pay now", not "pay directly". Pinned in Task 2 (bookings integration and one service unit test).
4. **A disguised host (`https://revolut.me@evil.example/`).** Expected: refused. Pinned in Task 1.
5. **A bank row that fails to parse beside a valid link.** Expected: the link is still offered. Pinned in Task 2.

---

### Task 1: Column, CHECK, parser, wire schema

**Files:**
- Modify: `prisma/schema.prisma` (model `Teacher`: add `paymentLink String?` next to `customDomain`)
- Create: `prisma/migrations/<timestamp>_teacher_payment_link/migration.sql`
- Modify: `src/lib/input-bounds.ts` (add `PAYMENT_LINK_MAX`; follow how the file documents its other bounds, and update `src/lib/input-bounds.test.ts` if it censuses exports)
- Create: `src/lib/payment-link.ts`, `src/lib/payment-link.test.ts`
- Modify: `src/lib/schemas.ts` (add `paymentLinkSchema`), `src/lib/schemas.test.ts`
- Create: `tests/integration/payment-link-check.test.ts` (the CHECK refuses a direct write)

**Interfaces — Produces:**
```ts
// src/lib/payment-link.ts
export type PaymentLinkFailure = 'required' | 'too_long' | 'invalid' | 'not_https';
export type ParsedPaymentLink = { url: string; host: string };
export function parsePaymentLink(raw: string):
  | ({ ok: true } & ParsedPaymentLink)
  | { ok: false; error: PaymentLinkFailure };
/** A stored value re-parsed for display; null when it does not parse. */
export function paymentLinkFromColumn(stored: string | null): ParsedPaymentLink | null;
// src/lib/schemas.ts
export const paymentLinkSchema; // z.object({ paymentLink: z.string().max(PAYMENT_LINK_MAX * 2) }).strict() — Step 5
```

- [ ] **Step 1: Write the failing parser tests** (`src/lib/payment-link.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { parsePaymentLink, paymentLinkFromColumn } from './payment-link';
import { PAYMENT_LINK_MAX } from './input-bounds';

describe('parsePaymentLink', () => {
  it('accepts an https link and shows its host without www', () => {
    expect(parsePaymentLink('https://www.paypal.me/annayoga')).toEqual({
      ok: true, url: 'https://www.paypal.me/annayoga', host: 'paypal.me',
    });
  });
  it('trims surrounding whitespace and a trailing newline', () => {
    expect(parsePaymentLink('  https://revolut.me/anna\n')).toEqual({
      ok: true, url: 'https://revolut.me/anna', host: 'revolut.me',
    });
  });
  it('accepts an upper-case scheme and stores it normalised', () => {
    const r = parsePaymentLink('HTTPS://Tikkie.me/pay/abc');
    expect(r).toEqual({ ok: true, url: 'https://tikkie.me/pay/abc', host: 'tikkie.me' });
  });
  it.each([
    ['http://revolut.me/anna', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['data:text/html,hi', 'not_https'],
    ['paypal.me/anna', 'invalid'],
    ['https://revolut.me@evil.example/', 'invalid'],
    ['https://user:pw@revolut.me/', 'invalid'],
    ['   ', 'required'],
    ['', 'required'],
  ] as const)('refuses %s as %s', (raw, error) => {
    expect(parsePaymentLink(raw)).toEqual({ ok: false, error });
  });
  it('refuses a link over the bound', () => {
    const raw = `https://example.com/${'a'.repeat(PAYMENT_LINK_MAX)}`;
    expect(parsePaymentLink(raw)).toEqual({ ok: false, error: 'too_long' });
  });
  it('drops only one leading www', () => {
    expect(parsePaymentLink('https://www.www.example.com/')).toMatchObject({ host: 'www.example.com' });
  });
});

describe('paymentLinkFromColumn', () => {
  it('re-parses a stored link', () => {
    expect(paymentLinkFromColumn('https://monzo.me/sarah')).toEqual({ url: 'https://monzo.me/sarah', host: 'monzo.me' });
  });
  it('answers null for no link and for a value that does not parse', () => {
    expect(paymentLinkFromColumn(null)).toBeNull();
    expect(paymentLinkFromColumn('http://monzo.me/sarah')).toBeNull();
  });
});
```

Note on `paypal.me/anna`: `new URL` throws on it (no scheme), so it is `invalid`. The route maps both `invalid` and `not_https` to messages that tell the teacher to start with `https://` (Task 3).

- [ ] **Step 2: Run, see it fail** — `pnpm exec vitest run --project unit src/lib/payment-link.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement** `src/lib/payment-link.ts`:

```ts
import { PAYMENT_LINK_MAX } from '@/lib/input-bounds';

/**
 * A teacher's open-ended payment link (#785): the rules a stored link
 * satisfies. Client-safe, so the settings form and the server agree.
 */

export type PaymentLinkFailure = 'required' | 'too_long' | 'invalid' | 'not_https';
export type ParsedPaymentLink = { url: string; host: string };

export function parsePaymentLink(
  raw: string,
): ({ ok: true } & ParsedPaymentLink) | { ok: false; error: PaymentLinkFailure } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, error: 'required' };
  if (trimmed.length > PAYMENT_LINK_MAX) return { ok: false, error: 'too_long' };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, error: 'not_https' };
  // Userinfo puts a host-looking word before the real host; the button's
  // host label exists so the student sees where the link goes.
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'invalid' };
  if (url.href.length > PAYMENT_LINK_MAX) return { ok: false, error: 'too_long' };
  return { ok: true, url: url.href, host: url.hostname.replace(/^www\./, '') };
}

export function paymentLinkFromColumn(stored: string | null): ParsedPaymentLink | null {
  if (stored === null) return null;
  const parsed = parsePaymentLink(stored);
  return parsed.ok ? { url: parsed.url, host: parsed.host } : null;
}
```

(`url.href` can be longer than the input after percent-encoding, which is why the bound is checked again; the CHECK bounds the stored value.)

- [ ] **Step 4: Run, see it pass.**

- [ ] **Step 5: Wire schema.** In `src/lib/schemas.ts`, beside `bankAccountSchema`:

```ts
/**
 * `PUT /api/teachers/[id]/payment-link`'s wire shape: the shape only; what
 * makes a link acceptable is `parsePaymentLink`'s to check.
 */
export const paymentLinkSchema = z.object({
  paymentLink: z.string().max(PAYMENT_LINK_MAX * 2),
}).strict();
```

The wire bound is twice the stored bound so that surrounding whitespace never trips the 400's generic message before the parser's own `too_long`. Add a `schemas.test.ts` case: a body with an extra key is refused (strict), and a string of `PAYMENT_LINK_MAX * 2 + 1` is refused. If `src/lib/input-bounds.test.ts` or `schemas.test.ts` has a census requiring every string field to be bounded, satisfy it.

- [ ] **Step 6: Schema + migration.** Add `paymentLink String?` to `model Teacher`. Generate the migration (`--create-only`, see Global Constraints), then append:

```sql
-- A payment link is shown to students as a link: only https, bounded.
-- The full rule (parses as a URL, no userinfo) is the service's.
ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_payment_link_check"
  CHECK ("paymentLink" IS NULL OR ("paymentLink" LIKE 'https://%' AND char_length("paymentLink") <= 500));
```

Apply it. Run `pnpm exec prisma generate`.

- [ ] **Step 7: Integration test for the CHECK** (`tests/integration/payment-link-check.test.ts`). Create a teacher with the project's existing integration helpers (look at `tests/integration/bank-accounts-api.test.ts` for how a teacher is created and cleaned up; clean up by a non-undefined id). Assert:
  - `prisma.teacher.update({ data: { paymentLink: 'http://x.example/' } })` rejects with a message containing `Teacher_payment_link_check`.
  - The same for a `'https://' + 'a'.repeat(500)` value.
  - `'https://x.example/'` succeeds.

  Run: `pnpm run worktree:up` (once), then `pnpm exec vitest run --project integration tests/integration/payment-link-check.test.ts`.

- [ ] **Step 8: Mutation steps** (record the exact failure text for each):
  - (a) Change `url.protocol !== 'https:'` to `false`. Expect the `http://` and `javascript:` cases to fail.
  - (b) Delete the userinfo line. Expect both userinfo cases to fail.
  - (c) Create a throwaway migration that drops the constraint. Rather than editing the applied one, run `ALTER TABLE "Teacher" DROP CONSTRAINT "Teacher_payment_link_check"` against the worktree **test** DB via `psql` in `fairyoga-db-1`. Run Step 7's test and expect it to fail. Restore with the `ADD CONSTRAINT` statement and re-run green.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/<dir> src/lib/input-bounds.ts src/lib/payment-link.ts src/lib/payment-link.test.ts src/lib/schemas.ts src/lib/schemas.test.ts tests/integration/payment-link-check.test.ts
git commit -m "feat: Teacher.paymentLink with an https-only CHECK and its parser (#785)"
```
(plus `src/lib/input-bounds.test.ts` if touched)

---

#### Task 1 amendments from the plan review (binding; they override the steps above where they differ)

- **Wire schema (I-1).** `paymentLinkSchema = z.object({ paymentLink: singleLineCharacters(z.string().trim(), PAYMENT_LINK_MAX * 2).max(PAYMENT_LINK_MAX * 2) }).strict()`. This satisfies the #769 every-leaf census in `src/lib/schemas.test.ts`: bounded, and refusing hidden characters. The trim keeps a pasted trailing newline from being refused. Never add this path to `HIDDEN_CHARACTERS_ALLOWED`. `schemas.test.ts` cases:
  - `'https://revolut.me/anna\n'` is accepted and trimmed.
  - `'https://revolut.me/a‮b'` is refused.
  - An extra key is refused.
  - `PAYMENT_LINK_MAX * 2 + 1` characters are refused.
- **`src/lib/input-bounds.test.ts`** censuses numeric exports by exact equality: add `PAYMENT_LINK_MAX: 500` to its expected object and commit the file.
- **A fifth failure, `has_userinfo`.** The userinfo refusal gets its own failure, so its message can be true. `https://revolut.me@evil.example/` does start with `https://`. `PaymentLinkFailure = 'required' | 'too_long' | 'invalid' | 'not_https' | 'has_userinfo'`. The parser tests' two userinfo cases expect `has_userinfo`.
- **The messages live in `src/lib/payment-link.ts`** (client-safe), so the route and the form share one copy:
  ```ts
  export const PAYMENT_LINK_MESSAGES = {
    required: 'Enter your payment link.',
    too_long: 'That link is too long.',
    invalid: 'Enter the full link, starting with https://',
    not_https: 'Enter the full link, starting with https://',
    has_userinfo: 'Enter the link without a name and @ before the address.',
  } as const satisfies Record<PaymentLinkFailure, string>;
  ```
- **Pin the href-length check.** Add a parser case: `` `https://x.example/${'é'.repeat(200)}` `` (input 218 characters, href over 1,000 after percent-encoding) expects `too_long`. Add mutation (d): delete the `url.href.length` line; this case must fail.
- **CHECK test placement and mutation (I-5).** Put the CHECK test in the **unit** tier as a real-DB file, `src/lib/payment-link-check.test.ts`, following `src/services/class-economics-constraints.test.ts`. The unit project reads the worktree's test DB, so mutation (c) drops the constraint on the **test** DB (`ethical_yoga_test_issue_785`, via `psql` in the `fairyoga-db-1` container), runs that test, records the failure, and re-adds the constraint. There is no throwaway migration, and no `tests/integration/payment-link-check.test.ts`. Make sure the migration is applied to both the dev and test DBs; check how `worktree:setup`/`pnpm test` migrates the test DB.
- **Migration comment.** One line, about its own SQL only: `-- A payment link is shown to students as a link: only https, bounded.`

### Task 2: The `payment_link` method, every consumer, the pay-page panel

Order matters: this task depends on Task 1's `paymentLinkFromColumn` and column.

**Files:**
- Modify: `src/lib/payment-methods.ts`, `src/lib/payment-methods.test.ts`
- Modify (call sites; re-derive with `grep -rn "paymentMethodsFor(" src | grep -v "\.test\." | grep -v "export function"`):
  - `src/app/(student)/bookings/[classId]/pay/page.tsx`
  - `src/app/(student)/bookings/page.tsx`
  - `src/services/class-lifecycle.ts`
  - `src/services/email-fallback.ts`
  - `src/services/payment-reminders.ts`
  - `src/services/payments.ts`
  - each one's query select, and test fixtures that build those selects' results (the compiler names them)
- Create: `src/components/student/copy-field-list.tsx`, which holds the copy-row list and status line extracted from `payment-details.tsx`. `PaymentDetails` renders it, and `payment-details.test.tsx` must pass unedited.
- Create: `src/components/student/payment-link-panel.tsx`, `src/components/student/payment-link-panel.test.tsx`
- Modify: `tests/integration/pay-page.test.ts`, `tests/integration/bookings-page.test.ts`
- Modify: one service unit test, `src/services/email-fallback.test.ts` (or `payment-reminders.test.ts`): a link-only teacher counts as having methods.
- Modify: `prisma/seed.ts`: give Sarah (GBP) `paymentLink: 'https://monzo.me/sarahmitchell'`.

**Interfaces:**
- Consumes: `paymentLinkFromColumn` (Task 1).
- Produces:
```ts
export type PaymentMethod =
  | { kind: 'bank_transfer'; beneficiary: string; details: BankDetails }
  | { kind: 'epc_qr'; beneficiary: string; iban: string; bic: string | null; currency: typeof EPC_QR_CURRENCY }
  | { kind: 'payment_link'; url: string; host: string };
PAYMENT_METHOD_COPY.payment_link = { label: 'Payment link', hint: 'Pay in the app the link opens' };
export type PaymentSources = { teacherId: string; account: StoredBankAccount | null; paymentLink: string | null };
export function paymentMethodsFor(sources: PaymentSources): PaymentMethod[];
export const teacherPaymentSelect = { id: true, paymentLink: true, bankAccounts: { select: bankAccountSelect } } as const satisfies Prisma.TeacherSelect;
export type TeacherPaymentSources = { id: string; paymentLink: string | null; bankAccounts: StoredBankAccount[] };
export function paymentMethodsForTeacher(teacher: TeacherPaymentSources, currency: Currency): PaymentMethod[];
/** Onboarding's `bank` step: an account in the current currency, or a link. */
export function hasPayoutDetails(teacher: { currency: Currency; paymentLink: string | null; bankAccounts: readonly { currency: Currency }[] }): boolean;
```
`hasPayoutDetails` is produced here and consumed in Task 3. Put it in this task with its unit tests so that `payment-methods.ts` changes in one place.

- [ ] **Step 1: Failing unit tests** in `src/lib/payment-methods.test.ts`. Extend the file's existing fixtures for a stored SEPA EUR account, a UK GBP account and an unparseable account. Cases:
  - Link only (`account: null`): `[{ kind: 'payment_link', url, host }]`.
  - EUR SEPA account plus link: kinds in order `['bank_transfer', 'epc_qr', 'payment_link']`.
  - GBP account plus link: `['bank_transfer', 'payment_link']`.
  - Unparseable account plus link: `[payment_link]`, and the existing account error is logged.
  - Account plus a stored link that does not parse (`'http://x'`): bank methods only, with `log.error` called with `{ teacherId }` and a message naming the payment link. Mock `@/lib/log` the way the file already does.
  - Neither: `[]`.
  - `paymentMethodsForTeacher` picks the account in the given currency and includes the link.
  - `hasPayoutDetails`: true for an account in the current currency, true for a link alone, false for an account only in another currency with no link, and false for neither.

- [ ] **Step 2: Run, see it fail** (compile errors count as failing).

- [ ] **Step 3: Implement** in `payment-methods.ts`:
  - Add the union member and its copy entry.
  - Change `paymentMethodsFor` to take `PaymentSources`. Compute the bank methods as today, but return them into a local, not early. On an unparseable account, still log with `teacherId`, `accountId` and `currency`, then continue with no bank methods.
  - Append the link when `paymentLinkFromColumn(paymentLink)` is non-null. When `paymentLink !== null` but it does not parse, call `log.error({ teacherId }, 'stored payment link does not parse; offering no link')`.
  - Add `teacherPaymentSelect`, `paymentMethodsForTeacher` (which calls `paymentMethodsFor({ teacherId: teacher.id, account: accountInCurrency(teacher.bankAccounts, currency), paymentLink: teacher.paymentLink })`) and `hasPayoutDetails`.
  - Update the docblock of `paymentMethodsFor` to describe the link (no counts).

- [ ] **Step 4: Move every call site** to `paymentMethodsForTeacher(teacher, cls.currency)`. Replace each site's `bankAccounts: { select: bankAccountSelect }` with `...teacherPaymentSelect` inside its teacher `select`, or with `select: teacherPaymentSelect` where the teacher is only read for payment. Keep the pay page's comment about picking the currency's account below. Run `pnpm run typecheck`. Every remaining error is a site or fixture still missing `id` or `paymentLink`; fix each.

- [ ] **Step 5: Extract `CopyFieldList`.** Move `Field`, `CopyState`, the `copy` function, the `<dl>` and the status `<p>` from `payment-details.tsx` into `copy-field-list.tsx`:

```ts
export type CopyField = { key: string; label: string; shown: string; copied: string };
export function CopyFieldList({ fields }: { fields: ReadonlyArray<CopyField> }): JSX.Element;
```
  `PaymentDetails` builds its fields and returns `<CopyFieldList fields={fields} />`. Keep the console prefixes as they are, since `payment-details.test.tsx` may assert them. Run `pnpm exec vitest run --project components src/components/student/payment-details.test.tsx` and confirm it is green and unedited.

- [ ] **Step 6: Failing panel test** (`payment-link-panel.test.tsx`):

```tsx
render(<PaymentLinkPanel url="https://revolut.me/anna" host="revolut.me" amount={12.5} currency="EUR" reference="Hatha Tue 7 Oct" />);
const link = screen.getByRole('link', { name: 'Pay via revolut.me' });
expect(link).toHaveAttribute('href', 'https://revolut.me/anna');
expect(link).toHaveAttribute('target', '_blank');
expect(link).toHaveAttribute('rel', 'noopener noreferrer');
expect(screen.getByRole('button', { name: 'Copy amount' })).toBeInTheDocument();
expect(screen.getByRole('button', { name: 'Copy reference' })).toBeInTheDocument();
```
Also assert that the amount is shown formatted (`formatMoney(12.5, 'EUR')`) and that copying the amount copies the bare decimal `12.50` with no currency symbol, mocking `navigator.clipboard` the way `payment-details.test.tsx` does.

- [ ] **Step 7: Implement `PaymentLinkPanel`** (`'use client'`):
  - A body line: `Pay <span class="type-number">{formatMoney(amount, currency)}</span> through the link, with this reference:`.
  - `<CopyFieldList fields={[{ key: 'amount', label: 'Amount', shown: formatMoney(amount, currency), copied: amount.toFixed(2) }, { key: 'reference', label: 'Reference', shown: reference, copied: reference }]} />`.
  - The anchor is styled as the project's primary button. Look in `src/components/ui/button.tsx` for an exported class helper for a link styled as a button. If none exists, copy the primary variant's classes and do not add a new UI primitive. Its text is `Pay via {host}`, and it carries `target="_blank" rel="noopener noreferrer"`.
  - A caption: `Your teacher marks it as received once it arrives.`

- [ ] **Step 8: Pay page.** Add `case 'payment_link': return <PaymentLinkPanel url={method.url} host={method.host} amount={amount} currency={currency} reference={reference} />;` to `MethodPanel`.

- [ ] **Step 9: Integration.**
  - `tests/integration/pay-page.test.ts`: a teacher with `paymentLink` and no bank account. The page HTML contains `Payment link`, `href="https://…"` and `Pay via `, and does not contain the "Pay {name} directly" fallback.
  - The same teacher with an EUR account: the HTML contains `Bank transfer`, `QR code` and `Payment link`, in that order (compare `indexOf`).
  - `tests/integration/bookings-page.test.ts`: a link-only teacher's outstanding payment shows the Pay-now link, not the "Pay {first} directly" caption.
  - Follow each file's existing fixture style.
- Service unit test: in `email-fallback.test.ts` (whichever of the four services' tests already builds the teacher fixture most simply), a link-only teacher yields `teacherHasPaymentMethods: true`.

- [ ] **Step 10: Mutation.** In `paymentMethodsFor`, skip appending the link. Expect the link-only unit test, the pay-page integration test and the bookings test to fail; record the text. Restore.

- [ ] **Step 11:** `pnpm run typecheck && pnpm run lint`, then the touched unit, component and integration files. Commit:

```bash
git add src/lib/payment-methods.ts src/lib/payment-methods.test.ts "src/app/(student)/bookings/[classId]/pay/page.tsx" "src/app/(student)/bookings/page.tsx" src/services/class-lifecycle.ts src/services/email-fallback.ts src/services/payment-reminders.ts src/services/payments.ts src/components/student/copy-field-list.tsx src/components/student/payment-details.tsx src/components/student/payment-link-panel.tsx src/components/student/payment-link-panel.test.tsx tests/integration/pay-page.test.ts tests/integration/bookings-page.test.ts prisma/seed.ts <each touched test fixture by path>
git commit -m "feat: a teacher's payment link is a pay method beside transfer and QR, at every call site (#785)"
```

---

#### Task 2 amendments from the plan review (binding; they override the steps above where they differ)

- **`hasPayoutDetails`** returns `hasAccountInCurrency(teacher.bankAccounts, teacher.currency) || paymentLinkFromColumn(teacher.paymentLink) !== null`. A stored but unparseable link then counts as no link, consistent with `paymentMethodsFor`. Add a unit case for it.
- **`TeacherPaymentSources`** is derived, not hand-written: `Prisma.TeacherGetPayload<{ select: typeof teacherPaymentSelect }>`.
- **`CopyFieldList`** has no `JSX.Element` return annotation; React 19 types have no global `JSX`. Omit it. The moved `copy` keeps its `[payment-details]` console prefix, because `payment-details.test.tsx` pins it.
- **The link anchor** copies `Button`'s base classes, including the focus ring (`focus-visible:shadow-focus`) and `min-h-12`, as well as the primary variant's. Precedent for a button-styled link: `src/components/signup/already-teaching-panel.tsx`. The host text wraps with `break-all` and is never ellipsised, because the host is the point of the label.

### Task 3: Saving and removing the link; onboarding; GDPR

**Files:**
- Create: `src/services/payment-link.ts`, `src/services/payment-link.test.ts`
- Create: `src/app/api/teachers/[id]/payment-link/route.ts`
- Create: `tests/integration/payment-link-api.test.ts`
- Modify: `src/lib/onboarding.ts`, `src/lib/onboarding.test.ts`, `src/components/schedule/getting-started.test.tsx` (if it builds a `StepInput`)
- Modify: `src/app/api/account/onboarding/route.ts`, `src/app/(teacher)/schedule/(overview)/page.tsx`
- Modify: `src/services/gdpr.ts`, `src/services/gdpr.test.ts`
- Possibly modify: a route-census test pinning every API write handler to `withErrorHandler` (#770), and the CSRF/proxy test lists. Run the whole unit suite once to find any census that now names the new route.

**Interfaces:**
- Consumes: `parsePaymentLink`, `PaymentLinkFailure`, `paymentLinkSchema` (Task 1); `hasPayoutDetails` (Task 2).
- Produces:
```ts
export type SavePaymentLinkOutcome =
  | { kind: 'saved'; paymentLink: string }
  | { kind: 'unchanged'; paymentLink: string }
  | { kind: 'invalid'; error: PaymentLinkFailure }
  | { kind: 'teacher_gone' };
export type RemovePaymentLinkOutcome = { kind: 'removed' } | { kind: 'absent' } | { kind: 'teacher_gone' };
export function savePaymentLink(db: PrismaClient, teacherId: string, raw: string): Promise<SavePaymentLinkOutcome>;
export function removePaymentLink(db: PrismaClient, teacherId: string): Promise<RemovePaymentLinkOutcome>;
```

- [ ] **Step 1: Failing integration test** (`tests/integration/payment-link-api.test.ts`), modelled on `tests/integration/bank-accounts-api.test.ts` (auth helpers, `freshIp()`, cleanup). Cases:
  - PUT with a valid link → 200, body `{ paymentLink: 'https://revolut.me/anna' }`, DB row updated.
  - The same PUT again → the `respondUnchanged` shape (read `src/lib/api-utils.ts` for how unchanged is signalled and assert that).
  - PUT `http://…`, PUT `paypal.me/anna` and PUT `https://revolut.me@evil.example/` → each 400, message `paymentLink: Enter the full link, starting with https://`.
  - PUT blank → 400, `paymentLink: Enter your payment link.`
  - PUT with an extra key → 400 (strict schema).
  - Another teacher's id → 403. No session → 401 (whatever `requireTeacher` answers).
  - DELETE with a link → 200 `{ paymentLink: null }`, column null. DELETE again → unchanged.
  - Erased teacher (set `deletedAt` directly) → PUT and DELETE 404.

- [ ] **Step 2: Run, see it fail** (404 — route missing).

- [ ] **Step 3: Service** `src/services/payment-link.ts`:

```ts
/**
 * A teacher's payment link (#785), saved and removed. Framework-agnostic.
 * Each write is scoped to the live row, as `updateTeacherProfile` is: under
 * READ COMMITTED a write that waited out an erasure re-checks `deletedAt`
 * and matches nothing, so it never lands on the anonymised row.
 */
export async function savePaymentLink(db, teacherId, raw) {
  const parsed = parsePaymentLink(raw);
  if (!parsed.ok) return { kind: 'invalid', error: parsed.error };
  const current = await db.teacher.findFirst({ where: { id: teacherId, deletedAt: null }, select: { paymentLink: true } });
  if (current === null) return { kind: 'teacher_gone' };
  if (current.paymentLink === parsed.url) return { kind: 'unchanged', paymentLink: parsed.url };
  const { count } = await db.teacher.updateMany({ where: { id: teacherId, deletedAt: null }, data: { paymentLink: parsed.url } });
  return count === 0 ? { kind: 'teacher_gone' } : { kind: 'saved', paymentLink: parsed.url };
}
export async function removePaymentLink(db, teacherId) {
  const current = await db.teacher.findFirst({ where: { id: teacherId, deletedAt: null }, select: { paymentLink: true } });
  if (current === null) return { kind: 'teacher_gone' };
  if (current.paymentLink === null) return { kind: 'absent' };
  const { count } = await db.teacher.updateMany({ where: { id: teacherId, deletedAt: null }, data: { paymentLink: null } });
  return count === 0 ? { kind: 'teacher_gone' } : { kind: 'removed' };
}
```
(Typed fully in the real file.) `src/services/payment-link.test.ts` unit-tests the outcomes with a mocked `db` in the style of `src/services/bank-accounts.test.ts`, including that `updateMany` is scoped by `deletedAt: null`.

- [ ] **Step 4: Route** `src/app/api/teachers/[id]/payment-link/route.ts`, mirroring `bank-accounts/[currency]/route.ts`. Structure:
  - `authorise` checks the session teacher equals `id`, else 403.
  - `PUT` runs `parseBody(request, paymentLinkSchema)`, then `savePaymentLink`, then an exhaustive `switch` with a `never` default.
  - `saved` → `respondOk({ paymentLink })`, `unchanged` → `respondUnchanged({ paymentLink })`.
  - `invalid` → `respondError(formatIssues([{ path: ['paymentLink'], message: INVALID_MESSAGES[error] }]), 400)`.
  - `teacher_gone` → `log.info` plus 404 `Teacher not found`.
  - Both handlers are wrapped in `withErrorHandler`.

```ts
const INVALID_MESSAGES = {
  required: 'Enter your payment link.',
  too_long: 'That link is too long.',
  invalid: 'Enter the full link, starting with https://',
  not_https: 'Enter the full link, starting with https://',
} as const satisfies Record<PaymentLinkFailure, string>;
```
  - `DELETE` → `removePaymentLink`: `removed` → `respondOk({ paymentLink: null })`, `absent` → `respondUnchanged({ paymentLink: null })`, `teacher_gone` → 404.

- [ ] **Step 5: Run Step 1 green.** Then run the whole unit project once (`pnpm exec vitest run --project unit`) and satisfy any route census (e.g. the #770 `withErrorHandler` pin) that names the new handlers.

- [ ] **Step 6: Onboarding (test first).**
  - In `src/lib/onboarding.test.ts`, rename the input field to `payoutDetailsSet`. Add a case where `payoutDetailsSet: true` alone makes `bank` `done`.
  - In `onboarding.ts`, rename the `StepInput` field `bankAccountInCurrentCurrency` to `payoutDetailsSet`, with the docblock "Whether the teacher has a bank account in their current currency or a payment link." Change the `bank` copy to label `Add how students pay you` and detail `Bank details or a payment link — skip if you take cash`.
  - Update every assertion of the old copy. Grep `Add your bank details` across `src` and `tests`, including e2e.
  - In both computing sites, select `paymentLink: true` beside `bankAccounts: { select: { currency: true } }`, and compute `payoutDetailsSet: hasPayoutDetails(teacher)`. Then `grep -rn "bankAccountInCurrentCurrency" src tests` must print nothing.
  - Mutation: make `hasPayoutDetails` ignore `paymentLink`. The Task 2 unit test for the link alone fails; record it and restore.

- [ ] **Step 7: GDPR (test first).** In `gdpr.test.ts`, extend the existing export and erasure tests: the export's `profile.paymentLink` equals the stored link, and the erasure's teacher `updateMany` data contains `paymentLink: null`. Match how the file asserts `processorAccountId`. Implement:
  - Add `paymentLink: teacher.paymentLink` to the export's `profile`, and add it to the export query's select if that is an explicit select.
  - Add `paymentLink: null` to the scrub beside `processorAccountId: null`.
  - Mutation: remove the scrub line. The erasure test fails; record it and restore.
  - If an integration erasure test exists (`grep -rln "deleteTeacherAccount" tests/integration`), add `paymentLink` to its set-then-erase assertions too.

- [ ] **Step 8:** typecheck, lint, the touched tests. Commit by exact paths:
`feat: save and remove a teacher's payment link; it completes onboarding's bank step and is exported and erased (#785)`

---

#### Task 3 amendments from the plan review (binding; they override the steps above where they differ)

- **There is no erased-teacher 404 over HTTP.** `validateSession` (`src/lib/auth/session.ts`) drops erased teachers, so such a request gets 401 or 403. Drop that integration bullet. Optionally assert the 401/403 that does happen.
- **`src/services/payment-link.test.ts` is a real-DB unit test** in the style of `src/services/bank-accounts.test.ts` (`new PrismaClient()`, real teachers, cleanup by a non-undefined id). Do not mock the db. Cases:
  - `saved`, `unchanged`, `invalid`.
  - `teacher_gone` for each verb after setting `deletedAt` (the column must stay unchanged).
  - **A race test per verb.** On a second connection, open a transaction, `SELECT … FROM "Teacher" WHERE id = $1 FOR NO KEY UPDATE`, then `UPDATE "Teacher" SET "deletedAt" = now() WHERE id = $1`. Start the service call, which blocks; commit the second connection. Assert `teacher_gone` and that `paymentLink` is unchanged. For remove, set a link beforehand.
  - **Mutation:** drop `deletedAt: null` from the `updateMany`. The race test must fail; record the exact text and restore.
  - Look at an existing race test for the two-connection pattern (`grep -rln "FOR NO KEY UPDATE" src/**/*.test.ts tests`).
- **Messages.** `INVALID_MESSAGES` moves to `src/lib/payment-link.ts` as the exported `PAYMENT_LINK_MESSAGES` (Task 1 amendment), and the route imports it. The integration assertions compare against it: `` `paymentLink: ${PAYMENT_LINK_MESSAGES.not_https}` `` and so on, never a literal. Use `expectUnchanged`/`expectApplied` from `tests/api-assertions.ts` for the 200 shapes.
- **Route mechanics:**
  - `formatIssues` comes from `@/lib/validation-message`.
  - `respondUnchanged` needs an explicit type argument: `respondUnchanged<{ paymentLink: string }>(…)` and `respondUnchanged<{ paymentLink: null }>(…)`.
  - For the applied answers use `respondTyped<…>` if `api-utils.ts`'s `respondOk` docblock steers new literals there. Follow what the docblock says.
- **Service docblock.** Link `docs/lock-order.md` ("The `Teacher` row is the first lock (#758)") rather than describing `updateTeacherProfile`, per Comment Discipline.
- **Onboarding copy sweep.** Grep case-insensitively for `skip if you take cash`, `Students see them` and `add your bank` across `src` and `tests`. `src/components/schedule/getting-started.test.tsx`'s negative assertions on the old label and detail would otherwise go vacuous. Rewrite them against the new copy, preferably reading the label and detail from `resolveSteps(...)` rather than literals. Also update `src/services/bank-accounts.test.ts`, which uses `bankAccountInCurrentCurrency`.
- **`hasPayoutDetails`** (Task 2) uses `paymentLinkFromColumn(teacher.paymentLink) !== null`. Task 2 owns it; Task 3 only consumes it.
- **Visual baseline.** This task edits `src/app/(teacher)/schedule/(overview)/page.tsx`, a visually baselined route (`src/lib/visual-baseline-freshness.ts`). The copy change moves `schedule.png`. After Step 6:
  - Run the check (`pnpm exec tsx scripts/check-visual-baseline-freshness.ts` or whatever `package.json` names) and the regenerate command it prints. This machine is macOS.
  - Inspect the image diff: only the bank row's label and detail should move.
  - Commit the PNG with this task. If regeneration is impossible here, report BLOCKED with the exact output; do not attest.
- **GDPR test.** `gdpr.test.ts` is real-DB. Give the fixture teacher a `paymentLink`, then after `deleteTeacherAccount` assert `teacher.paymentLink` is `null`, beside the existing `firstName`/`pageSlug` checks. For export, assert `profile.paymentLink` equals the stored value.

### Task 4: Settings form, profile page, docs

**Files:**
- Create: `src/components/settings/payment-link-form.tsx`, `src/components/settings/payment-link-form.test.tsx`
- Modify: `src/app/(teacher)/settings/profile/page.tsx`, `src/app/(teacher)/settings/profile/page.test.tsx`
- Modify: `docs/data-model.md` (Teacher table: a `paymentLink` row; the `TeacherBankAccount` section's methods line, which says when a link is offered; the GDPR/erasure mention if the section lists erased columns)
- Modify: `docs/product-concept.md` (the Level 1 "Tikkie, cash, or any other method" line names the link as how a teacher offers one)
- Modify: `CLAUDE.md` (Payment Model, Level 1: one clause, "or through an open-ended payment link the teacher adds (`Teacher.paymentLink`), shown beside the bank methods")
- Modify: `docs/superpowers/specs/2026-10-08-payment-link-design.md` only if the build changed a decision; say so in the report

**Interfaces — Consumes:** `PUT`/`DELETE /api/teachers/[id]/payment-link` (Task 3), `parsePaymentLink`, `PAYMENT_LINK_MAX` (Task 1).

- [ ] **Step 1: Failing form tests**, in the style of `bank-account-form.test.tsx` (its fetch mock and `router.refresh` mock). Cases:
  - It renders the label `Payment link`, the input carrying `initial`, and the hint text.
  - Save PUTs `{ paymentLink }` to `/api/teachers/t1/payment-link` and calls `router.refresh()` on 200.
  - A 400 shows the message after `paymentLink: ` on the field.
  - A client-side `http://` value shows `Enter the full link, starting with https://` without fetching, using `parsePaymentLink`.
  - Remove appears only when `hasLink` is true, sends DELETE, and refreshes.
  - The input has `maxLength={PAYMENT_LINK_MAX}`, `type="url"`, `inputMode="url"` and `autoComplete="off"`.

- [ ] **Step 2: Run, see it fail.**

- [ ] **Step 3: Implement** `PaymentLinkForm({ teacherId, initial, hasLink })` following `BankAccountForm`'s structure:
  - Section heading `Payment link`, in the same heading style as the bank block's.
  - One `Input`, Save `Button`, and a Remove control styled as the bank block's remove.
  - Status and error handling via `readError` and `logRequestFailure`.
  - Hint: `A Tikkie, PayPal.me, Revolut or similar link without a fixed amount. Students see it next to what they owe.`
  - No new tokens, no shadows, no motion (Design Philosophy).

- [ ] **Step 4: Profile page.** Render `<PaymentLinkForm teacherId={teacher.id} initial={teacher.paymentLink ?? ''} hasLink={teacher.paymentLink !== null} />` directly after `BankAccountForm`. Extend `page.test.tsx` to assert the form receives the stored link.

- [ ] **Step 5: Run the form and page tests green.** Then run `pnpm run verify` (needs the worktree app up) and report its summary line with the per-project arithmetic.

- [ ] **Step 6: Docs**, as listed under Files. Keep docs claims about what is true now. Name types rather than listing members.

- [ ] **Step 7: Commit** by exact paths, quoting the `(teacher)` path:
`feat: the payment link is edited on the profile settings page; docs name it as a Level 1 method (#785)`

---

#### Task 4 amendments from the plan review (binding; they override the steps above where they differ)

- **No `maxLength` on the input.** Browsers silently truncate a pasted link at `maxLength`, producing a different but valid URL. Leave the bound to the parser: a pasted 520-character link shows `PAYMENT_LINK_MESSAGES.too_long` and does not fetch. Pin that with a form test.
- **`type="url"`, `inputMode="url"` and `autoComplete="off"`, plus `noValidate` on the `<form>`.** Without `noValidate`, the browser's own bubble pre-empts the app's message for `paypal.me/anna` (precedent: `src/components/student/contact-details-form.tsx`). Client-side refusals show `PAYMENT_LINK_MESSAGES[error]`, imported from `@/lib/payment-link`, not a literal.
- **`page.test.tsx`.** Mock `@/components/settings/payment-link-form` the way `BankAccountForm` is mocked there. Add `paymentLink: null` to the existing fixtures, and assert both `hasLink: false` with `initial: ''`, and `hasLink: true` with the stored link.
- **`docs/lock-order.md`.** In the "The `Teacher` row is the first lock (#758)" section, add one bullet beside `updateTeacherProfile` for `savePaymentLink`/`removePaymentLink` (`src/services/payment-link.ts`). It takes no explicit lock. Its erasure safety is the live-row `deletedAt` scope on the `updateMany`, and `src/services/payment-link.test.ts`'s race test pins it.
- **The spec's security note.** Add a line to `docs/superpowers/specs/2026-10-08-payment-link-design.md`: changing the link, like the bank PUT, does not `requireRecentAuth`; #786 is the tracked mitigation.
- `pnpm run verify` needs Task 3's regenerated `schedule` baseline committed; if the freshness check still fails, report it rather than attesting.

## Self-review notes

- Spec coverage. Data/CHECK → T1. Parser → T1. Union, copy, signature and six sites → T2. Pay panel → T2. Route and service → T3. Onboarding → T3 (the helper is in T2). GDPR → T3. UI → T4. Docs → T4. Seed → T2. #786 comment → the controller, after merge.
- `invalid` and `not_https` share one route message on purpose: a scheme-less paste, an `http:` link and a userinfo link all get "Enter the full link, starting with https://".
