import type { PrismaClient } from '@prisma/client';

/**
 * Upsert by endpoint. Returns `'moved'` when the endpoint already belonged to
 * a different account, and reassigns it to `accountId`.
 */
export async function savePushSubscription(
  db: PrismaClient,
  accountId: string,
  sub: { endpoint: string; p256dh: string; auth: string },
): Promise<'created' | 'updated' | 'moved'> {
  const existing = await db.pushSubscription.findUnique({ where: { endpoint: sub.endpoint }, select: { accountId: true } });
  await db.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { accountId, ...sub },
    update: { accountId, p256dh: sub.p256dh, auth: sub.auth },
  });
  if (!existing) return 'created';
  return existing.accountId === accountId ? 'updated' : 'moved';
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
