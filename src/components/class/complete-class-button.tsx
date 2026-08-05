'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { readErrorMessage } from '@/lib/client-errors';

interface CompleteClassButtonProps {
  classId: string;
}

export function CompleteClassButton({ classId }: CompleteClassButtonProps) {
  const router = useRouter();
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
        setError(await readErrorMessage(res, 'Could not complete the class. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleComplete}
        disabled={submitting}
        className="h-9 px-4 rounded-pill text-[13px] font-medium border-[1.5px] border-teal text-teal hover:bg-teal-tint disabled:opacity-50"
      >
        {submitting ? 'Completing...' : 'Complete class'}
      </button>
      {error && <p className="type-caption text-danger text-right">{error}</p>}
    </div>
  );
}
