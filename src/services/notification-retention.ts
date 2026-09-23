import type { NotificationType, PrismaClient } from '@prisma/client';
import { log } from '@/lib/log';
import { NOTIFICATION_RETENTION_DAYS } from '@/lib/notification-retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1000;
const MAX_BATCHES_PER_PERIOD = 50;

export interface ReapNotificationOptions {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
}

export interface NotificationReapSummary {
  deleted: number;
  periods: Array<{ days: number; cutoff: string; deleted: number; cappedOut: boolean }>;
}

/** Types grouped by retention period, derived from the map. */
function typesByPeriod(): Map<number, NotificationType[]> {
  const groups = new Map<number, NotificationType[]>();
  for (const [type, days] of Object.entries(NOTIFICATION_RETENTION_DAYS) as Array<
    [NotificationType, number]
  >) {
    groups.set(days, [...(groups.get(days) ?? []), type]);
  }
  return groups;
}

/**
 * Deletes `Notification` rows older than their type's retention period (#223).
 *
 * Candidates are read with a top-level `findMany` and deleted by id, so
 * `tests/scoped-sweep.ts` can narrow both statements in a test. Each
 * `deleteMany` is its own statement: row locks last one batch, and the
 * `Class` rows these reference are never locked, because deleting a
 * referencing row takes no lock on the row it references.
 *
 * Bounded per run so a never-swept backlog cannot hold the daily job for
 * long; what is left waits for the next run, and `cappedOut` says so.
 * Errors propagate to `isolatedSweeps`: every batch already committed stays
 * deleted, and the next run picks up the rest.
 */
export async function reapExpiredNotifications(
  db: PrismaClient,
  opts: ReapNotificationOptions = {},
): Promise<NotificationReapSummary> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? MAX_BATCHES_PER_PERIOD;

  const periods: NotificationReapSummary['periods'] = [];
  for (const [days, types] of typesByPeriod()) {
    const cutoff = new Date(now.getTime() - days * DAY_MS);
    let deleted = 0;
    let cappedOut = false;

    for (let batch = 0; ; batch++) {
      if (batch === maxBatches) {
        cappedOut = true;
        break;
      }
      const rows = await db.notification.findMany({
        where: { type: { in: types }, createdAt: { lt: cutoff } },
        select: { id: true },
        take: batchSize,
      });
      if (rows.length === 0) break;
      const { count } = await db.notification.deleteMany({
        where: { id: { in: rows.map((r) => r.id) } },
      });
      deleted += count;
      if (rows.length < batchSize) break;
    }

    periods.push({ days, cutoff: cutoff.toISOString(), deleted, cappedOut });
  }

  const summary: NotificationReapSummary = {
    deleted: periods.reduce((sum, p) => sum + p.deleted, 0),
    periods,
  };
  if (periods.some((p) => p.cappedOut)) {
    log.warn(summary, 'notification retention hit its per-run cap; the rest waits for the next run');
  } else {
    log.info(summary, 'notification retention swept');
  }
  return summary;
}
