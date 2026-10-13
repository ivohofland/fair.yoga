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
   type 10 passes through max 1, which is `min > max`. The gates (the NaN check,
   then `economicsViolations`) catch the cleared and below-minimum values; the
   derivation below makes every other prefix harmless, such as "5" on the way to
   "50", which is a valid range.
2. **Non-integer bounds.** A bound can read `6.5` while typing. A plain clamp
   would show "6.5 students", and `normalSpread(6.5)` seats 7. The clamp lands
   on whole numbers: `ceil(effectiveMin)` … `floor(effectiveMax)`.

## Design decisions

- **A chosen size in state, the shown size derived.** The slider alone writes
  `chosenCount`; what is shown is that choice clamped to the whole-number range
  (`ceil(effectiveMin)` … `floor(effectiveMax)`), so widening the range gives the
  choice back. The clamp is not persisted: the props arrive per keystroke, so a
  gate-passing prefix ("5" on the way to "50") would otherwise move the size for
  good.
- **Normal spread is derived** from the shown size at render; only a shuffled
  draw is state.
- **A shuffled draw is redrawn during render** when its head count differs from
  the shown size, after the gates (React's "adjusting some state when a prop
  changes" pattern: React re-renders before committing, so a stale mix never
  reaches the screen). Past the gates the size is a finite whole number, so the
  redraw settles in one pass.
- **One whole-number range** feeds the slider, its captions and the table.
- **A NaN choice** (seeded while a bound was cleared) falls back to the range's
  midpoint.

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
Expected: the two narrowing tests, the whole-number test and the shuffle test
fail (the label still reads "8 students"); `leaves a size still inside the new
range alone` and `keeps the size through the states…` pass already (nothing
moves the size today). Record the failure output in the report.

### Step 2 — implementation

In `pricing-preview-table.tsx`, replace `studentCount`, `distribution`,
`updateDistribution` and `handleSliderChange` with the derivation, and the clamp
block with the after-gates redraw. Keep the three gates as they are.

```tsx
  const lowest = Math.ceil(effectiveMin);
  const highest = Math.max(lowest, Math.floor(effectiveMax));
  const [chosenCount, setChosenCount] = useState(
    Math.round((effectiveMin + effectiveMax) / 2),
  );
  const [mode, setMode] = useState<'normal' | 'shuffle'>('normal');
  const [shuffled, setShuffled] = useState<TierCounts>(emptyCounts);
  const chosen = Number.isFinite(chosenCount) ? chosenCount : Math.round((lowest + highest) / 2);
  const shownCount = Math.min(highest, Math.max(lowest, chosen));

  function handleModeChange(newMode: 'normal' | 'shuffle') {
    setMode(newMode);
    if (newMode === 'shuffle') setShuffled(shuffleMix(shownCount));
  }

  // ...gates, unchanged...

  if (mode === 'shuffle' && studentsIn(shuffled) !== shownCount) {
    setShuffled(shuffleMix(shownCount));
  }
  const distribution = mode === 'normal' ? normalSpread(shownCount) : shuffled;
```

The label, slider (`min={lowest}` `max={highest}` `value={shownCount}`, `onChange`
calling `setChosenCount`), captions and `PricingPreviewResult` read `shownCount`,
`lowest` and `highest`. Re-run the same command. Expected: every test passes.

Tests added in review, one line each:
- `gives the choice back when a narrowed bound widens again`
- `keeps the size while a bound is retyped through a range it can price`
- `lands on a whole number when the minimum is not one`
- `starts from the midpoint when it mounted on a cleared count`
- `keeps a shuffled mix when the size is still inside the new range`
- `shows the count message from a shuffled mix while a bound is cleared`
- `lands on a whole number when a bound is not one` also asserts the `6 max` caption.

### Step 3 — prove each guard bites

Apply each mutation, run the file, confirm the named test fails, restore:

- **M1, persist the clamp:** after the gates, `if (shownCount !== chosenCount) setChosenCount(shownCount);`. `gives the choice back…` and `keeps the size while a bound is retyped through a range it can price` fail.
- **M2, drop the shuffle redraw:** delete the `if (mode === 'shuffle' …)` block. `redraws a shuffled mix at the new size` fails.
- **M3, move the shuffle redraw above the first gate:** `shows the count message from a shuffled mix…` fails.
- **M4, ceil removed:** `const lowest = effectiveMin;`. `lands on a whole number when the minimum is not one` fails.
- **M5, NaN fallback removed:** `const chosen = chosenCount;`. `starts from the midpoint…` fails.
- **M6, redraw on every bound change:** a `useEffect` that calls `setShuffled(shuffleMix(shownCount))` on `[minStudents, maxStudents]`. `keeps a shuffled mix when the size is still inside the new range` fails.

Then re-run with no mutation; all pass.

### Step 4 — checks and commit

- `pnpm exec tsc --noEmit` and `pnpm exec eslint src/components/class/pricing-preview-table.tsx src/components/class/pricing-preview-table.test.tsx` clean.
- Commit both files (stage exact paths):
  `fix: the pricing preview moves its class size into a narrowed range (#851)`
