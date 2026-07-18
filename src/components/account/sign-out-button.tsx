'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Ends the session and returns to the login page. */
export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    try {
      await fetch('/api/auth/session', { method: 'DELETE' });
    } catch {
      // The cookie clear is what matters; a network hiccup here should
      // not trap someone in a signed-in state — fall through to login.
    }
    router.push('/login');
    router.refresh();
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
