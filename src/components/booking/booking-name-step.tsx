'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readErrorMessage } from '@/lib/client-errors';

interface BookingNameStepProps {
  /** The verified address, from the signup ticket. Display only: the route
   *  takes the email from the ticket it consumes, never from us. */
  email: string;
  /** This booking page — where a re-sent link must come back to. */
  redirect: string;
}

/**
 * `expired` and `expired-stuck` are the same event told honestly two ways:
 * the ticket aged out mid-typing, and the replacement link either went out
 * or did not. Saying "we've emailed you a fresh link" when that request
 * failed is worse than saying nothing.
 */
type Status = 'idle' | 'submitting' | 'expired' | 'expired-stuck';

/**
 * The name step of student signup (#399): the profile the ticket authorises.
 *
 * No `localStorage` draft, unlike `ProfileSetupForm`. That form persists one
 * because it is four fields including a bio and an availability-checked page
 * address; two name fields do not earn the shared-browser hazard that
 * machinery exists to manage.
 */
export function BookingNameStep({ email, redirect }: BookingNameStepProps) {
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  // The reason a resend landed on `expired-stuck`, when the server gave one
  // — a 429's retry time, a 400, or `student-signup`'s own `delivered:
  // false` message. Empty when the resend rejected outright (network error)
  // or returned nothing readable; the fixed copy covers that case.
  const [resendMessage, setResendMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setError('');
    setResendMessage('');

    let res: Response;
    try {
      res = await fetch('/api/account/student-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
        }),
      });
    } catch {
      setStatus('idle');
      setError('Network error. Please try again.');
      return;
    }

    if (res.ok) {
      // This response set the session cookie, so the refreshed server render
      // moves this branch to BookingFlow. `status` stays 'submitting' under
      // a navigation already in flight; the timer is the same guard
      // JoinAsStudent uses so a failed round-trip leaves no dead button.
      router.refresh();
      setTimeout(() => setStatus('idle'), 4000);
      return;
    }

    if (res.status === 401) {
      // The ticket aged out while they were typing. Not an error — a
      // re-send, with both names left exactly where they are.
      let resendRes: Response;
      try {
        resendRes = await fetch('/api/auth/student-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, redirect }),
        });
      } catch {
        setResendMessage('');
        setStatus('expired-stuck');
        return;
      }

      if (!resendRes.ok) {
        // A rate limit or validation error on the resend itself — the
        // server's own message names the real reason (e.g. a retry time),
        // which the fixed copy below cannot.
        setResendMessage(await readErrorMessage(resendRes, ''));
        setStatus('expired-stuck');
        return;
      }

      // 200 either way now (student-signup never answers non-2xx for a mail
      // failure) — `delivered` in the body is the true outcome, not `res.ok`.
      let body: { data?: { delivered?: boolean; message?: string } } | null;
      try {
        body = await resendRes.json();
      } catch {
        body = null;
      }
      if (body?.data?.delivered === true) {
        setStatus('expired');
        return;
      }
      setResendMessage(body?.data?.message ?? '');
      setStatus('expired-stuck');
      return;
    }

    setStatus('idle');
    setError(await readErrorMessage(res, 'Something went wrong. Please try again.'));
  }

  return (
    <div>
      <h2 className="type-subtitle mb-1">One last thing</h2>
      <p className="type-body mb-4 max-w-[420px]">
        We&apos;ve confirmed <span className="text-ink">{email}</span>. Your
        teacher sees your first name and last initial on their class list &mdash;
        you can share more, or change this, in your account later.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-[420px]">
        <Input
          label="First name"
          value={firstName}
          onChange={(e) => { setFirstName(e.target.value); if (error) setError(''); }}
          required
        />
        <Input
          label="Last name"
          value={lastName}
          onChange={(e) => { setLastName(e.target.value); if (error) setError(''); }}
          required
        />
        <Button type="submit" disabled={status === 'submitting'} className="w-full">
          {status === 'submitting' ? 'One moment...' : 'Continue'}
        </Button>

        {status === 'expired' && (
          <p role="status" className="type-caption">
            That took a while &mdash; we&apos;ve emailed you a fresh link. Your
            details are still here.
          </p>
        )}
        {status === 'expired-stuck' && (
          <p role="status" className="type-caption">
            That took a while and the link expired &mdash; and we couldn&apos;t
            send a fresh one just now. Your details are still here.{' '}
            {resendMessage || 'Try again in a moment.'}
          </p>
        )}
        {error && (
          <p role="alert" className="text-[13px] leading-[1.4] text-danger">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
