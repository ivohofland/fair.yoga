'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';

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

  async function handleUnpaid() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/payments/${paymentId}/unpaid`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not update. Try again.'));
        setBusy(false);
      }
    } catch {
      setError('Network error. Try again.');
      setBusy(false);
    }
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
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="type-caption text-teal min-h-[44px] px-1"
      >
        Keep
      </button>
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </span>
  );
}
