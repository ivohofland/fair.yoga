'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatMoney } from '@/lib/format';
import type { EPC_QR_CURRENCY } from '@/lib/payment-methods';

interface PaymentQrProps {
  iban: string;
  /** Encoded when present (EPC version 001); without it the payload is version 002. */
  bic: string | null;
  beneficiary: string;
  amount: number;
  /** The QR's currency, which the EPC format fixes. */
  currency: typeof EPC_QR_CURRENCY;
  remittance: string;
}

/**
 * EPC QR (the "Girocode" EU banking apps scan): beneficiary, IBAN, amount,
 * and a remittance line. Generated client-side — no bank data leaves the page.
 */
export function PaymentQr({ iban, bic, beneficiary, amount, currency, remittance }: PaymentQrProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const payload = [
      'BCD',
      bic === null ? '002' : '001',
      '1',
      'SCT',
      bic ?? '',
      beneficiary.slice(0, 70),
      iban.replace(/\s/g, ''),
      `${currency}${amount.toFixed(2)}`,
      '',
      '',
      remittance.slice(0, 140),
    ].join('\n');

    QRCode.toDataURL(payload, { margin: 1, width: 160, color: { dark: '#2D2D2D', light: '#F7F4EF' } })
      .then(setDataUrl)
      .catch((err: unknown) => {
        // The QR is progressive enhancement — hide it, but say why.
        console.error('[payment-qr] QR generation failed:', err);
        setDataUrl(null);
      });
  }, [iban, bic, beneficiary, amount, currency, remittance]);

  if (!dataUrl) return null;

  return (
    <div className="mt-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL, no optimization needed */}
      <img src={dataUrl} alt={`Payment QR: ${formatMoney(amount, currency)} to ${beneficiary}`} width={160} height={160} className="rounded-field border border-border" />
      <p className="type-caption mt-1">Scan with your banking app</p>
    </div>
  );
}
