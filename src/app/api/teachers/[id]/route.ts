import { NextRequest, NextResponse } from 'next/server';
import type { Teacher } from '@prisma/client';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondOk,
  respondUnchanged,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateTeacherSchema, PAGE_SLUG_TAKEN_MESSAGE } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { updateTeacherProfile, type TeacherProfileOutcome } from '@/services/teacher-profile';

export const GET = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  if (session.teacherId !== id) {
    return respondError('Access denied', 403);
  }

  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) return respondError('Teacher not found', 404);

  return respondOk(teacher);
});

export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  if (session.teacherId !== id) {
    return respondError('Access denied', 403);
  }

  const parsed = await parseBody(request, updateTeacherSchema);
  if ('error' in parsed) return parsed.error;
  const updateData = parsed.data;

  // A plain read, so a slug another teacher claims between here and the
  // update below slips past this check — the update's own catch answers it,
  // with the same message and code.
  if (updateData.pageSlug) {
    const existing = await prisma.teacher.findUnique({
      where: { pageSlug: updateData.pageSlug },
    });
    if (existing && existing.id !== id) {
      return respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
    }
  }

  if (Object.keys(updateData).length === 0) {
    return respondError('No valid fields to update', 400);
  }

  const { currency, ...fields } = updateData;
  let outcome: TeacherProfileOutcome;
  try {
    outcome = await updateTeacherProfile(prisma, id, { ...(currency !== undefined ? { currency } : {}), fields });
  } catch (err) {
    const refusal = refusalForWriteError(err);
    if (refusal) return refusal;
    throw err;
  }

  switch (outcome.kind) {
    case 'gone':
      // LOGGED before responding: `respondError` does not log, and
      // `withErrorHandler` never sees a response that was returned.
      log.warn({ teacherId: id }, 'teacher update refused: the teacher was erased');
      return respondError('Teacher not found', 404);
    case 'unchanged':
      return respondUnchanged<Teacher>(outcome.teacher);
    case 'saved':
      return outcome.currencySwitch === undefined
        ? respondOk(outcome.teacher)
        : respondOk({ ...outcome.teacher, currencySwitch: outcome.currencySwitch });
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled teacher update outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});

/** The answer to a write the database refused for a reason the teacher can act on. */
function refusalForWriteError(err: unknown): NextResponse | null {
  if (isUniqueConflictOn(err, ['pageSlug'])) {
    return respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
  }
  return null;
}
