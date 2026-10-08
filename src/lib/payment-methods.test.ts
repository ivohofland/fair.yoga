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
  hasAccountInCurrency,
  hasPayoutDetails,
  nonBlank,
  paymentMethodsFor,
  paymentMethodsForTeacher,
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

const LINK = 'https://revolut.me/anna';
const LINK_METHOD = { kind: 'payment_link', url: LINK, host: 'revolut.me' } as const;

/** `paymentMethodsFor` for the fixed test teacher, given the stored account and link. */
function methodsFor(stored: StoredBankAccount | null, paymentLink: string | null = null): PaymentMethod[] {
  return paymentMethodsFor({ teacherId: TEACHER_ID, account: stored, paymentLink });
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
    expect(methodsFor(null)).toEqual([]);
  });

  it('offers a euro account a bank transfer then a QR code, with a null BIC when none is stored', () => {
    expect(methodsFor(account({ currency: 'EUR', iban: IBAN }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'sepa', iban: IBAN, bic: null } },
      { kind: 'epc_qr', beneficiary: HOLDER, iban: IBAN, bic: null, currency: 'EUR' },
    ]);
  });

  it('carries a stored BIC into both euro methods', () => {
    expect(methodsFor(account({ currency: 'EUR', iban: IBAN, bic: 'ABNANL2A' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'sepa', iban: IBAN, bic: 'ABNANL2A' } },
      { kind: 'epc_qr', beneficiary: HOLDER, iban: IBAN, bic: 'ABNANL2A', currency: 'EUR' },
    ]);
  });

  it('offers a pound account a sort-code transfer and no QR code', () => {
    expect(methodsFor(account({ currency: 'GBP', sortCode: '123456', accountNumber: '12345678' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'uk', sortCode: '123456', accountNumber: '12345678' } },
    ]);
  });

  it('offers a dollar account a routing-number transfer and no QR code', () => {
    expect(methodsFor(account({ currency: 'USD', routingNumber: '021000021', accountNumber: '1234567' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'us', routingNumber: '021000021', accountNumber: '1234567' } },
    ]);
  });

  it.each(['CHF', 'SEK', 'NOK', 'DKK'] as const)('offers a %s account an IBAN transfer and no QR code', (currency) => {
    expect(methodsFor(account({ currency, iban: 'CH9300762011623852957' }))).toEqual([
      { kind: 'bank_transfer', beneficiary: HOLDER, details: { scheme: 'iban', iban: 'CH9300762011623852957', bic: null } },
    ]);
  });

  // The trimmed name is the one a bank compares; a stray space must not become part of it.
  it('trims the holder name it hands out', () => {
    const [transfer] = methodsFor(account({ currency: 'EUR', iban: IBAN, holderName: '  I. Hofland  ' }));
    expect(transfer).toMatchObject({ beneficiary: HOLDER });
  });

  it('offers nothing for, and logs with its teacher and row, a row the CHECK should have made impossible', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => error.mockRestore());
    expect(methodsFor(account({ currency: 'GBP', iban: IBAN, id: 'acct-gbp' }))).toEqual([]);
    expect(methodsFor(account({ currency: 'EUR', iban: IBAN, holderName: '  ', id: 'acct-eur' }))).toEqual([]);
    expect(error.mock.calls.map(([context]) => context)).toEqual([
      { teacherId: TEACHER_ID, accountId: 'acct-gbp', currency: 'GBP' },
      { teacherId: TEACHER_ID, accountId: 'acct-eur', currency: 'EUR' },
    ]);
  });

  it('offers a link alone when there is no account', () => {
    expect(methodsFor(null, LINK)).toEqual([LINK_METHOD]);
  });

  it('puts the link after a euro account\'s transfer and QR code', () => {
    expect(methodsFor(account({ currency: 'EUR', iban: IBAN }), LINK).map((m) => m.kind)).toEqual([
      'bank_transfer',
      'epc_qr',
      'payment_link',
    ]);
  });

  it('puts the link after a pound account\'s transfer', () => {
    const stored = account({ currency: 'GBP', sortCode: '123456', accountNumber: '12345678' });
    expect(methodsFor(stored, LINK).map((m) => m.kind)).toEqual(['bank_transfer', 'payment_link']);
  });

  it('still offers the link beside an account that does not parse, and logs the account', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => error.mockRestore());
    expect(methodsFor(account({ currency: 'GBP', iban: IBAN, id: 'acct-gbp' }), LINK)).toEqual([LINK_METHOD]);
    expect(error.mock.calls.map(([context]) => context)).toEqual([
      { teacherId: TEACHER_ID, accountId: 'acct-gbp', currency: 'GBP' },
    ]);
  });

  it('offers the bank methods alone, and logs the teacher and why, when the stored link does not parse', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => error.mockRestore());
    const stored = 'http://pay.example/anna';
    expect(methodsFor(account({ currency: 'EUR', iban: IBAN }), stored).map((m) => m.kind)).toEqual([
      'bank_transfer',
      'epc_qr',
    ]);
    expect(error).toHaveBeenCalledWith(
      { teacherId: TEACHER_ID, reason: 'not_https', length: stored.length },
      'stored payment link does not parse; offering no link',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('pay.example');
  });

  it('offers nothing with neither an account nor a link', () => {
    expect(methodsFor(null, null)).toEqual([]);
  });
});

describe('paymentMethodsForTeacher', () => {
  it('picks the account in the given currency and includes the link', () => {
    const eur = account({ currency: 'EUR', iban: IBAN });
    const gbp = account({ currency: 'GBP', sortCode: '123456', accountNumber: '12345678' });
    const teacher = { id: TEACHER_ID, paymentLink: LINK, bankAccounts: [eur, gbp] };
    expect(paymentMethodsForTeacher(teacher, 'GBP').map((m) => m.kind)).toEqual(['bank_transfer', 'payment_link']);
    expect(paymentMethodsForTeacher(teacher, 'EUR').map((m) => m.kind)).toEqual([
      'bank_transfer',
      'epc_qr',
      'payment_link',
    ]);
    expect(paymentMethodsForTeacher(teacher, 'CHF')).toEqual([LINK_METHOD]);
  });
});

describe('hasPayoutDetails', () => {
  const eur = { currency: Currency.EUR };

  it('is true for an account in the current currency', () => {
    expect(hasPayoutDetails({ currency: 'EUR', paymentLink: null, bankAccounts: [eur] })).toBe(true);
  });

  it('is true for a link alone', () => {
    expect(hasPayoutDetails({ currency: 'EUR', paymentLink: LINK, bankAccounts: [] })).toBe(true);
  });

  it('is false for an account only in another currency and no link', () => {
    expect(hasPayoutDetails({ currency: 'GBP', paymentLink: null, bankAccounts: [eur] })).toBe(false);
  });

  it('is false for neither', () => {
    expect(hasPayoutDetails({ currency: 'EUR', paymentLink: null, bankAccounts: [] })).toBe(false);
  });

  it('counts a stored link that does not parse as no link', () => {
    expect(hasPayoutDetails({ currency: 'EUR', paymentLink: 'http://x', bankAccounts: [] })).toBe(false);
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

describe('hasAccountInCurrency', () => {
  it('answers whether the accounts include one in the asked currency', () => {
    const accounts = [{ currency: Currency.GBP }, { currency: Currency.EUR }];
    expect(hasAccountInCurrency(accounts, 'EUR')).toBe(true);
    expect(hasAccountInCurrency(accounts, 'GBP')).toBe(true);
    expect(hasAccountInCurrency(accounts, 'CHF')).toBe(false);
    expect(hasAccountInCurrency([], 'EUR')).toBe(false);
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
    expect(PAYMENT_METHOD_COPY.payment_link).toEqual({
      label: 'Payment link',
      hint: 'Pay in the app the link opens',
    });
  });
});
