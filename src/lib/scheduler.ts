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

interface Job {
  name: string;
  intervalMs: number;
  run: (db: PrismaClient) => Promise<unknown>;
  running?: boolean;
}

const MINUTE = 60 * 1000;

declare global {
  // Survives dev-server HMR: the scheduler must start at most once.
  var __fairYogaSchedulerStarted: boolean | undefined;
}

export async function startScheduler(): Promise<void> {
  if (process.env.CRON_SCHEDULER === 'off') {
    console.log('[scheduler] disabled via CRON_SCHEDULER=off');
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

  const jobs: Job[] = [
    {
      name: 'class-transitions',
      intervalMs: 1 * MINUTE,
      run: async (db) => {
        await autoTransitionToInProgress(db);
        await autoCancelClasses(db);
        await autoCompleteClasses(db);
      },
    },
    {
      name: 'email-fallback',
      intervalMs: 5 * MINUTE,
      run: (db) => processEmailFallback(db),
    },
    {
      name: 'class-generation',
      intervalMs: 60 * MINUTE,
      run: async (db) => {
        await generateClassInstances(db);
        await generateStudioClassInstances(db);
      },
    },
    {
      name: 'payment-reminders',
      intervalMs: 60 * MINUTE,
      run: (db) => processPaymentReminders(db),
    },
  ];

  for (const job of jobs) {
    const tick = async () => {
      if (job.running) return;
      job.running = true;
      try {
        await job.run(prisma);
      } catch (err) {
        console.error(`[scheduler] ${job.name} failed:`, err);
      } finally {
        job.running = false;
      }
    };

    // First run shortly after boot, then on the interval. unref() so the
    // timers never keep a shutting-down process alive.
    setTimeout(tick, 15 * 1000).unref();
    setInterval(tick, job.intervalMs).unref();
  }

  console.log(`[scheduler] started ${jobs.length} jobs`);
}
