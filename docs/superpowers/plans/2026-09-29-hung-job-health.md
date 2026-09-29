# Hung Job Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/api/health` reports a scheduled job unhealthy once its run has stayed in flight across two consecutive ticks (#711).

**Architecture:** `makeTick`'s re-entrancy guard already sees every tick that a
run in flight makes it refuse. It will count those refused ticks in the job's
`JobHealth` and reset the count when the run settles. A single verdict
function, `isJobHealthy`, which lives in the scheduler, becomes the only rule
`/api/health` applies.

**Tech Stack:** TypeScript strict, Next.js 16 route handler, Vitest (`unit` project), pino logger (`@/lib/log`).

**Spec:** `docs/superpowers/specs/2026-09-29-hung-job-health-design.md`

## Global Constraints

- The public `/api/health` response shape is unchanged: per job, exactly `lastRunAt`, `lastSuccessAt`, `healthy`. No new field, no error text.
- `STALLED_AFTER_SKIPPED_TICKS = 2`. One refused tick is routine and stays healthy. The second refused tick in the same run reports the job unhealthy.
- No `statement_timeout` / `idle_in_transaction_session_timeout` changes (option 2 is out of scope).
- Comment Discipline (CLAUDE.md): a comment states only what is true of the code it sits on, and never quotes another file's expression, count or roster.
- Tests assert the logged fields, not the log message text.

## Review Focus

1. A hung run that finally settles **by throwing**: the stall clears (`skippedTicks` back to 0), and the job stays unhealthy on `lastError`. It must not flip to healthy, not even briefly.
2. A single overrun, meaning one refused tick, stays healthy and logs nothing. `waitlist-reconciliation` overruns routinely.
3. The boot `setTimeout` tick and the `setInterval` tick share one `JobHealth`, so a refusal by either counts toward the same streak.
4. The route answers `status: 'degraded'` for a stalled job while `db: 'up'`, and its per-job object has exactly the three public keys.
5. The route's verdict cannot quietly fall back to `lastError === null`. The route test must go red when it does.

---

### Task 1: Count refused ticks and give the verdict one home

**Files:**
- Modify: `src/lib/scheduler.ts`: `JobHealth`, `scheduleJobs`' health literal, `makeTick`, new `STALLED_AFTER_SKIPPED_TICKS` / `isJobHealthy`, and the comments named in Step 6.
- Test: `src/lib/scheduler.test.ts`

**Interfaces:**
- Produces:
  - `JobHealth.skippedTicks: number`, which is required.
  - `export const STALLED_AFTER_SKIPPED_TICKS = 2`.
  - `export function isJobHealthy(h: JobHealth): boolean`, which is `h.lastError === null && h.skippedTicks < STALLED_AFTER_SKIPPED_TICKS`.
- Task 2 consumes all three.

- [ ] **Step 1: Write the failing tests.** In `src/lib/scheduler.test.ts`:
  - Add `isJobHealthy` and `STALLED_AFTER_SKIPPED_TICKS` to the import from `./scheduler`.
  - Add `skippedTicks: 0` to the `makeTick` `fixture` helper's health literal.
  - Add a new `describe('isJobHealthy')` block.
  - Add the two `makeTick` cases below inside the existing `describe('makeTick')`.

```ts
describe('isJobHealthy', () => {
  const clean: JobHealth = { lastRunAt: null, lastSuccessAt: null, lastError: null, skippedTicks: 0 };

  it('is healthy with no error and no stall', () => {
    expect(isJobHealthy(clean)).toBe(true);
  });

  it('is unhealthy on an error alone', () => {
    expect(isJobHealthy({ ...clean, lastError: 'boom' })).toBe(false);
  });

  it('tolerates one refused tick and is unhealthy from the threshold on', () => {
    expect(STALLED_AFTER_SKIPPED_TICKS).toBe(2);
    expect(isJobHealthy({ ...clean, skippedTicks: STALLED_AFTER_SKIPPED_TICKS - 1 })).toBe(true);
    expect(isJobHealthy({ ...clean, skippedTicks: STALLED_AFTER_SKIPPED_TICKS })).toBe(false);
    expect(isJobHealthy({ ...clean, skippedTicks: STALLED_AFTER_SKIPPED_TICKS + 1 })).toBe(false);
  });
});
```

```ts
  /**
   * #711: a run that never settles holds the guard, and every later tick is
   * refused without writing any other health field — so `lastError` alone
   * would report this job healthy forever. The refused ticks are the signal.
   */
  it('reports a run that never settles unhealthy at its second refused tick, and clears when it settles', async () => {
    let release!: () => void;
    const hung = new Promise<void>((r) => {
      release = r;
    });
    const { job, health } = fixture(() => hung);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    const tick = makeTick(job, health, db);

    const first = tick();
    expect(isJobHealthy(health)).toBe(true);

    // One refused tick: a single overrun is routine, not a page.
    await tick();
    expect(health.skippedTicks).toBe(1);
    expect(isJobHealthy(health)).toBe(true);
    expect(error).not.toHaveBeenCalled();

    // Two: the run has been in flight across two of its intervals.
    await tick();
    expect(health.skippedTicks).toBe(2);
    expect(health.lastError).toBeNull();
    expect(isJobHealthy(health)).toBe(false);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ job: 'test-job', skippedTicks: 2, runningSince: health.lastRunAt }),
      expect.any(String),
    );

    release();
    await first;
    expect(health.skippedTicks).toBe(0);
    expect(isJobHealthy(health)).toBe(true);
  });

  it('keeps a hung run that finally throws unhealthy on its error once the stall clears', async () => {
    let fail!: (err: Error) => void;
    const hung = new Promise<void>((_, reject) => {
      fail = reject;
    });
    const { job, health } = fixture(() => hung);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());
    const tick = makeTick(job, health, db);

    const first = tick();
    await tick();
    await tick();
    expect(isJobHealthy(health)).toBe(false);

    fail(new Error('gave up'));
    await first;
    expect(health.skippedTicks).toBe(0);
    expect(health.lastError).toBe('gave up');
    expect(isJobHealthy(health)).toBe(false);
  });
```

Also extend the existing `scheduleJobs` test "shares one job's re-entrancy guard between its boot and interval registrations" (Review Focus 3). Pass a named `health: Record<string, JobHealth> = {}` instead of `{}`. After `expect(runs).toBe(1);`, add `expect(health['test-job']?.skippedTicks).toBe(1);`: the refusal by the interval registration counts on the same entry the boot registration's run holds. After the final `await second;`, add `expect(health['test-job']?.skippedTicks).toBe(0);`.

- [ ] **Step 2: Run the tests and see them fail.**
  - Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`
  - Expected: FAIL. `isJobHealthy` / `STALLED_AFTER_SKIPPED_TICKS` are not exported (undefined at runtime), and `pnpm exec tsc --noEmit` reports `skippedTicks` as unknown on `JobHealth`.

- [ ] **Step 3: Implement.** In `src/lib/scheduler.ts`:
  - Add `skippedTicks: number` to `JobHealth`. Its field comment says it counts the consecutive ticks refused while the current run is in flight, and that it is reset when that run settles.
  - Add `skippedTicks: 0` to the health literal in `scheduleJobs`.
  - Add, next to `JobHealth`:

```ts
/**
 * Refused ticks after which a run still in flight counts as stalled: one is a
 * routine overrun, two means the run has been in flight across two of its
 * job's intervals.
 */
export const STALLED_AFTER_SKIPPED_TICKS = 2;

function isStalled(h: JobHealth): boolean {
  return h.skippedTicks >= STALLED_AFTER_SKIPPED_TICKS;
}

/** The whole of `/api/health`'s per-job verdict: no error, and not stalled. */
export function isJobHealthy(h: JobHealth): boolean {
  return h.lastError === null && !isStalled(h);
}
```

  - In `makeTick`, replace `if (job.running) return;` with the code below, and add `jobHealth.skippedTicks = 0;` beside `job.running = false;` in `finally`.

```ts
    if (job.running) {
      jobHealth.skippedTicks += 1;
      if (isStalled(jobHealth)) {
        log.error(
          { job: job.name, skippedTicks: jobHealth.skippedTicks, runningSince: jobHealth.lastRunAt },
          'scheduler job run still in flight; reporting it unhealthy',
        );
      }
      return;
    }
```

- [ ] **Step 4: Run the tests and see them pass.**
  - Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts` and `pnpm exec tsc --noEmit`
  - Expected: PASS, and no type errors.

- [ ] **Step 5: Prove each guard bites.** Apply each mutation alone, run the scheduler test file, record the failing assertion's text, then restore. Commit the work first, so that restoring cannot discard it.
  - (a) Delete `jobHealth.skippedTicks += 1;`. Expect the never-settles case to fail at `expect(health.skippedTicks).toBe(1)`.
  - (b) Delete the `finally` reset. Expect the never-settles case to fail at the final `expect(health.skippedTicks).toBe(0)`.
  - (c) Change `>=` to `>` in `isStalled`. Expect the threshold case and the never-settles case to fail.
  - (d) Change `isJobHealthy` to `return h.lastError === null;`. Expect the stall cases to fail.
  - End with `git status` clean apart from the files this task changes.

- [ ] **Step 6: Correct the comments in `scheduler.ts` that this change makes false or incomplete.**
  - **The header's `running` flag bullet.** Add that a run holding the flag across `STALLED_AFTER_SKIPPED_TICKS` ticks reports its job unhealthy.
  - **`makeTick`'s docblock.** The guard now also counts what it refuses. Say so, and say that the count is what reports a hang.
  - **The `daily-cleanup` comment's paragraph** that quotes the route's expression (`healthy: j.lastError === null`, `health/route.ts`). Replace the quotation with a reference to `isJobHealthy`, in this same file, and to its `lastError` half. The rest of that paragraph's argument (the flag is shared across the job's sweeps) stays.
  - **The `waitlist-reconciliation` comment's sentence** "The `job.running` guard then drops the ticks it overruns". Extend it: a pass that overruns two ticks reports the job unhealthy (`STALLED_AFTER_SKIPPED_TICKS`).
  - Read each touched docblock whole. A grep finds stale names, not stale descriptions.

- [ ] **Step 7: Commit.** Stage both files by exact path, then:

```bash
git commit -m "fix(scheduler): report a job whose run never settles unhealthy (#711)"
```

---

### Task 2: The route applies the one verdict, and the docs state the bound

**Files:**
- Modify: `src/app/api/health/route.ts`
- Create: `src/app/api/health/route.test.ts`
- Modify: `DEPLOYMENT.md` §7 (Monitoring)
- Read and give a verdict on (edit only if false): the other files whose comments describe when `/api/health` reports healthy. These are `src/services/waitlist-reconciliation.ts`, `src/services/waitlist-reconciliation.test.ts`, `src/services/waitlist-retention.ts`, `src/services/timezone-audit.ts`, `src/services/generation-contention.ts` and `src/lib/api-errors.test.ts`. Re-derive the set with `grep -rn -e "healthy" -e "/api/health" src --include='*.ts'`. Do not trust this list.

**Interfaces:**
- Consumes: `isJobHealthy`, `STALLED_AFTER_SKIPPED_TICKS` and `JobHealth` (with `skippedTicks`) from `@/lib/scheduler` (Task 1).

- [ ] **Step 1: Write the failing route test**, `src/app/api/health/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { STALLED_AFTER_SKIPPED_TICKS, type JobHealth } from '@/lib/scheduler';

vi.mock('@/lib/db', () => ({ prisma: { $queryRaw: vi.fn(async () => [{ ok: 1 }]) } }));

const { GET } = await import('./route');

interface HealthBody {
  status: string;
  db: string;
  jobs: Record<string, Record<string, unknown>>;
}

function entry(overrides: Partial<JobHealth>): JobHealth {
  return {
    lastRunAt: '2026-09-29T10:00:00.000Z',
    lastSuccessAt: '2026-09-29T10:00:00.000Z',
    lastError: null,
    skippedTicks: 0,
    ...overrides,
  };
}

async function read(): Promise<{ status: number; body: HealthBody }> {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as HealthBody };
}

afterEach(() => {
  globalThis.__fairYogaJobHealth = undefined;
});

describe('GET /api/health', () => {
  it('reports a stalled job unhealthy and the service degraded, though its last completed run succeeded', async () => {
    globalThis.__fairYogaJobHealth = {
      stalled: entry({ skippedTicks: STALLED_AFTER_SKIPPED_TICKS }),
      fine: entry({}),
    };

    const { status, body } = await read();

    expect(status).toBe(200);
    expect(body.db).toBe('up');
    expect(body.status).toBe('degraded');
    expect(body.jobs.stalled).toEqual({
      lastRunAt: '2026-09-29T10:00:00.000Z',
      lastSuccessAt: '2026-09-29T10:00:00.000Z',
      healthy: false,
    });
    expect(body.jobs.fine?.healthy).toBe(true);
  });

  it('answers ok while a run has overrun only one tick', async () => {
    globalThis.__fairYogaJobHealth = { busy: entry({ skippedTicks: STALLED_AFTER_SKIPPED_TICKS - 1 }) };

    const { body } = await read();

    expect(body.status).toBe('ok');
    expect(body.jobs.busy?.healthy).toBe(true);
  });

  it('still reports a job that errored unhealthy', async () => {
    globalThis.__fairYogaJobHealth = { failing: entry({ lastError: 'boom' }) };

    const { body } = await read();

    expect(body.status).toBe('degraded');
    expect(body.jobs.failing).toEqual({
      lastRunAt: '2026-09-29T10:00:00.000Z',
      lastSuccessAt: '2026-09-29T10:00:00.000Z',
      healthy: false,
    });
  });
});
```

- [ ] **Step 2: Run the test and see it fail.**
  - Run: `pnpm exec vitest run --project unit src/app/api/health/route.test.ts`
  - Expected: the stalled case FAILS, because the route still computes `lastError === null` and so reports `healthy: true` and `status: 'ok'`. The other two pass.

- [ ] **Step 3: Implement.**
  - In `route.ts`, import `isJobHealthy` alongside `getJobHealth` and set `healthy: isJobHealthy(j)`.
  - Update the route docblock where it describes the healthy flag, if it does. It currently says "timestamps + healthy flag". Keep it true without restating the rule.

- [ ] **Step 4: Run the test and see it pass.** Run the same command. Expected: PASS.

- [ ] **Step 5: Prove the route test bites.** Commit first. Then revert `healthy:` to `j.lastError === null`, run the test, record the failure (the stalled case), and restore. Check that `git status` is clean.

- [ ] **Step 6: Update `DEPLOYMENT.md` §7.**
  - Change the first bullet's "(`jobs.<name>.healthy` flips false when a job errors)" so it also names the hang: a job whose run is still in flight when a second consecutive tick comes due (`STALLED_AFTER_SKIPPED_TICKS` in `src/lib/scheduler.ts`) is reported unhealthy. That is at most two of its intervals after the run began, so a couple of minutes for a job that runs every minute and two days for the daily one. Each job's interval is `intervalMs` in `buildJobs`.
  - It logs an `error` line naming the job, `skippedTicks` and `runningSince` on each refused tick from then on.
  - It clears when the run settles, and the verdict then rests on that run's outcome.
  - An idle-in-transaction session holding a lock is one cause. The class-generation bullet's `pg_blocking_pids()` / `pg_stat_activity` advice applies to any job.
  - Do not copy the job table into the doc.

- [ ] **Step 7: Sweep the other files' health claims.** For each file in the list above (re-derived by the grep), read every comment that says when the job reports `healthy: true` or `false`, and record a verdict per location in the task report: still true, or corrected.
  - Most describe a run that completes. A completed run has a `skippedTicks` of 0, so these claims are expected to stay true.
  - Correct only a claim that is now false. Correct it by replacing the claim, never by annotating it.

- [ ] **Step 8: Commit.** Stage the exact paths, then:

```bash
git commit -m "fix(health): apply the scheduler's one job verdict; state the hang bound (#711)"
```
