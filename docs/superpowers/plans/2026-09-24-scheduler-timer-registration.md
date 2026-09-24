# Scheduler timer registration pin (#225) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the loop that joins `buildJobs` to `makeTick` in `src/lib/scheduler.ts` assertable, so a wrong interval, boot delay, missing `unref()`, mis-bound tick or orphaned health entry fails a test.

**Architecture:** Extract the body of `startScheduler`'s `for (const job of jobs)` loop into an exported `scheduleJobs(jobs, db, health, timers = { setTimeout, setInterval })`. Tests pass a recording `timers` object and read back `(fn, ms)` pairs plus each handle's `unref`; one fake-timer test covers the default argument. `startScheduler` calls `scheduleJobs(jobs, prisma, health)` and carries no number of its own.

**Tech Stack:** TypeScript strict, Vitest (`unit` project), Node timers.

**Spec:** none — single file, one approach; the direction and the premise measurement are recorded below.

## Premise, as measured (2026-09-24)

- Mutation `setInterval(tick, job.intervalMs)` → `setInterval(tick, 60 * MINUTE)` together with `setTimeout(tick, 15 * 1000)` → `setTimeout(tick, 99 * 1000)`: `pnpm exec vitest run --project unit --project unit-sweeps --project components` → 275 files, 3363 tests, all passed. Restored afterwards.
- `integration` cannot see it either: `startScheduler`'s only caller is `src/instrumentation.ts`, and CI runs the app with `CRON_SCHEDULER: 'off'` (`.github/workflows/ci.yml`, three jobs).
- The issue names the `setInterval` line and the boot delay. The unpinned seam is the whole loop body: also `.unref()`, the `health[job.name]` entry `/api/health` reads (a tick given a different `JobHealth` object would leave that entry null forever), and which job each tick is bound to.

## Direction

Chosen: inject the timer functions (the issue's second option), with the loop extracted so health registration and tick binding are covered by the same tests. Rejected: driving `startScheduler` under `vi.useFakeTimers()` — it would mean mocking `@/lib/db`, ten service modules and `globalThis` flags to test four lines.

## Global Constraints

- TypeScript `strict`, no `any` (`@typescript-eslint/no-explicit-any: error`).
- Comment Discipline (CLAUDE.md): comments annotate the code they sit on, state what is true now, no counts or rosters in prose, no "previously" history.
- `src/lib/scheduler.ts` must stay free of new imports; `@/lib/log` is already imported there.
- Stage exact paths; never `git add -A`.

## Review Focus

1. A test that asserts `ms` against `job.intervalMs` read from the same object handed to `scheduleJobs`, with no link to which job the tick runs, passes when two jobs' ticks are swapped — the test must identify the job by running the registered function.
2. The boot delay must be asserted as the literal `15 * 1000`, not against an exported constant (asserting a constant against itself cannot fail).
3. The default `timers` argument is a new unpinned link — `{ setTimeout, setInterval: setTimeout }` must fail a test.
4. The health entry must be the object the tick writes to, not just a key that exists.
5. `unref()` must be asserted per handle, both kinds.

---

### Task 1: Extract and pin `scheduleJobs`

**Files:**
- Modify: `src/lib/scheduler.ts` (the loop in `startScheduler`, plus a new exported interface and function)
- Test: `src/lib/scheduler.test.ts` (new `describe('scheduleJobs')` block)

**Interfaces:**
- Produces:
  ```ts
  export interface SchedulerTimers {
    setTimeout: (fn: () => Promise<void>, ms: number) => { unref: () => unknown };
    setInterval: (fn: () => Promise<void>, ms: number) => { unref: () => unknown };
  }
  export function scheduleJobs(
    jobs: Job[],
    db: PrismaClient,
    health: Record<string, JobHealth>,
    timers?: SchedulerTimers, // defaults to { setTimeout, setInterval }
  ): void;
  ```
  `fn` is typed as returning `Promise<void>` because the tick is async and the test must await it; Node's global `setTimeout`/`setInterval` still satisfy the type.

- [ ] **Step 1: Write the failing tests**

Add `scheduleJobs` and `type SchedulerTimers` to the existing import from `./scheduler`, and `type Mock` to the `vitest` import. Append:

```ts
describe('scheduleJobs', () => {
  interface Registration {
    kind: 'timeout' | 'interval';
    fn: () => Promise<void>;
    ms: number;
    unref: Mock<() => unknown>;
  }

  /** Timers that record what they were asked for instead of starting a clock. */
  function recordingTimers(): { timers: SchedulerTimers; registrations: Registration[] } {
    const registrations: Registration[] = [];
    const record =
      (kind: Registration['kind']) =>
      (fn: () => Promise<void>, ms: number) => {
        const unref = vi.fn<() => unknown>();
        registrations.push({ kind, fn, ms, unref });
        return { unref };
      };
    return {
      timers: { setTimeout: record('timeout'), setInterval: record('interval') },
      registrations,
    };
  }

  /**
   * The real job table with each `run` replaced by a recorder, so a registered
   * function can be traced back to the job it runs. Name and interval come from
   * `buildJobs`, whose own test pins them as literals — together the two tests
   * cover the table and its use.
   */
  function tracedJobs(): { jobs: Job[]; ran: string[] } {
    const ran: string[] = [];
    const jobs = buildJobs(buildStubs(() => async () => {})).map((job) => ({
      name: job.name,
      intervalMs: job.intervalMs,
      run: async () => {
        ran.push(job.name);
      },
    }));
    return { jobs, ran };
  }

  it("registers each job's first run 15 seconds after boot and its repeat at its own interval", async () => {
    const { jobs, ran } = tracedJobs();
    const { timers, registrations } = recordingTimers();

    scheduleJobs(jobs, db, {}, timers);

    // Identify each registration by the job its function actually runs, not
    // by position: a tick bound to the wrong job must fail here even when the
    // two jobs share an interval.
    const observed: Array<[string, string, number]> = [];
    for (const r of registrations) {
      ran.length = 0;
      await r.fn();
      expect(ran).toHaveLength(1);
      observed.push([r.kind, ran[0], r.ms]);
    }

    const expected = jobs.flatMap((job): Array<[string, string, number]> => [
      ['timeout', job.name, 15 * 1000],
      ['interval', job.name, job.intervalMs],
    ]);
    const byKey = (a: [string, string, number], b: [string, string, number]): number =>
      `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`);
    expect(observed.sort(byKey)).toEqual(expected.sort(byKey));
  });

  it('unrefs every timer, so none keeps a shutting-down process alive', () => {
    const { jobs } = tracedJobs();
    const { timers, registrations } = recordingTimers();

    scheduleJobs(jobs, db, {}, timers);

    expect(registrations).toHaveLength(jobs.length * 2);
    for (const r of registrations) expect(r.unref).toHaveBeenCalledTimes(1);
  });

  /**
   * `/api/health` reads the entry registered here; if the tick wrote to any
   * other object, the job would run and its health would read null forever.
   */
  it("registers a health entry per job that the job's own tick writes to", async () => {
    const { jobs, ran } = tracedJobs();
    const { timers, registrations } = recordingTimers();
    const health: Record<string, JobHealth> = {};

    scheduleJobs(jobs, db, health, timers);

    expect(Object.keys(health).sort()).toEqual(jobs.map((j) => j.name).sort());

    const stamped = (): string[] =>
      Object.entries(health)
        .filter(([, entry]) => entry.lastSuccessAt !== null)
        .map(([name]) => name);

    // One interval tick per job, each run alone: the entry it newly stamps
    // must be the one registered under the name of the job it ran.
    for (const r of registrations.filter((reg) => reg.kind === 'interval')) {
      const before = new Set(stamped());
      ran.length = 0;
      await r.fn();
      expect(stamped().filter((name) => !before.has(name))).toEqual(ran);
    }
  });

  /**
   * The default argument is the one line of wiring the recording tests above
   * cannot see; run it against faked globals so `setTimeout` and `setInterval`
   * cannot be swapped or dropped unnoticed.
   */
  it('defaults to the global timers: once after 15 seconds, then every interval', async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    let runs = 0;
    const job: Job = {
      name: 'test-job',
      intervalMs: MINUTE,
      run: async () => {
        runs += 1;
      },
    };

    scheduleJobs([job], db, {});

    await vi.advanceTimersByTimeAsync(15 * 1000 - 1);
    expect(runs).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toBe(1);
    // The interval runs from registration, not from the boot run.
    await vi.advanceTimersByTimeAsync(MINUTE - 15 * 1000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(runs).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`
Expected: FAIL — `scheduleJobs` is not exported (a TypeScript/import error, or `scheduleJobs is not a function`).

- [ ] **Step 3: Extract `scheduleJobs`**

In `src/lib/scheduler.ts`, replace the `health` line and the `for` loop in `startScheduler` with:

```ts
  scheduleJobs(jobs, prisma, (globalThis.__fairYogaJobHealth ??= {}));
```

and add, below `startScheduler`:

```ts
/** The timer functions `scheduleJobs` registers with, injectable for tests. */
export interface SchedulerTimers {
  setTimeout: (fn: () => Promise<void>, ms: number) => { unref: () => unknown };
  setInterval: (fn: () => Promise<void>, ms: number) => { unref: () => unknown };
}

/**
 * Registers each job's tick: once shortly after boot, then on the job's own
 * interval, with its health entry under the job's name. Separated from
 * `startScheduler` for the reason `buildJobs` and `makeTick` were — this is
 * where the table's intervals are used rather than merely stated, and a test
 * can record what was registered without starting a clock.
 */
export function scheduleJobs(
  jobs: Job[],
  db: PrismaClient,
  health: Record<string, JobHealth>,
  timers: SchedulerTimers = { setTimeout, setInterval },
): void {
  for (const job of jobs) {
    const jobHealth: JobHealth = { lastRunAt: null, lastSuccessAt: null, lastError: null };
    health[job.name] = jobHealth;
    const tick = makeTick(job, jobHealth, db);

    // First run shortly after boot, then on the interval. unref() so the
    // timers never keep a shutting-down process alive.
    timers.setTimeout(tick, 15 * 1000).unref();
    timers.setInterval(tick, job.intervalMs).unref();
  }
}
```

If `{ setTimeout, setInterval }` does not type-check against `SchedulerTimers` (DOM and Node lib overloads), report the exact compiler error rather than widening the interface or casting — the interface's narrowness is what the recording timers rely on.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`
Expected: PASS, every `scheduleJobs` test plus the existing ones.

Then: `pnpm run typecheck` and `pnpm run lint` — both clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduler.ts src/lib/scheduler.test.ts
git commit -m "test(scheduler): pin timer registration — intervals, boot delay, unref, health (#225)"
```

Committed before Step 6 so the mutation restores cannot discard it.

- [ ] **Step 6: Prove each guard bites**

Apply each mutation alone to `src/lib/scheduler.ts`, run `pnpm exec vitest run --project unit src/lib/scheduler.test.ts`, record the failing test name and the first assertion line of its error, then restore with `git checkout src/lib/scheduler.ts`. End with `git status --short` clean.

| # | Mutation | Must fail |
|---|---|---|
| M1 | `timers.setInterval(tick, job.intervalMs)` → `timers.setInterval(tick, 60 * 60 * 1000)` | first test |
| M2 | `timers.setTimeout(tick, 15 * 1000)` → `timers.setTimeout(tick, 99 * 1000)` | first test and the default-timers test |
| M3 | delete `.unref()` after `timers.setInterval(...)` | unref test |
| M4 | `makeTick(job, jobHealth, db)` → `makeTick(job, { lastRunAt: null, lastSuccessAt: null, lastError: null }, db)` | health test |
| M5 | `makeTick(job, jobHealth, db)` → `makeTick(jobs[0], jobHealth, db)` | first test |
| M6 | default `{ setTimeout, setInterval }` → `{ setTimeout, setInterval: setTimeout }` | default-timers test |

If any mutation survives, the test is wrong — fix it, commit the fix separately, and re-run that mutation; do not weaken the table.
