# Implementation Plan: SkipReason is an ordered classification (#288)

**Issue:** #288  
**Date:** 2026-09-14  
**Branch:** `fix/288-skipreason-ordered-classification`

---

## Background & Problem

`SkipReason` (`src/lib/generation.ts:55`) is documented as:
> *"Six reasons, six distinct origins — they are not interchangeable and the copy layer treats them differently."*

In reality, the evaluation predicates overlap:
1. `already_generated` and `blocked_by_cancelled` are subsets of `already_this_week` (own class on date implies own class in week).
2. `already_this_week` overlaps `slot_taken` (a candidate date can be in a week held by this template from a previous schedule, and also collide with another class at that slot).
3. `slot_taken` is a subset of `blocked_by_overlap` (an exact-start collision is also a span overlap).
4. Post-insert probe: `blocked_by_overlap` vs `raced` (transient vs standing overlap).

Therefore, `SkipReason` is an **ordered, first-match classification**, not a partition of disjoint origins.

Furthermore, `SkipCounts` deliberately drops `already_generated` (idempotent re-run) and `raced` (transient contention). Currently, this drop decision is documented in prose and handled via a `switch` in `countSkipReasons`. A compiler-checked `SKIP_REASON_COUNT_MAP: Record<SkipReason, keyof SkipCounts | null>` makes the drop-or-surface decision total and enforced by TypeScript.

Finally, the ordering of `already_this_week` before `slot_taken` in `entry-generation.ts` is described as a "reporting preference" with no test pinning it. Adding a test fixture where a candidate date is both week-held and slot-taken pins this preference against accidental reordering.

---

## Tasks

### Task 1: Update `SkipReason` docblock and introduce `SKIP_REASON_COUNT_MAP` in `src/lib/generation.ts`

- **Files:** `src/lib/generation.ts`
- **Changes:**
  - Replace "six distinct origins" in `SkipReason` docblock with an explanation of the ordered, first-match classification pipeline.
  - Distinguish load-bearing orderings (`own` on date before `week`; `pre-check` before `post-insert` probe) from reporting preferences (`week` before `slot_taken`; `slot_taken` before `blocked_by_overlap`).
  - Export `SKIP_REASON_COUNT_MAP: Record<SkipReason, keyof SkipCounts | null>`.
  - Refactor `countSkipReasons` to use `SKIP_REASON_COUNT_MAP`, retaining the explicit initialization of `SkipCounts` and updating docblocks.
- **Verification:** `pnpm run typecheck`, `pnpm exec vitest run --project unit src/lib/generation.test.ts`.

### Task 2: Update twin docblock and preference comment in `src/services/entry-generation.ts`

- **Files:** `src/services/entry-generation.ts`
- **Changes:**
  - Update lines 1000–1010 where the old header ("Six reasons, six distinct origins") is quoted.
  - Update lines 710–726 to reflect that the `already_this_week` before `slot_taken` reporting preference is now pinned by a test.
- **Verification:** `pnpm run typecheck`.

### Task 3: Test mapping and pin `already_this_week` before `slot_taken` preference

- **Files:**
  - `src/lib/generation.test.ts`
  - `src/services/class-generator.test.ts`
- **Changes:**
  - In `src/lib/generation.test.ts`: test `SKIP_REASON_COUNT_MAP` entries explicitly (ensure all 6 members mapped correctly, `already_generated` and `raced` to `null`).
  - In `class-generator.test.ts`: create a test fixture where a candidate date has both a prior instance holding the week (e.g. on Tuesday) and an unrelated class holding the candidate's slot (e.g. on Thursday). Assert that `result.skipped` records `already_this_week`, not `slot_taken`.
  - **Mutation probe:** Invert the branches in `entry-generation.ts` to evaluate `slot_taken` before `isWeekHeld`. Confirm the test fails (RED). Restore and confirm it passes (GREEN).
- **Verification:** `pnpm exec vitest run --project unit src/lib/generation.test.ts src/services/class-generator.test.ts`.

### Task 4: Full Verification

- **Commands:**
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm test`
  - `pnpm run verify`
