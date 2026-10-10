import type { PrismaClient } from '@prisma/client';
import {
  assertAccountSignOutLockHeldBy,
  lockAccountForSignOut,
  type AccountSignOutLock,
  type TransactionClientOnly,
} from '@/lib/db-locks';

/**
 * End every way the account is still being reached: all its sessions and all
 * its push subscriptions, in one transaction. A subscription is keyed by
 * account, not session, so deleting sessions alone would leave a device the
 * person is signing out of still receiving this account's notifications.
 * Zero rows is a normal answer, not an error, and so is an account row that
 * is gone.
 */
export async function signOutEverywhere(
  db: PrismaClient,
  accountId: string,
): Promise<{ sessions: number; pushSubscriptions: number }> {
  return db.$transaction(async (tx) => {
    const lock = await lockAccountForSignOut(tx, accountId);
    if (lock === null) return { sessions: 0, pushSubscriptions: 0 };
    return signOutEverywhereTx(tx, lock);
  });
}

/**
 * `signOutEverywhere`'s two deletes inside a caller's transaction, sessions
 * first, under the account row lock the caller took
 * (`docs/lock-order.md`, "The `Account` row orders multi-session sign-out
 * writes").
 */
export async function signOutEverywhereTx(
  tx: TransactionClientOnly,
  lock: AccountSignOutLock,
): Promise<{ sessions: number; pushSubscriptions: number }> {
  assertAccountSignOutLockHeldBy(tx, lock);
  const { accountId } = lock;
  const sessions = await tx.session.deleteMany({ where: { accountId } });
  const pushSubscriptions = await tx.pushSubscription.deleteMany({ where: { accountId } });
  return { sessions: sessions.count, pushSubscriptions: pushSubscriptions.count };
}
