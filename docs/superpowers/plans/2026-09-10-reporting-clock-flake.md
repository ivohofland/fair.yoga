# Fix the once-daily reporting-page.test.ts flake at 23:59 America/Los_Angeles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #558 — the issue-278 regression fixture in
`tests/integration/reporting-page.test.ts` (`'excludes a studio class dated
today whose start instant is in the future (issue 278)'`) pins Studio Class
D's start time to a fixed wall-clock target, `hhmmToTime('23:59')`, on
`localToday`. The property under test is "a start instant later than now is
excluded" — the fixed target does not express that; it expresses "23:59 is
excluded", which happens to also be true of the property under test only
while real Pacific time is still before 23:59. Once the request-handling
`now` in `src/app/(teacher)/settings/reporting/page.tsx` reads at or past
23:59:00 Pacific on the fixture's `localToday`, the same fixed instant that
was "in the future" when the fixture was built has become "in the past" by
request time, and the class the test asserts is *excluded* is now
*included* — flipping the assertion at `line 481` (`toContain('50.00')`)
red for one HTTP round trip's worth of time, once a day.

**Premise verified against current `main` (`ab384e4e`):** read the fixture
(`tests/integration/reporting-page.test.ts:461-484`), the filter it
exercises (`classStartInstant(s.calendarEntry, session.defaultTimezone) <=
now` in `page.tsx:73-75`), and `classStartInstant` itself
(`src/lib/timezone.ts:203-`, minute-granularity: `Date.UTC(..., hours,
minutes, 0, 0)`). The issue's mechanism, precedent (#123), and both
suggested remedies (fixed offset ahead of `now`, clamped inside the Pacific
day; or a frozen clock) all hold up. A frozen clock is not available here:
this is an integration test against a live `next dev` process reading
`new Date()` server-side at request time, in a separate process from the
test — nothing in the test process can freeze the server's clock. The fixed
offset is the only one of the two remedies this test can use, and is
implemented below.

**Architecture:** One file changes — a local, test-only helper plus one
fixture's `startTime` computation. No production code changes: this is a
test-fixture defect, not an application defect (`classStartInstant` and the
reporting page's `<=` comparison are both already correct; #278's exclusion
logic is what this fixture exists to pin, and it isn't broken). Single task
— one file, reviewed once; no cross-task seam to protect, so no whole-branch
review step per `solve-issue`'s single-task exception.

**Tech Stack:** TypeScript (strict), Vitest (`--project integration`),
against this worktree's own isolated dev server (port from `worktree:setup`,
already run — `npm run worktree:up` needed before this suite runs).

## Global Constraints

- `npm run typecheck` = `tsc --noEmit`.
- Fast inner loop once the worktree's dev server is up:
  `pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts`
- Do not touch `:3000` — this worktree has its own dev server and databases.
- No schema, no migration.
- Comment Discipline (CLAUDE.md): the new helper's comment states *why* a
  fixed offset replaces a fixed target — no reaching past this file, no
  prose census.

---

### Task 1: Replace the fixed 23:59 target with a margin ahead of `now`, clamped to the Pacific day

**Files:**
- Modify: `tests/integration/reporting-page.test.ts`

**Interfaces:**
- Produces: a local (not exported — this is test-fixture-construction logic,
  scoped to this file, not a second place pinning application timezone
  behavior) helper that, given an instant and a margin in minutes, returns
  an `"HH:mm"` string representing that instant's Pacific wall-clock time of
  day plus the margin, clamped to `23:59` (the file already imports
  `hhmmToTime` from `@/lib/time-of-day`, which the helper's output feeds).
- Consumed by: the issue-278 `it()` block, replacing its
  `startTime: hhmmToTime('23:59')` for Studio Class D.
- Does not touch Studio Class A/B/C in the preceding `it()` — none of those
  three fixtures use a wall-clock-relative target (A is `00:00`, a
  time that has "started" for the entire Pacific day by construction; B is
  dated tomorrow, excluded on `date`, not on start instant; C is cancelled).
  Confirm this while implementing rather than assume it — re-read all four
  fixtures in the `describe('timezone boundary discrimination...')` block
  before editing.

- [ ] **Step 1: Add the margin-based Pacific time-of-day helper**

  In `tests/integration/reporting-page.test.ts`, near the top of the
  `describe('timezone boundary discrimination for west-of-UTC teacher', ...)`
  block (or immediately above the `it()` that uses it — pick whichever reads
  better once written), add:

  ```ts
  const PACIFIC_TZ = 'America/Los_Angeles';

  /**
   * `instant`'s Pacific wall-clock minute-of-day, `marginMinutes` later,
   * clamped to `23:59` — never rolls into the next Pacific calendar day.
   *
   * A fixed clock target (e.g. always `23:59`) is a race against real time:
   * once a day, whatever `now` this runs at converges on the target, and the
   * safety margin between "fixture built" and "server reads its own `now`"
   * shrinks to zero and then goes negative (#558). Anchoring to `now` instead
   * keeps that margin at a constant `marginMinutes` for all but the last
   * `marginMinutes` of the Pacific day, where it shrinks the same way the
   * fixed target always did — but only in that window, not every run.
   */
  function pacificHHmmAfter(instant: Date, marginMinutes: number): string {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: PACIFIC_TZ,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant);
    const hour = Number(parts.find((p) => p.type === 'hour')!.value);
    const minute = Number(parts.find((p) => p.type === 'minute')!.value);
    const clamped = Math.min(hour * 60 + minute + marginMinutes, 23 * 60 + 59);
    return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
  }
  ```

  Use `PACIFIC_TZ` to replace the two existing `'America/Los_Angeles'`
  string literals in the same `describe` block (the `startOfLocalDay` calls)
  — introducing a second untethered literal alongside a new one is exactly
  the kind of drift Comment Discipline exists to avoid, and `replace_all` on
  that one string makes it free to fix while in the file.

- [ ] **Step 2: Point Studio Class D at the new helper**

  In the issue-278 `it()` (`tests/integration/reporting-page.test.ts:461-484`),
  replace:

  ```ts
  startTime: hhmmToTime('23:59'),
  ```

  with:

  ```ts
  startTime: hhmmToTime(pacificHHmmAfter(now, 10)),
  ```

  10 minutes: comfortably larger than a single fixture-insert-plus-one-fetch
  round trip under concurrent integration-test load, while still reading as
  "later today" in the fixture's own comments. Update the two comments
  naming `23:59` in this block (`// Studio Class D: ... in the future
  (23:59) -> EXCLUDED` and the inline `// but in the future (23:59)`) to
  describe the margin instead of the literal clock value, since the literal
  is no longer true.

- [ ] **Step 3: Run the suite, confirm green**

  With this worktree's dev server up (`pnpm run worktree:up` if not already),
  run:

  ```
  pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts
  ```

  Full pass required, including both tests in the `describe('timezone
  boundary discrimination...')` block (they share fixture state — Studio
  Class A's fixture from the first `it()` must still be the only thing
  contributing to the second `it()`'s totals).

- [ ] **Step 4: Prove the fixture still catches the #278 regression**

  Per the issue's acceptance criteria and `solve-issue`'s "prove every guard
  bites": temporarily reintroduce the #278 bug in
  `src/app/(teacher)/settings/reporting/page.tsx` — change the studio-class
  filter from

  ```ts
  const completedStudioClasses = studioClasses.filter(
    (s) => classStartInstant(s.calendarEntry, session.defaultTimezone) <= now,
  );
  ```

  to unconditionally include every studio class dated on-or-before today
  (e.g. `.filter(() => true)`, or drop the `.filter(...)` and use
  `studioClasses` directly) — run the same command as Step 3, confirm the
  issue-278 `it()` goes **red** with the exact failure text, restore
  `page.tsx` to its original filter, re-run, confirm **green** again. Record
  the red failure text in the task report for the PR body.

- [ ] **Step 5: Prove the fixture no longer depends on wall-clock position**

  This is the property Step 4 cannot exercise (Step 4 proves the fixture
  still catches a *broken filter*; this step proves it no longer flakes on a
  *correct filter* near the boundary the old fixture raced against).
  Temporarily hardcode `marginMinutes` to a very small or negative number
  (e.g. `pacificHHmmAfter(now, -1)`, one minute in the *past*) — confirm the
  same test now goes red for the *opposite* reason (Class D's `60.00`
  appears, because a start instant one minute in the past is correctly
  included) — this confirms the helper's output is actually load-bearing in
  the assertion, not dead code the test would pass without. Restore
  `marginMinutes` to `10`, re-run, confirm green. This does not require the
  suite to actually span real 23:59 Pacific to verify — it verifies the
  mechanism directly, which is what the acceptance criterion's manual
  "deliberately start the suite so it spans 23:59" check would otherwise be
  standing in for.

- [ ] **Step 6: Full verify**

  `npm run typecheck` (or the worktree-scoped equivalent) and
  `pnpm exec vitest run --project integration tests/integration/reporting-page.test.ts`
  green. Note in the task report whether `pnpm run verify` was run in full
  or just this targeted command, per the fast-inner-loop guidance in
  `solve-issue`.
