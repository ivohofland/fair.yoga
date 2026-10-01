/**
 * In-process job scheduler — the single-VPS answer to "what triggers the
 * crons?". Started once from instrumentation.ts when the Node server boots.
 *
 * Design decisions:
 * - Jobs call the services directly (no HTTP round-trip, no CRON_SECRET
 *   needed for the in-process path). The /api/cron/* endpoints remain for
 *   manual runs.
 * - These jobs have had their send guarded against an overlapping trigger at
 *   the DB layer, and were measured: `payment-reminders` stamps
 *   `reminderSentAt` with a conditional `updateMany` and abandons the
 *   notification when the count is zero (`payment-reminders.ts`, the
 *   `$transaction` around its stamp); `email-fallback` claims each
 *   notification — `emailSent: false -> true`, count checked — BEFORE calling
 *   Resend, releasing the claim if the send fails; `class-reminders` stamps
 *   `Registration.classReminderSentAt` and `Class.teacherReminderSentAt` with
 *   a conditional `updateMany` inside a `$transaction` before any inbox row
 *   or email, and skips the reminder when the count is zero — measured by
 *   `class-reminders.test.ts` interposing a whole second sweep between the
 *   candidate read and the claim.
 *
 *   That is a statement about the jobs it names, NOT a survey. `class-transitions`
 *   also sends recipient-visible notifications — `autoCancelClasses` writes a
 *   `class_cancelled` set (`class-transitions.ts`) and `autoCompleteClasses`
 *   reaches `completeClass`'s `payment_request` set (`class-lifecycle.ts`) —
 *   and neither was examined for this.
 * - A per-job `running` flag prevents a slow tick from stacking on itself. A
 *   run holding that flag across `STALLED_AFTER_SKIPPED_TICKS` ticks makes
 *   `isJobHealthy` report its job unhealthy.
 * - CRON_SCHEDULER=off disables the scheduler entirely and is a CI setting,
 *   not a production mode (`DEPLOYMENT.md` §5). `startScheduler` warns when
 *   it is set.
 */

import type { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';

export interface Job {
  name: string;
  intervalMs: number;
  run: (db: PrismaClient) => Promise<unknown>;
  running?: boolean;
}

/** The sweeps `buildJobs` arranges, injected so the arrangement is testable. */
export interface SchedulerSweeps {
  autoTransitionToInProgress: (db: PrismaClient) => Promise<unknown>;
  autoCancelClasses: (db: PrismaClient) => Promise<unknown>;
  autoCompleteClasses: (db: PrismaClient) => Promise<unknown>;
  /**
   * The WRAPPERS, never `generateClassInstances` / `generateStudioClassInstances`
   * themselves. Each sweep takes a required second argument carrying the
   * cross-sweep contention streaks, and TypeScript refuses to assign a
   * two-parameter function to these one-parameter slots, so miswiring one is a
   * compile error rather than a sweep that silently forgets between runs.
   */
  runClassGenerationTick: (db: PrismaClient) => Promise<unknown>;
  runStudioClassGenerationTick: (db: PrismaClient) => Promise<unknown>;
  processEmailFallback: (db: PrismaClient) => Promise<unknown>;
  processPaymentReminders: (db: PrismaClient) => Promise<unknown>;
  processClassReminders: (db: PrismaClient) => Promise<unknown>;
  cleanupExpiredAuth: (db: PrismaClient) => Promise<unknown>;
  /**
   * The WRAPPER, never `reconcileWaitlists` itself — and the name is the
   * smaller half of why. `reconcileWaitlists` takes a required second argument
   * carrying the cross-tick streak state, and TypeScript refuses to assign a
   * two-parameter function to this one-parameter slot, so miswiring it is a
   * compile error rather than a sweep that silently forgets between ticks.
   */
  runWaitlistReconciliationTick: (db: PrismaClient) => Promise<unknown>;
  reapClosedWaitlistEntries: (db: PrismaClient) => Promise<unknown>;
  reapExpiredNotifications: (db: PrismaClient) => Promise<unknown>;
  auditTeacherTimezones: (db: PrismaClient) => Promise<unknown>;
}

const MINUTE = 60 * 1000;

/**
 * Runs each sweep in isolation: a failure in one must not starve the others.
 * Every failure is logged with its sweep name; the first is rethrown so job
 * health still surfaces the failure.
 */
export function isolatedSweeps(
  job: string,
  sweeps: Array<(db: PrismaClient) => Promise<unknown>>,
): (db: PrismaClient) => Promise<void> {
  return async (db) => {
    const errors: unknown[] = [];
    for (const sweep of sweeps) {
      try {
        await sweep(db);
      } catch (err) {
        log.error({ err, sweep: sweep.name }, `${job} sweep failed`);
        errors.push(err);
      }
    }
    if (errors.length > 0) throw errors[0];
  };
}

/** Last-run bookkeeping per job, surfaced by /api/health. */
export interface JobHealth {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /**
   * Consecutive ticks refused by the re-entrancy guard while the current run
   * is still in flight. Reset to 0 when that run settles.
   */
  skippedTicks: number;
}

/**
 * Refused ticks after which a run still in flight counts as stalled: one is a
 * routine overrun, two means the run is still in flight at the second tick
 * that came due after it began.
 */
export const STALLED_AFTER_SKIPPED_TICKS = 2;

function isStalled(h: JobHealth): boolean {
  return h.skippedTicks >= STALLED_AFTER_SKIPPED_TICKS;
}

/**
 * A job is healthy when its last settled run left no error and its current
 * run is not stalled (`STALLED_AFTER_SKIPPED_TICKS`).
 */
export function isJobHealthy(h: JobHealth): boolean {
  return h.lastError === null && !isStalled(h);
}

declare global {
  // Survives dev-server HMR: the scheduler must start at most once.
  var __fairYogaSchedulerStarted: boolean | undefined;
  // Global so the health route reads the same registry regardless of
  // which bundle context imported this module.
  var __fairYogaJobHealth: Record<string, JobHealth> | undefined;
}

export function getJobHealth(): Record<string, JobHealth> {
  return globalThis.__fairYogaJobHealth ?? {};
}

export async function startScheduler(): Promise<void> {
  if (process.env.CRON_SCHEDULER === 'off') {
    log.warn(
      'scheduler disabled via CRON_SCHEDULER=off — no scheduled job runs in this process; a CI setting, not a production mode (DEPLOYMENT.md §5)',
    );
    return;
  }
  if (globalThis.__fairYogaSchedulerStarted) return;
  globalThis.__fairYogaSchedulerStarted = true;

  // Dynamic imports keep instrumentation.ts loadable in the edge runtime,
  // where these modules (and the scheduler itself) must not run.
  const { prisma } = await import('@/lib/db');
  const { autoTransitionToInProgress, autoCancelClasses, autoCompleteClasses } =
    await import('@/services/class-transitions');
  const { runClassGenerationTick } = await import('@/services/class-generator');
  const { runStudioClassGenerationTick } = await import('@/services/studio-class-generator');
  const { processEmailFallback } = await import('@/services/email-fallback');
  const { processPaymentReminders } = await import('@/services/payment-reminders');
  const { processClassReminders } = await import('@/services/class-reminders');
  const { cleanupExpiredAuth } = await import('@/services/auth-cleanup');
  const { runWaitlistReconciliationTick } = await import('@/services/waitlist-reconciliation');
  const { reapClosedWaitlistEntries } = await import('@/services/waitlist-retention');
  const { reapExpiredNotifications } = await import('@/services/notification-retention');
  const { auditTeacherTimezones } = await import('@/services/timezone-audit');

  const jobs = buildJobs({
    autoTransitionToInProgress,
    autoCancelClasses,
    autoCompleteClasses,
    runClassGenerationTick,
    runStudioClassGenerationTick,
    processEmailFallback,
    processPaymentReminders,
    processClassReminders,
    cleanupExpiredAuth,
    runWaitlistReconciliationTick,
    reapClosedWaitlistEntries,
    reapExpiredNotifications,
    auditTeacherTimezones,
  });

  scheduleJobs(jobs, prisma, (globalThis.__fairYogaJobHealth ??= {}));

  log.info({ jobs: jobs.length }, 'scheduler started');
}

/** The timer functions `scheduleJobs` registers with, injectable for tests. */
export interface SchedulerTimers {
  setTimeout: (fn: () => Promise<void>, ms: number) => { unref: () => unknown };
  setInterval: (fn: () => Promise<void>, ms: number) => { unref: () => unknown };
}

/**
 * Registers each job's tick: once 15 seconds after registration, then every
 * `intervalMs` from that same registration (not from the first run), with
 * its health entry under the job's name. Separated from `startScheduler`
 * because this is where the table's intervals are used rather than merely
 * stated, and a test can record what was registered without starting a
 * clock.
 */
export function scheduleJobs(
  jobs: Job[],
  db: PrismaClient,
  health: Record<string, JobHealth>,
  timers: SchedulerTimers = { setTimeout, setInterval },
): void {
  for (const job of jobs) {
    const jobHealth: JobHealth = {
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      skippedTicks: 0,
    };
    health[job.name] = jobHealth;
    const tick = makeTick(job, jobHealth, db);

    // unref() so the timers never keep a shutting-down process alive.
    timers.setTimeout(tick, 15 * 1000).unref();
    timers.setInterval(tick, job.intervalMs).unref();
  }
}

/**
 * One job's tick: the re-entrancy guard and the health bookkeeping, separated
 * from the timer registration in `scheduleJobs` so both can be asserted
 * without starting timers.
 *
 * The `running` guard is what drops a tick that lands while the job's
 * previous run is still in flight — the `waitlist-reconciliation` entry in
 * `buildJobs` below relies on that — which is why it is separated and
 * asserted here. It also counts what it refuses: each dropped tick increments
 * `skippedTicks`, and `isJobHealthy` reads that count — a run still in flight
 * after `STALLED_AFTER_SKIPPED_TICKS` refused ticks reads unhealthy, whether
 * that run is hung or merely slow.
 */
export function makeTick(
  job: Job,
  jobHealth: JobHealth,
  db: PrismaClient,
): () => Promise<void> {
  return async () => {
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
    job.running = true;
    jobHealth.lastRunAt = new Date().toISOString();
    try {
      await job.run(db);
      jobHealth.lastSuccessAt = new Date().toISOString();
      jobHealth.lastError = null;
    } catch (err) {
      log.error({ err, job: job.name }, 'scheduler job failed');
      jobHealth.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      job.running = false;
      jobHealth.skippedTicks = 0;
    }
  };
}

/**
 * The job table, separated from `startScheduler` so it can be asserted without
 * starting timers.
 *
 * Worth separating because the intervals are not all conventional: at least one
 * is argued to be correctness-relevant, and nothing else in the suite would
 * notice it changing.
 */
export function buildJobs(sweeps: SchedulerSweeps): Job[] {
  const {
    autoTransitionToInProgress,
    autoCancelClasses,
    autoCompleteClasses,
    runClassGenerationTick,
    runStudioClassGenerationTick,
    processEmailFallback,
    processPaymentReminders,
    processClassReminders,
    cleanupExpiredAuth,
    runWaitlistReconciliationTick,
    reapClosedWaitlistEntries,
    reapExpiredNotifications,
    auditTeacherTimezones,
  } = sweeps;

  return [
    {
      name: 'class-transitions',
      intervalMs: 1 * MINUTE,
      run: isolatedSweeps('class-transitions', [
        autoTransitionToInProgress,
        autoCancelClasses,
        autoCompleteClasses,
      ]),
    },
    {
      name: 'email-fallback',
      intervalMs: 5 * MINUTE,
      run: (db) => processEmailFallback(db),
    },
    {
      // Both sweeps skip a template a concurrent writer holds, and report this
      // job degraded for contention only when one stays contended across
      // `MAX_CONSECUTIVE_CONTENDED_SWEEPS` (`generation-contention.ts`)
      // consecutive runs; a genuine failure reddens the job on the sweep it
      // happens in. That count is a duration only because of the
      // job's `intervalMs`.
      name: 'class-generation',
      intervalMs: 60 * MINUTE,
      run: isolatedSweeps('class-generation', [runClassGenerationTick, runStudioClassGenerationTick]),
    },
    {
      name: 'payment-reminders',
      intervalMs: 60 * MINUTE,
      run: (db) => processPaymentReminders(db),
    },
    {
      // 5 minutes bounds how late a reminder lands after its moment.
      name: 'class-reminders',
      intervalMs: 5 * MINUTE,
      run: (db) => processClassReminders(db),
    },
    {
      // Renamed from `auth-cleanup` when waitlist retention joined it (#238):
      // the job is the daily retention slot now, not the auth one. Every
      // sweep in this job runs through `isolatedSweeps` rather than getting
      // its own job, so there is one daily timer and one obvious slot for the
      // next retention policy.
      //
      // The cost, recorded rather than glossed: `/api/health` reports one
      // `lastRunAt` for every sweep in this job instead of one each.
      // Acceptable here and not for `waitlist-reconciliation`, which took its
      // own job name deliberately — a 60-second correctness sweep needs its
      // own health signal in a way a daily retention sweep does not.
      name: 'daily-cleanup',
      intervalMs: 24 * 60 * MINUTE,
      run: isolatedSweeps('daily-cleanup', [
        cleanupExpiredAuth,
        reapClosedWaitlistEntries,
        reapExpiredNotifications,
        // LAST, and the position is a default rather than a guarantee.
        // `isolatedSweeps` runs every sweep and rethrows the FIRST error, so a
        // standing bad timezone — which reports every run until a row is
        // fixed — would otherwise mask a real failure in any sweep above.
        //
        // That protects `lastError` here (in-memory; the full error already
        // reached the server log through `isolatedSweeps`' `log.error`). It does
        // NOT protect this job's `isJobHealthy` verdict — one verdict, shared
        // across every sweep in this job, and a standing timezone problem
        // already holds it `false`. A real failure in a sweep above it while
        // the timezone row stands produces no observable change there — the
        // verdict was false already. So the ordering keeps the other sweeps'
        // failures legible in logs, but the job's health verdict stays
        // uninformative about them until the bad row is fixed. Recorded as a
        // tradeoff, not mitigated architecturally.
        auditTeacherTimezones,
      ]),
    },
    {
      // 1 minute, and the cadence is load-bearing rather than conventional: the
      // claim window is only `CLAIM_WINDOW_MINUTES` (`lib/claim-window.ts`)
      // wide, ending at class start, so this bounds a dropped broadcast's cost
      // to roughly one of the student's claim minutes. At email-fallback's 5
      // minutes it would be five. That is why `scheduler.test.ts` pins this
      // number rather than trusting it.
      //
      // A floor, not a bound, and not a guarantee either. This tick calls
      // `handleSpotFreed` once per candidate class (`reconcileWaitlists`'s
      // loop), and that takes `lockClassRow` (`db-locks.ts`) on EITHER of its
      // branches — the auto-promote one through `promoteNext`, the broadcast
      // one directly. Each acquisition is bounded at 2s, but `SET LOCAL
      // lock_timeout` arms per acquisition and governs every remaining
      // statement in the transaction (`waitlist.ts`'s `promoteNext` docblock
      // spells this out), so a single contended class can cost more than 2s on
      // its own, and several in one pass add up past the interval. The
      // `job.running` guard then drops the ticks it overruns — and a pass
      // still in flight after `STALLED_AFTER_SKIPPED_TICKS` refused ticks
      // reads unhealthy.
      //
      // This interval is also what a tick COUNTS AS. The reconciliation
      // module tolerates a bounded number of consecutive all-contended TICKS
      // before reporting the job degraded, which is a wall-clock tolerance
      // only because of the number on the line below — halve it and the same
      // constant buys half the patience. `MAX_CONSECUTIVE_CONTENDED_TICKS`
      // carries that reasoning at its own definition; this is the end of it
      // that lives here.
      //
      // Its own job name rather than a fourth sweep inside `class-transitions`,
      // so its `lastRunAt` / `lastSuccessAt` describe this sweep alone — and
      // so `/api/health` can report it degraded. The sweep swallows per-class
      // failures (one contended class must not abandon the rest) but throws
      // `ReconciliationFailedError` when a tick failed every class it invoked
      // AND that is worth waking someone for — immediately when the failures
      // will not clear by retrying, after a streak when they are all lock
      // races. Without that throw, `makeTick` would record `lastSuccessAt`
      // and null `lastError` on every pass, so a sweep repairing nothing at
      // all would report `healthy: true` with a fresh timestamp — an
      // affirmative false statement rather than a missing one.
      name: 'waitlist-reconciliation',
      intervalMs: 1 * MINUTE,
      run: (db) => runWaitlistReconciliationTick(db),
    },
  ];
}
