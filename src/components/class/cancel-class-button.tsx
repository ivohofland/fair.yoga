'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

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
      const res = await fetch(`/api/classes/${classId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const json = (await res.json()) as { error?: { message?: string } | string };
        const message = typeof json.error === 'string' ? json.error : json.error?.message;
        setError(message ?? 'Could not cancel the class. Try again.');
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
