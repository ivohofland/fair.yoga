'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import type { AllowedMollieMethod } from '@/lib/processor-methods';

interface ProcessorPayButtonProps {
  paymentId: string;
  method: AllowedMollieMethod;
  /** The method's name as the student reads it. */
  label: string;
}

/**
 * Starts a Mollie payment by `method` and sends the browser to its checkout.
 * A refusal or a network error shows beneath the button, which can then be
 * pressed again.
 */
export function ProcessorPayButton({ paymentId, method, label }: ProcessorPayButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    let res: Response;
    try {
      res = await fetch(`/api/payments/${paymentId}/processor-attempt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method }),
      });
    } catch (err) {
      logRequestFailure('processor-pay-button', { paymentId, method }, err);
      setError('Network error. Try again.');
      setBusy(false);
      return;
    }
    if (!res.ok) {
      setError(await readErrorMessage(res, 'Couldn’t open the payment. Try again.'));
      setBusy(false);
      return;
    }
    const json = (await res.json()) as { data: { checkoutUrl: string } };
    // Left busy: the page is about to be replaced by the checkout.
    window.location.assign(json.data.checkoutUrl);
  }

  return (
    <div>
      <Button type="button" disabled={busy} onClick={() => void pay()}>
        {busy ? `Opening ${label}…` : `Pay with ${label}`}
      </Button>
      <p role="status" className="type-caption text-danger mt-1">
        {error ?? ''}
      </p>
    </div>
  );
}
