'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** The longest delay `setTimeout` holds; beyond it the timer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Re-renders the server components when each instant arrives, for a page whose
 * content depends on the clock at render time. `instants` are ISO strings; one
 * already past, or further away than `setTimeout` can wait, is ignored.
 */
export function RefreshAt({ instants }: { instants: readonly string[] }) {
  const router = useRouter();
  // A string key, so a new array with the same instants does not reset the timers.
  const key = instants.join('|');

  useEffect(() => {
    const now = Date.now();
    const timers = key
      .split('|')
      .map((iso) => new Date(iso).getTime() - now)
      .filter((delay) => delay > 0 && delay <= MAX_TIMEOUT_MS)
      .map((delay) => setTimeout(() => router.refresh(), delay));
    return () => timers.forEach(clearTimeout);
  }, [key, router]);

  return null;
}
