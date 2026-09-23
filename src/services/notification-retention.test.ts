import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient, type NotificationType } from '@prisma/client';
import { isTestDatabaseName } from '@/lib/worktree/identity';
import { reapExpiredNotifications } from './notification-retention';
import { scopeSweep } from '../../tests/scoped-sweep';

const prisma = new PrismaClient();
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

function scoped() {
  return scopeSweep(prisma, { Notification: { recipientId: RECIPIENT } });
}

beforeAll(async () => {
  // Refuse to run an unscoped DELETE sweep against a non-test database — the
  // same guard `waitlist-retention.test.ts` carries, for the same reason.
  const [row] =
    await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
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
    await reapExpiredNotifications(scoped().db, { now: NOW });
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
    await reapExpiredNotifications(scoped().db, { now: NOW });
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
    const first = await reapExpiredNotifications(scoped().db, {
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    });
    const year = first.periods.find((p) => p.days === 365);
    expect(year?.deleted).toBe(4);
    expect(year?.cappedOut).toBe(true);

    const second = await reapExpiredNotifications(scoped().db, {
      now: NOW,
      batchSize: 2,
      maxBatches: 2,
    });
    expect(second.periods.find((p) => p.days === 365)?.deleted).toBe(1);
    for (const id of ids) expect(await exists(id)).toBe(false);
  });
});
