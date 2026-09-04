'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface SignOutButtonProps {
  /**
   * Where the browser lands once the session is gone. Defaults to `/login`;
   * pass an explicit destination when signing out is a step toward
   * somewhere else (e.g. re-starting a signup under a different address).
   */
  redirectTo?: '/login' | '/signup';
}

/** Ends the session and sends the browser to `redirectTo`. */
export function SignOutButton({ redirectTo = '/login' }: SignOutButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    let cleared = false;
    try {
      const res = await fetch('/api/auth/session', { method: 'DELETE' });
      cleared = res.ok;
    } catch {
      // Network failure; cleared stays false — surfaced below, not silent.
    } finally {
      // #40. Neither the push nor the refresh is guaranteed to commit on a
      // starved or offline device, and both return `void`, so this component
      // cannot learn whether they did. Resetting here means a dropped commit
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
      {signOutFailed && (
        <p role="alert" className="type-caption text-danger">Couldn&apos;t sign out — try again.</p>
      )}
    </>
  );
}
