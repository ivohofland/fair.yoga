# Task 6 Report: Reporting Page Integer Cents Accumulation & Signed Euro Formatting

## 1. Objectives Completed
- Updated `src/app/(teacher)/settings/reporting/page.tsx`:
  - Defined integer cents accumulation for `totalClassEarningsCents`, `totalStudioEarningsCents`, and `totalRoomCostsCents`.
  - Used `toCents(c.totalRevenue) - toCents(c.roomCost)` in `classEarningsCents` to eliminate floating-point drift.
  - Used `formatCents` for the summary banner, breakdown cards, and monthly rollup rows.
- Added two new integration tests in `tests/integration/reporting-page.test.ts`:
  1. `accumulates in cents and avoids float drift resulting in -0.00`: Creates two classes in June 2026 whose float earnings sum to `-3.55e-15` (room 40.10 / rev 56.30 and room 40.20 / rev 24.00), verifying the rendered month shows `€0.00` and never `€-0.00` or `−€0.00`.
  2. `renders a net-negative earnings month as −€X.XX`: Creates a class in May 2026 with room 40.00 / rev 20.00 (loss of €20), verifying the rendered month shows `−€20.00` and never `€-20.00`.
  - Added test cleanup in `afterAll` for the test teachers and accounts.

## 2. Test Execution
- Ran integration test suite:
  ```bash
  pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts
  ```
- Result: 12 / 12 tests passed.

## 3. Mutation Testing & Proof of Guards
- **Mutation 1 (Negative format on monthly row)**: Mutated `formatCents(m.earningsCents)` to render `€-${Math.abs(m.earningsCents / 100).toFixed(2)}` for negative amounts.
  - Test failed:
    `AssertionError: expected '<!DOCTYPE html>...' to include '−€20.00'`
    `tests/integration/reporting-page.test.ts:456:20`
  - Restored to `formatCents` and verified GREEN.
- **Mutation 2 (Float drift accumulation)**: Mutated `classEarningsCents` to `Number(c.totalRevenue ?? 0) - Number(c.roomCost)` and line 170 to `€${m.earningsCents.toFixed(2)}` (the original buggy behavior).
  - Test failed:
    `AssertionError: expected '<!DOCTYPE html>...' to not include '€-0.00'`
    `tests/integration/reporting-page.test.ts:397:24`
    And `AssertionError: expected '<!DOCTYPE html>...' to include '−€20.00'`
    `tests/integration/reporting-page.test.ts:456:20`
  - Restored to clean integer cents accumulation and verified GREEN.
