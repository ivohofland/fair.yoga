import { describe, it, expect } from 'vitest';
import { epcQrPayload } from './epc-qr';

const BASE = { iban: 'NL91 ABNA 0417 1643 00', bic: null, beneficiary: 'I. Hofland', currency: 'EUR' as const, remittance: 'Vinyasa Saturday' };

describe('epcQrPayload', () => {
  it('encodes a fixed amount on line 8 (#912)', () => {
    const lines = epcQrPayload({ ...BASE, amount: { kind: 'fixed', amount: 12.5 } }).split('\n');
    expect(lines[7]).toBe('EUR12.50');
    expect(lines[6]).toBe('NL91ABNA0417164300');
  });
  it('leaves the amount line empty for an open amount, keeping every other line (#912)', () => {
    const lines = epcQrPayload({ ...BASE, amount: { kind: 'open' } }).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[7]).toBe('');
    expect(lines[10]).toBe('Vinyasa Saturday');
  });
});
