'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { logRequestFailure } from '@/lib/client-errors';
import { clearOutbox, readOutbox } from '@/lib/attendance-outbox';
import { flushWithinWait } from '@/lib/attendance-sync';
import { clearOfflinePages } from '@/lib/offline-client';
import { disablePush } from '@/lib/push-client';

interface SignOutButtonProps {
  /**
   * The signed-in account, whose queued attendance changes are sent before
   * leaving; null where the page knows of none. Another account's are never
   * sent under this session: they are counted, and leaving discards them.
   */
  accountId: string | null;
  /**
   * Where the browser lands once the session is gone. Defaults to `/login`;
   * pass an explicit destination when signing out is a step toward
   * somewhere else (e.g. re-starting a signup under a different address).
   */
  redirectTo?: '/login' | '/signup' | `/login?redirect=${string}`;
}

function pendingCount(): number {
  return Object.keys(readOutbox().pending).length;
}

/** Registrations with a change on the device that the server does not hold: pending, refused, or both. */
function unsyncedCount(): number {
  const { pending, refused } = readOutbox();
  return new Set([...Object.keys(pending), ...Object.keys(refused)]).size;
}

/** Ends the session and sends the browser to `redirectTo` either way —
 *  a failed DELETE surfaces a visible message but never blocks the leave.
 *  The signed-in account's queued attendance changes are sent first; any
 *  change still on the device after that, pending or refused, whichever
 *  account made it, is counted, and leaving then needs a second, explicit
 *  tap. */
export function SignOutButton({ accountId, redirectTo = '/login' }: SignOutButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [unsynced, setUnsynced] = useState(0);

  async function handleSignOut() {
    setBusy(true);
    setUnsynced(0);
    if (accountId !== null && pendingCount() > 0) await flushWithinWait(accountId, 'sign-out-button');
    // Read after the flush, so a refusal it just produced is counted too.
    const remaining = unsyncedCount();
    if (remaining > 0) {
      setUnsynced(remaining);
      setBusy(false);
      return;
    }
    await leave();
  }

  async function leave() {
    setBusy(true);
    setUnsynced(0);
    let cleared = false;
    try {
      // A device left subscribed would keep receiving this account's
      // notifications after someone else signs in on it. Waiting at most 3
      // seconds, so a stuck service worker never blocks leaving; a failure
      // never skips the session DELETE below.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logRequestFailure('sign-out-button', { step: 'push-timeout' }, new Error('push teardown exceeded 3s'));
          resolve();
        }, 3_000);
      });
      const pushDone = disablePush()
        .catch((err: unknown) => logRequestFailure('sign-out-button', { step: 'push' }, err))
        .finally(() => clearTimeout(timer));
      await Promise.race([pushDone, timedOut]);
      const res = await fetch('/api/auth/session', { method: 'DELETE' });
      cleared = res.ok;
    } catch (err) {
      // cleared stays false — surfaced below as well as logged.
      logRequestFailure('sign-out-button', {}, err);
    } finally {
      // The device's stored teacher pages belong to the account that just left.
      await clearOfflinePages();
      try {
        await clearOutbox();
      } catch (err) {
        logRequestFailure('sign-out-button', { step: 'clear-outbox' }, err);
      }
      // #40. Neither `router.push` nor `router.refresh` is guaranteed to
      // commit on a starved or offline device, and both return `void`, so this
      // component cannot learn whether they did. Resetting here means a dropped commit
      // leaves a tappable button rather than a stale authenticated shell with
      // no way out. DELETE /api/auth/session is idempotent, so a second tap
      // costs nothing.
      setSignOutFailed(!cleared);
      router.push(redirectTo);
      router.refresh();
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={busy}
        className="type-label text-teal disabled:opacity-50"
      >
        {busy ? 'Signing out...' : 'Sign out'}
      </button>
      {unsynced > 0 && (
        <>
          <p role="alert" className="type-caption text-danger">
            {unsynced === 1
              ? "1 attendance change hasn't synced."
              : `${unsynced} attendance changes haven't synced.`}{' '}
            Signing out discards them.
          </p>
          <button type="button" onClick={leave} disabled={busy} className="type-label text-teal disabled:opacity-50">
            Sign out anyway
          </button>
        </>
      )}
      {signOutFailed && (
        <p role="alert" className="type-caption text-danger">Couldn&apos;t sign out — try again.</p>
      )}
    </>
  );
}
