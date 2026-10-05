'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { clearAllOutboxes, pendingCount, pendingCountAllOwners } from '@/lib/attendance-outbox';
import { logRequestFailure } from '@/lib/client-errors';
import { flushWithinBound } from '@/lib/flush-within-bound';
import { clearOfflinePages } from '@/lib/offline-client';
import { disablePush } from '@/lib/push-client';

interface SignOutButtonProps {
  /**
   * Where the browser lands once the session is gone. Defaults to `/login`;
   * pass an explicit destination when signing out is a step toward
   * somewhere else (e.g. re-starting a signup under a different address).
   */
  redirectTo?: '/login' | '/signup';
  /**
   * The account whose queued attendance this button tries to sync first.
   * With it, anything of that account's still queued or refused after the
   * flush is named in an inline confirm before the session is touched.
   * Without it nothing is flushed, there being no account to send as, and the
   * confirm names what any account on this device has queued or refused: the
   * clear discards every account's.
   */
  outboxOwner?: string;
}

function unsyncedCopy(count: number): string {
  return count === 1
    ? "1 attendance change hasn't synced and will be lost."
    : `${count} attendance changes haven't synced and will be lost.`;
}

/** Ends the session and sends the browser to `redirectTo` either way —
 *  a failed DELETE surfaces a visible message but never blocks the leave.
 *  The one stop before that is the unsynced-attendance confirm, which sends
 *  nothing until the teacher chooses. */
export function SignOutButton({ redirectTo = '/login', outboxOwner }: SignOutButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [unsynced, setUnsynced] = useState<number | null>(null);
  const reasonId = useId();
  const confirming = unsynced !== null;
  const signOutRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // The control that had focus unmounts as the confirm replaces it, and back:
  // focus follows onto Cancel, and back onto Sign out.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) signOutRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  async function handleSignOut() {
    setBusy(true);
    let left: number;
    if (outboxOwner === undefined) {
      left = pendingCountAllOwners();
    } else {
      await flushWithinBound(outboxOwner, 'sign-out-button');
      left = pendingCount(outboxOwner);
    }
    if (left > 0) {
      setUnsynced(left);
      setBusy(false);
      return;
    }
    await leave();
  }

  function handleSignOutAnyway() {
    setUnsynced(null);
    setBusy(true);
    void leave();
  }

  async function leave() {
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
      // The device's stored teacher pages and queued attendance belong to the
      // account that just left — cleared whether or not the DELETE succeeded.
      await clearOfflinePages();
      clearAllOutboxes();
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

  if (confirming) {
    return (
      <div className="flex flex-col gap-3">
        <p id={reasonId} className="type-body max-w-[420px]">{unsyncedCopy(unsynced)}</p>
        <div className="flex gap-3">
          <Button variant="destructive" onClick={handleSignOutAnyway} aria-describedby={reasonId}>
            Sign out anyway
          </Button>
          <Button ref={cancelRef} variant="secondary" onClick={() => setUnsynced(null)} aria-describedby={reasonId}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      <button
        ref={signOutRef}
        type="button"
        onClick={handleSignOut}
        disabled={busy}
        className="type-label text-teal disabled:opacity-50"
      >
        {busy ? 'Signing out...' : 'Sign out'}
      </button>
      {signOutFailed && (
        <p role="alert" className="type-caption text-danger">Couldn&apos;t sign out — try again.</p>
      )}
    </>
  );
}
