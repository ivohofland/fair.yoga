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
import {
  createBulkNotifications,
  type CreateNotificationInput,
} from '@/services/notifications';
import { createAnnouncementSchema } from '@/lib/schemas';
import { ANNOUNCEMENT_DEDUPE_WINDOW_MS, lockAnnouncementSlot } from '@/lib/db-locks';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createAnnouncementSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  let studentIds: string[];

  if (body.classId) {
    // Verify teacher owns the class
    const cls = await prisma.class.findUnique({ where: { id: body.classId } });
    if (!cls) return respondError('Class not found', 404);
    if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

    // Get all non-cancelled registrations for this class
    const registrations = await prisma.registration.findMany({
      where: { classId: body.classId, status: { not: 'cancelled' } },
      select: { studentId: true },
    });

    studentIds = registrations.map((r) => r.studentId);
  } else {
    // Get ALL students who have any registration with this teacher
    const registrations = await prisma.registration.findMany({
      where: {
        class: { teacherId: session.teacherId },
        status: { not: 'cancelled' },
      },
      select: { studentId: true },
      distinct: ['studentId'],
    });

    studentIds = registrations.map((r) => r.studentId);
  }

  // Honor the per-teacher communication opt-out: students who set
  // receiveComms=false for this teacher get no announcements at all.
  const optOuts = await prisma.studentPrivacy.findMany({
    where: {
      teacherId: session.teacherId,
      studentId: { in: studentIds },
      receiveComms: false,
    },
    select: { studentId: true },
  });
  const optedOut = new Set(optOuts.map((o) => o.studentId));
  studentIds = studentIds.filter((id) => !optedOut.has(id));

  if (studentIds.length === 0) {
    return respondError('No students to notify', 400);
  }

  // Create notification for each student
  const notificationInputs: CreateNotificationInput[] = studentIds.map((studentId) => ({
    recipientType: 'student' as const,
    recipientId: studentId,
    type: 'announcement' as const,
    title: 'New announcement',
    body: body.message,
    relatedClassId: body.classId,
  }));

  const classId = body.classId ?? null;

  // Everything above is reads; from here down are the two writes a duplicate
  // costs, and until #196 nothing wrapped them in a transaction at all — the
  // fan-out ran first and the `Announcement` row second, so deduplicating the
  // insert would have suppressed the teacher's own sent-history record while
  // still notifying every student twice.
  const { announcement, deduped } = await prisma.$transaction(async (tx) => {
    // First statement in the transaction, so the compare below and both writes
    // after it are serialised against an identical concurrent send. Without
    // it, two racers each read an empty `findFirst` — neither has committed
    // anything the other can see — and both fan out.
    await lockAnnouncementSlot(tx, `${session.teacherId}|${classId ?? ''}|${body.message}`);

    const recent = await tx.announcement.findFirst({
      where: {
        teacherId: session.teacherId,
        // `classId ?? null` explicitly, never `body.classId`: `classId` is
        // nullable (the all-students case) and a Prisma `where` given
        // `undefined` OMITS the clause, so a pass-through would make an
        // all-students send match every announcement this teacher ever sent.
        classId,
        message: body.message,
        // `sentAt`, not `createdAt` — this model has no `createdAt`.
        sentAt: { gte: new Date(Date.now() - ANNOUNCEMENT_DEDUPE_WINDOW_MS) },
      },
      orderBy: { sentAt: 'desc' },
    });
    if (recent) return { announcement: recent, deduped: true };

    // Below the compare, because this is the write that reaches people: one
    // `Notification` per recipient. It emits on the SSE bus per input inside
    // the call, so a rollback here leaves bus events already emitted — that is
    // pre-existing shape, accepted in the spec, and the reason this
    // transaction is kept to two statements.
    const count = await createBulkNotifications(tx, notificationInputs);
    const created = await tx.announcement.create({
      data: {
        teacherId: session.teacherId,
        classId,
        message: body.message,
        recipientCount: count,
      },
    });
    return { announcement: created, deduped: false };
  });

  // 201 created, 200 suppressed — and `duplicateSuppressed` in the body,
  // because the status alone is not enough: `send-announcement.tsx` checks
  // only `res.ok`, so a client that ignored the flag would go on reporting a
  // send that did not happen. Suppressing the duplicate is right; hiding the
  // suppression would be a small lie told by a tool whose premise is being an
  // honest one.
  //
  // `recipientCount` on the suppressed branch is the FIRST send's, which is
  // the honest number — those students really did receive it.
  return respondOk({ ...announcement, duplicateSuppressed: deduped }, deduped ? 200 : 201);
});
