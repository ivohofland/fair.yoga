/**
 * Reconciles waitlists whose spot-freed hook never delivered.
 *
 * `handleSpotFreed` can fail two different ways, and both end with a waiting
 * student silently not told and nothing retrying (#220):
 *
 *   - the broadcast branch aborts at `lockClassRow`'s 2s `SET LOCAL
 *     lock_timeout` with `55P03`, while the contending writer still holds the
 *     row;
 *   - the auto-promote branch blows Prisma's default 5s interactive-transaction
 *     budget with `P2028`, measured at 7014 ms against a 7 s hold — it waits out
 *     the whole hold and fails afterwards, because Prisma cannot cancel a
 *     statement already blocked inside Postgres (`gdpr.ts:602`).
 *
 * Both callers log and swallow, so this sweep is the only thing that makes
 * either loss recoverable. It also covers a student who was merely offline,
 * which is the never-filed observation at
 * `docs/audits/2026-07-18-review-round-2.md:75`.
 *
 * **This module detects; `handleSpotFreed` decides.** No window logic, capacity
 * policy or promote-vs-broadcast branch is reimplemented here. That is what
 * makes the auto-promote half covered without a line addressing it, and it is
 * why re-running the hook is the whole action.
 */
import type { CancelDeadline, PrismaClient } from '@prisma/client';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { classStartInstant } from '@/lib/timezone';
import { DEADLINE_HOURS, getWaitlistWindow, handleSpotFreed } from './waitlist';

export interface ReconcileSummary {
  /** Classes holding at least one `waiting` entry that were examined. */
  candidates: number;
  /** Classes on which `handleSpotFreed` was invoked. */
  reconciled: number;
  /** Classes whose invocation threw. */
  failed: number;
}

export async function reconcileWaitlists(
  db: PrismaClient,
  opts: { now?: Date } = {},
): Promise<ReconcileSummary> {
  // Start from the waiting entries, not from the classes: most classes have no
  // queue, and this is the narrowest set that can possibly need reconciling.
  const queued = await db.waitlistEntry.findMany({
    where: { status: 'waiting' },
    select: { classId: true },
    distinct: ['classId'],
  });
  const candidateIds = queued.map((q) => q.classId);
  if (candidateIds.length === 0) return { candidates: 0, reconciled: 0, failed: 0 };

  const classes = await db.class.findMany({
    where: { id: { in: candidateIds }, status: 'open' },
    select: {
      id: true,
      date: true,
      startTime: true,
      cancelDeadline: true,
      maxStudents: true,
      teacher: { select: { defaultTimezone: true } },
    },
  });

  // One grouped count for the whole candidate set, not one count per class: this
  // runs every minute on a 2 GB VPS.
  const counts = await db.registration.groupBy({
    by: ['classId'],
    where: {
      classId: { in: candidateIds },
      status: { in: [...ACTIVE_REGISTRATION_STATUSES] },
    },
    _count: { _all: true },
  });
  const activeByClass = new Map(counts.map((c) => [c.classId, c._count._all]));

  let reconciled = 0;

  for (const cls of classes) {
    const window = getWaitlistWindow(
      cls.date,
      cls.startTime,
      cls.cancelDeadline,
      cls.teacher.defaultTimezone,
      opts.now,
    );
    if (window === 'frozen') continue;

    // A class ABSENT from the groupBy has zero active registrations, not zero
    // free seats. `?? 0` is what keeps the emptiest classes — the ones most
    // obviously in need of reconciling — inside the candidate set. Defaulting
    // the other way, or skipping the misses, inverts this filter exactly where
    // it matters most.
    const activeCount = activeByClass.get(cls.id) ?? 0;

    // Deliberately NOT `readSeatCount`: that helper takes `TransactionClientOnly`
    // and documents the Class row lock as a precondition (`capacity.ts:68`).
    //
    // This unlocked read is NOT the mistake #212 existed to remove, and the
    // difference is worth stating because it looks identical. #212's finding was
    // that an unlocked count is meaningless AS A GUARD — it moves the race
    // rather than closing it. This is not a guard. It decides only whether to
    // ASK, and `handleSpotFreed` re-counts through `readSeatCount` under
    // `lockClassRow` before it acts. Stale in either direction costs nothing:
    // reads full when free, the seat waits one more tick; reads free when full,
    // the hook's locked count suppresses it, as designed.
    //
    // It is therefore an equivalent mutant and has no mutation test. Said out
    // loud so the next reader does not mutation-test it, find nothing, and
    // conclude this suite is weak — the same reason `waitlist.ts:715` says it
    // about its own `waiting.length === 0` line.
    if (activeCount >= cls.maxStudents) continue;

    // Only the broadcast needs a gate. A promotion fills the seat, so the
    // auto-promote branch erases its own trigger and cannot re-fire; a broadcast
    // leaves the seat free and would go out again every tick.
    if (window === 'first_come_first_claimed' && (await alreadyBroadcastInWindow(db, cls))) {
      continue;
    }

    await handleSpotFreed(db, cls.id, opts.now);
    reconciled += 1;
  }

  return { candidates: classes.length, reconciled, failed: 0 };
}

/**
 * True when this class's current claim window already carries a broadcast.
 *
 * Exact rather than approximate: the broadcast is one `createMany` with no
 * `skipDuplicates` (`waitlist.ts:732`), so a class's waiting students either all
 * received a `spot_available` notification or none did. There is no partial
 * state for a class-level check to be wrong about, and so no per-recipient query
 * and no new column.
 *
 * `claimWindowStart` is derived from the class rather than stored: it is
 * `classStart - (deadlineHours + 1) h`, the same boundary `getWaitlistWindow`
 * computes to decide the window in the first place.
 *
 * **The one race this does not close.** The read is outside the Class row lock,
 * so: this reads the gate → the live hook broadcasts → this invokes the hook →
 * a second broadcast. The sweep cannot race ITSELF (`scheduler.ts:138` refuses a
 * tick while one is running), only the live path. The cost is one duplicate
 * notification against a current cost of no notification at all, and that trade
 * was made deliberately.
 */
async function alreadyBroadcastInWindow(
  db: PrismaClient,
  cls: {
    id: string;
    date: Date;
    startTime: string;
    cancelDeadline: CancelDeadline;
    teacher: { defaultTimezone: string };
  },
): Promise<boolean> {
  const classStart = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const claimWindowStart = new Date(
    classStart.getTime() - (DEADLINE_HOURS[cls.cancelDeadline] + 1) * 60 * 60 * 1000,
  );

  const existing = await db.notification.findFirst({
    where: {
      relatedClassId: cls.id,
      type: 'spot_available',
      createdAt: { gte: claimWindowStart },
    },
    select: { id: true },
  });
  return existing !== null;
}
