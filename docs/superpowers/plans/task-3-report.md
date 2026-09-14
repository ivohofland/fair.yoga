# Task 3 Report: End-to-end lifecycle test under non-UTC session TimeZone (#289)

**Plan:** [2026-09-14-pre-lock-superset-timezone.md](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-pre-lock-superset-timezone.md)  
**Date:** 2026-09-14  
**Status:** Complete ✅

---

## 1. Summary of Changes

In [`src/services/class-template-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-template-lifecycle.test.ts), under `describe('archiveOrUnarchiveTemplate (DB)', () => ...)`, added the test:
`'the pre-lock is a superset of the delete in a non-UTC session TimeZone'`.

### Implementation Details
- Imported `type Prisma` from `@prisma/client`.
- Seeded teacher has `defaultTimezone: 'UTC'`.
- Created classes dated today (`startOfLocalDay(new Date(), teacher.defaultTimezone)`) and tomorrow (`+1 day`).
- Interposed on `prisma.$extends` to hook `$transaction`, executing `SET LOCAL TimeZone = '${sessionTimeZone}'` before archive statements run.
- Spied on `dbLocks.lockClassRowsOrdered` via `vi.spyOn(dbLocks, 'lockClassRowsOrdered')` and cleaned up with `onTestFinished(() => spy.mockRestore())`.
- **West of UTC (`America/New_York`)**:
  - `lockSets[0]` contains both `classTodayWest.id` and `classTomorrowWest.id` (length 2).
  - The delete (using Prisma's `date > date`) deletes only `classTomorrowWest` (`count === 0`); `classTodayWest` survives (`count === 1`).
  - `resultWest.deleted === 1`.
  - Directly proves: `lock set ⊃ delete set` (today is locked by the pre-lock but spared by the delete).
- **East of UTC (`Asia/Tokyo`)**:
  - `lockSets[0]` contains only `classTomorrowEast.id` (length 1).
  - The delete removes only `classTomorrowEast` (`count === 0`); `classTodayEast` survives (`count === 1`).
  - `resultEast.deleted === 1`.
  - Demonstrates: `lock set = delete set` (neither today nor yesterday is matched).

---

## 2. Test Verification Output

Ran vitest targeting the new test:
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "the pre-lock is a superset of the delete in a non-UTC session TimeZone"
```

Output:
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  1 passed | 67 skipped (68)
   Start at  12:31:26
   Duration  1.66s (transform 161ms, setup 0ms, import 360ms, tests 186ms, environment 0ms)
```

Ran all tests in `src/services/class-template-lifecycle.test.ts`:
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts
```

Output:
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  68 passed (68)
   Start at  12:32:51
   Duration  3.35s (transform 168ms, setup 0ms, import 369ms, tests 1.91s, environment 0ms)
```

---

## 3. Mutation Probe

### Applied Mutation
In [`src/services/class-template-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-template-lifecycle.ts) line 769:
```diff
         where: Prisma.sql`e."scheduleRuleId" = ${scheduleRuleId}
           AND e."cancelledAt" IS NULL
-          AND e.date > ${today}
+          AND e.date < ${today}
           AND c.status IN (${SCHEDULED_STATUSES_SQL})`,
```

### Mutation Probe Execution
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "the pre-lock is a superset of the delete in a non-UTC session TimeZone"
```

### Mutation Failure Output
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test
 ❯ |unit| src/services/class-template-lifecycle.test.ts (68 tests | 1 failed | 67 skipped) 151ms
     × the pre-lock is a superset of the delete in a non-UTC session TimeZone 69ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| src/services/class-template-lifecycle.test.ts > archiveOrUnarchiveTemplate (DB) > the pre-lock is a superset of the delete in a non-UTC session TimeZone
AssertionError: expected [] to deeply equal ArrayContaining{…}

- Expected
+ Received

- ArrayContaining [
-   "88415646-daec-4ad3-9fda-4fd2cf0bcd20",
-   "a6024723-a1d4-4dee-8c1e-ceca419f8f62",
- ]
+ []

 ❯ src/services/class-template-lifecycle.test.ts:2652:25
    2650|     );
    2651|
    2652|     expect(lockSets[0]).toEqual(
       |                         ^
    2653|       expect.arrayContaining([classTodayWest.id, classTomorrowWest.id]…
    2654|     );

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 67 skipped (68)
   Start at  12:31:38
   Duration  1.58s (transform 166ms, setup 0ms, import 369ms, tests 151ms, environment 0ms)
```

The mutation probe demonstrated that inverting the pre-lock comparison bound causes the pre-lock under `America/New_York` to return an empty array `[]` rather than locking `{today, tomorrow}`, failing the test at line 2652.

---

## 4. Restoration & Typecheck Verification

1. `src/services/class-template-lifecycle.ts` was restored to `AND e.date > ${today}`.
2. Verified `git diff src/services/class-template-lifecycle.ts` is empty.
3. Re-ran vitest: test passed (1 passed).
4. Ran `pnpm run typecheck`:
```
$ tsc --noEmit
Exit code: 0
```
5. No commits have been made to git.
