import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { transitionClass, type TransitionFailureReason } from '@/services/class-lifecycle';
import { transitionClassSchema } from '@/lib/schemas';
import { formatDayHeader } from '@/lib/format';
import { createBulkNotifications, type CreateNotificationInput } from '@/services/notifications';
import { timeToHHmm } from '@/lib/time-of-day';

/**
 * How each refusal reaches the client, as a table rather than a ternary.
 *
 * `NOT_FOUND` is a 404 and the rest are 409s, which is why this started life as
 * `result.reason === 'NOT_FOUND' ? 404 : 409` — before that, mapping every
 * refusal to 409 answered a deleted class with `409 "Class not found: <id>"`,
 * a status and a message that contradict each other.
 *
 * The CODE is the part the ternary could not carry, and #249 is what made its
 * absence cost something. Three of these reach the client as an indistinguishable
 * 409 while wanting three different client behaviours: `STARTS_IN_PAST` is
 * permanent and the page is right (nothing will make that draft publishable),
 * `ILLEGAL_TRANSITION` means the page is stale and should re-read,
 * `CONCURRENT_MODIFICATION` means the write lost a race and may simply be
 * retried. Telling them apart by matching English in the message is exactly
 * what `TransitionFailureReason` was introduced (#182) to stop —
 * `autoCompleteClasses` used to do it with `.endsWith('has not ended yet')`.
 *
 * `CLASS_STARTS_IN_PAST` deliberately matches the code `PUT /api/classes/[id]`
 * already answers with, rather than mirroring the internal name. The two doors
 * refuse the same condition, and a client that learns to handle one gets the
 * other for nothing.
 *
 * A `Record` over the full union, so this is exhaustive by construction: a new
 * `TransitionFailureReason` member fails the build here rather than falling
 * through to some default. `NOT_ENDED_YET` is listed and unreachable through
 * this route — `completeClass` is its only producer — which is the superset
 * looseness `TransitionFailureReason`'s own docblock records.
 */
const TRANSITION_FAILURE_RESPONSE: Record<
  TransitionFailureReason,
  { httpStatus: number; code: string }
> = {
  NOT_FOUND: { httpStatus: 404, code: 'NOT_FOUND' },
  ILLEGAL_TRANSITION: { httpStatus: 409, code: 'ILLEGAL_TRANSITION' },
  NOT_ENDED_YET: { httpStatus: 409, code: 'CLASS_NOT_ENDED_YET' },
  CONCURRENT_MODIFICATION: { httpStatus: 409, code: 'CONCURRENT_MODIFICATION' },
  STARTS_IN_PAST: { httpStatus: 409, code: 'CLASS_STARTS_IN_PAST' },
  ROOM_ARCHIVED: { httpStatus: 409, code: 'ROOM_ARCHIVED' },
};

export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

  const parsed = await parseBody(request, transitionClassSchema);
  if ('error' in parsed) return parsed.error;

  // Manual cancellation carries the same duty of care as auto-cancel:
  // registered students must hear about it, and the waitlist closes.
  if (parsed.data.status === 'cancelled') {
    const outcome = await prisma.$transaction(async (tx) => {
      const updated = await tx.class.updateMany({
        where: { id, status: { in: ['draft', 'open'] } },
        data: { status: 'cancelled' },
      });
      if (updated.count === 0) {
        // Re-read rather than naming `cls`, the handler's top-of-function
        // snapshot taken before `parseBody`'s await and outside this
        // transaction. Without this, cancelling a class that was cancelled a
        // moment earlier reports 409 `status "open"` for a class that is
        // already `cancelled`. Cheap here: the CAS already failed, so there is
        // nothing left to protect by not reading.
        const current = await tx.class.findUnique({ where: { id }, select: { status: true } });

        // GONE, not "still whatever the snapshot said". A failed CAS leaves the
        // row freely deletable in that window: archiving a recurring template
        // hard-deletes its future `draft`/`open` instances, the same status set
        // this CAS matches on.
        //
        // This used to add "the `UPDATE` matched nothing and so locked
        // nothing". Not true in one of the two interleavings, and #117
        // corrected the same sentence in the template family: a CAS that
        // blocked on a concurrently-updated row and only then lost its
        // re-check still holds the lock to commit, because Postgres takes it
        // before the EvalPlanQual re-check rather than after. The re-read
        // ABOVE is correct either way, which is why nothing here changes —
        // see `archiveOrUnarchiveTemplate`'s miss branch
        // (`class-template-lifecycle.ts`) for the full account.
        //
        // Falling back to `cls.status` here told the teacher "cannot cancel a
        // class with status open" about a class that no longer exists, which
        // is the very staleness the re-read above was added to remove. The
        // handler already answers this condition honestly sixty lines up.
        if (!current) return { ok: false as const, httpStatus: 404, error: 'Class not found' };

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
      // transaction has just moved the class to `cancelled`, and
      // `studentNotificationHref` (`lib/notification-links.ts`) links only an
      // `open` class, deliberately, so the inbox row is inert. A waitlisted
      // recipient has even less — their entry was closed to `removed` a few
      // lines above, which drops the class off `/bookings`.

      // Re-read under the CAS above, which is this transaction's serialization
      // point — not from `cls`, the handler's top-of-function read, which was
      // taken before `parseBody`'s await and outside this transaction.
      //
      // `date` and `startTime` are NOT in `ECONOMIC_FIELDS`
      // (`lib/class-fields.ts`), so `settingsLocked` does not freeze them and a
      // teacher can reschedule a booked open class at any time. Reschedule
      // while cancelling and the notice named the old day. `autoCancelClasses`
      // (`class-transitions.ts`) re-reads inside its own transaction for
      // exactly this reason and says so; this route now matches it.
      //
      // No new lock: the CAS already holds this row.
      const fresh = await tx.class.findUniqueOrThrow({
        where: { id },
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
      return { ok: true as const, newStatus: 'cancelled' as const };
    });

    // No code here, while the `transitionClass` path below carries one for
    // every reason — an asymmetry that is deliberate rather than an oversight.
    // The table below exists because three DISTINCT service reasons arrived as
    // one indistinguishable 409 and a client had to match English to tell them
    // apart. This branch has one refusal with one meaning, so a code would
    // describe nothing the status does not. Its message being written for a
    // developer (`Cannot cancel a class with status "cancelled"`) is a real
    // defect, but it is #197's — eighteen endpoints, one convention — and
    // fixing one of them here would prejudge that convention.
    if (!outcome.ok) return respondError(outcome.error, outcome.httpStatus);
    return respondOk(outcome);
  }

  const result = await transitionClass(prisma, id, parsed.data.status);
  if (!result.ok) {
    const { httpStatus, code } = TRANSITION_FAILURE_RESPONSE[result.reason];
    return respondError(result.error, httpStatus, code);
  }

  return respondOk(result);
});
