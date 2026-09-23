'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readError } from '@/lib/client-errors';
import { isPastCancelDeadline } from '@/lib/cancel-deadline';

const DEADLINE_LABELS: Record<string, string> = {
  HOURS_48: '48 hours',
  HOURS_24: '24 hours',
  HOURS_12: '12 hours',
  HOURS_6: '6 hours',
};

interface CancelBookingButtonProps {
  registrationId: string;
  cancelDeadline: string;
  /** ISO instant — `cancelDeadlineInstant` (`@/services/waitlist`), run server-side. */
  cancelDeadlineAt: string;
}

/**
 * Whether the confirm step shows the past-deadline copy, decided once at the
 * tap that opens it (`isPastCancelDeadline`) and held for as long as the
 * confirm stays open — never recomputed from the clock at render, which
 * would go stale while the student reads it.
 */
interface Confirming {
  pastDeadline: boolean;
}

export function CancelBookingButton({
  registrationId,
  cancelDeadline,
  cancelDeadlineAt,
}: CancelBookingButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');

  async function handleCancel() {
    setCancelling(true);
    setError('');
    try {
      const res = await fetch(`/api/registrations/${registrationId}`, { method: 'DELETE' });
      if (res.ok) {
        router.refresh();
        return;
      }
      const { code, message } = await readError(res, 'Could not cancel. Try again.');
      // A booking that no longer exists is as cancelled as this button can make it.
      if (code === 'NOT_FOUND') {
        router.refresh();
        return;
      }
      setError(message);
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
        onClick={() =>
          setConfirming({
            pastDeadline: isPastCancelDeadline(new Date(cancelDeadlineAt), new Date()),
          })
        }
        className="type-label text-danger"
      >
        Cancel booking
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="type-body">
        {confirming.pastDeadline
          ? "The cancellation deadline has passed, so you'll still pay your share of this class. Cancelling lets your teacher know you won't be there."
          : `Cancel this booking? Free until ${DEADLINE_LABELS[cancelDeadline] ?? '24 hours'} before class — after that the class is still charged.`}
      </p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleCancel} disabled={cancelling}>
          {cancelling ? 'Cancelling...' : 'Cancel booking'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(null)}>
          Keep booking
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
