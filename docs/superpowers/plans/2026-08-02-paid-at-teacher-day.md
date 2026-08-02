# paidAt Renders the Teacher's Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The payments page shows a payment on the day the teacher marked it paid, not the UTC day (#140).

**Architecture:** The Received row moves out of the page into `ReceivedPaymentRow`, beside the already-extracted, already-tested `OutstandingPaymentRow`. It takes `paidAt` as a raw instant plus `timeZone` and converts with `startOfLocalDay` before formatting — matching `ClassList` and `ArchivedRecord`. The extraction exists because the page is an async server component that RTL cannot render, so without it the fix has no test.

**Tech Stack:** TypeScript strict, React Testing Library under Vitest's `components` project (jsdom).

## Global Constraints

- **TypeScript `strict: true`, `noUncheckedIndexedAccess` on.** No `any`, **no type assertions to silence a type error**, no eslint suppressions.
- **The only rendered change is the date in the "✓ paid" caption.** Every class name, element order, separator and label must survive the extraction byte-identical. Any other diff is a defect.
- **`Class.date` is a `@db.Date` calendar value — do NOT wrap it in `startOfLocalDay`.** Only `paidAt` is an instant. Getting this backwards would break the class date the same way `paidAt` is broken now.
- **`MarkUnpaidButton` moves unchanged.** Its accessible name is the bare "Mark unpaid" for every row — that is **#128**, deliberately not touched here.
- **`classContext` stays a pre-formatted string on both rows**, matching `OutstandingPaymentRow`, until **#154** converts both.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.
- Do NOT run `npx vitest run --project integration` — one of its files is IP rate-limited.

---

## File Structure

| File | Change |
|---|---|
| `src/components/class/received-payment-row.tsx` | **Create** — the row, with the fix |
| `src/components/class/received-payment-row.test.tsx` | **Create** — the timezone tests |
| `src/app/(teacher)/settings/payments/page.tsx` | Replace the inline Received markup with the component |

One task. The extraction, the fix and the test are one deliverable with one test cycle — splitting them would mean either a task whose tests assert the bug and get rewritten, or an unused `timeZone` prop that fails lint.

---

### Task 1: `ReceivedPaymentRow`, and the fix inside it

**Files:**
- Create: `src/components/class/received-payment-row.tsx`
- Create: `src/components/class/received-payment-row.test.tsx`
- Modify: `src/app/(teacher)/settings/payments/page.tsx:100-134`

**Interfaces:**
- Produces: `ReceivedPaymentRow` from `@/components/class/received-payment-row`, props exactly:
  ```ts
  interface ReceivedPaymentRowProps {
    paymentId: string;
    studentName: string;
    classContext: string;
    paidAt: Date | null;
    timeZone: string;
    amount: number;
  }
  ```
- Consumes: `startOfLocalDay` from `@/lib/timezone`, `formatDateShort` from `@/lib/format`, `MarkUnpaidButton` from `@/components/class/mark-unpaid-button`.

- [ ] **Step 1: Write the failing test**

Create `src/components/class/received-payment-row.test.tsx`. Read `src/components/class/outstanding-payment-row.test.tsx` first for its conventions — but note it imports `routerRefresh` from `tests/setup/components` because it calls `router.refresh()`; this component holds no state and touches no router, so that import is **not** needed here. `toBeInTheDocument` comes from the `components` project's `setupFiles` and needs no import either.

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReceivedPaymentRow } from './received-payment-row';

/**
 * #140. `Payment.paidAt` is a `DateTime` — an instant, the moment the teacher
 * tapped "Mark paid" — while `formatDateShort` reads with `getUTC*` accessors,
 * which is right for a `@db.Date` calendar value and wrong for an instant. The
 * page rendered it raw, so a teacher who settled up on Friday evening in
 * Portland saw the payment dated Saturday.
 *
 * Both fixtures below are chosen so the teacher's zone and UTC fall on
 * *different* calendar days. That property is the whole test: an instant where
 * they agree would pass whether or not the code applied a timezone at all. If
 * either instant is ever changed, re-check it rather than assuming.
 *
 * They also shift in opposite directions — Los Angeles backwards over
 * midnight, Kolkata forwards — which additionally rules out an implementation
 * that always subtracts.
 */
describe('ReceivedPaymentRow', () => {
  const base = {
    paymentId: 'pay-1',
    studentName: 'Ana d.',
    classContext: 'Vinyasa · 12 Jun · 09:30',
    amount: 14,
  };

  it('shows the teacher’s day, not UTC’s, west of the meridian', () => {
    // 18:00 on 12 June in Los Angeles is 01:00 on 13 June UTC.
    render(
      <ReceivedPaymentRow
        {...base}
        paidAt={new Date('2026-06-13T01:00:00.000Z')}
        timeZone="America/Los_Angeles"
      />,
    );

    expect(screen.getByText(/✓ paid 12 Jun/)).toBeInTheDocument();
    expect(screen.queryByText(/13 Jun/)).not.toBeInTheDocument();
  });

  it('shows the teacher’s day east of the meridian too', () => {
    // 20:00 on 12 June UTC is 01:30 on 13 June in Kolkata.
    render(
      <ReceivedPaymentRow
        {...base}
        paidAt={new Date('2026-06-12T20:00:00.000Z')}
        timeZone="Asia/Kolkata"
      />,
    );

    expect(screen.getByText(/✓ paid 13 Jun/)).toBeInTheDocument();
  });

  /**
   * `paidAt` is nullable on `Payment`. A row with no timestamp renders no
   * caption rather than an empty one — the `&&` guard the page already had.
   */
  it('renders no paid caption when paidAt is null', () => {
    render(<ReceivedPaymentRow {...base} paidAt={null} timeZone="America/Los_Angeles" />);

    expect(screen.queryByText(/✓ paid/)).not.toBeInTheDocument();
    expect(screen.getByText(/Vinyasa · 12 Jun · 09:30/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project components src/components/class/received-payment-row.test.tsx`

Expected: FAIL — the module does not exist yet (`Failed to resolve import "./received-payment-row"`).

- [ ] **Step 3: Create the component**

`src/components/class/received-payment-row.tsx`. The markup is moved from `src/app/(teacher)/settings/payments/page.tsx:105-132` **byte-identical** apart from the `paidAt` line and the substituted prop names. Open the page and copy it rather than retyping from this plan — a class name typo is a rendered-output change.

```tsx
import { formatDateShort } from '@/lib/format';
import { startOfLocalDay } from '@/lib/timezone';
import { MarkUnpaidButton } from '@/components/class/mark-unpaid-button';

interface ReceivedPaymentRowProps {
  paymentId: string;
  studentName: string;
  /**
   * `"{classType} · {date} · {startTime}"`, pre-formatted by the page — the
   * same shape and the same reason as `OutstandingPaymentRow`'s (#59): without
   * the start time, two paid classes of one type on one day read identically
   * for the same student, and the amount alone does not tell them apart.
   *
   * Pre-formatted rather than derived, matching its sibling. **#154** converts
   * both to raw props so the component builds its own labels; until then these
   * two agree with each other, which is worth more than one of them being
   * right on its own.
   */
  classContext: string;
  /**
   * The raw instant, deliberately not pre-formatted — unlike `classContext`.
   * `startOfLocalDay` runs *here* so the conversion sits inside the tested
   * unit; formatting it in the page would leave the bug this component exists
   * to fix untestable, because the page is an async server component RTL
   * cannot render.
   *
   * This matches `ClassList` and `ArchivedRecord`, which both take raw values
   * plus a `timeZone`. See #154.
   */
  paidAt: Date | null;
  timeZone: string;
  amount: number;
}

/**
 * One Received row on the payments overview.
 *
 * A plain (non-client) component: unlike `OutstandingPaymentRow` it holds no
 * state — `MarkUnpaidButton` owns its own.
 */
export function ReceivedPaymentRow({
  paymentId,
  studentName,
  classContext,
  paidAt,
  timeZone,
  amount,
}: ReceivedPaymentRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 min-h-14 py-2 border-b border-border last:border-b-0">
      <div className="min-w-0">
        <p className="text-base text-ink">{studentName}</p>
        <p className="type-caption">
          {classContext}
          {/*
            #140. `paidAt` is an *instant* — the moment "Mark paid" was tapped
            — not a calendar date, so it goes through `startOfLocalDay` before a
            UTC-accessor formatter sees it. Without that, a payment marked at
            18:00 Pacific on the 12th renders as the 13th.

            `classContext`'s date is the opposite case: `Class.date` is a
            `@db.Date` calendar value already at midnight UTC, so it must *not*
            be converted. Two kinds of date in this one caption — see
            `src/lib/timezone.ts` for the rule.
          */}
          {paidAt && <> · ✓ paid {formatDateShort(startOfLocalDay(paidAt, timeZone))}</>}
        </p>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="type-number">€{amount.toFixed(2)}</span>
        <MarkUnpaidButton paymentId={paymentId} />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project components src/components/class/received-payment-row.test.tsx`

Expected: PASS, 3/3.

- [ ] **Step 5: Prove the test actually bites**

Temporarily change the component's line to the unfixed form:

```tsx
{paidAt && <> · ✓ paid {formatDateShort(paidAt)}</>}
```

Run the test file again.

Expected: the two timezone tests **fail**, the Los Angeles one reporting `13 Jun` where `12 Jun` was expected. Restore the fix and confirm 3/3 again.

**Record the failure output in your report.** A test that passes with and without the fix proves nothing, and this bug has already survived one PR that deliberately preserved it.

- [ ] **Step 6: Repoint the page**

In `src/app/(teacher)/settings/payments/page.tsx`, replace the whole inline `received.map(...)` block (`:104-132`) with:

```tsx
          received.map((p) => (
            <ReceivedPaymentRow
              key={p.id}
              paymentId={p.id}
              studentName={studentName(p)}
              classContext={`${p.registration.class.classType} · ${formatDateShort(p.registration.class.date)} · ${p.registration.class.startTime}`}
              paidAt={p.paidAt}
              timeZone={session.defaultTimezone}
              amount={Number(p.amount)}
            />
          ))
```

Add the import beside the existing `OutstandingPaymentRow` one:

```tsx
import { ReceivedPaymentRow } from '@/components/class/received-payment-row';
```

Then **remove the now-unused `MarkUnpaidButton` import** — it moved into the component. Lint will catch it if you forget, but check rather than relying on that.

`session` is already in scope (`:14`), so no query changes. Leave the Outstanding section entirely alone.

- [ ] **Step 7: Confirm the extraction changed nothing but the date**

```bash
git diff "src/app/(teacher)/settings/payments/page.tsx"
```

Read the diff and confirm every removed line reappears in the component with only these differences: `p.id` → `paymentId`, `studentName(p)` → `studentName`, the `classContext` template → the prop, `Number(p.amount)` → `amount`, and the `paidAt` line gaining `startOfLocalDay`.

**Any other difference — a class name, an element, a separator, the `€` or the `·` — is a defect.** Report it rather than accepting it.

- [ ] **Step 8: Verify**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
npx vitest run --project unit
npx playwright test
```

Expected: clean; components rises by 3; unit 450 unchanged; e2e 118.

If `npx playwright test` fails on a payments screen, the extraction changed the markup — that is Step 7's check failing later, not a flake.

- [ ] **Step 9: Commit**

```bash
git add src/components/class/received-payment-row.tsx \
        src/components/class/received-payment-row.test.tsx \
        "src/app/(teacher)/settings/payments/page.tsx"
git commit -m "fix: show a payment on the day the teacher marked it paid (#140)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project components` — 84 + 3 = 87
- [ ] `npx vitest run --project unit` — 450 unchanged
- [ ] `npx playwright test` — 118
- [ ] The two timezone tests were proved to fail against the unfixed line, with the output recorded
- [ ] `grep -n "startOfLocalDay" src/components/class/received-payment-row.tsx` — applied to `paidAt` only, never to the class date
- [ ] `MarkUnpaidButton` renders unchanged; **#128** untouched
- [ ] `OutstandingPaymentRow` and the Outstanding section untouched
- [ ] The page's diff shows only the substitutions listed in Step 7
- [ ] `git status --short` — only `docs/backlog-roadmap.md` untracked
