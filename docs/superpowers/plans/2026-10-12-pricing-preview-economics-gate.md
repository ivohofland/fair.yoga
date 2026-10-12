# Pricing preview gates on the economics rules (#835)

**Goal:** `PricingPreviewTable` stops rendering prices for economics no write path
would accept, and says which rule the numbers break instead.

## Premise, as measured

- Holds as stated. `PricingPreviewTable` (`src/components/class/pricing-preview-table.tsx`)
  has two gates — non-finite amounts, invalid student counts — and never calls
  `economicsViolations` (`src/lib/class-economics.ts`). Room 30 / min rate −40 reaches
  the engine and renders negative totals and tier prices.
- Its three callers (new-class, class-edit, template form) are the only importers
  besides the component and its own test (`grep -rln PricingPreviewTable src` lists
  5 files = 3 callers + 2), so the fix covers them all.
- Wider than the issue says: the gate covers every `EconomicsRule`, not just
  `room_subsidy`. `rate_order` (min rate above target) also feeds the engine an inverted
  slope. `students_order` is silently clamped today: `effectiveMax = max(effectiveMin,
  maxStudents)` turns min 9 / max 6 into a one-position slider at 9.

## Design

- After the finite-amounts gate and before the student-count gate (shipped the other
  way round; see What shipped), compute
  `economicsViolations({ roomCost, minRate, targetRate, minStudents, maxStudents })`
  on the raw props. When it is non-empty, render each violation's sentence-case copy
  in place of the slider and table, styled like the existing gate messages.
- The copy is the component's own `Record<EconomicsRule, string>` with `satisfies`,
  using the same wording as the three forms. #221's spec
  (`2026-09-24-class-economic-invariants-design.md`) keeps each surface's copy its own,
  tethered by the compiler; consolidating the maps is out of scope.
- No change to `calculateClassPricing`. The engine trusts validated input, as the issue
  states.

## Task 1 — gate and tests (test first)

Files: `src/components/class/pricing-preview-table.tsx`, its `.test.tsx`.

1. Add failing tests to `pricing-preview-table.test.tsx`:
   - room 30 / min −40 / target 40 / students 6–9: the subsidy sentence renders, there is
     no slider, and no `−€` or tier row appears.
   - Boundary: room 30 / min −30 renders the slider and the table, because the subsidy
     equals the room cost and the total is ≥ 0.
   - min rate 50 / target 40 shows the rate-order sentence and no slider.
   - min students 9 / max 6 shows the students-order sentence and no slider.
2. Run them and watch them fail.
3. Implement the gate.
4. Prove the guard bites: comment out the gate, record the failing assertions, restore,
   and re-run green.
5. `pnpm exec tsc --noEmit`, `pnpm lint`, and the component vitest project.

## What shipped, where it differed from this plan

- **The "no `−€`" assertion could not fail with this fixture.** Room 30 / min −40 /
  target 40 / 6–9 opens the slider at `round(7.5) = 8` students, where the total is
  +€43.33. Negatives appear only at 6 students (total −€10.00, the issue's figure). The
  test asserts that no `€` amount renders at all.
- **Two form tests changed that this plan's file list did not name.** The rate-order
  tests in `class-edit-form.test.tsx` and `template-form.test.tsx` found the sentence
  twice, once in the form's own `role="alert"` and once in the preview. They are now
  scoped to the alert.
- A fifth test asserts that every rule shows its sentence when all three fire.
- Both forms' rate-order tests also assert that no slider renders. That pins the gate
  inside the forms: none of them has a slider of its own.
- **The student-count gate was dead, all three of its arms** (whole-branch review).
  `effectiveMin = max(1, minStudents)` is ≥ 1 or NaN, and `effectiveMax` is
  ≥ `effectiveMin` or NaN, so `<= 0`, `<= 0` and `<` could never be true. A NaN count,
  which `NumberInput` emits on bad input (`validity.badInput`), therefore reached the
  slider as "NaN students". The gate now checks `Number.isFinite` on both counts and
  runs before the economics gate, because `economicsViolations` passes NaN. Clamping a
  minimum below one stays as it was.
