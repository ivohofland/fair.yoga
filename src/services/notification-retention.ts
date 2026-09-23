import type { NotificationType, PrismaClient } from '@prisma/client';
import { isTransientDbError } from '@/lib/api-errors';
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
  periods: Array<{
    days: number;
    cutoff: string;
    deleted: number;
    cappedOut: boolean;
    failed: boolean;
  }>;
}

/**
 * Thrown after a run in which at least one period failed, once every other
 * period has run and the summary is logged, so the caller still sees the run
 * as failed.
 */
export class NotificationRetentionFailedError extends Error {
  constructor(readonly failedDays: readonly number[]) {
    super(`notification retention failed for the ${failedDays.join(', ')}-day period(s)`);
    this.name = 'NotificationRetentionFailedError';
  }
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
 *
 * Each period runs on its own: an error in one is logged and marks it
 * `failed`, and the periods after it still run. Every batch already
 * committed stays deleted and the next run picks up the rest. Once the
 * summary is logged, a run with a failed period throws
 * `NotificationRetentionFailedError`.
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
    let failed = false;

    try {
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
    } catch (err) {
      failed = true;
      const context = { err, days };
      if (isTransientDbError(err)) {
        log.warn(context, 'notification retention period failed on contention; the next run retries it');
      } else {
        log.error(context, 'notification retention period failed');
      }
    }

    periods.push({ days, cutoff: cutoff.toISOString(), deleted, cappedOut, failed });
  }

  const summary: NotificationReapSummary = {
    deleted: periods.reduce((sum, p) => sum + p.deleted, 0),
    periods,
  };
  const failedDays = periods.filter((p) => p.failed).map((p) => p.days);
  if (failedDays.length > 0) {
    log.error(summary, 'notification retention finished with a failed period');
  } else if (periods.some((p) => p.cappedOut)) {
    log.warn(summary, 'notification retention hit its per-run cap; the rest waits for the next run');
  } else {
    log.info(summary, 'notification retention swept');
  }
  if (failedDays.length > 0) throw new NotificationRetentionFailedError(failedDays);
  return summary;
}
