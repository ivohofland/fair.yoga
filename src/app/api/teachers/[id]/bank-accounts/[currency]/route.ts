import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Currency, type TeacherBankAccount } from '@prisma/client';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import {
  respondOk, respondUnchanged, respondError, requireTeacher, parseBody, isErrorResponse, withErrorHandler,
} from '@/lib/api-utils';
import { bankAccountSchema } from '@/lib/schemas';
import { formatIssues } from '@/lib/validation-message';
import type { BankDetailsInput } from '@/lib/bank-details';
import { saveBankAccount, removeBankAccount, type BankAccountFailure } from '@/services/bank-accounts';

type Params = { params: Promise<{ id: string; currency: string }> };

const currencySegment = z.enum(Currency);

/** The message shown on the field a refusal names, for each refusal whose wording is fixed. */
const INVALID_MESSAGES = {
  iban_invalid: 'Enter a valid IBAN.',
  bic_invalid: 'Enter a valid BIC.',
  bic_required: 'Add the BIC. This IBAN is from outside the EEA.',
  sort_code_invalid: 'Enter a six-digit sort code.',
  account_number_invalid: 'Enter a valid account number.',
  routing_number_invalid: 'Enter a valid nine-digit routing number.',
  holder_required: 'Enter the account holder’s name.',
} as const satisfies Record<Exclude<BankAccountFailure['error'], 'field_not_in_scheme'>, string>;

/** Each scheme field in words, as a sentence names it. */
const FIELD_IN_WORDS = {
  iban: 'an IBAN',
  bic: 'a BIC',
  sortCode: 'a sort code',
  accountNumber: 'an account number',
  routingNumber: 'a routing number',
} as const satisfies Record<keyof BankDetailsInput, string>;

function invalidMessage(failure: BankAccountFailure): string {
  return failure.error === 'field_not_in_scheme'
    ? `Accounts in this currency don’t use ${FIELD_IN_WORDS[failure.field]}.`
    : INVALID_MESSAGES[failure.error];
}

/**
 * The 400 for an invalid field, in `parseBody`'s `path: message` shape so a
 * client reads the field back the same way. `bic_required` carries its code.
 */
function respondInvalid(failure: BankAccountFailure): NextResponse {
  const message = formatIssues([{ path: [failure.field], message: invalidMessage(failure) }]);
  return failure.error === 'bic_required'
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
    case 'unchanged':
      return respondUnchanged<TeacherBankAccount>(outcome.account);
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
