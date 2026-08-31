import { log } from '@/lib/log';

/**
 * In-memory sliding-log rate limiter.
 *
 * Suitable for the single-process VPS deployment this project targets —
 * state does not survive restarts and is not shared across instances,
 * which is acceptable for abuse throttling (not billing).
 */

interface Bucket {
  timestamps: number[];
  expiresAt: number;
}

const buckets = new Map<string, Bucket>();

/** Bound the map so a scanner cycling keys cannot grow memory unbounded. */
export const MAX_KEYS = 10_000;

/** Bounded scan limit to reclaim dead buckets without hot-path latency spikes. */
const MAX_SCAN = 50;

let lastEvictionLogTime = 0;
let suppressedEvictions = 0;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest counted hit leaves the window. */
  retryAfterSeconds: number;
}

/**
 * Records a hit for `key` and reports whether it stays within
 * `limit` hits per `windowMs`.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const cutoff = now - windowMs;

  let bucket = buckets.get(key);
  if (bucket) {
    // Re-insert to keep Map in LRU order (most recently accessed key moves to tail)
    buckets.delete(key);
    buckets.set(key, bucket);
  } else {
    if (buckets.size >= MAX_KEYS) {
      // Bounded scan from head for expired buckets to reclaim dead slots
      let scanned = 0;
      for (const [k, v] of buckets) {
        scanned++;
        if (v.expiresAt <= now) {
          buckets.delete(k);
        }
        if (buckets.size < MAX_KEYS || scanned >= MAX_SCAN) break;
      }

      // If still at capacity, evict the true LRU entry at the head of the Map
      if (buckets.size >= MAX_KEYS) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) {
          buckets.delete(oldestKey);
          const keyPrefix = oldestKey.split(':')[0]!;
          if (now - lastEvictionLogTime >= 60_000 || lastEvictionLogTime === 0) {
            log.warn(
              { keyPrefix, capacity: MAX_KEYS, evictedCount: suppressedEvictions + 1 },
              'Rate limit bucket evicted under memory pressure',
            );
            lastEvictionLogTime = now;
            suppressedEvictions = 0;
          } else {
            suppressedEvictions++;
          }
        }
      }
    }
    bucket = { timestamps: [], expiresAt: now + windowMs };
    buckets.set(key, bucket);
  }

  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0]!;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  bucket.timestamps.push(now);
  bucket.expiresAt = now + windowMs;
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Hourly budget for `POST /api/students`, keyed on the inviting teacher.
 * #166 closed the enumeration oracle this used to guard against by
 * construction — the route no longer branches on whether the address
 * already exists — so what remains is a spam brake: a teacher can still
 * cause an email to be sent to an arbitrary address, once per request.
 *
 * There used to be a second caller, the teacher branch of
 * `PUT /api/students/[id]`, which wrote a client-supplied `email` to the
 * same `@unique` column with no pre-check and so needed the same budget.
 * Task 10 of #166 deleted that branch outright rather than leaving it
 * metered, so this is a single-caller budget again.
 *
 * 50/hour fits a workshop roster plus corrections in one sitting.
 */
export function checkStudentWriteLimit(teacherId: string): RateLimitResult {
  return checkRateLimit(`students:${teacherId}`, 50, 60 * 60 * 1000);
}

/** Test helper: forget all recorded hits. */
export function resetRateLimits(): void {
  buckets.clear();
  lastEvictionLogTime = 0;
  suppressedEvictions = 0;
}

/**
 * Best-effort client IP for rate-limit keying.
 *
 * Reads the LAST entry in `x-forwarded-for` because deploy/nginx.conf.example
 * configures `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
 * which appends the real client IP ($remote_addr) to the end of any incoming
 * X-Forwarded-For header. Taking the first entry (`[0]`) would trust an untrusted
 * client's spoofed prefix and allow per-IP rate limit bypasses.
 */
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',');
    return parts[parts.length - 1]!.trim();
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}
