import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateStudentSchema, archiveStateQuerySchema } from '@/lib/schemas';
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) return respondError('Student not found', 404);

  // Own student profile — return full data
  if (session.studentId === id) {
    return respondOk(student);
  }

  // Teacher accessing student profile — must be linked to the student,
  // then filtered by that student's per-teacher privacy settings.
  // Without the link check any teacher with a UUID could read names and
  // income tiers of students they have no relationship with.
  if (session.teacherId) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.teacherId, studentId: id } },
    });
    if (!link) return respondError('Student not in your contacts', 403);

    const visible = await prisma.student.findUnique({
      where: { id },
      select: studentVisibilitySelect(session.teacherId),
    });
    if (!visible) return respondError('Student not found', 404);

    return respondOk(projectStudentForTeacher(visible));
  }

  return respondError('Access denied', 403);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  // Own student profile is self-editable
  if (session.studentId === id) {

    const parsed = await parseBody(request, updateStudentSchema);
    if ('error' in parsed) return parsed.error;
    const updateData = parsed.data;

    if (Object.keys(updateData).length === 0) {
      return respondError('No valid fields to update', 400);
    }

    const student = await prisma.student.update({
      where: { id },
      data: {
        ...updateData,
        // A tier set by the student themself is a choice — the marker the
        // booking flow reads to decide picker vs summary. Teacher edits
        // never reach this branch.
        ...(updateData.incomeTier !== undefined ? { tierSelectedAt: new Date() } : {}),
      },
    });

    return respondOk(student);
  }

  return respondError('Access denied', 403);
});

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (!session.teacherId) {
    return respondError('Access denied', 403);
  }

  const parsed = archiveStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of archived or unarchived is required', 400);
  }
  const archiving = parsed.data.state === 'archived';

  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: session.teacherId, studentId: id } },
  });
  if (!link) return respondError('Student not in your contacts', 403);

  // Already there: no write. The point of #98 — a retry after a lost response
  // must not undo what the first attempt did.
  if (link.isArchived === archiving) {
    return respondOk({ isArchived: link.isArchived, action: 'unchanged' });
  }

  const updated = await prisma.teacherStudent.update({
    where: { id: link.id },
    data: { isArchived: archiving },
  });

  return respondOk({
    isArchived: updated.isArchived,
    action: archiving ? 'archived' : 'unarchived',
  });
});
