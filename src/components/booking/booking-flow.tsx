'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Currency } from '@/lib/prisma-client';
import { Button } from '@/components/ui/button';
import { isRefusal, logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import { TIER_INFO, TIER_PROMPT, type IncomeTier } from '@/lib/tiers';
import { formatMoney } from '@/lib/format';
import { FREE_CANCEL_GRACE_MINUTES } from '@/lib/cancel-deadline';
import { CLAIM_WINDOW_MINUTES } from '@/lib/claim-window';
import type { PublicClassLocation } from '@/lib/class-location';
import { PricingExplainer } from './pricing-explainer';

type BookingPricing = { mode: 'tiered'; tierPrices: number[] } | { mode: 'donation' };

interface BookingFlowProps {
  classId: string;
  isFull: boolean;
  alreadyBooked: boolean;
  /**
   * The student's stored tier, or null when it could not be read as one.
   * Null shows the picker with nothing selected — a tier we had to substitute
   * is not this student's, so this form asks rather than names it, and
   * booking waits for the answer.
   */
  currentTier: IncomeTier | null;
  studentId: string;
  /**
   * How the class is priced. A tiered class carries its estimated price per
   * tier 1..5 if it ran with today's sign-ups plus you; a donation class
   * carries no figure at all.
   */
  pricing: BookingPricing;
  /** The class's currency, which a tiered class's `tierPrices` are in. */
  currency: Currency;
  /**
   * The student has never chosen a tier themselves (tierSelectedAt is
   * null) — the documented income-selection moment. CRM-created
   * registrations don't count as choosing.
   */
  isFirstBooking: boolean;
  /** Pending/overdue payments this student owes this same teacher. */
  openPaymentsCount: number;
  /**
   * The student's place in this class's queue while their entry is
   * `waiting`, or null. Claiming and leaving happen on `/bookings`, so a
   * queued student is pointed there rather than offered the join again.
   */
  waitlistPosition: number | null;
  /**
   * The queue is in its final hour before class, when a freed seat goes to
   * whoever claims it first rather than to the head of the queue.
   */
  inClaimWindow: boolean;
  /** Where the class happens, without its video link, which this page never carries (#911). */
  location: PublicClassLocation;
}

type Phase = 'choose' | 'booked' | 'waitlisted';

// Tier selection + booking confirmation. Tiers are self-reported — no
// proof needed, changeable any time. Inviting, never guilt-inducing.
export function BookingFlow({
  classId,
  isFull,
  alreadyBooked,
  currentTier,
  studentId,
  pricing,
  currency,
  isFirstBooking,
  openPaymentsCount,
  waitlistPosition,
  inClaimWindow,
  location,
}: BookingFlowProps) {
  const router = useRouter();
  const [tier, setTier] = useState<IncomeTier | null>(currentTier);
  const [phase, setPhase] = useState<Phase>('choose');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showExplainer, setShowExplainer] = useState(false);

  // A refusal means this page was out of date — the class filled, its last
  // seat was taken, it started. Read it again so the button offers what is
  // possible now; the message stays. A server or network error says nothing
  // about the class, so it reads nothing.
  function refreshAfterRefusal(res: Response) {
    if (isRefusal(res)) router.refresh();
  }

  async function handleBook() {
    if (tier === null) return;
    setSubmitting(true);
    setError('');
    try {
      // Persist a changed tier first — tierAtBooking reads from the profile.
      // Accepting the default needs no client cooperation: the booking and
      // waitlist routes stamp tierSelectedAt server-side on self-bookings.
      if (tier !== currentTier) {
        const tierRes = await fetch(`/api/students/${studentId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ incomeTier: tier }),
        });
        if (!tierRes.ok) {
          setError(await readErrorMessage(tierRes, 'Could not save your tier. Try again.'));
          return;
        }
      }

      if (isFull) {
        const res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ classId }),
        });
        if (res.ok) {
          setPhase('waitlisted');
        } else {
          setError(await readErrorMessage(res, 'Could not join the waitlist. Try again.'));
          refreshAfterRefusal(res);
        }
        return;
      }

      const res = await fetch('/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classId }),
      });
      if (res.ok) {
        setPhase('booked');
      } else {
        setError(await readErrorMessage(res, 'Could not book the class. Try again.'));
        refreshAfterRefusal(res);
      }
    } catch (err) {
      logRequestFailure('booking-flow', { classId, studentId, isFull }, err);
      setError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (alreadyBooked) {
    return (
      <div className="py-4">
        <p className="type-subtitle">You&apos;re booked for this class</p>
        <p className="type-body mt-2">
          {location.format === 'online'
            ? 'Find it, and the video link, under your bookings.'
            : 'Find it under your bookings.'}
        </p>
        <Link href="/bookings" className="inline-block mt-4 type-label text-teal no-underline">
          Go to your bookings
        </Link>
      </div>
    );
  }

  if (phase === 'booked') {
    return (
      <div className="py-4">
        <p className="type-subtitle">You&apos;re in</p>
        <p className="type-body mt-2">
          {bookedCopy(pricing)}
        </p>
        <Link href="/bookings" className="inline-block mt-4 type-label text-teal no-underline">
          Go to your bookings
        </Link>
      </div>
    );
  }

  if (phase === 'waitlisted' || waitlistPosition !== null) {
    return (
      <div className="py-4">
        <p className="type-subtitle">You&apos;re on the waitlist</p>
        <p className="type-body mt-2">
          {waitlistPosition !== null && <>You&apos;re number {waitlistPosition} in the queue. </>}
          If a spot opens up, you&apos;ll either be moved in automatically or
          notified to claim it — watch your inbox.
        </p>
        <Link href="/bookings" className="inline-block mt-4 type-label text-teal no-underline">
          Go to your bookings
        </Link>
      </div>
    );
  }

  // The tier the summary would name, or null when there is none to name —
  // a first booking, or a stored value we could not read. One derived value
  // rather than two conditions, so the picker and the sentence explaining it
  // cannot come apart. Narrowing to IncomeTier in the summary branch is why
  // this is a null check on a const rather than a boolean flag.
  const summaryTier = isFirstBooking ? null : currentTier;

  return (
    <div>
      {openPaymentsCount > 0 && (
        // Friendly, never blocking (product-concept.md §7) — plain text like
        // the app's other payment states, no badge.
        <p className="type-body mb-4">
          You have {openPaymentsCount} open payment{openPaymentsCount === 1 ? '' : 's'} with this
          teacher.{' '}
          <Link href="/bookings" className="text-teal no-underline">
            View your bookings
          </Link>
        </p>
      )}
      <h2 className="type-subtitle mb-1">Your tier</h2>
      {summaryTier === null ? (
        <>
          <p className="type-body max-w-[420px]">{pickerIntro(pricing)}</p>
          <p className="type-body font-semibold mt-3 mb-4 max-w-[420px]">{TIER_PROMPT}</p>

          <div className="flex flex-col gap-3" role="radiogroup" aria-label="Income tier">
            {TIER_INFO.map((t) => {
              const selected = tier === t.tier;
              return (
                <button
                  key={t.tier}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTier(t.tier)}
                  className={`text-left border rounded-card p-5 ${
                    selected ? 'bg-teal-tint border-teal' : 'bg-sand-soft border-border hover:bg-sand'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="type-label text-ink font-semibold">
                        Tier {t.tier} · {t.label}
                      </div>
                      <div className="type-caption mt-0.5">{t.caption}</div>
                    </div>
                    {tierPriceFor(pricing, t.tier) !== null && (
                      <span className="type-number text-[18px]">
                        {formatMoney(tierPriceFor(pricing, t.tier)!, currency)}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      ) : (
        // Tier is global and lives in settings; returning students only get
        // the tier-1/2 honesty nudge the product concept asks for.
        <div className="mb-1">
          <p className="type-body max-w-[420px]">
            You&apos;re in Tier {summaryTier} · {TIER_INFO[summaryTier - 1]!.label}
            {summaryTier <= 2 ? ' — does this still reflect your situation?' : '.'}
          </p>
          <Link
            href="/account/tier"
            className="inline-block mt-2 type-label text-teal no-underline"
          >
            Change your tier in settings
          </Link>
        </div>
      )}

      {showsEstimates(pricing) && (
        <>
          <p className="type-caption mt-4 max-w-[420px]">
            Estimates assume the class at least reaches its minimum; the final price settles after
            class.{summaryTier === null && ' The highest tier pays about twice the lowest.'}{' '}
            <button
              type="button"
              onClick={() => setShowExplainer((prev) => !prev)}
              aria-expanded={showExplainer}
              aria-controls="pricing-explainer-panel"
              className="text-teal"
            >
              {showExplainer ? 'Hide explanation' : 'Learn more'}
            </button>
          </p>

          {showExplainer && (
            <PricingExplainer id="pricing-explainer-panel" className="mt-3 max-w-[420px]" />
          )}
        </>
      )}

      <div className="mt-5">
        <Button variant="primary" onClick={handleBook} disabled={submitting || tier === null} className="w-full">
          {submitting
            ? 'One moment...'
            : isFull
              ? 'Join the waitlist'
              : bookLabel(pricing, tier, currency)}
        </Button>
        {isFull && (
          <p className="type-caption mt-2">
            {inClaimWindow ? (
              <>
                It&apos;s the final hour before class, so a spot that opens isn&apos;t given
                out automatically: everyone waiting is told, and the first to claim it gets
                it.{claimChargeSentence(pricing)}
              </>
            ) : (
              <>
                If a spot opens up until {formatMinutes(CLAIM_WINDOW_MINUTES)} before
                class, the next person in line is booked automatically. The usual
                cancellation deadline applies, with at least{' '}
                {FREE_CANCEL_GRACE_MINUTES} minutes to change your mind.
              </>
            )}
          </p>
        )}
      </div>
      {error && <p role="alert" className="text-sm text-danger mt-3">{error}</p>}
    </div>
  );
}

/** `60` → `"1 hour"`, `120` → `"2 hours"`, `45` → `"45 minutes"`. */
function formatMinutes(minutes: number): string {
  if (minutes % 60 !== 0) return `${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

/** The picker's opening paragraph, per pricing mode. */
function pickerIntro(pricing: BookingPricing): string {
  switch (pricing.mode) {
    case 'tiered':
      return 'Your price is based on what you can comfortably contribute. Tiers are self-reported. No proof needed, and you can change yours at any time.';
    case 'donation':
      return 'This class is by donation. After class you can give what you like, if you like.';
    default:
      return assertNever(pricing);
  }
}

/** The confirmation line after booking, per pricing mode. */
function bookedCopy(pricing: BookingPricing): string {
  switch (pricing.mode) {
    case 'tiered':
      return 'Your spot is confirmed. The final price settles after class, based on who comes — your tier keeps it fair.';
    case 'donation':
      return 'Your spot is confirmed.';
    default:
      return assertNever(pricing);
  }
}

/** The estimate for a tier, or null when the class shows none. */
function tierPriceFor(pricing: BookingPricing, tier: IncomeTier): number | null {
  switch (pricing.mode) {
    case 'tiered':
      return pricing.tierPrices[tier - 1]!;
    case 'donation':
      return null;
    default:
      return assertNever(pricing);
  }
}

/** Whether the estimate caveat and its explainer belong on this class. */
function showsEstimates(pricing: BookingPricing): boolean {
  switch (pricing.mode) {
    case 'tiered':
      return true;
    case 'donation':
      return false;
    default:
      return assertNever(pricing);
  }
}

/** The booking button's label, with the estimate where the class has one. */
function bookLabel(pricing: BookingPricing, tier: IncomeTier | null, currency: Currency): string {
  switch (pricing.mode) {
    case 'tiered':
      return tier === null
        ? 'Book'
        : `Book — around ${formatMoney(pricing.tierPrices[tier - 1]!, currency)}`;
    case 'donation':
      return 'Book';
    default:
      return assertNever(pricing);
  }
}

/** What the final-hour caption adds about claiming, per pricing mode. */
function claimChargeSentence(pricing: BookingPricing): string {
  switch (pricing.mode) {
    case 'tiered':
      return " Claiming is charged even if you can't make it.";
    case 'donation':
      return '';
    default:
      return assertNever(pricing);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled pricing: ${JSON.stringify(value)}`);
}
