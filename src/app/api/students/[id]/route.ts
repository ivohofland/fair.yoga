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
import { updateStudentSchema, createStudentSchema, archiveStateQuerySchema } from '@/lib/schemas';
import { checkStudentWriteLimit } from '@/lib/rate-limit';
import { log } from '@/lib/log';

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

  // Teachers can edit unclaimed students in their contacts
  if (session.teacherId) {
    // Shares one bucket with POST /api/students — see `checkStudentWriteLimit`.
    // This branch writes a client-supplied `email` to a `@unique` column with
    // no pre-check, so a 409 from the P2002 fallback answers "is this address
    // taken?" exactly as the POST's 200-vs-201 does. Metered at the very top so
    // the 403 and 404 refusals below cost a hit too: probing that never gets
    // past them still probes.
    const limit = checkStudentWriteLimit(session.teacherId);
    if (!limit.allowed) {
      log.warn(
        { studentId: id, teacherId: session.teacherId },
        'student write refused: rate limit exceeded',
      );
      const minutes = Math.ceil(limit.retryAfterSeconds / 60);
      return respondError(
        `Too many student requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        429,
      );
    }

    const student = await prisma.student.findUnique({
      where: { id },
      select: { id: true, claimedAt: true },
    });
    if (!student) return respondError('Student not found', 404);
    if (student.claimedAt) {
      return respondError('Cannot edit a student who has claimed their account', 403);
    }

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.teacherId, studentId: id } },
    });
    if (!link) return respondError('Student not in your contacts', 403);

    // No empty-body guard here, unlike the self-edit branch above:
    // `createStudentSchema` requires `firstName` and `email` and defaults
    // `lastName`, so a successful parse always yields three keys and a failing
    // one already returned 400 on the line above.
    const parsed = await parseBody(request, createStudentSchema);
    if ('error' in parsed) return parsed.error;
    const updateData = parsed.data;

    // #162: same treatment as POST /api/students. Lower stakes here — this
    // branch only fires for an unclaimed student already in the teacher's
    // contacts, and Student_claim_link_check makes accountId provably null on
    // that path — so what leaked was shape, not secrets. Narrowed anyway: the
    // raw row standing here is what tells the next reader the pattern is fine.
    const updated = await prisma.student.update({
      where: { id },
      data: updateData,
      select: { id: true },
    });

    return respondOk({ id: updated.id });
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

  // Narrowed for the same reason as the PUT above: this pre-check reads
  // `claimedAt` and nothing else, and the rest of the handler works off `id`.
  const student = await prisma.student.findUnique({
    where: { id },
    select: { id: true, claimedAt: true },
  });
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
