'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import { ownedOutbox, readOutbox } from '@/lib/attendance-outbox';
import { flushWithinWait } from '@/lib/attendance-sync';

interface CompleteClassButtonProps {
  classId: string;
  chargedCount: number;
  /** The signed-in account, whose queued attendance changes for this class are sent before finishing. */
  ownerId: string;
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

/**
 * Finishing prices the class and words each payment request from the
 * statuses the server holds, so this class's attendance changes still queued
 * on the device are sent first; if any are still unsent after the wait, the
 * teacher is asked again before finishing.
 */
export function CompleteClassButton({ classId, chargedCount, ownerId }: CompleteClassButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // This class's changes still unsent after the wait; 0 while the question is not open.
  const [unsynced, setUnsynced] = useState(0);
  const reasonId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLButtonElement>(null);
  // Set by Cancel, so focus goes back to Finish class rather than dropping to the page.
  const returnFocus = useRef(false);

  useEffect(() => {
    if (unsynced > 0) {
      cancelRef.current?.focus();
      return;
    }
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      mainRef.current?.focus();
    }
  }, [unsynced, confirming]);

  function unsentForClass(): number {
    return Object.values(ownedOutbox(readOutbox(), ownerId).pending).filter((e) => e.classId === classId).length;
  }

  async function handleFinish() {
    setSubmitting(true);
    setError('');
    if (unsentForClass() > 0) {
      await flushWithinWait(ownerId, 'complete-class-button');
      const left = unsentForClass();
      if (left > 0) {
        setUnsynced(left);
        setSubmitting(false);
        return;
      }
    }
    await handleComplete();
  }

  function cancelFinish() {
    returnFocus.current = true;
    setUnsynced(0);
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

  if (confirming && unsynced > 0) {
    return (
      <div className="flex flex-col items-end gap-1">
        <p id={reasonId} className="type-caption text-right">
          {unsynced === 1
            ? "1 attendance change for this class hasn't synced."
            : `${unsynced} attendance changes for this class haven't synced.`}
        </p>
        <div className="flex items-center gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={cancelFinish}
            aria-describedby={reasonId}
            // The POST cannot be recalled once sent.
            disabled={submitting}
            className="type-label text-teal disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleComplete}
            aria-describedby={reasonId}
            disabled={submitting}
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
        ref={mainRef}
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
