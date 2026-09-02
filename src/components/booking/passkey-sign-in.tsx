'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';

const DEFAULT_ERROR_MESSAGE = "Passkey sign-in didn't work here — use the email link instead.";

interface PasskeySignInProps {
  /** Where to land after sign-in (relative path) — defaults to the role home. */
  redirect?: string;
}

export function PasskeySignIn({ redirect }: PasskeySignInProps) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'incomplete' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState(DEFAULT_ERROR_MESSAGE);

  async function handleSignIn() {
    setState('working');
    try {
      const optionsRes = await fetch('/api/auth/passkey/authenticate/options', {
        method: 'POST',
      });
      if (optionsRes.status === 429) {
        const body = (await optionsRes.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setErrorMessage(body?.error?.message ?? DEFAULT_ERROR_MESSAGE);
        setState('error');
        return;
      }
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
      // The browser folds every "the ceremony didn't produce a credential"
      // case — cancel, timeout, no matching credential, a cross-device flow
      // still pending elsewhere, and whatever WebAuthn adds next — into the
      // same `NotAllowedError`, and does not say which. That's deliberate:
      // telling them apart would mean probing the device for credentials,
      // which reopens on the client the disclosure #187 closed on the
      // server. The status copy below states only the observable fact
      // (nothing came back) and gives guidance that works no matter which
      // cause fired: a retry, or the email link.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setState('incomplete');
        return;
      }
      setErrorMessage(DEFAULT_ERROR_MESSAGE);
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
          Nothing came back from your device. Try again, or use the email link.
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
