'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { formatMoney } from '@/lib/format';
import type { EPC_QR_CURRENCY } from '@/lib/payment-methods';
import type { MethodAmount } from '@/lib/method-amount';
import { epcQrPayload } from '@/lib/epc-qr';

interface PaymentQrProps {
  iban: string;
  /** Encoded when present (EPC version 001); without it the payload is version 002. */
  bic: string | null;
  beneficiary: string;
  /** `open` for a gift: the payload and the alt text then name no amount. */
  amount: MethodAmount;
  /** The QR's currency, which the EPC format fixes. */
  currency: typeof EPC_QR_CURRENCY;
  remittance: string;
}

/**
 * EPC QR (the "Girocode" EU banking apps scan), built by `epcQrPayload`.
 * Generated client-side — no bank data leaves the page.
 */
export function PaymentQr({ iban, bic, beneficiary, amount, currency, remittance }: PaymentQrProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  // A string, so a caller passing a fresh `amount` object each render does not re-run the effect.
  const payload = epcQrPayload({ iban, bic, beneficiary, amount, currency, remittance });

  useEffect(() => {
    QRCode.toDataURL(payload, { margin: 1, width: 160, color: { dark: '#2D2D2D', light: '#F7F4EF' } })
      .then(setDataUrl)
      .catch((err: unknown) => {
        // The QR is progressive enhancement — hide it, but say why.
        console.error('[payment-qr] QR generation failed:', err);
        setDataUrl(null);
      });
  }, [payload]);

  const alt =
    amount.kind === 'fixed'
      ? `Payment QR: ${formatMoney(amount.amount, currency)} to ${beneficiary}`
      : `Payment QR to ${beneficiary}`;

  if (!dataUrl) return null;

  return (
    <div className="mt-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL, no optimization needed */}
      <img src={dataUrl} alt={alt} width={160} height={160} className="rounded-field border border-border" />
      <p className="type-caption mt-1">Scan with your banking app</p>
    </div>
  );
}
