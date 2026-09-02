# Payment "not charged" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a teacher mark an outstanding payment as "not charged" — the grace policy `docs/product-concept.md:142` specifies and nothing implements.

**Architecture:** A fourth `PaymentStatus` member, `not_charged`, plus a `notChargedAt` timestamp mirroring `paidAt`. It is a structural twin of `paid`: settled, reachable only from `pending|overdue`, reversed only to `pending` by the existing "Mark unpaid" control with its CAS widened. A single exhaustive `isOutstanding` predicate with a `never` default replaces five sites that today ask "is it paid?" and treat the negation as meaningful. The teacher control ships on `/settings/payments` only, on a second line of the outstanding row.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (projects: `unit`, `unit-sweeps`, `integration`, `components`), Playwright e2e, Tailwind v4 tokens in `src/app/globals.css`.

**Spec:** `docs/superpowers/specs/2026-09-02-payment-not-charged-design.md`

## Global Constraints

- **User-facing copy is "Not charged"**, never "waived". The enum member is `not_charged` (snake_case, matching `booking_confirmed` / `late_cancel` / `in_progress`).
- **Payment state is text, never a badge.** The new state renders `⊘ Not charged` with class `text-brown-light`; the inline caption variant is ` · ⊘ not charged`.
- **The existing three labels must come out byte-identical**: `✓ Paid` / `text-teal`, `○ Unpaid` / `''`, `! Overdue` / `text-danger font-medium`.
- **TypeScript strict, no `any`, no type assertions to silence an error.** `noUncheckedIndexedAccess` is on.
- **`@/lib/log` is pino and server-only** — never reachable from a `'use client'` module. Client-reachable code logs with `console.error`.
- **Every `@prisma/client` import in a client path is `import type`.**
- **Never edit an applied migration**, comment-only edits included.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `"src/app/(teacher)/…"`.
- **Do not kill or restart the dev server on :3000.** Integration tests need it live; if it is running it is the user's.
- **Task order is load-bearing.** Task 1 must land first: adding the enum member breaks the build at three deliberate tethers, and nothing else compiles until Task 1 restores it.

---

### Task 1: Schema, the compiler tethers, and the `isOutstanding` predicate

Adding the enum member deliberately breaks the build in three places. This task adds the member and repairs all three, ending with a green typecheck and one new shared predicate everything downstream depends on.

**Files:**
- Modify: `prisma/schema.prisma:73-77` (enum), `:943-958` (model)
- Create: `prisma/migrations/<timestamp>_payment_not_charged/migration.sql` (generated)
- Modify: `src/lib/payment-status.ts:29-33`
- Modify: `src/lib/format.ts:33-56`, `:62-70`
- Test: `src/lib/payment-status.test.ts`, `src/lib/format.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PaymentStatus` gains the member `not_charged`.
  - `Payment.notChargedAt: DateTime?` (Prisma) / `notChargedAt TIMESTAMP(3)` (SQL).
  - `isOutstanding(status: PaymentStatus): boolean` exported from `src/lib/payment-status.ts`. Returns `true` for `pending` and `overdue`, `false` for `paid` and `not_charged`, `false` on the impossible branch after logging.
  - `paymentStateText('not_charged')` → `{ label: '⊘ Not charged', className: 'text-brown-light' }`
  - `paymentStateInlineText('not_charged')` → `{ label: ' · ⊘ not charged', className: 'text-brown-light' }`

- [ ] **Step 1: Write the failing tests for the predicate**

Append to `src/lib/payment-status.test.ts`:

```ts
import { isOutstanding } from '@/lib/payment-status';

describe('isOutstanding', () => {
  it('is true for a payment that is still owed', () => {
    expect(isOutstanding('pending')).toBe(true);
    expect(isOutstanding('overdue')).toBe(true);
  });

  it('is false for a payment that is settled', () => {
    expect(isOutstanding('paid')).toBe(false);
    expect(isOutstanding('not_charged')).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing tests for the copy**

Append to `src/lib/format.test.ts`, inside the existing `paymentStateText` and `paymentStateInlineText` describes:

```ts
it('renders not_charged as muted "⊘ Not charged"', () => {
  expect(paymentStateText('not_charged')).toEqual({
    label: '⊘ Not charged',
    className: 'text-brown-light',
  });
});

it('renders the not_charged caption suffix', () => {
  expect(paymentStateInlineText('not_charged')).toEqual({
    label: ' · ⊘ not charged',
    className: 'text-brown-light',
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib/payment-status.test.ts src/lib/format.test.ts`
Expected: FAIL. `isOutstanding` is not exported; `'not_charged'` is not assignable to `PaymentStatus`.

- [ ] **Step 4: Add the enum member and the column to the schema**

In `prisma/schema.prisma`, the enum becomes:

```prisma
enum PaymentStatus {
  pending
  paid
  overdue
  not_charged
}
```

And in `model Payment`, add the field directly beneath `paidAt`:

```prisma
  paidAt         DateTime?
  notChargedAt   DateTime?
```

- [ ] **Step 5: Generate the migration**

Run: `npx prisma migrate dev --name payment_not_charged`

Then open the generated `migration.sql` and confirm it contains both statements and **no use of the new literal**:

```sql
-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'not_charged';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "notChargedAt" TIMESTAMP(3);
```

PostgreSQL forbids *using* a new enum value in the transaction that added it, and Prisma wraps migrations in one. No backfill is needed — existing rows keep their status. If the generated file contains any statement referencing `'not_charged'` as a value, stop and report it.

- [ ] **Step 6: Add the member to the `Record` tether**

In `src/lib/payment-status.ts:29-33`:

```ts
const PAYMENT_STATUSES: Record<PaymentStatus, true> = {
  pending: true,
  paid: true,
  overdue: true,
  not_charged: true,
};
```

- [ ] **Step 7: Add the `isOutstanding` predicate**

Append to `src/lib/payment-status.ts`:

```ts
/**
 * The one question the rest of the app asks about a payment status: is this
 * money still owed?
 *
 * An exhaustive `switch` with a `never` default rather than an inline
 * comparison, because the sites this replaced were `!== 'paid'` and
 * `!isPaid` — predicates that keep compiling when a member is added and
 * silently pick a side. `settings/payments/page.tsx` put an unrecognised
 * member into Outstanding and its € total; `bookings/page.tsx` showed the
 * student how to pay. A `switch` fails the build instead.
 *
 * Returns `false` on the impossible branch because that is the safe default
 * at every call site: an unknown status is not dunned and is not shown a
 * payment instruction. `console.error`, not `lib/log.ts` — that module is
 * pino and server-only, and this one is reached from `'use client'` code.
 */
export function isOutstanding(status: PaymentStatus): boolean {
  switch (status) {
    case 'pending':
    case 'overdue':
      return true;
    case 'paid':
    case 'not_charged':
      return false;
    default: {
      const unhandled: never = status;
      console.error('[payment-status] unhandled payment status', {
        status: String(unhandled),
      });
      return false;
    }
  }
}
```

- [ ] **Step 8: Add the two copy branches**

In `src/lib/format.ts`, add to `paymentStateText` immediately after the `'pending'` line and before the `never` block:

```ts
  if (status === 'not_charged') return { label: '⊘ Not charged', className: 'text-brown-light' };
```

And to `paymentStateInlineText`, after its `'pending'` line:

```ts
  if (status === 'not_charged') return { label: ' · ⊘ not charged', className: 'text-brown-light' };
```

Then update the docblock above `paymentStateText`, which currently lists only three states, to name the fourth. Do not write "this previously said three" — state what is true now.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/payment-status.test.ts src/lib/format.test.ts`
Expected: PASS, including every pre-existing assertion on the original three labels.

- [ ] **Step 10: Prove the tethers actually bite (mutation)**

A passing `tsc` on unchanged code demonstrates nothing about a guard. Temporarily add a fifth member to `prisma/schema.prisma`:

```prisma
enum PaymentStatus {
  pending
  paid
  overdue
  not_charged
  refunded
}
```

Run: `npx prisma generate && npx tsc --noEmit`

Expected: FAIL at **four** sites — record the exact error text for each in the commit message:
1. `src/lib/payment-status.ts` — `PAYMENT_STATUSES` missing property `refunded`
2. `src/lib/payment-status.ts` — `isOutstanding`, `Type 'PaymentStatus' is not assignable to type 'never'`
3. `src/lib/format.ts` — `paymentStateText`, same `never` error
4. `src/lib/format.ts` — `paymentStateInlineText`, same `never` error

Then **revert the fifth member**, run `npx prisma generate` again, and confirm `npx tsc --noEmit` is clean. **Do not create a migration for the mutation.** If fewer than four sites fail, the tether under-covers and you must report it rather than proceed.

- [ ] **Step 11: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/payment-status.ts src/lib/payment-status.test.ts src/lib/format.ts src/lib/format.test.ts
git commit -m "feat(payments): add not_charged status, notChargedAt, and the isOutstanding predicate

Mutation-proven: adding a fifth enum member fails tsc at four sites
(PAYMENT_STATUSES, isOutstanding, and both format.ts never guards), reverted
and re-verified clean."
```

---

### Task 2: The service transitions and the API route

**Files:**
- Modify: `src/services/payments.ts:144-164` (rename + widen), append new function
- Create: `src/app/api/payments/[id]/not-charged/route.ts`
- Modify: `src/app/api/payments/[id]/unpaid/route.ts:10,36` (import + call the renamed function)
- Test: `src/services/payments.test.ts`, `src/services/payment-reminders.test.ts`, `tests/integration/payments-api.test.ts`

**Interfaces:**
- Consumes: `PaymentStatus.not_charged` and `Payment.notChargedAt` from Task 1.
- Produces:
  - `markPaymentNotCharged(db: PrismaClient, paymentId: string): Promise<PaymentResult>` in `src/services/payments.ts`
  - `reopenPayment(db: PrismaClient, paymentId: string): Promise<PaymentResult>` — the renamed `unmarkPaymentPaid`, now accepting both settled states
  - `POST /api/payments/[id]/not-charged` — no request body, 404 / 403 / 409 / 200
  - `PaymentResult` is unchanged: `{ ok: true; payment: Payment } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing service tests**

Append to `src/services/payments.test.ts`. Follow the fixture helpers already used in that file for creating a teacher, class, registration and payment.

```ts
describe('markPaymentNotCharged', () => {
  it('settles a pending payment and stamps notChargedAt', async () => {
    const payment = await makePayment('pending');
    const result = await markPaymentNotCharged(prisma, payment.id);
    expect(result.ok).toBe(true);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('not_charged');
    expect(row.notChargedAt).not.toBeNull();
    expect(row.paidAt).toBeNull();
  });

  it('settles an overdue payment', async () => {
    const payment = await makePayment('overdue');
    expect((await markPaymentNotCharged(prisma, payment.id)).ok).toBe(true);
  });

  it('refuses a paid payment — that would be a refund', async () => {
    const payment = await makePayment('paid');
    const result = await markPaymentNotCharged(prisma, payment.id);
    expect(result).toEqual({
      ok: false,
      error: 'Cannot mark as not charged: current status is "paid". Must be "pending" or "overdue".',
    });
  });

  it('refuses a payment that is already not charged', async () => {
    const payment = await makePayment('not_charged');
    const result = await markPaymentNotCharged(prisma, payment.id);
    expect(result.ok).toBe(false);
  });
});

describe('reopenPayment', () => {
  it('returns a paid payment to pending, clearing method and paidAt', async () => {
    const payment = await makePayment('paid');
    expect((await reopenPayment(prisma, payment.id)).ok).toBe(true);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('pending');
    expect(row.paidAt).toBeNull();
    expect(row.method).toBeNull();
  });

  it('returns a not-charged payment to pending, clearing notChargedAt', async () => {
    const payment = await makePayment('not_charged');
    expect((await reopenPayment(prisma, payment.id)).ok).toBe(true);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.status).toBe('pending');
    expect(row.notChargedAt).toBeNull();
  });

  it('refuses a payment that is already outstanding', async () => {
    const payment = await makePayment('pending');
    const result = await reopenPayment(prisma, payment.id);
    expect(result).toEqual({
      ok: false,
      error: 'Cannot undo: current status is "pending". Must be "paid" or "not charged".',
    });
  });
});
```

- [ ] **Step 2: Write the failing dunning tests**

Append to `src/services/payment-reminders.test.ts`. These pass by construction once Task 1 lands — they exist so a later change to those filters cannot quietly start dunning forgiven money.

```ts
it('never sweeps a not-charged payment to overdue, however old', async () => {
  const payment = await makeAgedPayment('not_charged', 30); // 30 days old
  await markOverduePayments(prisma);
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(row.status).toBe('not_charged');
});

it('never reminds on a not-charged payment', async () => {
  const payment = await makeAgedPayment('not_charged', 30);
  const reminded = await sendPaymentReminders(prisma);
  const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  expect(row.reminderSentAt).toBeNull();
  expect(reminded).toBe(0);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/payments.test.ts`
Expected: FAIL — `markPaymentNotCharged` and `reopenPayment` are not exported.

- [ ] **Step 4: Rename and widen the reversal**

In `src/services/payments.ts`, replace `unmarkPaymentPaid` (currently `:136-164`) with:

```ts
/**
 * Return a settled payment to outstanding: paid or not_charged → pending,
 * clearing whichever settlement fields were set.
 *
 * Returns to 'pending' (not 'overdue') deliberately — the dunning sweep
 * (`markOverduePayments`) re-derives overdue from the payment's age, so an old
 * payment self-heals back to overdue on the sweep's next tick. `lib/scheduler.ts`
 * registers that job (`payment-reminders`) at `60 * MINUTE`, so the window is an
 * hour.
 *
 * One function for both settled states because they reverse identically: both
 * mean "this is no longer owed", and undoing either means "it is owed again".
 */
export async function reopenPayment(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentResult> {
  const result = await db.payment.updateMany({
    where: { id: paymentId, status: { in: ['paid', 'not_charged'] } },
    data: { status: 'pending', method: null, paidAt: null, notChargedAt: null },
  });

  if (result.count === 0) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };
    return {
      ok: false,
      error: `Cannot undo: current status is "${payment.status}". Must be "paid" or "not charged".`,
    };
  }

  const updated = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { ok: true, payment: updated };
}
```

- [ ] **Step 5: Add the new transition**

Append to `src/services/payments.ts`, directly after `reopenPayment`:

```ts
/**
 * The grace policy of `docs/product-concept.md:142`: the teacher chooses not to
 * collect. A settled state like `paid` — no longer outstanding, never dunned —
 * that differs from it in the one respect that matters to the money: nothing
 * arrived. `reopenPayment` is the reversal.
 *
 * `reminderSentAt` is deliberately left alone. A reminder that was sent was
 * sent, and the row's history stays true.
 *
 * Conditional update for the same reason `markPaymentPaid` uses one: the status
 * guard lives in the WHERE clause so a double submission cannot both pass a
 * pre-check and clobber `notChargedAt`.
 */
export async function markPaymentNotCharged(
  db: PrismaClient,
  paymentId: string,
): Promise<PaymentResult> {
  const result = await db.payment.updateMany({
    where: { id: paymentId, status: { in: ['pending', 'overdue'] } },
    data: { status: 'not_charged', notChargedAt: new Date() },
  });

  if (result.count === 0) {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return { ok: false, error: `Payment not found: ${paymentId}` };
    return {
      ok: false,
      error: `Cannot mark as not charged: current status is "${payment.status}". Must be "pending" or "overdue".`,
    };
  }

  const updated = await db.payment.findUniqueOrThrow({ where: { id: paymentId } });
  return { ok: true, payment: updated };
}
```

- [ ] **Step 6: Point the existing route at the renamed function**

In `src/app/api/payments/[id]/unpaid/route.ts`, change the import on `:10` to `import { reopenPayment } from '@/services/payments';` and the call on `:36` to `await reopenPayment(prisma, id)`. Update the docblock on `:12` to say it undoes a mistaken "mark paid" **or** "not charged". The URL does not change — the payment becomes unpaid again either way.

Then sweep for any other caller of the old name — `grep -rn "unmarkPaymentPaid" src tests` — and give every hit a verdict. Expect hits in comments (`use-payment-actions.ts:86`, `mark-unpaid-button.tsx`) that name the function in prose; those are stale references to a name that no longer exists and must be corrected too.

- [ ] **Step 7: Create the new route**

Create `src/app/api/payments/[id]/not-charged/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { markPaymentNotCharged } from '@/services/payments';

/**
 * The teacher chooses not to collect — same ownership chain as /paid and
 * /unpaid. No request body: unlike /paid there is no `method` to record,
 * because no money moved.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        include: { class: { select: { calendarEntry: { select: { teacherId: true } } } } },
      },
    },
  });

  if (!payment) return respondError('Payment not found', 404);
  if (payment.registration.class.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  const result = await markPaymentNotCharged(prisma, id);
  if (!result.ok) return respondError(result.error, 409);
  return respondOk(result.payment);
});
```

- [ ] **Step 8: Write the failing integration tests**

Append to `tests/integration/payments-api.test.ts`, following that file's existing session and `freshIp()` helpers:

```ts
it('marks a payment not charged', async () => {
  const res = await post(`/api/payments/${paymentId}/not-charged`, teacherSession);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.status).toBe('not_charged');
});

it('409s a payment that is already not charged', async () => {
  await post(`/api/payments/${paymentId}/not-charged`, teacherSession);
  const res = await post(`/api/payments/${paymentId}/not-charged`, teacherSession);
  expect(res.status).toBe(409);
});

it('403s another teacher', async () => {
  const res = await post(`/api/payments/${paymentId}/not-charged`, otherTeacherSession);
  expect(res.status).toBe(403);
});

it('404s an unknown payment', async () => {
  const res = await post('/api/payments/00000000-0000-0000-0000-000000000000/not-charged', teacherSession);
  expect(res.status).toBe(404);
});

it('does not disclose tier or price fields', async () => {
  const res = await post(`/api/payments/${paymentId}/not-charged`, teacherSession);
  const body = await res.json();
  expect(Object.keys(body.data).sort()).toEqual([
    'amount', 'createdAt', 'id', 'method', 'notChargedAt', 'paidAt',
    'processorRef', 'registrationId', 'reminderSentAt', 'status', 'updatedAt',
  ]);
});

it('reverses a not-charged payment through /unpaid', async () => {
  await post(`/api/payments/${paymentId}/not-charged`, teacherSession);
  const res = await post(`/api/payments/${paymentId}/unpaid`, teacherSession);
  expect(res.status).toBe(200);
  expect((await res.json()).data.status).toBe('pending');
});
```

The key-allowlist assertion mirrors the existing ones at `:127`, `:155`, `:187` — it is how this repo catches a widened `select`, and `notChargedAt` joining the row is exactly the kind of change it exists to notice.

- [ ] **Step 9: Run all the tests**

Run: `npx vitest run --project unit src/services/payments.test.ts`
Run: `npx vitest run --project unit-sweeps src/services/payment-reminders.test.ts`
Run: `npx vitest run --project integration tests/integration/payments-api.test.ts`

Warm the new route first — `next dev` compiles lazily and the first request's compile time reads exactly like an assertion failure:
`curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/payments/x/not-charged`

Expected: PASS.

- [ ] **Step 10: Prove the CAS bites (mutation)**

Temporarily widen `markPaymentNotCharged`'s `where` to `status: { in: ['pending', 'overdue', 'paid'] }`. Re-run `npx vitest run --project unit src/services/payments.test.ts`. Expected: the "refuses a paid payment" test FAILS. Record the error text, then restore. A refusal test that passes against a widened guard certifies nothing.

- [ ] **Step 11: Commit**

```bash
git add src/services/payments.ts src/services/payments.test.ts src/services/payment-reminders.test.ts "src/app/api/payments/[id]/not-charged/route.ts" "src/app/api/payments/[id]/unpaid/route.ts" tests/integration/payments-api.test.ts
git commit -m "feat(payments): markPaymentNotCharged, and reopenPayment reversing both settled states

unmarkPaymentPaid renamed to reopenPayment and its CAS widened to accept
not_charged: both settled states reverse identically, to pending, letting the
hourly sweep re-derive overdue. CAS mutation-proven."
```

---

### Task 3: The three teacher-side two-state gates

Three sites read `isPaid` and treat its negation as meaningful. Two of them render a control that a `not_charged` payment makes visible, enabled, and guaranteed to 409.

**Files:**
- Modify: `src/components/schedule/class-list.tsx:66-82`
- Modify: `src/components/class/payment-checklist.tsx:64-65`, `:99-101`
- Modify: `src/components/students/student-payment-list.tsx:37-38`, `:52-71`
- Test: `src/components/schedule/class-list.test.tsx`, `src/components/class/payment-checklist.test.tsx`, `src/components/students/student-payment-list.test.tsx`

**Interfaces:**
- Consumes: `isOutstanding` and `paymentStateText` from Task 1.
- Produces: no new exported symbols.

- [ ] **Step 1: Write the failing tests**

To `src/components/schedule/class-list.test.tsx`:

```ts
it('reports not charged rather than a false "all paid"', () => {
  renderClassList([completedClassWith([{ status: 'not_charged' }, { status: 'not_charged' }])]);
  expect(screen.getByText(/⊘ 2 not charged/)).toBeInTheDocument();
  expect(screen.queryByText(/✓ all paid/)).not.toBeInTheDocument();
});

it('still reports all paid when every payment really is paid', () => {
  renderClassList([completedClassWith([{ status: 'paid' }, { status: 'paid' }])]);
  expect(screen.getByText(/✓ all paid/)).toBeInTheDocument();
});

it('ranks outstanding above not charged', () => {
  renderClassList([completedClassWith([{ status: 'pending' }, { status: 'not_charged' }])]);
  expect(screen.getByText(/○ 1 unpaid/)).toBeInTheDocument();
});
```

To `src/components/class/payment-checklist.test.tsx`:

```ts
it('offers no mark-paid control on a not-charged payment', () => {
  renderChecklist([{ paymentId: 'p1', studentName: 'Anna Smith', status: 'not_charged', amount: 12 }]);
  expect(screen.queryByRole('button', { name: /Mark paid/i })).not.toBeInTheDocument();
  expect(screen.getByText('⊘ Not charged')).toBeInTheDocument();
});
```

To `src/components/students/student-payment-list.test.tsx`:

```ts
it('offers no mark-paid control on a not-charged payment', () => {
  renderList([{ paymentId: 'p1', classType: 'Vinyasa', classDate: 'Tue 2 Sep', status: 'not_charged', amount: 12 }]);
  expect(screen.queryByRole('button', { name: /Mark paid/i })).not.toBeInTheDocument();
});

it('gives each mark-paid button a distinct accessible name', () => {
  renderList([
    { paymentId: 'p1', classType: 'Vinyasa', classDate: 'Tue 2 Sep', status: 'pending', amount: 12 },
    { paymentId: 'p2', classType: 'Yin', classDate: 'Thu 4 Sep', status: 'pending', amount: 10 },
  ]);
  expect(screen.getByRole('button', { name: 'Mark paid — Vinyasa, Tue 2 Sep' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Mark paid — Yin, Thu 4 Sep' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components src/components/schedule/class-list.test.tsx src/components/class/payment-checklist.test.tsx src/components/students/student-payment-list.test.tsx`
Expected: FAIL — `✓ all paid` renders for the not-charged class, both Mark paid buttons render, and the two accessible names are both the bare string `Mark paid`.

- [ ] **Step 3: Add the rollup's fourth branch**

In `src/components/schedule/class-list.tsx`, inside `PaymentRollup` after the `unpaid` count:

```ts
  const notCharged = payments.filter((p) => p.status === 'not_charged').length;
  if (overdue > 0) {
    return <span className="text-danger font-medium"> · ! {overdue} overdue</span>;
  }
  if (unpaid > 0) {
    return <span className="text-brown"> · ○ {unpaid} unpaid</span>;
  }
  if (notCharged > 0) {
    return <span className="text-brown-light"> · ⊘ {notCharged} not charged</span>;
  }
  return <span className="text-teal font-medium"> · ✓ all paid</span>;
```

Then update the comment above `PaymentRollup` (`:63-65`), which lists the three outcomes, to name the fourth.

- [ ] **Step 4: Fix the checklist's gate**

In `src/components/class/payment-checklist.tsx`, replace the two local derivations at `:64-65` with the shared predicate, importing `isOutstanding` from `@/lib/payment-status`:

```ts
const isPaid = status === 'paid';
const outstanding = isOutstanding(status);
```

Then gate the mark-paid button on `outstanding` rather than `!isPaid` — wrap the whole `<button>` at `:99-121` in `{outstanding && ( … )}` and drop the now-redundant `isPaid` arms inside it, keeping the `disabled={isUpdating}` and the unpaid `aria-label`. The paid state is already rendered as text by `stateText` at `:79-80`, so nothing is lost. Replace the remaining `isOutstanding` usage that gates `SendReminderButton` with `outstanding`.

- [ ] **Step 5: Fix the student list's gate and its accessible names**

In `src/components/students/student-payment-list.tsx`, import `isOutstanding` and replace `:38`:

```ts
const outstanding = isOutstanding(status);
```

Gate the mark-paid button on `outstanding` instead of `!isPaid` at `:52`, and give both buttons a disambiguating accessible name — the defect #128 and #129 closed on the other two surfaces and missed here. The visible text must lead the accessible name (WCAG 2.5.3):

```tsx
aria-label={`Mark paid — ${item.classType}, ${item.classDate}`}
```

and on the Undo button:

```tsx
aria-label={`Undo marking ${item.classType}, ${item.classDate} as paid`}
```

Keep `isPaid` where it still gates the amount's brown styling at `:51`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/schedule/class-list.test.tsx src/components/class/payment-checklist.test.tsx src/components/students/student-payment-list.test.tsx`
Expected: PASS, with every pre-existing assertion in those three files still green.

- [ ] **Step 7: Prove the rollup guard bites (mutation)**

Remove the `notCharged` branch from `PaymentRollup` and re-run `class-list.test.tsx`. Expected: the "reports not charged" test FAILS with `✓ all paid` found — the false all-clear returning. Record the text, restore.

- [ ] **Step 8: Commit**

```bash
git add src/components/schedule/class-list.tsx src/components/schedule/class-list.test.tsx src/components/class/payment-checklist.tsx src/components/class/payment-checklist.test.tsx src/components/students/student-payment-list.tsx src/components/students/student-payment-list.test.tsx
git commit -m "fix(payments): three teacher surfaces assumed paid was the only way to settle

class-list's rollup claimed '✓ all paid' for a class where nothing was paid.
payment-checklist and student-payment-list each rendered an enabled 'Mark paid'
that markPaymentPaid's CAS refuses. Folds in student-payment-list's missing
accessible names — #128/#129's missed third surface, in a file this gate fix
opens anyway."
```

---

### Task 4: The student surface

The defect fix. `/bookings` currently shows the teacher's IBAN and a scannable EPC QR code for money that has been forgiven.

**Files:**
- Modify: `src/app/(student)/bookings/page.tsx:266`, `:278`, `:288`, `:290`
- Test: `tests/integration/bookings-page.test.ts` (create)

**Interfaces:**
- Consumes: `isOutstanding` from Task 1.
- Produces: no new exported symbols.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/bookings-page.test.ts`, following the session and fixture patterns in `tests/integration/student-detail-page.test.ts`. Seed a teacher with a `bankIban`, a completed class, and a registration whose payment is `not_charged`.

```ts
it('tells a student their payment was not charged, and stops asking for it', async () => {
  const html = await getPage('/bookings', studentSession);
  expect(html).toContain('⊘ Not charged');
  expect(html).not.toContain('How to pay');
  expect(html).not.toContain(TEACHER_IBAN);
});

it('still shows an unpaid student how to pay', async () => {
  await setPaymentStatus(paymentId, 'pending');
  const html = await getPage('/bookings', studentSession);
  expect(html).toContain('○ Unpaid');
  expect(html).toContain('How to pay');
  expect(html).toContain(TEACHER_IBAN);
});
```

Asserting the absence of the IBAN string is the point. A test that checked only for the `⊘ Not charged` label would pass against the unfixed gate, because the label and the disclosure render independently.

- [ ] **Step 2: Run the test to verify it fails**

Warm the route first: `curl -s -o /dev/null http://localhost:3000/bookings`
Run: `npx vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: FAIL — the page contains "How to pay" and the IBAN for a not-charged payment.

- [ ] **Step 3: Gate the disclosure and the styling on `isOutstanding`**

In `src/app/(student)/bookings/page.tsx`, import `isOutstanding` from `@/lib/payment-status`. At `:266`, keep `isPaid` only if something still needs it; otherwise replace the derivation with:

```tsx
const outstanding = payment ? isOutstanding(payment.status) : false;
```

At `:278`, the amount's styling becomes:

```tsx
<p className={`type-number ${outstanding ? 'text-brown' : ''}`}>
```

At `:288`, the disclosure's gate becomes:

```tsx
{payment && outstanding && (
```

- [ ] **Step 4: Fold in the disclosure's missing accessible name**

Every past class renders a `<summary>` reading "How to pay", so a student with three unpaid classes gets three identical controls — the same defect as #128/#129, in the expression this task is already editing. At `:290`:

```tsx
<summary
  className="type-label text-teal cursor-pointer"
  aria-label={`How to pay — ${cls.calendarEntry.classType}, ${formatDayHeader(cls.calendarEntry.date)}`}
>
  How to pay
</summary>
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the gate bites (mutation)**

Revert `:288` to `{payment && !isPaid && (` and re-run. Expected: the first test FAILS on the IBAN assertion. Record the text, restore.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(student)/bookings/page.tsx" tests/integration/bookings-page.test.ts
git commit -m "fix(bookings): stop showing a student how to pay money that was not charged

The How-to-pay disclosure — teacher IBAN, account name, remittance reference and
a scannable EPC QR pre-filled with the amount — was gated on !isPaid, so a
forgiven payment still solicited it. Folds in the summary's missing accessible
name, in the same expression."
```

---

### Task 5: The payments overview — positive filters, the third section, and the control

**Files:**
- Modify: `src/app/(teacher)/settings/payments/page.tsx:34-39`, `:67-108`
- Modify: `src/components/class/outstanding-payment-row.tsx:56-58`, `:76-133`
- Create: `src/components/class/not-charged-payment-row.tsx`
- Modify: `src/lib/use-payment-actions.ts`
- Test: `src/components/class/outstanding-payment-row.test.tsx`, `src/components/class/not-charged-payment-row.test.tsx` (create), `tests/integration/payments-overview-page.test.ts` (create)

**Interfaces:**
- Consumes: `isOutstanding` (Task 1), `POST /api/payments/[id]/not-charged` (Task 2).
- Produces:
  - `usePaymentActions` returns an additional `markNotCharged(paymentId: string): Promise<void>`
  - `NotChargedPaymentRow` component, props `{ paymentId, studentName, classType, classDate, startTime, notChargedAt, timeZone, amount }` — the same shape as `ReceivedPaymentRow` with `paidAt` replaced by `notChargedAt`
  - `OutstandingPaymentRow` gains no new props; it reads `markNotCharged` from the hook it already uses

- [ ] **Step 1: Write the failing integration test for the totals**

Create `tests/integration/payments-overview-page.test.ts`. Seed one teacher with three payments on completed classes: one `paid` at 20.00, one `pending` at 12.00, one `not_charged` at 15.00.

```ts
it('keeps not-charged money out of both totals and gives it its own section', async () => {
  const html = await getPage('/settings/payments', teacherSession);
  expect(html).toContain('€12.00');        // Outstanding total — not 27.00
  expect(html).not.toContain('€27.00');
  expect(html).toContain('€20.00');        // Received total — not 35.00
  expect(html).not.toContain('€35.00');
  expect(html).toContain('Not charged');   // the third section heading
  expect(html).toContain('⊘ Not charged');
});

it('counts only outstanding payments in the outstanding caption', async () => {
  const html = await getPage('/settings/payments', teacherSession);
  expect(html).toContain('1 payment');
  expect(html).not.toContain('2 payments');
});
```

**This is the assertion that fails against `page.tsx:34`'s `!== 'paid'`** and is the single most important test on the branch.

- [ ] **Step 2: Run it to verify it fails**

Warm: `curl -s -o /dev/null http://localhost:3000/settings/payments`
Run: `npx vitest run --project integration tests/integration/payments-overview-page.test.ts`
Expected: FAIL — the outstanding total is 27.00 and the caption reads "2 payments".

- [ ] **Step 3: Make all three filters positive**

In `src/app/(teacher)/settings/payments/page.tsx`, import `isOutstanding` and replace `:34-39`:

```ts
const outstanding = payments.filter((p) => isOutstanding(p.status));
const receivedAll = payments.filter((p) => p.status === 'paid');
const received = receivedAll.slice(0, 30);
const notCharged = payments.filter((p) => p.status === 'not_charged').slice(0, 30);
const outstandingTotal = outstanding.reduce((sum, p) => sum + Number(p.amount), 0);
const receivedTotal = receivedAll.reduce((sum, p) => sum + Number(p.amount), 0);
```

The two tiles are unchanged: Outstanding and Received keep their labels and their numbers. "Received" keeps meaning money-in, strictly.

- [ ] **Step 4: Add the third section**

Beneath the existing Received section in the same file:

```tsx
<section className="mt-8">
  <h2 className="type-subtitle mb-1">Not charged</h2>
  {notCharged.length === 0 ? (
    <EmptyState title="Nothing waived" body="Payments you choose not to collect appear here." />
  ) : (
    notCharged.map((p) => (
      <NotChargedPaymentRow
        key={p.id}
        paymentId={p.id}
        studentName={studentName(p)}
        classType={p.registration.class.calendarEntry.classType}
        classDate={p.registration.class.calendarEntry.date}
        startTime={p.registration.class.calendarEntry.startTime}
        notChargedAt={p.notChargedAt}
        timeZone={session.defaultTimezone}
        amount={Number(p.amount)}
      />
    ))
  )}
</section>
```

Render the whole `<section>` only when `notCharged.length > 0` — a teacher who has never waived anything should not see an empty section for a feature they do not use.

- [ ] **Step 5: Create the row component**

Create `src/components/class/not-charged-payment-row.tsx`, modelled on `received-payment-row.tsx`:

```tsx
import { formatClassContext, formatDateShort, paymentStateText } from '@/lib/format';
import { startOfLocalDay } from '@/lib/timezone';
import { MarkUnpaidButton } from '@/components/class/mark-unpaid-button';

interface NotChargedPaymentRowProps {
  paymentId: string;
  studentName: string;
  classType: string;
  classDate: Date;
  startTime: Date;
  /**
   * The raw instant, deliberately not pre-formatted — `startOfLocalDay` runs
   * here so the conversion sits inside the tested unit. Same reasoning as
   * `ReceivedPaymentRow`'s `paidAt`; see #140, #154.
   */
  notChargedAt: Date | null;
  timeZone: string;
  amount: number;
}

/**
 * One Not charged row on the payments overview.
 *
 * `MarkUnpaidButton` is the reversal here exactly as it is on a Received row:
 * both states mean "no longer owed", and undoing either means "owed again".
 */
export function NotChargedPaymentRow({
  paymentId,
  studentName,
  classType,
  classDate,
  startTime,
  notChargedAt,
  timeZone,
  amount,
}: NotChargedPaymentRowProps) {
  const classContext = formatClassContext(classType, classDate, startTime);
  const stateText = paymentStateText('not_charged');
  return (
    <div className="flex items-center justify-between gap-3 min-h-14 py-2 border-b border-border last:border-b-0">
      <div className="min-w-0">
        <p className="text-base text-ink">{studentName}</p>
        <p className="type-caption">
          {classContext}
          {notChargedAt && <> · {formatDateShort(startOfLocalDay(notChargedAt, timeZone))}</>}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className={`type-caption ${stateText.className}`}>{stateText.label}</span>
        <span className="type-number">€{amount.toFixed(2)}</span>
        <MarkUnpaidButton
          paymentId={paymentId}
          studentName={studentName}
          classContext={classContext}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Add the hook action**

In `src/lib/use-payment-actions.ts`, add alongside `markPaid`, following its exact error-handling shape (only the request wrapped, so 'Network error' means exactly that):

```ts
  async function markNotCharged(paymentId: string) {
    setUpdating(paymentId);
    setError('');
    try {
      let res: Response;
      try {
        res = await fetch(`/api/payments/${paymentId}/not-charged`, { method: 'POST' });
      } catch (err) {
        console.error('[payment-not-charged] request failed', { paymentId, err });
        setError('Network error. Try again.');
        return;
      }

      if (res.ok) {
        setPaymentState((prev) => ({ ...prev, [paymentId]: 'not_charged' }));
        setJustMarked((prev) => new Set(prev).add(paymentId));
      } else {
        setError(await readErrorMessage(res, 'Could not mark as not charged. Try again.'));
      }
    } finally {
      setUpdating(null);
    }
  }
```

Add `markNotCharged` to the returned object. `undo` needs no change: it POSTs `/unpaid`, which `reopenPayment` now accepts from both settled states.

- [ ] **Step 7: Write the failing component tests**

Append to `src/components/class/outstanding-payment-row.test.tsx`:

```ts
it('gives each not-charged action a distinct accessible name', () => {
  renderTwoRows();
  expect(screen.getByRole('button', { name: 'Not charged — Anna Smith, Vinyasa Tue 2 Sep 18:00' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Not charged — Ben Jones, Yin Thu 4 Sep 19:00' })).toBeInTheDocument();
});

it('marks not charged and offers a transient undo', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) }));
  renderRow({ status: 'pending' });
  fireEvent.click(screen.getByRole('button', { name: /^Not charged —/ }));
  await waitFor(() => expect(screen.getByText('⊘ Not charged')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /Undo marking Anna Smith/ })).toBeInTheDocument();
});
```

Create `src/components/class/not-charged-payment-row.test.tsx`:

```tsx
const baseProps = {
  paymentId: 'pay-1',
  studentName: 'Anna Smith',
  classType: 'Vinyasa',
  classDate: new Date('2026-09-02T00:00:00Z'),
  startTime: new Date('1970-01-01T18:00:00Z'),
  notChargedAt: new Date('2026-09-02T12:00:00Z'),
  timeZone: 'Europe/Amsterdam',
  amount: 15,
};

it('shows the state, the amount and the reversal', () => {
  render(<NotChargedPaymentRow {...baseProps} />);
  expect(screen.getByText('⊘ Not charged')).toBeInTheDocument();
  expect(screen.getByText('€15.00')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Mark unpaid — Anna Smith/ })).toBeInTheDocument();
});

it('renders the not-charged date in the teacher day, not UTC', () => {
  // 02:00 UTC on the 3rd is still the 2nd in Los Angeles. Without
  // startOfLocalDay this renders "3 Sep" — the #140 bug, in a new component.
  render(
    <NotChargedPaymentRow
      {...baseProps}
      notChargedAt={new Date('2026-09-03T02:00:00Z')}
      timeZone="America/Los_Angeles"
    />,
  );
  expect(screen.getByText(/2 Sep/)).toBeInTheDocument();
});

it('shows no date when the payment has none', () => {
  render(<NotChargedPaymentRow {...baseProps} notChargedAt={null} />);
  expect(screen.getByText('Vinyasa Wed 2 Sep 18:00')).toBeInTheDocument();
});
```

Check `received-payment-row.test.tsx:31-62` for the exact date fixtures and the `classDate` / `startTime` shapes that file already uses, and match them — the two components take identical prop shapes and their tests should be readable side by side.

- [ ] **Step 8: Add the action line to the outstanding row**

In `src/components/class/outstanding-payment-row.tsx`, first add the new action to the hook destructuring at `:45`:

```ts
const { paymentState, justMarked, updating, error, markPaid, markNotCharged, undo } =
  usePaymentActions({ [paymentId]: status });
```

Then replace the local `isOutstanding` derivation at `:57-58` with the shared predicate imported from `@/lib/payment-status` (rename the local to `outstanding` so it does not shadow the import), move `SendReminderButton` out of the right-hand flex group and onto a new line beneath the class caption, and add the not-charged action beside it. Both render as quiet text actions — the shape `Undo` already uses at `:104` — not pills:

```tsx
{outstanding && (
  <p className="type-caption mt-1 flex items-center gap-2">
    <SendReminderButton … />
    <span aria-hidden="true">·</span>
    <button
      type="button"
      onClick={() => markNotCharged(paymentId)}
      disabled={busy}
      className="type-caption text-teal min-h-[44px] px-1"
      // Visible text leads the accessible name for WCAG 2.5.3, matching the
      // shape the other three controls in this file use.
      aria-label={`Not charged — ${studentName}, ${classContext}`}
    >
      Not charged
    </button>
  </p>
)}
```

`Mark paid` stays where it is, as the row's one inline pill. Add a `'not_charged'` arm to the `isPaid ? … : …` ternary at `:87` so the optimistic state between the tap and the refresh renders the new label rather than falling into the Mark-paid branch.

- [ ] **Step 9: Run all the tests**

Run: `npx vitest run --project components src/components/class/outstanding-payment-row.test.tsx src/components/class/not-charged-payment-row.test.tsx`
Run: `npx vitest run --project integration tests/integration/payments-overview-page.test.ts`
Expected: PASS. Every pre-existing assertion in `outstanding-payment-row.test.tsx` — `:93`, `:112`, `:138`, `:165`, `:196`, `:215`, `:245`, `:289`, `:324` — must still be green; none of them should have needed editing, because both actions stayed directly visible.

- [ ] **Step 10: Prove the filter fix bites (mutation)**

Revert `page.tsx`'s outstanding filter to `p.status !== 'paid'` and re-run the integration test. Expected: FAIL, outstanding total 27.00 instead of 12.00. Record the text, restore.

- [ ] **Step 11: Commit**

```bash
git add "src/app/(teacher)/settings/payments/page.tsx" src/components/class/outstanding-payment-row.tsx src/components/class/outstanding-payment-row.test.tsx src/components/class/not-charged-payment-row.tsx src/components/class/not-charged-payment-row.test.tsx src/lib/use-payment-actions.ts tests/integration/payments-overview-page.test.ts
git commit -m "feat(payments): mark not charged from the payments overview

All three filters are now positive, so no future enum member can silently join
a money total — the outstanding one was !== 'paid' and would have counted
forgiven money as owed. Not-charged rows get their own section; Received keeps
meaning money-in. The two deliberate actions sit on the row's second line as
quiet text, leaving Mark paid the single primary."
```

---

### Task 6: Reporting copy, the a11y route, and e2e

**Files:**
- Modify: `src/app/(teacher)/settings/reporting/page.tsx:126`
- Modify: `tests/integration/reporting-page.test.ts:157`, `:171`
- Modify: `tests/e2e/a11y.spec.ts` (add one route block)
- Modify: `tests/e2e/teacher-journey.spec.ts` (extend the payments block)

**Interfaces:**
- Consumes: everything above.
- Produces: no new exported symbols.

- [ ] **Step 1: Change the reporting label**

`/settings/reporting` reads `Class.totalRevenue` and never a `Payment` row, so its numbers are what was *billed*. That was defensible while unpaid money was at least nominally collectable; once a teacher can mark €50 not charged and watch "Total earned teaching" not move, the label overclaims. In `src/app/(teacher)/settings/reporting/page.tsx:126`:

```tsx
<p className="type-label">Total charged for teaching</p>
```

"Charged" rather than "billed" because it is already this app's word — `pricing-breakdown.tsx:49` says "Students charged" — and it pairs directly with the new "Not charged" state. Numbers, queries and data path are untouched.

- [ ] **Step 2: Update the two assertions that pin that string**

In `tests/integration/reporting-page.test.ts`, `:157` asserts the empty state does *not* contain "Total earned teaching" and `:171` asserts it does alongside `157.00`. Update both to the new string. These are the only two occurrences — verify with `grep -rn "Total earned teaching" src tests` and confirm it returns nothing afterwards.

- [ ] **Step 3: Run the reporting test**

Run: `npx vitest run --project integration tests/integration/reporting-page.test.ts`
Expected: PASS.

- [ ] **Step 4: Add `/settings/payments` to the a11y sweep**

`tests/e2e/a11y.spec.ts` sweeps eight routes — `/login`, `/{slug}`, `/{slug}/book/{classId}`, `/bookings`, `/schedule`, `/class/{classId}`, `/inbox`, `/settings` — and `/settings/payments` is in neither that list nor the visual snapshot list. This branch adds a control and a new row type there. Add a block following the exact shape of the `/settings` one at `:205`.

- [ ] **Step 5: Extend the e2e journey**

In `tests/e2e/teacher-journey.spec.ts`, after the existing payments block at `:358-411`, add:

```ts
test('a payment can be marked not charged and put back', async ({ page }) => {
  await page.goto('/settings/payments');
  await page.getByRole('button', { name: /^Not charged — Walkin g\./ }).click();
  await expect(page.getByText('⊘ Not charged')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Not charged' })).toBeVisible();

  await page.getByRole('button', { name: /Mark unpaid — Walkin g\./ }).click();
  await page.getByRole('button', { name: /Confirm unpaid — Walkin g\./ }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Not charged' })).toBeHidden();
});
```

- [ ] **Step 6: Run the full verification**

Run: `npm run verify`

Expected: green — typecheck, lint, and all four vitest projects. Report the arithmetic that proves the integration tier ran (e.g. `N = a unit + b unit-sweeps + c components + d integration`), because `npm test` chains two invocations with `&&`: one red unit test means the second never runs and `integration` reports *nothing*, not zero failures. If anything earlier is red, run `npx vitest run --project integration` directly rather than reading a red `verify` as evidence about that tier.

Then run Playwright: `npx playwright test tests/e2e/teacher-journey.spec.ts tests/e2e/a11y.spec.ts`

- [ ] **Step 7: Commit**

```bash
git add "src/app/(teacher)/settings/reporting/page.tsx" tests/integration/reporting-page.test.ts tests/e2e/a11y.spec.ts tests/e2e/teacher-journey.spec.ts
git commit -m "feat(reporting): say charged, not earned — and sweep the payments route for a11y

/settings/reporting reads Class.totalRevenue and never a Payment row, so its
numbers are what was billed. That was defensible while unpaid money was at least
nominally collectable; a teacher who marks 50 EUR not charged and sees 'Total
earned teaching' hold still is being told something false. The numbers and the
data path are unchanged."
```

---

## Final sweep before the PR

- [ ] **Sweep for what this branch invalidated, not only what it edited.** `grep -rn "unmarkPaymentPaid\|Total earned teaching" src tests docs` must return nothing. Then `grep -rn "pending.*paid.*overdue\|three states\|pending | paid | overdue" docs src` and give every hit a verdict — `docs/data-model.md:414` describes the status column as `pending → paid / overdue` and is now wrong.
- [ ] **A grep finds a stale name, never a stale description.** Read the whole docblock of every function this branch touched — `markPaymentPaid`, `sendPaymentReminder`, `getOutstandingPayments`, `usePaymentActions`, `MarkUnpaidButton` — and check each against what its code now does. `usePaymentActions:8-15` and `mark-unpaid-button.tsx:14-19` both describe a two-state world.
- [ ] **Update `docs/data-model.md`** — the `Payment` table at `:406-424` needs the new status and the `notChargedAt` row.
- [ ] **Update `CLAUDE.md`'s Payment Model section** if the four-state lifecycle belongs there.
- [ ] **PR body:** record the premise correction (reporting never reads `Payment`), the `.amount` census arithmetic, the five two-state sites and which two were created rather than revealed, every mutation proof with its error text, and name by path the integration files touched. Write "**#386 is unaffected**" — never the auto-close phrasing, even negated or quoted.
