'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface SignOutButtonProps {
  /**
   * Where the browser lands once the session is gone. `/login` is right for
   * Settings and the account page, which is why it is the default. The signup
   * flow passes `/signup` (#431): someone signing out in order to sign UP
   * wants the signup page, and `/login` would be a second closed door in a
   * flow this control exists to open.
   */
  redirectTo?: string;
}

/** Ends the session and sends the browser to `redirectTo`. */
export function SignOutButton({ redirectTo = '/login' }: SignOutButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    try {
      await fetch('/api/auth/session', { method: 'DELETE' });
    } catch {
      // The cookie clear is what matters; a network hiccup here should
      // not trap someone in a signed-in state — leave anyway.
    } finally {
      // #40. Neither the push nor the refresh is guaranteed to commit on a
      // starved or offline device, and both return `void`, so this component
      // cannot learn whether they did. Resetting here means a dropped commit
      // leaves a tappable button rather than a stale authenticated shell with
      // no way out. DELETE /api/auth/session is idempotent, so a second tap
      // costs nothing.
      router.push(redirectTo);
      router.refresh();
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSignOut}
      disabled={busy}
      className="type-label text-teal disabled:opacity-50"
    >
      {busy ? 'Signing out...' : 'Sign out'}
    </button>
  );
}
