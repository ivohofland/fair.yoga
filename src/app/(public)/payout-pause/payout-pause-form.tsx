'use client';

import Link from 'next/link';
import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readError } from '@/lib/client-errors';

type State = 'ready' | 'pausing' | 'paused' | 'invalid' | 'limited' | 'failed' | 'unknown' | 'rejected';

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
 * The one button that pauses. The token is read from the fragment after
 * hydration and sent only when the button is pressed: a mail scanner that
 * opens the link pauses nothing. A pause that succeeded drops the token from
 * the address, so the history entry no longer carries it.
 */
export function PayoutPauseForm() {
  const [state, setState] = useState<State>('ready');
  // Set once a request's answer was lost: the pause may have gone through,
  // and a used link afterwards is most likely that attempt's doing.
  const [lostEarlier, setLostEarlier] = useState(false);
  // `undefined` on the server and through hydration: the fragment never
  // reaches the server.
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => undefined);
  const token = hash === undefined ? null : tokenFromHash(hash);
  const missing = hash !== undefined && token === null;

  async function handlePause() {
    if (token === null) return;
    setState('pausing');
    let res: Response;
    try {
      res = await fetch('/api/payout-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      logRequestFailure('payout-pause', {}, err);
      setLostEarlier(true);
      setState('unknown');
      return;
    }
    if (res.ok) {
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch (err) {
        // The pause committed; only dropping the spent token from the address failed.
        logRequestFailure('payout-pause', { step: 'replace-state' }, err);
      }
      setState('paused');
      return;
    }
    if (res.status === 429) {
      setState('limited');
      return;
    }
    const { code } = await readError(res, 'Something went wrong, and nothing was paused.');
    if (code === 'PAUSE_LINK_INVALID') {
      setState('invalid');
      return;
    }
    logRequestFailure('payout-pause', { status: res.status, code }, new Error('pause refused'));
    setState(res.status === 400 || res.status === 403 || res.status === 404 ? 'rejected' : 'failed');
  }

  if (state === 'paused') {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p className="type-subtitle">Payments are paused</p>
        <p className="type-body">
          Every device has been signed out, and your students are being asked to hold off paying. When
          you&rsquo;re ready, sign in, check your payment details and resume payments.
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
              ? 'This link has now been used: your earlier attempt most likely paused payments.'
              : 'This link no longer works. It may have been used already, or it has expired.'}
        </p>
        <p className="type-body">
          If you&rsquo;re worried about your payment details, <Link href="/login" className={linkClass}>sign in</Link> and
          check them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button
        type="button"
        onClick={handlePause}
        disabled={token === null || state === 'pausing'}
        className="w-full"
      >
        Pause payments
      </Button>
      {state === 'failed' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Something went wrong, and nothing was paused. Please try again.
        </p>
      )}
      {state === 'unknown' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          We couldn&rsquo;t tell whether payments were paused. Press the button again: if it then says this link no
          longer works, the pause went through.
        </p>
      )}
      {state === 'rejected' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Nothing was paused. Open the link from the email again, or copy the whole address.
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
