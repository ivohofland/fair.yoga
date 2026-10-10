'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readError } from '@/lib/client-errors';

type State = 'ready' | 'revoking' | 'revoked' | 'invalid' | 'limited' | 'failed' | 'unknown' | 'rejected';

/** The `t` parameter of the address's fragment, where the email puts the token. */
function tokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('t');
  return token === null || token === '' ? null : token;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

const linkClass =
  'text-teal underline decoration-[0.5px] underline-offset-[3px] rounded-field focus:outline-none focus-visible:shadow-focus';

/**
 * The one button that signs out and removes the added passkey where it can. The token is
 * read from the fragment after hydration and sent only when the button is
 * pressed: a mail scanner that opens the link changes nothing. A success
 * drops the token from the address, so the history entry no longer carries it.
 */
export function PasskeyRevokeForm() {
  const [state, setState] = useState<State>('ready');
  // Set once an attempt's outcome is unknown: a used link afterwards may be
  // that attempt's doing.
  const [lostEarlier, setLostEarlier] = useState(false);
  // `undefined` on the server and through hydration: the fragment never
  // reaches the server.
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => undefined);
  const token = hash === undefined ? null : tokenFromHash(hash);
  const missing = hash !== undefined && token === null;

  async function handleRevoke() {
    if (token === null) return;
    setState('revoking');
    let res: Response;
    try {
      res = await fetch('/api/passkey-revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      logRequestFailure('passkey-revoke', {}, err);
      setLostEarlier(true);
      setState('unknown');
      return;
    }
    if (res.ok) {
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch (err) {
        // The revoke committed; only dropping the spent token from the address failed.
        logRequestFailure('passkey-revoke', { step: 'replace-state' }, err);
      }
      setState('revoked');
      return;
    }
    if (res.status === 429) {
      setState('limited');
      return;
    }
    // An empty fallback marks a body the app did not write.
    const { code, message } = await readError(res, '');
    if (code === 'REVOKE_LINK_INVALID') {
      setState('invalid');
      return;
    }
    logRequestFailure('passkey-revoke', { status: res.status, code }, new Error('revoke refused'));
    // Only a coded refusal or the app's own busy answer says the revoke did not
    // happen; anything else (a gateway, a proxy's page, an uncoded refusal)
    // leaves the outcome unknown.
    if (code !== undefined && res.status >= 400 && res.status < 500) {
      setState('rejected');
      return;
    }
    if (res.status === 503 && message !== '') {
      setState('failed');
      return;
    }
    setLostEarlier(true);
    setState('unknown');
  }

  if (state === 'revoked') {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="type-subtitle">You are signed out everywhere</p>
        <p className="type-body">
          Every device has been signed out. If the passkey is still listed under your passkeys, you can
          remove it there once you sign in. Anyone who can read your inbox can still ask for a new
          sign-in link, so check your email account too.
        </p>
        <p className="type-body">
          <Link href="/login" className={linkClass}>Sign in</Link>
        </p>
      </div>
    );
  }

  if (state === 'invalid' || missing) {
    return (
      <div role="alert" className="flex flex-col gap-3">
        <p className="type-body">
          {state !== 'invalid'
            ? 'This link is incomplete. Open it again from the email, or copy the whole address.'
            : lostEarlier
              ? 'This link has already been used, perhaps by your earlier attempt.'
              : 'This link no longer works. It may have been used already, or it has expired.'}
        </p>
        <p className="type-body">
          If you&rsquo;re worried about your account, <Link href="/login" className={linkClass}>sign in</Link> and
          check your passkeys.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        onClick={handleRevoke}
        disabled={token === null || state === 'revoking'}
        className="w-full"
      >
        {state === 'revoking' ? 'Signing you out…' : "This wasn't me"}
      </Button>
      {state === 'failed' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Something went wrong, and you were not signed out. Please try again.
        </p>
      )}
      {state === 'unknown' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          We couldn&rsquo;t confirm that you were signed out. To check, press This wasn&apos;t me again: if it
          says this link no longer works, the link has been used.
        </p>
      )}
      {state === 'rejected' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Nothing was signed out. Open the link from the email again, or copy the whole address.
        </p>
      )}
      {state === 'limited' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Too many attempts from here. Wait a few minutes and try again.
        </p>
      )}
    </div>
  );
}
