import { describe, it, expect } from 'vitest';
import type { BankAccountData } from '@/lib/payment-methods';
import { payoutFingerprint } from './payout-fingerprint';

const eur: BankAccountData = {
  currency: 'EUR', holderName: 'Anna de Vries', iban: 'NL91ABNA0417164300', bic: null,
  sortCode: null, accountNumber: null, routingNumber: null, bankCode: null,
};
const gbp: BankAccountData = {
  currency: 'GBP', holderName: 'Anna de Vries', iban: null, bic: null,
  sortCode: '200000', accountNumber: '55779911', routingNumber: null, bankCode: null,
};
const link = 'https://revolut.me/anna';

describe('payoutFingerprint', () => {
  it('is a sha256 hex digest', () => {
    expect(payoutFingerprint({ paymentLink: link, bankAccounts: [eur], processorIdentity: null })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on the order the accounts were read in', () => {
    expect(payoutFingerprint({ paymentLink: link, bankAccounts: [eur, gbp], processorIdentity: null }))
      .toBe(payoutFingerprint({ paymentLink: link, bankAccounts: [gbp, eur], processorIdentity: null }));
  });

  it('ignores row keys that are not payout details', () => {
    const stored = { ...eur, id: 'row-1', teacherId: 't-1' };
    expect(payoutFingerprint({ paymentLink: null, bankAccounts: [stored], processorIdentity: null }))
      .toBe(payoutFingerprint({ paymentLink: null, bankAccounts: [eur], processorIdentity: null }));
  });

  it('moves when any column of any currency\'s account moves', () => {
    const base = payoutFingerprint({ paymentLink: link, bankAccounts: [eur, gbp], processorIdentity: null });
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
      expect(payoutFingerprint({ paymentLink: link, bankAccounts: accounts, processorIdentity: null })).not.toBe(base);
    }
  });

  it('moves when the link is set, changed or removed', () => {
    const base = payoutFingerprint({ paymentLink: link, bankAccounts: [eur], processorIdentity: null });
    expect(payoutFingerprint({ paymentLink: null, bankAccounts: [eur], processorIdentity: null })).not.toBe(base);
    expect(payoutFingerprint({ paymentLink: 'https://revolut.me/evil', bankAccounts: [eur], processorIdentity: null })).not.toBe(base);
  });

  it('tells a null column from an empty one', () => {
    expect(payoutFingerprint({ paymentLink: null, bankAccounts: [{ ...eur, bic: '' }], processorIdentity: null }))
      .not.toBe(payoutFingerprint({ paymentLink: null, bankAccounts: [eur], processorIdentity: null }));
  });

  describe('the live Mollie connection', () => {
    const at = (organizationId: string, profileId: string) =>
      payoutFingerprint({ paymentLink: link, bankAccounts: [eur], processorIdentity: { organizationId, profileId } });

    it('moves when Mollie is connected', () => {
      expect(at('org_a', 'pfl_1')).not.toBe(payoutFingerprint({ paymentLink: link, bankAccounts: [eur], processorIdentity: null }));
    });
    it('moves between two organizations', () => {
      expect(at('org_b', 'pfl_1')).not.toBe(at('org_a', 'pfl_1'));
    });
    it('moves between two profiles of one organization', () => {
      expect(at('org_a', 'pfl_2')).not.toBe(at('org_a', 'pfl_1'));
    });
  });
});
