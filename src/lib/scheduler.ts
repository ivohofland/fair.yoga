/**
 * In-process job scheduler — the single-VPS answer to "what triggers the
 * crons?". Started once from instrumentation.ts when the Node server boots.
 *
 * Design decisions:
 * - Jobs call the services directly (no HTTP round-trip, no CRON_SECRET
 *   needed for the in-process path). The /api/cron/* endpoints remain for
 *   manual runs and external schedulers.
 * - Two of these jobs have had their send guarded against an overlapping
 *   trigger at the DB layer, and were measured: `payment-reminders` stamps
 *   `reminderSentAt` with a conditional `updateMany` and abandons the
 *   notification when the count is zero (`payment-reminders.ts`, the
 *   `$transaction` around its stamp); `email-fallback` claims each
 *   notification — `emailSent: false -> true`, count checked — BEFORE calling
 *   Resend, releasing the claim if the send fails.
 *
 *   That is a statement about those two jobs, NOT a survey. `class-transitions`
 *   also sends recipient-visible notifications — `autoCancelClasses` writes a
 *   `class_cancelled` set (`class-transitions.ts`) and `autoCompleteClasses`
 *   reaches `completeClass`'s `payment_request` set (`class-lifecycle.ts`) —
 *   and neither was examined for this. An earlier version of this docblock
 *   claimed every job was idempotent; the correction is to claim less, not to
 *   redraw the set and claim it exhaustively.
 * - A per-job `running` flag prevents a slow tick from stacking on itself.
 * - CRON_SCHEDULER=off disables it (CI runs the built app while tests
 *   drive the same services with explicit clocks).
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
  generateClassInstances: (db: PrismaClient) => Promise<unknown>;
  generateStudioClassInstances: (db: PrismaClient) => Promise<unknown>;
  processEmailFallback: (db: PrismaClient) => Promise<unknown>;
  processPaymentReminders: (db: PrismaClient) => Promise<unknown>;
  cleanupExpiredAuth: (db: PrismaClient) => Promise<unknown>;
  reconcileWaitlists: (db: PrismaClient) => Promise<unknown>;
  reapClosedWaitlistEntries: (db: PrismaClient) => Promise<unknown>;
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
    log.info('scheduler disabled via CRON_SCHEDULER=off');
    return;
  }
  if (globalThis.__fairYogaSchedulerStarted) return;
  globalThis.__fairYogaSchedulerStarted = true;

  // Dynamic imports keep instrumentation.ts loadable in the edge runtime,
  // where these modules (and the scheduler itself) must not run.
  const { prisma } = await import('@/lib/db');
  const { autoTransitionToInProgress, autoCancelClasses, autoCompleteClasses } =
    await import('@/services/class-transitions');
  const { generateClassInstances } = await import('@/services/class-generator');
  const { generateStudioClassInstances } = await import('@/services/studio-class-generator');
  const { processEmailFallback } = await import('@/services/email-fallback');
  const { processPaymentReminders } = await import('@/services/payment-reminders');
  const { cleanupExpiredAuth } = await import('@/services/auth-cleanup');
  const { reconcileWaitlists } = await import('@/services/waitlist-reconciliation');
  const { reapClosedWaitlistEntries } = await import('@/services/waitlist-retention');

  const jobs = buildJobs({
    autoTransitionToInProgress,
    autoCancelClasses,
    autoCompleteClasses,
    generateClassInstances,
    generateStudioClassInstances,
    processEmailFallback,
    processPaymentReminders,
    cleanupExpiredAuth,
    reconcileWaitlists,
    reapClosedWaitlistEntries,
  });

  const health = (globalThis.__fairYogaJobHealth ??= {});
  for (const job of jobs) {
    const jobHealth: JobHealth = { lastRunAt: null, lastSuccessAt: null, lastError: null };
    health[job.name] = jobHealth;
    const tick = makeTick(job, jobHealth, prisma);

    // First run shortly after boot, then on the interval. unref() so the
    // timers never keep a shutting-down process alive.
    setTimeout(tick, 15 * 1000).unref();
    setInterval(tick, job.intervalMs).unref();
  }

  log.info({ jobs: jobs.length }, 'scheduler started');
}

/**
 * One job's tick: the re-entrancy guard and the health bookkeeping, separated
 * from `startScheduler` so both can be asserted without starting timers.
 *
 * Worth separating for the same reason `buildJobs` was. The `running` guard is
 * load-bearing by another module's argument — `waitlist-reconciliation.ts`
 * accepts a duplicate-notification race specifically because this refuses a
 * tick while one is running — and until it was extracted, deleting it failed
 * nothing in the suite. A premise of a documented trade-off should not be the
 * one line nothing covers.
 */
export function makeTick(
  job: Job,
  jobHealth: JobHealth,
  db: PrismaClient,
): () => Promise<void> {
  return async () => {
    if (job.running) return;
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
    generateClassInstances,
    generateStudioClassInstances,
    processEmailFallback,
    processPaymentReminders,
    cleanupExpiredAuth,
    reconcileWaitlists,
    reapClosedWaitlistEntries,
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
      name: 'class-generation',
      intervalMs: 60 * MINUTE,
      run: isolatedSweeps('class-generation', [generateClassInstances, generateStudioClassInstances]),
    },
    {
      name: 'payment-reminders',
      intervalMs: 60 * MINUTE,
      run: (db) => processPaymentReminders(db),
    },
    {
      // Renamed from `auth-cleanup` when waitlist retention joined it (#238):
      // the job is the daily retention slot now, not the auth one. Two sweeps
      // through `isolatedSweeps` rather than a seventh job, so there is one
      // daily timer and one obvious slot for the next retention policy (#223
      // poses the same question for `Notification`).
      //
      // The cost, recorded rather than glossed: `/api/health` reports one
      // `lastRunAt` for both sweeps instead of one each. Acceptable here and
      // not for `waitlist-reconciliation`, which took its own job name
      // deliberately — a 60-second correctness sweep needs its own health
      // signal in a way a daily retention sweep does not.
      name: 'daily-cleanup',
      intervalMs: 24 * 60 * MINUTE,
      run: isolatedSweeps('daily-cleanup', [cleanupExpiredAuth, reapClosedWaitlistEntries]),
    },
    {
      // 1 minute, and the cadence is load-bearing rather than conventional: the
      // claim window is only 60 minutes wide, so this bounds a dropped
      // broadcast's cost to roughly 1 of the student's 60 claim minutes. At
      // email-fallback's 5 minutes it would be 8% of the window. That is why
      // `scheduler.test.ts` pins this number rather than trusting it.
      //
      // A typical-case bound, not a guarantee: `promoteNext`'s `Class` row
      // lock (`lockClassRow`, `db-locks.ts`) is bounded at 2s PER ACQUISITION,
      // but this tick calls it once per contended class in `classes`
      // (`reconcileWaitlists`'s loop), so several contended classes in one
      // pass can still add up past the interval, and the `job.running` guard
      // then drops the ticks it overruns.
      //
      // Its own job name rather than a fourth sweep inside `class-transitions`,
      // so its `lastRunAt` / `lastSuccessAt` describe this sweep alone — and
      // so `/api/health` can report it degraded. `reconcileWaitlists` swallows
      // per-class failures (one contended class must not abandon the rest) but
      // throws `ReconciliationFailedError` when it invoked classes and every
      // one failed. Without that throw the tick below would record
      // `lastSuccessAt` and null `lastError` on every pass, so a sweep
      // repairing nothing at all would report `healthy: true` with a fresh
      // timestamp — an affirmative false statement rather than a missing one.
      name: 'waitlist-reconciliation',
      intervalMs: 1 * MINUTE,
      run: (db) => reconcileWaitlists(db),
    },
  ];
}
