# Task 1 Implementation Report: Pre-lock Superset Property Test in Any Session TimeZone (#289)

**Issue:** #289  
**Plan:** `docs/superpowers/plans/2026-09-14-pre-lock-superset-timezone.md`  
**Status:** Completed  

---

## 1. Summary of Changes

In `src/services/class-template-lifecycle.test.ts`, under `describe('archiveOrUnarchiveTemplate (DB)', () => ...)`, added the deterministic SQL property test:
`'the pre-lock bound never selects fewer rows than the re-read, in any session TimeZone'`.

### Specifications Implemented
- **Time zones tested:** `['UTC', 'Europe/Amsterdam', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'Pacific/Niue']`.
- **Bound values:**
  - `instant = '2026-08-15 22:30:00+00'`
  - `utcMidnight = '2026-08-15 00:00:00+00'`
- **Query:** Evaluates `VALUES (DATE '2026-08-14'), (DATE '2026-08-15'), (DATE '2026-08-16')` with columns:
  - `d::text AS day`
  - `(d > DATE '2026-08-15') AS reread`
  - `(d > TIMESTAMPTZ '${utcMidnight}') AS shipped`
  - `(d > TIMESTAMPTZ '${instant}') AS "rawInstant"`
- **Property Assertion:** For every row, if `row.reread` is true, `row.shipped` must be true.
- **Negative Control:** For east-of-UTC zones (`Asia/Tokyo` and `Pacific/Kiritimati`), tomorrow (`2026-08-16`) has `row.rawInstant === false` and `row.shipped === true`, verifying that the test actively distinguishes the safe UTC-midnight bound from the unsafe raw-instant bound.

---

## 2. Git Diff

```diff
diff --git a/src/services/class-template-lifecycle.test.ts b/src/services/class-template-lifecycle.test.ts
index fc0987be..f9104a0d 100644
--- a/src/services/class-template-lifecycle.test.ts
+++ b/src/services/class-template-lifecycle.test.ts
@@ -2503,6 +2503,58 @@ describe('archiveOrUnarchiveTemplate (DB)', () => {
     }
   });
 
+  it('the pre-lock bound never selects fewer rows than the re-read, in any session TimeZone', async () => {
+    // 22:30 UTC: late enough that a raw-instant bound stops covering
+    // tomorrow once the session TimeZone is far enough east.
+    const instant = '2026-08-15 22:30:00+00';
+    const utcMidnight = '2026-08-15 00:00:00+00';
+
+    for (const timeZone of [
+      'UTC',
+      'Europe/Amsterdam',
+      'Asia/Tokyo',
+      'Pacific/Kiritimati',
+      'America/New_York',
+      'Pacific/Niue',
+    ]) {
+      const rows = await prisma.$transaction(async (tx) => {
+        await tx.$executeRawUnsafe(`SET LOCAL TimeZone = '${timeZone}'`);
+        return tx.$queryRawUnsafe<
+          Array<{ day: string; reread: boolean; shipped: boolean; rawInstant: boolean }>
+        >(`
+          SELECT d::text                                        AS day,
+                 (d > DATE '2026-08-15')                        AS reread,
+                 (d > TIMESTAMPTZ '${utcMidnight}')             AS shipped,
+                 (d > TIMESTAMPTZ '${instant}')                 AS "rawInstant"
+          FROM (VALUES (DATE '2026-08-14'), (DATE '2026-08-15'), (DATE '2026-08-16')) AS t(d)
+        `);
+      });
+
+      for (const row of rows) {
+        // The guarantee: superset in every session TimeZone, subset in none.
+        // Stated as an implication rather than equality — west of UTC the
+        // shipped bound legitimately locks today as well, which the re-read
+        // then excludes, and that direction is safe.
+        if (row.reread) {
+          expect(
+            row.shipped,
+            `${timeZone}: ${row.day} is wanted by the re-read but not covered by the pre-lock`,
+          ).toBe(true);
+        }
+      }
+
+      // The negative control, so this test cannot quietly become vacuous:
+      // the bound this replaced DID drop tomorrow east of UTC. If Postgres
+      // ever stopped promoting `date` through the session TimeZone, both
+      // columns would agree everywhere and the assertion above would pass
+      // without meaning anything.
+      const tomorrow = rows.find((r) => r.day === '2026-08-16');
+      if (timeZone === 'Asia/Tokyo' || timeZone === 'Pacific/Kiritimati') {
+        expect(tomorrow?.rawInstant).toBe(false);
+        expect(tomorrow?.shipped).toBe(true);
+      }
+    }
+  });
 });
 
 describe('pauseOrResumeTemplate (DB)', () => {
```

---

## 3. Vitest Output (Passing)

Command:
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "the pre-lock bound never selects fewer rows"
```

Output:
```text
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  1 passed | 65 skipped (66)
   Start at  11:55:47
   Duration  1.63s (transform 178ms, setup 0ms, import 399ms, tests 122ms, environment 0ms)
```

---

## 4. Mutation Probe

### Mutation Applied
Replaced `${utcMidnight}` with `${instant}` in the `shipped` column of the query:
```diff
-                 (d > TIMESTAMPTZ '${utcMidnight}')             AS shipped,
+                 (d > TIMESTAMPTZ '${instant}')                 AS shipped,
```

### Exact Vitest Error Output
```text
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test
 ❯ |unit| src/services/class-template-lifecycle.test.ts (66 tests | 1 failed | 65 skipped) 101ms
     × the pre-lock bound never selects fewer rows than the re-read, in any session TimeZone 16ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  |unit| src/services/class-template-lifecycle.test.ts > archiveOrUnarchiveTemplate (DB) > the pre-lock bound never selects fewer rows than the re-read, in any session TimeZone
AssertionError: Europe/Amsterdam: 2026-08-16 is wanted by the re-read but not covered by the pre-lock: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

 ❯ src/services/class-template-lifecycle.test.ts:2542:13
    2540|             row.shipped,
    2541|             `${timeZone}: ${row.day} is wanted by the re-read but not …
    2542|           ).toBe(true);
       |             ^
    2543|         }
    2544|       }

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 65 skipped (66)
   Start at  11:55:54
   Duration  1.64s (transform 181ms, setup 0ms, import 396ms, tests 101ms, environment 0ms)
```

*(Note: As `Europe/Amsterdam` (UTC+2 in DST) is evaluated immediately after `UTC`, the assertion fails on `Europe/Amsterdam` at 2026-08-16, where 22:30 UTC is 00:30 local time on 2026-08-16, confirming that any timezone east of UTC drops tomorrow when binding raw instant).*

---

## 5. Restoration and Re-verification

The mutation was reverted back to `${utcMidnight}`.

Re-verification command:
```bash
pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "the pre-lock bound never selects fewer rows"
```

Output:
```text
 RUN  v4.1.10 /Users/ivohofland/Projects/fair.yoga

[unit-db] unit tests run against ethical_yoga_test

 Test Files  1 passed (1)
      Tests  1 passed | 65 skipped (66)
   Start at  11:56:02
   Duration  1.62s (transform 172ms, setup 0ms, import 364ms, tests 113ms, environment 0ms)
```

Typecheck command:
```bash
pnpm run typecheck
```
Output:
```text
$ tsc --noEmit
# Exit code 0 (clean pass)
```
