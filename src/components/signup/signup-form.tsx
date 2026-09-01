'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface SignupFormProps {
  /** Heading above the field. */
  title: string;
  /** One line on what the emailed link does. */
  intro: string;
  /** What the "Check your inbox" panel says the link will do. */
  sentMessage: string;
  initialEmail?: string;
}

/**
 * Email-only teacher signup (#385): one address, no password, and a link in
 * the inbox. Same shape as `booking-sign-in.tsx` — an idle form that swaps
 * itself for a "Check your inbox" panel, since there is nothing left to do
 * on this page once the link is sent.
 *
 * Copy is a prop because `/signup/profile` mounts this too, as its
 * no-ticket recovery prompt: the same request, asked for a different reason.
 *
 * The route answers a uniform 200 whether or not the address has an account,
 * so there is deliberately nothing here that could tell the two apart.
 */
export function SignupForm({ title, intro, sentMessage, initialEmail = '' }: SignupFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch('/api/auth/teacher-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
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
        <p className="type-body mt-2 max-w-[420px]">{sentMessage}</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="type-display mb-5">{title}</h1>
      <p className="type-body max-w-[420px] mb-8">{intro}</p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="Email"
          type="email"
          name="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === 'error') setStatus('idle');
          }}
          placeholder="you@example.com"
          required
        />
        <Button type="submit" disabled={status === 'sending'} className="w-full">
          {status === 'sending' ? 'Sending...' : 'Send me the link'}
        </Button>
        {status === 'error' && (
          <p role="alert" className="text-[13px] leading-[1.4] text-danger">
            Something went wrong. Please try again.
          </p>
        )}
      </form>
    </div>
  );
}
