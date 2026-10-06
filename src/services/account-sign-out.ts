import type { PrismaClient } from '@prisma/client';

/**
 * End every way the account is still being reached: all its sessions and all
 * its push subscriptions, in one transaction. A subscription is keyed by
 * account, not session, so deleting sessions alone would leave a device the
 * person is signing out of still receiving this account's notifications.
 * Zero rows is a normal answer, not an error.
 */
export async function signOutEverywhere(
  db: PrismaClient,
  accountId: string,
): Promise<{ sessions: number; pushSubscriptions: number }> {
  const [sessions, pushSubscriptions] = await db.$transaction([
    db.session.deleteMany({ where: { accountId } }),
    db.pushSubscription.deleteMany({ where: { accountId } }),
  ]);
  return { sessions: sessions.count, pushSubscriptions: pushSubscriptions.count };
}
