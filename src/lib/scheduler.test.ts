import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { buildJobs, isolatedSweeps, type SchedulerSweeps } from './scheduler';

const MINUTE = 60 * 1000;

describe('isolatedSweeps', () => {
  it('runs every sweep even when some fail, and rethrows the first error', async () => {
    const ran: string[] = [];
    async function alpha() { ran.push('alpha'); throw new Error('boom-alpha'); }
    async function beta() { ran.push('beta'); }
    async function gamma() { ran.push('gamma'); throw new Error('boom-gamma'); }

    const run = isolatedSweeps('test-job', [alpha, beta, gamma]);
    await expect(run({} as unknown as PrismaClient)).rejects.toThrow('boom-alpha');
    expect(ran).toEqual(['alpha', 'beta', 'gamma']); // none starved by an earlier failure
  });

  it('resolves when all sweeps succeed', async () => {
    const run = isolatedSweeps('test-job', [async () => {}, async () => {}]);
    await expect(run({} as unknown as PrismaClient)).resolves.toBeUndefined();
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
    const noop = async () => {};
    const sweeps = Object.fromEntries(
      [
        'autoTransitionToInProgress',
        'autoCancelClasses',
        'autoCompleteClasses',
        'generateClassInstances',
        'generateStudioClassInstances',
        'processEmailFallback',
        'processPaymentReminders',
        'cleanupExpiredAuth',
        'reconcileWaitlists',
      ].map((name) => [name, noop]),
    ) as unknown as SchedulerSweeps;

    expect(buildJobs(sweeps).map((j) => [j.name, j.intervalMs])).toEqual([
      ['class-transitions', 1 * MINUTE],
      ['email-fallback', 5 * MINUTE],
      ['class-generation', 60 * MINUTE],
      ['payment-reminders', 60 * MINUTE],
      ['auth-cleanup', 24 * 60 * MINUTE],
      ['waitlist-reconciliation', 1 * MINUTE],
    ]);
  });

  it('routes each job to the sweep it names', async () => {
    const called: string[] = [];
    const spy = (name: string) => async () => {
      called.push(name);
    };
    const sweeps = Object.fromEntries(
      [
        'autoTransitionToInProgress',
        'autoCancelClasses',
        'autoCompleteClasses',
        'generateClassInstances',
        'generateStudioClassInstances',
        'processEmailFallback',
        'processPaymentReminders',
        'cleanupExpiredAuth',
        'reconcileWaitlists',
      ].map((name) => [name, spy(name)]),
    ) as unknown as SchedulerSweeps;

    const db = {} as unknown as PrismaClient;
    for (const job of buildJobs(sweeps)) await job.run(db);

    // Without this, a job could carry the right name and interval while running
    // the wrong sweep — the table would look correct and do nothing useful.
    expect(called).toEqual([
      'autoTransitionToInProgress',
      'autoCancelClasses',
      'autoCompleteClasses',
      'processEmailFallback',
      'generateClassInstances',
      'generateStudioClassInstances',
      'processPaymentReminders',
      'cleanupExpiredAuth',
      'reconcileWaitlists',
    ]);
  });
});
