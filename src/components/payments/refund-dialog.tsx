'use client';

import { useState } from 'react';
import type { Currency, ProcessorRefundStatus } from '@/lib/prisma-client';
import { formatMoney } from '@/lib/format';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import { isRefundStatus } from '@/lib/processor-attempt-view';
import type { RefundChoice } from '@/services/processor-refunds';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';

interface RefundDialogProps {
  paymentId: string;
  attemptId: string;
  amount: number;
  /** The attempt's own currency: what Mollie charged. */
  currency: Currency;
  studentName: string;
  /** Whether the attempt settled the payment, so the teacher chooses what becomes of it. */
  settles: boolean;
  onClose: () => void;
  /** The refund was accepted; its status as Mollie answered it. */
  onRequested: (status: ProcessorRefundStatus) => void;
}

/** The refund status of a `{ data: { refundStatus } }` answer, or null when absent or unreadable. */
function readRefundStatus(json: unknown): ProcessorRefundStatus | null {
  if (typeof json !== 'object' || json === null || !('data' in json)) return null;
  const { data } = json;
  if (typeof data !== 'object' || data === null || !('refundStatus' in data)) return null;
  return isRefundStatus(data.refundStatus) ? data.refundStatus : null;
}

/**
 * Refunds one Mollie attempt in full. For the attempt that settled the
 * payment the teacher chooses its outcome — waive it, or ask again — and
 * both apply once Mollie reports the refund done; a duplicate's refund
 * changes no payment and offers no choice.
 */
export function RefundDialog({
  paymentId,
  attemptId,
  amount,
  currency,
  studentName,
  settles,
  onClose,
  onRequested,
}: RefundDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refund(choice: RefundChoice | null) {
    setBusy(true);
    setError('');
    let res: Response;
    try {
      res = await fetch(`/api/payments/${paymentId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId, choice }),
      });
    } catch (err) {
      logRequestFailure('refund-dialog', { paymentId }, err);
      setError('Network error. Try again.');
      setBusy(false);
      return;
    }
    if (!res.ok) {
      setError(await readErrorMessage(res, 'The refund didn’t go through. Try again.'));
      setBusy(false);
      return;
    }
    // The refund was accepted whatever the body says; an unreadable one is shown as pending.
    let json: unknown = null;
    try {
      json = await res.json();
    } catch (err) {
      logRequestFailure('refund-dialog', { paymentId }, err);
    }
    onRequested(readRefundStatus(json) ?? 'queued');
  }

  return (
    <Sheet title={`Refund ${formatMoney(amount, currency)}`} onClose={onClose}>
      <p className="type-body mb-5">
        {formatMoney(amount, currency)} goes back to {studentName} from your Mollie balance.
      </p>
      {error && (
        <p role="alert" className="type-label text-danger mb-4">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3">
        {settles ? (
          <>
            <Button onClick={() => refund('waive')} disabled={busy}>
              Refund and waive
            </Button>
            <Button variant="secondary" onClick={() => refund('ask_again')} disabled={busy}>
              Refund and ask again
            </Button>
          </>
        ) : (
          <Button onClick={() => refund(null)} disabled={busy}>
            Refund duplicate payment
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
