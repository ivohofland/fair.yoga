'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** The longest delay `setTimeout` holds; beyond it the timer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Re-renders the server components when each instant arrives, for a page whose
 * content depends on the clock at render time. `instants` are ISO strings the
 * server computed; `serverNow` is the server's render time, in epoch ms.
 *
 * Each wait is `instant − serverNow`, not `instant − Date.now()`: counted from
 * the server's render, a timer can only fire at or after the server-side
 * instant, whatever the client clock says. An instant at or before
 * `serverNow`, or further away than `setTimeout` can wait, is ignored.
 * `serverNow` is an effect dependency, so every render re-arms, even one with
 * the same instants.
 */
export function RefreshAt({ instants, serverNow }: { instants: readonly string[]; serverNow: number }) {
  const router = useRouter();
  // A string key, so a new array with the same instants does not reset the timers.
  const key = instants.join('|');

  useEffect(() => {
    const timers = key
      .split('|')
      .map((iso) => new Date(iso).getTime() - serverNow)
      .filter((delay) => delay > 0 && delay <= MAX_TIMEOUT_MS)
      .map((delay) => setTimeout(() => router.refresh(), delay));
    return () => timers.forEach(clearTimeout);
  }, [key, serverNow, router]);

  return null;
}
