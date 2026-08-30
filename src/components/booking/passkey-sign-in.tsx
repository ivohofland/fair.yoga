'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';

interface PasskeySignInProps {
  /** Narrow the credential list when the visitor already typed an email. */
  email?: string;
  /** Where to land after sign-in (relative path) — defaults to the role home. */
  redirect?: string;
}

export function PasskeySignIn({ email, redirect }: PasskeySignInProps) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');

  async function handleSignIn() {
    setState('working');
    try {
      const optionsRes = await fetch('/api/auth/passkey/authenticate/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(email ? { email } : {}),
      });
      if (!optionsRes.ok) throw new Error('options');
      const json = (await optionsRes.json()) as {
        data: { options: Parameters<typeof startAuthentication>[0]['optionsJSON']; challengeId: string };
      };

      const assertion = await startAuthentication({ optionsJSON: json.data.options });

      const verifyRes = await fetch('/api/auth/passkey/authenticate/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: assertion,
          challengeId: json.data.challengeId,
          ...(redirect ? { redirect } : {}),
        }),
      });
      if (!verifyRes.ok) throw new Error('verify');

      const verified = (await verifyRes.json()) as { data: { redirectTo: string } };
      router.push(verified.data.redirectTo);
      router.refresh();
      // #40. Explicitly NOT a `finally`: `state` carries the error too, so a
      // blanket reset would erase the `'error'` the catch below sets and the
      // user would be told nothing when a verify fails. Reset here, on the
      // success path only. Sign-in is idempotent — a retry mints a fresh
      // challenge and succeeds again — so returning to idle is safe, and it
      // beats freezing the gate to the whole app when the push never commits.
      setState('idle');
    } catch (err) {
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setState('idle');
        return;
      }
      setState('error');
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" onClick={handleSignIn} disabled={state === 'working'} className="w-full">
        {state === 'working' ? 'Follow your device…' : 'Sign in with a passkey'}
      </Button>
      {state === 'error' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Passkey sign-in didn&apos;t work here — use the email link instead.
        </p>
      )}
    </div>
  );
}
