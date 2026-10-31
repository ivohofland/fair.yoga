const TTL_MS = 60_000;
export const PUBLIC_SCHEDULE_CACHE_CAPACITY = 2_000;

type CacheEntry = { expiresAt: number; value: Promise<unknown> };

declare global {
  // Several route bundles import this module, so they must share one cache.
  var __fairYogaPublicScheduleCache: Map<string, CacheEntry> | undefined;
}

const cache = (globalThis.__fairYogaPublicScheduleCache ??= new Map<string, CacheEntry>());

/**
 * Returns the value cached under `cacheKey` while it is under a minute old,
 * otherwise loads and stores it. The promise is stored, so concurrent callers
 * share one load; a load that rejects is dropped so the next call retries.
 */
export function getCachedSchedule<T>(cacheKey: string, now: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt >= now) {
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return hit.value as Promise<T>;
  }
  cache.delete(cacheKey);
  while (cache.size >= PUBLIC_SCHEDULE_CACHE_CAPACITY) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  const value = load();
  const entry: CacheEntry = { expiresAt: now + TTL_MS, value };
  cache.set(cacheKey, entry);
  value.catch(() => {
    if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
  });
  return value;
}
