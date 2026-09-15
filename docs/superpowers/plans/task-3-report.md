# Task 3 Implementation Report: Teacher Completed Class Breakdown Formatter (#599)

**Issue:** #599  
**Plan:** `docs/superpowers/plans/2026-09-15-signed-euro-formatter.md`  
**Status:** Completed  

---

## 1. Summary of Changes

1. **`src/components/class/pricing-breakdown.tsx`**:
   - Imported `formatEuro` from `@/lib/format`.
   - Updated lines rendering euro amounts to use `formatEuro`:
     - Teacher earnings: `{formatEuro(teacherEarnings)}`
     - Room cost: `{formatEuro(roomCost)}`
     - Rate range: `{formatEuro(Number(cls.minRate))} &ndash; {formatEuro(Number(cls.targetRate))}`
     - Total revenue: `{formatEuro(totalRevenue)}`
     - Per-tier prices: `{formatEuro(row.price)}`

2. **`src/components/class/pricing-breakdown.test.tsx`**:
   - Added component tests covering:
     - Positive earnings: `€50.00`
     - Negative earnings: `−€4.00` (with U+2212)
     - Negative minRate: `−€20.00 – €60.00`

---

## 2. Test-Driven Development (TDD) Cycle

### Step 1: RED
- Ran `pnpm exec vitest run --project components src/components/class/pricing-breakdown.test.tsx`.
- 2 tests failed:
  - Negative teacher earnings expected `−€4.00`, received `€-4.00`.
  - Negative minRate expected `−€20.00 – €60.00`, received `€-20.00 – €60.00`.

### Step 2: GREEN
- Implemented `formatEuro` in `src/components/class/pricing-breakdown.tsx`.
- All 3 tests passed.

---

## 3. Mutation Testing (Proving Guard Bites)

- **Mutation:** Reverted line 38 back to `&euro;{teacherEarnings.toFixed(2)}`.
- **Command:** `pnpm exec vitest run --project components src/components/class/pricing-breakdown.test.tsx`
- **Result:** FAILED (1 failed, 2 passed) with:
  `TestingLibraryElementError: Unable to find an element with the text: −€4.00` (rendered `€-4.00`).
- **Restoration:** Restored `{formatEuro(teacherEarnings)}`. Verified 3/3 tests pass.
