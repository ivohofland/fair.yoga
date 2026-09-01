# A tier we had to substitute is a tier we do not know — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop three student-facing surfaces from stating, as a named person's own, an income tier the code had to substitute — and stop a no-op save from overwriting the corrupt row that caused it.

**Architecture:** One new reader in `src/lib/tiers.server.ts` answers `null`
instead of substituting, and `toIncomeTier` is redefined in terms of it so
there stays exactly one logging site. Three consumers then take
`IncomeTier | null` and decline to make a claim on `null`: the booking page
falls back to the anonymous price range, `BookingFlow` shows the picker with
nothing selected, and `TierForm` disables Save until the student chooses. No
new copy is written and no message is shown — the absence of a selection is
the signal.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, vitest (`unit` and
`components` projects), @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-01-degraded-tier-downstream-design.md`

## Global Constraints

- **TypeScript strict.** No `any`, no `!` non-null assertions added by this
  work (the two pre-existing ones in `tier-estimates.ts` and the
  `tierPrices[…]!` ones in `BookingFlow` stay as they are).
- **No user-visible message** in the degraded state. Nothing explains, nothing
  warns, nothing apologises. Decided at the design gate.
- **`toIncomeTier` keeps its exact observable behaviour** — same return value,
  same warning, same log payload. Its call sites are not touched except the
  two named in Tasks 2 and 4.
- **The pool keeps `toIncomeTier`.** Tiers of *other people's* registrations
  feeding an aggregate estimate stay on the substituting reader. Only a tier a
  surface speaks about as *this* person's moves to `readIncomeTier`.
- **Comment Discipline (CLAUDE.md).** No comment states a count, a roster, or
  a fact about another module. Docblocks state the rule, never which call
  sites are on which side of it.
- **Never `git add -A`.** Stage exact paths.
- **Task order is load-bearing:** Task 1 before everything. Tasks 2 and 3 are
  independent of each other. **Task 3 must precede Task 4** — Task 4 makes the
  page's `viewer.tier` nullable, which does not typecheck until `BookingFlow`
  accepts a nullable `currentTier`.

---

### Task 1: `readIncomeTier` — a reader that can answer "I don't know"

**Files:**
- Modify: `src/lib/tiers.server.ts` (whole file above `toIncomeTierOrThrow`)
- Test: `src/lib/tiers.server.test.ts`

**Interfaces:**
- Consumes: `isIncomeTier`, `DEFAULT_INCOME_TIER`, `IncomeTier` from `@/lib/tiers`; `log` from `@/lib/log`.
- Produces: `readIncomeTier(n: number, context?: Record<string, string>): IncomeTier | null`. Tasks 2, 3 and 4 all import it. `toIncomeTier(n, context?): IncomeTier` keeps its existing signature and behaviour.

- [ ] **Step 1: Write the failing tests**

Add a `readIncomeTier` describe block to `src/lib/tiers.server.test.ts`, and
add one case to the existing `toIncomeTier` block. Import `readIncomeTier`
alongside the existing imports on line 2.

```ts
describe('readIncomeTier', () => {
  it('passes every in-range tier through unchanged', () => {
    expect([1, 2, 3, 4, 5].map((n) => readIncomeTier(n))).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not warn for a value the database permits', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    readIncomeTier(4);
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers null rather than substituting, so a caller can decline to speak', () => {
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    expect(readIncomeTier(0)).toBeNull();
    expect(readIncomeTier(6)).toBeNull();
  });

  it('warns once, with the offending value and the caller context', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    readIncomeTier(9, { studentId: 'student-1' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 9, studentId: 'student-1' }),
      expect.stringContaining('outside 1-5'),
    );
  });
});
```

And inside the existing `describe('toIncomeTier', …)`, after the last case:

```ts
  it('still warns exactly once, now that it delegates', () => {
    // The refactor's one real risk: a warning left behind in both functions
    // would double every line an operator is meant to act on.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    toIncomeTier(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib/tiers.server.test.ts`
Expected: FAIL — TypeScript/vitest reports `readIncomeTier` is not exported
from `./tiers.server`. The new `toIncomeTier` case passes already; that is
expected, it is a regression pin, not a driver.

- [ ] **Step 3: Write the implementation**

Replace everything in `src/lib/tiers.server.ts` from the top of the file down
to the end of `toIncomeTier` (leave `toIncomeTierOrThrow` and its docblock
untouched) with:

```ts
import { log } from '@/lib/log';
import { DEFAULT_INCOME_TIER, isIncomeTier, type IncomeTier } from '@/lib/tiers';

/**
 * Read a tier from the database, answering `null` when the stored value is
 * not one.
 *
 * `Student.incomeTier` and `Registration.tierAtBooking` both carry a CHECK
 * constraint (see the income_tier_range_check migration), so `null` is
 * unreachable. It exists because the alternatives on a bypassed constraint
 * are both bad: a 500 on a teacher's public booking page, or a confident
 * statement about a value nobody knows.
 *
 * Choose between this and `toIncomeTier` by asking whose tier it is. A tier a
 * surface will speak about as THIS person's — the price it quotes them, the
 * tier it names back to them, the picker it seeds — is read here, and `null`
 * means that surface must not make the claim. A tier joining an aggregate
 * over other people keeps `toIncomeTier`: there is no honest per-person UI
 * for "someone else's row is corrupt", and one substituted ratio only nudges
 * a shared price.
 *
 * If this ever warns, the constraint was circumvented. That is the bug to
 * chase, and the log line is the only thing that would tell you.
 *
 * This file is separate from `tiers.ts` solely because it imports `@/lib/log`
 * (pino, server-only) and `tiers.ts` is value-imported by `'use client'`
 * components. Do not move it, and do not import it from a client component.
 *
 * `context` is merged into the log payload — pass whichever id is in hand at
 * the call site (`registrationId` when a registration is in hand, `studentId`
 * on a profile read) so a warning points at the row, not just the bad value.
 */
export function readIncomeTier(
  n: number,
  context?: Record<string, string>,
): IncomeTier | null {
  if (isIncomeTier(n)) return n;
  log.warn({ tier: n, ...context }, 'income tier outside 1-5; DB constraint bypassed');
  return null;
}

/**
 * Narrow a tier read from the database, substituting the median when the
 * stored value is not one.
 *
 * The substitution is what keeps a public booking page rendering rather than
 * 500ing over one bad row: the tier estimates run during SSR and are fed the
 * tiers of everyone registered. One wrong price with a warning beats a dead
 * storefront.
 *
 * That trade is only right where the substituted value disappears into an
 * aggregate. Where a surface would state the tier as a named person's, use
 * `readIncomeTier` above and let `null` suppress the claim; where a wrong
 * value would be billed, use `toIncomeTierOrThrow` below.
 *
 * Warning and log payload are `readIncomeTier`'s — this is the same read with
 * a substitution on the end, not a second one.
 */
export function toIncomeTier(n: number, context?: Record<string, string>): IncomeTier {
  return readIncomeTier(n, context) ?? DEFAULT_INCOME_TIER;
}
```

Note what the old `toIncomeTier` docblock said and this one does not: it named
`(public)/[slug]`, `(public)/[slug]/book/[classId]` and a `.map` call in
another module. Those are claims about other files, which *Comment Discipline*
puts in `docs/`, and the spec now holds them. Record the removal in the PR
body.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/tiers.server.test.ts`
Expected: PASS, 12 tests — 5 `toIncomeTier` (4 existing + 1 added above),
3 `toIncomeTierOrThrow` (untouched), 4 `readIncomeTier`.

- [ ] **Step 5: Prove the guard bites**

Change `readIncomeTier`'s `return null` to `return DEFAULT_INCOME_TIER`. Run
the same command. Record the exact failure text — it should name
`answers null rather than substituting`. Revert the mutation and re-run to
confirm green.

Note for the record: this mutation reddens **only** this file. The component
tests in Tasks 2 and 3 pass `currentTier={null}` as a prop and never call the
reader, so a mutation here could not fail them. Do not claim otherwise.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tiers.server.ts src/lib/tiers.server.test.ts
git commit -m "feat(tiers): add readIncomeTier, a reader that answers null (#158)"
```

---

### Task 2: `TierForm` will not present a substituted tier as a choice

**Files:**
- Modify: `src/components/student/tier-form.tsx`
- Modify: `src/app/(student)/account/tier/page.tsx:7,33`
- Test: `src/components/student/tier-form.test.tsx`

**Interfaces:**
- Consumes: `readIncomeTier` from `@/lib/tiers.server` (Task 1).
- Produces: `TierFormProps.currentTier: IncomeTier | null`. Nothing else consumes this.

- [ ] **Step 1: Write the failing tests**

Append two cases inside the existing `describe('TierForm', …)` in
`src/components/student/tier-form.test.tsx`. The file's existing `stubFetch`
and `save` helpers are reused as-is.

```ts
  it('selects nothing and refuses to save when the stored tier is unreadable', () => {
    stubFetch();
    render(<TierForm studentId="student-1" currentTier={null} />);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
    const button = screen.getByRole('button', { name: /save tier/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('saves the tier the student picks in place of an unreadable one', async () => {
    stubFetch();
    render(<TierForm studentId="student-1" currentTier={null} />);
    fireEvent.click(screen.getByRole('radio', { name: /Tier 4 · Doing well/i }));
    expect(screen.getByRole('button', { name: /save tier/i })).toBeEnabled();
    const { body } = await save();
    expect(body).toEqual({ incomeTier: 4 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components src/components/student/tier-form.test.tsx`
Expected: FAIL — TypeScript rejects `currentTier={null}` against
`currentTier: IncomeTier`.

- [ ] **Step 3: Widen the prop and gate the save**

In `src/components/student/tier-form.tsx`, replace the `currentTier` line in
`TierFormProps`:

```ts
interface TierFormProps {
  studentId: string;
  /**
   * The stored tier, or null when it could not be read as one. Null shows
   * the picker with nothing selected: a tier we had to substitute is not
   * this student's choice, and must not be presented back as if it were.
   * Save stays disabled until they make one.
   */
  currentTier: IncomeTier | null;
}
```

Change the state declaration:

```ts
  const [tier, setTier] = useState<IncomeTier | null>(currentTier);
```

Add the early return as the first line of `handleSave`, before `setSaving`:

```ts
    if (tier === null) return;
```

And gate the button:

```tsx
        <Button variant="primary" onClick={handleSave} disabled={saving || tier === null}>
```

Nothing else changes. `selected = tier === t.tier` is already false for every
card when `tier` is null, so `aria-checked` needs no edit.

- [ ] **Step 4: Point the page at the nullable reader**

In `src/app/(student)/account/tier/page.tsx`, change the import on line 7 to
`readIncomeTier`, and line 33 to:

```tsx
        // readIncomeTier, not toIncomeTier: this form presents the value back
        // as the student's own choice, so a substituted one must not seed it.
        currentTier={readIncomeTier(student.incomeTier, { studentId: student.id })}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/student/tier-form.test.tsx`
Expected: PASS, 4 tests.

Then: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Prove the guard bites**

Remove `|| tier === null` from the Button's `disabled`. Re-run the component
file. Record the exact failure text — the `toBeDisabled()` assertion fails.
Revert and re-run.

Note what this mutation does **not** prove: with the disabled gate gone, the
`if (tier === null) return` early return still stops the fetch, so
`expect(fetchMock).not.toHaveBeenCalled()` keeps passing. That early return is
not separately mutation-tested because deleting it does not compile —
`TierBody.incomeTier` is `IncomeTier`, and `tier` would be nullable. Record
that reasoning; do not report the assertion as covering it.

- [ ] **Step 7: Commit**

```bash
git add src/components/student/tier-form.tsx src/components/student/tier-form.test.tsx "src/app/(student)/account/tier/page.tsx"
git commit -m "fix(tiers): TierForm shows no selection for an unreadable tier (#158)"
```

---

### Task 3: `BookingFlow` asks for the tier instead of naming it

**Files:**
- Modify: `src/components/booking/booking-flow.tsx`
- Create: `src/components/booking/booking-flow.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 directly — this is a client component and takes the nullable tier as a prop.
- Produces: `BookingFlowProps.currentTier: IncomeTier | null`. Task 4 relies on this widening to pass `viewer.tier`.

- [ ] **Step 1: Write the failing tests**

Create `src/components/booking/booking-flow.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BookingFlow } from './booking-flow';

/**
 * #158. An unreadable stored tier must not be named back to the student as
 * theirs, and must not reach the booking write: the registration route stamps
 * `tierAtBooking` from the profile column, which the CHECK constraint would
 * reject. Picking a tier PUTs it before the booking POST, which is what
 * repairs the row — hence the call-order assertion below.
 */
describe('BookingFlow', () => {
  const fetchMock = vi.fn();
  const tierPrices = [10, 11, 12, 13, 14];

  type FlowProps = Parameters<typeof BookingFlow>[0];

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  function renderFlow(overrides: Partial<FlowProps> = {}) {
    render(
      <BookingFlow
        classId="class-1"
        slug="teacher-slug"
        isFull={false}
        alreadyBooked={false}
        currentTier={3}
        studentId="student-1"
        tierPrices={tierPrices}
        isFirstBooking={false}
        {...overrides}
      />,
    );
  }

  it('asks for a tier instead of naming one when the stored tier is unreadable', () => {
    stubFetch();
    renderFlow({ currentTier: null, isFirstBooking: false });
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
    expect(screen.queryByText(/You're in Tier/)).not.toBeInTheDocument();
  });

  it('keeps the spread explanation with the picker it explains', () => {
    stubFetch();
    renderFlow({ currentTier: null, isFirstBooking: false });
    expect(
      screen.getByText(/highest tier pays about twice the lowest/i),
    ).toBeInTheDocument();
  });

  it('refuses to book until an unreadable tier has been replaced', () => {
    stubFetch();
    renderFlow({ currentTier: null });
    const book = screen.getByRole('button', { name: /^Book$/ });
    expect(book).toBeDisabled();
    fireEvent.click(book);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the waitlist too — promotion stamps the same column', () => {
    stubFetch();
    renderFlow({ currentTier: null, isFull: true });
    expect(screen.getByRole('button', { name: /join the waitlist/i })).toBeDisabled();
  });

  it('saves the chosen tier before it books, so the write sees a valid one', async () => {
    stubFetch();
    renderFlow({ currentTier: null });
    fireEvent.click(screen.getByRole('radio', { name: /Tier 2 · Managing/ }));
    fireEvent.click(screen.getByRole('button', { name: /Book — around/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [firstUrl, firstOpts] = fetchMock.mock.calls[0] ?? [];
    expect(firstUrl).toBe('/api/students/student-1');
    const put = firstOpts as { method: string; body: string };
    expect(put.method).toBe('PUT');
    expect(JSON.parse(put.body)).toEqual({ incomeTier: 2 });

    expect((fetchMock.mock.calls[1] ?? [])[0]).toBe('/api/registrations');
  });

  it('does not touch the profile when a readable tier is left unchanged', async () => {
    stubFetch();
    renderFlow({ currentTier: 3, isFirstBooking: true });
    fireEvent.click(screen.getByRole('button', { name: /Book — around/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] ?? [])[0]).toBe('/api/registrations');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project components src/components/booking/booking-flow.test.tsx`
Expected: FAIL — TypeScript rejects `currentTier: null` in the overrides type.

- [ ] **Step 3: Widen the prop and derive one condition**

In `src/components/booking/booking-flow.tsx`, replace the `currentTier` line
in `BookingFlowProps`:

```ts
  /**
   * The student's stored tier, or null when it could not be read as one.
   * Null shows the picker with nothing selected — a tier we had to substitute
   * is not this student's, so this form asks rather than names it, and
   * booking waits for the answer.
   */
  currentTier: IncomeTier | null;
```

Change the state declaration:

```ts
  const [tier, setTier] = useState<IncomeTier | null>(currentTier);
```

Add the early return as the first line of `handleBook`, before `setSubmitting`:

```ts
    if (tier === null) return;
```

Immediately before the final `return (` of the component, derive the one value
that decides both the branch and the caption:

```ts
  // The tier the summary would name, or null when there is none to name —
  // a first booking, or a stored value we could not read. One derived value
  // rather than two conditions, so the picker and the sentence explaining it
  // cannot come apart. Narrowing to IncomeTier in the summary branch is why
  // this is a null check on a const rather than a boolean flag.
  const summaryTier = isFirstBooking ? null : currentTier;
```

Change the branch condition from `isFirstBooking ? (` to:

```tsx
      {summaryTier === null ? (
```

In the summary branch (the `else` half), replace the two reads of `tier` with
`summaryTier`:

```tsx
          <p className="type-body max-w-[420px]">
            You&apos;re in Tier {summaryTier} · {TIER_INFO[summaryTier - 1]!.label}
            {summaryTier <= 2 ? ' — does this still reflect your situation?' : '.'}
          </p>
```

They are the same value there — the picker is the only thing that calls
`setTier`, and it does not render in this branch — but only `summaryTier`
narrows to `IncomeTier`.

Change the trailing caption's condition from `isFirstBooking &&` to:

```tsx
        class.{summaryTier === null && ' The highest tier pays about twice the lowest.'}{' '}
```

And the button:

```tsx
        <Button variant="primary" onClick={handleBook} disabled={submitting || tier === null} className="w-full">
          {submitting
            ? 'One moment...'
            : isFull
              ? 'Join the waitlist'
              : tier === null
                ? 'Book'
                : `Book — around €${tierPrices[tier - 1]!.toFixed(2)}`}
        </Button>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project components src/components/booking/booking-flow.test.tsx`
Expected: PASS, 6 tests.

Then: `npm run typecheck`
Expected: clean. The booking page still passes a non-nullable `IncomeTier`,
which is assignable to the widened prop — Task 4 changes that.

- [ ] **Step 5: Prove the guards bite**

Three mutations, one at a time, each reverted and re-verified before the next:

1. Change `summaryTier` to `const summaryTier = isFirstBooking ? null : (currentTier ?? 3);`
   — the first test fails on `You're in Tier`. Record the text.
2. Change the caption condition back to `isFirstBooking &&` — the second test
   fails. Record the text.
3. Swap the order in `handleBook` so the registration POST runs before the
   tier PUT — the fifth test fails on the first call's URL. Record the text.

Then re-run the file and confirm 6 green.

- [ ] **Step 6: Commit**

```bash
git add src/components/booking/booking-flow.tsx src/components/booking/booking-flow.test.tsx
git commit -m "fix(booking): BookingFlow asks for an unreadable tier rather than naming it (#158)"
```

---

### Task 4: the booking page stops quoting a price it cannot stand behind

**Files:**
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx:13,86,118-141`
- Modify: `docs/backlog-roadmap.md:1126-1130`

**Interfaces:**
- Consumes: `readIncomeTier` (Task 1), `BookingFlowProps.currentTier: IncomeTier | null` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Point the viewer's own reads at the nullable reader**

In `src/app/(public)/[slug]/book/[classId]/page.tsx`, change the import on
line 13 to bring in both:

```ts
import { readIncomeTier, toIncomeTier } from '@/lib/tiers.server';
```

Replace the `viewer` block (around line 82-87) — keep the existing comment
above it and add the reason for the reader:

```ts
  // One conversion serves both the attendance-spread estimate and BookingFlow's
  // initial picker value — they read the same column. Carrying `student`
  // alongside its converted tier (rather than a standalone const) lets
  // narrowing `viewer` for truthiness also narrow `viewer.tier`, which
  // TypeScript could not do across two separate consts.
  //
  // readIncomeTier, not toIncomeTier: both consumers speak about this person —
  // the price quoted to them, the tier named back to them — so a value we had
  // to substitute must suppress the claim rather than fill it.
  const viewer = student
    ? { ...student, tier: readIncomeTier(student.incomeTier, { studentId: student.id }) }
    : null;
```

The two `toIncomeTier` calls that build `registeredTiers` (lines ~64 and ~134)
**stay as they are**: those are other people's tiers entering an aggregate,
where there is no per-person claim to suppress.

- [ ] **Step 2: Derive the tier the personal line would quote**

Directly after the `alreadyBooked` const (around line 94), add:

```ts
  // The tier the personal line would quote: a booked viewer is billed at the
  // tier stamped on their registration, anyone else would join at their
  // profile one. Null from either read means the line may not claim the tier
  // is settled, and the anonymous range says so instead.
  const quotedTier = viewer
    ? alreadyBooked && ownRegistration
      ? readIncomeTier(ownRegistration.tierAtBooking, { registrationId: ownRegistration.id })
      : viewer.tier
    : null;
```

- [ ] **Step 3: Gate the personal line on it**

Replace the price-line block (lines ~118-141) with:

```tsx
      {viewer && viewer.tierSelectedAt && quotedTier !== null ? (
        // Their tier is settled — turnout is the remaining uncertainty.
        <PersonalPriceRange
          spread={estimateAttendanceSpread({
            roomCost: Number(cls.roomCost),
            minRate: Number(cls.minRate),
            targetRate: Number(cls.targetRate),
            minStudents: cls.minStudents,
            maxStudents: cls.maxStudents,
            registeredTiers: cls.registrations
              .filter((r) => r !== ownRegistration)
              .map((r) => toIncomeTier(r.tierAtBooking, { registrationId: r.id })),
            viewerTier: quotedTier,
          })}
          className="mt-2 mb-6"
        />
      ) : (
        <PriceRange estimates={estimates} className="mt-2 mb-6" />
      )}
```

The comment that used to sit inside the `viewerTier` expression ("A booked
viewer is billed at the tier stamped on their registration; everyone else
would join at their current one") has moved to `quotedTier` in Step 2, where
the branch now lives. Do not leave a copy behind.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean. `viewer.tier` is now `IncomeTier | null` and reaches
`BookingFlow`'s widened prop; `quotedTier` is narrowed to `IncomeTier` by the
`!== null` in the JSX condition.

- [ ] **Step 5: Prove the compiler is the guard**

Delete `&& quotedTier !== null` from the JSX condition and run
`npm run typecheck`. Expected: FAIL — `Type 'IncomeTier | null' is not
assignable to type 'IncomeTier'` on `viewerTier`. Record the exact text; that
error is the whole tether for this surface. Restore and re-run.

- [ ] **Step 6: Record the mutation nothing catches**

Reverting either page's `readIncomeTier` call to `toIncomeTier` compiles,
lints and passes every test on the branch. The comments added in Task 2 Step 4
and Task 4 Step 1 are that gap's only home; confirm both are present and both
say *why* the nullable reader is the one that call site needs. Note the gap in
the PR body — do not claim test coverage for it.

- [ ] **Step 7: Correct the backlog entry**

In `docs/backlog-roadmap.md`, replace the `#158` bullet (line ~1126) with a
closed entry in the file's existing convention (see the `#200` entry at line
~499 for the shape): strike the title, mark it closed with today's date, and
carry the correction — the issue said a no-op save "erases the only evidence",
and the read-side warning already carries the raw value and necessarily fires
first, because the page has to render for the Save button to exist. Name the
two things the issue did not: `BookingFlow`'s summary as a third surface, and
the booking write failing the CHECK constraint outright.

Leave the retrospective at line ~2160 alone. It records what was believed when
#158 was spun out, and that is history rather than a live claim.

- [ ] **Step 8: Full verification**

Run: `npm run verify`
Expected: green across every project. Record the arithmetic (total = unit +
unit-sweeps + components + integration) for the PR body. This branch adds no
integration test and touches no file under `tests/integration/`; say so.

If anything earlier in the chain is red, run
`npx vitest run --project integration` directly rather than reading a red
`verify` as evidence about that tier — `npm test` chains with `&&`, so a red
unit run means integration reports nothing at all, not zero failures.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(public)/[slug]/book/[classId]/page.tsx" docs/backlog-roadmap.md
git commit -m "fix(booking): quote the range, not a personal price, for a tier we cannot read (#158)"
```

---

## After the tasks

With four tasks, the whole-branch review applies: one review on the most
capable model, one fix wave, one scoped re-review, before the PR. Its reason to
exist here is cross-task blindness — Task 1's docblock states a rule that Tasks
2, 3 and 4 are supposed to follow, and no task reviewer sees both halves.

Specific things for that review to chase:

- Did the pool reads (`registeredTiers`, both of them) correctly **stay** on
  `toIncomeTier`? A wave that swept `toIncomeTier` → `readIncomeTier` by
  keyword would have broken the estimate for a public page.
- Does Task 1's docblock rule actually describe what Tasks 2–4 did?
- Is there any remaining surface naming a tier from a substituted value? The
  teacher-facing `class/[id]/page.tsx:135` and `pricing-preview.tsx:46` were
  scoped out at the design gate as teacher surfaces, not student ones — confirm
  that scoping is stated somewhere, not merely assumed.
