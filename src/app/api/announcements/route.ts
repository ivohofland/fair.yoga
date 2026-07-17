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
    if (cls.teacherId !== session.userId) return respondError('Not your class', 403);

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
        class: { teacherId: session.userId },
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
      teacherId: session.userId,
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

  const count = await createBulkNotifications(prisma, notificationInputs);

  // Create Announcement record
  const announcement = await prisma.announcement.create({
    data: {
      teacherId: session.userId,
      classId: body.classId ?? null,
      message: body.message,
      recipientCount: count,
    },
  });

  return respondOk(announcement, 201);
});
