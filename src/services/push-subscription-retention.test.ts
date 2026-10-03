import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { isTestDatabaseName } from '@/lib/worktree/identity';
import {
  PUSH_SUBSCRIPTION_RETENTION_DAYS,
  reapStalePushSubscriptions,
} from './push-subscription-retention';
import { scopeSweep } from '../../tests/scoped-sweep';

const prisma = new PrismaClient();
const ACCOUNT = randomUUID();
const NOW = new Date('2026-10-03T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function seed(createdAt: Date, lastUsedAt: Date | null): Promise<string> {
  const row = await prisma.pushSubscription.create({
    data: {
      accountId: ACCOUNT,
      endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
      p256dh: 'p',
      auth: 'a',
      createdAt,
      lastUsedAt,
    },
  });
  return row.id;
}

async function exists(id: string): Promise<boolean> {
  return (await prisma.pushSubscription.findUnique({ where: { id } })) !== null;
}

function scoped(base: PrismaClient = prisma) {
  return scopeSweep(base, { PushSubscription: { accountId: ACCOUNT } });
}

beforeAll(async () => {
  // The sweep is database-wide; refuse to run it against anything but a test
  // database, the same guard `notification-retention.test.ts` carries.
  const [row] = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const dbName = row?.current_database ?? '';
  if (!isTestDatabaseName(dbName)) {
    throw new Error(
      `[push-subscription-retention.test] refusing to run an unscoped DELETE sweep against "${dbName}". ` +
        'Set DATABASE_URL_TEST to a database whose name ends in _test, or (in a worktree) _test_<slug>.',
    );
  }
});

afterAll(async () => {
  await prisma.pushSubscription.deleteMany({ where: { accountId: ACCOUNT } });
  await prisma.$disconnect();
});

describe('reapStalePushSubscriptions', () => {
  const WINDOW = PUSH_SUBSCRIPTION_RETENTION_DAYS;

  it('deletes a row whose last activity is older than the window and keeps one inside it', async () => {
    const stale = await seed(daysAgo(WINDOW + 400), daysAgo(WINDOW + 1));
    const fresh = await seed(daysAgo(WINDOW + 400), daysAgo(WINDOW - 1));
    const { db, rowsRead } = scoped();

    const summary = await reapStalePushSubscriptions(db, { now: NOW });

    expect(rowsRead('PushSubscription')).toBeGreaterThan(0);
    expect(summary.deleted).toBeGreaterThanOrEqual(1);
    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });

  it('falls back to createdAt for a row that was never sent to', async () => {
    const staleNeverUsed = await seed(daysAgo(WINDOW + 1), null);
    const freshNeverUsed = await seed(daysAgo(WINDOW - 1), null);
    const { db } = scoped();

    await reapStalePushSubscriptions(db, { now: NOW });

    expect(await exists(staleNeverUsed)).toBe(false);
    expect(await exists(freshNeverUsed)).toBe(true);
  });

  it('measures from lastUsedAt, not createdAt, once a send has happened', async () => {
    const oldButRecentlyUsed = await seed(daysAgo(WINDOW * 3), daysAgo(1));
    const { db } = scoped();

    await reapStalePushSubscriptions(db, { now: NOW });

    expect(await exists(oldButRecentlyUsed)).toBe(true);
  });

  it('keeps a row exactly on the cutoff', async () => {
    const onCutoff = await seed(daysAgo(WINDOW), null);
    const { db } = scoped();

    await reapStalePushSubscriptions(db, { now: NOW });

    expect(await exists(onCutoff)).toBe(true);
  });

  it('reports the cutoff it used and logs the run', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { db } = scoped();

    const summary = await reapStalePushSubscriptions(db, { now: NOW });

    expect(summary.cutoff).toBe(daysAgo(WINDOW).toISOString());
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ cutoff: summary.cutoff }), expect.any(String));
    info.mockRestore();
  });
});
