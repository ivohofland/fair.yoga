/**
 * Automated Class Transitions — Handles time-based class lifecycle changes.
 *
 * Three jobs run periodically:
 * 1. Auto-transition: open → in_progress when start time is reached
 * 2. Auto-cancel: cancel open classes below min_students at auto_cancel_check time
 * 3. Auto-complete: in_progress → completed when class duration has elapsed
 */

import type { PrismaClient } from '@prisma/client';
import { completeClass } from './class-lifecycle';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { classStartInstant } from '@/lib/timezone';
import { formatDayHeader } from '@/lib/format';
import { log } from '@/lib/log';
import { lockClassRow } from '@/lib/db-locks';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { closeQueueOnStart } from './waitlist';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANCEL_CHECK_HOURS: Record<string, number> = {
  HOURS_4: 4,
  HOURS_2: 2,
  HOURS_1: 1,
};

/** Whether `at` falls inside a class's auto-cancel window: past the check
 * time, before the start. Shared by the sweep's pre-filter and the decision
 * under the lock, for the same reason the status set they filter on is named
 * once (`@/lib/registration-status`) — two spellings of one window is how a
 * stale-snapshot bug comes back. */
function inCancelWindow(
  cls: { date: Date; startTime: string; autoCancelCheck: string },
  timezone: string,
  at: Date,
): boolean {
  const start = classStartInstant(cls.date, cls.startTime, timezone);
  const checkHours = CANCEL_CHECK_HOURS[cls.autoCancelCheck] ?? 2;
  const checkTime = new Date(start.getTime() - checkHours * 60 * 60 * 1000);
  return at >= checkTime && at < start;
}

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
      // Pre-filter from the snapshot, and an OPTIMISATION ONLY — the same
      // shape and the same reasoning as `autoCancelClasses` below. A stale
      // pre-filter can only DELAY a transition to the next 60-second tick,
      // never cause a wrong one, because nothing here transitions: it only
      // decides whether to open a transaction and look properly.
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      if (start > currentTime) continue;

      const didTransition = await db.$transaction(async (tx) => {
        // Locked before anything is read, not just before the write. This
        // decision reads more than a status — it reads `date` and `startTime`
        // and resolves them against the teacher's timezone — so per the rule
        // in `transitionClass`'s docblock this is a locking site, not a
        // CAS-only one. See `docs/lock-order.md`.
        await lockClassRow(tx, cls.id);

        // Re-read HERE and decide from THIS row. `date` and `startTime` are
        // NOT in `ECONOMIC_FIELDS` (`lib/class-fields.ts`), so `settingsLocked`
        // does not freeze them and a teacher can reschedule an `open` class
        // with registrations at any time, including while this sweep is
        // mid-flight. Deciding from the outer `findMany` started a class
        // against a time it no longer had — and `in_progress` can only go to
        // `completed`, so the teacher cannot undo it in the app.
        const fresh = await tx.class.findUnique({
          where: { id: cls.id },
          select: {
            status: true,
            date: true,
            startTime: true,
            teacher: { select: { defaultTimezone: true } },
          },
        });
        // Deleted, or no longer open — a concurrent cancel, completion or
        // teacher action got here first. The same outcome by a different route,
        // so `debug`: worth being able to see when a sweep did nothing for
        // forty classes, not worth paging anyone.
        if (!fresh) {
          log.debug({ classId: cls.id }, 'start sweep: class gone before the lock');
          return false;
        }
        if (fresh.status !== 'open') {
          log.debug(
            { classId: cls.id, status: fresh.status },
            'start sweep: no longer open',
          );
          return false;
        }

        // Recomputed from `fresh`, not re-tested against the snapshot's
        // `start`. Re-testing the old instant is the defect wearing a lock.
        const freshStart = classStartInstant(
          fresh.date,
          fresh.startTime,
          fresh.teacher.defaultTimezone,
        );
        if (freshStart > currentTime) {
          // The race the lock exists to catch: rescheduled between the snapshot
          // and the lock. Expected and self-resolving — the next tick
          // re-evaluates the new start — but `warn`, not `debug`, so the guard
          // is visible when it fires. Its sibling `autoCompleteClasses` logs the
          // identical race at `warn`; the two must not disagree about the same
          // event.
          log.warn(
            { classId: cls.id, freshStart, currentTime },
            'start sweep: class rescheduled after the snapshot, deferring',
          );
          return false;
        }

        // Redundant with the `fresh.status` check above, kept anyway for the
        // reason `autoCancelClasses` keeps its own: it costs nothing inside a
        // statement that has to run regardless, and it is the guard that
        // survives if someone later moves or drops the re-read.
        const updated = await tx.class.updateMany({
          where: { id: cls.id, status: 'open' },
          data: { status: 'in_progress' },
        });
        if (updated.count === 0) {
          // This one is NOT benign, and it is the reason the others are logged
          // quietly rather than not at all. `lockClassRow` above holds this row,
          // and `fresh.status` was read as `open` UNDER that lock, so nothing
          // can have changed it before this statement. A count of zero here
          // means the lock did not do what every other sweep on this table
          // assumes it does. `error`, and deliberately louder than the refusals
          // around it.
          log.error({ classId: cls.id }, 'start sweep: CAS lost under a held row lock');
          return false;
        }

        // #216. First of the three `open -> in_progress` exits. Atomic with
        // the CAS above: a class that started with its queue left standing is
        // exactly the state this write exists to make unreachable.
        await closeQueueOnStart(tx, cls.id);
        return true;
      });

      if (didTransition) transitioned++;
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

  // A filtered `_count`, and it is a PRE-FILTER and nothing else — see the
  // `continue` below. A count rather than the eager-loaded rows this used to
  // carry: the recipient list is read inside the transaction under the lock
  // now, and having no `studentId`s here at all is what stops a future reader
  // rebuilding it from the snapshot without noticing.
  //
  // The filter is load-bearing, not tidiness. An UNfiltered `_count` would be
  // wrong rather than merely coarse: a class whose registrations are all
  // cancelled would count above its minimum and never be swept again. This is
  // the same filtered shape, with the same status set, that
  // `(student)/bookings/page.tsx` already uses — now literally the same
  // constant (`@/lib/registration-status`), not just the same spelling. The
  // pre-filter and the authoritative count under the lock must answer the
  // same question, or the pre-filter skips classes the locked check would
  // have cancelled.
  const openClasses = await db.class.findMany({
    where: { status: 'open' },
    include: {
      teacher: { select: { defaultTimezone: true } },
      _count: {
        select: { registrations: { where: { status: { in: [...ACTIVE_REGISTRATION_STATUSES] } } } },
      },
    },
  });

  let cancelled = 0;

  for (const cls of openClasses) {
    try {
      // Two pre-filters, both from this snapshot, both optimisations only —
      // the same shape `updateClass` (`class-lifecycle.ts`) documents for its
      // own double check: "Deleting the first check would cost round trips,
      // not correctness."
      //
      // Removing them was not free. Without a pre-filter this sweep opens a
      // transaction, issues a `SET LOCAL` and takes a `FOR UPDATE` on EVERY
      // in-window open class every 60 seconds, including the healthy majority
      // that will never be cancelled — and every concurrent registration on
      // one of those classes queues behind a lock taken purely to confirm
      // nothing needed doing. On a single 2GB VPS with one connection pool
      // (`CLAUDE.md`: "VPS budget") that is not a rounding error.
      //
      // What a stale pre-filter can cost, by contrast, is one tick: the
      // authoritative check is inside the lock, the window spans hours, and
      // the sweep runs every minute — so a class that drops below its minimum
      // between this read and the next sweep is cancelled on the next sweep
      // instead of this one. A pre-filter can only ever DELAY a cancellation,
      // never cause a wrong one, because nothing here cancels: it only
      // decides whether to look properly.
      if (cls._count.registrations >= cls.minStudents) continue;
      if (!inCancelWindow(cls, cls.teacher.defaultTimezone, currentTime)) continue;

      // Cancel + notify atomically: a cancelled class nobody was told
      // about is worse than one that stays open one more sweep.
      const didCancel = await db.$transaction(async (tx) => {
        // Locked before anything is read, not just before the write: this
        // decision reads more state than a status (a registration count),
        // so per the rule in `transitionClass`'s docblock — CAS where the
        // status is the only thing the decision depends on, `FOR UPDATE`
        // where the transaction reads more state under the decision —
        // this is a locking site, not a CAS-only one. Every production
        // writer that CREATES a registration takes the same Class row lock
        // first — `POST /api/registrations` and `waitlist.ts`'s
        // `activateRegistration` (reached through `promoteNext` and
        // `claimSpot`), each via its own inline `SELECT … FOR UPDATE`
        // rather than through this helper; `db-locks.ts` records those
        // inline sites as deliberately not adopting it. So this serializes
        // against all of them: one already inside its own lock when this
        // transaction starts is finished (committed or rolled back) before
        // this count runs; one arriving after this count has been read
        // blocks here until this transaction ends — it cannot land between
        // the count and the update below either way. Without this lock,
        // nothing stops it doing exactly that: reading the count first is
        // not enough by itself, only serializing every writer against it
        // is.
        //
        // Two writers are outside that: `PUT /api/registrations/[id]`
        // (attendance) and `DELETE /api/registrations/[id]` (cancel) both
        // write `Registration.status` with no `Class` lock at all.
        //
        // `DELETE` is harmless here, and the direction is why: it only ever
        // writes `cancelled` or `late_cancel`, both OUTSIDE the set this
        // count filters on, so a racing cancel makes the count too HIGH and
        // the class merely survives a sweep it might have been cancelled in
        // — a one-tick delay, the same cost as a stale pre-filter above.
        //
        // `PUT` is closed too, and closed exactly where the risk is. Its
        // `updateMany` WHERE (`registrations/[id]/route.ts`) refuses the one
        // accepted transition that moves INTO the counted set,
        // `late_cancel -> attended`, while the class is still `open` — which
        // is the whole of this sweep's reach, since it both selects and CASes
        // on `status: 'open'`. Once a class has started, that same move is
        // allowed and cannot affect this count, because this sweep will never
        // look at the class again.
        //
        // An earlier version of this comment claimed the check-in UI could
        // never send that request, on the grounds that its toggle writes only
        // `attended <-> no_show`. That was wrong, and worth recording because
        // it is a tempting mistake: the toggle's TARGET is always
        // attended/no_show, but its SOURCE is whatever the row already is, and
        // `activeRegistrations` (`class/[id]/page.tsx`) deliberately keeps
        // `late_cancel` rows in the check-in list. A student who cancelled late
        // and turned up anyway is one tap away, every class. The guard is
        // server-side precisely so it does not depend on what the UI happens
        // to send.
        //
        // Scope note, the same one `gdpr.ts` and `waitlist.ts`'s
        // `removeFromWaitlist` each carry at their own `lockClassRow` call:
        // `SET LOCAL lock_timeout = '2s'` bounds every statement left in
        // this transaction, not just the `FOR UPDATE` inside the helper. So
        // the 2s also governs the `registration.count`, the CAS, the
        // recipient `findMany`, and — since #112 — the `waitlistEntry`
        // `findMany`, the `waitlistEntry.updateMany` that closes the queue,
        // and `createBulkNotifications`. Six statements, not four.
        //
        // Still benign, unlike at the erasure sites, but the argument is
        // longer now because one of the six is a WRITE that takes row locks.
        // It cannot be the first place THIS transaction blocks, because this
        // transaction is already holding the `Class` row lock from the line
        // below — so any contention materialises at `lockClassRow`, exactly as
        // it did before #112. That is the whole argument, and it depends only
        // on this function's own lock, not on a property of every other writer.
        //
        // Stated that narrowly on purpose. An earlier version of this comment
        // claimed that EVERY writer of `WaitlistEntry` is serialized behind a
        // conflicting `Class` row lock, "either by calling `lockClassRow` or by
        // writing through a CAS `UPDATE` that already took one". Both halves
        // were wrong. The mechanism list omitted the most common one — an
        // inline `SELECT ... FOR UPDATE` on the class row, which is what
        // `addToWaitlist`, `promoteNext`, `claimSpot`,
        // `withdrawWaitingEntriesForTeacher` and `POST /api/registrations` all
        // do — and the universal claim is false regardless: issue #183 is open
        // precisely because `deleteStudentAccount`'s write set can exceed its
        // lock set. It replaced a correct hand-written roster with a general
        // rule, on the reasoning that rosters go stale. They do; a false
        // invariant is worse, because the next person adding a writer checks it
        // and concludes they are safe.
        //
        // To re-derive the real roster:
        // `grep -rnE 'waitlistEntry\.(create|update|delete|upsert)' src`,
        // excluding tests, then read each hit's enclosing transaction for which
        // of the three mechanisms it uses, if any.
        //
        // If one did time out, the per-class `catch` at the bottom of this
        // loop logs it and the sweep moves to the next class — no partial
        // write survives, because the whole transaction rolls back, INCLUDING
        // the cancellation itself. That is deliberate and predates #112: a
        // cancelled class nobody was told about is worse than one that stays
        // open for one more 60-second tick.
        await lockClassRow(tx, cls.id);

        // Re-read HERE, under the lock, and decide from THIS row — not from
        // the snapshot the loop is walking. Round 1 review moved the count
        // in and stopped there, which left the WINDOW itself still decided
        // from the pre-lock read: `date`, `startTime`, `autoCancelCheck`
        // and `minStudents` all still came from the outer `findMany`. Only
        // `minStudents` is economic; `date` and `startTime` are NOT, so a
        // teacher can reschedule an `open` class with registrations at any
        // time, including while this sweep is mid-flight. The result was a
        // class rescheduled out of its window being cancelled against the
        // old one — and every student emailed about it — with `cancelled`
        // now terminal in Postgres, so the teacher cannot undo it in the
        // app.
        //
        // The identical stale-window race no longer sits open in either
        // sibling. `autoTransitionToInProgress` above now re-reads `date` and
        // `startTime` from the fresh, locked row before recomputing its own
        // start instant, the same shape as this function. `autoCompleteClasses`
        // below takes no lock of its own; the equivalent decision moved into
        // `completeClass` (`class-lifecycle.ts`), which already held the lock
        // and now also compares its caller's `requireEndedBy` against the
        // fresh row's recomputed end time before completing.
        const fresh = await tx.class.findUnique({
          where: { id: cls.id },
          select: {
            status: true,
            date: true,
            startTime: true,
            autoCancelCheck: true,
            minStudents: true,
            classType: true,
            teacherId: true,
            teacher: { select: { defaultTimezone: true } },
          },
        });
        // Deleted, or no longer open — a concurrent cancel, completion or
        // teacher action got here first. Not an error; the same outcome by
        // a different route.
        if (!fresh || fresh.status !== 'open') return false;
        if (!inCancelWindow(fresh, fresh.teacher.defaultTimezone, currentTime)) return false;

        // Counted HERE, not from the sweep's outer `findMany` at the top of
        // this function. That read is a snapshot taken before this
        // transaction began, so a registration committing in between is
        // invisible to it — and cancelling a class that has just reached
        // its minimum tells every student it is off when it is not.
        const activeCount = await tx.registration.count({
          where: { classId: cls.id, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
        });
        if (activeCount >= fresh.minStudents) return false;

        // Redundant with the `fresh.status` check above, kept anyway: it
        // costs nothing inside a statement that has to run regardless, and
        // it is the guard that survives if someone later moves or drops the
        // re-read.
        const updated = await tx.class.updateMany({
          where: { id: cls.id, status: 'open' },
          data: { status: 'cancelled' },
        });
        if (updated.count === 0) return false;

        const registrations = await tx.registration.findMany({
          where: { classId: cls.id, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
          select: { studentId: true },
        });

        // #112. Read before the update below closes them — `updateMany`
        // returns a count, not rows, so the recipient list has to be taken
        // first. A student in this queue was told the class was full and has
        // been waiting for a seat; the class not happening at all is the one
        // outcome they most need to hear about, and until now this sweep never
        // told them. The manual-cancel route (`transition/route.ts:47-58`) is
        // the shape being copied.
        const waiting = await tx.waitlistEntry.findMany({
          where: { classId: cls.id, status: 'waiting' },
          select: { studentId: true },
        });
        // The read and the update are two statements but cannot interleave:
        // every writer of `WaitlistEntry` takes this class's row lock first,
        // and `lockClassRow` above is holding it. Without that, a `waiting`
        // row committing between them would be closed without being notified —
        // which is the bug this whole change is about, reintroduced two
        // statements apart. The guard is only a statement-count saving on the
        // common case of no queue; `gdpr.ts` issues the same update unguarded.
        if (waiting.length > 0) {
          await tx.waitlistEntry.updateMany({
            where: { classId: cls.id, status: 'waiting' },
            data: { status: 'removed' },
          });
        }

        // Bodies built from `fresh`, not `cls`. A notice that names the
        // pre-lock `classType` or `minStudents` tells the student about a
        // class that no longer exists in that shape — the same defect as
        // deciding from the snapshot, one step later and harder to see.
        //
        // One body for both audiences, like the manual-cancel route: a
        // waitlisted student never held a spot, but "this class is cancelled"
        // is true for both, and two bodies would be two things to keep in step.
        //
        // Type, date AND time, matching the archive path's withdrawal notice:
        // this audience has nothing else to place the class by. The class
        // survives as `cancelled` with its `relatedClassId` intact, but the
        // student's inbox cannot link it (only `open` classes link,
        // `notification-links.ts`) and their waitlist entry has just been
        // closed to `removed`, which drops it from `/bookings`. A queued
        // student with two weekly classes needs the time to tell them apart.
        const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map((r) => ({
          recipientType: 'student' as const,
          recipientId: r.studentId,
          type: 'class_cancelled' as const,
          title: 'Class cancelled',
          body: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} has been cancelled due to insufficient registrations.`,
          relatedClassId: cls.id,
        }));
        notifications.push({
          recipientType: 'teacher',
          recipientId: fresh.teacherId,
          type: 'class_cancelled',
          title: 'Class auto-cancelled',
          body: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} was cancelled — only ${activeCount} of ${fresh.minStudents} minimum students registered.`,
          relatedClassId: cls.id,
        });
        await createBulkNotifications(tx, notifications);
        return true;
      });

      if (didCancel) cancelled++;
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
      // Pre-filter from the snapshot, an OPTIMISATION ONLY — the authoritative
      // timing check now lives inside `completeClass`, under the row lock it
      // already takes. A stale pre-filter can only DELAY a completion to the
      // next 60-second tick, never cause a wrong one.
      const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
      const endTime = new Date(start.getTime() + cls.durationMinutes * 60 * 1000);

      if (currentTime >= endTime) {
        // `requireEndedBy` is what makes the decision the locked row's, not
        // this snapshot's. Without it this sweep completes a class
        // rescheduled after the read above — creating `Payment` rows for a
        // class that has not happened.
        const result = await completeClass(db, cls.id, { requireEndedBy: currentTime });
        if (result.ok) {
          completed++;
        } else if (result.reason === 'NOT_ENDED_YET') {
          // The race `requireEndedBy` exists to catch: this class was
          // rescheduled to a later time between the `findMany` snapshot
          // above and `completeClass`'s locked re-read. Not a failure — the
          // lock did its job and deferred to the next tick, which will
          // re-evaluate the class's now-current end time. `warn`, not
          // `error`, so this expected, self-resolving outcome does not page
          // anyone; every OTHER refusal reason still logs at `error` below.
          log.warn({ classId: cls.id, reason: result.error }, 'class completion rejected');
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
