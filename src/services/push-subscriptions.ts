import type { PrismaClient } from '@prisma/client';
import type { PushTarget } from '@/lib/push/send';

export type SavePushSubscriptionResult = 'created' | 'updated' | 'moved' | 'unchanged';

/**
 * The most devices one account may hold. Every row is a host the dispatch
 * sweep POSTs to for each of that account's notifications, so the count is
 * bounded rather than left to the caller.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT = 10;

/**
 * Upsert by endpoint. Returns `'unchanged'`, writing nothing, when this
 * account already holds the endpoint with the same keys; `'moved'` when the
 * endpoint belonged to a different account, and reassigns it to `accountId`.
 *
 * When a row is created or moved onto `accountId`, the same transaction
 * evicts that account's least recently active other rows — by
 * `lastUsedAt ?? createdAt` — until it holds `MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT`.
 * The row just saved is never the one evicted.
 */
export async function savePushSubscription(
  db: PrismaClient,
  accountId: string,
  sub: PushTarget,
): Promise<SavePushSubscriptionResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.pushSubscription.findUnique({
      where: { endpoint: sub.endpoint },
      select: { accountId: true, p256dh: true, auth: true },
    });
    if (existing && existing.accountId === accountId && existing.p256dh === sub.p256dh && existing.auth === sub.auth) {
      return 'unchanged';
    }
    await tx.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { accountId, ...sub },
      update: { accountId, p256dh: sub.p256dh, auth: sub.auth },
    });
    if (existing && existing.accountId === accountId) return 'updated';

    const others = await tx.pushSubscription.findMany({
      where: { accountId, endpoint: { not: sub.endpoint } },
      select: { id: true, createdAt: true, lastUsedAt: true },
    });
    const activity = (row: { createdAt: Date; lastUsedAt: Date | null }) => (row.lastUsedAt ?? row.createdAt).getTime();
    const newestFirst = [...others].sort((a, b) => activity(b) - activity(a));
    const evicted = newestFirst.slice(MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT - 1).map((row) => row.id);
    if (evicted.length > 0) {
      await tx.pushSubscription.deleteMany({ where: { id: { in: evicted } } });
    }
    return existing ? 'moved' : 'created';
  });
}

/** Removes the row only if this account holds it. */
export async function removePushSubscription(
  db: PrismaClient,
  accountId: string,
  endpoint: string,
): Promise<'removed' | 'absent'> {
  const { count } = await db.pushSubscription.deleteMany({ where: { endpoint, accountId } });
  return count === 1 ? 'removed' : 'absent';
}
