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
import { sendAnnouncement } from '@/services/announcements';

export const POST = withErrorHandler(async (request: NextRequest) => {
  console.log("REQUEST ARRIVED AT", Date.now());
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
  } else {
    // Get ALL students who have any registration with this teacher
    const registrations = await prisma.registration.findMany({
      where: {
        class: { calendarEntry: { teacherId: session.teacherId } },
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

  const { announcement, deduped } = await sendAnnouncement(prisma, {
    teacherId: session.teacherId,
    classId,
    message: body.message,
    recipients: notificationInputs,
  });

  // 201 created, 200 suppressed — and `duplicateSuppressed` in the body,
  // because the status alone is not enough: a client that checked only
  // `res.ok` — which is what `send-announcement.tsx` did before #196, and what
  // any other caller may still do — would go on reporting a
  // send that did not happen. Suppressing the duplicate is right; hiding the
  // suppression would be a small lie told by a tool whose premise is being an
  // honest one.
  //
  // `recipientCount` on the suppressed branch belongs to the most recent
  // matching send inside the window (`orderBy: sentAt desc` above) — which the
  // dedupe makes the only one, but the ordering is what decides it. Either
  // way it is the honest number: those students really did receive it.
  return respondOk({ ...announcement, duplicateSuppressed: deduped }, deduped ? 200 : 201);
});
