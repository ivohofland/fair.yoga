import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Currency } from '@prisma/client';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondOk, respondUnchanged, respondError, requireTeacher, parseBody, isErrorResponse, withErrorHandler,
} from '@/lib/api-utils';
import { bankAccountSchema } from '@/lib/schemas';
import { formatIssues } from '@/lib/validation-message';
import { saveBankAccount, removeBankAccount, type BankAccountFailure } from '@/services/bank-accounts';

type Params = { params: Promise<{ id: string; currency: string }> };

const currencySegment = z.enum(Currency);

/** The message shown on the field a refusal names. */
const INVALID_MESSAGES = {
  iban_invalid: 'Enter a valid IBAN',
  bic_invalid: 'Enter a valid BIC',
  bic_required: 'Add the BIC — this IBAN is from outside the EEA',
  sort_code_invalid: 'Enter a six-digit sort code',
  account_number_invalid: 'Enter a valid account number',
  routing_number_invalid: 'Enter a valid nine-digit routing number',
  field_not_in_scheme: 'Accounts in this currency don’t use this field',
  holder_required: 'Enter the account holder’s name',
} as const satisfies Record<BankAccountFailure['error'], string>;

/**
 * The 400 for an invalid field, in `parseBody`'s `path: message` shape so a
 * client reads the field back the same way. `bic_required` carries its code.
 */
function respondInvalid({ error, field }: BankAccountFailure): NextResponse {
  const message = formatIssues([{ path: [field], message: INVALID_MESSAGES[error] }]);
  return error === 'bic_required'
    ? respondError(message, 400, 'BIC_REQUIRED')
    : respondError(message, 400);
}

/** The session teacher's own id and a known currency, or the refusal. */
async function authorise(
  request: NextRequest,
  { params }: Params,
): Promise<{ id: string; currency: Currency } | NextResponse> {
  const { id, currency } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;
  if (session.teacherId !== id) return respondError('Access denied', 403);
  const parsed = currencySegment.safeParse(currency);
  if (!parsed.success) return respondError('Unknown currency', 404);
  return { id, currency: parsed.data };
}

export const PUT = withErrorHandler(async (request: NextRequest, context: Params) => {
  const target = await authorise(request, context);
  if (target instanceof NextResponse) return target;

  const body = await parseBody(request, bankAccountSchema);
  if ('error' in body) return body.error;

  const outcome = await saveBankAccount(prisma, target.id, target.currency, body.data);
  switch (outcome.kind) {
    case 'saved':
      return respondOk(outcome.account);
    case 'invalid':
      return respondInvalid(outcome.failure);
    case 'teacher_gone':
      log.info({ teacherId: target.id }, 'bank account save refused: the teacher was erased');
      return respondError('Teacher not found', 404);
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled bank account save outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});

export const DELETE = withErrorHandler(async (request: NextRequest, context: Params) => {
  const target = await authorise(request, context);
  if (target instanceof NextResponse) return target;

  const outcome = await removeBankAccount(prisma, target.id, target.currency);
  switch (outcome.kind) {
    case 'removed':
      return respondOk({ currency: target.currency });
    case 'absent':
      return respondUnchanged<{ currency: Currency }>({ currency: target.currency });
    case 'teacher_gone':
      log.info({ teacherId: target.id }, 'bank account removal refused: the teacher was erased');
      return respondError('Teacher not found', 404);
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled bank account removal outcome: ${String((unhandled as { kind?: unknown }).kind)}`);
    }
  }
});
