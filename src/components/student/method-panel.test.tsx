import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { log } from '@/lib/log';
import type { PaymentMethod } from '@/lib/payment-methods';
import { MethodPanel } from './method-panel';

const toDataURL = vi.hoisted(() => vi.fn(async (_payload: string) => 'data:image/png;base64,AAAA'));
vi.mock('qrcode', () => ({ default: { toDataURL } }));

const IBAN = 'NL91ABNA0417164300';
const BANK: PaymentMethod = { kind: 'bank_transfer', beneficiary: 'I. Hofland', details: { scheme: 'sepa', iban: IBAN, bic: null } };
const EPC: PaymentMethod = { kind: 'epc_qr', beneficiary: 'I. Hofland', iban: IBAN, bic: null, currency: 'EUR' };
const LINK: PaymentMethod = { kind: 'payment_link', url: 'https://pay.example/anna', host: 'pay.example' };

describe('MethodPanel', () => {
  beforeEach(() => {
    toDataURL.mockClear();
  });

  it.each([BANK, EPC, LINK])('names no amount for an open $kind panel (#912)', async (method) => {
    const { container } = render(<MethodPanel method={method} amount={{ kind: 'open' }} currency="EUR" reference="Vinyasa Saturday" />);
    if (method.kind === 'epc_qr') await screen.findByRole('img');
    expect(container.textContent).not.toMatch(/€|\d+[.,]\d{2}/);
  });

  it('names the amount on a fixed bank transfer panel (#912)', () => {
    const { container } = render(
      <MethodPanel method={BANK} amount={{ kind: 'fixed', amount: 12.5 }} currency="EUR" reference="Vinyasa Saturday" paymentId="p1" />,
    );
    expect(container.textContent).toContain('€12.50');
  });

  it('(#912) an open amount admits no processor method, and one forced through renders nothing', () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const { container } = render(
      // @ts-expect-error -- the open arm's method is a `GiftMethod`, which has no processor kind.
      <MethodPanel method={{ kind: 'processor', method: 'ideal' }} amount={{ kind: 'open' }} currency="EUR" reference="r" />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(error).toHaveBeenCalledWith({ kind: 'processor' }, 'pay page: unhandled payment method kind');
    error.mockRestore();
  });
});
