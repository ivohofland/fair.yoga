'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readError } from '@/lib/client-errors';
import { isPastCancelDeadline } from '@/lib/cancel-deadline';

interface CancelBookingButtonProps {
  registrationId: string;
  /** ISO instant — `freeCancelUntilFor` (`@/lib/cancel-deadline`), computed server-side. */
  freeCancelUntilAt: string;
  /**
   * `freeCancelUntilAt` formatted in the teacher's timezone by
   * `formatInstantInZone` (`@/lib/timezone`), also server-side — this
   * component does no time formatting of its own, so it never risks
   * rendering an instant in the server's zone instead of the teacher's.
   */
  freeCancelUntilLabel: string;
}

/**
 * Whether the confirm step shows the past-deadline copy, decided once at the
 * tap that opens it (`isPastCancelDeadline`) and held while the confirm stays
 * open, so a re-render after the deadline passes does not swap the text
 * under the student mid-read.
 */
interface Confirming {
  pastDeadline: boolean;
}

export function CancelBookingButton({
  registrationId,
  freeCancelUntilAt,
  freeCancelUntilLabel,
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
            pastDeadline: isPastCancelDeadline(new Date(freeCancelUntilAt), new Date()),
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
          : `Cancel this booking? Free until ${freeCancelUntilLabel} — after that the class is still charged.`}
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
