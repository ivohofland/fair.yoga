'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PushOfferCard } from '@/components/push/push-offer-card';
import { logRequestFailure } from '@/lib/client-errors';

/** The student's push offer: `PushOfferCard` with the student's copy and a dismissal stored on the student. */
export function StudentPushCard({ dismissed, vapidPublicKey }: { dismissed: boolean; vapidPublicKey: string | null }) {
  return (
    <PushOfferCard
      dismissed={dismissed}
      vapidPublicKey={vapidPublicKey}
      description={
        <p className="type-caption mt-0.5 mb-4">
          A heads-up when a waitlist spot opens for you or a class you booked is cancelled. Booking emails still come as
          they do now — you choose which messages in{' '}
          <Link href="/account/notifications" className="text-teal">
            Settings
          </Link>
          .
        </p>
      }
      dismissControl={<DismissButton />}
    />
  );
}

function DismissButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDismiss() {
    setLoading(true);
    try {
      const res = await fetch('/api/account/student-push-card', { method: 'POST' });
      if (res.ok) {
        router.refresh();
        return;
      }
      console.error('[student-push-card] refused', { status: res.status });
    } catch (err) {
      logRequestFailure('student-push-card', {}, err);
    }
    // Nothing was recorded, so the button comes back for another try.
    setLoading(false);
  }

  return (
    <button
      type="button"
      aria-label="Dismiss the notifications card"
      onClick={() => void handleDismiss()}
      disabled={loading}
      className="rounded-field focus:outline-none focus-visible:shadow-focus disabled:opacity-50 type-label text-brown-light hover:text-brown px-3 min-h-11 shrink-0"
    >
      Dismiss
    </button>
  );
}
