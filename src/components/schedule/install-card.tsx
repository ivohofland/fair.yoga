'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { OnboardingStep } from '@prisma/client';
import { Button } from '@/components/ui/button';
import { InstallSteps } from '@/components/account/install-steps';
import { installStore, useCoarsePointer, useInstallSupport } from '@/components/layout/install-store';
import { canOfferInstall, installStepsVariant } from '@/lib/install-support';
import { logRequestFailure } from '@/lib/client-errors';
import { OnboardingSkipButton } from './onboarding-skip-button';

let recording: Promise<boolean> | null = null;

/** Posts the `install` dismissal at most once per page load: this component
 *  can mount many times in one page load. A failed post is not retried
 *  until the next load. */
function recordInstallOnce(): Promise<boolean> {
  recording ??= fetch('/api/account/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step: 'install' } satisfies { step: OnboardingStep }),
  }).then(
    (res) => {
      if (!res.ok) console.error('[install-card] refused', { status: res.status });
      return res.ok;
    },
    (err: unknown) => {
      logRequestFailure('install-card', { step: 'install' }, err);
      return false;
    },
  );
  return recording;
}

/**
 * A one-time nudge to install the app. Shows on a phone that can install,
 * whatever the checklist's state, until dismissed — by Dismiss, by Done
 * after the steps, by an accepted install prompt, or by opening inside the
 * installed app, or in the tab that just installed it.
 */
export function InstallCard({ dismissed }: { dismissed: boolean }) {
  const support = useInstallSupport();
  const coarse = useCoarsePointer();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const stepsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Gated on a coarse pointer: an `installed` desktop standalone window, or
    // a desktop tab right after `appinstalled`, is not the phone this card
    // targets, and posting there would retire it on the teacher's actual
    // phone too — dismissal is per teacher, not per device.
    if (!dismissed && support === 'installed' && coarse) void recordInstallOnce();
  }, [dismissed, support, coarse]);

  useEffect(() => {
    if (open) stepsRef.current?.focus();
  }, [open]);

  if (dismissed || accepted) return null;
  if (!canOfferInstall(support)) return null;
  if (support !== 'ios-safari' && !coarse) return null;

  async function handlePrimary(): Promise<void> {
    if (support !== 'prompt' || !installStore) {
      setOpen(true);
      return;
    }
    const outcome = await installStore.promptInstall();
    if (outcome === 'accepted') {
      // The person just installed — show nothing more regardless of
      // whether the dismissal post below succeeds, so a failed post never
      // leaves someone who installed looking at manual add-it-yourself steps.
      setAccepted(true);
      if (await recordInstallOnce()) router.refresh();
      return;
    }
    if (outcome === 'unavailable') setOpen(true);
  }

  return (
    <div className="bg-sand-soft border border-border rounded-card p-5 mb-6">
      <h2 className="type-subtitle">Use fair.yoga as an app</h2>
      <p className="type-caption mt-0.5 mb-4">
        Open it from your Home Screen, full screen, one tap away.
      </p>
      {open ? (
        <>
          <div ref={stepsRef} tabIndex={-1} className="focus:outline-none">
            <InstallSteps variant={installStepsVariant(support)} />
          </div>
          <div className="mt-4">
            <OnboardingSkipButton
              step="install"
              ariaLabel="Done adding fair.yoga to your Home Screen"
              className="type-label text-teal hover:text-teal-hover px-3 min-h-11"
            >
              Done
            </OnboardingSkipButton>
          </div>
        </>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <Button onClick={() => void handlePrimary()}>
            {support === 'prompt' ? 'Install' : 'Show me how'}
          </Button>
          <OnboardingSkipButton
            step="install"
            ariaLabel="Dismiss the install card"
            className="type-label text-brown-light hover:text-brown px-3 min-h-11 shrink-0"
          >
            Dismiss
          </OnboardingSkipButton>
        </div>
      )}
    </div>
  );
}
