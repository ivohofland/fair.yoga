/**
 * The device's zone, or nothing (#258, #825).
 *
 * Call it from an event handler, never from render. A `'use client'`
 * component still server-renders, and React 19 keeps that server value through
 * hydration — so a zone read during render is the SERVER's zone: not the
 * person's, not the device's. That is worse than whatever fallback a caller
 * applies when this returns nothing, because it looks like it worked.
 */
export function detectTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
