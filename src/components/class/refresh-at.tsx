'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** The longest delay `setTimeout` holds; beyond it the timer fires at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** How many distinct `serverNow` values a client is remembered mounting with, bounding `seenServerNows` below. */
const MAX_REMEMBERED_SERVER_NOWS = 20;

/**
 * `serverNow` values this client has already mounted `RefreshAt` with,
 * oldest first. A value reappearing means the page came back from Next's
 * client router cache with its old render payload rather than a fresh
 * server render — see `RefreshAt`'s docblock.
 */
const seenServerNows = new Set<number>();

/** Test-only: forget every remembered `serverNow` value. */
export function resetSeenServerNows(): void {
  seenServerNows.clear();
}

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
 *
 * Next's client router cache can restore this page from an old payload —
 * back/forward after tapping a student or edit link — bringing back its old
 * `serverNow` on mount instead of a fresh one. Arming timers from that stale
 * render would fire every one of them late by however long the payload sat
 * cached, so mounting with a `serverNow` already seen refreshes immediately
 * instead; the resulting fresh render brings a new `serverNow` and arms
 * normally.
 */
export function RefreshAt({ instants, serverNow }: { instants: readonly string[]; serverNow: number }) {
  const router = useRouter();
  // A string key, so a new array with the same instants does not reset the timers.
  const key = instants.join('|');

  useEffect(() => {
    if (seenServerNows.has(serverNow)) {
      router.refresh();
      return;
    }
    seenServerNows.add(serverNow);
    if (seenServerNows.size > MAX_REMEMBERED_SERVER_NOWS) {
      const oldest = seenServerNows.values().next().value;
      if (oldest !== undefined) seenServerNows.delete(oldest);
    }

    const timers = key
      .split('|')
      .map((iso) => new Date(iso).getTime() - serverNow)
      .filter((delay) => delay > 0 && delay <= MAX_TIMEOUT_MS)
      .map((delay) => setTimeout(() => router.refresh(), delay));
    return () => timers.forEach(clearTimeout);
  }, [key, serverNow, router]);

  return null;
}
