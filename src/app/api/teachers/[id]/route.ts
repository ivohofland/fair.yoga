import { NextRequest, NextResponse } from 'next/server';
import type { Currency, Teacher } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondUnchanged,
  respondError,
  requireTeacher,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { updateTeacherSchema, PAGE_SLUG_TAKEN_MESSAGE, BANK_HOLDER_NAME_REQUIRED_MESSAGE } from '@/lib/schemas';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isCheckViolationOn } from '@/lib/check-violation';
import { nonBlank } from '@/lib/payment-methods';
import { switchTeacherCurrency, type CurrencySwitchResult } from '@/services/currency-switch';

type UpdateTeacherInput = z.infer<typeof updateTeacherSchema>;

/**
 * The switch locks the teacher, every template and every class it relabels,
 * each wait bounded at 2s by `setLockTimeout`; Prisma's 5s default would cut
 * a switch short behind a few contended rows with a code-less 503.
 */
const CURRENCY_SAVE_TIMEOUT_MS = 15_000;

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
  // after this save, and answered with copy the teacher can act on. Read and
  // write are separate statements, so a teacher racing their own two saves
  // can get past this check; `Teacher_bank_holder_name_check` refuses the
  // pair in the database, and the catch below answers that with the same 400.
  if (updateData.bankIban !== undefined || updateData.bankAccountName !== undefined) {
    const stored = await prisma.teacher.findUnique({
      where: { id },
      select: { bankIban: true, bankAccountName: true },
    });
    if (!stored) return respondError('Teacher not found', 404);
    const iban = nonBlank(updateData.bankIban !== undefined ? updateData.bankIban : stored.bankIban);
    const holder = nonBlank(
      updateData.bankAccountName !== undefined ? updateData.bankAccountName : stored.bankAccountName,
    );
    if (iban !== null && holder === null) {
      return respondError(BANK_HOLDER_NAME_REQUIRED_MESSAGE, 400);
    }
  }

  if (updateData.currency !== undefined) {
    return putWithCurrency(id, updateData.currency, withoutCurrency(updateData));
  }

  // Scoped to a live row. An erasure holds this row from its first statement
  // to its commit, so this write can wait behind one; once it commits the
  // row is re-checked, and matched by `id` alone it would still match and
  // write these fields onto the anonymised row. `docs/lock-order.md`, "The
  // `Teacher` row is the first lock (#758)".
  try {
    const { count } = await prisma.teacher.updateMany({
      where: { id, deletedAt: null },
      data: updateData,
    });
    if (count === 0) return respondError('Teacher not found', 404);
  } catch (err) {
    const refusal = refusalForWriteError(err);
    if (refusal) return refusal;
    throw err;
  }

  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) return respondError('Teacher not found', 404);
  return respondOk(teacher);
});

type TeacherFields = Omit<UpdateTeacherInput, 'currency'>;

function withoutCurrency({ currency: _currency, ...rest }: UpdateTeacherInput): TeacherFields {
  return rest;
}

/** The answer to a write the database refused for a reason the teacher can act on. */
function refusalForWriteError(err: unknown): NextResponse | null {
  if (isUniqueConflictOn(err, ['pageSlug'])) {
    return respondError(PAGE_SLUG_TAKEN_MESSAGE, 409, 'SLUG_TAKEN');
  }
  if (isCheckViolationOn(err, 'Teacher_bank_holder_name_check')) {
    return respondError(BANK_HOLDER_NAME_REQUIRED_MESSAGE, 400);
  }
  return null;
}

/**
 * A save that names a currency: the switch and the other fields in one
 * transaction, the switch first because its teacher lock is that
 * transaction's first lock (`switchTeacherCurrency`). A refusal of another
 * field rolls the switch back with it. The other fields' write keeps the
 * live-row scope of the plain save above; holding the lock, it cannot miss.
 */
async function putWithCurrency(
  id: string,
  currency: Currency,
  fields: TeacherFields,
): Promise<NextResponse> {
  const hasFields = Object.keys(fields).length > 0;
  let outcome:
    | { kind: 'gone' }
    | { kind: 'unchanged'; teacher: Teacher }
    | { kind: 'saved'; teacher: Teacher; currencySwitch: CurrencySwitchResult | null };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const switched = await switchTeacherCurrency(tx, id, currency);
      if (switched === 'teacher_gone') return { kind: 'gone' as const };
      if (switched === 'unchanged' && !hasFields) {
        return { kind: 'unchanged' as const, teacher: await tx.teacher.findUniqueOrThrow({ where: { id } }) };
      }
      if (hasFields) {
        const { count } = await tx.teacher.updateMany({ where: { id, deletedAt: null }, data: fields });
        if (count === 0) return { kind: 'gone' as const };
      }
      return {
        kind: 'saved' as const,
        teacher: await tx.teacher.findUniqueOrThrow({ where: { id } }),
        currencySwitch: switched === 'unchanged' ? null : switched,
      };
    }, { timeout: CURRENCY_SAVE_TIMEOUT_MS });
  } catch (err) {
    const refusal = refusalForWriteError(err);
    if (refusal) return refusal;
    throw err;
  }

  if (outcome.kind === 'gone') return respondError('Teacher not found', 404);
  if (outcome.kind === 'unchanged') return respondUnchanged<Teacher>(outcome.teacher);
  if (outcome.currencySwitch === null) return respondOk(outcome.teacher);
  return respondOk({ ...outcome.teacher, currencySwitch: outcome.currencySwitch });
}
