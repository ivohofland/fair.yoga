const WINDOW_MS = 3_600_000;
const MAX_DISTINCT_KEYS = 10;
const IP_CAPACITY = 5_000;

type Seen = Map<string, number>;

declare global {
  // Every route copy that checks a visitor must count against the same keys, or a scraper gets the limit once per copy.
  var __fairYogaDistinctKeyLimits: Map<string, Seen> | undefined;
}

const limits = (globalThis.__fairYogaDistinctKeyLimits ??= new Map<string, Seen>());

/**
 * Whether `ip` may look at `key`: at most ten different keys per hour. A key
 * the address already looked at in the window never counts again, and a refused
 * key is not recorded, so a scraper cannot spend the budget by being refused.
 */
export function checkDistinctKeyLimit(
  ip: string,
  key: string,
  now: number,
): { allowed: boolean; retryAfterSeconds: number } {
  let seen = limits.get(ip);
  if (seen) {
    limits.delete(ip);
  } else {
    while (limits.size >= IP_CAPACITY) {
      const oldest = limits.keys().next().value;
      if (oldest === undefined) break;
      limits.delete(oldest);
    }
    seen = new Map<string, number>();
  }
  limits.set(ip, seen);

  for (const [k, at] of seen) if (at + WINDOW_MS < now) seen.delete(k);

  if (seen.has(key)) return { allowed: true, retryAfterSeconds: 0 };
  if (seen.size >= MAX_DISTINCT_KEYS) {
    const oldest = Math.min(...seen.values());
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
  }
  seen.set(key, now);
  return { allowed: true, retryAfterSeconds: 0 };
}
