import { NextRequest } from 'next/server';
import type { Announcement } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  respondTyped,
  respondUnchanged,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import type { AnnouncementSendResponse } from '@/lib/api-types';
import { log } from '@/lib/log';
import { type CreateNotificationInput } from '@/services/notifications';
import { createAnnouncementSchema } from '@/lib/schemas';
import { listAnnouncementAudience, sendAnnouncement } from '@/services/announcements';
import { NO_RECIPIENTS_MESSAGE } from './shared';

type CreatedResponse = Omit<Announcement, 'audienceStudentIds'> & AnnouncementSendResponse;

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

    // Every non-cancelled registration for this class whose student is not
    // erased (`docs/data-model.md`, Announcement).
    const registrations = await prisma.registration.findMany({
      where: { classId: body.classId, status: { not: 'cancelled' }, student: { deletedAt: null } },
      select: { studentId: true },
    });

    studentIds = registrations.map((r) => r.studentId);
  } else if (body.studentIds) {
    // Gate 4: the client names students, so each must be proven to be in this
    // teacher's audience. An id outside it — another teacher's student, an
    // archived one, a stale picker row, a made-up uuid — is dropped without
    // saying which, so the answer is no oracle on who exists or is linked
    // elsewhere. The log line carries counts for the same reason.
    const audience = new Set(await listAnnouncementAudience(prisma, session.teacherId));
    const requested = [...new Set(body.studentIds)];
    studentIds = requested.filter((id) => audience.has(id));
    if (studentIds.length < requested.length) {
      log.info(
        { teacherId: session.teacherId, requested: requested.length, accepted: studentIds.length },
        'announcement: custom audience ids outside the audience dropped',
      );
    }
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
    return respondError(
      body.studentIds ? NO_RECIPIENTS_MESSAGE.chosen : NO_RECIPIENTS_MESSAGE.audience,
      400,
    );
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
  // already been told this message inside the window. A created announcement
  // answers with its own row, minus the ids of everyone it told, plus that
  // count. A suppressed one is a request whose goal already holds, so it
  // answers `respondUnchanged` with only what is true of THIS request —
  // `recipientCount` is `alreadyNotified` and nothing of the stored row —
  // because the latest row in the window may belong to another send (another
  // class, another list), and its id, class, time and count would describe
  // that one.
  if (deduped) {
    return respondUnchanged<AnnouncementSendResponse>({
      recipientCount: alreadyNotified,
      duplicateSuppressed: true,
      alreadyNotified,
    });
  }
  return respondTyped<CreatedResponse>(
    {
      id: announcement.id,
      teacherId: announcement.teacherId,
      classId: announcement.classId,
      message: announcement.message,
      recipientCount: announcement.recipientCount,
      sentAt: announcement.sentAt,
      duplicateSuppressed: false,
      alreadyNotified,
    },
    201,
  );
});
