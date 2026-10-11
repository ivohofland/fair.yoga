'use client';

import Link from 'next/link';
import { PushOfferCard } from '@/components/push/push-offer-card';
import { OnboardingSkipButton } from './onboarding-skip-button';

/** The teacher's push offer: `PushOfferCard` with the teacher's copy and onboarding dismissal. */
export function PushCard({ dismissed, vapidPublicKey }: { dismissed: boolean; vapidPublicKey: string | null }) {
  return (
    <PushOfferCard
      dismissed={dismissed}
      vapidPublicKey={vapidPublicKey}
      description={
        <p className="type-caption mt-0.5 mb-4">
          A heads-up when a student books or a class changes. Email still comes as it does now — you choose which
          messages in{' '}
          <Link href="/settings/notifications" className="text-teal">
            Settings
          </Link>
          .
        </p>
      }
      dismissControl={
        <OnboardingSkipButton
          step="push"
          ariaLabel="Dismiss the notifications card"
          className="type-label text-brown-light hover:text-brown px-3 min-h-11 shrink-0"
        >
          Dismiss
        </OnboardingSkipButton>
      }
    />
  );
}
