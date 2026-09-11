/**
 * Announcement Service — Manages announcement dispatch and deduplication.
 *
 * Announcements broadcast messages from a teacher to their students (either scoped
 * to a specific class, or to all active students of that teacher).
 *
 * Business logic lives here per CLAUDE.md:
 * - Pure functions with typed inputs and typed outputs.
 * - No HTTP concerns or framework imports.
 * - Manages the transaction, advisory lock, deduplication check, notification fan-out,
 *   and Announcement record persistence.
 */

import { createHash } from 'crypto';
import type { Announcement, PrismaClient } from '@prisma/client';
import {
  createBulkNotifications,
  type CreateNotificationInput,
} from '@/services/notifications';
import { type TransactionClientOnly } from '@/lib/db-locks';

/**
 * How long an identical announcement suppresses a second send of itself.
 *
 * Two minutes: long enough to absorb a double-click and a retried request from
 * a flaky connection, short enough that a teacher who genuinely wants to say
 * the same thing again is not told no. The same quantity as
 * `MANUAL_REMIND_COOLDOWN_MS` (`services/payments.ts`), deliberately — one
 * concept, not two.
 */
export const ANNOUNCEMENT_DEDUPE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Namespace for this project's advisory locks — the first argument of
 * Postgres's two-int `pg_advisory_xact_lock(int4, int4)`, which exists for
 * exactly this.
 *
 * Advisory locks share one global key space per database, so an unnamespaced
 * key is a key every future advisory lock in this codebase can collide with by
 * accident. Namespacing means a collision is only ever possible between two
 * users of the SAME namespace, where the consequence is understood.
 */
const ADVISORY_NAMESPACE = { announcement: 196 } as const;

/**
 * The LEADING 32 bits of a SHA-256, read big-endian and signed, so it fits
 * Postgres's `int4`. Bytes 0-3, not the low end — which matters only to
 * someone recomputing the key by hand to look a lock up in `pg_locks`.
 */
function hash32(value: string): number {
  return createHash('sha256').update(value).digest().readInt32BE(0);
}

/**
 * Serialises concurrent sends of one `(teacher, class, message)` for the rest
 * of the calling transaction.
 *
 * `pg_advisory_xact_lock`, never `pg_advisory_lock`: the transaction-scoped
 * variant releases on commit or rollback however the transaction ends, while
 * the session-scoped one would leak a held lock onto a pooled connection and
 * eventually wedge an unrelated request that never asked for it.
 *
 * The hash is used ONLY for mutual exclusion — the caller compares the real
 * message text afterwards — so a collision inside the namespace costs a few
 * milliseconds of needless serialisation and nothing else. That is the whole
 * reason this is a lock and not a unique index on a hashed column.
 * `Announcement.message` is `@db.Text` — indexable in principle, but a btree
 * entry cannot exceed roughly 2704 bytes and `createAnnouncementSchema`
 * (`lib/schemas.ts`) sets no maximum length, so a long announcement would fail
 * to index at insert time.
 *
 * This function is MODULE-PRIVATE. Its safety rests on two properties:
 * 1. It must be the FIRST statement in its transaction. Anything above it can
 *    read state the lock exists to serialise.
 * 2. It must have EXACTLY ONE call site in the system. It sits above `Class` in
 *    the lock order (its inserts take `FOR KEY SHARE` on the parent row), so a
 *    second caller inside a transaction that already holds a `Class` lock creates
 *    an inversion immediately — and will not announce itself.
 *
 * Keeping this helper private to this module makes both properties structural
 * facts about a module boundary rather than conventions callers must remember.
 */
async function lockAnnouncementSlot(
  tx: TransactionClientOnly,
  slot: { teacherId: string; classId: string | null; message: string },
): Promise<void> {
  const key = `${slot.teacherId}|${slot.classId ?? ''}|${slot.message}`;
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM (
      SELECT pg_advisory_xact_lock(${ADVISORY_NAMESPACE.announcement}::int4, ${hash32(key)}::int4)
    ) AS taken`;
}

export type SendAnnouncementInput = {
  teacherId: string;
  classId: string | null;
  message: string;
  recipients: CreateNotificationInput[];
};

export type SendAnnouncementResult = {
  announcement: Announcement;
  deduped: boolean;
};

/**
 * Sends an announcement to students, wrapped in an interactive transaction that
 * serialises concurrent sends using a transaction-scoped advisory lock.
 *
 * If a matching announcement for the same `(teacherId, classId, message)` was
 * already sent within `ANNOUNCEMENT_DEDUPE_WINDOW_MS`, duplicate creation is
 * suppressed and the existing recent record is returned with `deduped: true`.
 */
export async function sendAnnouncement(
  db: PrismaClient,
  input: SendAnnouncementInput,
): Promise<SendAnnouncementResult> {
  const { teacherId, classId, message, recipients } = input;

  return db.$transaction(async (tx) => {
    // First statement in the transaction, so the compare below and both writes
    // after it are serialised against an identical concurrent send. Without
    // it, two racers each read an empty `findFirst` — neither has committed
    // anything the other can see — and both fan out.
    //
    // The three fields go in as a tuple and the key is composed inside
    // `lockAnnouncementSlot`, deliberately: they are the same three the
    // `findFirst` below compares, and a key composed here could drift from
    // that predicate without anything failing.
    await lockAnnouncementSlot(tx, {
      teacherId,
      classId,
      message,
    });

    const recent = await tx.announcement.findFirst({
      where: {
        teacherId,
        // `classId` is nullable (the all-students case) and a Prisma `where`
        // given `undefined` OMITS the clause, so explicitly passing `classId`
        // (which is `string | null`) ensures `WHERE "classId" IS NULL` is queried
        // for all-students sends rather than matching all announcements.
        classId,
        message,
        // `sentAt`, not `createdAt` — this model has no `createdAt`.
        sentAt: { gte: new Date(Date.now() - ANNOUNCEMENT_DEDUPE_WINDOW_MS) },
      },
      orderBy: { sentAt: 'desc' },
    });
    if (recent) return { announcement: recent, deduped: true };

    // Below the compare, because this is the write that reaches people: one
    // `Notification` per recipient. It emits on the SSE bus per input inside
    // the call, so a rollback here leaves bus events already emitted — that is
    // pre-existing shape, accepted in the spec, and the reason this
    // transaction is kept to two statements.
    const count = await createBulkNotifications(tx, recipients);
    const created = await tx.announcement.create({
      data: {
        teacherId,
        classId,
        message,
        recipientCount: count,
      },
    });
    return { announcement: created, deduped: false };
  });
}
