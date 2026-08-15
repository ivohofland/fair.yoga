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
import { transitionClass } from '@/services/class-lifecycle';
import { transitionClassSchema } from '@/lib/schemas';
import { formatDayHeader } from '@/lib/format';
import { createBulkNotifications, type CreateNotificationInput } from '@/services/notifications';

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
        // transaction (#F6, whole-branch review of #216/#182 — the same
        // staleness Task 7 fixed for the success path's notification body,
        // a few lines below). Without this, cancelling a class concurrently
        // cancelled a moment earlier reports 409 `status "open"` for a class
        // that is already `cancelled`. Cheap here: the CAS already failed, so
        // there is nothing left to protect by not reading — one more select
        // on a row this transaction is not writing to.
        const current = await tx.class.findUnique({ where: { id }, select: { status: true } });
        return {
          ok: false as const,
          error: `Cannot cancel a class with status "${current?.status ?? cls.status}"`,
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
        body: `${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} has been cancelled by your teacher.`,
        relatedClassId: id,
      }));
      if (notifications.length > 0) {
        await createBulkNotifications(tx, notifications);
      }
      return { ok: true as const, newStatus: 'cancelled' as const };
    });

    if (!outcome.ok) return respondError(outcome.error, 409);
    return respondOk(outcome);
  }

  const result = await transitionClass(prisma, id, parsed.data.status);
  if (!result.ok) return respondError(result.error, 409);

  return respondOk(result);
});
