'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { SettledNotice } from '@/components/ui/settled-notice';

interface MarkUnpaidButtonProps {
  paymentId: string;
}

/**
 * The permanent correction path on the payments overview: unlike the
 * transient in-the-moment Undo, this edits a settled record — so it
 * takes a second tap to confirm. The row returns to Outstanding on
 * refresh ('overdue' re-derives from age via the daily sweep).
 */
export function MarkUnpaidButton({ paymentId }: MarkUnpaidButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleUnpaid() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/payments/${paymentId}/unpaid`, { method: 'POST' });
      if (res.ok) {
        // #40. The refresh below normally replaces this row (the payment moves
        // Received → Outstanding) and this component unmounts, so `done` is
        // never seen. When the commit is dropped it is the only thing standing
        // between the teacher and a dead button: the action HAS committed, so
        // re-offering it would earn a 409 ("current status is 'pending'") over
        // an action that worked. Say what happened instead, and offer the
        // repaint that failed.
        setDone(true);
        router.refresh();
        return;
      }
      setError(await readErrorMessage(res, 'Could not update. Try again.'));
      setBusy(false);
    } catch {
      setError('Network error. Try again.');
      setBusy(false);
    }
  }

  if (done) {
    return (
      <SettledNotice label="Marked unpaid" actionLabel="Refresh" onAction={() => router.refresh()} />
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="type-caption text-brown min-h-[44px] px-1"
      >
        Mark unpaid
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleUnpaid}
        disabled={busy}
        className="type-caption text-danger font-medium min-h-[44px] px-1"
      >
        {busy ? 'Updating...' : 'Confirm unpaid'}
      </button>
      {/*
        #40. Deliberately NOT disabled by `busy`. `Keep` is a pure client-side
        state reset that touches no network, and it is the only way out of this
        confirm cluster if the request hangs rather than resolving — a case the
        settled state above cannot reach, because there is no success path yet.
        It cannot cancel an in-flight request; if that request later succeeds,
        the settled state renders, which is the honest outcome.
      */}
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="type-caption text-teal min-h-[44px] px-1"
      >
        Keep
      </button>
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </span>
  );
}
