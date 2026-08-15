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
import { resolveInvitationOnLink } from './link-consent';
import { lockClassRow, type TransactionClientOnly } from '@/lib/db-locks';
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import { readSeatCount } from './capacity';
// pino, and server-only. Safe here and checked rather than assumed: no
// `'use client'` component imports this module — the eleven importers are
// route handlers, services, tests and two server components.
import { log } from '@/lib/log';

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

/**
 * Creates or reactivates a registration row. Both Registration and
 * WaitlistEntry are unique per (classId, studentId), and cancelled rows are
 * kept — plain `create` locks a student out of a class forever after one
 * cancellation. Reactivation resets the row instead.
 *
 * Also clears `Class.spotBroadcastAt`, and this is the only place that does
 * (#220). Filling a seat is what makes a standing first-come-first-claimed
 * broadcast stale — not time passing — so the clear belongs on the fill, and
 * this function is where every fill in the app converges: direct booking
 * (`POST /api/registrations`), `promoteNext` and `claimSpot`. All three hold
 * this class row's `FOR UPDATE` lock before they call, which is what
 * serializes the clear against `handleSpotFreed`'s set; a future booking path
 * inherits the clear for free, because reactivating a cancelled row is the
 * problem this function exists to solve and nothing else may do it.
 */
export async function activateRegistration(
  tx: PrismaTransactionClient,
  input: { classId: string; studentId: string; tierAtBooking: number; isWalkIn?: boolean },
) {
  // Unconditionally, not "only when this fill made the class full". The
  // precise version needs a seat count on every booking and can drift from
  // the thing it is counting; this one cannot. The cost is that with two
  // seats free in the claim window, each claim re-opens the gate and the
  // remaining waiters are told again — but a seat genuinely is still free
  // when that happens, so the second message is true and actionable, and the
  // live path already re-broadcasts on every freed seat with no gate at all.
  await tx.class.update({
    where: { id: input.classId },
    data: { spotBroadcastAt: null },
  });

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

/** The transaction client the helpers below take. Every call site passes one. */
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
 * Joining also creates the roster link — see the comment at that write for
 * why this function, and not the promotion, is where consent lives.
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
      select: { status: true, teacherId: true },
    });
    if (cls.status !== 'open') {
      throw new WaitlistJoinError(
        `Cannot join the waitlist for a class with status "${cls.status}"`,
        'class_not_open',
      );
    }

    const { isFull } = await readSeatCount(tx, classId);
    if (!isFull) {
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

    // #166: joining the waitlist IS the consenting act, and this is the line
    // that says so. It is student-initiated and aimed at one named teacher —
    // the same thing a direct booking is (`api/registrations/route.ts`) — so
    // it earns the roster link on the same terms. Without a link the student
    // is queued but unmanageable: absent from the CRM, and unable to create
    // the `StudentPrivacy` row that would mute this teacher.
    //
    // The link used to be written at the promotion instead. That handed the
    // TEACHER the moment it came into existence: cancel any unrelated
    // registration, `handleSpotFreed` promotes the head of this queue, and a
    // link appears — off a request the student made at some earlier time,
    // with nothing rechecking their intent in between. Here the instant is
    // the student's own.
    //
    // Placed BEFORE the three exits below, not after them, and that is the
    // point: `existingEntry.status === 'waiting'` returns early, so a write
    // sitting after it would be skipped on the one path where the student is
    // re-asserting a request that already stands. Both states that path can
    // be in need it — a `waiting` row written before this change never got a
    // link, and an unlink racing a join can leave a `waiting` row whose link
    // the unlink then deleted (see `withdrawWaitingEntriesForTeacher`'s
    // docblock for that race). The cost is one upsert on a no-op rejoin, and
    // it buys all three exits agreeing about whether a link exists.
    //
    // Order matters and is not a preference: the class lock is already held
    // (top of this transaction) and the `TeacherStudent` row is taken after
    // it, which is the same order `promoteNext`, `claimSpot` and
    // `unlinkTeacher` take them in. Reversing it here would deadlock against
    // any of the three.
    const student = await tx.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { email: true },
    });

    await tx.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId: cls.teacherId, studentId } },
      update: {},
      create: { teacherId: cls.teacherId, studentId },
    });

    // The student's own act at this instant, so it resolves whatever
    // invitation state stood between them and this teacher — a `declined`
    // one included, which is the escape hatch the whole decline design rests
    // on: permanent from the teacher's side, always reversible from the
    // student's. Booking is the other route back; this is the second.
    await resolveInvitationOnLink(tx, {
      teacherId: cls.teacherId,
      studentEmail: student.email,
    });

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
 * Scoped to `status: 'waiting'` — see the inline comment on the `updateMany`
 * below for why (#F3, whole-branch review of #216/#182). Then gets all
 * remaining 'waiting' entries ordered by position and reorders them
 * sequentially starting at 1.
 *
 * Wrapped in a transaction so removal and reordering are atomic.
 *
 * Two distinct refusals, because they are two distinct things to tell a person.
 *
 * `NOT_FOUND` — no entry for this `(classId, studentId)` at all. That is the
 * race `DELETE /api/waitlist/[id]` cannot pre-empt: it reads the entry before
 * calling this, and a concurrent `deleteStudentAccount` (`gdpr.ts`, which
 * deletes every `WaitlistEntry` the student holds) can land in the gap.
 * Answering it with a 404 is honest, and it replaced the bare 500 Prisma's
 * `P2025` used to fall through to (`classifyApiError` has no branch for it).
 *
 * `NOT_WAITING` — the entry is right there, and is no longer this student's to
 * leave: already `removed`/`promoted`/`claimed`, or `expired` because
 * `closeQueueOnStart` (#216) closed the queue since their page last rendered.
 * That last case is not exotic; it is the DESIGNED consequence of a class
 * starting while a `/bookings` tab is open. Folding it into `NOT_FOUND` told a
 * student "waitlist entry not found" about a row they can see on screen and
 * will see again in their own Article 15 export.
 *
 * The deletion race is NARROWER since #174, not wider: this function takes
 * the class row lock first, so a concurrent erasure either committed before
 * this transaction opened — the case handled above — or blocks behind the
 * lock until this one is done.
 *
 * No sentinel-error dance, and no `try`/`catch` either — unlike
 * `acceptInvitation`'s `NotPendingError` (`invitations.ts`), which throws
 * because a bare `return` inside that transaction would commit the writes
 * above it. Here `updateMany`'s returned count already IS that decision: zero
 * rows matched means nothing was written and nothing needs rolling back, so
 * `$transaction` just returns `false` and the caller translates it after the
 * fact — the same shape as every CAS in this codebase (`transitionClass`,
 * `autoCancelClasses`, `autoTransitionToInProgress`).
 */
export async function removeFromWaitlist(
  db: PrismaClient,
  classId: string,
  studentId: string,
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_WAITING' }> {
  return db.$transaction(async (tx) => {
    // The same row and `FOR UPDATE` mode `addToWaitlist`, `promoteNext`,
    // `claimSpot` and `withdrawWaitingEntriesForTeacher` take — though this
    // wait is bounded to 2s by `lockClassRow`'s `SET LOCAL lock_timeout`,
    // unlike those four inline sites' unbounded wait (#104; not this
    // branch's to fix). Without the lock at all, two renumberings of one
    // queue interleave, each having read a snapshot the other invalidated,
    // and nothing errors: there is no unique on `(classId, position)`, only
    // a plain index. `promoteNext` then picks its head by lowest position
    // and promotes the wrong student.
    //
    // `SET LOCAL` bounds every statement left in this transaction, not just
    // the `FOR UPDATE` above it — including the reorder loop's own
    // `UPDATE`s below (`lockClassRow`'s docblock). `deleteStudentAccount`
    // (`gdpr.ts`) takes the same bounded lock on the same queue too, since
    // #174 Task 5 — so a race between the two now waits, up to 2s, on
    // whichever of them got there first, rather than interleaving unlocked.
    // At 2s the loser gets a Postgres `lock_timeout`, which
    // `classifyApiError` now answers with a 503 and "please try again"
    // rather than the 500 it used to — not swallowed either way.
    await lockClassRow(tx, classId);

    // Scoped to `status: 'waiting'`, not a bare `update` on the
    // `(classId, studentId)` key. #F3: an unconditional write let a DELETE
    // sent from a stale `/bookings` render — the class has since started,
    // `closeQueueOnStart` (#216) already flipped this row to `expired` —
    // overwrite it to `removed`, turning "never got in" into "withdrew", the
    // wrong story #216 exists to prevent, one status over. `waiting` is the
    // one status this function's whole point is to leave from ("a student
    // must be able to leave a dead queue", spec §1.1) — that stays true, this
    // only refuses a no-op on a row some other writer already closed.
    const result = await tx.waitlistEntry.updateMany({
      where: { classId, studentId, status: 'waiting' },
      data: { status: 'removed' },
    });
    if (result.count === 0) {
      // Which of the two it was, decided INSIDE the lock so the answer cannot
      // race the thing it is describing. One indexed lookup on a unique key,
      // and only on a path where the write has already failed — effectively
      // free, and it is the difference between telling a student their entry
      // does not exist and telling them it is no longer theirs to leave.
      const existing = await tx.waitlistEntry.findUnique({
        where: { classId_studentId: { classId, studentId } },
        select: { id: true },
      });
      return existing
        ? ({ ok: false, reason: 'NOT_WAITING' } as const)
        : ({ ok: false, reason: 'NOT_FOUND' } as const);
    }

    // Reorder remaining 'waiting' entries
    await reorderWaitingEntries(tx, classId);
    return { ok: true } as const;
  });
}

/**
 * Promotes the head of the waitlist queue: creates a Registration, links it
 * to the waitlist entry, notifies the student, and reorders remaining
 * positions. Stale heads (a student who booked directly but whose `waiting`
 * row survives) are dropped and skipped rather than promoted.
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
  opts: { now?: Date } = {},
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

    const { isFull } = await readSeatCount(tx, classId);
    if (isFull) {
      throw new WaitlistPromotionError('Class is full', 'class_full');
    }

    // Find the queue head to promote. Entries can go stale — a student books
    // the class directly and their `waiting` row survives. A stale head must
    // be dropped, not promoted: promoting it would violate the unique
    // (classId, studentId) registration constraint and wedge the queue.
    let nextEntry: WaitlistEntry | null = null;
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

    if (!nextEntry) return null;

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

    // #166: a backstop, not the mechanism. The link is created where the
    // consent is given — `addToWaitlist` above — and nobody reaches this
    // function without having joined. This upsert repairs the cases that
    // join cannot reach: a `waiting` row written before that change, and one
    // written by hand (fixtures, a psql fix-up). One idempotent query, and
    // without it such a promotion registers a student the teacher's CRM
    // cannot see.
    await tx.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId: cls.teacherId, studentId: nextEntry.studentId } },
      update: {},
      create: { teacherId: cls.teacherId, studentId: nextEntry.studentId },
    });

    // No `resolveInvitationOnLink` here, deliberately. A promotion fires at
    // a moment the TEACHER chooses — cancel any registration →
    // `handleSpotFreed` → here — off a request the student made earlier,
    // with nothing rechecking their intent in between. Whatever invitation
    // stood between these two was resolved by the join; anything that
    // appeared after it is a decision this function has no standing to make,
    // and making it here is what let a teacher time the acceptance of a row
    // the student had not answered.

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

    const { isFull } = await readSeatCount(tx, classId);
    if (isFull) {
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

    // #166: the same backstop as `promoteNext` above, for the same reason —
    // and silent about invitations for a simpler one: a claim can only come
    // from someone already holding a `waiting` entry, and the join that
    // created it is what created the link and resolved the invitation.
    // There is nothing left here to resolve.
    await tx.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId: cls.teacherId, studentId } },
      update: {},
      create: { teacherId: cls.teacherId, studentId },
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
 * - final hour before the deadline: **check capacity under the class row
 *   lock**, then broadcast to all waiting students (first to claim gets the
 *   spot). A class refilled between the cancel and this call is announced to
 *   nobody — `{ action: 'none' }` — which is #212; see the comment at that
 *   branch for why the lock is what makes the check mean anything.
 * - after the deadline: frozen — nothing happens
 *
 * Three callers. The two LIVE ones (`DELETE /api/registrations/[id]`,
 * `deleteStudentAccount`) invoke this OUTSIDE any transaction and discard the
 * result, logging and swallowing anything it throws — which is what made a
 * dropped notification unrecoverable and is why the third exists.
 *
 * The third is `reconcileWaitlists` (`services/waitlist-reconciliation.ts`,
 * #220), the sweep that re-invokes this every minute for any open class holding
 * a free seat and a waiting queue. It is the one caller that READS the returned
 * `SpotFreedResult`, using it to tell an invocation that repaired something
 * from one that did not. Nothing about this function's signature or behaviour
 * changed for it; it is a caller, not a coupling.
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
  //
  // Under the class row lock, and counting before it speaks (#212). Both
  // siblings that hand out a seat check capacity — `promoteNext` and
  // `claimSpot` above — and this branch did not, so a class refilled between
  // the cancel and this hook still told every waiting student a spot had
  // opened. `claimSpot`'s own check then rejected them: the notification was
  // wrong when it was written, not merely stale by the time it was read.
  //
  // The lock is what makes the count mean anything. Read outside it, this
  // would only move the race from "cancel-commit → findMany" to "count →
  // createMany" — and a race is the ONLY way to reach this state, since a
  // cancel frees the seat it announces. Every writer that CREATES a
  // registration takes this same row lock, so they serialise against this
  // transaction: one arriving after the count blocks until this commits.
  //
  // Three writers sit outside that. `autoCancelClasses`'s own comment in
  // `class-transitions.ts` names two beside its own count-under-lock —
  // `PUT /api/registrations/[id]` (attendance) and `DELETE
  // /api/registrations/[id]` (cancel) — and its enumeration is short by one:
  // `deleteStudentAccount` (`gdpr.ts`) cancels registrations in every
  // draft/open class of the erased student while locking only the classes
  // they were WAITING in, so a class they were registered in but not queued
  // in is written unlocked too.
  //
  // Only attendance could ever move a row INTO the counted set (`late_cancel
  // → attended`); the other two only move rows out, which makes the count too
  // high and this branch too quiet — the safe direction.
  //
  // That one move is closed STRUCTURALLY, not by timing:
  // `PUT /api/registrations/[id]` scopes its write so `late_cancel → attended`
  // is refused while the class is `open`, and this branch only ever runs on an
  // `open` class. Once a class starts the move is allowed, and by then this
  // branch cannot run at all.
  //
  // Deliberately NOT argued from the clock. An earlier version reasoned that
  // the two "never met in practice" because this branch runs at least 6 h
  // before the start (minimum `DEADLINE_HOURS`) while attendance is written at
  // class time. That spacer is a property of today's window boundaries, not of
  // this code — #236 proposes broadcasting freed spots right up to class start,
  // which would erase it. The structural argument above survives that change;
  // the timing one would not.
  //
  // `lockClassRow`, not the inline `FOR UPDATE` the three functions above
  // use: those are pre-existing unbounded waits that `db-locks.ts` reserves
  // for #104. This site is new, so it takes the bounded 2s wait from the
  // start. The cost is that a class row held longer than that drops the
  // broadcast entirely — both callers log and swallow. That is the
  // conservative outcome: a writer holding this row that long is probably
  // filling the seat.
  const outcome = await db.$transaction(async (tx) => {
    await lockClassRow(tx, classId);

    const seats = await readSeatCount(tx, classId);
    if (seats.isFull) {
      const waiting = await tx.waitlistEntry.count({ where: { classId, status: 'waiting' } });
      return { kind: 'suppressed' as const, seats, waiting };
    }

    const waiting = await tx.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
    });
    // Not a guard — an equivalent mutant, and worth saying so rather than
    // letting a later reader mutation-test it and find nothing. `createMany`
    // on an empty array is a no-op that emits nothing, so removing this line
    // changes no behaviour and no test. It is a saved round-trip.
    if (waiting.length === 0) return { kind: 'empty' as const };

    const notified = await createBulkNotifications(
      tx,
      waiting.map((w) => ({
        recipientType: 'student' as const,
        recipientId: w.studentId,
        type: 'spot_available' as const,
        title: 'A spot opened up',
        body: `A spot opened in ${cls.classType}. The first to claim it gets it.`,
        relatedClassId: classId,
      })),
    );
    // The broadcast now stands for the seat that is currently free, and this
    // is what says so (#220). Written inside the same transaction and under
    // the same class row lock as the notifications, so the flag and the rows
    // it describes commit together — a broadcast that rolls back leaves no
    // flag claiming it happened. `activateRegistration` clears it again the
    // moment anyone fills a seat.
    await tx.class.update({
      where: { id: classId },
      data: { spotBroadcastAt: now ?? new Date() },
    });
    // `notified` is `createMany`'s own count, not `waiting.length`. The two
    // cannot differ today (no `skipDuplicates`, so the insert is all-or-throw)
    // — but the return value exists to be checked, and reporting the size of
    // the input would start lying silently the day anyone adds it.
    return { kind: 'sent' as const, notified };
  });

  if (outcome.kind === 'suppressed') {
    // `debug`, not `warn` and not nothing. A `warn` would ask an operator to
    // act on an outcome where the cancel and the refill both did the right
    // thing — the auto-promote branch above swallows the identical event
    // silently for that reason. But silence has a cost this branch cannot
    // pay: neither caller reads the return value, so with no line here the
    // guard FIRING is indistinguishable from its never having been reached,
    // including for a guard broken to reject every class. `debug` is off by
    // default (`LOG_LEVEL`, `lib/log.ts`), so it costs nothing in production
    // and is the difference between answering "did this fire last Tuesday?"
    // and not being able to.
    log.debug(
      {
        classId,
        activeCount: outcome.seats.activeCount,
        maxStudents: outcome.seats.maxStudents,
        waiting: outcome.waiting,
      },
      'waitlist broadcast suppressed — class refilled before the spot-freed hook ran',
    );
  }

  return outcome.kind === 'sent'
    ? { action: 'broadcast', notified: outcome.notified }
    : { action: 'none' };
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
    ACTIVE_REGISTRATION_STATUSES.includes(registration.status)
  );
}

/**
 * Withdraws every `waiting` entry a student holds across one teacher's
 * classes, closing the gaps behind them. Called by `unlinkTeacher`
 * (services/invitations.ts) — a standing request aimed at a teacher the
 * student has just walked away from is a lever the teacher can pull to
 * reach back through (#166 Task 7 F3; the reasoning lives at that call site).
 *
 * It lives HERE rather than there because it must take the class row's
 * `FOR UPDATE` lock, and that convention belongs with the table it
 * protects. Without the lock, a `promoteNext` racing an unlink promotes the
 * student off the queue, and its `teacherStudent.upsert` re-creates the very
 * link the unlink is in the middle of deleting. (It no longer clears the
 * `TeacherBlock` too: since the link moved to the join, promotion resolves
 * no invitations at all. The link alone is enough to want this lock.)
 *
 * The convention now covers every renumbering writer *in this module*:
 * `addToWaitlist`, `promoteNext`, `claimSpot` and `removeFromWaitlist` each
 * open with the lock, and this function takes it too — for an additional
 * reason on top of the link race above, not the same one: two renumberings
 * of one queue interleaving with no unique on `(classId, position)` to catch
 * it. (`removeFromWaitlist` picked it up in #174, having gone without it for
 * a while — it can only move an entry OUT of `waiting`, never into it, so
 * nothing it raced could have manufactured the standing request this
 * withdraws; the gap was skew in the position numbering, not a wrong
 * promotion.) `POST /api/registrations` locks and renumbers the same way,
 * outside this module (`src/app/api/registrations/route.ts` — its own
 * `FOR UPDATE` on the `Class` row, and the `reorderWaitingEntries` call in
 * its waitlist-resolution step).
 * This paragraph claims nothing about renumbering writers beyond the ones
 * named here. `deleteStudentAccount` (`gdpr.ts`) was the last renumbering
 * writer that ran fully unlocked — closed in #174 Task 5 — so as of that
 * task nothing renumbers this queue unlocked any more; see
 * `src/lib/db-locks.ts` for the bounded-vs-unbounded split (#104) that
 * remains among the ones that do lock.
 *
 * A narrower, still-open gap: three writers flip `WaitlistEntry.status` out
 * of `waiting` — never touching `position`, so "renumbering writer" above
 * does not cover them — without calling `lockClassRow` themselves: the
 * cancel branch of `POST /api/classes/[id]/transition` (its
 * `waitlistEntry.updateMany` on `status: 'waiting'`, to `removed`),
 * `deleteTeacherAccount`'s own cancel loop (`gdpr.ts`, near its
 * `class.updateMany` CAS, also to `removed`), and `closeQueueOnStart` below
 * (to `expired` — see its own docblock for the detail). The first two take a
 * conflicting lock on the Class row themselves, via that CAS `UPDATE`;
 * `closeQueueOnStart` takes none of its own and instead trusts its caller to
 * have already taken one — `lockClassRow` from `autoTransitionToInProgress`
 * and `completeClass`, or the CAS `UPDATE` from `transitionClass`. Either
 * way, none of the three can race a `lockClassRow` holder into corrupting
 * anything. The first two still do not bound their own wait the way
 * `lockClassRow` does, and `deleteStudentAccount`'s `reorderWaitingEntries`
 * loop inherits `lockClassRow`'s 2s bound for every statement it runs, these
 * two mutators' rows included. Named here so the next reader of that
 * budget's arithmetic (`gdpr.ts`, the erasure transaction's `timeout`) does
 * not have to rediscover them.
 *
 * The lock is taken BY the statement that chooses the classes, so there is
 * no window between choosing them and holding them.
 *
 * The caller must call this before its own writes, and that is a
 * correctness requirement rather than a style note: a caller that deleted
 * the `TeacherStudent` row first would hold that row's lock while waiting
 * on a class lock `promoteNext` already had, while `promoteNext`'s own
 * `teacherStudent.upsert` waited on the row — a deadlock instead of a race.
 *
 * A student with no `waiting` entry for this teacher locks nothing, so an
 * unlink racing a waitlist JOIN of that same student's can leave the new
 * entry standing. Both of those are the student's own acts; the lever this
 * closes is the teacher's. That race is the one way a `waiting` entry can
 * outlive its link (the join creates one; an unlink that commits after the
 * join's withdrawal window deletes it), which is why `addToWaitlist` writes
 * the link on its no-op path too and `promoteNext` keeps its upsert.
 */
export async function withdrawWaitingEntriesForTeacher(
  tx: TransactionClientOnly,
  input: { teacherId: string; studentId: string },
): Promise<void> {
  // `FOR UPDATE OF c` — only the Class rows, the same thing `addToWaitlist`,
  // `promoteNext`, `claimSpot` and `removeFromWaitlist` lock. No `DISTINCT`:
  // Postgres refuses it alongside `FOR UPDATE`, so duplicates are collapsed
  // below. Ordered, so two concurrent unlinks take multiple classes in the
  // same sequence.
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id
    FROM "Class" c
    JOIN "WaitlistEntry" w ON w."classId" = c.id
    WHERE c."teacherId" = ${input.teacherId}
      AND w."studentId" = ${input.studentId}
      AND w.status = 'waiting'
    ORDER BY c.id
    FOR UPDATE OF c
  `;
  if (locked.length === 0) return;

  const classIds = [...new Set(locked.map((row) => row.id))];

  // 'removed', matching `removeFromWaitlist` above rather than inventing a
  // state. Re-selected through Prisma under the lock now held, so a
  // concurrent promotion that committed while this waited is seen: its
  // entry is no longer `waiting` and is left alone.
  await tx.waitlistEntry.updateMany({
    where: { studentId: input.studentId, classId: { in: classIds }, status: 'waiting' },
    data: { status: 'removed' },
  });

  for (const classId of classIds) {
    await reorderWaitingEntries(tx, classId);
  }
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

/**
 * Closes a class's queue because the class has STARTED, not because it was
 * cancelled or left.
 *
 * `expired`, and it is the only writer of that value in the codebase. The three
 * cancel paths write `removed`, matching `removeFromWaitlist` — a student who
 * left. This one means the opposite: a student who never got in. The
 * distinction is not decorative. `exportStudentData` (`gdpr.ts`) publishes
 * `WaitlistEntry.status` verbatim and, unlike the registrations half of the
 * same export, does NOT select the class's status — so `removed` here would
 * tell a subject-access request that the student withdrew, which is a
 * different and equally wrong story from the one the data supports.
 *
 * No reorder. `reorderWaitingEntries` renumbers only `waiting` rows, so closed
 * rows keep stale positions by design (#183); closing an entire queue at once
 * leaves nothing to renumber, which is why the two cancel paths issue their
 * `updateMany` without one either.
 *
 * No notification. #112's promise was about a class ceasing to be OFFERED. A
 * class that ran is not that, and "it happened without you" is noise to
 * someone who was never promised a seat.
 *
 * No read-before-write, unlike the cancel paths: they read first because they
 * need a recipient list, and this one has no recipients. The returned count is
 * the whole result.
 *
 * `TransactionClientOnly` rather than this module's `PrismaTransactionClient`
 * alias, deliberately: running this outside a transaction — where the status
 * flip and the queue close could commit separately — IS the defect, so the
 * type refuses a bare client rather than trusting the caller.
 *
 * The caller must have already taken the `Class` row lock, or written the
 * status via a CAS `UPDATE` that took it. Every other `WaitlistEntry` writer
 * conflicts on that row, so this statement cannot interleave with one.
 */
export async function closeQueueOnStart(
  tx: TransactionClientOnly,
  classId: string,
): Promise<number> {
  const { count } = await tx.waitlistEntry.updateMany({
    where: { classId, status: 'waiting' },
    data: { status: 'expired' },
  });
  return count;
}
