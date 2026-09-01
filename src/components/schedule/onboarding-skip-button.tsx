'use client';

import { useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { OnboardingStep } from '@prisma/client';

interface OnboardingSkipButtonProps {
  step: OnboardingStep;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

/**
 * Records a skip via `POST /api/account/onboarding` and refreshes the page
 * so the checklist re-renders against the teacher's updated
 * `skippedOnboarding`. Shared by a row's Skip control and the completion
 * card's Dismiss action — same endpoint, same idempotent append, different
 * `step`.
 */
/**
 * `docs/design-brief.md` §2 asks for `shadow-focus` on every interactive
 * element and 50% opacity when disabled; this control had neither. The hover
 * step is a defined colour move (brown-light -> brown) rather than a
 * transition, since this design has essentially no motion.
 *
 * Before the caller's own classes, so a call site can still override any of
 * it — both of them pass the text colour this hover step darkens.
 */
const BASE_CLASSES =
  'rounded-field hover:text-brown focus:outline-none focus-visible:shadow-focus disabled:opacity-50';

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
    } catch {
      // Fall through to re-enabling the button below.
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
