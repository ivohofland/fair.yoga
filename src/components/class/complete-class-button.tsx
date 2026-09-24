'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';

interface CompleteClassButtonProps {
  classId: string;
  chargedCount: number;
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

export function CompleteClassButton({ classId, chargedCount }: CompleteClassButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

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
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
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
            onClick={handleComplete}
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
