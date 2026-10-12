# Pricing preview gates on the economics rules (#835)

**Goal:** `PricingPreviewTable` stops rendering prices for economics no write path
would accept, and says which rule the numbers break instead.

## Premise, as measured

- Holds as stated. `PricingPreviewTable` (`src/components/class/pricing-preview-table.tsx`)
  has two gates — non-finite amounts, invalid student counts — and never calls
  `economicsViolations` (`src/lib/class-economics.ts`). Room 30 / min rate −40 reaches
  the engine and renders negative totals and tier prices.
- Its three callers (new-class, class-edit, template form) are the only importers
  (`grep -rln PricingPreviewTable src`), so the fix covers them all.
- Wider than the issue says: the gate covers every `EconomicsRule`, not just
  `room_subsidy`. `rate_order` (min rate above target) also feeds the engine an inverted
  slope. `students_order` is silently clamped today: `effectiveMax = max(effectiveMin,
  maxStudents)` turns min 9 / max 6 into a one-position slider at 9, so the
  student-count gate's `effectiveMax < effectiveMin` arm can never fire.

## Design

- After the finite-amounts gate and before the student-count gate, compute
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
