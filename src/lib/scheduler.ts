/**
 * In-process job scheduler — the single-VPS answer to "what triggers the
 * crons?". Started once from instrumentation.ts when the Node server boots.
 *
 * Design decisions:
 * - Jobs call the services directly (no HTTP round-trip, no CRON_SECRET
 *   needed for the in-process path). The /api/cron/* endpoints remain for
 *   manual runs and external schedulers.
 * - Every job is idempotent at the DB layer (conditional updates, unique
 *   constraints), so an overlapping external trigger is harmless.
 * - A per-job `running` flag prevents a slow tick from stacking on itself.
 * - CRON_SCHEDULER=off disables it (CI runs the built app while tests
 *   drive the same services with explicit clocks).
 */

import type { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';

interface Job {
  name: string;
  intervalMs: number;
  run: (db: PrismaClient) => Promise<unknown>;
  running?: boolean;
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

  const jobs: Job[] = [
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
      name: 'auth-cleanup',
      intervalMs: 24 * 60 * MINUTE,
      run: (db) => cleanupExpiredAuth(db),
    },
  ];

  const health = (globalThis.__fairYogaJobHealth ??= {});
  for (const job of jobs) {
    health[job.name] = { lastRunAt: null, lastSuccessAt: null, lastError: null };
    const tick = async () => {
      if (job.running) return;
      job.running = true;
      const jobHealth = health[job.name]!;
      jobHealth.lastRunAt = new Date().toISOString();
      try {
        await job.run(prisma);
        jobHealth.lastSuccessAt = new Date().toISOString();
        jobHealth.lastError = null;
      } catch (err) {
        log.error({ err, job: job.name }, 'scheduler job failed');
        jobHealth.lastError = err instanceof Error ? err.message : String(err);
      } finally {
        job.running = false;
      }
    };

    // First run shortly after boot, then on the interval. unref() so the
    // timers never keep a shutting-down process alive.
    setTimeout(tick, 15 * 1000).unref();
    setInterval(tick, job.intervalMs).unref();
  }

  log.info({ jobs: jobs.length }, 'scheduler started');
}
