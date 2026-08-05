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
      select: { status: true, maxStudents: true, teacherId: true },
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

    const activeCount = await tx.registration.count({
      where: { classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
    });
    if (activeCount >= cls.maxStudents) {
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
 * The convention is NOT universal in this module, and inferring one from
 * the writers that do follow it would hide a real gap: `addToWaitlist`,
 * `promoteNext` and `claimSpot` each open with the lock; `removeFromWaitlist`
 * writes `status` — and `position`, through `reorderWaitingEntries` — with
 * no lock at all, so `DELETE /api/waitlist/[id]` mutates the queue unlocked.
 * Named rather than glossed so the next person to touch the queue finds it.
 * It is filed as #174, and it is not this function's to fix: `removeFromWaitlist`
 * can only move an entry OUT of `waiting`, never into it, so nothing it
 * races can manufacture the standing request this withdraws.
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
  tx: PrismaTransactionClient,
  input: { teacherId: string; studentId: string },
): Promise<void> {
  // `FOR UPDATE OF c` — only the Class rows, the same thing `addToWaitlist`,
  // `promoteNext` and `claimSpot` lock (`removeFromWaitlist` locks nothing;
  // see this function's docblock). No `DISTINCT`: Postgres refuses it
  // alongside `FOR UPDATE`, so duplicates are collapsed below. Ordered, so
  // two concurrent unlinks take multiple classes in the same sequence.
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
