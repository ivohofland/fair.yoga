# Pricing preview re-clamps its class size (#851) — plan

**Goal:** when the form's min or max students change so that the preview's chosen
class size falls outside the new range, the preview moves the size to the nearest
bound and reprices it; a size still inside the range is left alone.

**No spec.** One component, one obvious mechanism, no change to stored data or to
what any write path accepts. The design decisions below are the spec.

## Premise, as measured

The issue holds. In `src/components/class/pricing-preview-table.tsx`,
`studentCount` and `distribution` are `useState` values seeded from the opening
midpoint; only `handleSliderChange` and `handleModeChange` write them. The three
forms that render it (`new-class-form.tsx`, `class-edit-form.tsx`,
`template-form.tsx`) pass `form.minStudents`/`form.maxStudents` straight through,
updated per keystroke, with no `key` that would remount the preview.

Two things the issue does not mention, both because the fields update per keystroke:

1. **Transient states.** Clearing a field gives `NaN`; backspacing max from 12 to
   type 10 passes through max 1, which is `min > max`. Both already hit an early
   return (the NaN gate, then `economicsViolations`). The clamp must run only
   after those gates, or retyping a bound wipes the teacher's slider choice.
2. **Non-integer bounds.** A bound can read `6.5` while typing. A plain clamp
   would show "6.5 students", and `normalSpread(6.5)` seats 7. The clamp lands
   on whole numbers: `ceil(effectiveMin)` … `floor(effectiveMax)`.

## Design decisions

- **Persist the clamp** (write it to state), as the issue's acceptance reads:
  narrowing max to 6 and widening back to 12 leaves the size at 6.
- **Adjust during render, not in an effect.** React's "adjusting some state when
  a prop changes" pattern: compare, and `setState` during render when they
  differ. React discards that render's output and re-renders before committing,
  so the stale size never reaches the screen; an effect would commit it for a
  frame. The guard is idempotent (a clamped size clamps to itself), so it cannot
  loop.
- **Recompute in the current mode** through the existing `updateDistribution`.

## Global constraints

- TypeScript strict; no `any`.
- Comment Discipline (CLAUDE.md): a comment annotates the code it sits on, states
  what is true now, no counts or rosters.
- Test first: the tests below fail before the implementation.

## Task 1: re-clamp the class size when the range narrows

**Files:**
- `src/components/class/pricing-preview-table.test.tsx` (tests)
- `src/components/class/pricing-preview-table.tsx` (implementation)

### Step 1 — failing tests

Append this `describe` block inside the top-level `describe('PricingPreviewTable', …)`
in the test file, after the last `it` (`'treats a minimum below one as one…'`).
`row`, `setStudents`, `EXAMPLE`, `render`, `screen`, `fireEvent`, `vi`,
`beforeEach`, `afterEach` are already in scope or imported there.

```tsx
  describe('when the form narrows the class-size range', () => {
    const TIERS = ['1 · Getting by', '2 · Managing', '3 · Comfortable', '4 · Doing well', '5 · Plenty to share'];
    const seated = (): number => TIERS.map((l) => Number(row(l)[0])).reduce((a, b) => a + b, 0);

    it('moves a size above the new maximum down to it and prices that size', () => {
      // Oracle: the same range rendered fresh with its slider at 6.
      const fresh = render(<PricingPreviewTable {...EXAMPLE} maxStudents={6} />);
      setStudents(6);
      const expected = fresh.container.textContent;
      fresh.unmount();

      const { rerender, container } = render(<PricingPreviewTable {...EXAMPLE} />);
      expect(screen.getByText('8 students')).toBeTruthy();
      rerender(<PricingPreviewTable {...EXAMPLE} maxStudents={6} />);

      expect(screen.getByText('6 students')).toBeTruthy();
      expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('6');
      // 6 students fill a 4–6 class: the target rate, 90, plus the room, 20.
      expect(screen.getByText('€110.00')).toBeTruthy();
      expect(seated()).toBe(6);
      expect(container.textContent).toBe(expected);
    });

    it('moves a size below the new minimum up to it', () => {
      const { rerender } = render(<PricingPreviewTable {...EXAMPLE} />);
      rerender(<PricingPreviewTable {...EXAMPLE} minStudents={10} />);

      expect(screen.getByText('10 students')).toBeTruthy();
      // 10 students at the minimum of a 10–12 class: the min rate, 40, plus the room, 20.
      expect(screen.getByText('€60.00')).toBeTruthy();
      expect(seated()).toBe(10);
    });

    it('leaves a size still inside the new range alone', () => {
      const { rerender } = render(<PricingPreviewTable {...EXAMPLE} />);
      setStudents(10);
      rerender(<PricingPreviewTable {...EXAMPLE} maxStudents={11} />);

      expect(screen.getByText('10 students')).toBeTruthy();
      expect(seated()).toBe(10);
    });

    it('keeps the size through the states a bound passes while being retyped', () => {
      const { rerender } = render(<PricingPreviewTable {...EXAMPLE} />);
      setStudents(10);
      // Backspacing 12 to type 15: cleared, then "1" (below the minimum), then "15".
      rerender(<PricingPreviewTable {...EXAMPLE} maxStudents={Number.NaN} />);
      rerender(<PricingPreviewTable {...EXAMPLE} maxStudents={1} />);
      rerender(<PricingPreviewTable {...EXAMPLE} maxStudents={15} />);

      expect(screen.getByText('10 students')).toBeTruthy();
    });

    it('lands on a whole number when a bound is not one', () => {
      const { rerender } = render(<PricingPreviewTable {...EXAMPLE} />);
      rerender(<PricingPreviewTable {...EXAMPLE} maxStudents={6.5} />);

      expect(screen.getByText('6 students')).toBeTruthy();
      expect(seated()).toBe(6);
    });

    describe('with a fixed random source', () => {
      // Math.random() = 0.5 puts every draw at tier 2 (see the block above).
      beforeEach(() => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
      });
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('redraws a shuffled mix at the new size', () => {
        const { rerender } = render(<PricingPreviewTable {...EXAMPLE} />);
        fireEvent.click(screen.getByRole('button', { name: 'Shuffle mix' }));
        rerender(<PricingPreviewTable {...EXAMPLE} maxStudents={6} />);

        expect(screen.getByText('6 students')).toBeTruthy();
        expect(row('2 · Managing')[0]).toBe('6');
      });
    });
  });
```

Run `pnpm exec vitest run --project components src/components/class/pricing-preview-table.test.tsx`.
Expected: the three narrowing tests, the whole-number test and the shuffle test
fail (the label still reads "8 students"); `leaves a size still inside the new
range alone` and `keeps the size through the states…` pass already (nothing
moves the size today). Record the failure output in the report.

### Step 2 — implementation

In `pricing-preview-table.tsx`, insert immediately after the `violations` early
return (the `if (violations.length > 0) { … }` block) and before the final
`return (`:

```tsx
  // Placed after the gates so a field mid-edit — cleared, or briefly below the
  // other bound — cannot move the size; only a range the preview prices can.
  const lowest = Math.ceil(effectiveMin);
  const highest = Math.max(lowest, Math.floor(effectiveMax));
  const clamped = Math.min(highest, Math.max(lowest, studentCount));
  if (clamped !== studentCount) {
    // Adjusting state during render: React re-renders before committing, so the
    // stale size never reaches the screen.
    setStudentCount(clamped);
    updateDistribution(clamped, mode);
  }
```

Re-run the same command. Expected: every test in the file passes.

### Step 3 — prove the guard bites

1. Move the inserted block to directly after the `useState`/`useCallback`
   declarations (before the first gate). Run the file: `keeps the size through
   the states a bound passes while being retyped` must fail ("10 students" not
   found — max 1 clamps the size to 4). Record the exact error text. Restore.
2. Replace `Math.ceil(effectiveMin)` with `effectiveMin` and
   `Math.floor(effectiveMax)` with `effectiveMax`. `lands on a whole number…`
   must fail. Record the error. Restore.
3. Replace `updateDistribution(clamped, mode);` with
   `updateDistribution(clamped, 'normal');`. `redraws a shuffled mix…` must fail.
   Record the error. Restore.
4. Re-run the file; all pass.

### Step 4 — checks and commit

- `pnpm exec tsc --noEmit` and `pnpm exec eslint src/components/class/pricing-preview-table.tsx src/components/class/pricing-preview-table.test.tsx` clean.
- Commit both files (stage exact paths):
  `fix: the pricing preview moves its class size into a narrowed range (#851)`
