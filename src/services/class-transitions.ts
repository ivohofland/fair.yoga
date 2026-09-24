/**
 * Automated Class Transitions — Handles time-based class lifecycle changes.
 *
 * Three jobs run periodically:
 * 1. Auto-transition: open → in_progress when start time is reached
 * 2. Auto-cancel: cancel open classes below min_students at auto_cancel_check time
 * 3. Auto-complete: in_progress → completed when class duration has elapsed
 */

import type { AutoCancelCheck, PrismaClient } from '@prisma/client';
import { completeClass } from './class-lifecycle';
import { createBulkNotifications, type CreateNotificationInput } from './notifications';
import { classStartInstant } from '@/lib/timezone';
import { timeToHHmm } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';
import { log } from '@/lib/log';
import { lockClassRow } from '@/lib/db-locks';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { closeQueueOnStart } from './waitlist';
import { readInPages } from '@/lib/read-in-pages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANCEL_CHECK_HOURS: Record<string, number> = {
  HOURS_4: 4,
  HOURS_2: 2,
  HOURS_1: 1,
} satisfies Record<AutoCancelCheck, number>;

/** The check hours `inCancelWindow` uses for an `autoCancelCheck` the record
 * does not name. */
export const DEFAULT_CANCEL_CHECK_HOURS = 2;

/** The widest check window: the furthest ahead of `now` a start can be and
 * still be cancelled. */
export const MAX_CANCEL_CHECK_HOURS = Math.max(...Object.values(CANCEL_CHECK_HOURS));

const HOUR_MS = 60 * 60 * 1000;

/** The stored `date`s a class inside its check window at `now` can have, as
 * UTC-midnight bounds, both inclusive. Zone offsets span UTC−12..UTC+14, and a
 * stored `date` is the teacher's local day, so a start instant lies in
 * [date − 14 h, date + 36 h). */
export function cancelCandidateDates(now: Date): { from: Date; to: Date } {
  const utcMidnight = (t: number) => {
    const d = new Date(t);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  };
  return {
    // The first midnight strictly after now − 36 h: a start after `now`
    // cannot sit on a local date at or before that instant.
    from: utcMidnight(now.getTime() - 36 * HOUR_MS + 24 * HOUR_MS),
    to: utcMidnight(now.getTime() + (MAX_CANCEL_CHECK_HOURS + 14) * HOUR_MS),
  };
}

/** Whether `at` falls inside a class's auto-cancel window: past the check
 * time, before the start. Shared by the sweep's pre-filter and the decision
 * under the lock, for the same reason the status set they filter on is named
 * once (`@/lib/registration-status`) — two spellings of one window is how a
 * stale-snapshot bug comes back.
 *
 * Two arguments rather than one row since #327: the window is computed from
 * `date`/`startTime` on the `CalendarEntry` and `autoCancelCheck` on the
 * `Class`, and no single row carries all three. Keeping them separate is what
 * stops a caller passing a spread-together object that silently lost one. */
function inCancelWindow(
  entry: { date: Date; startTime: Date },
  cls: { autoCancelCheck: string },
  timezone: string,
  at: Date,
): boolean {
  const start = classStartInstant(entry, timezone);
  const checkHours = CANCEL_CHECK_HOURS[cls.autoCancelCheck] ?? DEFAULT_CANCEL_CHECK_HOURS;
  const checkTime = new Date(start.getTime() - checkHours * 60 * 60 * 1000);
  return at >= checkTime && at < start;
}

// ---------------------------------------------------------------------------
// Auto-transition: open → in_progress
// ---------------------------------------------------------------------------

/**
 * One page of `autoTransitionToInProgress`'s snapshot: open, live classes
 * stored on or before `dateCeiling`, after `afterId` in id order. Paged
 * because the `calendarEntry` relation load grows with the parent set — see
 * `docs/technical-architecture.md` ("Relation loads over platform-wide sets").
 */
function readStartCandidatePage(
  db: PrismaClient,
  dateCeiling: Date,
  afterId: string | undefined,
  take: number,
) {
  // `cancelledAt: null` beside the status, not instead of it (#327). A
  // cancelled class keeps its `open` status now, so the status filter alone
  // selects exactly the classes this sweep must never start.
  return db.class.findMany({
    where: {
      status: 'open',
      calendarEntry: { cancelledAt: null, date: { lte: dateCeiling } },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    include: {
      calendarEntry: {
        select: { date: true, startTime: true, teacher: { select: { defaultTimezone: true } } },
      },
    },
  });
}

type StartCandidate = Awaited<ReturnType<typeof readStartCandidatePage>>[number];

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
  const openClasses = await readInPages<StartCandidate>((after, take) =>
    readStartCandidatePage(db, dateCeiling, after?.id, take),
  );

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
      const start = classStartInstant(
        cls.calendarEntry,
        cls.calendarEntry.teacher.defaultTimezone,
      );
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
            calendarEntry: {
              select: {
                date: true,
                startTime: true,
                cancelledAt: true,
                teacher: { select: { defaultTimezone: true } },
              },
            },
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
        // Re-read under the lock like the status beside it, and for the same
        // reason: a cancellation committing between the snapshot and this lock
        // is now invisible to `status`.
        if (fresh.calendarEntry.cancelledAt !== null) {
          log.debug({ classId: cls.id }, 'start sweep: cancelled before the lock');
          return false;
        }

        // Recomputed from `fresh`, not re-tested against the snapshot's
        // `start`. Re-testing the old instant is the defect wearing a lock.
        const freshStart = classStartInstant(
          fresh.calendarEntry,
          fresh.calendarEntry.teacher.defaultTimezone,
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
          where: { id: cls.id, status: 'open', calendarEntry: { cancelledAt: null } },
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
 * One page of `autoCancelClasses`'s snapshot: open, live classes stored on a
 * date in `[from, to]`, after `afterId` in id order, each with its count of
 * active registrations.
 *
 * Windowed by `cancelCandidateDates` because only a class starting within
 * `MAX_CANCEL_CHECK_HOURS` can be cancelled, and paged because the
 * `calendarEntry` relation load grows with the parent set — see
 * `docs/technical-architecture.md` ("Relation loads over platform-wide sets").
 */
async function readCancelCandidatePage(
  db: PrismaClient,
  from: Date,
  to: Date,
  afterId: string | undefined,
  take: number,
) {
  // `cancelledAt: null` beside the status (#327): a cancelled class keeps its
  // `open` status, so without it this sweep would re-cancel — and re-notify —
  // classes a teacher has already called off.
  const page = await db.class.findMany({
    where: {
      status: 'open',
      calendarEntry: { cancelledAt: null, date: { gte: from, lte: to } },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    include: {
      calendarEntry: {
        select: { date: true, startTime: true, teacher: { select: { defaultTimezone: true } } },
      },
    },
  });
  // A per-page `groupBy` over the page's ids, and it feeds a PRE-FILTER and
  // nothing else — see the `continue` in `autoCancelClasses`. A count rather
  // than loaded registration rows: the recipient list is read inside the
  // transaction under the lock, and having no `studentId`s here at all is what
  // stops a future reader rebuilding it from the snapshot without noticing.
  //
  // The status filter is load-bearing, not tidiness. An UNfiltered count would
  // be wrong rather than merely coarse: a class whose registrations are all
  // cancelled would count above its minimum and never be swept again. The
  // filter is `ACTIVE_REGISTRATION_STATUSES`, the constant the authoritative
  // count under the lock also uses. The two must answer the same question, or
  // the pre-filter skips classes the locked check would have cancelled.
  const counts =
    page.length === 0
      ? []
      : await db.registration.groupBy({
          by: ['classId'],
          where: {
            classId: { in: page.map((c) => c.id) },
            status: { in: [...ACTIVE_REGISTRATION_STATUSES] },
          },
          _count: { _all: true },
        });
  const active = new Map(counts.map((c) => [c.classId, c._count._all]));
  return page.map((c) => ({ ...c, activeRegistrations: active.get(c.id) ?? 0 }));
}

type CancelCandidate = Awaited<ReturnType<typeof readCancelCandidatePage>>[number];

/**
 * Finds open classes within their auto-cancel check window and cancels
 * them if registered students are below min_students.
 * Creates notifications for affected students.
 *
 * Each class gets its own `db.$transaction`, so each also gets its own
 * `lockClassRow` wait and its own Prisma-default transaction budget — not a
 * budget shared across the sweep. This differs from `deleteStudentAccount`
 * (`gdpr.ts`), which takes every `Class` lock it needs inside ONE
 * transaction — one ordered statement through `lockClassRowsOrdered` rather
 * than a loop (#216/#182 made it one statement, #237 moved it into the shared
 * helper), under a flat `{ timeout: 20_000 }` rather than a budget sized from
 * a count (#240 removed the sizing term). An earlier version of this sentence
 * described both the loop and the sizing, and outlived both. The contrast is
 * what survives them and is the reason for this paragraph: `lock_timeout` is
 * armed per lock ACQUISITION, so that single statement's waits still
 * accumulate across N contended rows inside one budget. Nothing here
 * accumulates that way, so a slow lock wait on one class costs only that
 * class's own transaction, not the ones before or after it in this loop.
 */
export async function autoCancelClasses(
  db: PrismaClient,
  now?: Date,
): Promise<number> {
  const currentTime = now ?? new Date();

  const { from, to } = cancelCandidateDates(currentTime);
  const openClasses = await readInPages<CancelCandidate>((after, take) =>
    readCancelCandidatePage(db, from, to, after?.id, take),
  );

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
      if (cls.activeRegistrations >= cls.minStudents) continue;
      if (
        !inCancelWindow(
          cls.calendarEntry,
          cls,
          cls.calendarEntry.teacher.defaultTimezone,
          currentTime,
        )
      ) {
        continue;
      }

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
        // `claimSpot`), each via `lockClassRow` — the same helper this
        // transaction takes it through below. So this serializes
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
        // `updateMany` WHERE (`registrations/[id]/route.ts`) scopes the SOURCE,
        // so it refuses every move INTO the counted set — both
        // `late_cancel -> attended` and `late_cancel -> no_show`, since
        // `no_show` is in the set as well — while the class is still `open`,
        // which
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
        // this transaction, not just the two `FOR UPDATE`s inside the helper
        // (`Class` then its `CalendarEntry`, since #327). So
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
        // Stated that narrowly on purpose: which writers of `WaitlistEntry`
        // take which lock is `docs/lock-order.md`'s to say. A rule about every
        // writer, written here, is one this comment cannot keep true, and the
        // next person adding a writer would check it and conclude they are
        // safe.
        //
        // To re-derive the real roster:
        // `grep -rnE 'waitlistEntry\.(create|update|delete|upsert)' src`,
        // excluding tests, then read each hit's enclosing transaction for how
        // it takes the class row lock, if it does: `lockClassRow` or
        // `lockClassRowsOrdered`, an inline `SELECT ... FOR UPDATE`, or a CAS
        // `UPDATE` on the class row.
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
            autoCancelCheck: true,
            minStudents: true,
            calendarEntry: {
              select: {
                id: true,
                teacherId: true,
                classType: true,
                date: true,
                startTime: true,
                cancelledAt: true,
                teacher: { select: { defaultTimezone: true } },
              },
            },
          },
        });
        // Deleted, no longer open, or already cancelled — a concurrent cancel,
        // completion or teacher action got here first. Not an error; the same
        // outcome by a different route. The cancellation half is read from the
        // entry since #327; `status` cannot answer it.
        if (!fresh || fresh.status !== 'open') return false;
        if (fresh.calendarEntry.cancelledAt !== null) return false;
        if (
          !inCancelWindow(
            fresh.calendarEntry,
            fresh,
            fresh.calendarEntry.teacher.defaultTimezone,
            currentTime,
          )
        ) {
          return false;
        }

        // Counted HERE, not from the sweep's outer `findMany` at the top of
        // this function. That read is a snapshot taken before this
        // transaction began, so a registration committing in between is
        // invisible to it — and cancelling a class that has just reached
        // its minimum tells every student it is off when it is not.
        const activeCount = await tx.registration.count({
          where: { classId: cls.id, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
        });
        if (activeCount >= fresh.minStudents) return false;

        // Cancellation writes the ENTRY now (#327), not a status — one
        // spelling for both families. The class-side conjunct is carried
        // through the relation so the CAS still says what it used to: cancel
        // this class only while it is still open. Redundant with the two
        // checks above, kept anyway for the same reason it always was — it
        // costs nothing inside a statement that has to run regardless, and it
        // is the guard that survives if someone later moves or drops the
        // re-read.
        const updated = await tx.calendarEntry.updateMany({
          where: {
            id: fresh.calendarEntry.id,
            cancelledAt: null,
            classes: { some: { status: 'open' } },
          },
          data: { cancelledAt: new Date() },
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
        // told them. The manual-cancel route
        // (`api/classes/[id]/cancel/route.ts`, its own door since #327) is the
        // shape being copied.
        const waiting = await tx.waitlistEntry.findMany({
          where: { classId: cls.id, status: 'waiting' },
          select: { studentId: true },
        });
        // The read and the update are two statements, and `lockClassRow` above
        // holds this class's row across both, so a `WaitlistEntry` writer that
        // takes this class's lock cannot interleave with them. Which writers
        // do is `docs/lock-order.md`'s to say ("Known conformance"). A
        // `waiting` row committing between the two would be closed without
        // being notified — which is the bug this whole change is about,
        // reintroduced two statements apart. The guard is only a
        // statement-count saving on the common case of no queue: the update
        // would be correct without it, matching nothing.
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
          body: `${fresh.calendarEntry.classType} class on ${formatDayHeader(fresh.calendarEntry.date)} at ${timeToHHmm(fresh.calendarEntry.startTime)} has been cancelled due to insufficient registrations.`,
          relatedClassId: cls.id,
        }));
        notifications.push({
          recipientType: 'teacher',
          recipientId: fresh.calendarEntry.teacherId,
          type: 'class_cancelled',
          title: 'Class auto-cancelled',
          body: `${fresh.calendarEntry.classType} class on ${formatDayHeader(fresh.calendarEntry.date)} at ${timeToHHmm(fresh.calendarEntry.startTime)} was cancelled — only ${activeCount} of ${fresh.minStudents} minimum students registered.`,
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
 * One page of `autoCompleteClasses`'s snapshot: in-progress, live classes
 * after `afterId` in id order. Paged because the `calendarEntry` relation
 * load grows with the parent set — see `docs/technical-architecture.md`
 * ("Relation loads over platform-wide sets").
 */
function readCompleteCandidatePage(db: PrismaClient, afterId: string | undefined, take: number) {
  // `cancelledAt: null` beside the status (#327). Completion runs the pricing
  // engine and writes `Payment` rows, so a cancelled class reaching this sweep
  // would bill students for a class that is off.
  return db.class.findMany({
    where: {
      status: 'in_progress',
      calendarEntry: { cancelledAt: null },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    include: {
      calendarEntry: {
        select: {
          date: true,
          startTime: true,
          durationMinutes: true,
          teacher: { select: { defaultTimezone: true } },
        },
      },
    },
  });
}

type CompleteCandidate = Awaited<ReturnType<typeof readCompleteCandidatePage>>[number];

/**
 * Finds in_progress classes whose duration has elapsed and completes them.
 * Triggers pricing calculation and payment creation via completeClass().
 */
export async function autoCompleteClasses(
  db: PrismaClient,
  now?: Date,
): Promise<number> {
  const currentTime = now ?? new Date();

  const inProgressClasses = await readInPages<CompleteCandidate>((after, take) =>
    readCompleteCandidatePage(db, after?.id, take),
  );

  let completed = 0;

  for (const cls of inProgressClasses) {
    // Per-class isolation — see autoTransitionToInProgress. Completion also
    // runs the pricing engine, which has more ways to fail per class.
    try {
      // Pre-filter from the snapshot, an OPTIMISATION ONLY — the authoritative
      // timing check now lives inside `completeClass`, under the row lock it
      // already takes. A stale pre-filter can only DELAY a completion to the
      // next 60-second tick, never cause a wrong one.
      const entry = cls.calendarEntry;
      const start = classStartInstant(entry, entry.teacher.defaultTimezone);
      const endTime = new Date(start.getTime() + entry.durationMinutes * 60 * 1000);

      if (currentTime >= endTime) {
        // `requireEndedBy` is what makes the decision the locked row's, not
        // this snapshot's. Without it this sweep completes a class
        // rescheduled after the read above — creating `Payment` rows for a
        // class that has not happened.
        const result = await completeClass(db, cls.id, { requireEndedBy: currentTime });
        if (result.ok) {
          completed++;
        } else if (result.reason === 'NOT_ENDED_YET' || result.reason === 'CANCELLED') {
          // The race `requireEndedBy` exists to catch: this class was
          // rescheduled to a later time between the snapshot read above and
          // `completeClass`'s locked re-read. Not a failure — the
          // lock did its job and deferred to the next tick, which will
          // re-evaluate the class's now-current end time. `warn`, not
          // `error`, so this expected, self-resolving outcome does not page
          // anyone; every OTHER refusal reason still logs at `error` below.
          //
          // `CANCELLED` shares this branch and shares the reason. The
          // snapshot read already excludes cancelled classes, so reaching
          // this means one was cancelled in the same gap — the lock refusing
          // to bill for it, which is the guard working rather than failing.
          // It is also the terminal one of the two: the next tick will not
          // see the class at all.
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
