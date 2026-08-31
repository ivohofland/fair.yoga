import { log } from '@/lib/log';

/**
 * In-memory sliding-log rate limiter.
 *
 * Suitable for the single-process VPS deployment this project targets —
 * state does not survive restarts and is not shared across instances,
 * which is acceptable for abuse throttling (not billing). Buckets are
 * partitioned by key prefix, each with its own bounded, LRU-evicted
 * capacity (`PREFIX_CAPACITIES`), so a flood on one prefix can never evict
 * or throttle-suppress another prefix's state.
 */

interface Bucket {
  timestamps: number[];
  /**
   * Storage-reclamation TTL, refreshed on every allowed hit — independent
   * of the caller's rate-limit window. Used only to identify buckets safe
   * to reclaim under capacity pressure (see the bounded scan below), never
   * to decide whether a hit is allowed.
   */
  expiresAt: number;
}

interface PrefixState {
  buckets: Map<string, Bucket>;
  lastEvictionLogTime: number;
  suppressedEvictions: number;
}

const prefixStates = new Map<string, PrefixState>();

export const DEFAULT_PREFIX_CAPACITY = 2_000;

export type RateLimitPrefix =
  | 'magic-link:ip'
  | 'magic-link:email'
  | 'student-signup:ip'
  | 'student-signup:email'
  | 'students'
  | 'teacher-signup';

export const PREFIX_CAPACITIES = {
  'magic-link:email': 5_000,
  'magic-link:ip': 2_000,
  'student-signup:email': 2_000,
  'student-signup:ip': 1_000,
  students: 2_000,
  'teacher-signup': 1_000,
} as const satisfies Record<RateLimitPrefix, number>;

// Longest-registered-prefix first, so e.g. 'student-signup:email' matches
// before the shorter 'student-signup:ip' sibling could.
const REGISTERED_PREFIXES = Object.keys(PREFIX_CAPACITIES).sort((a, b) => b.length - a.length);

/**
 * Builds a rate-limit key from a registered prefix, so a call site can't
 * drift from `PREFIX_CAPACITIES` by hand-typing a key string — a typo or a
 * new unregistered prefix is a compile error here instead of a silent
 * fallback to `DEFAULT_PREFIX_CAPACITY` at runtime.
 */
export function rateLimitKey(prefix: RateLimitPrefix, id: string): string {
  return `${prefix}:${id}`;
}

function partitionOf(key: string): string {
  for (const prefix of REGISTERED_PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}:`)) return prefix;
  }
  return key.includes(':') ? key.split(':')[0]! : 'default';
}

/** Bounded scan limit to reclaim dead buckets without hot-path latency spikes. */
const MAX_SCAN = 50;

/** Suppressed-eviction (and unresolved-IP) warnings are flushed at most this often. */
const WARNING_LOG_THROTTLE_MS = 60_000;

function getPrefixState(prefix: string): PrefixState {
  let state = prefixStates.get(prefix);
  if (!state) {
    state = {
      buckets: new Map<string, Bucket>(),
      lastEvictionLogTime: 0,
      suppressedEvictions: 0,
    };
    prefixStates.set(prefix, state);
  }
  return state;
}

/**
 * Emits the pending eviction count for a prefix, throttled to once per
 * `WARNING_LOG_THROTTLE_MS`. Called both right after an eviction and on
 * every subsequent call into the same prefix — the latter is what stops a
 * burst that tapers off inside the throttle window from being lost: without
 * it, nothing but a *further* eviction would ever flush a suppressed count,
 * and if pressure never resumes, an operator never learns it happened.
 */
function flushPendingEvictionLog(state: PrefixState, prefix: string, capacity: number, now: number): void {
  if (state.suppressedEvictions === 0) return;
  if (now - state.lastEvictionLogTime < WARNING_LOG_THROTTLE_MS) return;
  log.warn(
    { keyPrefix: prefix, capacity, evictedCount: state.suppressedEvictions },
    'Rate limit bucket evicted under memory pressure',
  );
  state.lastEvictionLogTime = now;
  state.suppressedEvictions = 0;
}

function recordEviction(state: PrefixState, prefix: string, capacity: number, now: number): void {
  state.suppressedEvictions++;
  flushPendingEvictionLog(state, prefix, capacity, now);
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest counted hit leaves the window. */
  retryAfterSeconds: number;
}

function recordHit(bucket: Bucket, now: number, windowMs: number): void {
  bucket.timestamps.push(now);
  bucket.expiresAt = now + windowMs;
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
  const prefix = partitionOf(key);
  const state = getPrefixState(prefix);
  const buckets = state.buckets;
  const capacity = (PREFIX_CAPACITIES as Record<string, number>)[prefix] ?? DEFAULT_PREFIX_CAPACITY;
  flushPendingEvictionLog(state, prefix, capacity, now);
  const cutoff = now - windowMs;

  let bucket = buckets.get(key);
  if (bucket) {
    // Re-insert to keep Map in LRU order (most recently accessed key moves to tail)
    buckets.delete(key);
    buckets.set(key, bucket);
  } else {
    if (buckets.size >= capacity) {
      // Bounded scan from head for expired buckets to reclaim dead slots
      let scanned = 0;
      for (const [k, v] of buckets) {
        scanned++;
        if (v.expiresAt <= now) {
          buckets.delete(k);
        }
        if (buckets.size < capacity || scanned >= MAX_SCAN) break;
      }

      // If still at capacity, evict the true LRU entry at the head of the Map
      if (buckets.size >= capacity) {
        const oldestKey = buckets.keys().next().value;
        if (oldestKey !== undefined) {
          buckets.delete(oldestKey);
          recordEviction(state, prefix, capacity, now);
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

  recordHit(bucket, now, windowMs);
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
  return checkRateLimit(rateLimitKey('students', teacherId), 50, 60 * 60 * 1000);
}

/** Fallback key segment for callers whose IP could not be resolved — never a valid IP literal, so it can't collide with a real address. */
export const UNRESOLVED_IP_ID = 'unresolved';

let lastUnresolvedIpLogTime = 0;

/**
 * Throttled (max once per 60s, across all routes) warning that `clientIp()`
 * could not resolve a real address for a rate-limited request. This is the
 * operator's only signal that the trusted-proxy assumption documented on
 * `clientIp` below has broken — see docs/technical-architecture.md's "Rate
 * limiting" section.
 */
function warnUnresolvedClientIp(route: string, now: number): void {
  if (now - lastUnresolvedIpLogTime < WARNING_LOG_THROTTLE_MS) return;
  lastUnresolvedIpLogTime = now;
  log.warn({ route }, 'Rate limit IP check skipped: client IP could not be resolved');
}

type IpRateLimitPrefix = Extract<RateLimitPrefix, 'magic-link:ip' | 'student-signup:ip' | 'teacher-signup'>;

/**
 * IP-keyed rate limit for an unauthenticated route. An unresolved IP is
 * never exempted from throttling — it shares one bucket (`UNRESOLVED_IP_ID`)
 * per prefix instead, so a broken trusted-proxy assumption degrades to a
 * single shared budget rather than removing the check entirely.
 */
export function checkIpRateLimit(
  prefix: IpRateLimitPrefix,
  ip: string,
  limit: number,
  windowMs: number,
  route: string,
  now: number = Date.now(),
): RateLimitResult {
  if (ip === 'unknown') {
    warnUnresolvedClientIp(route, now);
    return checkRateLimit(rateLimitKey(prefix, UNRESOLVED_IP_ID), limit, windowMs, now);
  }
  return checkRateLimit(rateLimitKey(prefix, ip), limit, windowMs, now);
}

/** Test helper: forget all recorded hits. */
export function resetRateLimits(): void {
  prefixStates.clear();
  lastUnresolvedIpLogTime = 0;
}

/**
 * Best-effort client IP for rate-limit keying — see
 * docs/technical-architecture.md's "Rate limiting" section for why this
 * trusts exactly the LAST entry of `x-forwarded-for`.
 */
export function clientIp(request: { headers: { get(name: string): string | null } }): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',');
    const last = parts[parts.length - 1]!.trim();
    if (last) return last;
  }
  return request.headers.get('x-real-ip') ?? 'unknown';
}
