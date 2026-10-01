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
import { type CreateNotificationInput } from '@/services/notifications';
import { createAnnouncementSchema } from '@/lib/schemas';
import { listAnnouncementAudience, sendAnnouncement } from '@/services/announcements';

export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, createAnnouncementSchema);
  if ('error' in parsed) return parsed.error;
  const body = parsed.data;

  let studentIds: string[];

  if (body.classId) {
    // Verify teacher owns the class
    const cls = await prisma.class.findUnique({
      where: { id: body.classId },
      include: { calendarEntry: { select: { teacherId: true } } },
    });
    if (!cls) return respondError('Class not found', 404);
    if (cls.calendarEntry.teacherId !== session.teacherId) {
      return respondError('Not your class', 403);
    }

    // Get all non-cancelled registrations for this class
    const registrations = await prisma.registration.findMany({
      where: { classId: body.classId, status: { not: 'cancelled' } },
      select: { studentId: true },
    });

    studentIds = registrations.map((r) => r.studentId);
  } else if (body.studentIds) {
    // Gate 4: the client names students, so each must be proven to be in this
    // teacher's audience. An id outside it — another teacher's student, an
    // archived one, a stale picker row, a made-up uuid — is dropped without
    // saying which, so the answer is no oracle on who exists or is linked elsewhere.
    const audience = new Set(await listAnnouncementAudience(prisma, session.teacherId));
    studentIds = [...new Set(body.studentIds)].filter((id) => audience.has(id));
  } else {
    studentIds = await listAnnouncementAudience(prisma, session.teacherId);
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

  const { announcement, deduped, alreadyNotified } = await sendAnnouncement(prisma, {
    teacherId: session.teacherId,
    classId,
    message: body.message,
    recipients: notificationInputs,
  });

  // 201 created, 200 suppressed — and `duplicateSuppressed` in the body,
  // because the status alone is not enough: a client that checked only
  // `res.ok` would go on reporting a send that did not happen. Suppressing
  // the duplicate is right; hiding the suppression would be a small lie told
  // by a tool whose premise is being an honest one.
  //
  // `alreadyNotified` is how many of the students this request named had
  // already been told this message inside the window. `recipientCount` is the
  // number of students this request's own response is about: on a created
  // announcement, those it newly notified (the stored row's count); on a
  // suppressed one, `alreadyNotified` — the stored row is whichever send was
  // latest, which may never have named these students, so its count would
  // describe someone else's send.
  return respondOk(
    {
      ...announcement,
      recipientCount: deduped ? alreadyNotified : announcement.recipientCount,
      duplicateSuppressed: deduped,
      alreadyNotified,
    },
    deduped ? 200 : 201,
  );
});
