'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { readErrorMessage } from '@/lib/client-errors';

interface HandoffCodeEntryProps {
  className?: string;
}

/**
 * The claiming half of the magic-link device handoff (#214). A link opened
 * somewhere that doesn't hold the `fair_yoga_origin` cookie shows a 6-digit
 * code instead of consuming the link, and this form trades that code for a
 * session on the browser that requested it, by posting to
 * `POST /api/auth/magic-link/claim`. Meant to be shared by any "Check your
 * inbox" panel, so its own copy and behaviour don't fork across them.
 *
 * No props carry state: the cookie that ties a code to this browser rides
 * along with the request on its own, and this component never reads or
 * sets it.
 */
export function HandoffCodeEntry({ className = '' }: HandoffCodeEntryProps) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    try {
      const res = await fetch('/api/auth/magic-link/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        const json = (await res.json()) as { data: { redirectTo: string } };
        // A full navigation, not `router.push`: this response just set a
        // cookie — a session, or a signup ticket — and server components
        // must re-render against it.
        window.location.assign(json.data.redirectTo);
        return;
      }
      setErrorMessage(
        await readErrorMessage(res, 'That code did not work. Ask for a new link.'),
      );
      setStatus('error');
    } catch {
      setErrorMessage('Network error. Please try again.');
      setStatus('error');
    }
  }

  return (
    <div className={`mt-4 ${className}`.trim()}>
      <p className="type-body">
        Opened it somewhere else? That device will show you a code &mdash;
        enter it here.
      </p>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 mt-3 max-w-[200px]">
        <Input
          label="Code"
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (status === 'error') setStatus('idle');
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="\d{6}"
          placeholder="123456"
          required
        />
        <Button type="submit" variant="secondary" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Checking...' : 'Continue'}
        </Button>
        {status === 'error' && (
          <p role="alert" className="text-[13px] leading-[1.4] text-danger">
            {errorMessage}
          </p>
        )}
      </form>
    </div>
  );
}
