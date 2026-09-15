# Task 1 Implementation Report: Signed Euro Formatter (`formatCents` & `formatEuro`) (#599)

**Issue:** #599  
**Plan:** `docs/superpowers/plans/2026-09-15-signed-euro-formatter.md`  
**Status:** Completed  

---

## 1. Summary of Changes

1. **`src/lib/format.ts`**:
   - Implemented `formatCents(cents: number): string`:
     - Rounds `cents` with `Math.round`.
     - Formats positive amounts as `€X.XX`, negative amounts as `−€X.XX` using the unicode minus glyph `−` (U+2212) preceding `€`, and zero as `€0.00`.
     - Guard `rounded < 0` ensures `-0` and floats rounding to zero never render as `−€0.00` or `€-0.00`.
   - Implemented `formatEuro(euros: number): string`:
     - Convenience wrapper around `formatCents(Math.round(euros * 100))`.

2. **`src/lib/format.test.ts`**:
   - Added unit test suites for `formatCents` and `formatEuro`:
     - `formatCents`: positive whole cents (`4000` -> `€40.00`), single-digit padding (`5` -> `€0.05`), negative whole cents (`-400` -> `−€4.00` with explicit `charCodeAt(0) === 0x2212` assertion), zero (`0` -> `€0.00`), negative zero (`-0` -> `€0.00`), near-zero float cancellation (`-7.1054e-15` -> `€0.00`), sub-cent rounding (`399.6` -> `€4.00`).
     - `formatEuro`: positive decimal (`16.25` -> `€16.25`), negative euro (`-4` -> `−€4.00` with `charCodeAt(0) === 0x2212`), zero (`0` -> `€0.00`), negative zero (`-0` -> `€0.00`), float drift cancellation (`(56.30 - 40.10) + (24.00 - 40.20)` -> `€0.00`).

---

## 2. Test-Driven Development (TDD) Cycle

### Step 1: RED (Failing Unit Tests)
- Executed `pnpm exec vitest run --project unit src/lib/format.test.ts`.
- Tests failed with 12 errors due to missing exports:
  - `TypeError: formatCents is not a function` (7 tests)
  - `TypeError: formatEuro is not a function` (5 tests)

### Step 2: GREEN (Implementation)
- Added implementations in `src/lib/format.ts`.
- Executed `pnpm exec vitest run --project unit src/lib/format.test.ts`.
- Result: **50 passed (50 tests total)** in 1.74s.

---

## 3. Mutation Testing (Proving Guards Bite)

### Mutation 1: Minus Glyph Check (`−` U+2212 to `-` ASCII Hyphen)
- **Mutation:** Changed `rounded < 0 ? '−' : ''` to `rounded < 0 ? '-' : ''` in `src/lib/format.ts`.
- **Command:** `pnpm exec vitest run --project unit src/lib/format.test.ts`
- **Result:** FAILED (2 failed, 48 passed).
- **Exact Failures:**
  ```
  FAIL  |unit| src/lib/format.test.ts > formatCents > formats negative whole cents with minus sign (U+2212)
  AssertionError: expected '-€4.00' to be '−€4.00' // Object.is equality
  Expected: "−€4.00"
  Received: "-€4.00"

  FAIL  |unit| src/lib/format.test.ts > formatEuro > formats negative euro amount with minus sign (U+2212)
  AssertionError: expected '-€4.00' to be '−€4.00' // Object.is equality
  Expected: "−€4.00"
  Received: "-€4.00"
  ```
- **Restoration:** Restored U+2212. Vitest verified back to GREEN (50 passed).

### Mutation 2: Zero Guard Check (`rounded < 0` to `rounded <= 0`)
- **Mutation:** Changed `rounded < 0 ? '−' : ''` to `rounded <= 0 ? '−' : ''` in `src/lib/format.ts`.
- **Command:** `pnpm exec vitest run --project unit src/lib/format.test.ts`
- **Result:** FAILED (6 failed, 44 passed).
- **Exact Failures:**
  ```
  FAIL  |unit| src/lib/format.test.ts > formatCents > formats zero cents as positive zero
  AssertionError: expected '−€0.00' to be '€0.00' // Object.is equality
  Expected: "€0.00"
  Received: "−€0.00"

  FAIL  |unit| src/lib/format.test.ts > formatCents > formats negative zero cents as positive zero
  AssertionError: expected '−€0.00' to be '€0.00' // Object.is equality
  Expected: "€0.00"
  Received: "−€0.00"

  FAIL  |unit| src/lib/format.test.ts > formatCents > cancels near-zero float drift to zero
  AssertionError: expected '−€0.00' to be '€0.00' // Object.is equality
  Expected: "€0.00"
  Received: "−€0.00"

  FAIL  |unit| src/lib/format.test.ts > formatEuro > formats zero euros as positive zero
  AssertionError: expected '−€0.00' to be '€0.00' // Object.is equality
  Expected: "€0.00"
  Received: "−€0.00"

  FAIL  |unit| src/lib/format.test.ts > formatEuro > formats negative zero euros as positive zero
  AssertionError: expected '−€0.00' to be '€0.00' // Object.is equality
  Expected: "€0.00"
  Received: "−€0.00"

  FAIL  |unit| src/lib/format.test.ts > formatEuro > cancels floating point drift to zero
  AssertionError: expected '−€0.00' to be '€0.00' // Object.is equality
  Expected: "€0.00"
  Received: "−€0.00"
  ```
- **Restoration:** Restored `rounded < 0`. Vitest verified back to GREEN (50 passed).

---

## 4. Verification

1. `pnpm exec vitest run --project unit src/lib/format.test.ts`: PASS (50/50 passed).
2. `pnpm run typecheck`: PASS (`tsc --noEmit` exited 0).
3. `pnpm run lint`: PASS (0 errors).
