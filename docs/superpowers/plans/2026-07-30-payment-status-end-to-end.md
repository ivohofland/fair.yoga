# PaymentStatus End To End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry `PaymentStatus` through `usePaymentActions` and its three consumers so the UI-gating comparisons are compiler-checked, and replace the undo response's unchecked cast with a real type guard (#58).

**Architecture:** The hook stops being `Record<string, string>` and becomes `Record<string, PaymentStatus>`. Its one untyped value — the undo response — gets a runtime guard rather than an assertion, and the guard plus its reader live in a module of their own (`src/lib/payment-status.ts`) so their tests reach a real public surface instead of a test-only export. Two boundaries that re-widen the same type (`StudentPaymentItem.status`, `paymentStateText`) are tightened in the same change, the second gaining a `never` exhaustiveness guard that logs and falls back rather than throwing. A fifth widening — `class-list.tsx`'s `ClassWithDetails.registrations`, which the spec documents at `:32` and which was found only by the final whole-branch review — is Task 3.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess` on), React client components, Vitest `unit` project (node) and `components` project (jsdom + Testing Library).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, **no type assertions to silence a type error**, no eslint suppressions. This change exists to remove an assertion — do not add one.
- **`import type` for `@prisma/client` in any `'use client'` file.** Every Prisma import in a client file in this repo is type-only. A value import would be the first and risks pulling the Prisma runtime into the browser bundle.
- **`Set.has`, not `Object.hasOwn`.** `tsc` accepts `Object.hasOwn` because `lib` includes `esnext`, but `target` is `ES2017` and a library method is not downleveled. `Set` is ES2015.
- **`paymentStateText`'s labels and classNames must come out byte-identical.** `'✓ Paid'` / `'text-teal'`, `'! Overdue'` / `'text-danger font-medium'`, `'○ Unpaid'` / `''`. Three surfaces render these, one student-facing.
- ~~**Do not change the `?? 'pending'` / `?? status` fallbacks.** Out of scope — existing behaviour.~~ **Reversed in review, with the repo owner's explicit approval.** The constraint held while this was a types-only change; the review made it untenable to leave standing. `payment-checklist.tsx` and `student-payment-list.tsx` fabricated `'pending'` while `item.status` — the server's own value — sat unused in the same scope, and `outstanding-payment-row.tsx:55` already did it correctly with `?? status`. Two of the three files disagreeing about what an unknown row means is not "existing behaviour" worth preserving; the two now match the one. It is reachable, not theoretical: `usePaymentActions` seeds from `items` through `useState`, which ignores later arguments, so a payment appearing after mount (a `router.refresh()` re-renders these without remounting) had no entry — and an overdue one rendered as the calm "○ Unpaid". Covered by a component test per file, each mutation-verified.
- **Do not modify `prisma/schema.prisma`** except transiently in Task 2's mutation step, which must be reverted. **Never create a migration for it.**
- **Never restart the dev server on `:3000`.** It is managed manually by the repo owner.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `src/lib/use-payment-actions.ts` | `PaymentStatus` throughout; replace the cast; `undo` treats a committed mutation with an unreadable body as success | 1 |
| `src/lib/payment-status.ts` | **New** — `isPaymentStatus` + `readUndoStatus`, and the `Record`-pinned member list behind them | 1 |
| `src/lib/payment-status.test.ts` | **New** — unit tests for the two pure functions | 1 |
| `src/components/students/student-payment-list.tsx` | `StudentPaymentItem.status: string` → `PaymentStatus`; `?? item.status` | 1 |
| `src/components/students/student-payment-list.test.tsx` | **New** — the fallback reads the item's own status | 1 |
| `src/components/class/payment-checklist.tsx` | `?? item.status` | 1 |
| `src/components/class/payment-checklist.test.tsx` | **New** — the fallback reads the item's own status | 1 |
| `src/components/class/outstanding-payment-row.test.tsx` | Two undo round-trip tests, plus the unreadable-body case | 1 |
| `src/lib/format.ts` | `paymentStateText(status: PaymentStatus)` + `never` guard that logs and falls back | 2 |
| `src/lib/format.test.ts` | **First** `paymentStateText` tests | 2 |
| `src/components/schedule/class-list.tsx` | `ClassWithDetails.registrations` and the `.filter` narrowing → `PaymentStatus` | 3 |
| `src/components/schedule/class-list.test.tsx` | **New** — `PaymentRollup`'s priority order and both guards | 3 |

**Three tasks, and the split is not arbitrary.** Task 1 must land as one commit: tightening the hook makes `student-payment-list.tsx` stop compiling (verified — `Object.fromEntries` over `status: string` yields `Record<string, string>`, which `Record<string, PaymentStatus>` rejects), so the file and the hook are one atomic change. Task 2 is separable and must come *second*: `paymentStateText` is called with the hook's output, so tightening it before Task 1 would break `payment-checklist.tsx`. Task 3 is independent of both — `class-list.tsx` neither uses the hook nor calls `paymentStateText` — and can land in any order; it is last because it was found last.

`outstanding-payment-row.tsx` needs **no source edits** in any task — its props are already `PaymentStatus` and its expressions re-derive, including the `?? status` fallback the other two were brought into line with. Verify this rather than assume it; if it needs an edit, something else is wrong. `payment-checklist.tsx` needs no edit *for the typing* either, and originally had none; its one-line `?? item.status` change came out of review (see the struck-through constraint above), not out of the type work.

---

### Task 1: Carry `PaymentStatus` through the hook, and validate the undo response

**Files:**
- Modify: `src/lib/use-payment-actions.ts`
- Create: `src/lib/payment-status.ts`
- Create: `src/lib/payment-status.test.ts`
- Modify: `src/components/students/student-payment-list.tsx:11`
- Create: `src/components/students/student-payment-list.test.tsx`
- Modify: `src/components/class/payment-checklist.tsx`
- Create: `src/components/class/payment-checklist.test.tsx`
- Modify: `src/components/class/outstanding-payment-row.test.tsx`

**Interfaces:**
- Produces, for Task 2: nothing directly. Task 2 relies only on the fact that after this task, `payment-checklist.tsx:58` and `student-payment-list.tsx:33` evaluate to `PaymentStatus`, which is what lets `paymentStateText` narrow its parameter.
- Consumes: nothing.

- [ ] **Step 1: Write the failing unit tests for the two new pure functions**

Create `src/lib/payment-status.test.ts`. The `unit` project's `include` is `src/**/*.test.ts`, so it is picked up with no config change. The environment is node, which is fine: both functions under test are pure, and nothing renders the hook here.

**Revised in review.** This file was originally `src/lib/use-payment-actions.test.ts`, importing two functions that the hook module exported *solely* so a test could reach them — a deviation from how this repo does it (`isValidTimeZone` in `schemas.ts`, `timeZoneOffsetMs` in `timezone.ts` are module-private and tested through their public entry points). Deleting the tests was the wrong correction: a mutation matrix showed each of the five catches something no other test does — swapping `PAYMENT_STATUS_KEYS.has(value)` for `value in PAYMENT_STATUSES` kills only the prototype-key test, and the component tests, which pass just `'overdue'` and `'nonsense'`, stay green through it. So the functions move to `src/lib/payment-status.ts`, whose public surface they legitimately are, and the tests move with them.

```ts
import { describe, it, expect } from 'vitest';
import { isPaymentStatus, readUndoStatus } from './payment-status';

/**
 * #58. `usePaymentActions` used to read the undo response through
 * `as { data: { status: string } }` — an unchecked assertion over a network
 * payload. These two functions replace it.
 */
describe('isPaymentStatus', () => {
  it('accepts every member of the schema enum', () => {
    expect(isPaymentStatus('pending')).toBe(true);
    expect(isPaymentStatus('paid')).toBe(true);
    expect(isPaymentStatus('overdue')).toBe(true);
  });

  it('rejects near-misses and non-strings', () => {
    expect(isPaymentStatus('overdu')).toBe(false);
    expect(isPaymentStatus('')).toBe(false);
    expect(isPaymentStatus('PENDING')).toBe(false); // case-sensitive on purpose
    expect(isPaymentStatus(null)).toBe(false);
    expect(isPaymentStatus(undefined)).toBe(false);
    expect(isPaymentStatus(42)).toBe(false);
  });

  /**
   * The reason this is a `Set` and not `value in PAYMENT_STATUSES`: an `in`
   * check against a plain object walks the prototype chain, so 'constructor'
   * and 'toString' would both pass. A Set has no such members.
   */
  it('rejects inherited Object.prototype keys', () => {
    expect(isPaymentStatus('constructor')).toBe(false);
    expect(isPaymentStatus('toString')).toBe(false);
    expect(isPaymentStatus('hasOwnProperty')).toBe(false);
  });
});

describe('readUndoStatus', () => {
  it('returns the status the server sent', () => {
    expect(readUndoStatus({ data: { status: 'overdue' } })).toBe('overdue');
    expect(readUndoStatus({ data: { status: 'pending' } })).toBe('pending');
  });

  /**
   * Every malformed shape reads as `null`, not as a substituted 'pending'
   * (revised in review). An undo whose response we cannot read still succeeded
   * server-side, so the row must stop showing "Paid" — but choosing 'pending'
   * as the stand-in is the *caller's* decision, made visibly at the call site
   * in `undo`, which also logs it. Returning it from here hid a fabricated
   * value behind a signature that promised a validated one.
   */
  it('returns null on any shape it cannot read', () => {
    expect(readUndoStatus({ data: { status: 'nonsense' } })).toBeNull();
    expect(readUndoStatus({ data: {} })).toBeNull();
    expect(readUndoStatus({ data: null })).toBeNull();
    expect(readUndoStatus({})).toBeNull();
    expect(readUndoStatus(null)).toBeNull();
    expect(readUndoStatus('not json')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project unit src/lib/payment-status.test.ts`

Expected: FAIL at import — `isPaymentStatus` and `readUndoStatus` do not exist yet. Vitest reports this as a failed suite, not a failed assertion.

- [ ] **Step 3: Create the guard module**

Create `src/lib/payment-status.ts`. It is reached from `'use client'` modules, so its `@prisma/client` import is type-only like every other one in a client path here.

```ts
import type { PaymentStatus } from '@prisma/client';
```

```ts
/**
 * Requires *every* member of the enum: adding one to the schema breaks this
 * initializer until it is listed here, which is the point. A
 * `readonly PaymentStatus[]` would accept a subset silently.
 *
 * The values are hand-listed rather than derived from Prisma's runtime enum
 * export (which does exist) because this module is reached from client
 * components and every `@prisma/client` import in a `'use client'` path in this
 * repo is type-only — a value import would be the first, and would risk pulling
 * the Prisma runtime into the browser bundle. The `Record` pin buys the drift
 * protection instead.
 */
const PAYMENT_STATUSES: Record<PaymentStatus, true> = {
  pending: true,
  paid: true,
  overdue: true,
};

/**
 * A `Set`, not `Object.hasOwn`: `tsc` accepts `Object.hasOwn` here only because
 * `lib` includes `esnext`, while `target` is ES2017 and a library method is not
 * downleveled — the lib setting describes a runtime we have not committed to.
 * A Set also has no prototype keys, so 'constructor' cannot sneak through.
 */
const PAYMENT_STATUS_KEYS: ReadonlySet<string> = new Set(Object.keys(PAYMENT_STATUSES));

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && PAYMENT_STATUS_KEYS.has(value);
}

/**
 * Reads the status out of the undo endpoint's `{ data: { status } }` envelope.
 *
 * Returns `null` — not a substituted 'pending' — for anything it cannot read.
 * The caller decides what an unreadable response should mean and applies its own
 * `?? 'pending'`, so that decision is visible at the site that makes it.
 */
export function readUndoStatus(json: unknown): PaymentStatus | null {
  if (json !== null && typeof json === 'object' && 'data' in json) {
    const data = json.data;
    if (
      data !== null &&
      typeof data === 'object' &&
      'status' in data &&
      isPaymentStatus(data.status)
    ) {
      return data.status;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: `npx vitest run --project unit src/lib/payment-status.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Type the hook's state, and use the reader in `undo`**

In `src/lib/use-payment-actions.ts`, import the reader (`import { readUndoStatus } from '@/lib/payment-status';`) and type the signature and state (currently lines 14-15):

```ts
export function usePaymentActions(initial: Record<string, PaymentStatus>) {
  const [paymentState, setPaymentState] = useState<Record<string, PaymentStatus>>(initial);
```

`markPaid`'s `'paid'` on line 30 needs no change — it satisfies `PaymentStatus` as a literal.

Then `undo`. The cast goes, and so does the shape it sat in — **revised in review, and this is the load-bearing part of the step, not a tidy-up.** `await res.json()` used to sit inside the same `try` as the fetch, so an `ok` response with an unreadable body (a proxy error page, a truncation on flaky wifi) set `'Network error. Try again.'` and returned `false` — while `unmarkPaymentPaid` had already committed `status: 'pending'`. The row kept `isPaid`, kept "✓ Paid" and its Undo button, and because `isOutstanding` derives from the same stale value the reminder button stayed hidden for a debt that now really existed; a second Undo then got the service's contradictory `Cannot undo: current status is "pending"`.

Follow `send-reminder-button.tsx:71-86`, which handles the identical "server committed, body unreadable" case and states the principle. Only the request is wrapped, so 'Network error' means exactly that; past `res.ok` the mutation has happened, so an unreadable body is **logged** (`console.error('[payment-undo] …', { paymentId })` — the client convention; `lib/log.ts` is pino and server-only) and never surfaced in `error`, local state resolves to `'pending'`, `justMarked` is cleared, and `undo` returns `true` so the caller's `router.refresh()` reconciles.

```ts
      let status: PaymentStatus | null;
      try {
        const json: unknown = await res.json();
        status = readUndoStatus(json);
        if (status === null) {
          console.error('[payment-undo] undone, but the response shape was unreadable', {
            paymentId,
          });
        }
      } catch (err) {
        status = null;
        console.error('[payment-undo] undone, but the response body was unreadable', {
          paymentId,
          err,
        });
      }

      setPaymentState((prev) => ({ ...prev, [paymentId]: status ?? 'pending' }));
```

- [ ] **Step 6: Tighten `StudentPaymentItem`, and fix both `?? 'pending'` fallbacks**

In `src/components/students/student-payment-list.tsx`, add the type import and change line 11:

```tsx
import type { PaymentStatus } from '@prisma/client';
```

```tsx
  status: PaymentStatus;
```

This is not optional. `Object.fromEntries` over items whose `status` is `string` produces `Record<string, string>`, which the hook's new parameter rejects — verified with the compiler, not assumed. The page already passes a real `PaymentStatus` (`students/[id]/page.tsx:152`, `reg.payment!.status`), so only the declaration was widening it.

Then, in that file (`:33`) and in `src/components/class/payment-checklist.tsx` (`:58`), `paymentState[item.paymentId] ?? 'pending'` becomes `?? item.status` — see the struck-through Global Constraint. Each gets a component test (`student-payment-list.test.tsx`, `payment-checklist.test.tsx`) that re-renders with a payment appearing after mount and asserts it shows its own status, because `useState` ignores later arguments and a `router.refresh()` re-renders these without remounting. One per file: reverting either line alone leaves the other's test green.

- [ ] **Step 7: Typecheck, and confirm the two class-surface consumers needed nothing**

```bash
npx tsc --noEmit && npm run lint
```

Expected: clean. Neither `payment-checklist.tsx` nor `outstanding-payment-row.tsx` must need an edit **for the typing** — their props are already `PaymentStatus` and their expressions re-derive from the hook. If either reports a *type error*, stop and report it rather than patching: it means an assumption in this plan is wrong. (`payment-checklist.tsx` does get one non-type edit, the fallback in Step 6; `outstanding-payment-row.tsx` gets none at all.)

Then confirm `PaymentStatus` is the union this plan assumes, which everything downstream rests on. Add this file temporarily, run `npx tsc --noEmit`, then delete it:

```ts
// src/lib/__probe.ts — DELETE after checking
import type { PaymentStatus } from '@prisma/client';
declare const s: PaymentStatus;
export const a: 'pending' | 'paid' | 'overdue' = s;  // must NOT error
export const b: 'pending' = s;                        // MUST error
```

Expected: exactly one error, on `b` (`Type 'PaymentStatus' is not assignable to type '"pending"'`). If `a` errors too, `PaymentStatus` is not what this plan assumes.

- [ ] **Step 8: Write the undo round-trip component tests**

In `src/components/class/outstanding-payment-row.test.tsx`. The `fetchMock` / `afterEach` / `renderCollidingPair` scaffolding already exists in that file from #59 — reuse it, do not redeclare it.

Note the mock shape: the existing undo test uses `fetchMock.mockResolvedValue({ ok: true })` because it only ever clicks Mark paid, which never calls `res.json()`. These tests click Undo, so the mock must also supply `json`.

**Corrected in `ded1802`, after the first review:** the comment below originally
claimed `'overdue'` was a reachable undo response ("the domain admits 'overdue'
for an aged payment"). That's false — `unmarkPaymentPaid` writes `'pending'`
unconditionally; the daily dunning sweep re-derives `'overdue'` later, from the
payment's age. The block below is the corrected version, matching the comment
actually committed at `outstanding-payment-row.test.tsx:197-207`.

```tsx
  /**
   * #58. `undo` renders whatever status the server's response carries, guard
   * included, rather than rendering the response verbatim or assuming the
   * result is always 'pending'. Today `unmarkPaymentPaid`
   * (services/payments.ts:91-97) always writes 'pending' unconditionally — the
   * daily dunning sweep re-derives 'overdue' later, from the payment's age —
   * so the 'overdue' response mocked below is a hypothetical exercising the
   * read path, not current server behavior. The round trip still earns its
   * keep: it is what keeps this correct the day `unmarkPaymentPaid` starts
   * returning a re-derived status itself, and this is the only test here that
   * fails if someone "simplifies" the round trip to a hardcoded 'pending'.
   */
  it('renders the status the undo response carries', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'overdue' } }) });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · Jun 12 · 09:30',
      }),
    );

    expect(await screen.findByText(/! overdue/)).toBeInTheDocument();
  });

  /**
   * The other half: a response the guard rejects falls back to 'pending', so no
   * overdue marker appears. Weak on its own — a hardcoded 'pending' would pass
   * it too — which is why the test above exists and is the load-bearing one.
   */
  it('falls back to pending when the undo response carries a bad status', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { status: 'nonsense' } }) });
    vi.stubGlobal('fetch', fetchMock);
    renderCollidingPair();

    fireEvent.click(
      screen.getByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Undo marking Ana de Vries as paid for Vinyasa · Jun 12 · 09:30',
      }),
    );

    expect(
      await screen.findByRole('button', { name: 'Mark paid — Ana de Vries, Vinyasa · Jun 12 · 09:30' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/! overdue/)).not.toBeInTheDocument();
  });
```

Add, from the review, a third: resolve undo with `{ ok: true, json: async () => { throw new SyntaxError(…) } }` and assert the row leaves the paid state, that **no** `role="alert"` appears, that `routerRefresh` was called (so `undo` returned `true`), and that the `[payment-undo] undone, but the response body was unreadable` line was logged. Spy on `console.error` for it, and for the bad-status test above, which now logs the shape case — both to assert the log and to keep the expected noise out of the suite's output.

- [ ] **Step 9: Run the component tests**

Run: `npx vitest run --project components src/components/class/outstanding-payment-row.test.tsx`
Expected: PASS, 8 tests (5 from #59, 3 new).

- [ ] **Step 10: Mutation-verify the new component tests bite**

One at a time, confirming with `git diff` that each edit landed before running, and reverting before the next. **The #66 lesson: a mutation you did not confirm landed proves nothing.**

1. In `use-payment-actions.ts`, replace `readUndoStatus(json) ?? 'pending'` with the literal `'pending'` → `'renders the status the undo response carries'` must FAIL. This is the mutation that matters; if it passes, the round trip is not actually pinned.
2. In `readUndoStatus`, change the fallback `return null` to `return 'overdue'` → `'falls back to pending when the undo response carries a bad status'` must FAIL.
3. Restore the hook's pre-review `undo` (one `try` around fetch *and* body read, bare `catch` setting 'Network error') → `'treats a committed undo with an unreadable body as the success it is'` must FAIL.
4. Revert `?? item.status` to `?? 'pending'` in `payment-checklist.tsx`, then in `student-payment-list.tsx` → each file's own new test must FAIL, and only that one.

**Beware `git checkout --` as the revert step while the fix is still uncommitted** — it reverts the fix along with the mutation. Commit first, or restore from a copy.

- [ ] **Step 11: Run the full suites**

```bash
npx vitest run --project unit
npx vitest run --project components
npx vitest run --project integration
```

Expected: unit up by 5, components up by 5 at this point (2 undo round-trip + 1 unreadable body + 2 fallback; Task 3 adds the other 6), integration unchanged. Integration needs the app on `:3000` — **do not restart it**. If `signup-api` tests fail with `expected 429 to be 201`, that is the local per-IP rate limiter (3/hour and 5/hour, `src/app/api/teachers/route.ts:14` and `src/app/api/auth/student-signup/route.ts:20`) exhausted by repeated runs, not this change. Say so in your report rather than reporting a false failure — and do not re-run repeatedly to "confirm", which only deepens it.

- [ ] **Step 12: Commit**

```bash
git add src/lib/use-payment-actions.ts src/lib/payment-status.ts src/lib/payment-status.test.ts \
        src/components/students/student-payment-list.tsx src/components/students/student-payment-list.test.tsx \
        src/components/class/payment-checklist.tsx src/components/class/payment-checklist.test.tsx \
        src/components/class/outstanding-payment-row.test.tsx
git commit -m "fix: carry PaymentStatus through usePaymentActions, validate the undo response (#58)"
```

---

### Task 2: Tighten `paymentStateText` and close its exhaustiveness

**Files:**
- Modify: `src/lib/format.ts:27-31`
- Modify: `src/lib/format.test.ts`

**Interfaces:**
- Consumes from Task 1: that `payment-checklist.tsx:63` and `student-payment-list.tsx:42-43` now pass a `PaymentStatus`. Without Task 1 this task does not compile.
- Produces: nothing.

**Must run after Task 1.** `paymentStateText` is called with the hook's output; tightening it first breaks `payment-checklist.tsx`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/format.test.ts`. It currently imports `formatDayHeader` and `formatHistoricalDate` on line 2 — extend that import rather than adding a second one.

```ts
/**
 * #58. These are `paymentStateText`'s first tests. It had none while its
 * parameter was `string` and its last branch was a catch-all `return`, which is
 * the combination this change removes: three surfaces render these exact
 * strings — the class payment checklist, a student's payment history, and the
 * student-facing bookings page — so the labels are the contract, not an
 * implementation detail.
 *
 * Asserted as whole objects so a className change cannot slip through a
 * label-only assertion.
 */
describe('paymentStateText', () => {
  it('renders paid in teal with a check', () => {
    expect(paymentStateText('paid')).toEqual({ label: '✓ Paid', className: 'text-teal' });
  });

  it('renders overdue in danger, medium weight', () => {
    expect(paymentStateText('overdue')).toEqual({
      label: '! Overdue',
      className: 'text-danger font-medium',
    });
  });

  it('renders pending as unstyled unpaid', () => {
    // No colour class: unpaid is the resting state, not an alarm.
    expect(paymentStateText('pending')).toEqual({ label: '○ Unpaid', className: '' });
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project unit src/lib/format.test.ts`

Expected: FAIL at import — `paymentStateText` is not in the import list yet. Add it to line 2's import, re-run, and expect **PASS**: the current implementation already returns these values.

That is the honest sequence and worth not dressing up. These three tests are characterization tests — they pin behaviour that already works, so that Step 3's rewrite cannot change it silently. The red-then-green cycle belongs to the `never` guard, which Step 5 exercises by mutation because a type-level guarantee cannot be asserted at runtime.

- [ ] **Step 3: Tighten the signature and close the exhaustiveness**

In `src/lib/format.ts`, add the type import at the top of the file (it currently has none from Prisma):

```ts
import type { PaymentStatus } from '@prisma/client';
```

Then replace lines 27-31:

```ts
export function paymentStateText(status: PaymentStatus): { label: string; className: string } {
  if (status === 'paid') return { label: '✓ Paid', className: 'text-teal' };
  if (status === 'overdue') return { label: '! Overdue', className: 'text-danger font-medium' };
  if (status === 'pending') return { label: '○ Unpaid', className: '' };
  // Unreachable for any status the schema can produce, and the `never` is what
  // keeps it that way: adding a member to the enum fails the *build* here
  // instead of rendering silently as "Unpaid".
  const unhandled: never = status;
  console.error('[payment-state-text] unhandled payment status', { status: String(unhandled) });
  return { label: '○ Unpaid', className: '' };
}
```

**It logs and returns; it does not throw — revised in review.** The first version threw, and that was worse than the unguarded catch-all it replaced. `(student)/bookings/page.tsx` is an async server component with `export const dynamic = 'force-dynamic'` that calls this during render, and the app's only error boundary (`app/error.tsx`, plus `global-error.tsx`) logs nothing: on enum or deploy drift a throw takes down an entire student-facing page on every request with no diagnostic trail, where the catch-all merely mislabelled one row. The `never` — the part with all the value — is untouched. `'○ Unpaid'` is the fallback because it is one of the design system's three payment labels and the only one that cannot overclaim payment.

`console.error`, not `lib/log.ts`: that module is pino and server-only, and `format.ts` is imported by `'use client'` components. Note `format.ts` is **not** itself a `'use client'` module, but keep `import type` regardless: nothing here needs the value, and a type-only import cannot accidentally pull the runtime into a client bundle that imports this file.

There is deliberately **no runtime test for that branch**. It is unreachable for every value the type admits, and reaching it from a test would take the type assertion this project forbids. Step 5 is how it is verified.

- [ ] **Step 4: Typecheck and run**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit src/lib/format.test.ts
```

Expected: clean; tests pass with the same three assertions. `bookings/page.tsx:209` must not need an edit — it includes the full Prisma `payment` (`:36`), so it already passes a `PaymentStatus`. If it errors, report it.

- [ ] **Step 5: Mutation-verify the `never` guard**

A passing `tsc` on unchanged code proves nothing about an exhaustiveness guard. Prove it bites:

```bash
# add a fourth member to the enum — DO NOT create a migration
```

Edit `prisma/schema.prisma` lines 74-78 to add `refunded` to `enum PaymentStatus`, then:

```bash
npx prisma generate
npx tsc --noEmit
```

Expected: **exactly two errors**, and check both are present rather than stopping at the first —

1. `format.ts` — `TS2322: Type '"refunded"' is not assignable to type 'never'`
2. `payment-status.ts` — `TS2741: Property 'refunded' is missing in type '{ pending: true; paid: true; overdue: true; }' but required in type 'Record<PaymentStatus, true>'` (this was `use-payment-actions.ts` before the guards moved to their own module)

Then revert:

```bash
git checkout -- prisma/schema.prisma
npx prisma generate
npx tsc --noEmit   # clean again
git status --short  # must show no change to prisma/
```

**Do not commit the schema edit, and do not run `npx prisma migrate dev`.** This is a compiler probe, not a schema change.

- [ ] **Step 6: Run the full suites**

```bash
npx vitest run --project unit
npx vitest run --project components
npx vitest run --project integration
npx playwright test
```

Expected: unit up by 3 from Task 1's total, components unchanged from Task 1, integration unchanged, e2e 118 passing. The same `signup-api` 429 note from Task 1 Step 11 applies.

- [ ] **Step 7: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "fix: tighten paymentStateText to PaymentStatus and close its exhaustiveness (#58)"
```

---

### Task 3: Close the fifth widening — `class-list.tsx`'s payment rollup

**Files:**
- Modify: `src/components/schedule/class-list.tsx:13` and `:74`
- Create: `src/components/schedule/class-list.test.tsx`

**Interfaces:**
- Consumes: nothing. `class-list.tsx` neither uses `usePaymentActions` nor calls `paymentStateText`, so this task is independent of Tasks 1 and 2 and can land in any order.
- Produces: nothing.

**Why this task exists at all.** It was missing from the first version of this plan while the spec documented it fully at `:32` ("**There is a fifth.**") — so an agentic worker following the plan task-by-task completed Tasks 1-2, passed the whole Pre-PR checklist, and shipped a build that still carried the defect. `ClassWithDetails.registrations` (`:13`) declares `{ payment: { status: string } | null }[]` and the `.filter` narrowing (`:74`) repeats the same `string`, while real `PaymentStatus` data flows in from both `(teacher)/page.tsx` and `schedule/past/page.tsx`. A typo or a renamed enum member there silently zeroes out the overdue count on the teacher's home screen with `tsc` reporting nothing.

- [ ] **Step 1: Write the `PaymentRollup` tests first**

Create `src/components/schedule/class-list.test.tsx` (the `components` project's glob is `src/components/**/*.test.tsx`; `src/components/class/outstanding-payment-row.test.tsx` is the house pattern).

`PaymentRollup` has **no coverage anywhere** today — unit, component and e2e all grepped, zero hits — and the type change cannot give it any: what it carries is a priority order (overdue > unpaid > all-paid) and a `payments.length === 0` guard, neither of which a type protects. Swapping the two `if`s reintroduces the exact "false ✓ all paid" bug this branch is named after, with a green build.

Render through `ClassList`, not by exporting `PaymentRollup` — a test-only export is what Task 1's module extraction exists to undo. Type the fixture as `ComponentProps<typeof ClassList>['classes'][number]` so no assertion is needed and a schema change breaks the file. `Decimal` comes from `@prisma/client/runtime/library` (pure JS, no engine), not from `@prisma/client`.

Six tests: overdue ahead of unpaid; the unpaid count with nothing overdue; all paid; the empty-payments guard; a non-completed class rendering no rollup; and `registrations` absent entirely (the prop is optional). Each "renders nothing" test must also assert the card *is* on screen, or it passes vacuously.

- [ ] **Step 2: Mutation-verify all six**

They are characterization tests — they pass against unchanged code, so the red-then-green cycle has to be supplied by mutation. One at a time, `git diff` confirming the edit landed before the run, reverted before the next. Each must kill exactly one test:

| Mutation | Kills |
|---|---|
| swap the `overdue` / `unpaid` `if` blocks | reports overdue ahead of unpaid |
| delete the `unpaid` branch | reports the unpaid count when nothing is overdue |
| `if (unpaid > 0)` → `if (unpaid >= 0)` | reports all paid only when every payment is paid |
| `payments.length === 0` → `payments.length < 0` | stays silent when a completed class has no payments yet |
| drop `cls.status !== 'completed' \|\|` from the guard | renders no rollup for a class that has not completed |
| drop `\|\| !cls.registrations` from the guard | stays silent when registrations were not loaded at all |

- [ ] **Step 3: Tighten the type**

```tsx
  /** Charged registrations' payment states — powers the completed-card rollup. */
  registrations?: { payment: { status: PaymentStatus } | null }[];
```

and the narrowing at `:74`:

```tsx
    .filter((p): p is { status: PaymentStatus } => p !== null);
```

`PaymentStatus` joins the existing `import type` line from `@prisma/client`.

- [ ] **Step 4: Prove the tightening bites**

Change one comparison to `p.status === 'overdu'` and run `npx tsc --noEmit`: expect `TS2367` (this comparison appears unintentional). Against the pre-task `string` it compiled silently. Revert, confirm with `git diff`, re-run clean.

- [ ] **Step 5: Run the full suites and commit**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
git add src/components/schedule/class-list.tsx src/components/schedule/class-list.test.tsx
git commit -m "fix: close the fifth PaymentStatus widening, found in final review (#58)"
```

Expected: unit unchanged, components up by 6.

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 419 + 8 = 427 passing
- [ ] `npx vitest run --project components` — 37 + 11 = 48 passing (3 in `outstanding-payment-row`, 1 each in the two new fallback files, 6 in `class-list`)
- [ ] `npx vitest run --project integration` — 215 passing (429s are the rate limiter, not this change)
- [ ] `npx playwright test` — 118 passing
- [ ] `git status --short` — only `docs/backlog-roadmap.md` untracked; **`prisma/` unchanged**
- [ ] No `as` added anywhere in the diff — `git diff | grep -n ' as '` reviewed
- [ ] `outstanding-payment-row.tsx` has no source edits; `payment-checklist.tsx` has exactly one, the `?? item.status` fallback
- [ ] `bookings/page.tsx` has no edits
- [ ] Every mutation in Task 1 Step 10, Task 2 Step 5 and Task 3 Step 2 was observed to land (`git diff`) and to kill the test named for it — not assumed
- [ ] `src/lib/__probe.ts` deleted
- [ ] Task 3 was done. It is the one that ships nothing visible and is therefore the one most easily skipped; the spec documents it at `:32` and the plan carried no task for it at all until the review caught that.
