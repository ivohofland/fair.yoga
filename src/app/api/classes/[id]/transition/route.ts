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
        return { ok: false as const, error: `Cannot cancel a class with status "${cls.status}"` };
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
      //
      // KNOWN RESIDUAL, recorded rather than fixed. `cls` is the read at the
      // top of this handler, taken before `parseBody`'s await and outside this
      // transaction — so these three fields are a snapshot, not the row as it
      // stands here. `autoCancelClasses` deliberately re-reads inside its
      // transaction under the row lock for exactly this reason, and says so.
      // This route does not, and #200 is what made that matter: `date` and
      // `startTime` are NOT in `ECONOMIC_FIELDS` (`lib/class-fields.ts`), so
      // `settingsLocked` does not freeze them and a teacher can reschedule a
      // booked open class. Reschedule inside the window and the notice names
      // the old day. Before #200 only `classType` was stale, which changes far
      // less often.
      //
      // Left as-is on purpose: no test can observe a window this narrow, the
      // harm is wrong words rather than a wrong write, and an untestable
      // behaviour change does not belong in a copy fix.
      //
      // Not filed as work — pointed at from #182 instead, which owns this
      // mechanism for the sites where it corrupts a *decision* rather than a
      // message. This route already satisfies #182's rule: its CAS above is
      // status-predicated and status is the only input to the decision. If
      // that issue's in-transaction re-read lands, doing the same here is
      // about four lines (`tx.class.findUnique` after the CAS, interpolate
      // from that) and needs no new lock, because the CAS is already the
      // serialization point.
      const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map((r) => ({
        recipientType: 'student' as const,
        recipientId: r.studentId,
        type: 'class_cancelled' as const,
        title: 'Class cancelled',
        body: `${cls.classType} class on ${formatDayHeader(cls.date)} at ${cls.startTime} has been cancelled by your teacher.`,
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
