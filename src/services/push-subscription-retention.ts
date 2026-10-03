import type { PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';

/**
 * How long a `PushSubscription` may go without activity before it is reaped
 * (#744). Why this length, and what a reaped device costs its owner:
 * `docs/data-model.md` (`### PushSubscription`).
 */
export const PUSH_SUBSCRIPTION_RETENTION_DAYS = 180;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReapPushSubscriptionOptions {
  now?: Date;
}

export interface PushSubscriptionReapSummary {
  deleted: number;
  cutoff: string;
}

/**
 * Deletes `PushSubscription` rows whose `coalesce(lastUsedAt, createdAt)` is
 * older than `PUSH_SUBSCRIPTION_RETENTION_DAYS`. A row exactly on the cutoff
 * is kept.
 *
 * Prisma cannot spell `coalesce`, so the predicate is its two cases: a row
 * that has been sent to is measured from `lastUsedAt`, one that never was from
 * `createdAt`. One DELETE: a row a send refreshes while it runs is re-checked
 * by Postgres once the delete has the row lock, and kept. A failure propagates
 * to the caller.
 */
export async function reapStalePushSubscriptions(
  db: PrismaClient,
  opts: ReapPushSubscriptionOptions = {},
): Promise<PushSubscriptionReapSummary> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - PUSH_SUBSCRIPTION_RETENTION_DAYS * DAY_MS);

  const { count } = await db.pushSubscription.deleteMany({
    where: {
      OR: [{ lastUsedAt: { lt: cutoff } }, { lastUsedAt: null, createdAt: { lt: cutoff } }],
    },
  });

  const summary: PushSubscriptionReapSummary = { deleted: count, cutoff: cutoff.toISOString() };
  log.info(summary, 'push subscription retention swept');
  return summary;
}
