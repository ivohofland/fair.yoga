import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  respondRefusal,
  respondUnchanged,
  requireSession,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { isRecordNotFound } from '@/lib/api-errors';
import {
  updateStudentSchema,
  archiveStateQuerySchema,
  archiveStudentBodySchema,
} from '@/lib/schemas';
import { archiveStudent } from '@/services/student-archive';
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
  //
  // The two checks answer different questions and neither replaces the other.
  // Without the link check, any teacher holding a UUID reads a stranger — and
  // a stranger has no `StudentPrivacy` row for this teacher, so the projection
  // returns the maximum-privacy view rather than nothing: a truncated name,
  // and the confirmation that this id is a student at all. That is the
  // disclosure the link check exists to prevent. Once linked, the projection
  // decides which of email, phone, birthday and address come back.
  //
  // Never income tiers: `incomeTier` is not in the teacher-facing shape
  // (#167), and `students-api.test.ts` pins that it stays out.
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

    return respondOk(projectStudentForTeacher(visible, session.teacherId));
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

    // Scoped to a live profile because an erasure can commit while this write
    // waits on the row, and an unscoped `WHERE` would then apply to the erased
    // version (`docs/lock-order.md`, "The `Student` row is the erasure's gate").
    const student = await prisma.student.update({
      where: { id, deletedAt: null },
      data: {
        ...updateData,
        // A tier set by the student themself is a choice — the marker the
        // booking flow reads to decide picker vs summary. Teacher edits
        // never reach this branch.
        ...(updateData.incomeTier !== undefined ? { tierSelectedAt: new Date() } : {}),
      },
    }).catch((err: unknown) => {
      if (isRecordNotFound(err)) return null;
      throw err;
    });
    if (!student) return respondError('Student not found', 404);

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
  const teacherId = session.teacherId;

  if (parsed.data.state === 'archived') {
    const body = await readArchiveBody(request);
    if (!body) return respondError('Invalid request body', 400);

    const outcome = await archiveStudent(prisma, {
      teacherId,
      studentId: id,
      waivePaymentIds: body.waivePaymentIds,
    });
    switch (outcome.kind) {
      case 'not-linked':
        return respondError('Student not in your contacts', 403);
      case 'unchanged':
        return respondUnchanged<{ isArchived: boolean }>({ isArchived: true });
      case 'refused':
        return respondRefusal(outcome.refusal);
      case 'archived':
        return respondOk({ isArchived: true, action: 'archived', waivedCount: outcome.waivedCount });
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled archive outcome: ${JSON.stringify(unhandled)}`);
      }
    }
  }

  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId: id } },
  });
  if (!link) return respondError('Student not in your contacts', 403);

  // Already there: no write. The point of #98 — a retry after a lost response
  // must not undo what the first attempt did.
  if (!link.isArchived) {
    return respondUnchanged<{ isArchived: boolean }>({ isArchived: false });
  }

  await prisma.teacherStudent.update({
    where: { id: link.id },
    data: { isArchived: false },
  });

  return respondOk({ isArchived: false, action: 'unarchived' });
});

/**
 * The archive body, or `null` for one that is not valid JSON or fails the
 * schema. An empty body is `{}`: the plain archive, with nothing to waive.
 */
async function readArchiveBody(
  request: NextRequest,
): Promise<{ waivePaymentIds?: string[] } | null> {
  const text = await request.text();
  if (text.trim() === '') return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
    // eslint-disable-next-line no-restricted-syntax -- a body that isn't JSON is a 400, not a fault
  } catch {
    return null;
  }
  const result = archiveStudentBodySchema.safeParse(raw);
  return result.success ? result.data : null;
}
