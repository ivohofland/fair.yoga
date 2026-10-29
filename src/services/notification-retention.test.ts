import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { type PrismaClient, type NotificationType } from '@/lib/prisma-client';
import { log } from '@/lib/log';
import { isTestDatabaseName } from '@/lib/worktree/identity';
import {
  NotificationRetentionFailedError,
  reapExpiredNotifications,
} from './notification-retention';
import { scopeSweep } from '../../tests/scoped-sweep';
import { typedCallError, pgCause } from '../../tests/adapter-errors';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const RECIPIENT = randomUUID();
const NOW = new Date('2026-09-23T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function seed(type: NotificationType, createdAt: Date, isRead = true): Promise<string> {
  const row = await prisma.notification.create({
    data: {
      recipientType: 'student',
      recipientId: RECIPIENT,
      type,
      title: 't',
      body: 'b',
      isRead,
      createdAt,
    },
  });
  return row.id;
}

async function exists(id: string): Promise<boolean> {
  return (await prisma.notification.findUnique({ where: { id } })) !== null;
}

function scoped(base: PrismaClient = prisma) {
  return scopeSweep(base, { Notification: { recipientId: RECIPIENT } });
}

/**
 * A base client whose `deleteMany` throws `error` when its batch holds
 * `failingId`. Attached before `scopeSweep` so the hook sees the sweep's own
 * `where` (`tests/scoped-sweep.ts`).
 */
function failingOn(failingId: string, error: Error): PrismaClient {
  return prisma.$extends({
    query: {
      notification: {
        async deleteMany({ args, query }) {
          const where = args.where as { id?: { in?: string[] } } | undefined;
          if (where?.id?.in?.includes(failingId)) throw error;
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

beforeAll(async () => {
  // Refuse to run an unscoped DELETE sweep against a non-test database — the
  // same guard `waitlist-retention.test.ts` carries, for the same reason.
  const [row] =
    await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()::text AS current_database`;
  const dbName = row?.current_database ?? '';
  if (!isTestDatabaseName(dbName)) {
    throw new Error(
      `[notification-retention.test] refusing to run an unscoped DELETE sweep against "${dbName}". ` +
        'Set DATABASE_URL_TEST to a database whose name ends in _test, or (in a worktree) _test_<slug>.',
    );
  }
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: RECIPIENT } });
  await prisma.$disconnect();
});

describe('reapExpiredNotifications', () => {
  it('deletes a 365-day type past its period and keeps one inside it', async () => {
    const old = await seed('booking_confirmed', daysAgo(366));
    const fresh = await seed('booking_confirmed', daysAgo(364));
    const s = scoped();
    await reapExpiredNotifications(s.db, { now: NOW });
    expect(s.rowsRead('Notification')).toBeGreaterThan(0);
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('keeps a row exactly at the cutoff (strictly older is deleted)', async () => {
    const edge = await seed('announcement', daysAgo(365));
    const past = await seed('announcement', daysAgo(366));
    const s = scoped();
    await reapExpiredNotifications(s.db, { now: NOW });
    expect(s.rowsRead('Notification')).toBeGreaterThan(0);
    expect(await exists(past)).toBe(false);
    expect(await exists(edge)).toBe(true);
  });

  it('deletes spot_available after 30 days', async () => {
    const old = await seed('spot_available', daysAgo(31));
    const fresh = await seed('spot_available', daysAgo(29));
    await reapExpiredNotifications(scoped().db, { now: NOW });
    expect(await exists(old)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('keeps waitlist_promoted and reminder past 30 days', async () => {
    const promoted = await seed('waitlist_promoted', daysAgo(31));
    const reminder = await seed('reminder', daysAgo(31));
    const pastPromoted = await seed('waitlist_promoted', daysAgo(366));
    const s = scoped();
    await reapExpiredNotifications(s.db, { now: NOW });
    expect(s.rowsRead('Notification')).toBeGreaterThan(0);
    expect(await exists(pastPromoted)).toBe(false);
    expect(await exists(promoted)).toBe(true);
    expect(await exists(reminder)).toBe(true);
  });

  it('deletes an unread row like a read one', async () => {
    const unread = await seed('class_cancelled', daysAgo(400), false);
    await reapExpiredNotifications(scoped().db, { now: NOW });
    expect(await exists(unread)).toBe(false);
  });

  it('stops at its batch cap, reports it, and the next run continues', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => seed('payment_received', daysAgo(500))),
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    let first;
    try {
      first = await reapExpiredNotifications(scoped().db, {
        now: NOW,
        batchSize: 2,
        maxBatches: 2,
      });
      expect(warn).toHaveBeenCalledWith(first, expect.stringContaining('cap'));
      expect(info).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
    const year = first.periods.find((p) => p.days === 365);
    expect(year?.deleted).toBe(4);
    expect(year?.cappedOut).toBe(true);
    expect(year?.failed).toBe(false);

    const second = await reapExpiredNotifications(scoped().db, {
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    });
    expect(second.periods.find((p) => p.days === 365)?.deleted).toBe(1);
    for (const id of ids) expect(await exists(id)).toBe(false);
  });

  it('runs the other period when one fails, logs every period, then rejects', async () => {
    const yearly = await seed('booking_confirmed', daysAgo(400));
    const short = await seed('spot_available', daysAgo(40));
    const failure = new Error('injected failure');
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    try {
      const s = scoped(failingOn(yearly, failure));
      await expect(reapExpiredNotifications(s.db, { now: NOW })).rejects.toBeInstanceOf(
        NotificationRetentionFailedError,
      );
      expect(s.rowsRead('Notification')).toBeGreaterThan(0);

      expect(error).toHaveBeenCalledWith({ err: failure, days: 365, transientKind: null }, expect.any(String));
      expect(error).toHaveBeenCalledWith(
        {
          deleted: 1,
          periods: [
            expect.objectContaining({ days: 365, deleted: 0, failed: true }),
            expect.objectContaining({ days: 30, deleted: 1, failed: false }),
          ],
        },
        expect.any(String),
      );
      expect(warn).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
      info.mockRestore();
    }
    expect(await exists(short)).toBe(false);
    expect(await exists(yearly)).toBe(true);
    await prisma.notification.delete({ where: { id: yearly } });
  });

  it('logs a lock timeout period failure at warn, carrying its kind', async () => {
    const yearly = await seed('class_cancelled', daysAgo(400));
    const failure = typedCallError(pgCause('55P03', 'canceling statement due to lock timeout'));
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const summary = expect.objectContaining({
      periods: expect.arrayContaining([expect.objectContaining({ days: 365, failed: true })]),
    });
    try {
      await expect(
        reapExpiredNotifications(scoped(failingOn(yearly, failure)).db, { now: NOW }),
      ).rejects.toThrow(/365/);
      expect(warn).toHaveBeenCalledWith(
        { err: failure, days: 365, transientKind: 'lock_timeout' },
        expect.stringMatching(/transient database failure/),
      );
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(summary, expect.any(String));
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
    await prisma.notification.delete({ where: { id: yearly } });
  });

  it("logs a deadlock period failure at error, as its kind's level says", async () => {
    const yearly = await seed('class_cancelled', daysAgo(400));
    const failure = typedCallError(pgCause('40P01', 'deadlock detected'));
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const summary = expect.objectContaining({
      periods: expect.arrayContaining([expect.objectContaining({ days: 365, failed: true })]),
    });
    try {
      await expect(
        reapExpiredNotifications(scoped(failingOn(yearly, failure)).db, { now: NOW }),
      ).rejects.toThrow(/365/);
      expect(warn).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(2);
      expect(error).toHaveBeenCalledWith(
        { err: failure, days: 365, transientKind: 'deadlock' },
        expect.stringMatching(/transient database failure/),
      );
      expect(error).toHaveBeenCalledWith(summary, expect.any(String));
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
    await prisma.notification.delete({ where: { id: yearly } });
  });
});
