import type { AllowedMollieMethod } from '@/lib/processor-methods';

export type CachedOffer = { kind: 'methods'; offered: AllowedMollieMethod[]; excluded: string[] };
export const METHODS_CACHE_MS = 60_000;

export const offerCache = new Map<string, { at: number; value: CachedOffer }>();

/** Drops every cached overlap for a connection; called whenever the connection changes. */
export function forgetOfferedMethods(connectionId: string): void {
  for (const key of offerCache.keys()) if (key.startsWith(`${connectionId}:`)) offerCache.delete(key);
}

/** Stores an offer, first dropping every entry already past its lifetime. */
export function putOffer(key: string, value: CachedOffer, now: number): void {
  for (const [k, e] of offerCache) if (now - e.at >= METHODS_CACHE_MS) offerCache.delete(k);
  offerCache.set(key, { at: now, value });
}
