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
import { log } from '@/lib/log';
import { lockClassRow } from '@/lib/db-locks';

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
    // Per-class isolation: one bad class (corrupt timezone, failed
    // transition) must not halt the sweep for every other class.
    try {
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      if (start <= currentTime) {
        const result = await transitionClass(db, cls.id, 'in_progress');
        if (result.ok) {
          transitioned++;
        } else {
          log.error({ classId: cls.id, reason: result.error }, 'transition to in_progress rejected');
        }
      }
    } catch (err) {
      log.error({ err, classId: cls.id }, 'transition to in_progress failed');
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
 *
 * Each class gets its own `db.$transaction`, so each also gets its own
 * `lockClassRow` wait and its own Prisma-default transaction budget — not a
 * budget shared across the sweep. This differs from `deleteStudentAccount`
 * (`gdpr.ts`), which calls `lockClassRow` in a loop *inside one*
 * transaction and sizes that transaction's timeout to the number of classes
 * it is about to lock: nothing here accumulates that way, so a slow lock
 * wait on one class costs only that class's own transaction, not the ones
 * before or after it in this loop.
 */
export async function autoCancelClasses(
  db: PrismaClient,
  now?: Date,
): Promise<number> {
  const currentTime = now ?? new Date();

  // No `registrations` eager-load here: the count and the recipient list
  // that decide and act on cancellation are both read inside the
  // transaction below, from the database state at the moment of the CAS —
  // not from this outer snapshot.
  const openClasses = await db.class.findMany({
    where: { status: 'open' },
    include: {
      teacher: { select: { defaultTimezone: true } },
    },
  });

  let cancelled = 0;

  for (const cls of openClasses) {
    try {
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      const checkHours = CANCEL_CHECK_HOURS[cls.autoCancelCheck] ?? 2;
      const checkTime = new Date(start.getTime() - checkHours * 60 * 60 * 1000);

      // Only cancel if we're past the check time but before the class starts
      if (currentTime >= checkTime && currentTime < start) {
        // Cancel + notify atomically: a cancelled class nobody was told
        // about is worse than one that stays open one more sweep.
        const didCancel = await db.$transaction(async (tx) => {
          // Locked before anything is read, not just before the write: this
          // decision reads more state than a status (a registration count),
          // so per the rule in `transitionClass`'s docblock — CAS where the
          // status is the only thing the decision depends on, `FOR UPDATE`
          // where the transaction reads more state under the decision —
          // this is a locking site, not a CAS-only one. Every production
          // registration writer already takes this same Class row lock
          // first (`POST /api/registrations`; `waitlist.ts`'s
          // `activateRegistration`), so this serializes against all of
          // them: one that is already inside its own `lockClassRow` when
          // this transaction starts is finished (committed or rolled back)
          // before this count runs; one that arrives after this count has
          // already been read blocks here, behind this lock, until this
          // transaction commits or rolls back — it cannot land between the
          // count and the update below either way. Without this lock, nothing
          // stops it doing exactly that: reading the count first is not
          // enough by itself, only serializing every writer against it is.
          await lockClassRow(tx, cls.id);

          // Counted HERE, not from the sweep's outer `findMany` at the top of
          // this function. That read is a snapshot taken before this
          // transaction began, so a registration committing in between is
          // invisible to it — and cancelling a class that has just reached
          // its minimum tells every student it is off when it is not.
          const activeCount = await tx.registration.count({
            where: { classId: cls.id, status: { in: ['registered', 'attended', 'no_show'] } },
          });
          if (activeCount >= cls.minStudents) return false;

          const updated = await tx.class.updateMany({
            where: { id: cls.id, status: 'open' },
            data: { status: 'cancelled' },
          });
          if (updated.count === 0) return false;

          const registrations = await tx.registration.findMany({
            where: { classId: cls.id, status: { in: ['registered', 'attended', 'no_show'] } },
            select: { studentId: true },
          });

          const notifications: CreateNotificationInput[] = registrations.map((r) => ({
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
    } catch (err) {
      // Per-class isolation — see autoTransitionToInProgress.
      log.error({ err, classId: cls.id }, 'auto-cancel check failed');
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
    // Per-class isolation — see autoTransitionToInProgress. Completion also
    // runs the pricing engine, which has more ways to fail per class.
    try {
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      const endTime = new Date(start.getTime() + cls.durationMinutes * 60 * 1000);

      if (currentTime >= endTime) {
        const result = await completeClass(db, cls.id);
        if (result.ok) {
          completed++;
        } else {
          log.error({ classId: cls.id, reason: result.error }, 'class completion rejected');
        }
      }
    } catch (err) {
      log.error({ err, classId: cls.id }, 'class completion failed');
    }
  }

  return completed;
}
