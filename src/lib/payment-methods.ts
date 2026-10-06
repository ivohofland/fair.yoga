import type { Currency } from '@prisma/client';

/**
 * One way a student can pay a teacher. A new kind fails the build at
 * `PAYMENT_METHOD_COPY` until it has a label and hint.
 */
export type PaymentMethod =
  | { kind: 'bank_transfer'; iban: string; beneficiary: string }
  | { kind: 'epc_qr'; iban: string; beneficiary: string };

export type PaymentMethodKind = PaymentMethod['kind'];

/** The chooser row's label, and the one line saying when to pick it. */
export const PAYMENT_METHOD_COPY = {
  bank_transfer: { label: 'Bank transfer', hint: 'Copy the details into your banking app' },
  epc_qr: { label: 'QR code', hint: 'For a banking app on another device' },
} as const satisfies Record<PaymentMethodKind, { label: string; hint: string }>;

/** The value with surrounding whitespace removed, or `null` when nothing is left. */
export function nonBlank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * The methods a student may use to pay this teacher, in chooser order.
 *
 * Bank methods need the holder name as well as the IBAN, with no stand-in:
 * the payer's bank checks the name against the IBAN (Verification of Payee),
 * and a name that is not the account's draws a mismatch warning.
 *
 * Only euro payments get a method: the stored IBAN is a euro account, and an
 * EPC QR can only carry euros.
 */
export function paymentMethodsFor(
  teacher: {
    bankIban: string | null;
    bankAccountName: string | null;
  },
  currency: Currency,
): PaymentMethod[] {
  if (currency !== 'EUR') return [];
  const iban = nonBlank(teacher.bankIban);
  const beneficiary = nonBlank(teacher.bankAccountName);
  if (iban === null || beneficiary === null) return [];
  return [
    { kind: 'bank_transfer', iban, beneficiary },
    { kind: 'epc_qr', iban, beneficiary },
  ];
}
