'use client';

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasskeySignIn } from '@/components/booking/passkey-sign-in';
import { HandoffCodeEntry } from '@/components/auth/handoff-code-entry';
import { isLoginRedirectTarget } from '@/lib/schemas';

function LoginForm() {
  const searchParams = useSearchParams();
  const rawRedirect = searchParams.get('redirect');
  const redirect =
    rawRedirect && isLoginRedirectTarget(rawRedirect) ? rawRedirect : undefined;

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch('/api/auth/magic-link/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, ...(redirect ? { redirect } : {}) }),
      });
      if (res.ok) {
        setStatus('sent');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  }

  return (
    <div className="flex-1 flex flex-col justify-center py-10">
      {status === 'sent' ? (
        <div>
          <p className="type-body">Check your inbox for the link.</p>
          <HandoffCodeEntry />
        </div>
      ) : (
        <>
          <h1 className="type-display mb-5">
            Sign in with a link
            <br />
            sent to your inbox
          </h1>
          <p className="type-body max-w-[360px] mb-8">
            Enter your email address — teacher or student. We&apos;ll email a
            link that works for fifteen minutes.
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              label="Email"
              type="email"
              name="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); if (status === 'error') setStatus('idle'); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
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

          <div className="mt-4">
            <PasskeySignIn redirect={redirect} />
          </div>

          {/* For anyone who bookmarked /login before they had an account. */}
          <p className="mt-6 type-caption">
            New here?{' '}
            <Link href="/signup" className="text-teal">
              Start teaching on fair.yoga
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
