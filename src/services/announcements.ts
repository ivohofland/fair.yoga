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
import { log } from '@/lib/log';

/**
 * How long an identical announcement suppresses a second send of itself.
 *
 * Two minutes: long enough to absorb a double-click and a retried request from
 * a flaky connection, short enough that a teacher who genuinely wants to say
 * the same thing again is not told no. The same quantity as
 * `MANUAL_REMIND_COOLDOWN_MS` (`services/payments.ts`), deliberately — one
 * concept, not two.
 *
 * It lives here, beside the lock that makes it enforceable, rather than in the
 * route: `tests/integration/announcements-api.test.ts` backdates a first send
 * by exactly this to prove a later identical one still goes out, and a test
 * that hard-codes `120000` drifts silently the day the window changes.
 *
 * Importing this module in a jsdom test pulls the notification bus and pino in
 * transitively (via `services/notifications.ts` — unlike its old home in
 * `lib/db-locks.ts`, which pulled only `crypto` and the generated client).
 * It stays safe in node tests and server contexts, but re-check before
 * importing it from a client component or a `'use client'` test; a bundled
 * pino is the same class of failure as a bundled Prisma client.
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
 * to index at insert time. An index-based design would therefore have to key
 * on a hash, where a collision silently rejects a legitimate announcement
 * instead of merely serialising it. A time-bucketed index leaks differently
 * again — two sends straddling a bucket edge both pass.
 *
 * Branded `TransactionClientOnly` per the register in `db-locks.ts`: on a bare
 * client the lock would be taken and released by its own autocommit
 * transaction before the caller's next statement ran, protecting nothing.
 *
 * It is NOT free of the ordering obligation in `docs/lock-order.md`, and the
 * plan for #196 predicted it would be. Its transaction goes on to insert a
 * `Notification` carrying `relatedClassId` and an `Announcement` carrying
 * `classId`, each of which takes `FOR KEY SHARE` on the parent `Class` row —
 * that document's "fourth path". So this lock sits ABOVE `Class` in the order
 * (see "The announcement advisory lock" section there). The `FOR KEY SHARE`
 * reasoning covers the worst case, which is the class-scoped send; an
 * all-students announcement carries `classId === null` on both inserts and
 * takes no `Class` lock at all.
 *
 * The lock call is wrapped in a subselect and the outer projection is a
 * literal, which is not styling: `pg_advisory_xact_lock` returns `void`, and
 * selecting that column directly fails at the client with
 * `P2010 … Failed to deserialize column of type 'void'` — measured, not
 * guessed. A tagged `$queryRaw` is still the right tool (the two ints are
 * bound parameters, so nothing here is interpolated); only the column it
 * hands back had to change.
 *
 * `slot` is the tuple, not a pre-composed key, and that is the point of the
 * signature. The caller's dedupe compare is a `findFirst` on exactly these
 * three columns, so the key and that predicate have to describe the same
 * thing — and when the caller composed the key itself, nothing said so.
 * Changing the composition without changing the predicate would have given
 * two identical sends two DIFFERENT locks: neither waits, each reads an empty
 * compare, and both fan out — the exact failure this lock exists to prevent,
 * reintroduced by an edit that looks local. Composing it here puts the
 * coupling in one place. The separator makes the key ambiguous for a message
 * containing `|`, which costs nothing: the key is only ever a mutual-exclusion
 * hash (see above), and the caller still compares the real column values.
 *
 * This function is MODULE-PRIVATE (#215), and that is what makes it safe from
 * the ordering obligation above. "Cannot be half of a cycle" used to be a
 * warning in `docs/lock-order.md` — check no second call site appears before
 * calling it — because a second caller inside a transaction already holding a
 * `Class` lock would create an inversion immediately, and it would not
 * announce itself. It is now structural: a second caller would have to break
 * the service module boundary to reach this helper. Two announcement sends
 * racing each other take the two locks in the same order (`advisory → Class`),
 * which is not a cycle either.
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

  // Second line of defence. The route answers 400 on an empty recipient set
  // before reaching this service; a future caller that forgets the check would
  // otherwise commit an `Announcement` with `recipientCount: 0` and get a
  // "201 created" for a fan-out that notified nobody — a silent phantom in
  // the teacher's sent history.
  if (recipients.length === 0) {
    throw new Error('sendAnnouncement: refusing to announce to zero recipients');
  }

  const result = await db.$transaction(async (tx) => {
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
        // given `undefined` OMITS the clause rather than matching `NULL` —
        // which would make an all-students send match every announcement this
        // teacher ever sent. `sendAnnouncement` is safe because
        // `SendAnnouncementInput.classId` is typed `string | null`, so the
        // route's `body.classId ?? null` coercion travels all the way down as
        // `null`, and `WHERE "classId" IS NULL` is queried.
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

  // Outcome only, after the transaction committed — a rolled-back send logged
  // nothing, and the error propagates to `withErrorHandler`, which logs it.
  log.info(
    {
      teacherId,
      classId,
      announcementId: result.announcement.id,
      recipientCount: result.announcement.recipientCount,
      deduped: result.deduped,
    },
    result.deduped ? 'announcement send suppressed as duplicate' : 'announcement sent',
  );
  return result;
}
