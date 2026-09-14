# Task 2 Report: Pin the pre-lock bound parameter to UTC midnight (#289)

**Plan:** [2026-09-14-pre-lock-superset-timezone.md](file:///Users/ivohofland/Projects/fair.yoga/docs/superpowers/plans/2026-09-14-pre-lock-superset-timezone.md)  
**Date:** 2026-09-14  
**Status:** Complete ✅

---

## 1. Summary of Changes

In [`src/services/class-template-lifecycle.test.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/class-template-lifecycle.test.ts), under `describe('archiveOrUnarchiveTemplate (DB)', () => ...)`, added the unit test:
`'binds the pre-lock to UTC midnight, not the raw instant'`.

### Implementation Details
- Uses `prisma.$extends` with a query hook on `$queryRaw`.
- Intercepts `$queryRaw` when `args.values` contains the target template's `scheduleRuleId`.
- Captures the bound `Date` object passed for `today` in the pre-lock query (`e.date > ${today}`).
- Asserts that:
  1. `capturedToday` is an instance of `Date` (`expect(boundToday).toBeInstanceOf(Date)`).
  2. The UTC hours, minutes, seconds, and milliseconds of the captured `Date` are `[0, 0, 0, 0]` (`[d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()].toEqual([0, 0, 0, 0])`).

---

## 2. Test Verification Output

Ran vitest targeting the new test:
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "binds the pre-lock to UTC midnight"
```

Output:
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  1 passed | 66 skipped (67)
   Start at  12:17:50
   Duration  1.56s (transform 167ms, setup 0ms, import 376ms, tests 128ms, environment 0ms)
```

Running both pre-lock tests:
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "pre-lock"
```

Output:
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  2 passed | 65 skipped (67)
   Start at  12:18:02
   Duration  1.64s (transform 174ms, setup 0ms, import 380ms, tests 153ms, environment 0ms)
```

---

## 3. Mutation Probe

### Applied Mutation
In [`src/services/rule-lifecycle.ts`](file:///Users/ivohofland/Projects/fair.yoga/src/services/rule-lifecycle.ts) line 704:
```diff
- const today = startOfLocalDay(now, timeZone);
+ const today = now;
```

### Mutation Probe Execution
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "binds the pre-lock to UTC midnight"
```

### Mutation Failure Output
```
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test
 ❯ |unit| src/services/class-template-lifecycle.test.ts (67 tests | 1 failed | 66 skipped) 127ms
     × binds the pre-lock to UTC midnight, not the raw instant 41ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| src/services/class-template-lifecycle.test.ts > archiveOrUnarchiveTemplate (DB) > binds the pre-lock to UTC midnight, not the raw instant
AssertionError: expected [ 10, 17, 42, 489 ] to deeply equal [ +0, +0, +0, +0 ]

- Expected
+ Received

  [
-   0,
-   0,
-   0,
-   0,
+   10,
+   17,
+   42,
+   489,
  ]

 ❯ src/services/class-template-lifecycle.test.ts:2584:8
    2582|       d.getUTCSeconds(),
    2583|       d.getUTCMilliseconds(),
    2584|     ]).toEqual([0, 0, 0, 0]);
       |        ^
    2585|   });
    2586| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 66 skipped (67)
   Start at  12:17:40
   Duration  1.59s (transform 168ms, setup 0ms, import 371ms, tests 127ms, environment 0ms)
```

The mutation probe demonstrated that a non-truncated instant bound fails with non-zero time components, certifying the test assertion.

---

## 4. Restoration & Typecheck Verification

1. `src/services/rule-lifecycle.ts` was restored to `const today = startOfLocalDay(now, timeZone);`.
2. Verified `git diff src/services/rule-lifecycle.ts` is empty.
3. Re-ran vitest: test passed (1 passed).
4. Ran `pnpm run typecheck`:
```
$ tsc --noEmit
Exit code: 0
```
5. No commits have been made.
