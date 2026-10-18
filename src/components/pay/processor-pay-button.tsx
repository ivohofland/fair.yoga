'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import type { AllowedMollieMethod } from '@/lib/processor-methods';

interface ProcessorPayButtonProps {
  paymentId: string;
  method: AllowedMollieMethod;
  /** The method's name as the student reads it. */
  label: string;
}

const UNAVAILABLE = 'Paying online isn’t available right now. Try again, or choose another way to pay.';

/**
 * Starts a Mollie payment by `method` and sends the browser to its checkout.
 * A refusal, a network error or an answer that does not parse shows beneath
 * the button, which can then be pressed again; so can a page restored from
 * the back-forward cache after leaving for the checkout.
 */
export function ProcessorPayButton({ paymentId, method, label }: ProcessorPayButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) setBusy(false);
    }
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

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
    let checkoutUrl: unknown;
    try {
      checkoutUrl = ((await res.json()) as { data?: { checkoutUrl?: unknown } }).data?.checkoutUrl;
    } catch (err) {
      logRequestFailure('processor-pay-button', { paymentId, method }, err);
    }
    if (typeof checkoutUrl !== 'string') {
      setError(UNAVAILABLE);
      setBusy(false);
      return;
    }
    // Left busy: the page is about to be replaced by the checkout.
    window.location.assign(checkoutUrl);
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
