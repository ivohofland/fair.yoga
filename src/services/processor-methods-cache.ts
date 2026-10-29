import type { AllowedMollieMethod } from '@/lib/processor-methods';

/** A method Mollie lists that fair.yoga does not offer: its id, and Mollie's own name for it when given. */
export type ExcludedMethod = { id: string; description: string | null };

export type CachedOffer = { kind: 'methods'; offered: AllowedMollieMethod[]; excluded: ExcludedMethod[] };
export const METHODS_CACHE_MS = 60_000;

declare global {
  // A disconnect on one module copy must drop what another copy cached.
  var __fairYogaOfferCache: Map<string, { at: number; value: CachedOffer }> | undefined;
}

export const offerCache = (globalThis.__fairYogaOfferCache ??= new Map<string, { at: number; value: CachedOffer }>());

/** Drops every cached offer for a connection. */
export function forgetOfferedMethods(connectionId: string): void {
  for (const key of offerCache.keys()) if (key.startsWith(`${connectionId}:`)) offerCache.delete(key);
}

/** Stores an offer, first dropping every entry already past its lifetime. */
export function putOffer(key: string, value: CachedOffer, now: number): void {
  for (const [k, e] of offerCache) if (now - e.at >= METHODS_CACHE_MS) offerCache.delete(k);
  offerCache.set(key, { at: now, value });
}
