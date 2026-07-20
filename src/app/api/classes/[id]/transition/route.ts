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

      const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map((r) => ({
        recipientType: 'student' as const,
        recipientId: r.studentId,
        type: 'class_cancelled' as const,
        title: 'Class cancelled',
        body: `${cls.classType} has been cancelled by your teacher.`,
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
