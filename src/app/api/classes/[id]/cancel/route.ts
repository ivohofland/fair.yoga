import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { formatDayHeader } from '@/lib/format';
import { createBulkNotifications, type CreateNotificationInput } from '@/services/notifications';
import { timeToHHmm } from '@/lib/time-of-day';
import { lockClassRow } from '@/lib/db-locks';

/**
 * The regular family's cancel door (#327).
 *
 * Cancellation stopped being a transition when `cancelled` left `ClassStatus`:
 * there is no target status to move to, and the wire format would be naming a
 * value the enum does not have. It is `CalendarEntry.cancelledAt` now, which
 * both families share — but each family keeps its OWN door, because their duty
 * of care genuinely differs. This one has to notify every registered student
 * and close the waitlist; a `StudioClass` has neither, and its existing PUT
 * already writes the same column.
 *
 * The block below is `POST …/transition`'s cancel branch, moved rather than
 * rewritten — the notification set, the queue close and the re-read under the
 * CAS are all #112's, and none of that reasoning changed.
 *
 * No body. The old endpoint took `{ status: 'cancelled' }`; the URL now says
 * the whole request, so there is nothing left to parse or validate.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { calendarEntry: { select: { id: true, teacherId: true } } },
  });
  if (!cls) return respondError('Class not found', 404);
  if (cls.calendarEntry.teacherId !== session.teacherId) {
    return respondError('Not your class', 403);
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // `Class` then `CalendarEntry`, the order every writer of this pair takes
    // (`db-locks.ts`). The old branch relied on its CAS `UPDATE` to take the
    // `Class` lock for free; the CAS now writes the ENTRY, so the free lock
    // would land on the wrong row — the same shape `updateClass` was rewritten
    // for. It also brings this path the 2s bound it never had:
    // `waitlist.ts`'s docblock recorded the transition route's cancel CAS as
    // the one unbounded `WaitlistEntry`-adjacent writer left.
    await lockClassRow(tx, id);

    // The CAS moved to the entry with the column. The class-side conjunct is
    // carried through the relation so it still asks what it always did:
    // cancel this class only while it is a draft or open.
    const updated = await tx.calendarEntry.updateMany({
      where: {
        id: cls.calendarEntry.id,
        cancelledAt: null,
        classes: { some: { status: { in: ['draft', 'open'] } } },
      },
      data: { cancelledAt: new Date() },
    });
    if (updated.count === 0) {
      // Re-read rather than naming `cls`, the handler's top-of-function
      // snapshot taken outside this transaction. Without this, cancelling a
      // class that was cancelled a moment earlier reports 409 `status "open"`
      // for a class that is already cancelled. Cheap here: the CAS already
      // failed, so there is nothing left to protect by not reading.
      const current = await tx.class.findUnique({
        where: { id },
        select: { status: true, calendarEntry: { select: { cancelledAt: true } } },
      });

      // GONE, not "still whatever the snapshot said". A failed CAS leaves the
      // row freely deletable in that window: archiving a recurring template
      // hard-deletes its future `draft`/`open` instances, the same status set
      // this CAS matches on.
      //
      // Falling back to `cls` here told the teacher "cannot cancel a class
      // with status open" about a class that no longer exists, which is the
      // very staleness the re-read above was added to remove.
      if (!current) return { ok: false as const, httpStatus: 404, error: 'Class not found' };

      // TWO refusals where there used to be one, because the CAS now has two
      // conjuncts a teacher can hit and they mean different things: already
      // cancelled (the double-click, and the common one), or past the point
      // where cancelling is the right verb at all.
      if (current.calendarEntry.cancelledAt !== null) {
        return {
          ok: false as const,
          httpStatus: 409 as const,
          error: 'This class is already cancelled.',
        };
      }
      return {
        ok: false as const,
        httpStatus: 409 as const,
        error: `Cannot cancel a class with status "${current.status}"`,
      };
    }

    const registrations = await tx.registration.findMany({
      where: { classId: id, status: 'registered' },
      select: { studentId: true },
    });
    const waiting = await tx.waitlistEntry.findMany({
      where: { classId: id, status: 'waiting' },
      select: { studentId: true },
    });
    if (waiting.length > 0) {
      await tx.waitlistEntry.updateMany({
        where: { classId: id, status: 'waiting' },
        data: { status: 'removed' },
      });
    }

    // Named in full — type, day, time — like the three service paths #112
    // fixed. `relatedClassId` below is set and still does not help: this
    // transaction has just cancelled the class, and `studentNotificationHref`
    // (`lib/notification-links.ts`) links only an `open` class, deliberately,
    // so the inbox row is inert. A waitlisted recipient has even less — their
    // entry was closed to `removed` a few lines above, which drops the class
    // off `/bookings`.
    //
    // Re-read under the lock this transaction holds — not from `cls`, the
    // handler's top-of-function read, taken outside it. `date` and `startTime`
    // are NOT in `ECONOMIC_FIELDS` (`lib/class-fields.ts`), so `settingsLocked`
    // does not freeze them and a teacher can reschedule a booked open class at
    // any time. Reschedule while cancelling and the notice named the old day.
    // `autoCancelClasses` (`class-transitions.ts`) re-reads inside its own
    // transaction for exactly this reason.
    const fresh = await tx.calendarEntry.findUniqueOrThrow({
      where: { id: cls.calendarEntry.id },
      select: { classType: true, date: true, startTime: true },
    });
    const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map((r) => ({
      recipientType: 'student' as const,
      recipientId: r.studentId,
      type: 'class_cancelled' as const,
      title: 'Class cancelled',
      body: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${timeToHHmm(fresh.startTime)} has been cancelled by your teacher.`,
      relatedClassId: id,
    }));
    if (notifications.length > 0) {
      await createBulkNotifications(tx, notifications);
    }
    return { ok: true as const, cancelled: true };
  });

  // No code here, unlike the transition route's table — an asymmetry that is
  // deliberate rather than an oversight, and inherited with the block. That
  // table exists because three DISTINCT service reasons arrived as one
  // indistinguishable 409 and a client had to match English to tell them
  // apart. This route's two refusals differ in wording rather than in what a
  // client should do about them, so a code would describe nothing the status
  // does not.
  if (!outcome.ok) return respondError(outcome.error, outcome.httpStatus);
  return respondOk(outcome);
});
