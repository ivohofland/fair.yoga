import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
} from '@/lib/api-utils';
import {
  createBulkNotifications,
  type CreateNotificationInput,
} from '@/services/notifications';

interface AnnouncementBody {
  classId?: string;
  message: string;
}

export async function POST(request: NextRequest) {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const body = await parseBody<AnnouncementBody>(request);
  if (!body?.message) return respondError('Missing message', 400);

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
}
