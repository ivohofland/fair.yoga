import type { EPC_QR_CURRENCY } from '@/lib/payment-methods';
import type { MethodAmount } from '@/lib/method-amount';

/**
 * The EPC QR payload (the "Girocode" EU banking apps scan): beneficiary, IBAN,
 * the BIC when there is one (version 001; without it, 002), amount, and a
 * remittance line. An open amount leaves the amount line empty, so the
 * student's banking app asks for it.
 */
export function epcQrPayload({
  iban,
  bic,
  beneficiary,
  amount,
  currency,
  remittance,
}: {
  iban: string;
  bic: string | null;
  beneficiary: string;
  amount: MethodAmount;
  currency: typeof EPC_QR_CURRENCY;
  remittance: string;
}): string {
  return [
    'BCD',
    bic === null ? '002' : '001',
    '1',
    'SCT',
    bic ?? '',
    beneficiary.slice(0, 70),
    iban.replace(/\s/g, ''),
    amount.kind === 'fixed' ? `${currency}${amount.amount.toFixed(2)}` : '',
    '',
    '',
    remittance.slice(0, 140),
  ].join('\n');
}
