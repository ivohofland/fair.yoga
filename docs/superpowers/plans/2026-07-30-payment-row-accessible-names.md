# Payment Row Accessible Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all three buttons on an Outstanding payment row uniquely named, so two rows for the same student stop sharing accessible names — and visible captions (#59).

**Architecture:** One string, three consumers. The payments page already builds a `classContext` per row; it gains the class start time, and `outstanding-payment-row.tsx` feeds it to the two labels that currently have no disambiguator as well as the one that already does. No new component, no new prop.

**Tech Stack:** Next.js App Router (server page + client row), TypeScript strict, Vitest `components` project (jsdom + Testing Library).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence a type error, no eslint suppressions.
- **One string feeds both the visible caption and the accessible names.** Do not introduce a second, aria-only value — two strings that must agree is the drift this design deliberately avoids.
- **Do not change `src/components/class/send-reminder-button.tsx`.** Its `context` prop already exists, is already nullable, and already appends correctly. This change alters what is passed to it, not the component.
- **Do not touch `MarkUnpaidButton` or the Received section.** Filed as #128.
- **Do not replace the page's local `formatDay`.** It is correct (UTC accessors on a `@db.Date` column) and consolidating date formatters is #96's decision, which is design-gated.
- **Do not modify `prisma/schema.prisma`**; no migration. `Class.startTime` already exists as a `String`.
- **Never restart the dev server on `:3000`.** It is managed manually by the repo owner.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.

---

## File Structure

| File | Change |
|---|---|
| `src/app/(teacher)/settings/payments/page.tsx` | Add `startTime` to the class `select`; append it to `classContext` |
| `src/components/class/outstanding-payment-row.tsx` | Use `classContext` in the Mark paid and Undo labels; fix the possessive; update the prop docblock |
| `src/components/class/outstanding-payment-row.test.tsx` | **New** — the first test under `src/components/class/` |

**One task.** The three files change together and are meaningless apart: the page supplies a value the row must consume, and the test asserts the pair. Splitting them would produce a commit where the caption shows a time no label uses, or labels referencing data the query does not select.

---

### Task 1: Give all three row buttons a unique accessible name

**Files:**
- Modify: `src/app/(teacher)/settings/payments/page.tsx`
- Modify: `src/components/class/outstanding-payment-row.tsx`
- Create: `src/components/class/outstanding-payment-row.test.tsx`

**Interfaces:**
- Consumes: `OutstandingPaymentRow`'s existing props — `paymentId`, `studentName`, `classId`, `classContext`, `amount`, `status`, `reminderSentAt`. None are added or removed; only what the page puts in `classContext` changes.
- Produces: nothing later tasks depend on. This is the whole change.

- [ ] **Step 1: Write the failing test**

Create `src/components/class/outstanding-payment-row.test.tsx`. This is the first test in this directory; the `components` project picks it up from `src/components/**/*.test.tsx` with no config change.

`next/navigation` is already stubbed by `tests/setup/components.ts`, and `next/link` renders in jsdom with no router provider (verified). `usePaymentActions` and the reminder button only call `fetch` on click, so rendering needs no network stub.

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutstandingPaymentRow } from './outstanding-payment-row';

/**
 * #59. Two Outstanding rows for the same student used to share accessible
 * names. The reminder button had a partial disambiguator — class type and
 * date, no time — so it collided for a morning and an evening class of the
 * same type on one day; "Mark paid" and "Undo" had none at all and collided
 * for any two outstanding payments the student had.
 *
 * The fixture is the narrowest case that breaks all three: one student, one
 * class type, one day, two times. A fixture differing in type or date would
 * pass on the pre-fix code for the reminder button and prove nothing.
 */
describe('OutstandingPaymentRow', () => {
  const base = {
    studentName: 'Ana de Vries',
    amount: 18,
    status: 'pending' as const,
    reminderSentAt: null,
  };

  function renderCollidingPair() {
    render(
      <>
        <OutstandingPaymentRow
          {...base}
          paymentId="pay-morning"
          classId="cls-morning"
          classContext="Vinyasa · Jun 12 · 09:30"
        />
        <OutstandingPaymentRow
          {...base}
          paymentId="pay-evening"
          classId="cls-evening"
          classContext="Vinyasa · Jun 12 · 18:00"
        />
      </>,
    );
  }

  it('gives the reminder buttons distinct accessible names', () => {
    renderCollidingPair();

    expect(
      screen.getByRole('button', { name: 'Send reminder to Ana de Vries for Vinyasa · Jun 12 · 09:30' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send reminder to Ana de Vries for Vinyasa · Jun 12 · 18:00' }),
    ).toBeInTheDocument();
  });

  it('gives the mark-paid buttons distinct accessible names', () => {
    renderCollidingPair();

    expect(
      screen.getByRole('button', { name: "Mark Ana de Vries's payment as paid for Vinyasa · Jun 12 · 09:30" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: "Mark Ana de Vries's payment as paid for Vinyasa · Jun 12 · 18:00" }),
    ).toBeInTheDocument();
  });

  /**
   * The collision is visual too — two identical captions with the same amount
   * are ambiguous to a sighted teacher. Asserted separately from the labels
   * because they are one string by design: if that ever stops being true,
   * this is the test that notices.
   */
  it('renders distinct visible captions', () => {
    renderCollidingPair();

    expect(screen.getByText('Vinyasa · Jun 12 · 09:30')).toBeInTheDocument();
    expect(screen.getByText('Vinyasa · Jun 12 · 18:00')).toBeInTheDocument();
  });
});
```

`getByRole('button', { name })` matches the **whole** accessible name — a substring would pass on the colliding version, which is the defect. `getByText` and `getByRole` both throw when a query matches more than one element, so a collision fails these tests rather than silently passing.

The Undo button is deliberately not asserted here: it renders only after a successful `markPaid`, which needs a network round trip. Step 4 covers it by inspection instead — noted in the report rather than faked with a test that does not exercise it.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run --project components src/components/class/outstanding-payment-row.test.tsx`

Expected: `'gives the mark-paid buttons distinct accessible names'` FAILS — `getByRole` finds two buttons both named `Mark Ana de Vries payment as paid`, and Testing Library throws "Found multiple elements". The other two tests pass already, because the fixture hands the component two distinct `classContext` values directly.

That is the point of the fixture: it proves the *component* is at fault for Mark paid, and that the reminder button and caption only need the page to pass a better string.

- [ ] **Step 3: Use the context in both unlabelled buttons**

In `src/components/class/outstanding-payment-row.tsx`, the Undo button's label:

```tsx
                  aria-label={`Undo marking ${studentName} as paid for ${classContext}`}
```

and the Mark paid button's:

```tsx
              aria-label={`Mark ${studentName}'s payment as paid for ${classContext}`}
```

Note the possessive on Mark paid — `${studentName} payment` was already ungrammatical and gets more audible in a longer label. Undo's existing phrasing (`Undo marking X as paid`) is already correct and only gains the suffix.

- [ ] **Step 4: Run the test and watch it pass; check Undo by inspection**

Run: `npx vitest run --project components src/components/class/outstanding-payment-row.test.tsx`
Expected: all three pass.

Then read the Undo label you just wrote and confirm it interpolates `classContext` the same way. It is not covered by a test because it renders only after a successful `markPaid` network call. **Say so in your report** — do not add a test that mocks the fetch just to claim coverage, and do not claim it is covered.

- [ ] **Step 5: Update the prop docblock, which your change just falsified**

`classContext`'s docblock currently reads:

```tsx
  /** "{classType} · {date}" — the row's visible sub-label *and* the reminder aria-label context. */
```

Both halves are now wrong: the format gained a time, and the string feeds three labels rather than one. Replace it:

```tsx
  /**
   * `"{classType} · {date} · {startTime}"` — the row's visible sub-label *and*
   * the disambiguator in all three button labels. One string on purpose: two
   * rows for the same student are told apart by this and nothing else, so a
   * separate aria-only value could drift from what is on screen (#59). The
   * time is what makes a morning and an evening class of the same type on one
   * day distinguishable.
   */
```

- [ ] **Step 6: Supply the time from the page**

In `src/app/(teacher)/settings/payments/page.tsx`, add `startTime` to the class select:

```tsx
          class: { select: { id: true, classType: true, date: true, startTime: true } },
```

and append it where `classContext` is built:

```tsx
              classContext={`${p.registration.class.classType} · ${formatDay(p.registration.class.date)} · ${p.registration.class.startTime}`}
```

`Class.startTime` is a `String` in `'HH:MM'` form — no formatting, no timezone handling. Leave the Received section's inline caption alone; it has no interactive control whose name collides (#128 covers its button).

- [ ] **Step 7: Typecheck, lint, and run the suites**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
npx vitest run --project unit
```

Expected: clean, 32 + 3 = 35 components tests, unit unchanged.

- [ ] **Step 8: Mutation-verify that the new tests bite**

One at a time, confirming the edit landed and reverting before the next:

1. Drop ` for ${classContext}` from the Mark paid label → `'gives the mark-paid buttons distinct accessible names'` must FAIL.
2. Drop ` · ${p.registration.class.startTime}` from the page's `classContext` → this test file still passes, because it constructs `classContext` itself. **That is expected and worth reporting:** the component tests pin the component; nothing pins the page's string. Say so plainly rather than implying end-to-end coverage.

- [ ] **Step 9: Check the row at 375px**

The caption gained roughly eight characters inside a 640px column, beside an amount and up to two buttons. Look at an Outstanding row on the running dev server at 375px width and confirm it has not started wrapping badly or pushing the buttons.

Do not restart the dev server — it is already running. If you cannot check this, say so in your report rather than assuming it is fine; the spec flags it as a real risk, not a formality.

- [ ] **Step 10: Commit**

```bash
git add "src/app/(teacher)/settings/payments/page.tsx" src/components/class/outstanding-payment-row.tsx src/components/class/outstanding-payment-row.test.tsx
git commit -m "fix: give all three payment-row buttons distinct accessible names (#59)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project components` — 35 passing (32 before, 3 new)
- [ ] `npx vitest run --project unit` — unchanged
- [ ] `npx vitest run --project integration` — unchanged. Needs the app on `:3000`; do not restart it. `signup-api` 429s are the local rate limiter, not this change.
- [ ] `npx playwright test` — 118 passing
- [ ] `git status` — only `docs/backlog-roadmap.md` untracked
- [ ] `send-reminder-button.tsx` untouched
- [ ] `MarkUnpaidButton` and the Received section untouched
- [ ] The page's local `formatDay` untouched
- [ ] Both halves of the `classContext` docblock updated
- [ ] The Undo label's lack of test coverage stated in the report, not glossed
