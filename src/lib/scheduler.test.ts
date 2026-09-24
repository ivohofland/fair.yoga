import { describe, it, expect, vi, onTestFinished, type Mock } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { log } from './log';
import type { NoneOf } from './type-pins';
import {
  buildJobs,
  isolatedSweeps,
  makeTick,
  scheduleJobs,
  type Job,
  type JobHealth,
  type SchedulerSweeps,
  type SchedulerTimers,
} from './scheduler';

const MINUTE = 60 * 1000;
const db = {} as unknown as PrismaClient;

/**
 * The sweeps `SchedulerSweeps` names, written once.
 *
 * Hoisted because both tests below used to carry their own verbatim copy, so
 * the list existed three times (here and in each test) and nothing made the
 * copies agree.
 */
const SWEEP_NAMES = [
  'autoTransitionToInProgress',
  'autoCancelClasses',
  'autoCompleteClasses',
  'generateClassInstances',
  'generateStudioClassInstances',
  'processEmailFallback',
  'processPaymentReminders',
  'cleanupExpiredAuth',
  'runWaitlistReconciliationTick',
  'reapClosedWaitlistEntries',
  'reapExpiredNotifications',
  'auditTeacherTimezones',
] as const;

type StubbedName = (typeof SWEEP_NAMES)[number];

/**
 * The stub list and `SchedulerSweeps` must name the same sweeps.
 *
 * `buildStubs` below ends in `as unknown as SchedulerSweeps`, and that cast is
 * not gratuitous — `Object.fromEntries` yields `{[k: string]: T}`, which a
 * single `as SchedulerSweeps` rejects (TS2352, no implicit index signature on
 * an interface), so the double cast is what makes the construction compile at
 * all. The cost is that it also defeats the check the type would otherwise
 * provide: add a field to `SchedulerSweeps` and the stub object still
 * type-checks, passing `undefined` for the sweep nobody stubbed.
 *
 * These two pins restore it, in the repo's own idiom (`lib/type-pins.ts`). A
 * missing stub fails as `Type 'true' is not assignable to type
 * '"theNewSweep"'` — naming the offender, at compile time, which is what the
 * cast took away.
 */
const _stubsCoverSweeps: NoneOf<Exclude<keyof SchedulerSweeps, StubbedName>> = true;
const _stubsHaveNoExtras: NoneOf<Exclude<StubbedName, keyof SchedulerSweeps>> = true;
void _stubsCoverSweeps;
void _stubsHaveNoExtras;

function buildStubs(make: (name: StubbedName) => () => Promise<unknown>): SchedulerSweeps {
  return Object.fromEntries(
    SWEEP_NAMES.map((name) => [name, make(name)]),
  ) as unknown as SchedulerSweeps;
}

describe('isolatedSweeps', () => {
  it('runs every sweep even when some fail, and rethrows the first error', async () => {
    const ran: string[] = [];
    const boom = new Error('first');
    const run = isolatedSweeps('test', [
      async () => {
        ran.push('a');
        throw boom;
      },
      async () => {
        ran.push('b');
        throw new Error('second');
      },
      async () => {
        ran.push('c');
      },
    ]);

    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());

    await expect(run(db)).rejects.toBe(boom);
    expect(ran).toEqual(['a', 'b', 'c']);
  });

  it('resolves when every sweep succeeds', async () => {
    const run = isolatedSweeps('test', [async () => {}, async () => {}]);
    await expect(run(db)).resolves.toBeUndefined();
  });
});

describe('buildJobs', () => {
  /**
   * The job table itself, which nothing asserted before this: deleting a job,
   * misspelling its name, or changing its interval was invisible to the whole
   * suite.
   *
   * The names are the keys `/api/health` reports under, so a rename is a silent
   * break in an operator's dashboard rather than a compile error. The intervals
   * are not all convention — `waitlist-reconciliation` runs every minute because
   * the first-come-first-claimed window is only sixty wide, so at
   * `email-fallback`'s five minutes a dropped broadcast would cost a student 8%
   * of their claim window instead of under 2%. Nothing else in the suite would
   * notice that number changing.
   */
  it('registers each job under its name at its intended interval', () => {
    const jobs = buildJobs(buildStubs(() => async () => {}));

    expect(jobs.map((j) => [j.name, j.intervalMs])).toEqual([
      ['class-transitions', 1 * MINUTE],
      ['email-fallback', 5 * MINUTE],
      ['class-generation', 60 * MINUTE],
      ['payment-reminders', 60 * MINUTE],
      ['daily-cleanup', 24 * 60 * MINUTE],
      ['waitlist-reconciliation', 1 * MINUTE],
    ]);
  });

  /**
   * Which sweeps each job runs, keyed BY JOB rather than as one flat call
   * order. The flat form coupled this test to the order of the job table as
   * well as to each job's contents, so swapping two behaviourally independent
   * jobs failed a test for no behavioural reason. Order WITHIN a job is still
   * asserted, because `isolatedSweeps` order is meaningful — a class must
   * transition to in-progress before it can be completed.
   */
  it('routes each job to the sweep it names', async () => {
    const called: string[] = [];
    const sweeps = buildStubs((name) => async () => {
      called.push(name);
    });

    const calledByJob: Record<string, string[]> = {};
    for (const job of buildJobs(sweeps)) {
      called.length = 0;
      await job.run(db);
      calledByJob[job.name] = [...called];
    }

    // Without this, a job could carry the right name and interval while running
    // the wrong sweep — the table would look correct and do nothing useful.
    expect(calledByJob).toEqual({
      'class-transitions': [
        'autoTransitionToInProgress',
        'autoCancelClasses',
        'autoCompleteClasses',
      ],
      'email-fallback': ['processEmailFallback'],
      'class-generation': ['generateClassInstances', 'generateStudioClassInstances'],
      'payment-reminders': ['processPaymentReminders'],
      // The ORDER here is pinned without being load-bearing. `isolatedSweeps`
      // order is meaningful for `class-transitions` — a class must transition
      // to in-progress before it can be completed — and this assertion is a
      // whole-map equality, so it pins order everywhere. Nothing couples the
      // sweeps in this job to one another; do not read a dependency into this
      // line.
      'daily-cleanup': [
        'cleanupExpiredAuth',
        'reapClosedWaitlistEntries',
        'reapExpiredNotifications',
        // Last, so a real failure in any sweep above still surfaces as the
        // job's `lastError` rather than being masked by a standing data
        // problem this one reports every run until someone fixes the row.
        'auditTeacherTimezones',
      ],
      'waitlist-reconciliation': ['runWaitlistReconciliationTick'],
    });
  });
});

describe('makeTick', () => {
  function fixture(run: Job['run']): { job: Job; health: JobHealth } {
    return {
      job: { name: 'test-job', intervalMs: MINUTE, run },
      health: { lastRunAt: null, lastSuccessAt: null, lastError: null },
    };
  }

  /**
   * The re-entrancy guard, whose deletion used to fail nothing.
   *
   * It is load-bearing by another module's argument:
   * `waitlist-reconciliation.ts` accepts a duplicate-notification race
   * specifically on the grounds that "the sweep cannot race ITSELF — the
   * `job.running` guard refuses a tick while one is running". A premise a
   * documented trade-off rests on should not be the one line nothing covers.
   */
  it('refuses a tick while one is already running', async () => {
    let runs = 0;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      release = r;
    });
    const { job, health } = fixture(async () => {
      runs += 1;
      await started;
    });
    const tick = makeTick(job, health, db);

    const first = tick();
    // Not awaited: the second tick lands while the first is still inside its
    // run, which is the whole condition under test.
    await tick();
    expect(runs).toBe(1);

    release();
    await first;
    expect(runs).toBe(1);

    // And the guard is released, so the next scheduled tick is not lost.
    await tick();
    expect(runs).toBe(2);
  });

  it('records a success and clears any previous error', async () => {
    const { job, health } = fixture(async () => {});
    health.lastError = 'a failure from an earlier tick';

    await makeTick(job, health, db)();

    expect(health.lastRunAt).not.toBeNull();
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastError).toBeNull();
  });

  /**
   * A throwing job must leave `lastError` set and `lastSuccessAt` untouched —
   * this is the whole path by which `/api/health` reports a job degraded, and
   * it is why the waitlist sweep throws `ReconciliationFailedError` on a tick
   * that failed every class it invoked and is worth escalating, rather than
   * swallowing it.
   */
  it('records a failure without stamping success, and releases the guard', async () => {
    const { job, health } = fixture(async () => {
      throw new Error('sweep exploded');
    });
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());

    await makeTick(job, health, db)();

    expect(health.lastError).toBe('sweep exploded');
    expect(health.lastSuccessAt).toBeNull();
    // `finally`, not the success path: a job that throws every tick must still
    // be allowed to try again rather than wedging itself permanently.
    expect(job.running).toBe(false);
  });
});

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
    // by position. A tick bound to a same-interval sibling job leaves this
    // multiset unchanged, though — that swap is caught by the health test
    // below, not here.
    const observed: Array<[string, string, number]> = [];
    for (const r of registrations) {
      ran.length = 0;
      await r.fn();
      expect(ran).toHaveLength(1);
      observed.push([r.kind, ran[0]!, r.ms]);
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

    // Every registration, timeout and interval, run alone: reset every entry
    // first (a job's timeout and interval both write the same entry, so a
    // second stamp of an already-stamped one would not read as "new") and
    // check the set it stamps is exactly the job that ran.
    for (const r of registrations) {
      for (const entry of Object.values(health)) {
        entry.lastRunAt = null;
        entry.lastSuccessAt = null;
      }
      ran.length = 0;
      await r.fn();
      expect(stamped()).toEqual(ran);
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
