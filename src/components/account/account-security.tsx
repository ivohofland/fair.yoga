'use client';

import { useCallback, useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { HandoffCodeEntry } from '@/components/auth/handoff-code-entry';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readError } from '@/lib/client-errors';
import { formatDateWithYear } from '@/lib/format';
import { clearOfflinePages } from '@/lib/offline-client';
import { disablePush } from '@/lib/push-client';

interface PasskeyRow {
  id: string;
  createdAt: string;
  transports: string[];
}

type AddState = 'idle' | 'working' | 'done' | 'error';
type StepUp = 'none' | 'needed' | 'sending' | 'sent' | 'error';

interface AccountSecurityProps {
  /** The signed-in account's address; the step-up sign-in link goes here. */
  email: string;
  /** The page this renders on; the sign-in link brings the person back to it. */
  redirectPath: string;
}

// A thrown Error carries a refusal's registered code out of the ceremony's
// try block, so the catch below can branch on it.
class RefusedError extends Error {
  constructor(
    readonly step: string,
    readonly code: string | undefined,
  ) {
    super(step);
  }
}

function transportHint(transports: string[]): string | null {
  if (transports.includes('internal')) return 'This device';
  if (transports.includes('hybrid')) return 'A phone or tablet';
  if (transports.some((t) => t === 'usb' || t === 'nfc' || t === 'ble')) return 'A security key';
  return null;
}

// Sign-in security for the signed-in account: its passkeys (list, add,
// remove) and ending every session. Adding needs a sign-in within the last
// few minutes; when the server says so, the person is offered a fresh
// sign-in link that returns here.
export function AccountSecurity({ email, redirectPath }: AccountSecurityProps) {
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [listError, setListError] = useState(false);
  const [addState, setAddState] = useState<AddState>('idle');
  const [stepUp, setStepUp] = useState<StepUp>('none');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<false | 'failed' | 'signed-out'>(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);

  const loadPasskeys = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/passkey');
      if (!res.ok) throw new RefusedError('list', (await readError(res, 'list')).code);
      const json = (await res.json()) as { data: PasskeyRow[] };
      setPasskeys(json.data);
      setListError(false);
    } catch (err) {
      logRequestFailure('account-security', { step: 'list' }, err);
      setListError(true);
    }
  }, []);

  useEffect(() => {
    void loadPasskeys();
  }, [loadPasskeys]);

  async function handleAdd() {
    setAddState('working');
    setStepUp('none');
    try {
      const optionsRes = await fetch('/api/auth/passkey/register/options', { method: 'POST' });
      if (!optionsRes.ok) throw new RefusedError('options', (await readError(optionsRes, 'options')).code);
      const optionsJson = (await optionsRes.json()) as {
        data: Parameters<typeof startRegistration>[0]['optionsJSON'];
      };

      const attestation = await startRegistration({ optionsJSON: optionsJson.data });

      const verifyRes = await fetch('/api/auth/passkey/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: attestation }),
      });
      if (!verifyRes.ok) throw new RefusedError('verify', (await readError(verifyRes, 'verify')).code);

      setAddState('done');
      void loadPasskeys();
    } catch (err) {
      if (err instanceof RefusedError && err.code === 'RECENT_AUTH_REQUIRED') {
        setAddState('idle');
        setStepUp('needed');
        return;
      }
      // NotAllowedError = user dismissed the browser prompt — not a failure.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setAddState('idle');
        return;
      }
      // InvalidStateError = this device already holds a passkey for the
      // account — that's a success condition, not a broken device.
      if (err instanceof Error && err.name === 'InvalidStateError') {
        setAddState('done');
        void loadPasskeys();
        return;
      }
      logRequestFailure('account-security', { step: 'add' }, err);
      setAddState('error');
    }
  }

  async function handleSendLink() {
    setStepUp('sending');
    try {
      const res = await fetch('/api/auth/magic-link/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, redirect: redirectPath }),
      });
      if (!res.ok) throw new RefusedError('send-link', (await readError(res, 'send-link')).code);
      setStepUp('sent');
    } catch (err) {
      logRequestFailure('account-security', { step: 'send-link' }, err);
      setStepUp('error');
    }
  }

  async function handleRemove(id: string) {
    setRemovingId(id);
    setRemoveError(false);
    try {
      const res = await fetch(`/api/auth/passkey/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const { code } = await readError(res, 'remove');
        // The route's own NOT_FOUND: already removed (another tab, another
        // device), so the goal holds and the list is refreshed. A bare 404
        // is some other layer's and stays an error.
        if (code !== 'NOT_FOUND') {
          if (res.status === 401) {
            logRequestFailure('account-security', { step: 'remove', status: 401 }, new Error('session ended'));
            setRemoveError('signed-out');
            return;
          }
          throw new RefusedError('remove', code);
        }
      }
      setConfirmingId(null);
      await loadPasskeys();
    } catch (err) {
      logRequestFailure('account-security', { step: 'remove' }, err);
      setRemoveError('failed');
    } finally {
      setRemovingId(null);
    }
  }

  async function handleSignOutEverywhere() {
    setSigningOut(true);
    setSignOutError(false);
    try {
      // This device is about to lose its session; a subscription left on it
      // would keep receiving the account's notifications. Waits at most 3
      // seconds and a failure never skips the DELETE below.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logRequestFailure('account-security', { step: 'push-timeout' }, new Error('push teardown exceeded 3s'));
          resolve();
        }, 3_000);
      });
      const pushDone = disablePush()
        .catch((err: unknown) => logRequestFailure('account-security', { step: 'push' }, err))
        .finally(() => clearTimeout(timer));
      await Promise.race([pushDone, timedOut]);
      const res = await fetch('/api/auth/session/all', { method: 'DELETE' });
      // 401: the session is already gone, which is what was asked for.
      if (!res.ok && res.status !== 401) {
        throw new RefusedError('sign-out-all', (await readError(res, 'sign-out-all')).code);
      }
    } catch (err) {
      logRequestFailure('account-security', { step: 'sign-out-all' }, err);
      setSignOutError(true);
      setSigningOut(false);
      return;
    }
    try {
      // The session is gone; the device's stored teacher pages belong to it.
      await clearOfflinePages();
    } catch (err) {
      logRequestFailure('account-security', { step: 'clear-offline' }, err);
    }
    // A full navigation, so no cached authenticated shell survives.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full navigation on purpose
    window.location.assign('/login');
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        {passkeys !== null && passkeys.length > 0 && (
          <ul className="mb-3 divide-y divide-border rounded-card border border-border bg-sand-soft">
            {passkeys.map((p) => {
              const hint = transportHint(p.transports);
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 min-h-14">
                  <div>
                    <p className="type-body">Passkey added {formatDateWithYear(new Date(p.createdAt))}</p>
                    {hint && <p className="type-caption">{hint}</p>}
                  </div>
                  {confirmingId === p.id ? (
                    <div className="flex items-center gap-4">
                      <button
                        type="button"
                        className="type-label text-danger disabled:opacity-50"
                        disabled={removingId === p.id}
                        onClick={() => handleRemove(p.id)}
                      >
                        Yes, remove
                      </button>
                      <button
                        type="button"
                        className="type-label text-teal"
                        disabled={removingId === p.id}
                        onClick={() => setConfirmingId(null)}
                      >
                        Keep it
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="type-label text-danger"
                      onClick={() => {
                        setRemoveError(false);
                        setConfirmingId(p.id);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {listError && <p role="alert" className="mb-3 text-[13px] text-danger">Could not load your passkeys.</p>}
        {removeError && (
          <p role="alert" className="mb-3 text-[13px] text-danger">
            {removeError === 'signed-out' ? 'Your session has ended — sign in again.' : 'Could not remove that passkey.'}
          </p>
        )}

        {addState === 'done' && (
          <p className="type-caption mb-2 text-teal">✓ Passkey added — next sign-in is one tap</p>
        )}
        <div className="flex flex-col items-start gap-2">
          <Button variant="secondary" onClick={handleAdd} disabled={addState === 'working'}>
            {addState === 'working' ? 'Follow your device…' : 'Add a passkey'}
          </Button>
          <p className="type-caption max-w-[380px]">
            Sign in with your fingerprint, face, or device PIN — faster than the email link.
          </p>
          {addState === 'error' && (
            <p role="alert" className="text-[13px] text-danger">Could not add a passkey on this device.</p>
          )}
        </div>

        {stepUp !== 'none' && (
          <div className="mt-3 flex flex-col items-start gap-2 rounded-card border border-border bg-sand-soft p-4">
            {stepUp === 'sent' ? (
              <>
                <p className="type-body">Check {email} for a sign-in link. It brings you back here to add the passkey.</p>
                <HandoffCodeEntry />
              </>
            ) : (
              <>
                <p className="type-body">
                  To add a passkey, sign in again first. It keeps someone who borrows this device from adding
                  one.
                </p>
                <Button variant="secondary" onClick={handleSendLink} disabled={stepUp === 'sending'}>
                  {stepUp === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
                </Button>
              </>
            )}
            {stepUp === 'error' && (
              <p role="alert" className="text-[13px] text-danger">Could not send the sign-in link.</p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col items-start gap-2">
        <Button variant="destructive" onClick={handleSignOutEverywhere} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out everywhere'}
        </Button>
        <p className="type-caption max-w-[380px]">
          Ends every session on every device, this one included.
        </p>
        {signOutError && (
          <p role="alert" className="text-[13px] text-danger">Could not sign out everywhere — try again.</p>
        )}
      </div>
    </div>
  );
}
