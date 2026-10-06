import type { Currency, PrismaClient, TeacherBankAccount } from '@prisma/client';
import type { z } from 'zod';
import { lockTeacherForShare } from '@/lib/db-locks';
import type { bankAccountSchema } from '@/lib/schemas';
import {
  parseBankDetails,
  type BankAccountColumns,
  type BankDetails,
  type BankDetailsFailure,
} from '@/lib/bank-details';

/**
 * A teacher's bank account in one currency, saved and removed (#758).
 * Framework-agnostic: the caller validates the body's shape and maps the
 * outcome to a response.
 */

/** The body `bankAccountSchema` accepts, so the route's parse and this input cannot drift. */
export type BankAccountInput = z.infer<typeof bankAccountSchema>;

/** A refusal and the field it names: a scheme field's, or the holder name's. */
export type BankAccountFailure = BankDetailsFailure | { error: 'holder_required'; field: 'holderName' };

export type SaveBankAccountOutcome =
  | { kind: 'saved'; account: TeacherBankAccount }
  | { kind: 'invalid'; failure: BankAccountFailure }
  | { kind: 'teacher_gone' };

export type RemoveBankAccountOutcome = { kind: 'removed' } | { kind: 'absent' } | { kind: 'teacher_gone' };

/** Every scheme column, the ones `details`' scheme does not use set to null. */
function columnsFor(details: BankDetails): BankAccountColumns {
  switch (details.scheme) {
    case 'sepa':
    case 'iban':
      return { iban: details.iban, bic: details.bic, sortCode: null, accountNumber: null, routingNumber: null };
    case 'uk':
      return { iban: null, bic: null, sortCode: details.sortCode, accountNumber: details.accountNumber, routingNumber: null };
    case 'us':
      return { iban: null, bic: null, sortCode: null, accountNumber: details.accountNumber, routingNumber: details.routingNumber };
    default: {
      const unhandled: never = details;
      throw new Error(`unhandled bank scheme ${String((unhandled as { scheme?: unknown }).scheme)}`);
    }
  }
}

/**
 * Creates or replaces the teacher's account in `currency`, validated against
 * that currency's scheme. Gated on `lockTeacherForShare` as the transaction's
 * first lock, whose placement against erasure is `docs/lock-order.md`'s ("The
 * `Teacher` row is the first lock (#758)").
 */
export async function saveBankAccount(
  db: PrismaClient,
  teacherId: string,
  currency: Currency,
  input: BankAccountInput,
): Promise<SaveBankAccountOutcome> {
  const parsed = parseBankDetails(currency, input);
  if (!parsed.ok) return { kind: 'invalid', failure: parsed.failure };
  const holderName = input.holderName.trim();
  if (holderName === '') return { kind: 'invalid', failure: { error: 'holder_required', field: 'holderName' } };
  const columns = columnsFor(parsed.details);

  return db.$transaction(async (tx): Promise<SaveBankAccountOutcome> => {
    if (!(await lockTeacherForShare(tx, teacherId))) return { kind: 'teacher_gone' };
    const account = await tx.teacherBankAccount.upsert({
      where: { teacherId_currency: { teacherId, currency } },
      create: { teacherId, currency, holderName, ...columns },
      update: { holderName, ...columns },
    });
    return { kind: 'saved', account };
  });
}

/** Removes the teacher's account in `currency`, under the same first lock as `saveBankAccount`. */
export async function removeBankAccount(
  db: PrismaClient,
  teacherId: string,
  currency: Currency,
): Promise<RemoveBankAccountOutcome> {
  return db.$transaction(async (tx): Promise<RemoveBankAccountOutcome> => {
    if (!(await lockTeacherForShare(tx, teacherId))) return { kind: 'teacher_gone' };
    const { count } = await tx.teacherBankAccount.deleteMany({ where: { teacherId, currency } });
    return count === 0 ? { kind: 'absent' } : { kind: 'removed' };
  });
}
