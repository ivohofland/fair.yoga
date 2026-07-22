'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';
import { TIER_INFO, TIER_QUOTE } from '@/lib/tiers';

interface BookingFlowProps {
  classId: string;
  slug: string;
  isFull: boolean;
  alreadyBooked: boolean;
  currentTier: number;
  studentId: string;
  /** Estimated price per tier 1..5 if the class ran with today's sign-ups plus you. */
  tierPrices: number[];
  /** Zero prior registrations: the documented income-selection moment. */
  isFirstBooking: boolean;
}

type Phase = 'choose' | 'booked' | 'waitlisted';

// Tier selection + booking confirmation. Tiers are self-reported — no
// proof needed, changeable any time. Inviting, never guilt-inducing.
export function BookingFlow({
  classId,
  slug,
  isFull,
  alreadyBooked,
  currentTier,
  studentId,
  tierPrices,
  isFirstBooking,
}: BookingFlowProps) {
  const [tier, setTier] = useState(currentTier);
  const [phase, setPhase] = useState<Phase>('choose');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleBook() {
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
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (alreadyBooked) {
    return (
      <div className="py-4">
        <p className="type-subtitle">You&apos;re booked for this class</p>
        <p className="type-body mt-2">Find it under your bookings.</p>
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
          Your spot is confirmed. The final price settles after class, based on
          who comes — your tier keeps it fair.
        </p>
        <Link href="/bookings" className="inline-block mt-4 type-label text-teal no-underline">
          Go to your bookings
        </Link>
      </div>
    );
  }

  if (phase === 'waitlisted') {
    return (
      <div className="py-4">
        <p className="type-subtitle">You&apos;re on the waitlist</p>
        <p className="type-body mt-2">
          If a spot opens up, you&apos;ll either be moved in automatically or
          notified to claim it — watch your inbox.
        </p>
        <Link href="/bookings" className="inline-block mt-4 type-label text-teal no-underline">
          Go to your bookings
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h2 className="type-subtitle mb-1">Your tier</h2>
      {isFirstBooking ? (
        <>
          <p className="type-body max-w-[420px]">
            Your price is based on what you can comfortably contribute. Tiers are
            self-reported — no proof needed, and you can change yours at any time.
          </p>
          <p className="type-caption font-heading italic mt-3 mb-4 max-w-[420px]">
            &ldquo;{TIER_QUOTE.text}&rdquo; — {TIER_QUOTE.author}
          </p>

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
                    <span className="type-number text-[18px]">
                      €{tierPrices[t.tier - 1]!.toFixed(2)}
                    </span>
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
            You&apos;re in Tier {tier} · {TIER_INFO[tier - 1]!.label}
            {tier <= 2 ? ' — does this still reflect your situation?' : '.'}
          </p>
          <Link
            href="/account/tier"
            className="inline-block mt-2 type-label text-teal no-underline"
          >
            Change your tier in settings
          </Link>
        </div>
      )}

      <p className="type-caption mt-4 max-w-[420px]">
        Estimates assume the class at least reaches its minimum; the final price settles after
        class. The highest tier pays about twice the lowest.{' '}
        <Link href={`/${slug}`} className="text-teal">
          Learn more
        </Link>
      </p>

      <div className="mt-5">
        <Button variant="primary" onClick={handleBook} disabled={submitting} className="w-full">
          {submitting
            ? 'One moment...'
            : isFull
              ? 'Join the waitlist'
              : `Book — around €${tierPrices[tier - 1]!.toFixed(2)}`}
        </Button>
      </div>
      {error && <p className="text-sm text-danger mt-3">{error}</p>}
    </div>
  );
}
