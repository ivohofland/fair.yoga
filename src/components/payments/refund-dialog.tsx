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

/** Each choice's label, in the order the sheet offers them. */
const OUTCOME_LABEL = {
  waive: 'Refund and waive',
  ask_again: 'Refund and ask again',
} as const satisfies Record<RefundChoice, string>;
const OUTCOMES = (Object.keys(OUTCOME_LABEL) as RefundChoice[]).map((value) => ({ value, label: OUTCOME_LABEL[value] }));

/** The refund status of a `{ data: { refundStatus } }` answer, or null when absent or unreadable. */
function readRefundStatus(json: unknown): ProcessorRefundStatus | null {
  if (typeof json !== 'object' || json === null || !('data' in json)) return null;
  const { data } = json;
  if (typeof data !== 'object' || data === null || !('refundStatus' in data)) return null;
  return isRefundStatus(data.refundStatus) ? data.refundStatus : null;
}

/**
 * Refunds one Mollie attempt in full. For the attempt that settled the
 * payment the teacher first chooses its outcome — waive it, or ask again —
 * and both apply once Mollie reports the refund done; a duplicate's refund
 * changes no payment and offers no choice. The sheet cannot be dismissed
 * while the request is in flight, so its answer is always seen.
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
  const [choice, setChoice] = useState<RefundChoice | null>(null);
  const money = formatMoney(amount, currency);

  async function refund(sent: RefundChoice | null) {
    setBusy(true);
    setError('');
    let res: Response;
    try {
      res = await fetch(`/api/payments/${paymentId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId, choice: sent }),
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
    <Sheet title={`Refund ${money}`} onClose={onClose} dismissible={!busy}>
      <p className="type-body mb-5">
        {money} goes back to {studentName} from your Mollie balance.
      </p>
      {settles && (
        <fieldset className="mb-5 flex flex-col">
          <legend className="sr-only">What becomes of the payment</legend>
          {OUTCOMES.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-3 min-h-11 type-body">
              <input
                type="radio"
                name="refund-outcome"
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                disabled={busy}
                className="h-5 w-5 accent-teal"
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="type-label text-danger mb-4">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-3">
        {settles ? (
          <Button onClick={() => refund(choice)} disabled={busy || choice === null}>
            Refund {money}
          </Button>
        ) : (
          <Button onClick={() => refund(null)} disabled={busy}>
            Refund duplicate payment
          </Button>
        )}
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Sheet>
  );
}
