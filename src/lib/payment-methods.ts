import type { Currency, Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { parsePaymentLink, paymentLinkFromColumn } from '@/lib/payment-link';
import { bankDetailsFromRow, type BankAccountColumns, type BankDetails } from '@/lib/bank-details';

/** The one currency an EPC QR can carry. */
export const EPC_QR_CURRENCY = 'EUR' as const satisfies Currency;

/**
 * One way a student can pay a teacher. A new kind fails the build at
 * `PAYMENT_METHOD_COPY` until it has a label and hint.
 */
export type PaymentMethod =
  | { kind: 'bank_transfer'; beneficiary: string; details: BankDetails }
  | { kind: 'epc_qr'; beneficiary: string; iban: string; bic: string | null; currency: typeof EPC_QR_CURRENCY }
  | { kind: 'payment_link'; url: string; host: string };

export type PaymentMethodKind = PaymentMethod['kind'];

/** The chooser row's label, and the one line saying when to pick it. */
export const PAYMENT_METHOD_COPY = {
  bank_transfer: { label: 'Bank transfer', hint: 'Copy the details into your banking app' },
  epc_qr: { label: 'QR code', hint: 'For a banking app on another device' },
  payment_link: { label: 'Payment link', hint: 'Pay in the app the link opens' },
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

/** What a teacher's payment methods are read from: their account in the class's currency and their link. */
export type PaymentSources = { teacherId: string; account: StoredBankAccount | null; paymentLink: string | null };

/**
 * The methods a student may use to pay a teacher, in chooser order: a
 * transfer into `account` for every scheme, an EPC QR for a SEPA account in
 * euros, then the teacher's payment link. An account that does not parse
 * offers no bank method and does not hide the link; a stored link that does
 * not parse offers no link and does not hide the bank methods.
 *
 * The holder name is the beneficiary with no stand-in: the payer's bank checks
 * it against the account (Verification of Payee).
 */
export function paymentMethodsFor({ teacherId, account, paymentLink }: PaymentSources): PaymentMethod[] {
  const methods = account === null ? [] : bankMethodsFor(account);
  if (paymentLink === null) return methods;
  const link = parsePaymentLink(paymentLink);
  if (link.ok) {
    methods.push({ kind: 'payment_link', url: link.url, host: link.host });
  } else {
    // The reason and length, never the value: the link is the teacher's input.
    log.error({ teacherId, reason: link.error, length: paymentLink.length }, 'stored payment link does not parse; offering no link');
  }
  return methods;
}

function bankMethodsFor(account: StoredBankAccount): PaymentMethod[] {
  const details = bankDetailsFromRow(account);
  const beneficiary = nonBlank(account.holderName);
  if (details === null || beneficiary === null) {
    log.error(
      { teacherId: account.teacherId, accountId: account.id, currency: account.currency },
      'stored bank account does not parse; offering no bank method',
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

/** The teacher columns `paymentMethodsForTeacher` reads, so one select serves every call site. */
export const teacherPaymentSelect = {
  id: true,
  paymentLink: true,
  bankAccounts: { select: bankAccountSelect },
} as const satisfies Prisma.TeacherSelect;

export type TeacherPaymentSources = Prisma.TeacherGetPayload<{ select: typeof teacherPaymentSelect }>;

/** The methods for a teacher read with `teacherPaymentSelect`, using their account in `currency`. */
export function paymentMethodsForTeacher(teacher: TeacherPaymentSources, currency: Currency): PaymentMethod[] {
  return paymentMethodsFor({
    teacherId: teacher.id,
    account: accountInCurrency(teacher.bankAccounts, currency),
    paymentLink: teacher.paymentLink,
  });
}

/** Onboarding's `bank` step: an account in the current currency, or a link. */
export function hasPayoutDetails(teacher: {
  currency: Currency;
  paymentLink: string | null;
  bankAccounts: readonly { currency: Currency }[];
}): boolean {
  return hasAccountInCurrency(teacher.bankAccounts, teacher.currency) || paymentLinkFromColumn(teacher.paymentLink) !== null;
}
