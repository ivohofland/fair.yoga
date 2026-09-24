# CRON_SCHEDULER=off is a CI setting — Implementation Plan (#678)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Following the repo's deployment docs can no longer produce a deployment in which waitlist reconciliation never runs: `CRON_SCHEDULER=off` stops being documented as a production mode, and the app warns at boot when it is set.

**Architecture:** Issue #678's option (2). The scheduled jobs run in the app process, full stop; `CRON_SCHEDULER=off` is what CI sets while tests drive the services with their own clocks. The `/api/cron/*` endpoints stay, documented for manual runs alongside the scheduler. One code change: `startScheduler`'s off-branch logs at `warn`, not `info`, and names the mode as not-for-production.

**Tech Stack:** Next.js 16 route handlers, pino (`@/lib/log`), vitest.

**Spec:** none — the spec gate was declined (one subsystem, one approach, no change to data, money, auth or concurrency). The direction and why options (1) and (3) were rejected are recorded under *Direction* below; the issue itself (`gh issue view 678`) is the requirements document.

## Direction

- **(1) `/api/cron/waitlist-reconciliation` — rejected.** The issue frames it as "one endpoint, streak in module state", and the streak already is module state (`productionStreaks`, `src/services/waitlist-reconciliation.ts`). But the scheduler gives every job two more things an HTTP path would have to rebuild: `makeTick`'s `job.running` guard (a reconciliation tick can overrun its interval — `buildJobs`' comment says so — and two overlapping calls would interleave writes to one streak object) and the `getJobHealth()` registry, which is all `/api/health` reads and is empty with the scheduler off. And the one-minute cadence, which `scheduler.test.ts` pins because it is correctness-relevant, would move to operator timer config nothing checks.
- **(3) refuse to boot in production with the scheduler off — rejected.** CI runs the built app with `CRON_SCHEDULER: 'off'` (`.github/workflows/ci.yml`, three jobs). A production-only refusal needs an escape hatch for CI, and that hatch is the same flag renamed.
- **(2) — taken**, the maintainer's stated lean in the issue, plus a boot `warn` so someone who sets the flag anyway is told at the moment it takes effect.

## Premise check (measured 2026-09-24 on `origin/main` a6d04ae6)

- `ls src/app/api/cron/` → 5 routes: `daily-cleanup`, `email-fallback`, `generate-classes`, `payment-reminders`, `transition-classes`. `buildJobs` returns 6 jobs; every one except `waitlist-reconciliation` has a route. Holds.
- The #678 gap is already *stated* on main: `DEPLOYMENT.md` §5 ("Waitlist reconciliation has no endpoint yet (#678)") and `docs/technical-architecture.md` § Cron Jobs both carry a note added by #677. The mode is still documented as supported, so the acceptance criterion does not hold yet.
- `.env.example`'s `CRON_SECRET` block says "the scheduler sends" the secret and "without it … no lifecycle automation runs". `grep -rln CRON_SECRET src` → only `cron-auth.ts` (+ its test, the worktree env-file helper, and `scheduler.ts`'s header, which says the in-process path needs no secret). Both claims are false today; fixed in Task 2 because it is the same block describing the same mode.

## Global Constraints

- Comment Discipline (CLAUDE.md): comments annotate their own code; no prose rosters or counts; no correction history ("an earlier revision…") — that goes in the PR body.
- Never `git add -A` / `git add .`; stage exact paths.
- Commit messages end with the `Co-Authored-By` line given in the session.
- Never write the phrase "does not close #N" anywhere (GitHub's parser closes the issue).

## Review Focus

1. **A reader following `DEPLOYMENT.md` top to bottom** must find no sentence that still offers `CRON_SCHEDULER=off` or an external timer as a way to run production. Checked by the Task 2 sweep, not a test.
2. **A reader who sets the flag anyway** (from an old `.env`, or AGENTS.md) must see a `warn`, not an `info` a `LOG_LEVEL=warn` config would hide. Pinned by Task 1's test.
3. **The `daily-cleanup` route's status contract** (200 / 503 / 500) is unchanged: only comments move in that file. `route.test.ts` must pass unedited apart from its two comments.
4. **`/api/cron/*` still works for manual runs**: no route changes, no auth change.
5. **CI**, which still sets the flag, must not fail on the new `warn` — it is a log line, nothing asserts on CI's server log.

---

### Task 1: `startScheduler` warns when the scheduler is off

**Files:**
- Modify: `src/lib/scheduler.ts` — the `CRON_SCHEDULER === 'off'` branch of `startScheduler`, and the module header's two bullets that describe the endpoints and the flag
- Test: `src/lib/scheduler.test.ts` — the existing `it('registers nothing when CRON_SCHEDULER=off', …)`

**Interfaces:** none produced or consumed; `startScheduler(): Promise<void>` keeps its signature.

- [ ] **Step 1: Write the failing test.** Extend the existing off-mode test (keep its name's meaning, widen it): spy `log.warn` alongside the existing `log.info` spy, restore it in `onTestFinished`, and after `await startScheduler()` assert

```ts
expect(getJobHealth()).toEqual({});
expect(setIntervalSpy).not.toHaveBeenCalled();
expect(warn).toHaveBeenCalledTimes(1);
expect(warn).toHaveBeenCalledWith(expect.stringContaining('CRON_SCHEDULER=off'));
expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a production mode'));
expect(info).not.toHaveBeenCalled();
```

Rename the test to `'registers nothing, and warns, when CRON_SCHEDULER=off'`.

- [ ] **Step 2: Run it and see it fail.**
`pnpm exec vitest run src/lib/scheduler.test.ts` — expected: the off-mode test fails on `expect(warn).toHaveBeenCalledTimes(1)` (0 calls). Record the exact failure text in the task report.

- [ ] **Step 3: Implement.** In `startScheduler`:

```ts
if (process.env.CRON_SCHEDULER === 'off') {
  log.warn(
    'scheduler disabled via CRON_SCHEDULER=off — no scheduled job runs in this process; a CI setting, not a production mode (DEPLOYMENT.md §5)',
  );
  return;
}
```

In the module header: the bullet ending "The /api/cron/* endpoints remain for manual runs and external schedulers." becomes "…remain for manual runs." The `CRON_SCHEDULER=off` bullet states what is true now: it disables the scheduler, CI sets it (CI runs the built app while tests drive the same services with explicit clocks), it is not a production mode, and `startScheduler` warns when it is set. No roster of jobs, no mention of which jobs lack an endpoint (that claim is owned by `DEPLOYMENT.md`).

- [ ] **Step 4: Run it and see it pass.** Same command; the whole file green.

- [ ] **Step 5: Prove the pin bites.** Mutate the branch back to `log.info(...)` (same message), run the file, record the exact failure text, restore, re-run green, and confirm `git status --short` shows only the intended files. Second mutation: keep `log.warn` but drop the "not a production mode" clause from the message — must fail on the second `stringContaining`. Record, restore, re-run.

- [ ] **Step 6: Commit.**
```bash
git add src/lib/scheduler.ts src/lib/scheduler.test.ts
git commit -m "fix(scheduler): warn at boot when CRON_SCHEDULER=off (#678)"
```

---

### Task 2: Documentation — the in-process scheduler is the only production mode

**Files (all prose; no behaviour changes):**
- Modify: `DEPLOYMENT.md` §5 "Scheduled jobs"
- Modify: `docs/technical-architecture.md` § Cron Jobs (the paragraph above the table)
- Modify: `.env.example` — the `CRON_SECRET` block and the `CRON_SCHEDULER` block
- Modify: `AGENTS.md` § Cron scheduler
- Modify: `src/app/api/cron/daily-cleanup/route.ts` — comments only
- Modify: `src/app/api/cron/daily-cleanup/route.test.ts` — two docblocks only

**Interfaces:** consumes Task 1's log text only in that `DEPLOYMENT.md` may say "the app logs a warning at boot when the scheduler is off".

- [ ] **Step 1: `DEPLOYMENT.md` §5.** Rewrite so it says, in this order:
  1. The scheduled jobs (roster in `src/lib/scheduler.ts`, also `docs/technical-architecture.md` § Cron Jobs) run inside the app process, and in production they must — nothing to configure.
  2. `CRON_SCHEDULER=off` is a CI setting (tests drive the same services with their own clocks), not a production mode. With it set, nothing runs waitlist reconciliation — it has no endpoint — so a seat freed by a cancellation whose spot-freed hook was dropped (§7) is never offered to the queue. The app logs a warning at boot when the scheduler is off.
  3. The `/api/cron/*` endpoints are for running a job by hand (after an outage, say), alongside the scheduler rather than instead of it. Keep the existing `curl --fail …` block and its `# also:` line unchanged.
  4. The `--fail` paragraph, kept, but argued from a scripted or manual call rather than a systemd timer: the status is the verdict (200 / 503 / 500, meanings unchanged), the body carries every outcome (`data.auth.ok`, `data.waitlistRetention.ok`, `data.notificationRetention.ok`, `data.timezoneAudit.ok`), and without `--fail` `curl` exits 0 on all of them, so a script reports success for a run in which a sweep did not run.
  Remove the "(#678)" note and every mention of systemd timers / driving the jobs externally.

- [ ] **Step 2: `docs/technical-architecture.md` § Cron Jobs.** Replace the last sentence of the paragraph above the table ("The `/api/cron/*` endpoints remain for manual runs and external schedulers — every job except waitlist reconciliation, which has no HTTP trigger yet (#678).") with: the endpoints remain for manual runs alongside the scheduler — every job except waitlist reconciliation has one — and `CRON_SCHEDULER=off` is a CI setting, not a production mode (`DEPLOYMENT.md` §5). Leave the rest of the paragraph and the table alone.

- [ ] **Step 3: `.env.example`.**
  - `CRON_SECRET` block: the secret authorises manual calls to `/api/cron/*` (`Authorization: Bearer <secret>`); without it those endpoints fail closed; the in-process scheduler does not use it. Keep `CRON_SECRET=""`.
  - `CRON_SCHEDULER` block: the in-process scheduler (jobs: `src/lib/scheduler.ts` — no prose roster) starts with the server and must run in production; `"off"` is for CI only, see `DEPLOYMENT.md` §5 for what stops. Keep the line `# CRON_SCHEDULER="off"` commented out.

- [ ] **Step 4: `AGENTS.md` § Cron scheduler.** One or two sentences: the in-process scheduler starts with the server and is how scheduled jobs run in production; `CRON_SCHEDULER="off"` disables it — CI sets it, production must not (`DEPLOYMENT.md` §5); the `/api/cron/*` endpoints are for manual runs.

- [ ] **Step 5: `daily-cleanup/route.ts` comments.** Every comment in this file that argues from "`DEPLOYMENT.md` documents `CRON_SCHEDULER=off` + systemd timers as a supported mode" is now false. Find them with `grep -n "systemd\|CRON_SCHEDULER\|external schedulers" src/app/api/cron/daily-cleanup/route.ts` (on `a6d04ae6`: lines 51, 66, 90, 98, 128) and give each hit a verdict:
  - The module docblock's quote of `scheduler.ts`'s header ("remain for manual runs and external schedulers") must match Task 1's new header wording ("remain for manual runs").
  - The isolation paragraph: the reason sweeps are isolated is that a thrown sweep must not skip the ones after it on this route either — state that without the systemd mode.
  - The paragraph beginning "An earlier revision answered 200 unconditionally…" is correction history whose argument rests on the removed mode; delete it (the paragraph above it already carries the why: a 2xx means "what you asked for happened"). Its content goes in the PR body.
  - The comment above `auditTeacherTimezones`: keep "Last, matching the scheduler job this route mirrors"; drop the systemd-mode clause.
  - The `settle` catch comment: "under a systemd timer is a `curl` whose output may go nowhere" → a scripted `curl`'s output may go nowhere.
  No code change in this file: `git diff` of it must show comment lines only.

- [ ] **Step 6: `daily-cleanup/route.test.ts` docblocks.** Same grep on the test file (on `a6d04ae6`: lines 130, 214). The retention-isolation docblock must not claim a documented off mode; the timezone-audit docblock's "503 tells a systemd timer to back off" → "503 tells a caller to back off". No assertion changes.

- [ ] **Step 7: Sweep for what was invalidated.**
```bash
grep -rniE "systemd|external scheduler|external cron|drive them externally|#678|external schedulers" DEPLOYMENT.md AGENTS.md README.md .env.example docs src scripts | grep -v docs/superpowers
```
Expected: no hits, except anything you can name a reason to keep (report each survivor with its verdict). Then `grep -rn "CRON_SCHEDULER" . --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git | grep -v docs/superpowers` and give every hit a verdict: each must describe the flag as CI-only or be code/CI config.

- [ ] **Step 8: Run the touched test files.** `pnpm exec vitest run src/app/api/cron/daily-cleanup/route.test.ts src/lib/scheduler.test.ts` — green. `pnpm run typecheck && pnpm run lint` — green.

- [ ] **Step 9: Commit.**
```bash
git add DEPLOYMENT.md docs/technical-architecture.md .env.example AGENTS.md src/app/api/cron/daily-cleanup/route.ts src/app/api/cron/daily-cleanup/route.test.ts
git commit -m "docs(scheduler): CRON_SCHEDULER=off is a CI setting, not a production mode (#678)"
```
