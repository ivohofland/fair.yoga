import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentQr } from './payment-qr';

const toDataURL = vi.hoisted(() => vi.fn(async (_payload: string) => 'data:image/png;base64,AAAA'));
vi.mock('qrcode', () => ({ default: { toDataURL } }));

const IBAN = 'NL91ABNA0417164300';

async function payloadFor(bic: string | null): Promise<string[]> {
  render(<PaymentQr iban={IBAN} bic={bic} beneficiary="I. Hofland" amount={12.5} currency="EUR" remittance="Vinyasa Saturday" />);
  await screen.findByRole('img');
  const payload = toDataURL.mock.calls.at(-1)?.[0];
  if (payload === undefined) throw new Error('no QR payload generated');
  return payload.split('\n');
}

describe('PaymentQr', () => {
  beforeEach(() => {
    toDataURL.mockClear();
  });

  it('encodes EPC version 002 with an empty BIC line when no BIC is stored', async () => {
    const lines = await payloadFor(null);
    expect(lines[0]).toBe('BCD');
    expect(lines[1]).toBe('002');
    expect(lines[4]).toBe('');
    expect(lines[6]).toBe(IBAN);
    expect(lines[7]).toBe('EUR12.50');
  });

  it('encodes EPC version 001 with the BIC when one is stored', async () => {
    const lines = await payloadFor('ABNANL2A');
    expect(lines[1]).toBe('001');
    expect(lines[4]).toBe('ABNANL2A');
    expect(lines[6]).toBe(IBAN);
  });
});
