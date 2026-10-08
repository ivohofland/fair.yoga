import 'server-only';
import { createHash } from 'node:crypto';
import { bankAccountDataSelect, type BankAccountData } from '@/lib/payment-methods';

/** Every column of `BankAccountData`, in the one order the serialisation writes them. */
const COLUMNS = Object.keys(bankAccountDataSelect) as (keyof BankAccountData)[];

/**
 * A digest of every payout detail a teacher holds: each bank account in every
 * currency, column by column, and the payment link. The resume screen shows
 * the details and hands this back, so a resume confirms exactly what was
 * shown — a change to any account since, in any currency, no longer matches.
 * Keys beyond `BankAccountData`'s (a row's `id`, its timestamps) are not
 * payout details and do not enter it.
 */
export function payoutFingerprint(t: {
  paymentLink: string | null;
  bankAccounts: readonly BankAccountData[];
}): string {
  const accounts = [...t.bankAccounts]
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
    .map((account) => COLUMNS.map((column) => account[column]));
  return createHash('sha256').update(JSON.stringify([t.paymentLink, accounts])).digest('hex');
}
