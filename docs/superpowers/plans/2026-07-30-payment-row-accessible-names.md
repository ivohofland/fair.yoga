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

> **Superseded in part by the PR review round (commits `a76e78b`, `3b43cec`,
> `da4f12e`).** The steps below are kept as the record of what was planned and
> executed first; four of their instructions no longer describe the branch, and
> each correction is marked inline where it applies. In summary:
>
> | Step | Planned | Shipped |
> |---|---|---|
> | 3 | `Mark {name}'s payment as paid for {context}` | `Mark paid — {name}, {context}` (WCAG 2.5.3 — the visible `Mark paid` must be contiguous and first) |
> | 4 | Undo verified by inspection; "do not add a test that mocks the fetch" | Undo **is** tested — `vi.stubGlobal('fetch', …)` through a real click is this suite's established pattern, not a contrivance |
> | 6 | "Leave the Received section's inline caption alone" | Received gains the start time too; §2's visual-ambiguity argument does not stop at that heading. `MarkUnpaidButton`'s name is still untouched (#128) |
> | 7 / pre-PR | 35 components tests | 36 |
>
> Step 8's second mutation result also changed: the e2e now pins the page's
> `classContext` (commit `da4f12e`), so reverting it fails the suite. The
> component tests still do not — that half of the note stands.

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
 * (SUPERSEDED — write the version now in `outstanding-payment-row.test.tsx`,
 * not this one. This block originally read "the narrowest case that breaks all
 * three … a fixture differing in type or date would prove nothing". Both halves
 * are false at the component level: only the mark-paid test fails pre-fix, and
 * a type- or date-varying fixture fails exactly the same one test. Verified by
 * building one and running it. The time fixture is still preferred, for what it
 * documents — the case the reminder button's partial disambiguator could not
 * tell apart — not for what it catches.)
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

`getByRole('button', { name })` matches the **whole** accessible name.

**Corrected after review — the original reason given here was wrong.** It said a substring match "would pass on the colliding version". It would not: on a colliding pair *both* names are identical, so any query, substring or exact, matches 0 or 2 elements and throws either way. Verified by re-running the assertion in substring form against the pre-fix labels — it still failed.

Two separate mechanisms, worth keeping separate:
- **Exactness pins the copy.** Superstring mutants (label + ` (outstanding)`, caption + ` (unpaid)`) die under an exact match and survive a substring one.
- **The duplicate-name throw catches collisions.** `getByText` and `getByRole` both throw on more than one match, so a collision fails these tests rather than passing silently.

That distinction is load-bearing: told that exactness *is* the collision guard, a maintainer could drop the second row from the fixture, keep the exact names, and believe collisions stay covered. They would not.

The Undo button is deliberately not asserted here: it renders only after a successful `markPaid`, which needs a network round trip. Step 4 covers it by inspection instead — noted in the report rather than faked with a test that does not exercise it.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run --project components src/components/class/outstanding-payment-row.test.tsx`

Expected: `'gives the mark-paid buttons distinct accessible names'` FAILS.

**Corrected after review — the mechanism first predicted here does not occur.** It said `getByRole` finds two buttons with the same name and throws "Found multiple elements". It cannot: the asserted string is the *post-fix* label, which pre-fix matches **zero** elements, so the error is `Unable to find an accessible element…`.

The distinction matters. The test fails because the asserted string is **absent** — the label gained both the possessive and the context suffix — and so it would fail against pre-fix with a *single* row. The pair fixture is not what makes this test red. What the pair guards is a *future* collision, via the duplicate-name throw.

The other two tests pass already, because the fixture hands the component two distinct `classContext` values directly.

- [ ] **Step 3: Use the context in both unlabelled buttons**

In `src/components/class/outstanding-payment-row.tsx`, the Undo button's label:

```tsx
                  aria-label={`Undo marking ${studentName} as paid for ${classContext}`}
```

and the Mark paid button's — **superseded, do not copy this line**:

```tsx
              aria-label={`Mark ${studentName}'s payment as paid for ${classContext}`}
```

```tsx
              aria-label={`Mark paid — ${studentName}, ${classContext}`}   // shipped
```

The planned form was reshaped in review. Every `Mark {name}'s payment as paid` variant splits the visible `Mark paid` across the accessible name, which WCAG 2.5.3 forbids — a speech-input user cannot say what they see. Leading with the visible text fixes that and drops the possessive along with the phrasing that needed it. Undo's existing phrasing (`Undo marking X as paid`) already leads with its visible text, so it conforms as written and only gains the suffix.

- [ ] **Step 4: Run the test and watch it pass; check Undo by inspection**

Run: `npx vitest run --project components src/components/class/outstanding-payment-row.test.tsx`
Expected: all three pass. (Four, after the review round.)

Then read the Undo label you just wrote and confirm it interpolates `classContext` the same way. It is not covered by a test because it renders only after a successful `markPaid` network call. **Say so in your report** — do not add a test that mocks the fetch just to claim coverage, and do not claim it is covered.

**Overturned in review.** The instruction treated a `fetch` stub as coverage theatre; it is not. `vi.stubGlobal('fetch', …)` followed by a real click is how six component test files in this repo already drive their components, so the stub is scaffolding the suite depends on rather than a prop added to manufacture a green test. The gap was the only one of the three labels with no coverage anywhere, and it is now a fourth test.

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

`Class.startTime` is a `String` in `'HH:MM'` form — no formatting, no timezone handling. ~~Leave the Received section's inline caption alone; it has no interactive control whose name collides (#128 covers its button).~~

**Superseded.** "No control whose name collides" answers the accessible half and skips the visible one, and the spec's §2 accepts the time on every Outstanding row precisely because two identical captions with the same amount are ambiguous on screen. Received gets the same treatment. `MarkUnpaidButton`'s accessible name is still untouched and still #128.

- [ ] **Step 7: Typecheck, lint, and run the suites**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
npx vitest run --project unit
```

Expected: clean, 32 + 3 = 35 components tests, unit unchanged. (36 after the review round's fourth test.)

- [ ] **Step 8: Mutation-verify that the new tests bite**

One at a time, confirming the edit landed and reverting before the next:

1. Drop ` for ${classContext}` from the Mark paid label → `'gives the mark-paid buttons distinct accessible names'` must FAIL.
2. Drop ` · ${p.registration.class.startTime}` from the page's `classContext` → this test file still passes, because it constructs `classContext` itself. **That is expected and worth reporting:** the component tests pin the component; nothing pins the page's string. Say so plainly rather than implying end-to-end coverage.

   **Half superseded.** The component half stands — this file still passes under that mutation, by construction. But "nothing pins the page's string" was true only until `da4f12e`: the e2e's reminder assertion was `/Send reminder to Walkin Guest for /`, which the pre-fix two-part label satisfied just as well, so the mutation ran green end to end. It now matches `` `Send reminder to Walkin Guest for .*${slot.startTime}` `` and the mutation fails it. That is the reason the vacuous assertion was worth fixing rather than leaving: it is what made this bullet true.

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
- [ ] `npx vitest run --project components` — 36 passing (32 before, 4 new)
- [ ] `npx vitest run --project unit` — unchanged
- [ ] `npx vitest run --project integration` — unchanged. Needs the app on `:3000`; do not restart it. `signup-api` 429s are the local rate limiter, not this change.
- [ ] `npx playwright test` — 118 passing
- [ ] `git status` — only `docs/backlog-roadmap.md` untracked
- [ ] `send-reminder-button.tsx` untouched
- [ ] `MarkUnpaidButton` untouched (the Received *caption* is changed on purpose — see Step 6)
- [ ] The page's local `formatDay` untouched
- [ ] Both halves of the `classContext` docblock updated
- [ ] The Undo label is covered by its own test (the review round closed this gap)
