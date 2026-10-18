import type { AllowedMollieMethod } from '@/lib/processor-methods';

export type CachedOffer = { kind: 'methods'; offered: AllowedMollieMethod[]; excluded: string[] };
export const offerCache = new Map<string, { at: number; value: CachedOffer }>();

/** Drops every cached overlap for a connection; called whenever the connection changes. */
export function forgetOfferedMethods(connectionId: string): void {
  for (const key of offerCache.keys()) if (key.startsWith(`${connectionId}:`)) offerCache.delete(key);
}
