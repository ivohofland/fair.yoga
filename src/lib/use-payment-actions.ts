'use client';

import { useState } from 'react';
import type { PaymentStatus } from '@prisma/client';
import { readErrorMessage } from '@/lib/client-errors';

/**
 * Requires *every* member of the enum: adding one to the schema breaks this
 * initializer until it is listed here, which is the point. A
 * `readonly PaymentStatus[]` would accept a subset silently.
 *
 * The values are hand-listed rather than derived from Prisma's runtime enum
 * export (which does exist) because this is a client module and every
 * `@prisma/client` import in a `'use client'` file in this repo is type-only —
 * a value import would be the first, and would risk pulling the Prisma runtime
 * into the browser bundle. The `Record` pin buys the drift protection instead.
 */
const PAYMENT_STATUSES: Record<PaymentStatus, true> = {
  pending: true,
  paid: true,
  overdue: true,
};

/**
 * A `Set`, not `Object.hasOwn`: `tsc` accepts `Object.hasOwn` here only because
 * `lib` includes `esnext`, while `target` is ES2017 and a library method is not
 * downleveled — the lib setting describes a runtime we have not committed to.
 * A Set also has no prototype keys, so 'constructor' cannot sneak through.
 */
const PAYMENT_STATUS_KEYS: ReadonlySet<string> = new Set(Object.keys(PAYMENT_STATUSES));

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === 'string' && PAYMENT_STATUS_KEYS.has(value);
}

/**
 * The undo endpoint returns the updated payment. Exported for its unit test.
 *
 * Falls back to 'pending' rather than throwing: the undo already succeeded on
 * the server by the time we get here, so refusing to update local state would
 * leave the row showing "Paid" for a payment that is not. 'pending' is what
 * `unmarkPaymentPaid` writes (services/payments.ts:97).
 */
export function readUndoStatus(json: unknown): PaymentStatus {
  if (json !== null && typeof json === 'object' && 'data' in json) {
    const data = json.data;
    if (
      data !== null &&
      typeof data === 'object' &&
      'status' in data &&
      isPaymentStatus(data.status)
    ) {
      return data.status;
    }
  }
  return 'pending';
}

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
        const json: unknown = await res.json();
        setPaymentState((prev) => ({ ...prev, [paymentId]: readUndoStatus(json) }));
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
