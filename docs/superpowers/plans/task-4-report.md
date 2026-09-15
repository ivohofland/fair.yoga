# Task 4 Implementation Report: Teacher Pricing Preview Components Formatter (#599)

**Issue:** #599  
**Plan:** `docs/superpowers/plans/2026-09-15-signed-euro-formatter.md`  
**Status:** Completed  

---

## 1. Summary of Changes

1. **`src/components/class/pricing-preview-table.tsx`**:
   - Replaced local `formatEuro` function with import of `formatEuro` from `@/lib/format`.

2. **`src/components/class/pricing-preview.tsx`**:
   - Imported `formatEuro` from `@/lib/format`.
   - Updated lines rendering euro amounts to use `formatEuro`:
     - Estimated earnings: `{formatEuro(estimatedEarnings)}`
     - Room cost: `{formatEuro(Number(cls.roomCost))}`
     - Rate range: `{formatEuro(Number(cls.minRate))} &ndash; {formatEuro(Number(cls.targetRate))}`
     - Per-tier prices: `{formatEuro(row.price)}`

3. **`src/app/(teacher)/class/new/page.tsx`**:
   - Imported `formatEuro` from `@/lib/format`.
   - Updated review step line 643 to use `formatEuro`:
     `Room cost: {formatEuro(form.roomCost)} · Rate: {formatEuro(form.minRate)} – {formatEuro(form.targetRate)}`

4. **`src/components/class/pricing-preview.test.tsx`**:
   - Added component tests covering:
     - Positive estimated earnings: `€20.00`
     - Negative estimated earnings: `−€4.00` (with U+2212)
     - Negative minRate: `−€20.00 – €60.00`

---

## 2. Test-Driven Development (TDD) Cycle

### Step 1: RED
- Ran `pnpm exec vitest run --project components src/components/class/pricing-preview.test.tsx`.
- 2 tests failed:
  - Negative estimated earnings expected `−€4.00`, received `€-4.00`.
  - Negative minRate expected `−€20.00 – €60.00`, received `€-20.00 – €60.00`.

### Step 2: GREEN
- Implemented `formatEuro` in `src/components/class/pricing-preview.tsx`, `pricing-preview-table.tsx`, and `class/new/page.tsx`.
- All 3 tests passed.

---

## 3. Mutation Testing (Proving Guard Bites)

- **Mutation:** Reverted line 84 in `pricing-preview.tsx` back to `&euro;{estimatedEarnings.toFixed(2)}`.
- **Command:** `pnpm exec vitest run --project components src/components/class/pricing-preview.test.tsx`
- **Result:** FAILED (1 failed, 2 passed) with:
  `TestingLibraryElementError: Unable to find an element with the text: −€4.00` (rendered `€-4.00`).
- **Restoration:** Restored `{formatEuro(estimatedEarnings)}`. Verified 3/3 tests pass.
