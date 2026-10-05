'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getOutboxSnapshot } from '@/lib/attendance-outbox';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import { flushWithinBound } from '@/lib/flush-within-bound';

interface CompleteClassButtonProps {
  classId: string;
  chargedCount: number;
  /**
   * The account whose queued attendance is synced before finishing. With it,
   * a mark for this class still unsynced after the flush — queued, or refused
   * once the outbox stopped retrying it — is named in an inline confirm before
   * completion is posted; without it, Finish posts straight away.
   */
  outboxOwner?: string;
}

function unsyncedCopy(count: number): string {
  return count === 1
    ? "1 attendance change for this class hasn't synced."
    : `${count} attendance changes for this class haven't synced.`;
}

function confirmCopy(chargedCount: number): string {
  if (chargedCount === 0) {
    return 'Finish class? No one is charged for this class.';
  }
  if (chargedCount === 1) {
    return 'Finish class? A payment request goes to 1 student now.';
  }
  return `Finish class? Payment requests go to ${chargedCount} students now.`;
}

export function CompleteClassButton({ classId, chargedCount, outboxOwner }: CompleteClassButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [unsynced, setUnsynced] = useState<number | null>(null);
  const reasonId = useId();
  const askingUnsynced = unsynced !== null;
  const finishClassRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasAskingUnsynced = useRef(false);

  // The control that had focus unmounts as the confirm replaces it, and back:
  // focus follows onto Cancel, and back onto Finish class.
  useEffect(() => {
    if (askingUnsynced) cancelRef.current?.focus();
    else if (wasAskingUnsynced.current) finishClassRef.current?.focus();
    wasAskingUnsynced.current = askingUnsynced;
  }, [askingUnsynced]);

  async function handleFinish() {
    setSubmitting(true);
    setError('');
    if (outboxOwner !== undefined) {
      await flushWithinBound(outboxOwner, 'complete-class-button');
      // A mark the server refused is not counted: it answered that one. A mark
      // the outbox gave up retrying is: the server may never have seen it.
      const { queued, refused } = getOutboxSnapshot(outboxOwner);
      const left =
        queued.filter((entry) => entry.classId === classId).length +
        refused.filter((entry) => entry.classId === classId && entry.kind === 'retries-exhausted').length;
      if (left > 0) {
        setUnsynced(left);
        setSubmitting(false);
        return;
      }
    }
    await handleComplete();
  }

  function handleCancelUnsynced() {
    setUnsynced(null);
    setConfirming(false);
  }

  async function handleComplete() {
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch(`/api/classes/${classId}/complete`, {
        method: 'POST',
      });
      if (res.ok) {
        router.refresh();
      } else {
        // Same family as `PublishClassButton` (#166 re-review M5), and the
        // one with the most behind it: completion runs the pricing engine,
        // writes the payment rows and notifies everyone registered. A
        // failure that says nothing leaves the teacher unable to tell
        // whether any of that happened.
        setError(await readErrorMessage(res, 'Could not finish the class. Please try again.'));
      }
    } catch (err) {
      logRequestFailure('complete-class-button', { classId }, err);
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (askingUnsynced) {
    return (
      <div className="flex flex-col items-end gap-1">
        <p id={reasonId} className="type-caption text-right">{unsyncedCopy(unsynced)}</p>
        <div className="flex items-center gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={handleCancelUnsynced}
            disabled={submitting}
            aria-describedby={reasonId}
            className="type-label text-teal disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleComplete}
            disabled={submitting}
            aria-describedby={reasonId}
            className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint disabled:opacity-50"
          >
            {submitting ? 'Finishing…' : 'Finish anyway'}
          </button>
        </div>
        {error && <p role="alert" className="type-caption text-danger text-right">{error}</p>}
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex flex-col items-end gap-1">
        <p className="type-caption text-right">{confirmCopy(chargedCount)}</p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirming(false)}
            // The POST cannot be recalled once sent.
            disabled={submitting}
            className="type-label text-teal disabled:opacity-50"
          >
            Keep open
          </button>
          <button
            type="button"
            onClick={handleFinish}
            disabled={submitting}
            className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint disabled:opacity-50"
          >
            {submitting ? 'Finishing…' : 'Finish'}
          </button>
        </div>
        {error && <p role="alert" className="type-caption text-danger text-right">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        ref={finishClassRef}
        type="button"
        onClick={() => setConfirming(true)}
        className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint disabled:opacity-50"
      >
        Finish class
      </button>
      {error && <p role="alert" className="type-caption text-danger text-right">{error}</p>}
    </div>
  );
}
