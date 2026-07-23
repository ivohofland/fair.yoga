'use client';

import { useState } from 'react';
import { readErrorMessage } from '@/lib/client-errors';

/**
 * Mark-paid with transient undo. "Mark paid" is the app's most repeated
 * action, so it stays one tap — no confirm. The safety net is Undo,
 * offered only for payments marked paid in this session (justMarked):
 * old paid records keep a clean row and can't be unmarked casually.
 * Undo returns the payment to 'pending'; the daily dunning sweep
 * re-derives 'overdue' from the payment's age where applicable.
 */
export function usePaymentActions(initial: Record<string, string>) {
  const [paymentState, setPaymentState] = useState<Record<string, string>>(initial);
  const [justMarked, setJustMarked] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function markPaid(paymentId: string) {
    setUpdating(paymentId);
    setError('');
    try {
      const res = await fetch(`/api/payments/${paymentId}/paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'manual' }),
      });
      if (res.ok) {
        setPaymentState((prev) => ({ ...prev, [paymentId]: 'paid' }));
        setJustMarked((prev) => new Set(prev).add(paymentId));
      } else {
        setError(await readErrorMessage(res, 'Could not mark as paid. Try again.'));
      }
    } catch {
      setError('Network error. Try again.');
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
      const res = await fetch(`/api/payments/${paymentId}/unpaid`, { method: 'POST' });
      if (res.ok) {
        const json = (await res.json()) as { data: { status: string } };
        setPaymentState((prev) => ({ ...prev, [paymentId]: json.data.status }));
        setJustMarked((prev) => {
          const next = new Set(prev);
          next.delete(paymentId);
          return next;
        });
        return true;
      }
      setError(await readErrorMessage(res, 'Could not undo. Try again.'));
      return false;
    } catch {
      setError('Network error. Try again.');
      return false;
    } finally {
      setUpdating(null);
    }
  }

  return { paymentState, justMarked, updating, error, markPaid, undo };
}
