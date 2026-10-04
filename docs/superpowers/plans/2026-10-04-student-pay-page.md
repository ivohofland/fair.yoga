# Student Pay Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An outstanding past class gets its own page, `/bookings/[classId]/pay`, where the student chooses a payment method and gets that method's details; `/bookings` links to it, payment notifications link to it, and a teacher's IBAN now requires its exact holder name.

**Architecture:** A pure module, `src/lib/payment-methods.ts`, turns a teacher's bank fields into a typed `PaymentMethod[]` — empty unless both IBAN and holder name are non-blank. The pay page is a server component keyed by `(classId, session.studentId)`, rendering one exclusive `<details name="pay-method">` row per method. The same list gates `/bookings`, the onboarding `bank` step, and (through a merged-row check) the teacher PUT route.

**Tech Stack:** Next.js 16 App Router (server components), TypeScript strict, Prisma, Zod 4, Vitest (unit / components / integration projects), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-10-04-student-pay-page-design.md`

## Global Constraints

- **Node 24 for every command.** The agent shell defaults to Node 22. Prefix each command block with
  `export PATH="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | grep ^v24 | tail -1)/bin:/usr/sbin:$PATH"`.
- **Integration tests run against the dev server on :3000 from this checkout.** If a page answers stale code or Prisma errors, restart the dev server (memory: local dev quirks).
- **TypeScript `strict: true`. No `any`, no `as` widening casts.**
- **Asserted copy is one text node.** React SSR puts `<!-- -->` between adjacent JSX text pieces, so any string a test matches in HTML is built as one template literal: `{`Pay ${firstName} directly`}`, never `Pay {firstName} directly`.
- **Apostrophes in asserted copy are typographic (`’`).** React escapes `'` as `&#x27;` in HTML.
- **Compact pill recipe, verbatim:** `h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint`.
- **Payment state is text, never a badge.** Use `paymentStateText` from `src/lib/format.ts`.
- **Copy strings (exact):**
  - Pay link label and email button: `Pay now`
  - Row and pay-page fallback: `Pay ${firstName} directly` (row) / `Pay ${firstName} directly — cash or transfer, whatever you two agreed. They’ll mark it as received.` (page)
  - Chooser heading: `How would you like to pay?`
  - Method labels and hints: `Bank transfer` / `Copy the details into your banking app`; `QR code` / `For a banking app on another device`
  - Not charged body: `${firstName} isn’t charging for this class.`
  - Holder-name refusal: `Add the account holder name exactly as your bank shows it.`
  - Profile hint: `Exactly as your bank shows it — your students’ banks check this name.`
- **A 400 validation refusal is asserted by status and an unchanged row, never by message text.**
- **Comments annotate the code they sit on** (CLAUDE.md, Comment Discipline): no counts, no rosters of other modules, no history.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Rebase-merge workflow: one commit per task, never squash.

## Review Focus

1. **A teacher whose row predates the holder-name rule (IBAN, no name) saves an unrelated field** — e.g. their bio. Expect 200: the merged check runs only when the body touches a bank field, or every legacy teacher is locked out of their own settings. Pinned in Task 4.
2. **A malformed `classId` in the URL** (`/bookings/not-a-uuid/pay`). Expect 404, not 500. `Class.id` is a text column so the lookup just misses, but nothing else would notice a regression. Pinned in Task 6.
3. **An account that is both teacher and student opens its own pay page.** Expect 200: the student layout lets it through on `studentId`, and a guard that checked `teacherId` first would bounce it to `/schedule`. Pinned in Task 6.
4. **A teacher-audience `payment_request` email with a `relatedClassId`.** Expect no Pay now button: the pay page is a student route, and teachers receive `payment_request` too. Pinned in Task 5.
5. **A holder name stored with surrounding whitespace.** Expect the copied and QR-encoded beneficiary to be trimmed, since a padded name is what Verification of Payee compares. Pinned in Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/components/student/payment-details.tsx` (+ `.test.tsx`) | Copyable Name / IBAN / Reference rows (already written on this branch) | 1 |
| `src/components/student/payment-breakdown.tsx` | Summary restyled to quiet caption (already written) | 1 |
| `src/lib/payment-methods.ts` (+ `.test.ts`) | `PaymentMethod` union, `PAYMENT_METHOD_COPY`, `nonBlank`, `paymentMethodsFor` | 2 |
| `src/lib/onboarding.ts` (+ tests, callers) | `bank` step done ⇔ `paymentMethodsFor` non-empty | 3 |
| `src/lib/schemas.ts`, `src/app/api/teachers/[id]/route.ts`, `src/components/settings/profile-form.tsx` | Blank→null, holder-name rule, hint | 4 |
| `src/lib/notification-links.ts`, `src/lib/email-templates.ts` (+ tests) | `payPagePath`, `isPaymentNotification`, inbox href, email button | 5 |
| `src/app/(student)/bookings/[classId]/pay/page.tsx`, `tests/integration/pay-page.test.ts` | The pay page | 6 |
| `src/app/(student)/bookings/page.tsx`, `tests/integration/bookings-page.test.ts` | Row links to the pay page; inline panel removed | 7 |

---

### Task 1: Land the carried-over copy component

The branch holds uncommitted work from before the spec. `PaymentDetails` and the quieter breakdown summary carry over unchanged; the inline-panel edits to `/bookings` and its tests are superseded by Task 7 and are discarded here so every commit leaves a working tree.

**Files:**
- Commit as-is: `src/components/student/payment-details.tsx`, `src/components/student/payment-details.test.tsx`, `src/components/student/payment-breakdown.tsx`
- Restore to HEAD: `src/app/(student)/bookings/page.tsx`, `tests/integration/bookings-page.test.ts`

**Interfaces:**
- Produces: `PaymentDetails({ iban: string; beneficiary: string; reference: string })` — a `'use client'` component. Copies the IBAN with whitespace removed.

- [ ] **Step 1: Confirm the working tree is exactly the expected five files**

Run: `git status --short`
Expected:
```
 M src/app/(student)/bookings/page.tsx
 M src/components/student/payment-breakdown.tsx
 M tests/integration/bookings-page.test.ts
?? src/components/student/payment-details.test.tsx
?? src/components/student/payment-details.tsx
```
If anything else appears, stop and report — do not restore over unknown edits.

- [ ] **Step 2: Discard the superseded inline-panel edits**

```bash
git restore "src/app/(student)/bookings/page.tsx" tests/integration/bookings-page.test.ts
```

- [ ] **Step 3: Run the component tests**

Run: `pnpm exec vitest run --project components src/components/student/payment-details.test.tsx src/components/student/payment-breakdown.test.tsx`
Expected: PASS, 10 tests.

- [ ] **Step 4: Lint and commit**

```bash
pnpm exec eslint src/components/student/payment-details.tsx src/components/student/payment-details.test.tsx src/components/student/payment-breakdown.tsx
git add src/components/student/payment-details.tsx src/components/student/payment-details.test.tsx src/components/student/payment-breakdown.tsx
git commit -m "feat: copyable payment details; quieter breakdown summary

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The payment-method model

**Files:**
- Create: `src/lib/payment-methods.ts`
- Test: `src/lib/payment-methods.test.ts`

**Interfaces:**
- Produces:
  - `type PaymentMethod = { kind: 'bank_transfer'; iban: string; beneficiary: string } | { kind: 'epc_qr'; iban: string; beneficiary: string }`
  - `type PaymentMethodKind = PaymentMethod['kind']`
  - `const PAYMENT_METHOD_COPY: Record<PaymentMethodKind, { label: string; hint: string }>` (declared `as const satisfies …`)
  - `function nonBlank(value: string | null | undefined): string | null` — trimmed value, or `null` when nothing is left
  - `function paymentMethodsFor(teacher: { bankIban: string | null; bankAccountName: string | null }): PaymentMethod[]`
- Must stay client-safe (no server imports): `src/lib/onboarding.ts`, imported by a `'use client'` component, will import it in Task 3.

- [ ] **Step 1: Write the failing tests**

`src/lib/payment-methods.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PAYMENT_METHOD_COPY, nonBlank, paymentMethodsFor } from './payment-methods';

const IBAN = 'NL91ABNA0417164300';

describe('nonBlank', () => {
  it('trims a value', () => {
    expect(nonBlank('  I. Hofland ')).toBe('I. Hofland');
  });

  it('answers null for null, undefined, empty and whitespace-only', () => {
    expect(nonBlank(null)).toBeNull();
    expect(nonBlank(undefined)).toBeNull();
    expect(nonBlank('')).toBeNull();
    expect(nonBlank(' \t ')).toBeNull();
  });
});

describe('paymentMethodsFor', () => {
  it('offers a bank transfer then a QR code when the IBAN and its holder name are both set', () => {
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: 'I. Hofland' })).toEqual([
      { kind: 'bank_transfer', iban: IBAN, beneficiary: 'I. Hofland' },
      { kind: 'epc_qr', iban: IBAN, beneficiary: 'I. Hofland' },
    ]);
  });

  it('offers nothing without an IBAN', () => {
    expect(paymentMethodsFor({ bankIban: null, bankAccountName: 'I. Hofland' })).toEqual([]);
    expect(paymentMethodsFor({ bankIban: '', bankAccountName: 'I. Hofland' })).toEqual([]);
    expect(paymentMethodsFor({ bankIban: '   ', bankAccountName: 'I. Hofland' })).toEqual([]);
  });

  // Verification of Payee: a student's bank checks the name against the IBAN,
  // so a missing holder name is never stood in for by anything else.
  it('offers nothing with an IBAN but no holder name', () => {
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: null })).toEqual([]);
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: '' })).toEqual([]);
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: '  ' })).toEqual([]);
  });

  // Review Focus 5: the padded name is the one a bank would compare.
  it('trims the IBAN and the holder name it hands out', () => {
    const [transfer] = paymentMethodsFor({ bankIban: ` ${IBAN} `, bankAccountName: '  I. Hofland  ' });
    expect(transfer).toEqual({ kind: 'bank_transfer', iban: IBAN, beneficiary: 'I. Hofland' });
  });
});

describe('PAYMENT_METHOD_COPY', () => {
  it('names each method the way the chooser shows it', () => {
    expect(PAYMENT_METHOD_COPY.bank_transfer).toEqual({
      label: 'Bank transfer',
      hint: 'Copy the details into your banking app',
    });
    expect(PAYMENT_METHOD_COPY.epc_qr).toEqual({
      label: 'QR code',
      hint: 'For a banking app on another device',
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/payment-methods.test.ts`
Expected: FAIL — `Failed to resolve import "./payment-methods"`.

- [ ] **Step 3: Implement**

`src/lib/payment-methods.ts`:

```ts
/**
 * How a student can pay a teacher, derived from what the teacher has set up.
 *
 * Each member of `PaymentMethod` is one row in the pay page's chooser. A new
 * kind fails the build at `PAYMENT_METHOD_COPY` and at the pay page's
 * exhaustive renderer until both handle it.
 */
export type PaymentMethod =
  | { kind: 'bank_transfer'; iban: string; beneficiary: string }
  | { kind: 'epc_qr'; iban: string; beneficiary: string };

export type PaymentMethodKind = PaymentMethod['kind'];

/** The chooser row's label, and the one line saying when to pick it. */
export const PAYMENT_METHOD_COPY = {
  bank_transfer: { label: 'Bank transfer', hint: 'Copy the details into your banking app' },
  epc_qr: { label: 'QR code', hint: 'For a banking app on another device' },
} as const satisfies Record<PaymentMethodKind, { label: string; hint: string }>;

/** The value with surrounding whitespace removed, or `null` when nothing is left. */
export function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The methods a student may use to pay this teacher, in chooser order.
 *
 * Bank methods need the holder name as well as the IBAN, with no stand-in:
 * the payer's bank checks the name against the IBAN (Verification of Payee),
 * and a name that is not the account's draws a mismatch warning.
 */
export function paymentMethodsFor(teacher: {
  bankIban: string | null;
  bankAccountName: string | null;
}): PaymentMethod[] {
  const iban = nonBlank(teacher.bankIban);
  const beneficiary = nonBlank(teacher.bankAccountName);
  if (iban === null || beneficiary === null) return [];
  return [
    { kind: 'bank_transfer', iban, beneficiary },
    { kind: 'epc_qr', iban, beneficiary },
  ];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --project unit src/lib/payment-methods.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the two guards**

Store each mutation as exact text, apply, run, restore with `cp` from a backup (not `git checkout` — the file is new and uncommitted):

```bash
cp src/lib/payment-methods.ts /tmp/pm.bak
sed -i '' 's/if (iban === null || beneficiary === null) return \[\];/if (iban === null) return [];/' src/lib/payment-methods.ts
pnpm exec vitest run --project unit src/lib/payment-methods.test.ts   # Expected: FAIL "offers nothing with an IBAN but no holder name"
cp /tmp/pm.bak src/lib/payment-methods.ts
sed -i '' "s/const trimmed = value?.trim() ?? '';/const trimmed = value ?? '';/" src/lib/payment-methods.ts
pnpm exec vitest run --project unit src/lib/payment-methods.test.ts   # Expected: FAIL whitespace-only and trim cases
cp /tmp/pm.bak src/lib/payment-methods.ts && cmp /tmp/pm.bak src/lib/payment-methods.ts && echo restored
```
Expected: each mutated run FAILS with the named test; final line `restored`. If a mutation passes, the test is not pinning that guard — fix the test before continuing.

- [ ] **Step 6: Commit**

```bash
pnpm exec eslint src/lib/payment-methods.ts src/lib/payment-methods.test.ts
git add src/lib/payment-methods.ts src/lib/payment-methods.test.ts
git commit -m "feat: payment methods derived from a teacher's bank details

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Onboarding's bank step uses the same predicate

**Files:**
- Modify: `src/lib/onboarding.ts` (`StepInput`, `isDone` `'bank'` case)
- Modify: `src/app/api/account/onboarding/route.ts` (select + pass `bankAccountName`)
- Modify: `src/app/(teacher)/schedule/(overview)/page.tsx` (select + pass `bankAccountName`)
- Modify: `tests/e2e/skeleton-geometry.spec.ts` (fixture teacher gets a holder name)
- Test: `src/lib/onboarding.test.ts`, `src/components/schedule/getting-started.test.tsx`

**Interfaces:**
- Consumes: `paymentMethodsFor` (Task 2).
- Produces: `StepInput` gains `bankAccountName: string | null`. `GettingStarted`'s props extend `StepInput`, so its callers pass it too.

- [ ] **Step 1: Write the failing tests**

In `src/lib/onboarding.test.ts`, add `bankAccountName: null,` to `nothingDone` (after `bankIban: null,`) and to every other `StepInput` object literal in the file (the `isOnboardingComplete` cases near lines 42 and 50). Then add inside `describe('resolveSteps', …)`:

```ts
  it('marks bank done once the IBAN and its holder name exist', () => {
    const bank = resolveSteps({
      ...nothingDone,
      bankIban: 'NL91ABNA0417164300',
      bankAccountName: 'I. Hofland',
    }).find((s) => s.key === 'bank');
    expect(bank?.state).toBe('done');
  });

  // Students are shown bank details only when both exist, so the checklist
  // must not call the step done on the IBAN alone.
  it('leaves bank to do with an IBAN but no holder name', () => {
    const bank = resolveSteps({
      ...nothingDone,
      bankIban: 'NL91ABNA0417164300',
      bankAccountName: null,
    }).find((s) => s.key === 'bank');
    expect(bank?.state).toBe('todo');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/onboarding.test.ts`
Expected: FAIL — `leaves bank to do with an IBAN but no holder name` (received `'done'`). (The type error on `bankAccountName` is reported by `tsc`, not Vitest.)

- [ ] **Step 3: Implement**

`src/lib/onboarding.ts`:

```ts
import type { OnboardingStep } from '@prisma/client';
import { paymentMethodsFor } from './payment-methods';
```

In `StepInput`, after `bankIban: string | null;` add:

```ts
  bankAccountName: string | null;
```

In `isDone`, replace `case 'bank': return input.bankIban !== null;` with:

```ts
    // Done exactly when students can pay by bank.
    case 'bank': return paymentMethodsFor(input).length > 0;
```

`src/app/api/account/onboarding/route.ts` — select `bankAccountName: true` beside `bankIban: true`, and pass `bankAccountName: teacher.bankAccountName,` beside `bankIban: teacher.bankIban,` in the `isSettled({ … })` call.

`src/app/(teacher)/schedule/(overview)/page.tsx` — select `bankAccountName: true` beside `bankIban: true`, and add `bankAccountName: teacher.bankAccountName,` after `bankIban: teacher.bankIban,` in `onboardingInput`.

`src/components/schedule/getting-started.test.tsx` — add `bankAccountName: null,` after each `bankIban: null,` in the `Props` literals, `bankAccountName={null}` after `bankIban={null}`, and `bankAccountName="J. Doe"` after `bankIban="NL00BANK0123456789"`.

`tests/e2e/skeleton-geometry.spec.ts` — after `bankIban: 'NL91ABNA0417164300',` add `bankAccountName: 'Skeleton Teacher',`. Without it the bank step reopens, the getting-started card renders, and the geometry this spec measures changes.

- [ ] **Step 4: Run to verify it passes, and typecheck**

Run:
```bash
pnpm exec vitest run --project unit src/lib/onboarding.test.ts
pnpm exec vitest run --project components src/components/schedule/getting-started.test.tsx
pnpm exec tsc --noEmit 2>&1 | grep -v '^.next-build' | head
```
Expected: both suites PASS; `tsc` prints nothing outside `.next-build` (stale build artifacts there are not this change's).

- [ ] **Step 5: Commit**

```bash
pnpm exec eslint src/lib/onboarding.ts src/lib/onboarding.test.ts src/app/api/account/onboarding/route.ts "src/app/(teacher)/schedule/(overview)/page.tsx" src/components/schedule/getting-started.test.tsx tests/e2e/skeleton-geometry.spec.ts
git add src/lib/onboarding.ts src/lib/onboarding.test.ts src/app/api/account/onboarding/route.ts "src/app/(teacher)/schedule/(overview)/page.tsx" src/components/schedule/getting-started.test.tsx tests/e2e/skeleton-geometry.spec.ts
git commit -m "feat: the bank onboarding step needs the holder name too

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: An IBAN requires its holder name

**Files:**
- Modify: `src/lib/schemas.ts` (`updateTeacherSchema` bank fields; new message constant)
- Modify: `src/app/api/teachers/[id]/route.ts` (merged-row check in `PUT`)
- Modify: `src/components/settings/profile-form.tsx` (hint on "Account holder name")
- Test: `tests/integration/teachers-api.test.ts`, `src/components/settings/profile-form.test.tsx`

**Interfaces:**
- Consumes: `nonBlank` (Task 2).
- Produces: `BANK_HOLDER_NAME_REQUIRED_MESSAGE` (exported from `src/lib/schemas.ts`).

- [ ] **Step 1: Write the failing integration tests**

Append to `tests/integration/teachers-api.test.ts` (it already imports `BASE_URL`, `cookie`, `uniqueSuffix`, `seedSession`, and defines `putTeacher`, `prisma`, `suffix`):

```ts
/**
 * Verification of Payee: a student's bank checks the payee name against the
 * IBAN, so an IBAN is only stored with its holder name. The check reads the
 * row as it would be after the save — the PUT is partial, so the body alone
 * cannot tell an IBAN-only save that pairs with a stored name from one that
 * does not.
 */
describe('PUT /api/teachers/[id] — an IBAN needs its holder name', () => {
  const IBAN = 'NL91ABNA0417164300';
  const email = `holder-teacher-${suffix}@test.local`;
  let holderTeacherId = '';
  let holderAccountId = '';
  let holderToken = '';

  async function setBank(bank: { bankIban: string | null; bankAccountName: string | null }): Promise<void> {
    await prisma.teacher.update({ where: { id: holderTeacherId }, data: bank });
  }

  async function storedBank(): Promise<{ bankIban: string | null; bankAccountName: string | null }> {
    return prisma.teacher.findUniqueOrThrow({
      where: { id: holderTeacherId },
      select: { bankIban: true, bankAccountName: true },
    });
  }

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Holder',
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: 'Holder-name fixture',
        pageSlug: `holder-teacher-${suffix}`,
      },
    });
    holderTeacherId = teacher.id;
    holderAccountId = teacher.accountId;
    holderToken = await seedSession(prisma, holderAccountId);
  });

  afterAll(async () => {
    if (holderAccountId) await prisma.session.deleteMany({ where: { accountId: holderAccountId } });
    if (holderTeacherId) await prisma.teacher.delete({ where: { id: holderTeacherId } });
    await prisma.account.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it('refuses an IBAN with no holder name, and stores nothing', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN }, holderToken);
    expect(res.status).toBe(400);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  it('refuses an IBAN whose holder name is only whitespace', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN, bankAccountName: '   ' }, holderToken);
    expect(res.status).toBe(400);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  it('accepts the IBAN and holder name together', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN, bankAccountName: 'H. Teacher' }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('accepts a holder name added to a stored IBAN', async () => {
    await setBank({ bankIban: IBAN, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankAccountName: 'H. Teacher' }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('accepts an IBAN added to a stored holder name', async () => {
    await setBank({ bankIban: null, bankAccountName: 'H. Teacher' });
    const res = await putTeacher(holderTeacherId, { bankIban: IBAN }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('refuses clearing the holder name while an IBAN is stored', async () => {
    await setBank({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
    const res = await putTeacher(holderTeacherId, { bankAccountName: null }, holderToken);
    expect(res.status).toBe(400);
    expect(await storedBank()).toEqual({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
  });

  it('accepts clearing both', async () => {
    await setBank({ bankIban: IBAN, bankAccountName: 'H. Teacher' });
    const res = await putTeacher(holderTeacherId, { bankIban: null, bankAccountName: null }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  it('stores blank bank fields as null', async () => {
    await setBank({ bankIban: null, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bankIban: '  ', bankAccountName: '' }, holderToken);
    expect(res.status).toBe(200);
    expect(await storedBank()).toEqual({ bankIban: null, bankAccountName: null });
  });

  // Review Focus 1: a row from before this rule must not lock its teacher out
  // of saving anything else.
  it('saves an unrelated field for a teacher whose stored IBAN has no holder name', async () => {
    await setBank({ bankIban: IBAN, bankAccountName: null });
    const res = await putTeacher(holderTeacherId, { bio: 'Still editable' }, holderToken);
    expect(res.status).toBe(200);
    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: holderTeacherId } });
    expect(after.bio).toBe('Still editable');
  });
});
```

- [ ] **Step 2: Write the failing component test**

In `src/components/settings/profile-form.test.tsx`, inside `describe('ProfileForm', …)` (which defines `renderForm`), add:

```tsx
  it('tells the teacher the holder name must match their bank', () => {
    renderForm();
    expect(
      screen.getByText('Exactly as your bank shows it — your students’ banks check this name.'),
    ).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run to verify they fail**

Run:
```bash
pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts
pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx
```
Expected: integration FAILS on `refuses an IBAN with no holder name` (received 200), `refuses an IBAN whose holder name is only whitespace`, `refuses clearing the holder name while an IBAN is stored`, and `stores blank bank fields as null` (stored `'  '`); component FAILS (`Unable to find an element with the text`).

- [ ] **Step 4: Implement the schema**

`src/lib/schemas.ts` — above `export const updateTeacherSchema`, add:

```ts
/** Trimmed, with a blank answer stored as no answer. */
const blankAsNull = z.string().trim().transform((value) => (value === '' ? null : value));

/** The PUT refusal for an IBAN without its holder name. */
export const BANK_HOLDER_NAME_REQUIRED_MESSAGE =
  'Add the account holder name exactly as your bank shows it.';
```

and replace the two bank lines in `updateTeacherSchema` with:

```ts
  bankIban: blankAsNull.nullable().optional(),
  bankAccountName: blankAsNull.nullable().optional(),
```

- [ ] **Step 5: Implement the route check**

`src/app/api/teachers/[id]/route.ts` — import `BANK_HOLDER_NAME_REQUIRED_MESSAGE` from `@/lib/schemas` (beside `updateTeacherSchema`) and `nonBlank` from `@/lib/payment-methods`. After the `if (Object.keys(updateData).length === 0) { … }` block, insert:

```ts
  // The body is partial, so the rule is checked on the row as it would be
  // after this save. Only a save touching a bank field is checked: a row
  // stored before the rule must not block its teacher's unrelated edits.
  // Read and write are separate statements; a teacher racing their own two
  // saves could still land an IBAN alone, and `paymentMethodsFor` then shows
  // students no bank details rather than a wrong name.
  if (updateData.bankIban !== undefined || updateData.bankAccountName !== undefined) {
    const stored = await prisma.teacher.findUniqueOrThrow({
      where: { id },
      select: { bankIban: true, bankAccountName: true },
    });
    const iban = nonBlank(updateData.bankIban !== undefined ? updateData.bankIban : stored.bankIban);
    const holder = nonBlank(
      updateData.bankAccountName !== undefined ? updateData.bankAccountName : stored.bankAccountName,
    );
    if (iban !== null && holder === null) {
      return respondError(BANK_HOLDER_NAME_REQUIRED_MESSAGE, 400);
    }
  }
```

- [ ] **Step 6: Implement the form hint**

`src/components/settings/profile-form.tsx` — on the `Account holder name` `Input`, add:

```tsx
          hint="Exactly as your bank shows it — your students’ banks check this name."
```

- [ ] **Step 7: Run to verify they pass**

Run:
```bash
pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts
pnpm exec vitest run --project components src/components/settings/profile-form.test.tsx
```
Expected: PASS.

- [ ] **Step 8: Mutation-check the merged-row read**

```bash
cp "src/app/api/teachers/[id]/route.ts" /tmp/route.bak
sed -i '' 's/updateData.bankAccountName !== undefined ? updateData.bankAccountName : stored.bankAccountName/updateData.bankAccountName ?? null/' "src/app/api/teachers/[id]/route.ts"
pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts   # Expected: FAIL "accepts an IBAN added to a stored holder name" (400)
cp /tmp/route.bak "src/app/api/teachers/[id]/route.ts" && cmp /tmp/route.bak "src/app/api/teachers/[id]/route.ts" && echo restored
```
Then mutate the gate to always run (`if (true) {`) and confirm `saves an unrelated field …` FAILS; restore the same way.
Expected: each mutated run FAILS with the named test; each restore prints `restored`. Check `git status --short` shows only this task's intended edits.

- [ ] **Step 9: Commit**

```bash
pnpm exec eslint src/lib/schemas.ts "src/app/api/teachers/[id]/route.ts" src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx tests/integration/teachers-api.test.ts
git add src/lib/schemas.ts "src/app/api/teachers/[id]/route.ts" src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx tests/integration/teachers-api.test.ts
git commit -m "feat: an IBAN is stored only with its holder name

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Payment notifications link to the pay page

**Files:**
- Modify: `src/lib/notification-links.ts`
- Modify: `src/lib/email-templates.ts`
- Test: `src/lib/notification-links.test.ts`, `src/lib/email-templates.test.ts`

**Interfaces:**
- Produces (from `src/lib/notification-links.ts`):
  - `function payPagePath(classId: string): string` → `` `/bookings/${classId}/pay` ``
  - `const PAY_NOW_LABEL = 'Pay now'`
  - `function isPaymentNotification(type: NotificationType): boolean` — true for `payment_request` and `reminder`
- `NotificationEmailInput` gains `relatedClassId?: string | null`.

- [ ] **Step 1: Write the failing link tests**

`src/lib/notification-links.test.ts` — extend the import to `{ STUDENT_INVITATION_PATH, TEACHER_INVITATION_PATH, payPagePath, studentNotificationHref, teacherNotificationHref }` and add inside `describe('studentNotificationHref', …)`:

```ts
  const completedClass = { ...openClass, status: 'completed' as const };

  it('sends a payment request to the pay page of its class', () => {
    expect(
      studentNotificationHref({ type: 'payment_request', relatedClass: completedClass }),
    ).toBe('/bookings/class-1/pay');
  });

  it('sends a payment reminder to the pay page of its class', () => {
    expect(
      studentNotificationHref({ type: 'reminder', relatedClass: completedClass }),
    ).toBe('/bookings/class-1/pay');
  });

  it('yields null for a payment notification with no related class', () => {
    expect(studentNotificationHref({ type: 'payment_request', relatedClass: null })).toBeNull();
  });

  it('builds the pay page path from the class id', () => {
    expect(payPagePath('abc')).toBe('/bookings/abc/pay');
  });
```

- [ ] **Step 2: Write the failing email tests**

`src/lib/email-templates.test.ts` — replace the test `adds no link to a notification type that has nowhere to send a student` (it uses `reminder`, which now links when a class is given) with:

```ts
  // The link is per-type, not a blanket addition: a type with no student
  // destination gets none.
  it('adds no link to a notification type that has nowhere to send a student', () => {
    const { html } = renderNotificationEmail(
      { type: 'booking_cancelled', title: 'Cancelled', body: 'You cancelled Tuesday.', recipientType: 'student' },
      'https://example.test',
    );
    expect(html).not.toContain('href=');
  });

  it('gives a student payment request a Pay now button to its class’s pay page', () => {
    const { html } = renderNotificationEmail(
      { type: 'payment_request', title: 'Priced', body: '€5.75', recipientType: 'student', relatedClassId: 'class-9' },
      'https://example.test',
    );
    expect(html).toContain('href="https://example.test/bookings/class-9/pay"');
    expect(html).toContain('Pay now');
  });

  it('gives a student payment reminder the same button', () => {
    const { html } = renderNotificationEmail(
      { type: 'reminder', title: 'Payment outstanding', body: '€5.75', recipientType: 'student', relatedClassId: 'class-9' },
      'https://example.test',
    );
    expect(html).toContain('href="https://example.test/bookings/class-9/pay"');
  });

  it('gives a payment notification without a class no button', () => {
    const { html } = renderNotificationEmail(
      { type: 'reminder', title: 'Payment outstanding', body: '€5.75', recipientType: 'student', relatedClassId: null },
      'https://example.test',
    );
    expect(html).not.toContain('href=');
  });

  // Review Focus 4: teachers receive payment_request too, and the pay page is
  // a student route.
  it('gives a teacher payment request no Pay now button', () => {
    const { html } = renderNotificationEmail(
      { type: 'payment_request', title: 'Class completed', body: 'Prices are out.', recipientType: 'teacher', relatedClassId: 'class-9' },
      'https://example.test',
    );
    expect(html).not.toContain('/bookings/class-9/pay');
    expect(html).not.toContain('Pay now');
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/notification-links.test.ts src/lib/email-templates.test.ts`
Expected: FAIL — `payPagePath` not exported; payment request href `null`; email lacks the pay link.

- [ ] **Step 4: Implement the links**

`src/lib/notification-links.ts` — after `STUDENT_BOOKINGS_LABEL`, add:

```ts
/** The page where a student pays for one class. */
export function payPagePath(classId: string): string {
  return `/bookings/${classId}/pay`;
}

/** The label for that action, in the app and on the email's button. */
export const PAY_NOW_LABEL = 'Pay now';

/** Whether a student notification is about paying for its class. */
export function isPaymentNotification(type: NotificationType): boolean {
  return type === 'payment_request' || type === 'reminder';
}
```

`NotificationType` is currently a type-only import (`import type { ClassStatus, NotificationType } from '@prisma/client';`) — that stays correct, since the function only compares strings.

In `studentNotificationHref`, after the `teacher_invitation` line, add:

```ts
  if (isPaymentNotification(notification.type)) {
    return notification.relatedClass ? payPagePath(notification.relatedClass.id) : null;
  }
```

and add to its docblock, after the "Type first, related class second" paragraph:

```ts
 * A payment notification goes to its class's pay page whatever the payment's
 * state: that page answers paid and not-charged truthfully, so the link never
 * has to know which.
```

- [ ] **Step 5: Implement the email button**

`src/lib/email-templates.ts`:
- Extend the `./notification-links` import with `PAY_NOW_LABEL, isPaymentNotification, payPagePath`.
- In `NotificationEmailInput`, add:

```ts
  /** The class a notification is about; gives a payment notification its pay link. */
  relatedClassId?: string | null;
```

- Above `renderNotificationEmail`, add:

```ts
/** A student email's action: a payment's own pay page, else the type's fixed one. */
function studentAction(
  notification: NotificationEmailInput,
): { label: string; path: string } | undefined {
  if (isPaymentNotification(notification.type)) {
    return notification.relatedClassId
      ? { label: PAY_NOW_LABEL, path: payPagePath(notification.relatedClassId) }
      : undefined;
  }
  return STUDENT_ACTION_LINKS[notification.type];
}
```

- In `renderNotificationEmail`, replace `: STUDENT_ACTION_LINKS[notification.type];` with `: studentAction(notification);`.
- In the `STUDENT_ACTION_LINKS` docblock, after the class-reminder sentence, add: `A payment notification is not in this map: its link names its own class, so \`studentAction\` builds it.`

`email-fallback.ts` passes the whole notification row, which carries `relatedClassId`, so no call site changes.

- [ ] **Step 6: Run to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/notification-links.test.ts src/lib/email-templates.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec tsc --noEmit 2>&1 | grep -v '^.next-build' | head
pnpm exec eslint src/lib/notification-links.ts src/lib/notification-links.test.ts src/lib/email-templates.ts src/lib/email-templates.test.ts
git add src/lib/notification-links.ts src/lib/notification-links.test.ts src/lib/email-templates.ts src/lib/email-templates.test.ts
git commit -m "feat: payment notifications link to the class's pay page

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The pay page

**Files:**
- Create: `src/app/(student)/bookings/[classId]/pay/page.tsx`
- Test: `tests/integration/pay-page.test.ts`

**Interfaces:**
- Consumes: `paymentMethodsFor`, `PAYMENT_METHOD_COPY`, `PaymentMethod` (Task 2); `PaymentDetails` (Task 1); `PaymentQr` (`src/components/student/payment-qr.tsx`, props `{ iban, beneficiary, amount: number, remittance }`); `PaymentBreakdown` + `resolveReportedPaymentBreakdown` (existing); `paymentStateText`, `formatDayHeader` (`src/lib/format.ts`); `formatInstantInZone(instant, timeZone)` (`src/lib/timezone.ts`).
- Produces: the route `/bookings/[classId]/pay`.

- [ ] **Step 1: Write the failing integration tests**

`tests/integration/pay-page.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const IBAN = 'NL91ABNA0417164300';
const HOLDER = 'P. Paypage';

/**
 * `/bookings/[classId]/pay` — one class's payment, for the signed-in student.
 *
 * The page is keyed by the class and the session's own student, so every
 * class that is not this student's — someone else's, one with no payment, one
 * that does not exist — answers the same 404.
 */
describe('GET /bookings/[classId]/pay', () => {
  const accountIds: string[] = [];
  const teacherIds: string[] = [];
  const roomIds: string[] = [];
  const studentIds: string[] = [];
  let studentToken = '';
  let otherStudentToken = '';
  let teacherToken = '';
  let dualToken = '';
  const classIds = {
    overdue: '',
    paid: '',
    notCharged: '',
    cancelledRegistration: '',
    noBank: '',
    ibanNoHolder: '',
    dual: '',
  };
  const overdueClass = { classType: `Pay Overdue ${suffix}`, date: new Date('2026-06-01T00:00:00.000Z') };

  async function makeTeacher(
    key: string,
    bank: { bankIban: string | null; bankAccountName: string | null },
  ): Promise<{ id: string; accountId: string; teacherRoomId: string }> {
    const email = `paypage-${key}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: `Pay${key}`,
        lastName: 'Teacher',
        email,
        bio: 'Pay page fixture',
        pageSlug: `paypage-${key}-${suffix}`,
        defaultTimezone: 'UTC',
        ...bank,
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    const room = await prisma.room.create({
      data: {
        venueName: 'Pay Studio',
        address: `${suffix} ${key} St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    roomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 25 },
    });
    return { ...teacher, teacherRoomId: teacherRoom.id };
  }

  async function makeStudent(key: string, accountId?: string): Promise<{ id: string; accountId: string }> {
    const email = `paypage-student-${key}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: `Student${key}`,
        lastName: 'Payer',
        email,
        claimedAt: new Date(),
        account: accountId ? { connect: { id: accountId } } : { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    studentIds.push(student.id);
    const ownAccount = student.accountId as string;
    if (!accountId) accountIds.push(ownAccount);
    return { id: student.id, accountId: ownAccount };
  }

  async function completedClass(
    teacher: { id: string; teacherRoomId: string },
    c: { classType: string; date: Date },
    studentId: string,
    registrationStatus: 'attended' | 'cancelled',
    payment: { amount: number; status: 'pending' | 'overdue' | 'paid' | 'not_charged' } | null,
  ): Promise<string> {
    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacher.teacherRoomId,
      classType: c.classType,
      date: c.date,
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
      effectiveTeacherRate: 10,
      totalStudents: 4,
      totalRevenue: 30,
    });
    const registration = await prisma.registration.create({
      data: { classId: cls.id, studentId, status: registrationStatus, tierAtBooking: 3 },
    });
    if (payment) {
      await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: payment.amount,
          status: payment.status,
          paidAt: payment.status === 'paid' ? new Date('2026-06-05T10:00:00.000Z') : null,
          notChargedAt: payment.status === 'not_charged' ? new Date() : null,
        },
      });
    }
    return cls.id;
  }

  async function payPage(classId: string, token: string | null): Promise<Response> {
    return fetch(`${BASE_URL}/bookings/${classId}/pay`, {
      headers: token ? cookie(token) : {},
      redirect: 'manual',
    });
  }

  beforeAll(async () => {
    await prisma.$connect();

    const bankTeacher = await makeTeacher('bank', { bankIban: IBAN, bankAccountName: HOLDER });
    const noBankTeacher = await makeTeacher('nobank', { bankIban: null, bankAccountName: null });
    // Written straight to the row: the API now refuses this pair, but a row
    // from before that rule can still hold it.
    const noHolderTeacher = await makeTeacher('noholder', { bankIban: IBAN, bankAccountName: null });

    const student = await makeStudent('main');
    studentToken = await seedSession(prisma, student.accountId);
    const otherStudent = await makeStudent('other');
    otherStudentToken = await seedSession(prisma, otherStudent.accountId);
    teacherToken = await seedSession(prisma, bankTeacher.accountId);

    // An account with both hats, paying for its own class as a student.
    const dualTeacher = await makeTeacher('dual', { bankIban: null, bankAccountName: null });
    const dualStudent = await makeStudent('dual', dualTeacher.accountId);
    dualToken = await seedSession(prisma, dualTeacher.accountId);

    classIds.overdue = await completedClass(bankTeacher, overdueClass, student.id, 'attended', { amount: 5.75, status: 'overdue' });
    classIds.paid = await completedClass(bankTeacher, { classType: `Pay Paid ${suffix}`, date: new Date('2026-06-02T00:00:00.000Z') }, student.id, 'attended', { amount: 6.11, status: 'paid' });
    classIds.notCharged = await completedClass(bankTeacher, { classType: `Pay Waived ${suffix}`, date: new Date('2026-06-03T00:00:00.000Z') }, student.id, 'attended', { amount: 7.12, status: 'not_charged' });
    classIds.cancelledRegistration = await completedClass(bankTeacher, { classType: `Pay Cancelled ${suffix}`, date: new Date('2026-06-04T00:00:00.000Z') }, student.id, 'cancelled', null);
    classIds.noBank = await completedClass(noBankTeacher, { classType: `Pay NoBank ${suffix}`, date: new Date('2026-06-01T00:00:00.000Z') }, student.id, 'attended', { amount: 8.13, status: 'pending' });
    classIds.ibanNoHolder = await completedClass(noHolderTeacher, { classType: `Pay NoHolder ${suffix}`, date: new Date('2026-06-01T00:00:00.000Z') }, student.id, 'attended', { amount: 9.14, status: 'pending' });
    classIds.dual = await completedClass(noBankTeacher, { classType: `Pay Dual ${suffix}`, date: new Date('2026-06-02T00:00:00.000Z') }, dualStudent.id, 'attended', { amount: 4.5, status: 'pending' });

    // Warm the route: `next dev` compiles a page lazily on its first request.
    await payPage(classIds.overdue, studentToken).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    if (studentIds.length > 0) {
      await prisma.payment.deleteMany({ where: { registration: { studentId: { in: studentIds } } } });
      await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
    }
    if (teacherIds.length > 0) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomIds.length > 0) await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    if (studentIds.length > 0) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('offers an outstanding payment its methods, with the bank details inside them', async () => {
    const res = await payPage(classIds.overdue, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(overdueClass.classType);
    expect(html).toContain('! Overdue');
    expect(html).toContain('How would you like to pay?');
    expect(html).toContain('Bank transfer');
    expect(html).toContain('QR code');
    expect(html).toContain('name="pay-method"');
    expect(html).toContain(IBAN);
    expect(html).toContain(HOLDER);
    expect(html).toContain('href="/bookings"');
  });

  it('shows why the amount is what it is', async () => {
    const html = await (await payPage(classIds.overdue, studentToken)).text();
    expect(html).toContain(`Where your payment goes — ${overdueClass.classType}, ${formatDayHeader(overdueClass.date)}`);
  });

  it('tells a student whose teacher has no bank details to pay directly', async () => {
    const res = await payPage(classIds.noBank, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Pay Paynobank directly');
    expect(html).not.toContain('How would you like to pay?');
  });

  // The page's own gate, independent of the API rule: an IBAN without its
  // holder name shows no bank details at all.
  it('shows no bank details for an IBAN stored without its holder name', async () => {
    const res = await payPage(classIds.ibanNoHolder, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Pay Paynoholder directly');
    expect(html).not.toContain(IBAN);
  });

  it('answers a paid payment calmly, with no methods', async () => {
    const res = await payPage(classIds.paid, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('✓ Paid');
    expect(html).not.toContain('How would you like to pay?');
    expect(html).not.toContain(IBAN);
  });

  it('answers a not-charged payment calmly, with no methods', async () => {
    const res = await payPage(classIds.notCharged, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('⊘ Not charged');
    expect(html).toContain('Paybank isn’t charging for this class.');
    expect(html).not.toContain(IBAN);
  });

  it("answers another student's class as not found", async () => {
    const res = await payPage(classIds.overdue, otherStudentToken);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(overdueClass.classType);
  });

  it('answers a registration that has no payment as not found', async () => {
    expect((await payPage(classIds.cancelledRegistration, studentToken)).status).toBe(404);
  });

  // Review Focus 2.
  it('answers a malformed or unknown class id as not found', async () => {
    expect((await payPage('not-a-uuid', studentToken)).status).toBe(404);
    expect((await payPage('00000000-0000-0000-0000-000000000000', studentToken)).status).toBe(404);
  });

  // Review Focus 3.
  it('opens for an account that is both teacher and student', async () => {
    const res = await payPage(classIds.dual, dualToken);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Pay Dual ${suffix}`);
  });

  it('sends a teacher-only account to their schedule', async () => {
    const res = await payPage(classIds.overdue, teacherToken);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', BASE_URL).pathname).toBe('/schedule');
  });

  it('sends a signed-out visitor to sign in, keeping the destination', async () => {
    const res = await payPage(classIds.overdue, null);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '', BASE_URL);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('redirect')).toBe(`/bookings/${classIds.overdue}/pay`);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run --project integration tests/integration/pay-page.test.ts`
Expected: FAIL — the 200 cases receive 404 (route does not exist). The 404 cases and the two redirect cases may already pass; that is expected, since they hold for any unmatched `/bookings/*` path.

- [ ] **Step 3: Implement the page**

`src/app/(student)/bookings/[classId]/pay/page.tsx`:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { PaymentStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSession } from '@/lib/session';
import { redirectNonStudent } from '@/lib/student-guard';
import { Icon } from '@/components/ui/icon';
import { PaymentDetails } from '@/components/student/payment-details';
import { PaymentQr } from '@/components/student/payment-qr';
import { PaymentBreakdown } from '@/components/student/payment-breakdown';
import { resolveReportedPaymentBreakdown } from '@/lib/payment-breakdown.server';
import { formatDayHeader, paymentStateText } from '@/lib/format';
import { formatInstantInZone } from '@/lib/timezone';
import { PAYMENT_METHOD_COPY, paymentMethodsFor, type PaymentMethod } from '@/lib/payment-methods';

export const dynamic = 'force-dynamic';

/** One method's details, inside its chooser row. */
function MethodPanel({
  method,
  amount,
  reference,
}: {
  method: PaymentMethod;
  amount: number;
  reference: string;
}) {
  switch (method.kind) {
    case 'bank_transfer':
      return (
        <>
          <p className="type-body">
            Transfer <span className="type-number">€{amount.toFixed(2)}</span> to:
          </p>
          <PaymentDetails iban={method.iban} beneficiary={method.beneficiary} reference={reference} />
        </>
      );
    case 'epc_qr':
      return (
        <PaymentQr iban={method.iban} beneficiary={method.beneficiary} amount={amount} remittance={reference} />
      );
    default: {
      // A kind added to `PaymentMethod` without a panel fails the build here.
      const unhandled: never = method;
      return unhandled;
    }
  }
}

// One class's payment for the signed-in student: how to pay it, or that it
// is settled.
export default async function PayPage({ params }: { params: Promise<{ classId: string }> }) {
  const session = await getSession();
  if (!session?.studentId) redirectNonStudent(session);
  const { classId } = await params;

  // Keyed by the session's own student: another student's class finds no
  // row, and answers exactly as a class that does not exist.
  const registration = await prisma.registration.findUnique({
    where: { classId_studentId: { classId, studentId: session.studentId } },
    include: {
      payment: true,
      class: {
        include: {
          calendarEntry: {
            include: {
              teacher: {
                select: {
                  firstName: true,
                  lastName: true,
                  bankIban: true,
                  bankAccountName: true,
                  defaultTimezone: true,
                },
              },
            },
          },
        },
      },
    },
  });
  const payment = registration?.payment;
  if (!registration || !payment) notFound();

  const cls = registration.class;
  const entry = cls.calendarEntry;
  const teacher = entry.teacher;
  const amount = Number(payment.amount);
  const reference = `${entry.classType} ${formatDayHeader(entry.date)}`;
  const methods = paymentMethodsFor(teacher);
  const state = paymentStateText(payment.status);
  const breakdown = resolveReportedPaymentBreakdown(
    {
      classStatus: cls.status,
      roomCost: cls.roomCost,
      totalRevenue: cls.totalRevenue,
      totalStudents: cls.totalStudents,
      payment,
    },
    { classId: cls.id, registrationId: registration.id },
  );

  return (
    <div>
      <Link
        href="/bookings"
        className="inline-flex items-center gap-1.5 type-label text-teal no-underline mb-2"
      >
        <Icon name="arrow-left" size={18} />
        Your bookings
      </Link>
      <h1 className="type-title">{entry.classType}</h1>
      <p className="type-caption mb-4">
        {`${formatDayHeader(entry.date)} · with ${teacher.firstName} ${teacher.lastName}`}
      </p>
      <div className="flex items-baseline justify-between gap-3 mb-6">
        <p className="type-number">€{amount.toFixed(2)}</p>
        <p className={`type-caption ${state.className}`}>{state.label}</p>
      </div>
      <PayBody
        status={payment.status}
        methods={methods}
        amount={amount}
        reference={reference}
        teacherFirstName={teacher.firstName}
        paidAt={payment.paidAt}
        timeZone={teacher.defaultTimezone}
      />
      {breakdown.kind === 'shown' && (
        <PaymentBreakdown lines={breakdown.lines} classType={entry.classType} date={entry.date} />
      )}
    </div>
  );
}

function PayBody({
  status,
  methods,
  amount,
  reference,
  teacherFirstName,
  paidAt,
  timeZone,
}: {
  status: PaymentStatus;
  methods: PaymentMethod[];
  amount: number;
  reference: string;
  teacherFirstName: string;
  paidAt: Date | null;
  timeZone: string;
}) {
  switch (status) {
    case 'paid':
      return (
        <p className="type-body mb-6">
          {paidAt ? `Marked paid ${formatInstantInZone(paidAt, timeZone)}.` : 'Marked paid.'}
        </p>
      );
    case 'not_charged':
      return <p className="type-body mb-6">{`${teacherFirstName} isn’t charging for this class.`}</p>;
    case 'pending':
    case 'overdue':
      if (methods.length === 0) {
        return (
          <p className="type-body mb-6">
            {`Pay ${teacherFirstName} directly — cash or transfer, whatever you two agreed. They’ll mark it as received.`}
          </p>
        );
      }
      return (
        <section className="mb-6">
          <h2 className="type-subtitle mb-3">How would you like to pay?</h2>
          <div className="border-t border-border">
            {methods.map((method) => (
              // A shared `name` makes the rows exclusive: opening one closes the others.
              <details key={method.kind} name="pay-method" className="border-b border-border">
                <summary className="min-h-14 py-3 cursor-pointer">
                  <span className="text-base text-ink">{PAYMENT_METHOD_COPY[method.kind].label}</span>
                  <span className="block type-caption">{PAYMENT_METHOD_COPY[method.kind].hint}</span>
                </summary>
                <div className="pb-4">
                  <MethodPanel method={method} amount={amount} reference={reference} />
                </div>
              </details>
            ))}
          </div>
        </section>
      );
    default: {
      // A status added to `PaymentStatus` without a body fails the build here.
      const unhandled: never = status;
      return unhandled;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm exec vitest run --project integration tests/integration/pay-page.test.ts`
Expected: PASS, 12 tests. If the 404 cases answer 200 with not-found content, a loading boundary is streaming above the page — stop and report rather than loosening the assertion.

- [ ] **Step 5: Mutation-check the ownership key**

```bash
cp "src/app/(student)/bookings/[classId]/pay/page.tsx" /tmp/pay.bak
```
Replace the `findUnique` call's `where` with a lookup that ignores the student — `prisma.registration.findFirst({ where: { classId }, include: … })` (same `include`) — then run:
`pnpm exec vitest run --project integration tests/integration/pay-page.test.ts`
Expected: FAIL `answers another student's class as not found` (200). Restore:
```bash
cp /tmp/pay.bak "src/app/(student)/bookings/[classId]/pay/page.tsx" && cmp /tmp/pay.bak "src/app/(student)/bookings/[classId]/pay/page.tsx" && echo restored
```

- [ ] **Step 6: Commit**

```bash
pnpm exec tsc --noEmit 2>&1 | grep -v '^.next-build' | head
pnpm exec eslint "src/app/(student)/bookings/[classId]/pay/page.tsx" tests/integration/pay-page.test.ts
git add "src/app/(student)/bookings/[classId]/pay/page.tsx" tests/integration/pay-page.test.ts
git commit -m "feat: a pay page for each outstanding class

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `/bookings` links to the pay page

**Files:**
- Modify: `src/app/(student)/bookings/page.tsx` (the past-class row's payment block; imports)
- Test: `tests/integration/bookings-page.test.ts`

**Interfaces:**
- Consumes: `paymentMethodsFor` (Task 2); `payPagePath`, `PAY_NOW_LABEL` (Task 5).

- [ ] **Step 1: Update the tests first**

In `tests/integration/bookings-page.test.ts`:

1. **`payment status gate` describe** — capture the class id: declare `let classId = '';` beside `let paymentId = '';` and set `classId = cls.id;` after `createClassFixture`. Replace the docblock above the describe with:

```ts
/**
 * `/bookings` — the Pay now link's payment-status gate.
 *
 * A `not_charged` payment must not solicit payment: no Pay now link. An
 * actually-unpaid payment links to its pay page. The bank details themselves
 * live on that page, so the IBAN appears on `/bookings` in neither case.
 */
```

   Replace the test `still shows an unpaid student how to pay` with:

```ts
  it('links an unpaid student to the pay page', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'pending', notChargedAt: null } });

    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('○ Unpaid');
    expect(html).toContain(`href="/bookings/${classId}/pay"`);
    expect(html).toContain('Pay now');
    expect(html).not.toContain(TEACHER_IBAN);
  });

  it('tells an unpaid student to pay directly when the teacher has no holder name', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'pending', notChargedAt: null } });
    await prisma.teacher.update({ where: { id: teacherId }, data: { bankAccountName: null } });
    try {
      const html = await (await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) })).text();
      expect(html).toContain('Pay Bookings directly');
      expect(html).not.toContain(`href="/bookings/${classId}/pay"`);
    } finally {
      await prisma.teacher.update({ where: { id: teacherId }, data: { bankAccountName: 'Bookings Teacher' } });
    }
  });
```

   In `tells a student their payment was not charged, and stops asking for it`, change `expect(html).not.toContain('How to pay');` to `expect(html).not.toContain('Pay now');` and the comment above `not.toContain(TEACHER_IBAN)` to: `// No pay link and no bank details for a payment nobody is collecting.`

2. **`cancelled class moves to Past` describe** — change `expect(html).not.toContain('How to pay');` to `expect(html).not.toContain('Pay now');` and add `expect(html).not.toContain('directly');` after it.

3. **`past-class payment breakdown` describe** — give its fixture teacher bank details, so its pending row keeps a Pay now link beside the breakdown: in that describe's `prisma.teacher.create`, add `bankIban: 'NL91ABNA0417164300',` and `bankAccountName: 'Breakdown Teacher',`. Change the assertion `` expect(html).toContain(`How to pay — ${pendingClass.classType}, ${formatDayHeader(pendingClass.date)}`); `` to `` expect(html).toContain(`Pay now — ${pendingClass.classType}, ${formatDayHeader(pendingClass.date)}`); ``.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: FAIL — `links an unpaid student to the pay page` (no pay href; IBAN present), `tells an unpaid student to pay directly …`, and the breakdown `Pay now — …` assertion.

- [ ] **Step 3: Implement the row**

`src/app/(student)/bookings/page.tsx`:
- Remove the `PaymentQr` import. Add `import { paymentMethodsFor } from '@/lib/payment-methods';` and extend the `@/lib/notification-links` import to `{ PAY_NOW_LABEL, payPagePath, studentNotificationHref }`.
- Replace the whole `{payment && outstanding && ( <details className="mt-2"> … </details> )}` expression with:

```tsx
                {payment && outstanding && (
                  paymentMethodsFor(cls.calendarEntry.teacher).length > 0 ? (
                    <div className="mt-3">
                      <Link
                        href={payPagePath(cls.id)}
                        aria-label={`${PAY_NOW_LABEL} — ${cls.calendarEntry.classType}, ${formatDayHeader(cls.calendarEntry.date)}`}
                        className="inline-flex items-center h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint no-underline"
                      >
                        {PAY_NOW_LABEL}
                      </Link>
                    </div>
                  ) : (
                    <p className="type-caption mt-2">{`Pay ${cls.calendarEntry.teacher.firstName} directly`}</p>
                  )
                )}
```

   `bankIban` and `bankAccountName` are already in this query's teacher `select`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: PASS (all describes in the file).

- [ ] **Step 5: Commit**

```bash
pnpm exec tsc --noEmit 2>&1 | grep -v '^.next-build' | head
pnpm exec eslint "src/app/(student)/bookings/page.tsx" tests/integration/bookings-page.test.ts
git add "src/app/(student)/bookings/page.tsx" tests/integration/bookings-page.test.ts
git commit -m "feat: past classes link to their pay page

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch verification

**Files:** none changed unless a check fails.

- [ ] **Step 1: Unit and component suites**

Run: `pnpm exec vitest run --project unit --project components`
Expected: PASS.

- [ ] **Step 2: Integration files this branch touched**

Run: `pnpm exec vitest run --project integration tests/integration/pay-page.test.ts tests/integration/bookings-page.test.ts tests/integration/teachers-api.test.ts`
Expected: PASS.

- [ ] **Step 3: Whole-tree typecheck and lint**

Run:
```bash
pnpm exec tsc --noEmit 2>&1 | grep -v '^.next-build' | head
pnpm exec eslint src tests
```
Expected: no output from `tsc` outside `.next-build`; eslint clean.

- [ ] **Step 4: Visual check at 390px**

With the dev server running, mint a session for the seeded student with an outstanding payment (`.claude/skills/verify/SKILL.md`, "Sessions"), open `/bookings` and the pay page in Playwright at 390×844, and screenshot: the `/bookings` row; the pay page with the chooser closed; Bank transfer open; QR code open (Bank transfer must close). Delete the session row afterwards. Judge the screenshots at actual size.

- [ ] **Step 5: Confirm a clean tree**

Run: `git status --short`
Expected: empty — no orphaned mutation or scratch file.
