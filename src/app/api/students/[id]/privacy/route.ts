import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updatePrivacySchema } from '@/lib/schemas';
import { log } from '@/lib/log';

/**
 * A student may only read or write privacy settings for a teacher they are
 * actually connected to. Both handlers proved the *student* side
 * (`session.studentId !== id`) and never the teacher side, so `teacherId` was a
 * cross-tenant id taken from the request with no check — the same defect as
 * #146/#148 one route over, with the field kept rather than dropped because
 * here the student legitimately chooses the teacher.
 *
 * Existence, not `isArchived: false`. Archiving is the teacher's filing action,
 * and the looser check is the one that would not strip a student of control
 * over their own settings because a teacher tidied them away. This is now
 * load-bearing, not merely future-proofing: `account/privacy/page.tsx`
 * renders a card, toggles included, for an archived link too (#166 Task 11
 * review F3) — a student must still be able to revoke shares from a teacher
 * who filed them away, and this route is what that card's Save button hits.
 *
 * The two 403s below have different causes and different remedies, so they
 * carry distinct codes. Splitting them leaks nothing: the link check runs only
 * after `session.studentId === id`, so the only caller who can reach it is the
 * student themselves, and what it reveals is already rendered on their own
 * /account/privacy page.
 */
async function hasTeacherLink(studentId: string, teacherId: string): Promise<boolean> {
  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId } },
    select: { id: true },
  });
  return link !== null;
}

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  if (session.studentId !== id) {
    return respondError('Access denied', 403, 'NOT_YOUR_PROFILE');
  }

  const teacherId = request.nextUrl.searchParams.get('teacherId');
  if (!teacherId) {
    return respondError('Missing teacherId query parameter', 400);
  }

  if (!(await hasTeacherLink(id, teacherId))) {
    log.warn({ studentId: id, teacherId }, 'privacy read refused: no TeacherStudent link');
    return respondError('Access denied', 403, 'TEACHER_NOT_LINKED');
  }

  const privacy = await prisma.studentPrivacy.findUnique({
    where: {
      studentId_teacherId: {
        studentId: id,
        teacherId,
      },
    },
  });

  if (!privacy) {
    return respondOk({
      studentId: id,
      teacherId,
      shareFullName: false,
      shareEmail: false,
      sharePhone: false,
      shareBirthday: false,
      shareAddress: false,
      receiveComms: true,
    });
  }

  return respondOk(privacy);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  if (session.studentId !== id) {
    return respondError('Access denied', 403, 'NOT_YOUR_PROFILE');
  }

  const parsed = await parseBody(request, updatePrivacySchema);
  if ('error' in parsed) return parsed.error;
  const { teacherId, ...privacyFields } = parsed.data;

  if (!(await hasTeacherLink(id, teacherId))) {
    log.warn({ studentId: id, teacherId }, 'privacy write refused: no TeacherStudent link');
    return respondError('Access denied', 403, 'TEACHER_NOT_LINKED');
  }

  const privacy = await prisma.studentPrivacy.upsert({
    where: {
      studentId_teacherId: {
        studentId: id,
        teacherId,
      },
    },
    update: privacyFields,
    create: {
      studentId: id,
      teacherId,
      shareFullName: privacyFields.shareFullName ?? false,
      shareEmail: privacyFields.shareEmail ?? false,
      sharePhone: privacyFields.sharePhone ?? false,
      shareBirthday: privacyFields.shareBirthday ?? false,
      shareAddress: privacyFields.shareAddress ?? false,
      receiveComms: privacyFields.receiveComms ?? true,
    },
  });

  return respondOk(privacy);
});
