import type { Currency, Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { bankDetailsFromRow, type BankAccountColumns, type BankDetails } from '@/lib/bank-details';

/** The one currency an EPC QR can carry. */
export const EPC_QR_CURRENCY = 'EUR' as const satisfies Currency;

/**
 * One way a student can pay a teacher. A new kind fails the build at
 * `PAYMENT_METHOD_COPY` until it has a label and hint.
 */
export type PaymentMethod =
  | { kind: 'bank_transfer'; beneficiary: string; details: BankDetails }
  | { kind: 'epc_qr'; beneficiary: string; iban: string; bic: string | null; currency: typeof EPC_QR_CURRENCY };

export type PaymentMethodKind = PaymentMethod['kind'];

/** The chooser row's label, and the one line saying when to pick it. */
export const PAYMENT_METHOD_COPY = {
  bank_transfer: { label: 'Bank transfer', hint: 'Copy the details into your banking app' },
  epc_qr: { label: 'QR code', hint: 'For a banking app on another device' },
} as const satisfies Record<PaymentMethodKind, { label: string; hint: string }>;

/** A stored account's own data: its currency, holder name and every scheme column. */
export type BankAccountData = { currency: Currency; holderName: string } & BankAccountColumns;

/** A stored account with the keys that name its row in a log line. */
export type StoredBankAccount = BankAccountData & { id: string; teacherId: string };

/** The columns `BankAccountData` holds; a column the type gains and this select lacks fails to compile. */
export const bankAccountDataSelect = {
  currency: true,
  holderName: true,
  iban: true,
  bic: true,
  sortCode: true,
  accountNumber: true,
  routingNumber: true,
} as const satisfies Record<keyof BankAccountData, true> & Prisma.TeacherBankAccountSelect;

/** The columns `StoredBankAccount` holds, so one select reads every one `paymentMethodsFor` needs. */
export const bankAccountSelect = {
  ...bankAccountDataSelect,
  id: true,
  teacherId: true,
} as const satisfies Record<keyof StoredBankAccount, true> & Prisma.TeacherBankAccountSelect;

/** The value with surrounding whitespace removed, or `null` when nothing is left. */
export function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The account in `currency` among a teacher's accounts, or `null` when they hold none in it. */
export function accountInCurrency<A extends { currency: Currency }>(accounts: readonly A[], currency: Currency): A | null {
  return accounts.find((a) => a.currency === currency) ?? null;
}

/** Whether a teacher's accounts include one in `currency`. */
export function hasAccountInCurrency(accounts: readonly { currency: Currency }[], currency: Currency): boolean {
  return accountInCurrency(accounts, currency) !== null;
}
function isEpcQrCurrency(currency: Currency): currency is typeof EPC_QR_CURRENCY {
  return currency === EPC_QR_CURRENCY;
}

/**
 * The methods a student may use to pay into `account`, in chooser order: a
 * transfer for every scheme, and an EPC QR for a SEPA account in euros.
 *
 * The holder name is the beneficiary with no stand-in: the payer's bank checks
 * it against the account (Verification of Payee).
 */
export function paymentMethodsFor(account: StoredBankAccount | null): PaymentMethod[] {
  if (account === null) return [];
  const details = bankDetailsFromRow(account);
  const beneficiary = nonBlank(account.holderName);
  if (details === null || beneficiary === null) {
    log.error(
      { teacherId: account.teacherId, accountId: account.id, currency: account.currency },
      'stored bank account does not parse; offering no method',
    );
    return [];
  }
  const transfer: PaymentMethod = { kind: 'bank_transfer', beneficiary, details };
  if (details.scheme !== 'sepa' || !isEpcQrCurrency(account.currency)) return [transfer];
  return [
    transfer,
    { kind: 'epc_qr', beneficiary, iban: details.iban, bic: details.bic, currency: account.currency },
  ];
}
