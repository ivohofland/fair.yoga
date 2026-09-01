'use client';

import Link from 'next/link';
import type { OnboardingStep } from '@prisma/client';
import { Icon } from '@/components/ui/icon';
import { ShareBookingLink } from '@/components/class/share-booking-link';
import { OnboardingSkipButton } from './onboarding-skip-button';
import { resolveSteps, type StepInput, type ResolvedStep } from '@/lib/onboarding';

interface GettingStartedProps extends StepInput {
  pageSlug: string;
}

/**
 * Narrows a row's key to the `OnboardingStep` it may be skipped as, or
 * `null` for the two required rows. The equality check is what lets
 * TypeScript narrow `step.key` — `ResolvedStep['skippable']` alone is a
 * plain boolean and narrows nothing.
 */
function skipTargetFor(step: ResolvedStep): OnboardingStep | null {
  return step.key === 'profile' || step.key === 'bank' ? step.key : null;
}

/**
 * Inline onboarding: a quiet checklist on the Schedule tab that retires
 * itself once the teacher is set up. No overlay, no tour — the app is
 * the tour.
 */
export function GettingStarted({ pageSlug, ...input }: GettingStartedProps) {
  if (input.skipped.includes('share')) return null;

  const steps = resolveSteps(input);
  const settled = steps.every((step) => step.state !== 'todo');

  if (settled) {
    return (
      <div className="bg-sand-soft border border-border rounded-card p-5 mb-6">
        <h2 className="type-subtitle">You’re all set</h2>
        <p className="type-caption mt-0.5 mb-4">
          Share your booking page so students can find you.
        </p>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <ShareBookingLink pageSlug={pageSlug} />
          <OnboardingSkipButton
            step="share"
            ariaLabel="Dismiss the getting started card"
            className="type-label text-brown-light px-3 min-h-11 shrink-0"
          >
            Dismiss
          </OnboardingSkipButton>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-sand-soft border border-border rounded-card p-5 mb-6">
      <h2 className="type-subtitle">Getting started</h2>
      <p className="type-caption mt-0.5 mb-2">
        A few steps and your booking page is ready to share.
      </p>
      <div>
        {steps.map((step) => {
          const skipTarget = skipTargetFor(step);
          return (
            <div
              key={step.key}
              className="flex items-center min-h-12 py-2 border-b border-border last:border-b-0"
            >
              <Link
                href={step.href}
                className="flex items-center gap-3 flex-1 min-w-0 no-underline"
              >
                <span
                  className={`flex items-center justify-center w-6 h-6 rounded-full shrink-0 ${
                    step.state === 'done'
                      ? 'bg-teal text-cream'
                      : 'border-[1.5px] border-border text-brown-light'
                  }`}
                >
                  {step.state === 'done' && <Icon name="check" size={14} />}
                  {step.state === 'skipped' && <span aria-hidden="true">–</span>}
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className={`block text-base ${step.state === 'todo' ? 'text-ink' : 'text-brown'}`}
                  >
                    {step.label}
                  </span>
                  {step.state === 'todo' && <span className="type-caption">{step.detail}</span>}
                </span>
                {step.state === 'todo' && (
                  <Icon name="chevron-right" size={18} className="text-brown-light" />
                )}
              </Link>
              {skipTarget && step.state === 'todo' && (
                <OnboardingSkipButton
                  step={skipTarget}
                  ariaLabel={`Skip ${step.label.toLowerCase()}`}
                  className="type-label text-brown-light px-3 min-h-11 shrink-0"
                >
                  Skip
                </OnboardingSkipButton>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
