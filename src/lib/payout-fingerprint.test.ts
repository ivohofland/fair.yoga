import { describe, it, expect } from 'vitest';
import type { BankAccountData } from '@/lib/payment-methods';
import { payoutFingerprint } from './payout-fingerprint';

const eur: BankAccountData = {
  currency: 'EUR', holderName: 'Anna de Vries', iban: 'NL91ABNA0417164300', bic: null,
  sortCode: null, accountNumber: null, routingNumber: null,
};
const gbp: BankAccountData = {
  currency: 'GBP', holderName: 'Anna de Vries', iban: null, bic: null,
  sortCode: '200000', accountNumber: '55779911', routingNumber: null,
};
const link = 'https://revolut.me/anna';

describe('payoutFingerprint', () => {
  it('is a sha256 hex digest', () => {
    expect(payoutFingerprint({ paymentLink: link, bankAccounts: [eur] })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the accounts were read in', () => {
    expect(payoutFingerprint({ paymentLink: link, bankAccounts: [eur, gbp] }))
      .toBe(payoutFingerprint({ paymentLink: link, bankAccounts: [gbp, eur] }));
  });

  it('ignores row keys that are not payout details', () => {
    const stored = { ...eur, id: 'row-1', teacherId: 't-1' };
    expect(payoutFingerprint({ paymentLink: null, bankAccounts: [stored] }))
      .toBe(payoutFingerprint({ paymentLink: null, bankAccounts: [eur] }));
  });

  it('moves when any column of any currency\'s account moves', () => {
    const base = payoutFingerprint({ paymentLink: link, bankAccounts: [eur, gbp] });
    const variants: BankAccountData[][] = [
      [eur, { ...gbp, accountNumber: '55779912' }],
      [eur, { ...gbp, sortCode: '200001' }],
      [eur, { ...gbp, holderName: 'Someone Else' }],
      [{ ...eur, bic: 'ABNANL2A' }, gbp],
      [{ ...eur, iban: 'NL02ABNA0123456789' }, gbp],
      [eur],
      [gbp],
    ];
    for (const accounts of variants) {
      expect(payoutFingerprint({ paymentLink: link, bankAccounts: accounts })).not.toBe(base);
    }
  });

  it('moves when the link is set, changed or removed', () => {
    const base = payoutFingerprint({ paymentLink: link, bankAccounts: [eur] });
    expect(payoutFingerprint({ paymentLink: null, bankAccounts: [eur] })).not.toBe(base);
    expect(payoutFingerprint({ paymentLink: 'https://revolut.me/evil', bankAccounts: [eur] })).not.toBe(base);
  });

  it('tells a null column from an empty one', () => {
    expect(payoutFingerprint({ paymentLink: null, bankAccounts: [{ ...eur, bic: '' }] }))
      .not.toBe(payoutFingerprint({ paymentLink: null, bankAccounts: [eur] }));
  });
});
