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
import { updateStudentSchema, createStudentSchema } from '@/lib/schemas';

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

    const privacy = await prisma.studentPrivacy.findUnique({
      where: {
        studentId_teacherId: {
          studentId: id,
          teacherId: session.teacherId,
        },
      },
    });

    // Unclaimed students (teacher-created) — no privacy restrictions
    const isUnclaimed = !student.claimedAt;

    const filtered: Record<string, unknown> = {
      id: student.id,
      firstName: student.firstName,
      lastName: (isUnclaimed || privacy?.shareFullName) ? student.lastName : (student.lastName.charAt(0) || ''),
      incomeTier: student.incomeTier,
      claimedAt: student.claimedAt,
      createdAt: student.createdAt,
      updatedAt: student.updatedAt,
    };

    if (isUnclaimed || privacy?.shareEmail) filtered.email = student.email;
    if (isUnclaimed || privacy?.sharePhone) filtered.phone = student.phone;
    if (isUnclaimed || privacy?.shareBirthday) filtered.birthday = student.birthday;
    if (isUnclaimed || privacy?.shareAddress) filtered.address = student.address;

    return respondOk(filtered);
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
      data: updateData,
    });

    return respondOk(student);
  }

  // Teachers can edit unclaimed students in their contacts
  if (session.teacherId) {
    const student = await prisma.student.findUnique({ where: { id } });
    if (!student) return respondError('Student not found', 404);
    if (student.claimedAt) {
      return respondError('Cannot edit a student who has claimed their account', 403);
    }

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.teacherId, studentId: id } },
    });
    if (!link) return respondError('Student not in your contacts', 403);

    const parsed = await parseBody(request, createStudentSchema);
    if ('error' in parsed) return parsed.error;
    const updateData = parsed.data;

    if (Object.keys(updateData).length === 0) {
      return respondError('No valid fields to update', 400);
    }

    const updated = await prisma.student.update({
      where: { id },
      data: updateData,
    });

    return respondOk(updated);
  }

  return respondError('Access denied', 403);
});

export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireSession(request);
  if (isErrorResponse(session)) return session;

  if (!session.teacherId) {
    return respondError('Access denied', 403);
  }

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student) return respondError('Student not found', 404);
  if (student.claimedAt) {
    return respondError('Cannot remove a student who has claimed their account', 403);
  }

  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: session.teacherId, studentId: id } },
  });
  if (!link) return respondError('Student not in your contacts', 403);

  // Delete the link
  await prisma.teacherStudent.delete({ where: { id: link.id } });

  // If no other teacher has this student linked, delete the student record
  const remainingLinks = await prisma.teacherStudent.count({
    where: { studentId: id },
  });
  if (remainingLinks === 0) {
    await prisma.student.delete({ where: { id } });
  }

  return respondOk({ removed: true });
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

  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId: session.teacherId, studentId: id } },
  });
  if (!link) return respondError('Student not in your contacts', 403);

  const updated = await prisma.teacherStudent.update({
    where: { id: link.id },
    data: { isArchived: !link.isArchived },
  });

  return respondOk({ isArchived: updated.isArchived });
});
