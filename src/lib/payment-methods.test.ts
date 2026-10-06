import type { ComponentProps } from 'react';
import { describe, it, expect } from 'vitest';
import { Currency } from '@prisma/client';
import type { PaymentQr } from '@/components/student/payment-qr';
import {
  BANK_METHOD_CURRENCY,
  PAYMENT_METHOD_COPY,
  bankMethodsAvailable,
  nonBlank,
  paymentMethodsFor,
  type PaymentMethod,
} from './payment-methods';

const IBAN = 'NL91ABNA0417164300';

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

describe('bankMethodsAvailable', () => {
  it.each(Object.values(Currency))('answers for %s whether it is the bank-method currency', (currency) => {
    expect(bankMethodsAvailable(currency)).toBe(currency === 'EUR');
  });

  it('names the euro as the bank-method currency', () => {
    expect(BANK_METHOD_CURRENCY).toBe('EUR');
  });

  it('types a QR code and its component to the bank-method currency alone', () => {
    // @ts-expect-error a QR method in another currency does not compile
    const method: PaymentMethod = { kind: 'epc_qr', iban: IBAN, beneficiary: 'A', currency: 'GBP' };
    // @ts-expect-error nor does a QR component asked for one
    const qrCurrency: ComponentProps<typeof PaymentQr>['currency'] = 'GBP';
    expect([method.kind, qrCurrency]).toEqual(['epc_qr', 'GBP']);
  });
});

describe('paymentMethodsFor', () => {
  it.each(Object.values(Currency).filter((c) => c !== 'EUR'))('offers nothing for %s', (currency) => {
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: 'A' }, currency)).toEqual([]);
  });

  it('offers a bank transfer then a QR code when the IBAN and its holder name are both set', () => {
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: 'I. Hofland' }, 'EUR')).toEqual([
      { kind: 'bank_transfer', iban: IBAN, beneficiary: 'I. Hofland' },
      { kind: 'epc_qr', iban: IBAN, beneficiary: 'I. Hofland', currency: 'EUR' },
    ]);
  });

  it('offers nothing without an IBAN', () => {
    expect(paymentMethodsFor({ bankIban: null, bankAccountName: 'I. Hofland' }, 'EUR')).toEqual([]);
    expect(paymentMethodsFor({ bankIban: '', bankAccountName: 'I. Hofland' }, 'EUR')).toEqual([]);
    expect(paymentMethodsFor({ bankIban: '   ', bankAccountName: 'I. Hofland' }, 'EUR')).toEqual([]);
  });

  // Verification of Payee: a student's bank checks the name against the IBAN,
  // so a missing holder name is never stood in for by anything else.
  it('offers nothing with an IBAN but no holder name', () => {
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: null }, 'EUR')).toEqual([]);
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: '' }, 'EUR')).toEqual([]);
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: '  ' }, 'EUR')).toEqual([]);
  });

  // Any all-whitespace value is absent here, which is stricter than the
  // database's bank CHECKs (`docs/data-model.md`, Teacher).
  it('offers nothing for a tab-only or newline-only holder name or IBAN', () => {
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: '\t' }, 'EUR')).toEqual([]);
    expect(paymentMethodsFor({ bankIban: IBAN, bankAccountName: '\n' }, 'EUR')).toEqual([]);
    expect(paymentMethodsFor({ bankIban: '\t', bankAccountName: 'I. Hofland' }, 'EUR')).toEqual([]);
    expect(paymentMethodsFor({ bankIban: '\n', bankAccountName: 'I. Hofland' }, 'EUR')).toEqual([]);
  });

  // The trimmed name is the one a bank compares; a stray space must not become part of it.
  it('trims the IBAN and the holder name it hands out', () => {
    const [transfer] = paymentMethodsFor({ bankIban: ` ${IBAN} `, bankAccountName: '  I. Hofland  ' }, 'EUR');
    expect(transfer).toEqual({ kind: 'bank_transfer', iban: IBAN, beneficiary: 'I. Hofland' });
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
