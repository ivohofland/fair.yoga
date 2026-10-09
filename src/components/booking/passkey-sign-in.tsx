'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';
import { clearOfflinePages } from '@/lib/offline-client';
import { recordPushDeviceForSignIn } from '@/lib/push-client';
import { Button } from '@/components/ui/button';

const DEFAULT_ERROR_MESSAGE = "Passkey sign-in didn't work here — use the email link instead.";
const RETRY_ONLY_ERROR_MESSAGE = "Passkey sign-in didn't work here. Try again.";

interface PasskeySignInProps {
  /** Where to land after sign-in (relative path) — defaults to the role home. */
  redirect?: string;
  /** False where the page has no email sign-in to point to: the copy then offers only a retry. */
  emailFallback?: boolean;
}

export function PasskeySignIn({ redirect, emailFallback = true }: PasskeySignInProps) {
  const router = useRouter();
  const defaultErrorMessage = emailFallback ? DEFAULT_ERROR_MESSAGE : RETRY_ONLY_ERROR_MESSAGE;
  const [state, setState] = useState<'idle' | 'working' | 'incomplete' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState(defaultErrorMessage);

  async function handleSignIn() {
    setState('working');
    try {
      const optionsRes = await fetch('/api/auth/passkey/authenticate/options', {
        method: 'POST',
      });
      if (optionsRes.status === 429) {
        setErrorMessage(await readErrorMessage(optionsRes, defaultErrorMessage));
        setState('error');
        return;
      }
      if (!optionsRes.ok) {
        console.error('[passkey-sign-in] options request refused', { status: optionsRes.status });
        throw new Error('options');
      }
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
      if (!verifyRes.ok) {
        console.error('[passkey-sign-in] verify request refused', { status: verifyRes.status });
        throw new Error('verify');
      }

      const verified = (await verifyRes.json()) as { data: { redirectTo: string } };
      // Not awaited: `router.push` below is a client navigation, so the
      // request is not aborted by it.
      void recordPushDeviceForSignIn();
      void clearOfflinePages();
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
      logRequestFailure('passkey-sign-in', {}, err);
      setErrorMessage(defaultErrorMessage);
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
          {emailFallback
            ? 'Nothing came back from your device. Try again, or use the email link.'
            : 'Nothing came back from your device. Try again.'}
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
