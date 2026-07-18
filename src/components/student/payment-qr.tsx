'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface PaymentQrProps {
  iban: string;
  beneficiary: string;
  amount: number;
  remittance: string;
}

/**
 * EPC QR (the "Girocode" EU banking apps scan): beneficiary, IBAN, amount,
 * and a remittance line. Generated client-side — no bank data leaves the page.
 */
export function PaymentQr({ iban, beneficiary, amount, remittance }: PaymentQrProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    const payload = [
      'BCD',
      '002',
      '1',
      'SCT',
      '', // BIC — optional since EPC v2
      beneficiary.slice(0, 70),
      iban.replace(/\s/g, ''),
      `EUR${amount.toFixed(2)}`,
      '',
      '',
      remittance.slice(0, 140),
    ].join('\n');

    QRCode.toDataURL(payload, { margin: 1, width: 160, color: { dark: '#2D2D2D', light: '#F7F4EF' } })
      .then(setDataUrl)
      .catch(() => setDataUrl(null));
  }, [iban, beneficiary, amount, remittance]);

  if (!dataUrl) return null;

  return (
    <div className="mt-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- data URL, no optimization needed */}
      <img src={dataUrl} alt={`Payment QR: €${amount.toFixed(2)} to ${beneficiary}`} width={160} height={160} className="rounded-field border border-border" />
      <p className="type-caption mt-1">Scan with your banking app</p>
    </div>
  );
}
