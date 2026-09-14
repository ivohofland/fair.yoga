# Implementation Plan: Pre-lock superset property test in any session TimeZone (#289)

**Issue:** #289  
**Date:** 2026-09-14  
**Branch:** `test/289-pre-lock-superset-timezone`

---

## Background & Premise Verification

PR #285 deleted `src/services/template-sync.test.ts` (7 tests) along with `syncTemplateInstances`. That deletion removed the only test pinning the pre-lock superset property:
> *"the pre-lock bound never selects fewer rows than the re-read, in any session TimeZone"*

That property still ships in `archiveOrUnarchiveTemplate` (`src/services/class-template-lifecycle.ts:669-713`). The raw pre-lock query compares `e.date > ${today}`, which Postgres evaluates as `date > timestamptz`, promoting `e.date` to midnight in the session `TimeZone`. The delete it guards compares calendar dates (`date > date` in Prisma).

### Premise Verification Findings

1. **Test Deletion**: Confirmed. `src/services/template-sync.test.ts` was deleted in PR #285 (commit `c5e69540`).
2. **Prose Location**: Shifted from `1805-1830` to `src/services/class-template-lifecycle.ts:669-713`.
3. **Subset East of UTC Refuted**: Issue #289 hypothesized that an east-of-UTC session `TimeZone` makes the pre-lock a subset. Empirical measurement in Postgres across 6 time zones (`UTC`, `Europe/Amsterdam`, `Asia/Tokyo`, `Pacific/Kiritimati`, `America/New_York`, `Pacific/Niue`) proved this false:
   - In **UTC**: pre-lock matches `{tomorrow, ...}`, delete matches `{tomorrow, ...}` (equal).
   - In **west-of-UTC** (`America/New_York`, `Pacific/Niue`): pre-lock matches `{today, tomorrow, ...}`, delete matches `{tomorrow, ...}` (**superset**; today's unbooked classes are locked but spared by the delete).
   - In **east-of-UTC** (`Europe/Amsterdam`, `Asia/Tokyo`, `Pacific/Kiritimati`): pre-lock matches `{tomorrow, ...}`, delete matches `{tomorrow, ...}` (**equal**; neither today nor yesterday is matched).
   - In **zero** session time zones does the pre-lock become a subset.
   The historic issue in `c4cc9e54` dropped tomorrow east of UTC only when binding a *raw instant* (e.g. `22:30 UTC`). Because `archiveOrUnarchiveTemplate` binds `today` (`startOfLocalDay` UTC midnight), containment (`lock set ⊇ delete set`) holds everywhere.

---

## Tasks

### Task 1: Reintroduce the deterministic SQL property test with negative control

- **File:** `src/services/class-template-lifecycle.test.ts`
- **Behavior:**
  - Evaluates `SELECT ... FROM (VALUES (DATE '2026-08-14'), (DATE '2026-08-15'), (DATE '2026-08-16')) AS t(d)` across 6 session timezones: `'UTC'`, `'Europe/Amsterdam'`, `'Asia/Tokyo'`, `'Pacific/Kiritimati'`, `'America/New_York'`, `'Pacific/Niue'`.
  - Uses fixed instant `'2026-08-15 22:30:00+00'` and UTC midnight `'2026-08-15 00:00:00+00'`.
  - Asserts that whenever `row.reread` is true (`d > DATE '2026-08-15'`), `row.shipped` (`d > TIMESTAMPTZ '${utcMidnight}'`) is also true.
  - Negative control: verifies that for east-of-UTC zones (`Asia/Tokyo`, `Pacific/Kiritimati`), `row.rawInstant` is `false` for tomorrow (`2026-08-16`), demonstrating that the test detects unsafe boundaries.
- **Mutation Probe:** Replace `utcMidnight` with `instant` in the `shipped` column. Verify test fails with `Asia/Tokyo: 2026-08-16 is wanted by the re-read but not covered by the pre-lock`. Restore.
- **Verification:** `pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "the pre-lock bound never selects fewer rows"`.

### Task 2: Pin the pre-lock bound parameter to UTC midnight

- **File:** `src/services/class-template-lifecycle.test.ts`
- **Behavior:**
  - Hooks `prisma.$extends` to intercept `$queryRaw` during `archiveOrUnarchiveTemplate`.
  - Captures the bound argument passed for `e.date > ${today}`.
  - Asserts that the captured argument is an instance of `Date` and has UTC hours, minutes, seconds, and milliseconds equal to `[0, 0, 0, 0]`.
- **Mutation Probe:** In `src/services/rule-lifecycle.ts`, temporarily replace `const today = startOfLocalDay(now, timeZone);` with `const today = now;`. Run the test and verify it fails with non-zero UTC time components. Restore.
- **Verification:** `pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "binds the pre-lock to UTC midnight"`.

### Task 3: End-to-end lifecycle test under non-UTC session TimeZone

- **File:** `src/services/class-template-lifecycle.test.ts`
- **Behavior:**
  - Creates template with two unbooked classes: one dated today (`startOfLocalDay(new Date(), 'UTC')`), one dated tomorrow (`+1 day`).
  - Uses an interposing `prisma` client that executes `SET LOCAL TimeZone = 'America/New_York'` (west-of-UTC) inside the transaction before archive statements run.
  - Spies on `dbLocks.lockClassRowsOrdered` to observe the locked class IDs.
  - Calls `archiveOrUnarchiveTemplate(hookedPrisma, template.id, teacher.id, 'archived')`.
  - Asserts:
    - `lockSets[0]` contains both `classToday.id` and `classTomorrow.id` (superset).
    - `classTomorrow` is deleted (count 0); `classToday` survives (count 1).
    - `result.deleted === 1`.
  - Also runs under `Asia/Tokyo`:
    - `lockSets[0]` contains only `classTomorrow.id`.
    - `classTomorrow` is deleted; `classToday` survives.
- **Mutation Probe:** In `src/services/class-template-lifecycle.ts:769`, mutate `AND e.date > ${today}` to `AND e.date < ${today}`. Verify test fails. Restore.
- **Verification:** `pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "session TimeZone"`.

### Task 4: Docblock clarity & full repo verification

- **File:** `src/services/class-template-lifecycle.ts`
- **Changes:**
  - Refine docblock at lines 669–713 to note that containment is pinned by tests in `class-template-lifecycle.test.ts` across session TimeZones, and clarify that east-of-UTC produces equality (not subset) when binding UTC midnight.
- **Verification:**
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm test`
  - `pnpm run verify`
