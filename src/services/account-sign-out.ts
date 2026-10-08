import type { PrismaClient } from '@prisma/client';
import type { TransactionClientOnly } from '@/lib/db-locks';

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
  return db.$transaction((tx) => signOutEverywhereTx(tx, accountId));
}

/**
 * `signOutEverywhere`'s two deletes inside a caller's transaction, sessions
 * first.
 */
export async function signOutEverywhereTx(
  tx: TransactionClientOnly,
  accountId: string,
): Promise<{ sessions: number; pushSubscriptions: number }> {
  const sessions = await tx.session.deleteMany({ where: { accountId } });
  const pushSubscriptions = await tx.pushSubscription.deleteMany({ where: { accountId } });
  return { sessions: sessions.count, pushSubscriptions: pushSubscriptions.count };
}
