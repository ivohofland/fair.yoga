'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface CancelStudioClassButtonProps {
  studioClassId: string;
}

export function CancelStudioClassButton({ studioClassId }: CancelStudioClassButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');

  async function handleCancel() {
    setCancelling(true);
    setError('');
    try {
      const res = await fetch(`/api/studio-classes/${studioClassId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelledAt: new Date().toISOString() }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        // Same family as the two class buttons (#166 re-review M5). The
        // confirm step makes silence worse rather than safer: the teacher
        // has already answered "yes, cancel this", so an unchanged page
        // reads as the cancellation having gone through, and the class
        // stays in their schedule and their income figures.
        setError(await readErrorMessage(res, 'Could not cancel the class. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setCancelling(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="type-label text-danger"
      >
        Cancel class
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="type-body">Cancel this studio class?</p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
          {cancelling ? 'Cancelling...' : 'Cancel'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </div>
      {error && <p className="type-caption text-danger">{error}</p>}
    </div>
  );
}
