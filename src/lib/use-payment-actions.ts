'use client';

import { useState } from 'react';
import type { PaymentStatus } from '@prisma/client';
import { readErrorMessage } from '@/lib/client-errors';
import { readUndoStatus } from '@/lib/payment-status';

/**
 * Mark-paid with transient undo. "Mark paid" is the app's most repeated
 * action, so it stays one tap — no confirm. The safety net is Undo,
 * offered only for payments marked paid in this session (justMarked):
 * old paid records keep a clean row and can't be unmarked casually.
 * Undo returns the payment to 'pending'; the daily dunning sweep
 * re-derives 'overdue' from the payment's age where applicable.
 */
export function usePaymentActions(initial: Record<string, PaymentStatus>) {
  const [paymentState, setPaymentState] = useState<Record<string, PaymentStatus>>(initial);
  const [justMarked, setJustMarked] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function markPaid(paymentId: string) {
    setUpdating(paymentId);
    setError('');
    try {
      // Only the request itself is wrapped, so 'Network error' means exactly
      // that. In the !res.ok branch, readErrorMessage handles extracting
      // the server's error message or falling back to a generic copy without
      // falsely claiming the network failed.
      let res: Response;
      try {
        res = await fetch(`/api/payments/${paymentId}/paid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'manual' }),
        });
      } catch (err) {
        console.error('[payment-mark-paid] request failed', { paymentId, err });
        setError('Network error. Try again.');
        return;
      }

      if (res.ok) {
        setPaymentState((prev) => ({ ...prev, [paymentId]: 'paid' }));
        setJustMarked((prev) => new Set(prev).add(paymentId));
      } else {
        setError(await readErrorMessage(res, 'Could not mark as paid. Try again.'));
      }
    } finally {
      setUpdating(null);
    }
  }

  // Returns whether the undo succeeded, so a caller that refreshes on success
  // (the payments overview) can keep a failed undo's error on screen instead
  // of refreshing the row — and its error — away.
  async function undo(paymentId: string): Promise<boolean> {
    setUpdating(paymentId);
    setError('');
    try {
      // Only the request itself is wrapped, so 'Network error' means exactly
      // that. It used to wrap the body read as well: an `ok` response whose
      // body did not parse — a proxy error page, a truncation on flaky wifi —
      // was reported as a network failure and returned false, while the server
      // had already written 'pending'. The row kept "✓ Paid" and its Undo
      // button, and because `isOutstanding` derives from the same stale value,
      // the reminder button stayed hidden for a debt that now really existed.
      let res: Response;
      try {
        res = await fetch(`/api/payments/${paymentId}/unpaid`, { method: 'POST' });
      } catch (err) {
        console.error('[payment-undo] request failed', { paymentId, err });
        setError('Network error. Try again.');
        return false;
      }

      if (!res.ok) {
        setError(await readErrorMessage(res, 'Could not undo. Try again.'));
        return false;
      }

      // Past this point the undo HAS happened — same principle as
      // `send-reminder-button.tsx`, which commits before it responds too. An
      // unreadable body must not be dressed up as a failure or leave the UI in
      // its pre-action state; it is logged and the local state resolves to
      // 'pending', which is what `unmarkPaymentPaid` writes
      // (services/payments.ts:97). Returning true lets the caller's
      // `router.refresh()` reconcile against the server's real value.
      //
      // Deliberately not surfaced in `error`: the undo succeeded, and alarming
      // the teacher about a body they cannot act on would be wrong.
      let status: PaymentStatus | null;
      try {
        const json: unknown = await res.json();
        status = readUndoStatus(json);
        if (status === null) {
          console.error('[payment-undo] undone, but the response shape was unreadable', {
            paymentId,
          });
        }
      } catch (err) {
        status = null;
        console.error('[payment-undo] undone, but the response body was unreadable', {
          paymentId,
          err,
        });
      }

      setPaymentState((prev) => ({ ...prev, [paymentId]: status ?? 'pending' }));
      setJustMarked((prev) => {
        const next = new Set(prev);
        next.delete(paymentId);
        return next;
      });
      return true;
    } finally {
      setUpdating(null);
    }
  }

  return { paymentState, justMarked, updating, error, markPaid, undo };
}
