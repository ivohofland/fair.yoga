# Deduplicate slotTime into tests/class-fixtures.ts

## Problem & Context
Issue #253 noted that `slotTime` was duplicated across test files with comments explicitly stating that each copy mirrored the others. At the time issue #253 was opened, 8 files were listed.
Subsequent architectural changes (PR #327) introduced `tests/class-fixtures.ts` and refactored two of those files (`class-terminal-date.test.ts` and `class-terminal-status.test.ts`) to use `slotDate`. Later, three lock-order test files were split out, each taking a local copy of `slotTime`.

Current census of files defining `slotTime`:
`8 (issue) - 2 (migrated in #327) + 3 (lock-order tests: class-template-lifecycle-lock-order.test.ts, studio-class-template-lifecycle-lock-order.test.ts, waitlist-lock-order.test.ts) = 9 files`.

All 9 files already import from `tests/class-fixtures.ts`. Deduplicating `slotTime` into `tests/class-fixtures.ts` beside `slotDate` eliminates this duplication, unifies error handling, and removes stale "mirrors X" comments.

## User Review Required
No breaking changes to runtime behavior, database schema, or production logic. All changes are internal to test suites and test fixtures.

## Proposed Changes

### Component 1: Shared Fixture Helper & Unit Test

#### [MODIFY] [tests/class-fixtures.ts](file:///Users/ivohofland/Projects/fair.yoga/tests/class-fixtures.ts)
- Export `slotTime(totalMinutesFrom9am: number): string` beside `slotDate`.
- Include the ceiling check (`hour > 24 || (hour === 24 && minute !== 0)`) which raises a descriptive error when Postgres `24:00:00` is exceeded.
- Include regex check `/^\d{2}:[0-5]\d$/` ensuring valid format.
- Document the function's contract and its role alongside `slotDate` for fixtures under `CalendarEntry_teacher_slot_excl` and `ScheduleRule_teacher_slot_excl`.

#### [NEW] [src/lib/class-fixtures.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/lib/class-fixtures.test.ts)
- Test `slotTime`:
  - Standard offsets: `0` -> `'09:00'`, `30` -> `'09:30'`, `75` -> `'10:15'`, `540` -> `'18:00'`, `900` -> `'24:00'`.
  - Negative whole-hour offsets (used by studio templates): `-540` -> `'00:00'`, `-60` -> `'08:00'`.
  - Rejection past `24:00:00`: e.g. `901` ('24:01') and `960` ('25:00') throw error mentioning Postgres `time` limit.
  - Rejection of invalid minutes: non-multiples of 60 when negative (e.g. `-30`).
- Test `slotDate`:
  - Date offsets by day increments from a base date.
- Prove guards bite via mutation tests.

---

### Component 2: Service Unit and Sweeps Test Suites (8 files)

Remove local `slotTime` definitions, import `slotTime` from `../../tests/class-fixtures`, and delete obsolete "mirrors X" comments:

#### [MODIFY] [src/services/class-lifecycle.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-lifecycle.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local `slotTime` definition and docblock.

#### [MODIFY] [src/services/class-template-lifecycle.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-template-lifecycle.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local `slotTime` definition and docblock.

#### [MODIFY] [src/services/class-template-lifecycle-lock-order.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-template-lifecycle-lock-order.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local `slotTime` definition and docblock.

#### [MODIFY] [src/services/studio-class-template-lifecycle.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-template-lifecycle.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local `slotTime` definition and docblock.

#### [MODIFY] [src/services/studio-class-template-lifecycle-lock-order.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/studio-class-template-lifecycle-lock-order.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local `slotTime` definition and docblock.

#### [MODIFY] [src/services/waitlist.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/waitlist.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local `slotTime` definition and docblock.
- Update reference comment from "module-level slotTime" to point to `tests/class-fixtures.ts`.

#### [MODIFY] [src/services/waitlist-lock-order.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/waitlist-lock-order.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local `slotTime` definition and docblock.

#### [MODIFY] [src/services/waitlist-retention.test.ts](file:///Users/ivohofland/Projects/fair.yoga/src/services/waitlist-retention.test.ts)
- Import `slotTime` from `../../tests/class-fixtures`.
- Remove local zero-argument `slotTime` function and its obsolete docblock referencing `class-terminal-status.test.ts`.
- Update line 130 in `makeClassWithEntry`: `startTime: hhmmToTime(slotTime(slotCounter++))` so it passes the incrementing counter cleanly to the pure `slotTime` helper.

---

### Component 3: Integration Test Suite (1 file)

#### [MODIFY] [tests/integration/registrations-api.test.ts](file:///Users/ivohofland/Projects/fair.yoga/tests/integration/registrations-api.test.ts)
- Import `slotTime` from `../class-fixtures`.
- Remove local `slotTime` definition and docblock.

---

## Tasks Breakdown

### Task 1: Add `slotTime` to `tests/class-fixtures.ts` and test in `src/lib/class-fixtures.test.ts`
1. Export `slotTime` from `tests/class-fixtures.ts`.
2. Add `src/lib/class-fixtures.test.ts` with unit test coverage for `slotTime` and `slotDate`.
3. Mutation testing:
   - Break upper bound guard (`hour > 24 || ...`) -> verify test fails with exact error expected.
   - Break format regex guard (`/^\d{2}:[0-5]\d$/`) -> verify test fails with exact error expected.
   - Restore guards and verify green.
4. Run `pnpm exec vitest run src/lib/class-fixtures.test.ts`.

### Task 2: Migrate all 9 test suites to shared `slotTime`
1. Update imports in all 9 files:
   - `src/services/class-lifecycle.test.ts`
   - `src/services/class-template-lifecycle.test.ts`
   - `src/services/class-template-lifecycle-lock-order.test.ts`
   - `src/services/studio-class-template-lifecycle.test.ts`
   - `src/services/studio-class-template-lifecycle-lock-order.test.ts`
   - `src/services/waitlist.test.ts`
   - `src/services/waitlist-lock-order.test.ts`
   - `src/services/waitlist-retention.test.ts`
   - `tests/integration/registrations-api.test.ts`
2. Remove local implementations and "mirrors X" comments.
3. Update `waitlist-retention.test.ts` call site to `slotTime(slotCounter++)`.
4. Verify all 9 test suites pass across their respective vitest projects (`unit`, `unit-sweeps`, `integration`).

---

## Verification Plan

### Automated Tests
1. `pnpm exec vitest run src/lib/class-fixtures.test.ts` (unit tier)
2. `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts src/services/class-template-lifecycle.test.ts src/services/studio-class-template-lifecycle.test.ts src/services/waitlist.test.ts`
3. `pnpm exec vitest run --project unit-sweeps src/services/class-template-lifecycle-lock-order.test.ts src/services/studio-class-template-lifecycle-lock-order.test.ts src/services/waitlist-lock-order.test.ts src/services/waitlist-retention.test.ts`
4. `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts`
5. Full gate run:
   - `pnpm run typecheck`
   - `pnpm run lint`
   - `pnpm run verify`
