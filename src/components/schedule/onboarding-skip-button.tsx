'use client';

import type { ReactNode } from 'react';
import type { OnboardingStep } from '@/lib/prisma-client';
import { QuietPostButton } from '@/components/ui/quiet-post-button';

interface OnboardingSkipButtonProps {
  step: OnboardingStep;
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}

/**
 * Records a skip via `POST /api/account/onboarding` and refreshes the page
 * so whatever rendered this control re-renders against the teacher's
 * updated `skippedOnboarding`. A thin wrapper over that endpoint — a call site
 * supplies its own label, aria text and colours, and gets back the same
 * idempotent append under whichever `step` it names.
 */
export function OnboardingSkipButton({ step, ariaLabel, className, children }: OnboardingSkipButtonProps) {
  return (
    <QuietPostButton
      url="/api/account/onboarding"
      body={{ step }}
      ariaLabel={ariaLabel}
      className={className}
      logTag="onboarding-skip"
      logContext={{ step }}
    >
      {children}
    </QuietPostButton>
  );
}
