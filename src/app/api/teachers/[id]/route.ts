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
import { updateTeacherSchema, PAGE_SLUG_TAKEN_MESSAGE, BANK_HOLDER_NAME_REQUIRED_MESSAGE } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { nonBlank } from '@/lib/payment-methods';

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

  // The body is partial, so the rule is checked on the row as it would be
  // after this save. Only a save touching a bank field is checked: a row
  // stored before the rule must not block its teacher's unrelated edits.
  // Read and write are separate statements, so a teacher racing their own two
  // saves could still land an IBAN alone; nothing reading the row may assume
  // the pair.
  if (updateData.bankIban !== undefined || updateData.bankAccountName !== undefined) {
    const stored = await prisma.teacher.findUniqueOrThrow({
      where: { id },
      select: { bankIban: true, bankAccountName: true },
    });
    const iban = nonBlank(updateData.bankIban !== undefined ? updateData.bankIban : stored.bankIban);
    const holder = nonBlank(
      updateData.bankAccountName !== undefined ? updateData.bankAccountName : stored.bankAccountName,
    );
    if (iban !== null && holder === null) {
      return respondError(BANK_HOLDER_NAME_REQUIRED_MESSAGE, 400);
    }
  }

  let teacher;
  try {
    teacher = await prisma.teacher.update({
      where: { id },
      data: updateData,
    });
  } catch (err) {
    if (isUniqueConflictOn(err, ['pageSlug'])) {
      return respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
    }
    throw err;
  }

  return respondOk(teacher);
});
