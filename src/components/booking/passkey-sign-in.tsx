'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';

interface PasskeySignInProps {
  /** Where to land after sign-in (relative path) — defaults to the role home. */
  redirect?: string;
}

export function PasskeySignIn({ redirect }: PasskeySignInProps) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'incomplete' | 'error'>('idle');

  async function handleSignIn() {
    setState('working');
    try {
      const optionsRes = await fetch('/api/auth/passkey/authenticate/options', {
        method: 'POST',
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
      // The browser reports a deliberate cancel and a ceremony that matched no
      // credential as the same `NotAllowedError`, and does not say which —
      // WebAuthn conflates them so the client cannot become an enumeration
      // oracle. Do not try to tell them apart by probing the device for
      // credentials: that reopens on the client the disclosure #187 closed on
      // the server. Naming both possibilities lets each reader take the step
      // that works — a retry for one, the email link for the other.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setState('incomplete');
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
      {state === 'incomplete' && (
        <p role="status" className="type-caption">
          Cancelled, or no passkey on this device. Try again, or use the email link.
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Passkey sign-in didn&apos;t work here — use the email link instead.
        </p>
      )}
    </div>
  );
}
