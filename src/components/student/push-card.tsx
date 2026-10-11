'use client';

import Link from 'next/link';
import { PushOfferCard } from '@/components/push/push-offer-card';
import { QuietPostButton } from '@/components/ui/quiet-post-button';

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
  return (
    <QuietPostButton
      url="/api/account/student-push-card"
      ariaLabel="Dismiss the notifications card"
      className="type-label text-brown-light hover:text-brown px-3 min-h-11 shrink-0"
      logTag="student-push-card"
    >
      Dismiss
    </QuietPostButton>
  );
}
