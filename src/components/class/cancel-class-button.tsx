'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface CancelClassButtonProps {
  classId: string;
  registrationCount: number;
}

// Destructive confirm pattern: danger text trigger, then a two-button
// confirmation (never three). Registered students are notified server-side.
export function CancelClassButton({ classId, registrationCount }: CancelClassButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');

  async function handleCancel() {
    setCancelling(true);
    setError('');
    try {
      // Its own door since #327, not a transition: cancellation is
      // `CalendarEntry.cancelledAt`, and `transitionClassSchema` no longer
      // accepts a status this enum does not have. No body — the URL is the
      // whole request.
      const res = await fetch(`/api/classes/${classId}/cancel`, {
        method: 'POST',
      });
      if (res.ok) {
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not cancel the class. Try again.'));
      }
    } catch {
      setError('Network error. Try again.');
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
    <div className="flex flex-col gap-3">
      <p className="type-body">
        Cancel this class?
        {registrationCount > 0 && (
          <> {registrationCount} registered {registrationCount === 1 ? 'student' : 'students'} will be notified.</>
        )}
      </p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
          {cancelling ? 'Cancelling...' : 'Cancel class'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Keep class
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
