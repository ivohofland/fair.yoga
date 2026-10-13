# Probe horizon judged at the next sweep — Implementation Plan (#860)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A template edit's answer never names a first week whose only candidate starts before the next nominal sweep can run — for studio templates, the half of #860 that #859 left open.

**Architecture:** `updateRule` (`src/services/rule-lifecycle.ts`) builds the probe's candidate horizon from occurrences whose start is after `now`. The sweep (`generateEntriesForRule`, `src/services/entry-generation.ts`) keeps only a candidate whose start is strictly after its own run instant. The fix filters the horizon on `start > at`, where `at = now + CLASS_GENERATION_INTERVAL_MS` is the instant `updateRule` already judges the class family's `past_cancel_check` and `lateFirstClass` at. One rule for both families, extracted into a pure exported function so the millisecond boundaries are unit-testable.

**Tech Stack:** TypeScript strict, Vitest (unit + DB-backed service tests), Prisma.

**Spec:** none — issue #860 itself (option 1) plus its 2026-10-13 comment. No spec: one subsystem, one approach, chosen in the issue.

## Premise, as measured

- The class family already gets option 1 from #859: the probe drops a candidate whose auto-cancel check is past at `at`, and the shortest check is 1 h (`CANCEL_CHECK_HOURS.HOURS_1`) = `CLASS_GENERATION_INTERVAL_MS` (60 min). A surviving class candidate's check is after `at`, so its start is after `at + 1 h`. The new horizon filter is therefore a no-op for that family, and changes no class answer.
- The studio family has `pastCancelCheck: null`, so the probe still names a candidate 40 minutes out. `studio-class-template-lifecycle.test.ts`, case "still names the near week for a candidate starting within the hour", pins exactly that, and this plan inverts it.
- The `min(now + interval, start)` cap (#860's fourth criterion) is already gone (#859). Nothing to do there.
- The generator's comparison is strict (`start > startDate`, `entry-generation.ts` `generateEntriesForRule`), so a candidate starting exactly at `at` is one a sweep at `at` skips: the horizon excludes it.

## Global Constraints

- Comment Discipline (CLAUDE.md): comments state what is true now; no "#860 used to…" history in code; no counts or rosters in prose.
- No new runtime imports into `entry-generation.ts`; the helper takes `at` as a parameter rather than importing `CLASS_GENERATION_INTERVAL_MS`, so `updateRule` owns the one derivation of `at`.

## Review Focus

1. A candidate exactly at `at`: excluded (strict `>`, matching the generator). Pinned in Task 1.
2. A non-UTC teacher zone: the boundary is judged on the zone-resolved start instant, not UTC wall time. Pinned in Task 1.
3. `now` and `at` on different UTC dates: occurrences still enumerate from `now`, so no candidate on `now`'s date is lost to the enumeration. Pinned in Task 1.
4. A studio candidate just past the interval (≈90 min out) is still named. Pinned in Task 2.
5. The class family's answer is unchanged — the existing #859 cases in `class-template-lifecycle.test.ts` must stay green untouched.

---

### Task 1: `probeHorizon` — the pure horizon helper

**Files:**
- Modify: `src/services/entry-generation.ts` (new export beside `getNextOccurrences`)
- Test: `src/services/entry-generation.test.ts` (new `describe('probeHorizon')`)

**Interfaces:**
- Produces: `export function probeHorizon(rule: { dayOfWeek: number; startTime: Date }, timeZone: string, now: Date, at: Date): Date[]` — the next `DEFAULT_WEEKS * 2` occurrences of `rule.dayOfWeek` enumerated from `now`, keeping only those whose `classStartInstant({ date, startTime: rule.startTime }, timeZone)` is strictly after `at`.

- [ ] **Step 1: Write the failing tests.** In `entry-generation.test.ts`, import `probeHorizon` and `hhmmToTime` (`@/lib/time-of-day`). Use a Tuesday occurrence, `2026-10-20` (schema `dayOfWeek: 1`), `startTime: hhmmToTime('10:00')`, zone `'UTC'`, so the candidate's start `S = 2026-10-20T10:00:00.000Z`. For each case set `now = at - 60 min`:
  - `at = S - 1 ms` → horizon[0] is `2026-10-20`.
  - `at = S` → horizon[0] is `2026-10-27`.
  - `at = S + 1 ms` → horizon[0] is `2026-10-27`.
  - Zone `'Europe/Amsterdam'` (CEST, UTC+2 on that date), same rule: start instant is `2026-10-20T08:00:00.000Z`; `at` 1 ms before it keeps `2026-10-20`, `at` equal to it drops it.
  - `now = 2026-10-19T23:30:00.000Z`, `at = now + 60 min` (next UTC date), rule Tuesday `10:00` UTC: horizon[0] is `2026-10-20` (enumeration from `now` loses nothing).
  - `now` well before (`2026-10-13T00:00Z`), `at = now + 60 min`: horizon has `DEFAULT_WEEKS * 2` members, all Tuesdays, ascending.

- [ ] **Step 2: Run, see them fail** — `pnpm exec vitest run --project unit src/services/entry-generation.test.ts` . Expected: `probeHorizon` is not exported.

- [ ] **Step 3: Implement.** In `entry-generation.ts`:

```ts
export function probeHorizon(
  rule: { dayOfWeek: number; startTime: Date },
  timeZone: string,
  now: Date,
  at: Date,
): Date[] {
  return getNextOccurrences(rule.dayOfWeek, now, DEFAULT_WEEKS * 2).filter(
    (date) => classStartInstant({ date, startTime: rule.startTime }, timeZone) > at,
  );
}
```

  With a docblock stating: the candidates an edit's probe considers; strictly after `at`, the same strict comparison the generator's own window applies at its run instant, so a candidate a sweep running at `at` would skip is not named; enumerated from `now` rather than `at` so that a candidate on `now`'s date is not lost when `at` falls on the next UTC date; `DEFAULT_WEEKS * 2` for the reason `DEFAULT_WEEKS`'s own docblock gives. The caller owns `at` (point at `updateRule`).

- [ ] **Step 4: Run, see them pass.** Then **prove the strictness bites**: change `> at` to `>= at`, re-run, record the failing case's exact assertion text (the `at = S` case), restore, re-run green.

- [ ] **Step 5: Commit** — `git add src/services/entry-generation.ts src/services/entry-generation.test.ts`; message `feat: probeHorizon keeps only candidates starting after the next sweep (#860)`.

### Task 2: `updateRule` judges the horizon at `at`

**Files:**
- Modify: `src/services/rule-lifecycle.ts` (`updateRule`'s horizon block and the `at` comment; `UpdateRuleResult.firstEffective` docblock if it describes the horizon)
- Modify: `src/services/entry-generation.ts` (`probeFirstEffectiveWeek` docblock: the horizon's start bound is now the caller's `at`; `DEFAULT_WEEKS` docblock if it describes the horizon's lower bound)
- Test: `src/services/studio-class-template-lifecycle.test.ts` (`updateStudioClassTemplate (DB)`)

**Interfaces:**
- Consumes: `probeHorizon(rule, timeZone, now, at)` from Task 1.

- [ ] **Step 1: Write the failing tests.** In `studio-class-template-lifecycle.test.ts`:
  - Invert the existing case "still names the near week for a candidate starting within the hour": rename it to say the answer names the following week, and assert `result.firstEffective` equals `mondayOf(near) + 7 days`. Rewrite its leading comment to state the current rule: a candidate starting before the next nominal sweep may never be generated, so the answer names the week after (#860).
  - Add a sibling case with the same seeding but `target = now + 90 min`, asserting the answer still names `mondayOf(near)` — a candidate past the interval is named.
  - Both cases: if `target`'s UTC date differs from `now`'s, the arithmetic still holds (the test derives `near` from `target`); keep that.

- [ ] **Step 2: Run, see the inverted case fail** — `pnpm exec vitest run --project unit src/services/studio-class-template-lifecycle.test.ts -t "near"` (the `unit` project includes `src/**/*.test.ts`, DB-backed service tests among them, against the worktree's own test database). Expected: the 40-minute case answers `mondayOf(near)`.

- [ ] **Step 3: Implement.** In `updateRule`: move the `at` declaration above the horizon, and replace the inline `getNextOccurrences(...).filter(... > now)` with `probeHorizon(updatedRule, timeZone, now, at)`. Drop `getNextOccurrences`'s import from `rule-lifecycle.ts` if nothing else there uses it. Rewrite the `at` comment so it states what is true now: `at` is the latest instant the next nominal sweep runs; the horizon, the probe's `past_cancel_check` decline and the late-first-class judgement are all judged at it, so they cannot disagree; a sweep earlier than nominal may fill a candidate the answer skipped (class arrives a week earlier than named — the tolerated direction); a sweep later than nominal can still miss the named candidate, bounded by how late it runs. Remove the "#860's imprecision" sentence.

- [ ] **Step 4: Run, see green**, then the whole `class-template-lifecycle.test.ts` and `rule-lifecycle.test.ts` too (Review Focus 5: unchanged). **Prove it bites**: revert `updateRule` to pass `now` as `at` to `probeHorizon`, re-run the studio file, record the exact failing assertion, restore.

- [ ] **Step 5: Comment sweep.** `grep -n "after now\|> now\|#860\|still after" src/services/rule-lifecycle.ts src/services/entry-generation.ts` and read `probeFirstEffectiveWeek`'s and `UpdateRuleResult.firstEffective`'s whole docblocks: where they describe the horizon's lower bound or list the generator refusals the probe reproduces, make them say the horizon starts after the caller's `at` (pointing at `probeHorizon`), which reproduces the generator's own window filter at the sweep's instant. Give every grep hit a verdict.

- [ ] **Step 6: Commit** — stage the exact touched paths; message `fix: a template edit names no week whose candidate starts before the next sweep (#860)`.
