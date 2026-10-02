import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT, savePushSubscription } from './push-subscriptions';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const accountIds: string[] = [];

const endpoint = (tag: string) => `https://fcm.googleapis.com/fcm/send/${suffix}-${tag}`;
const keys = { p256dh: 'p', auth: 'a' };

async function account(tag: string): Promise<string> {
  const a = await prisma.account.create({ data: { email: `push-sub-${tag}-${suffix}@test.local` } });
  accountIds.push(a.id);
  return a.id;
}

/** Fills `accountId` to the cap with rows whose activity times are given explicitly, oldest first. */
async function fillToCap(accountId: string, tag: string, activity: (i: number) => { createdAt: Date; lastUsedAt: Date | null }) {
  for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT; i++) {
    await prisma.pushSubscription.create({
      data: { accountId, endpoint: endpoint(`${tag}-${i}`), ...keys, ...activity(i) },
    });
  }
}

describe('savePushSubscription per-account cap', () => {
  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    if (accountIds.length > 0) {
      await prisma.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  });

  it('evicts by lastUsedAt ?? createdAt, so a row used recently outlives a newer unused one', async () => {
    const accountId = await account('order');
    const base = Date.now() - 24 * 60 * 60_000;
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    // Row 0 is the oldest by createdAt but was used last; row 1 was used
    // before row 2 was even created; the rest are newer and never used.
    // Least recently active is therefore row 1 — neither createdAt alone
    // (row 0) nor never-used-first (row 2) names it.
    await fillToCap(accountId, 'order', (i) => {
      if (i === 0) return { createdAt: at(0), lastUsedAt: at(1000) };
      if (i === 1) return { createdAt: at(1), lastUsedAt: at(2) };
      return { createdAt: at(i + 10), lastUsedAt: null };
    });

    expect(await savePushSubscription(prisma, accountId, { endpoint: endpoint('order-new'), ...keys })).toBe('created');

    const remaining = await prisma.pushSubscription.findMany({ where: { accountId }, select: { endpoint: true } });
    expect(remaining).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT);
    expect(remaining.map((r) => r.endpoint)).not.toContain(endpoint('order-1'));
    expect(remaining.map((r) => r.endpoint)).toContain(endpoint('order-new'));
  });

  it('applies the cap to a row moved onto a full account, and never evicts the moved row', async () => {
    const full = await account('move-full');
    const other = await account('move-other');
    const base = Date.now() - 24 * 60 * 60_000;
    await fillToCap(full, 'move', (i) => ({ createdAt: new Date(base + (i + 10) * 60_000), lastUsedAt: null }));
    // Older than every row on `full`, so it would be the first evicted if
    // the saved row were not exempt.
    await prisma.pushSubscription.create({
      data: { accountId: other, endpoint: endpoint('moved'), ...keys, createdAt: new Date(base) },
    });

    expect(await savePushSubscription(prisma, full, { endpoint: endpoint('moved'), ...keys })).toBe('moved');

    const remaining = await prisma.pushSubscription.findMany({ where: { accountId: full }, select: { endpoint: true } });
    expect(remaining).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT);
    expect(remaining.map((r) => r.endpoint)).toContain(endpoint('moved'));
    expect(remaining.map((r) => r.endpoint)).not.toContain(endpoint('move-0'));
  });

  it('evicts nothing when a key rotation updates a row on a full account', async () => {
    const accountId = await account('rotate');
    const base = Date.now() - 24 * 60 * 60_000;
    await fillToCap(accountId, 'rotate', (i) => ({ createdAt: new Date(base + i * 60_000), lastUsedAt: null }));

    expect(await savePushSubscription(prisma, accountId, { endpoint: endpoint('rotate-0'), p256dh: 'p2', auth: 'a2' })).toBe('updated');

    expect(await prisma.pushSubscription.count({ where: { accountId } })).toBe(MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT);
  });
});
