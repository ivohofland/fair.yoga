/**
 * In-memory fixed-window rate limiter.
 *
 * Suitable for the single-process VPS deployment this project targets —
 * state does not survive restarts and is not shared across instances,
 * which is acceptable for abuse throttling (not billing).
 */

interface Window {
  timestamps: number[];
}

const buckets = new Map<string, Window>();

/** Bound the map so a scanner cycling keys cannot grow memory unbounded. */
const MAX_KEYS = 10_000;

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
  if (!bucket) {
    if (buckets.size >= MAX_KEYS) {
      // Drop the oldest-inserted bucket — coarse, but bounds memory.
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    bucket = { timestamps: [] };
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
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Shared hourly budget for teacher-initiated student writes that carry a
 * client-supplied email: `POST /api/students` and the teacher branch of
 * `PUT /api/students/[id]`. Both write `email` to a `@unique` column, so both
 * answer "is this address taken?" — the POST through 200-vs-201, the PUT
 * through 200-vs-409 on the P2002 fallback. Metering only one leaves the pair
 * unbounded, so they share a bucket.
 *
 * 50/hour fits a workshop roster plus corrections in one sitting.
 */
export function checkStudentWriteLimit(teacherId: string): RateLimitResult {
  return checkRateLimit(`students:${teacherId}`, 50, 60 * 60 * 1000);
}

/** Test helper: forget all recorded hits. */
export function resetRateLimits(): void {
  buckets.clear();
}

/** Best-effort client IP for rate-limit keying (nginx sets x-forwarded-for). */
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}
