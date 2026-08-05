import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const cls = await prisma.class.findUnique({ where: { id } });
  if (!cls) return respondError('Class not found', 404);
  if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

  const registrations = await prisma.registration.findMany({
    where: { classId: id },
    select: {
      id: true,
      classId: true,
      studentId: true,
      status: true,
      isWalkIn: true,
      registeredAt: true,
      cancelledAt: true,
      updatedAt: true,
      student: { select: studentVisibilitySelect(session.teacherId) },
    },
    orderBy: { registeredAt: 'asc' },
  });

  return respondOk(
    registrations.map((r) => ({ ...r, student: projectStudentForTeacher(r.student) })),
  );
});
