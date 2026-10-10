'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useCoarsePointer } from '@/components/layout/install-store';
import { usePushDevice } from '@/components/settings/use-push-device';
import { enablePush } from '@/lib/push-client';
import { OnboardingSkipButton } from './onboarding-skip-button';

/**
 * A one-time offer to turn on push, for a phone whose browser has never been
 * asked. `permission === 'default'` is what "never asked" means: unsubscribing
 * never revokes a granted permission, so a phone where push was switched off
 * reads `granted`. Gated on a coarse pointer because `dismissed` holds for the
 * teacher, not the device, and a "no" in a desktop window would otherwise
 * retire the offer on the phone too.
 */
export function PushCard({ dismissed, vapidPublicKey }: { dismissed: boolean; vapidPublicKey: string | null }) {
  const coarse = useCoarsePointer();
  const { state, permission } = usePushDevice(vapidPublicKey, { resync: false });
  const [answered, setAnswered] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  if (dismissed || answered || !coarse || vapidPublicKey === null) return null;
  if (state !== 'off' || permission !== 'default') return null;
  const key = vapidPublicKey;

  // The permission prompt needs the tap's gesture, so this runs from the
  // click and never on load. `on` and `blocked` both end the offer; neither
  // is stored, since the device state answers it on the next load.
  async function handleEnable(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const outcome = await enablePush(key);
    if (outcome === 'failed') {
      // Kept only while the page is open: a failure after the browser granted
      // permission reads `off` and `granted` on the next load, so the card does
      // not return (docs/information-architecture.md, Push card).
      setFailed(true);
      setBusy(false);
      return;
    }
    setAnswered(true);
  }

  return (
    <div className="bg-sand-soft border border-border rounded-card p-5 mb-6">
      <h2 className="type-subtitle">Get notifications on this phone</h2>
      <p className="type-caption mt-0.5 mb-4">
        A heads-up when a student books or a class changes. Email still comes as it does now — you choose which
        messages in{' '}
        <Link href="/settings/notifications" className="text-teal">
          Settings
        </Link>
        .
      </p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Button onClick={() => void handleEnable()} disabled={busy}>
          Turn on
        </Button>
        <OnboardingSkipButton
          step="push"
          ariaLabel="Dismiss the notifications card"
          className="type-label text-brown-light hover:text-brown px-3 min-h-11 shrink-0"
        >
          Dismiss
        </OnboardingSkipButton>
      </div>
      {failed && (
        <p role="alert" className="type-caption text-danger mt-3">
          Notifications weren&apos;t turned on. Try again.
        </p>
      )}
    </div>
  );
}
