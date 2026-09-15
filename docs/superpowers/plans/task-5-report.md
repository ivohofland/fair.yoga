# Task 5 Implementation Report: Class Completion Notification Formatter (#599)

**Issue:** #599  
**Plan:** `docs/superpowers/plans/2026-09-15-signed-euro-formatter.md`  
**Status:** Completed  

---

## 1. Summary of Changes

1. **`src/services/class-lifecycle.ts`**:
   - Imported `formatEuro` from `@/lib/format`.
   - Updated line 840 to use `formatEuro` for earnings in the completion notification body:
     ```ts
     body: `${cls.calendarEntry.classType} class on ${formatDayHeader(cls.calendarEntry.date)} at ${timeToHHmm(cls.calendarEntry.startTime)} completed — ${formatEuro(pricing.totalCost - Number(cls.roomCost))} earnings, ${chargedRegistrations.length} payment ${chargedRegistrations.length === 1 ? 'request' : 'requests'} sent.`
     ```

2. **`src/services/class-lifecycle.test.ts`**:
   - Added test `formats negative teacher earnings with minus sign before euro sign in completion notification`:
     - Creates class with roomCost 40, minRate -4, 4 charged registrations.
     - pricing totalCost = 36 $\to$ teacher earnings = -4.00.
     - Asserts teacher notification body contains `completed — −€4.00 earnings, 4 payment requests sent.`.

---

## 2. Test-Driven Development (TDD) Cycle

### Step 1: RED
- Ran `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "formats negative teacher earnings"`.
- Test failed with:
  `AssertionError: expected '... completed — €-4.00 earnings ...' to contain 'completed — −€4.00 earnings'`.

### Step 2: GREEN
- Implemented `formatEuro` on line 840 of `src/services/class-lifecycle.ts`.
- Test passed.

---

## 3. Mutation Testing (Proving Guard Bites)

- **Mutation:** Reverted line 840 back to `` `€${(pricing.totalCost - Number(cls.roomCost)).toFixed(2)}` ``.
- **Command:** `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "formats negative teacher earnings"`
- **Result:** FAILED (1 failed, 79 skipped) with:
  `AssertionError: expected '... completed — €-4.00 earnings ...' to contain 'completed — −€4.00 earnings'`.
- **Restoration:** Restored `${formatEuro(pricing.totalCost - Number(cls.roomCost))}`. Verified test passes.
