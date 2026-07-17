'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    try {
      const res = await fetch('/api/auth/magic-link/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
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
        <p className="fy-lede">Check your inbox for the link.</p>
      ) : (
        <>
          <h1 className="fy-pullquote mb-5" style={{ fontSize: '32px', lineHeight: 1.15 }}>
            Sign in with a link
            <br />
            sent to your inbox
          </h1>
          <p className="fy-lede max-w-[360px] mb-8">
            Enter the email you teach with. We&apos;ll email a link that works for ten minutes.
          </p>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <Input
              label="Email"
              type="email"
              name="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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
              <p className="font-heading italic text-[12px] text-error">
                Something went wrong. Please try again.
              </p>
            )}
          </form>
        </>
      )}
    </div>
  );
}
