import type { Currency, Prisma } from '@prisma/client';
import { bankDetailsFromRow, type BankDetails } from '@/lib/bank-details';

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

/** The columns every payment-facing reader selects from a `TeacherBankAccount`. */
export const bankAccountSelect = {
  currency: true,
  holderName: true,
  iban: true,
  bic: true,
  sortCode: true,
  accountNumber: true,
  routingNumber: true,
} as const satisfies Prisma.TeacherBankAccountSelect;

/** A stored account, as `bankAccountSelect` reads it. */
export type StoredBankAccount = Parameters<typeof bankDetailsFromRow>[0] & { holderName: string };

/** The value with surrounding whitespace removed, or `null` when nothing is left. */
export function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The account in `currency` among a teacher's accounts, or `null` when they hold none in it. */
export function accountInCurrency<A extends { currency: Currency }>(accounts: readonly A[], currency: Currency): A | null {
  return accounts.find((a) => a.currency === currency) ?? null;
}

/**
 * The methods a student may use to pay into `account`, in chooser order: a
 * transfer for every scheme, and an EPC QR for a euro account.
 *
 * The holder name is the beneficiary with no stand-in: the payer's bank checks
 * it against the account (Verification of Payee).
 */
export function paymentMethodsFor(account: StoredBankAccount | null): PaymentMethod[] {
  if (account === null) return [];
  const details = bankDetailsFromRow(account);
  const beneficiary = nonBlank(account.holderName);
  if (details === null || beneficiary === null) {
    // Client-reachable module, so no server logger.
    console.error('[payment-methods] stored bank account does not parse; offering no method', {
      currency: account.currency,
    });
    return [];
  }
  const transfer: PaymentMethod = { kind: 'bank_transfer', beneficiary, details };
  if (details.scheme !== 'sepa') return [transfer];
  return [
    transfer,
    { kind: 'epc_qr', beneficiary, iban: details.iban, bic: details.bic, currency: EPC_QR_CURRENCY },
  ];
}
