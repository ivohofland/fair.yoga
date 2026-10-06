import type { ComponentProps } from 'react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { Currency } from '@prisma/client';
import type { PaymentQr } from '@/components/student/payment-qr';
import { SCHEME_FOR_CURRENCY } from '@/lib/bank-details';
import { log } from '@/lib/log';
import {
  EPC_QR_CURRENCY,
  PAYMENT_METHOD_COPY,
  accountInCurrency,
  nonBlank,
  paymentMethodsFor,
  type PaymentMethod,
  type StoredBankAccount,
} from './payment-methods';

const IBAN = 'NL91ABNA0417164300';
const HOLDER = 'I. Hofland';
const TEACHER_ID = 'teacher-1';
const blank = { iban: null, bic: null, sortCode: null, accountNumber: null, routingNumber: null };

function account(fields: Partial<StoredBankAccount> & Pick<StoredBankAccount, 'currency'>): StoredBankAccount {
  return { ...blank, id: `acct-${fields.currency}`, teacherId: TEACHER_ID, holderName: HOLDER, ...fields };
}

describe('nonBlank', () => {
  it('trims a value', () => {
    expect(nonBlank('  I. Hofland ')).toBe('I. Hofland');
  });

  it('answers null for null, undefined, empty and whitespace-only', () => {
    expect(nonBlank(null)).toBeNull();
    expect(nonBlank(undefined)).toBeNull();
    expect(nonBlank('')).toBeNull();
    expect(nonBlank(' \t ')).toBeNull();
  });
});

describe('EPC_QR_CURRENCY', () => {
  it('names the euro as the one currency an EPC QR carries', () => {
    expect(EPC_QR_CURRENCY).toBe('EUR');
  });

  // paymentMethodsFor offers the QR on the account's currency as well as its
  // scheme; this pins that the two conditions still pick the same accounts.
  it('is the only currency whose accounts use the sepa scheme', () => {
    const sepa = Object.entries(SCHEME_FOR_CURRENCY).filter(([, scheme]) => scheme === 'sepa');
    expect(sepa).toEqual([[EPC_QR_CURRENCY, 'sepa']]);
  });

  it('types a QR code and its component to the euro alone', () => {
    // @ts-expect-error a QR method in another currency does not compile
    const method: PaymentMethod = { kind: 'epc_qr', iban: IBAN, bic: null, beneficiary: 'A', currency: 'GBP' };
    // @ts-expect-error nor does a QR component asked for one
    const qrCurrency: ComponentProps<typeof PaymentQr>['currency'] = 'GBP';
    expect([method.kind, qrCurrency]).toEqual(['epc_qr', 'GBP']);
  });
});

describe('paymentMethodsFor', () => {
  it('offers nothing without an account', () => {
    expect(paymentMethodsFor(null)).toEqual([]);
  });

  it('offers a euro account a bank transfer then a QR code, with a null BIC when none is stored', () => {
    expect(paymentMethodsFor(account({ currency: 'EUR', iban: IBAN }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'sepa', iban: IBAN, bic: null } },
      { kind: 'epc_qr', beneficiary: HOLDER, iban: IBAN, bic: null, currency: 'EUR' },
    ]);
  });

  it('carries a stored BIC into both euro methods', () => {
    expect(paymentMethodsFor(account({ currency: 'EUR', iban: IBAN, bic: 'ABNANL2A' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'sepa', iban: IBAN, bic: 'ABNANL2A' } },
      { kind: 'epc_qr', beneficiary: HOLDER, iban: IBAN, bic: 'ABNANL2A', currency: 'EUR' },
    ]);
  });

  it('offers a pound account a sort-code transfer and no QR code', () => {
    expect(paymentMethodsFor(account({ currency: 'GBP', sortCode: '123456', accountNumber: '12345678' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'uk', sortCode: '123456', accountNumber: '12345678' } },
    ]);
  });

  it('offers a dollar account a routing-number transfer and no QR code', () => {
    expect(paymentMethodsFor(account({ currency: 'USD', routingNumber: '021000021', accountNumber: '1234567' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'us', routingNumber: '021000021', accountNumber: '1234567' } },
    ]);
  });

  it.each(['CHF', 'SEK', 'NOK', 'DKK'] as const)('offers a %s account an IBAN transfer and no QR code', (currency) => {
    expect(paymentMethodsFor(account({ currency, iban: 'CH9300762011623852957' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'iban', iban: 'CH9300762011623852957', bic: null } },
    ]);
  });

  // The trimmed name is the one a bank compares; a stray space must not become part of it.
  it('trims the holder name it hands out', () => {
    const [transfer] = paymentMethodsFor(account({ currency: 'EUR', iban: IBAN, holderName: '  I. Hofland  ' }));
    expect(transfer?.beneficiary).toBe(HOLDER);
  });

  it('offers nothing for, and logs with its teacher and row, a row the CHECK should have made impossible', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => error.mockRestore());
    expect(paymentMethodsFor(account({ currency: 'GBP', iban: IBAN, id: 'acct-gbp' }))).toEqual([]);
    expect(paymentMethodsFor(account({ currency: 'EUR', iban: IBAN, holderName: '  ', id: 'acct-eur' }))).toEqual([]);
    expect(error.mock.calls.map(([context]) => context)).toEqual([
      { teacherId: TEACHER_ID, accountId: 'acct-gbp', currency: 'GBP' },
      { teacherId: TEACHER_ID, accountId: 'acct-eur', currency: 'EUR' },
    ]);
  });
});

describe('accountInCurrency', () => {
  it('picks the account in the asked currency, or none', () => {
    const eur = account({ currency: 'EUR', iban: IBAN });
    const gbp = account({ currency: 'GBP', sortCode: '123456', accountNumber: '12345678' });
    expect(accountInCurrency([gbp, eur], 'EUR')).toBe(eur);
    expect(accountInCurrency([gbp, eur], 'GBP')).toBe(gbp);
    expect(accountInCurrency([gbp, eur], 'CHF')).toBeNull();
    expect(accountInCurrency([], Currency.EUR)).toBeNull();
  });
});

describe('PAYMENT_METHOD_COPY', () => {
  it('names each method the way the chooser shows it', () => {
    expect(PAYMENT_METHOD_COPY.bank_transfer).toEqual({
      label: 'Bank transfer',
      hint: 'Copy the details into your banking app',
    });
    expect(PAYMENT_METHOD_COPY.epc_qr).toEqual({
      label: 'QR code',
      hint: 'For a banking app on another device',
    });
  });
});
