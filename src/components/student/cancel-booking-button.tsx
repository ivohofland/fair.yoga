'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

const DEADLINE_LABELS: Record<string, string> = {
  HOURS_48: '48 hours',
  HOURS_24: '24 hours',
  HOURS_12: '12 hours',
  HOURS_6: '6 hours',
};

interface CancelBookingButtonProps {
  registrationId: string;
  cancelDeadline: string;
}

export function CancelBookingButton({ registrationId, cancelDeadline }: CancelBookingButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');

  async function handleCancel() {
    setCancelling(true);
    setError('');
    try {
      const res = await fetch(`/api/registrations/${registrationId}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
      } else {
        const json = (await res.json()) as { error?: { message?: string } | string };
        const message = typeof json.error === 'string' ? json.error : json.error?.message;
        setError(message ?? 'Could not cancel. Try again.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setCancelling(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="type-label text-danger">
        Cancel booking
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="type-body">
        Cancel this booking? Free until {DEADLINE_LABELS[cancelDeadline] ?? '24 hours'} before
        class — after that the class is still charged.
      </p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
          {cancelling ? 'Cancelling...' : 'Cancel booking'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Keep booking
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
