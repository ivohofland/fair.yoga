/**
 * Waitlist Service — Hybrid promotion for class overflow.
 *
 * Manages the waitlist when a class reaches max_students. Three time windows:
 * 1. auto_promote — before 1 hour before cancel deadline, first in queue is auto-promoted
 * 2. first_come_first_claimed — final hour before deadline, all waitlisted are notified
 * 3. frozen — after deadline passes, no more promotions
 */

import type { PrismaClient, Prisma, CancelDeadline, WaitlistEntry } from '@prisma/client';
import { classStartInstant } from '@/lib/timezone';
import { createBulkNotifications } from './notifications';

/** Raised when a promotion/claim is not allowed in the current class state. */
export class WaitlistPromotionError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | 'class_not_open'
      | 'class_full'
      | 'window_frozen'
      | 'wrong_window'
      | 'entry_not_waiting',
  ) {
    super(message);
    this.name = 'WaitlistPromotionError';
  }
}

/** Raised when joining the waitlist is not allowed. */
export class WaitlistJoinError extends Error {
  constructor(
    message: string,
    public readonly reason: 'class_not_open' | 'class_not_full' | 'already_registered',
  ) {
    super(message);
    this.name = 'WaitlistJoinError';
  }
}

/** Registration statuses that occupy a spot. */
const ACTIVE_REGISTRATION_STATUSES = ['registered', 'attended', 'no_show'] as const;

/**
 * Creates or reactivates a registration row. Both Registration and
 * WaitlistEntry are unique per (classId, studentId), and cancelled rows are
 * kept — plain `create` locks a student out of a class forever after one
 * cancellation. Reactivation resets the row instead.
 */
export async function activateRegistration(
  tx: PrismaTransactionClient,
  input: { classId: string; studentId: string; tierAtBooking: number; isWalkIn?: boolean },
) {
  const existing = await tx.registration.findUnique({
    where: { classId_studentId: { classId: input.classId, studentId: input.studentId } },
  });
  if (existing) {
    return tx.registration.update({
      where: { id: existing.id },
      data: {
        status: 'registered',
        cancelledAt: null,
        tierAtBooking: input.tierAtBooking,
        isWalkIn: input.isWalkIn ?? false,
      },
    });
  }
  return tx.registration.create({
    data: {
      classId: input.classId,
      studentId: input.studentId,
      status: 'registered',
      tierAtBooking: input.tierAtBooking,
      isWalkIn: input.isWalkIn ?? false,
    },
  });
}

/** A Prisma client or transaction client — used for helpers that run inside or outside transactions. */
type PrismaTransactionClient = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WaitlistWindow = 'auto_promote' | 'first_come_first_claimed' | 'frozen';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maps CancelDeadline enum to hours before class start. */
export const DEADLINE_HOURS: Record<CancelDeadline, number> = {
  HOURS_48: 48,
  HOURS_24: 24,
  HOURS_12: 12,
  HOURS_6: 6,
};

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Determines which promotion window the waitlist is currently in.
 *
 * Given a class date, start time (HH:mm, teacher-local), the teacher's
 * timezone, and the cancel deadline enum:
 * 1. Resolve classDate + startTime in the teacher's timezone → class start
 * 2. Subtract deadline hours → deadline time
 * 3. Subtract 1 more hour → cutoff time
 * 4. If now >= deadline → 'frozen'
 * 5. If now >= cutoff → 'first_come_first_claimed'
 * 6. Otherwise → 'auto_promote'
 */
export function getWaitlistWindow(
  classDate: Date,
  startTime: string,
  cancelDeadline: CancelDeadline,
  timeZone: string,
  now?: Date,
): WaitlistWindow {
  const currentTime = now ?? new Date();

  const classStart = classStartInstant(classDate, startTime, timeZone);

  // Calculate deadline and cutoff
  const deadlineHours = DEADLINE_HOURS[cancelDeadline];
  const deadlineTime = new Date(classStart.getTime() - deadlineHours * 60 * 60 * 1000);
  const cutoffTime = new Date(deadlineTime.getTime() - 1 * 60 * 60 * 1000);

  if (currentTime >= deadlineTime) {
    return 'frozen';
  }
  if (currentTime >= cutoffTime) {
    return 'first_come_first_claimed';
  }
  return 'auto_promote';
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * Adds a student to the waitlist at the next available position.
 *
 * Guards (under the shared FOR UPDATE class lock, so joins serialize with
 * registrations and promotions):
 * - the class must be open
 * - the class must actually be full — otherwise the student should book
 * - the student must not hold an active registration
 *
 * A student who left (or was promoted and then cancelled) has their old
 * entry reactivated at the back of the queue — the unique
 * (classId, studentId) constraint means the row must be reused.
 *
 * Throws WaitlistJoinError when a guard rejects.
 */
export async function addToWaitlist(
  db: PrismaClient,
  classId: string,
  studentId: string,
): Promise<WaitlistEntry> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;

    const cls = await tx.class.findUniqueOrThrow({
      where: { id: classId },
      select: { status: true, maxStudents: true },
    });
    if (cls.status !== 'open') {
      throw new WaitlistJoinError(
        `Cannot join the waitlist for a class with status "${cls.status}"`,
        'class_not_open',
      );
    }

    const activeCount = await tx.registration.count({
      where: { classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
    });
    if (activeCount < cls.maxStudents) {
      throw new WaitlistJoinError(
        'The class still has open spots — book directly instead',
        'class_not_full',
      );
    }

    if (await hasActiveRegistration(tx, classId, studentId)) {
      throw new WaitlistJoinError(
        'You are already registered for this class',
        'already_registered',
      );
    }

    // Find the current max position among 'waiting' entries
    const maxEntry = await tx.waitlistEntry.findFirst({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const nextPosition = maxEntry ? maxEntry.position + 1 : 1;

    const existingEntry = await tx.waitlistEntry.findUnique({
      where: { classId_studentId: { classId, studentId } },
    });
    if (existingEntry) {
      // Already waiting → joining again is a no-op.
      if (existingEntry.status === 'waiting') return existingEntry;
      // Rejoin: reactivate the old row at the back of the queue.
      return tx.waitlistEntry.update({
        where: { id: existingEntry.id },
        data: {
          status: 'waiting',
          position: nextPosition,
          promotedAt: null,
          registrationId: null,
        },
      });
    }

    return tx.waitlistEntry.create({
      data: {
        classId,
        studentId,
        position: nextPosition,
        status: 'waiting',
      },
    });
  });
}

/**
 * Removes a student from the waitlist and reorders remaining positions.
 *
 * Marks the entry as 'removed', then gets all remaining 'waiting' entries
 * ordered by position and reorders them sequentially starting at 1.
 *
 * Wrapped in a transaction so removal and reordering are atomic.
 */
export async function removeFromWaitlist(
  db: PrismaClient,
  classId: string,
  studentId: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    // Mark as removed
    await tx.waitlistEntry.update({
      where: { classId_studentId: { classId, studentId } },
      data: { status: 'removed' },
    });

    // Reorder remaining 'waiting' entries
    await reorderWaitingEntries(tx, classId);
  });
}

/**
 * Promotes a waiting student: creates a Registration, links it to the
 * waitlist entry, notifies the student, and reorders remaining positions.
 *
 * Without `entryId`, the queue head is promoted; with `entryId`, that
 * specific entry is promoted (teacher's explicit choice).
 *
 * Guards (all inside the transaction, serialized by a FOR UPDATE lock on
 * the class row shared with the registration route):
 * - the class must still be open
 * - the promotion window must not be frozen (past the cancel deadline)
 * - the class must have a free spot — promotions are not walk-ins
 *
 * Returns the updated waitlist entry, or null when the queue is empty.
 * Throws WaitlistPromotionError when a guard rejects.
 */
export async function promoteNext(
  db: PrismaClient,
  classId: string,
  opts: { entryId?: string; now?: Date } = {},
): Promise<WaitlistEntry | null> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;

    const cls = await tx.class.findUniqueOrThrow({
      where: { id: classId },
      include: { teacher: { select: { defaultTimezone: true } } },
    });

    if (cls.status !== 'open') {
      throw new WaitlistPromotionError(
        `Cannot promote into a class with status "${cls.status}"`,
        'class_not_open',
      );
    }

    const window = getWaitlistWindow(
      cls.date,
      cls.startTime,
      cls.cancelDeadline,
      cls.teacher.defaultTimezone,
      opts.now,
    );
    if (window === 'frozen') {
      throw new WaitlistPromotionError(
        'The waitlist is frozen — the cancellation deadline has passed',
        'window_frozen',
      );
    }

    const activeCount = await tx.registration.count({
      where: { classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
    });
    if (activeCount >= cls.maxStudents) {
      throw new WaitlistPromotionError('Class is full', 'class_full');
    }

    // Find the entry to promote. Entries can go stale — a student books the
    // class directly and their `waiting` row survives. A stale head must be
    // dropped, not promoted: promoting it would violate the unique
    // (classId, studentId) registration constraint and wedge the queue.
    let nextEntry: WaitlistEntry | null = null;
    if (opts.entryId) {
      const candidate = await tx.waitlistEntry.findFirst({
        where: { id: opts.entryId, classId, status: 'waiting' },
      });
      if (candidate && (await hasActiveRegistration(tx, classId, candidate.studentId))) {
        await tx.waitlistEntry.update({
          where: { id: candidate.id },
          data: { status: 'removed' },
        });
        await reorderWaitingEntries(tx, classId);
        throw new WaitlistPromotionError(
          'This student already has a registration for the class',
          'entry_not_waiting',
        );
      }
      nextEntry = candidate;
    } else {
      for (;;) {
        const candidate = await tx.waitlistEntry.findFirst({
          where: { classId, status: 'waiting' },
          orderBy: { position: 'asc' },
        });
        if (!candidate) break;
        if (!(await hasActiveRegistration(tx, classId, candidate.studentId))) {
          nextEntry = candidate;
          break;
        }
        await tx.waitlistEntry.update({
          where: { id: candidate.id },
          data: { status: 'removed' },
        });
      }
    }

    if (!nextEntry) {
      if (opts.entryId) {
        throw new WaitlistPromotionError('Waitlist entry is not waiting', 'entry_not_waiting');
      }
      return null;
    }

    // Look up the student to get their incomeTier
    const student = await tx.student.findUniqueOrThrow({
      where: { id: nextEntry.studentId },
      select: { incomeTier: true },
    });

    const registration = await activateRegistration(tx, {
      classId,
      studentId: nextEntry.studentId,
      tierAtBooking: student.incomeTier,
    });

    // Update the waitlist entry: promoted status, promotedAt, link to registration
    const updatedEntry = await tx.waitlistEntry.update({
      where: { id: nextEntry.id },
      data: {
        status: 'promoted',
        promotedAt: new Date(),
        registrationId: registration.id,
      },
    });

    await createBulkNotifications(tx, [
      {
        recipientType: 'student',
        recipientId: nextEntry.studentId,
        type: 'waitlist_promoted',
        title: 'You are in',
        body: `A spot opened in ${cls.classType} and you moved off the waitlist.`,
        relatedClassId: classId,
      },
    ]);

    // Reorder remaining 'waiting' entries
    await reorderWaitingEntries(tx, classId);

    return updatedEntry;
  });
}

/**
 * Claims an open spot from the waitlist during the first-come-first-claimed
 * window (final hour before the cancel deadline). The first student whose
 * claim lands gets the spot; everyone else keeps waiting.
 */
export async function claimSpot(
  db: PrismaClient,
  classId: string,
  studentId: string,
  now?: Date,
): Promise<WaitlistEntry> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;

    const cls = await tx.class.findUniqueOrThrow({
      where: { id: classId },
      include: { teacher: { select: { defaultTimezone: true } } },
    });

    if (cls.status !== 'open') {
      throw new WaitlistPromotionError(
        `Cannot claim a spot in a class with status "${cls.status}"`,
        'class_not_open',
      );
    }

    const window = getWaitlistWindow(
      cls.date,
      cls.startTime,
      cls.cancelDeadline,
      cls.teacher.defaultTimezone,
      now,
    );
    if (window === 'frozen') {
      throw new WaitlistPromotionError(
        'The waitlist is frozen — the cancellation deadline has passed',
        'window_frozen',
      );
    }
    if (window !== 'first_come_first_claimed') {
      throw new WaitlistPromotionError(
        'Spots can only be claimed in the final hour before the deadline — before that the queue promotes automatically',
        'wrong_window',
      );
    }

    const activeCount = await tx.registration.count({
      where: { classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
    });
    if (activeCount >= cls.maxStudents) {
      throw new WaitlistPromotionError('The spot has already been claimed', 'class_full');
    }

    const entry = await tx.waitlistEntry.findFirst({
      where: { classId, studentId, status: 'waiting' },
    });
    if (!entry) {
      throw new WaitlistPromotionError('You are not on the waitlist for this class', 'entry_not_waiting');
    }

    const student = await tx.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { incomeTier: true },
    });

    const registration = await activateRegistration(tx, {
      classId,
      studentId,
      tierAtBooking: student.incomeTier,
    });

    const updatedEntry = await tx.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: 'promoted', promotedAt: new Date(), registrationId: registration.id },
    });

    await createBulkNotifications(tx, [
      {
        recipientType: 'student',
        recipientId: studentId,
        type: 'booking_confirmed',
        title: 'Spot claimed',
        body: `You claimed the open spot in ${cls.classType}.`,
        relatedClassId: classId,
      },
    ]);

    await reorderWaitingEntries(tx, classId);

    return updatedEntry;
  });
}

// ---------------------------------------------------------------------------
// Spot-freed hook — the hybrid promotion entry point
// ---------------------------------------------------------------------------

export type SpotFreedResult =
  | { action: 'promoted'; entry: WaitlistEntry }
  | { action: 'broadcast'; notified: number }
  | { action: 'frozen' }
  | { action: 'none' };

/**
 * Called when a registration cancellation frees a spot in an open class.
 * Implements the documented hybrid promotion:
 * - before the final hour: auto-promote the queue head
 * - final hour before the deadline: broadcast to all waiting students
 *   (first to claim gets the spot)
 * - after the deadline: frozen — nothing happens
 */
export async function handleSpotFreed(
  db: PrismaClient,
  classId: string,
  now?: Date,
): Promise<SpotFreedResult> {
  const cls = await db.class.findUnique({
    where: { id: classId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!cls || cls.status !== 'open') return { action: 'none' };

  const window = getWaitlistWindow(
    cls.date,
    cls.startTime,
    cls.cancelDeadline,
    cls.teacher.defaultTimezone,
    now,
  );

  if (window === 'frozen') return { action: 'frozen' };

  if (window === 'auto_promote') {
    try {
      const entry = await promoteNext(db, classId, { now });
      return entry ? { action: 'promoted', entry } : { action: 'none' };
    } catch (err) {
      // A concurrent registration may have refilled the spot — that's fine.
      if (err instanceof WaitlistPromotionError) return { action: 'none' };
      throw err;
    }
  }

  // first_come_first_claimed: notify everyone waiting; first claim wins.
  const waiting = await db.waitlistEntry.findMany({
    where: { classId, status: 'waiting' },
  });
  if (waiting.length === 0) return { action: 'none' };

  await createBulkNotifications(
    db,
    waiting.map((w) => ({
      recipientType: 'student' as const,
      recipientId: w.studentId,
      type: 'spot_available' as const,
      title: 'A spot opened up',
      body: `A spot opened in ${cls.classType}. The first to claim it gets it.`,
      relatedClassId: classId,
    })),
  );
  return { action: 'broadcast', notified: waiting.length };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** True when the student holds a spot-occupying registration for the class. */
async function hasActiveRegistration(
  db: PrismaTransactionClient,
  classId: string,
  studentId: string,
): Promise<boolean> {
  const registration = await db.registration.findUnique({
    where: { classId_studentId: { classId, studentId } },
    select: { status: true },
  });
  return (
    registration !== null &&
    (ACTIVE_REGISTRATION_STATUSES as readonly string[]).includes(registration.status)
  );
}

/**
 * Reorders all 'waiting' entries for a class so positions are
 * sequential starting at 1 with no gaps.
 */
export async function reorderWaitingEntries(
  db: PrismaTransactionClient,
  classId: string,
): Promise<void> {
  const remaining = await db.waitlistEntry.findMany({
    where: { classId, status: 'waiting' },
    orderBy: { position: 'asc' },
  });

  for (let i = 0; i < remaining.length; i++) {
    const entry = remaining[i]!;
    const newPosition = i + 1;
    if (entry.position !== newPosition) {
      await db.waitlistEntry.update({
        where: { id: entry.id },
        data: { position: newPosition },
      });
    }
  }
}
