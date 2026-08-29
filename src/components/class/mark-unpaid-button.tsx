'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';
import { SettledNotice } from '@/components/ui/settled-notice';

interface MarkUnpaidButtonProps {
  paymentId: string;
  studentName: string;
  classContext: string;
}

/**
 * The permanent correction path on the payments overview: unlike the
 * transient in-the-moment Undo, this edits a settled record — so it
 * takes a second tap to confirm. The row returns to Outstanding on
 * refresh ('overdue' re-derives from age via the daily sweep).
 */
export function MarkUnpaidButton({
  paymentId,
  studentName,
  classContext,
}: MarkUnpaidButtonProps) {
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

  /**
   * #40, PR #198 review P3/P4. The escape from the confirm cluster, and
   * deliberately never disabled by `busy`: it touches no network, and it is
   * the only way out if the POST hangs rather than resolving — a case the
   * settled state cannot reach, because there is no success path yet.
   *
   * It resets the whole cluster, not only `confirming`. Leaving `busy` and
   * `error` standing moved the freeze instead of lifting it: a hung POST kept
   * `busy` true with nothing left to clear it, so the next "Mark unpaid"
   * reopened a confirm whose only action read "Updating…" and was disabled;
   * and a failed attempt's red message came back with it, attached to a fresh
   * click the teacher had not yet made.
   *
   * What it cannot do is recall the request — this is a state reset, not an
   * abort. If the abandoned POST later succeeds, `done` renders the settled
   * state (checked above the `confirming` branch precisely so it wins over
   * this reset); if it later fails, its message is set on a cluster the
   * teacher has already left. Both are the honest report of what the server
   * did, not a promise that leaving the confirm undid it.
   */
  function handleKeep() {
    setConfirming(false);
    setBusy(false);
    setError('');
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
        aria-label={`Mark unpaid — ${studentName}, ${classContext}`}
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
        aria-label={
          busy
            ? `Updating... — ${studentName}, ${classContext}`
            : `Confirm unpaid — ${studentName}, ${classContext}`
        }
        className="type-caption text-danger font-medium min-h-[44px] px-1"
      >
        {busy ? 'Updating...' : 'Confirm unpaid'}
      </button>
      {/* Never disabled by `busy` — see `handleKeep` for why, and for what
          the reset does and does not guarantee. */}
      <button
        type="button"
        onClick={handleKeep}
        aria-label={`Keep — ${studentName}, ${classContext}`}
        className="type-caption text-teal min-h-[44px] px-1"
      >
        Keep
      </button>
      {error && <span className="text-[13px] text-danger">{error}</span>}
    </span>
  );
}
