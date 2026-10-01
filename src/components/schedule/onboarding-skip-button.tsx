'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { OnboardingStep } from '@prisma/client';
import { logRequestFailure } from '@/lib/client-errors';

interface OnboardingSkipButtonProps {
  step: OnboardingStep;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

/**
 * `docs/design-brief.md` §2 asks for `shadow-focus` on every interactive
 * element and 50% opacity when disabled. Colour — including any hover step,
 * a defined step rather than a transition, since this design has essentially
 * no motion — is entirely the call site's own concern; the call site's
 * classes come after this base so they can override any of it.
 */
const BASE_CLASSES =
  'rounded-field focus:outline-none focus-visible:shadow-focus disabled:opacity-50';

/**
 * Records a skip via `POST /api/account/onboarding` and refreshes the page
 * so whatever rendered this control re-renders against the teacher's
 * updated `skippedOnboarding`. A thin wrapper over that endpoint — a call site
 * supplies its own label, aria text and colours, and gets back the same
 * idempotent append under whichever `step` it names.
 */
export function OnboardingSkipButton({ step, ariaLabel, className = '', children }: OnboardingSkipButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleSkip() {
    setLoading(true);
    try {
      const res = await fetch('/api/account/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      console.error('[onboarding-skip] refused', { step, status: res.status });
    } catch (err) {
      logRequestFailure('onboarding-skip', { step }, err);
    }
    // A failed skip just leaves the row showing — nothing was recorded, so
    // the teacher can tap Skip again. No error UI: skipping is a quiet,
    // low-stakes action, not a form submission.
    setLoading(false);
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={handleSkip}
      disabled={loading}
      className={`${BASE_CLASSES} ${className}`.trim()}
    >
      {children}
    </button>
  );
}
