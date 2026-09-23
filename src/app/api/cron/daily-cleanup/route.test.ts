import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';

/**
 * The STATUS CONTRACT for this route, and nothing else.
 *
 * This file exists because review turned the route's answer from an
 * unconditional 200 into a verdict: **a 2xx means every sweep ran**, and if
 * any failed the answer is non-2xx while the body still carries every
 * outcome. That is a claim a reader cannot check by reading, and a manual
 * `curl` cannot check at all — the failure path needs a sweep to throw, which
 * means either editing the service or provoking a real database fault against
 * whatever database the app is pointed at.
 *
 * WHY THIS IS MOCKED, AND WHY THAT IS THE POINT. Spec review rejected a
 * route-handler test for the WIRING (does this route call the sweeps it names),
 * on the grounds that no precedent existed under `src/app/api` and the
 * in-process scheduler — not this route — runs the sweeps in production. That
 * reasoning still stands and this file does not reopen it: nothing here asserts
 * which sweep was called or what it did. It asserts only the mapping from every
 * sweep's outcome to one HTTP status.
 *
 * Mocking is also the only SAFE instrument. An e2e or integration test would run
 * against the app's database — dev, locally — and `reapClosedWaitlistEntries` is
 * deliberately unscoped, so a Playwright spec POSTing this route would
 * permanently delete dev rows. The guard that refuses a non-`_test` database
 * lives in `waitlist-retention.test.ts`, not in the service, so it would not fire.
 * With every sweep mocked this file touches no database at all.
 */

const cleanupExpiredAuth = vi.fn();
const reapClosedWaitlistEntries = vi.fn();
const reapExpiredNotifications = vi.fn();
const auditTeacherTimezones = vi.fn();

vi.mock('@/services/auth-cleanup', () => ({
  cleanupExpiredAuth: (...args: unknown[]) => cleanupExpiredAuth(...args),
}));
vi.mock('@/services/waitlist-retention', () => ({
  reapClosedWaitlistEntries: (...args: unknown[]) => reapClosedWaitlistEntries(...args),
}));
vi.mock('@/services/notification-retention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/notification-retention')>()),
  reapExpiredNotifications: (...args: unknown[]) => reapExpiredNotifications(...args),
}));
vi.mock('@/services/timezone-audit', () => ({
  auditTeacherTimezones: (...args: unknown[]) => auditTeacherTimezones(...args),
}));
// The route builds a PrismaClient at module load through this. Stubbed so
// importing the route opens no connection — the sweeps that would use it are
// mocked, so the value is never read.
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('@/lib/cron-auth', () => ({ requireCronAuth: () => null }));

const { POST } = await import('./route');
const { NotificationRetentionFailedError } = await import('@/services/notification-retention');

function post(): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/daily-cleanup', { method: 'POST' });
}

/** The shape the route returns, as a caller reading the JSON would see it. */
interface Body {
  data: {
    auth: { ok: boolean; error?: string };
    waitlistRetention: { ok: boolean; error?: string };
    notificationRetention: { ok: boolean; error?: string };
    timezoneAudit: { ok: boolean; error?: string };
  };
}

/** A lock timeout, which `classifyApiError` classifies as transient (503). */
function transientError(): Error {
  return new Error(
    'canceling statement due to lock timeout\ncode: "55P03"\nseverity: "ERROR"',
  );
}

beforeEach(() => {
  cleanupExpiredAuth.mockReset();
  reapClosedWaitlistEntries.mockReset();
  reapExpiredNotifications.mockReset();
  auditTeacherTimezones.mockReset();
  // A clean audit by default. Without this an unmocked `vi.fn()` returns
  // `undefined`, which `settle` reports as a SUCCESS — so the audit would
  // appear to pass in every case here for the wrong reason, and the failure
  // case below would be the only one actually exercising it.
  auditTeacherTimezones.mockResolvedValue({ checked: 3, teachers: 0, invalid: [] });
  // Same reason, for notification retention.
  reapExpiredNotifications.mockResolvedValue({ deleted: 0, periods: [] });
});

describe('POST /api/cron/daily-cleanup — status contract', () => {
  it('answers 200 only when every sweep ran', async () => {
    cleanupExpiredAuth.mockResolvedValue({ sessions: 1 });
    reapClosedWaitlistEntries.mockResolvedValue({ deleted: 2, classes: 1 });

    const res = await POST(post());
    const body = (await res.json()) as Body;

    expect(res.status).toBe(200);
    expect(body.data.auth.ok).toBe(true);
    expect(body.data.waitlistRetention.ok).toBe(true);
    expect(body.data.notificationRetention.ok).toBe(true);
    expect(body.data.timezoneAudit.ok).toBe(true);
  });

  it('answers 500 when a notification retention period fails, and the other sweeps still ran', async () => {
    cleanupExpiredAuth.mockResolvedValue({ sessions: 0 });
    reapClosedWaitlistEntries.mockResolvedValue({ deleted: 0, classes: 0 });
    // What the sweep throws after a failed period, whatever that period's own
    // error was: it carries no `cause`, so it classifies as permanent.
    reapExpiredNotifications.mockRejectedValue(new NotificationRetentionFailedError([365]));

    const res = await POST(post());
    const body = (await res.json()) as Body;

    expect(res.status).toBe(500);
    expect(body.data.notificationRetention.ok).toBe(false);
    expect(body.data.auth.ok).toBe(true);
    expect(body.data.waitlistRetention.ok).toBe(true);
    expect(body.data.timezoneAudit.ok).toBe(true);
  });

  /**
   * The isolation property O5 was about, now visible in the status.
   *
   * Auth cleanup throwing must NOT stop retention — under `CRON_SCHEDULER=off`
   * this route is the only trigger for retention — and the caller must still be
   * told something went wrong. Both halves are asserted here, because the first
   * without the second is what the earlier revision shipped.
   */
  it('runs retention even when auth cleanup throws, and still answers non-2xx', async () => {
    cleanupExpiredAuth.mockRejectedValue(new Error('auth cleanup exploded'));
    reapClosedWaitlistEntries.mockResolvedValue({ deleted: 0, classes: 0 });

    const res = await POST(post());
    const body = (await res.json()) as Body;

    expect(reapClosedWaitlistEntries).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
    // The whole point: the body still says WHICH one failed.
    expect(body.data.auth.ok).toBe(false);
    expect(body.data.auth.error).toContain('auth cleanup exploded');
    expect(body.data.waitlistRetention.ok).toBe(true);
  });

  /**
   * Partial failure the other way round, which is the case that matters most:
   * retention is the sweep this route is the sole trigger for.
   */
  it('answers non-2xx when only retention fails, naming it in the body', async () => {
    cleanupExpiredAuth.mockResolvedValue({ sessions: 3 });
    reapClosedWaitlistEntries.mockRejectedValue(
      new Error('waitlist retention attempted 4 class(es) and every one failed'),
    );

    const res = await POST(post());
    const body = (await res.json()) as Body;

    expect(res.status).toBe(500);
    expect(body.data.auth.ok).toBe(true);
    expect(body.data.waitlistRetention.ok).toBe(false);
    expect(body.data.waitlistRetention.error).toContain('every one failed');
  });

  it('answers non-2xx with both failures in the body when both fail', async () => {
    cleanupExpiredAuth.mockRejectedValue(new Error('auth boom'));
    reapClosedWaitlistEntries.mockRejectedValue(new Error('retention boom'));

    const res = await POST(post());
    const body = (await res.json()) as Body;

    expect(res.status).toBe(500);
    expect(body.data.auth.ok).toBe(false);
    expect(body.data.waitlistRetention.ok).toBe(false);
  });

  /**
   * 503 rather than 500 when every failure is a lost contention race, matching
   * how the rest of the codebase answers contention (`classifyApiError`). A
   * timer reading this should back off and retry, not page someone.
   */
  it('answers 503 when every failure is transient', async () => {
    cleanupExpiredAuth.mockResolvedValue({ sessions: 0 });
    reapClosedWaitlistEntries.mockRejectedValue(transientError());

    const res = await POST(post());

    expect(res.status).toBe(503);
  });

  /**
   * One permanent failure alongside a transient one makes 500 the honest
   * answer — a schema drift does not clear on the next tick, and "try again"
   * would be the misleading half of that trade.
   */
  it('answers 500 when a permanent failure accompanies a transient one', async () => {
    cleanupExpiredAuth.mockRejectedValue(new Error('schema drift'));
    reapClosedWaitlistEntries.mockRejectedValue(transientError());

    const res = await POST(post());

    expect(res.status).toBe(500);
  });

  /**
   * The audit is the third sweep, and a failing one must reach the status.
   * 500 and not 503: `InvalidTimezoneError` matches no branch in
   * `classifyApiError`, so it falls to the generic 500 — which is the right
   * answer, because 503 tells a systemd timer to back off and retry, and a
   * stored zone that will not resolve does not clear on the next tick.
   */
  it('answers 500 when only the timezone audit fails', async () => {
    cleanupExpiredAuth.mockResolvedValue({ sessions: 0 });
    reapClosedWaitlistEntries.mockResolvedValue({ deleted: 0, classes: 0 });
    auditTeacherTimezones.mockRejectedValue(
      new Error('stored teacher timezones no longer resolve: Invalid/Test_Zone_145'),
    );

    const res = await POST(post());
    const body = (await res.json()) as Body;

    expect(res.status).toBe(500);
    expect(body.data.auth.ok).toBe(true);
    expect(body.data.waitlistRetention.ok).toBe(true);
    expect(body.data.timezoneAudit.ok).toBe(false);
    expect(body.data.timezoneAudit.error).toContain('Invalid/Test_Zone_145');
  });

  /**
   * `settle`'s catch logs `classifyApiError`'s `detail` alongside `err` and
   * `status` — `withErrorHandler` spreads `...failure.detail` first so the
   * literal keys win (`src/lib/api-utils.ts`), and this route's own log call
   * follows the same order. Without it a transient sweep failure logs with no
   * `transientKind`, which is what made this route invisible to the spec
   * §8 acceptance 1 census of `classifyApiError` consumers.
   */
  it('logs a tx_budget sweep failure at warn with its transientKind', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined as never);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as never);
    try {
      cleanupExpiredAuth.mockResolvedValue({ sessions: 0 });
      reapClosedWaitlistEntries.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('tx budget exceeded', {
          code: 'P2028',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await POST(post());

      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ transientKind: 'tx_budget' }),
        'daily-cleanup: a sweep failed; the others still ran',
      );
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('logs a pool_exhausted sweep failure at error with its transientKind', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined as never);
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as never);
    try {
      cleanupExpiredAuth.mockResolvedValue({ sessions: 0 });
      reapClosedWaitlistEntries.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('pool timeout', {
          code: 'P2024',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await POST(post());

      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ transientKind: 'pool_exhausted' }),
        'daily-cleanup: a sweep failed; the others still ran',
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
