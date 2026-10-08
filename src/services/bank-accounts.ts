import type { Currency, PrismaClient, TeacherBankAccount } from '@prisma/client';
import type { z } from 'zod';
import { lockTeacherForNoKeyUpdate } from '@/lib/db-locks';
import type { bankAccountSchema } from '@/lib/schemas';
import {
  maskedIdentifier,
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

/**
 * `saved` and `removed` carry the `PayoutChangeEvent` they recorded; `unchanged`
 * is a save whose stored values already matched, which records none.
 */
export type SaveBankAccountOutcome =
  | { kind: 'saved'; account: TeacherBankAccount; eventId: string }
  | { kind: 'unchanged'; account: TeacherBankAccount }
  | { kind: 'invalid'; failure: BankAccountFailure }
  | { kind: 'teacher_gone' };

export type RemoveBankAccountOutcome =
  | { kind: 'removed'; eventId: string }
  | { kind: 'absent' }
  | { kind: 'teacher_gone' };

/** The values a save writes to the account row. */
type StoredValues = BankAccountColumns & { holderName: string };

/** Every column a save writes, so the unchanged check compares each one. */
const STORED_KEYS = {
  holderName: true, iban: true, bic: true, sortCode: true, accountNumber: true, routingNumber: true,
} as const satisfies Record<keyof StoredValues, true>;

function storesAlready(current: TeacherBankAccount, next: StoredValues): boolean {
  return (Object.keys(STORED_KEYS) as (keyof StoredValues)[]).every((key) => current[key] === next[key]);
}

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
 * that currency's scheme, and records the change with both identifiers
 * masked. Gated on `lockTeacherForNoKeyUpdate` as the transaction's first
 * lock, so the account it reads as "before" is the one it replaces; its
 * placement is `docs/lock-order.md`'s ("The `Teacher` row is the first lock").
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

  const next: StoredValues = { holderName, ...columns };

  return db.$transaction(async (tx): Promise<SaveBankAccountOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, teacherId))) return { kind: 'teacher_gone' };
    const where = { teacherId_currency: { teacherId, currency } };
    const current = await tx.teacherBankAccount.findUnique({ where });
    if (current !== null && storesAlready(current, next)) return { kind: 'unchanged', account: current };
    const account = await tx.teacherBankAccount.upsert({
      where,
      create: { teacherId, currency, ...next },
      update: next,
    });
    const event = await tx.payoutChangeEvent.create({
      data: {
        teacherId,
        kind: current === null ? 'bank_account_added' : 'bank_account_changed',
        accountCurrency: currency,
        before: current === null ? null : maskedIdentifier(current),
        after: maskedIdentifier(account),
      },
      select: { id: true },
    });
    return { kind: 'saved', account, eventId: event.id };
  });
}

/**
 * Removes the teacher's account in `currency` and records the removal with
 * its identifier masked, under the same first lock as `saveBankAccount`.
 */
export async function removeBankAccount(
  db: PrismaClient,
  teacherId: string,
  currency: Currency,
): Promise<RemoveBankAccountOutcome> {
  return db.$transaction(async (tx): Promise<RemoveBankAccountOutcome> => {
    if (!(await lockTeacherForNoKeyUpdate(tx, teacherId))) return { kind: 'teacher_gone' };
    const current = await tx.teacherBankAccount.findUnique({ where: { teacherId_currency: { teacherId, currency } } });
    if (current === null) return { kind: 'absent' };
    await tx.teacherBankAccount.delete({ where: { id: current.id } });
    const event = await tx.payoutChangeEvent.create({
      data: {
        teacherId,
        kind: 'bank_account_removed',
        accountCurrency: currency,
        before: maskedIdentifier(current),
        after: null,
      },
      select: { id: true },
    });
    return { kind: 'removed', eventId: event.id };
  });
}
