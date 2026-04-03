/**
 * Waitlist Service — Hybrid promotion for class overflow.
 *
 * Manages the waitlist when a class reaches max_students. Three time windows:
 * 1. auto_promote — before 1 hour before cancel deadline, first in queue is auto-promoted
 * 2. first_come_first_claimed — final hour before deadline, all waitlisted are notified
 * 3. frozen — after deadline passes, no more promotions
 */

import type { PrismaClient, Prisma, CancelDeadline, WaitlistEntry } from '@prisma/client';

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
const DEADLINE_HOURS: Record<CancelDeadline, number> = {
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
 * Given a class date, start time (HH:mm), and cancel deadline enum:
 * 1. Combine classDate + startTime into a class start datetime (UTC)
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
  now?: Date,
): WaitlistWindow {
  const currentTime = now ?? new Date();

  // Parse start time
  const [hours, minutes] = startTime.split(':').map(Number) as [number, number];

  // Combine classDate + startTime into a UTC datetime
  const classStart = new Date(classDate);
  classStart.setUTCHours(hours, minutes, 0, 0);

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
 * Finds the current max position among 'waiting' entries for this class,
 * then creates a new entry at position = max + 1 (or 1 if none exist).
 *
 * Wrapped in a transaction to prevent race conditions on position assignment.
 */
export async function addToWaitlist(
  db: PrismaClient,
  classId: string,
  studentId: string,
): Promise<WaitlistEntry> {
  return db.$transaction(async (tx) => {
    // Find the current max position among 'waiting' entries
    const maxEntry = await tx.waitlistEntry.findFirst({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const nextPosition = maxEntry ? maxEntry.position + 1 : 1;

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
 * Promotes the first waiting student: creates a Registration, links it
 * to the waitlist entry, and reorders remaining positions.
 *
 * Returns the updated waitlist entry, or null if no waiting students remain.
 *
 * Wrapped in a transaction so promotion, registration creation, and
 * reordering are atomic.
 */
export async function promoteNext(
  db: PrismaClient,
  classId: string,
): Promise<WaitlistEntry | null> {
  return db.$transaction(async (tx) => {
    // Find first 'waiting' entry ordered by position
    const nextEntry = await tx.waitlistEntry.findFirst({
      where: { classId, status: 'waiting' },
      orderBy: { position: 'asc' },
    });

    if (!nextEntry) return null;

    // Look up the student to get their incomeTier
    const student = await tx.student.findUniqueOrThrow({
      where: { id: nextEntry.studentId },
      select: { incomeTier: true },
    });

    // Create a Registration
    const registration = await tx.registration.create({
      data: {
        classId,
        studentId: nextEntry.studentId,
        status: 'registered',
        tierAtBooking: student.incomeTier,
      },
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

    // Reorder remaining 'waiting' entries
    await reorderWaitingEntries(tx, classId);

    return updatedEntry;
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Reorders all 'waiting' entries for a class so positions are
 * sequential starting at 1 with no gaps.
 */
async function reorderWaitingEntries(
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
