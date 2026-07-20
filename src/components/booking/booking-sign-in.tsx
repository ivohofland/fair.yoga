'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasskeySignIn } from '@/components/booking/passkey-sign-in';

interface BookingSignInProps {
  /** Where the magic link should land the student — this booking page. */
  redirect: string;
}

type Mode = 'new' | 'returning';

// Account step of the booking flow: one email, no passwords. The magic
// link brings the student straight back to this class.
export function BookingSignIn({ redirect }: BookingSignInProps) {
  const [mode, setMode] = useState<Mode>('new');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    try {
      const res =
        mode === 'new'
          ? await fetch('/api/auth/student-signup', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ firstName, lastName, email, redirect }),
            })
          : await fetch('/api/auth/magic-link/send', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email, redirect }),
            });
      setStatus(res.ok ? 'sent' : 'error');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'sent') {
    return (
      <div className="py-4">
        <p className="type-subtitle">Check your inbox</p>
        <p className="type-body mt-2 max-w-[420px]">
          We sent you a sign-in link. It brings you straight back here to
          finish booking.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="type-subtitle mb-1">
        {mode === 'new' ? 'First time here?' : 'Welcome back'}
      </h2>
      <p className="type-body mb-4 max-w-[420px]">
        {mode === 'new'
          ? 'Booking takes one email — no passwords. We create your account and send you a sign-in link.'
          : "We'll email you a sign-in link that brings you back to this class."}
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-[420px]">
        {mode === 'new' && (
          <>
            <Input
              label="First name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
            <Input
              label="Last name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
            />
          </>
        )}
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
        <Button type="submit" disabled={status === 'sending'} className="w-full">
          {status === 'sending' ? 'Sending...' : 'Send me the link'}
        </Button>
        {status === 'error' && (
          <p className="text-[13px] leading-[1.4] text-danger">
            Something went wrong. Please try again.
          </p>
        )}
      </form>

      {/* First-timers have no passkey yet — the button only makes sense on
          the returning path. Signs in and lands back on this class. */}
      {mode === 'returning' && (
        <div className="mt-4 max-w-[420px]">
          <PasskeySignIn email={email || undefined} redirect={redirect} />
        </div>
      )}

      <button
        type="button"
        onClick={() => setMode(mode === 'new' ? 'returning' : 'new')}
        className="mt-4 type-label text-teal"
      >
        {mode === 'new' ? 'Already have an account?' : 'First time here?'}
      </button>
    </div>
  );
}
