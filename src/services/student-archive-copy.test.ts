/**
 * The archive refusal copy, tested as copy: these assert text because the
 * text is what the functions under test produce. API responses carrying it
 * are asserted by code elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  owedPhrase,
  unbilledRefusal,
  outstandingRefusal,
  outstandingChangedRefusal,
  type OpenPayment,
} from './student-archive-copy';

function owed(...amounts: string[]): OpenPayment[] {
  return amounts.map((amount, i) => ({ id: `p${i}`, amount: new Prisma.Decimal(amount) }));
}

describe('owedPhrase', () => {
  it('names one payment in the singular', () => {
    expect(owedPhrase(owed('12.50'))).toBe('€12.50 across 1 payment');
  });

  it('names several in the plural, summed', () => {
    expect(owedPhrase(owed('12.50', '7.25'))).toBe('€19.75 across 2 payments');
  });

  // 0.1 + 0.2 is 0.30000000000000004 as floats; the total still reads €0.30.
  it('sums as decimals: 0.10 + 0.20 is €0.30', () => {
    expect(owedPhrase(owed('0.10', '0.20'))).toBe('€0.30 across 2 payments');
  });

  it('keeps every cent of a large total', () => {
    expect(owedPhrase(owed('99999999.99', '99999999.99', '0.01'))).toBe('€199999999.99 across 3 payments');
  });
});

describe('unbilledRefusal', () => {
  it('singular', () => {
    expect(unbilledRefusal(1)).toEqual({
      code: 'STUDENT_HAS_UNBILLED_CLASSES',
      status: 409,
      message: "This student is booked on 1 class that hasn't been billed yet. Remove them from it, or archive once it's completed.",
    });
  });

  it('plural', () => {
    expect(unbilledRefusal(3).message).toBe(
      "This student is booked on 3 classes that haven't been billed yet. Remove them from those classes, or archive once they're completed.",
    );
  });
});

describe('outstandingRefusal', () => {
  it('singular: tells the teacher how to waive it', () => {
    expect(outstandingRefusal(owed('20.00'))).toEqual({
      code: 'STUDENT_HAS_OUTSTANDING_PAYMENTS',
      status: 409,
      message: 'This student still owes €20.00 across 1 payment. Tap Archive student again to waive it and archive.',
    });
  });

  it('plural', () => {
    expect(outstandingRefusal(owed('20.00', '0.10', '0.20')).message).toBe(
      'This student still owes €20.30 across 3 payments. Tap Archive student again to waive them and archive.',
    );
  });
});

describe('outstandingChangedRefusal', () => {
  it('names the new total', () => {
    expect(outstandingChangedRefusal(owed('30.00', '20.00'))).toEqual({
      code: 'STUDENT_HAS_OUTSTANDING_PAYMENTS',
      status: 409,
      message: 'What this student owes has changed — now €50.00 across 2 payments. Check it and try again.',
    });
  });

  it('singular', () => {
    expect(outstandingChangedRefusal(owed('30.00')).message).toBe(
      'What this student owes has changed — now €30.00 across 1 payment. Check it and try again.',
    );
  });

  it('the zero form, when everything named was settled meanwhile', () => {
    expect(outstandingChangedRefusal([]).message).toBe(
      'What this student owes has changed — nothing is outstanding now. Try again.',
    );
  });
});
