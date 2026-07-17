/**
 * Automated Class Transitions — Handles time-based class lifecycle changes.
 *
 * Three jobs run periodically:
 * 1. Auto-transition: open → in_progress when start time is reached
 * 2. Auto-cancel: cancel open classes below min_students at auto_cancel_check time
 * 3. Auto-complete: in_progress → completed when class duration has elapsed
 */

import type { PrismaClient } from '@prisma/client';
import { transitionClass, completeClass } from './class-lifecycle';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { classStartInstant } from '@/lib/timezone';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANCEL_CHECK_HOURS: Record<string, number> = {
  HOURS_4: 4,
  HOURS_2: 2,
  HOURS_1: 1,
};

// ---------------------------------------------------------------------------
// Auto-transition: open → in_progress
// ---------------------------------------------------------------------------

/**
 * Finds all open classes whose start time has passed and transitions
 * them to in_progress.
 */
export async function autoTransitionToInProgress(
  db: PrismaClient,
  now?: Date,
): Promise<number> {
  const currentTime = now ?? new Date();

  // A class early in the teacher's local morning can start *before* its
  // stored UTC-midnight date, so include the next calendar day in the sweep.
  const dateCeiling = new Date(currentTime.getTime() + 24 * 60 * 60 * 1000);
  const openClasses = await db.class.findMany({
    where: { status: 'open', date: { lte: dateCeiling } },
    include: { teacher: { select: { defaultTimezone: true } } },
  });

  let transitioned = 0;

  for (const cls of openClasses) {
    const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
    if (start <= currentTime) {
      const result = await transitionClass(db, cls.id, 'in_progress');
      if (result.ok) transitioned++;
    }
  }

  return transitioned;
}

// ---------------------------------------------------------------------------
// Auto-cancel: open classes below min_students
// ---------------------------------------------------------------------------

/**
 * Finds open classes within their auto-cancel check window and cancels
 * them if registered students are below min_students.
 * Creates notifications for affected students.
 */
export async function autoCancelClasses(
  db: PrismaClient,
  now?: Date,
): Promise<number> {
  const currentTime = now ?? new Date();

  const openClasses = await db.class.findMany({
    where: { status: 'open' },
    include: {
      teacher: { select: { defaultTimezone: true } },
      registrations: {
        where: { status: { in: ['registered', 'attended', 'no_show'] } },
        select: { studentId: true },
      },
    },
  });

  let cancelled = 0;

  for (const cls of openClasses) {
    const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
    const checkHours = CANCEL_CHECK_HOURS[cls.autoCancelCheck] ?? 2;
    const checkTime = new Date(start.getTime() - checkHours * 60 * 60 * 1000);

    // Only cancel if we're past the check time but before the class starts
    if (currentTime >= checkTime && currentTime < start) {
      const activeCount = cls.registrations.length;

      if (activeCount < cls.minStudents) {
        // Cancel + notify atomically: a cancelled class nobody was told
        // about is worse than one that stays open one more sweep.
        const didCancel = await db.$transaction(async (tx) => {
          const updated = await tx.class.updateMany({
            where: { id: cls.id, status: 'open' },
            data: { status: 'cancelled' },
          });
          if (updated.count === 0) return false;

          const notifications: CreateNotificationInput[] = cls.registrations.map((r) => ({
            recipientType: 'student' as const,
            recipientId: r.studentId,
            type: 'class_cancelled' as const,
            title: 'Class cancelled',
            body: `${cls.classType} class has been cancelled due to insufficient registrations.`,
            relatedClassId: cls.id,
          }));
          notifications.push({
            recipientType: 'teacher',
            recipientId: cls.teacherId,
            type: 'class_cancelled',
            title: 'Class auto-cancelled',
            body: `${cls.classType} was cancelled — only ${activeCount} of ${cls.minStudents} minimum students registered.`,
            relatedClassId: cls.id,
          });
          await createBulkNotifications(tx, notifications);
          return true;
        });

        if (didCancel) cancelled++;
      }
    }
  }

  return cancelled;
}

// ---------------------------------------------------------------------------
// Auto-complete: in_progress → completed
// ---------------------------------------------------------------------------

/**
 * Finds in_progress classes whose duration has elapsed and completes them.
 * Triggers pricing calculation and payment creation via completeClass().
 */
export async function autoCompleteClasses(
  db: PrismaClient,
  now?: Date,
): Promise<number> {
  const currentTime = now ?? new Date();

  const inProgressClasses = await db.class.findMany({
    where: { status: 'in_progress' },
    include: { teacher: { select: { defaultTimezone: true } } },
  });

  let completed = 0;

  for (const cls of inProgressClasses) {
    const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
    const endTime = new Date(start.getTime() + cls.durationMinutes * 60 * 1000);

    if (currentTime >= endTime) {
      const result = await completeClass(db, cls.id);
      if (result.ok) completed++;
    }
  }

  return completed;
}
