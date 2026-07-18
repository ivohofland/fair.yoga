'use client';

import { useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';

// Adds a passkey to the signed-in account: next sign-in is Face ID /
// fingerprint / device PIN instead of waiting for an email.
export function AddPasskey() {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleAdd() {
    setState('working');
    setMessage('');
    try {
      const optionsRes = await fetch('/api/auth/passkey/register/options', { method: 'POST' });
      if (!optionsRes.ok) throw new Error('options');
      const optionsJson = (await optionsRes.json()) as { data: Parameters<typeof startRegistration>[0]['optionsJSON'] };

      const attestation = await startRegistration({ optionsJSON: optionsJson.data });

      const verifyRes = await fetch('/api/auth/passkey/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: attestation }),
      });
      if (!verifyRes.ok) throw new Error('verify');

      setState('done');
    } catch (err) {
      // NotAllowedError = user dismissed the browser prompt — not a failure.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setState('idle');
        return;
      }
      setState('error');
      setMessage('Could not add a passkey on this device.');
    }
  }

  if (state === 'done') {
    return <p className="type-caption text-teal">✓ Passkey added — next sign-in is one tap</p>;
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="secondary" onClick={handleAdd} disabled={state === 'working'}>
        {state === 'working' ? 'Follow your device…' : 'Add a passkey'}
      </Button>
      <p className="type-caption max-w-[380px]">
        Sign in with your fingerprint, face, or device PIN — faster than the email link.
      </p>
      {state === 'error' && <p className="text-[13px] text-danger">{message}</p>}
    </div>
  );
}
