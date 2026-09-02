import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkRateLimit,
  checkIpRateLimit,
  resetRateLimits,
  clientIp,
  rateLimitKey,
  respondRateLimited,
  DEFAULT_PREFIX_CAPACITY,
  PREFIX_CAPACITIES,
  UNRESOLVED_IP_ID,
} from './rate-limit';
import { log } from '@/lib/log';

describe('checkRateLimit', () => {
  beforeEach(() => resetRateLimits());

  const MINUTE = 60_000;
  const HOUR = 60 * 60 * 1000;

  it('allows hits up to the limit', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('k', 3, MINUTE, t0 + i).allowed).toBe(true);
    }
  });

  it('blocks the hit past the limit and reports retry-after', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit('k', 3, MINUTE, t0 + i * 1000);
    const blocked = checkRateLimit('k', 3, MINUTE, t0 + 10_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('allows again after the window slides past the oldest hit', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit('k', 3, MINUTE, t0);
    expect(checkRateLimit('k', 3, MINUTE, t0 + MINUTE + 1).allowed).toBe(true);
  });

  it('keys are independent', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit('a', 3, MINUTE, t0);
    expect(checkRateLimit('a', 3, MINUTE, t0).allowed).toBe(false);
    expect(checkRateLimit('b', 3, MINUTE, t0).allowed).toBe(true);
  });

  it('a blocked hit does not extend the window (no lockout creep)', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit('k', 3, MINUTE, t0);
    // Hammering while blocked...
    for (let i = 1; i <= 30; i++) checkRateLimit('k', 3, MINUTE, t0 + i * 1000);
    // ...must not delay recovery past the original window.
    expect(checkRateLimit('k', 3, MINUTE, t0 + MINUTE + 1).allowed).toBe(true);
  });

  it('reclaims an expired dead bucket behind a live head during bounded scan', () => {
    const t0 = 1_000_000;

    // 'sweep:protected' is at the head of the partition with a 1-hour window (expiresAt = t0 + HOUR)
    checkRateLimit('sweep:protected', 2, HOUR, t0);

    // 'sweep:dead' sits behind 'sweep:protected' with a short 1-second window (expiresAt = t0 + 1000)
    checkRateLimit('sweep:dead', 2, 1000, t0);

    // Fill the rest of the partition to DEFAULT_PREFIX_CAPACITY
    for (let i = 0; i < DEFAULT_PREFIX_CAPACITY - 2; i++) {
      checkRateLimit(`sweep:fill:${i}`, 5, HOUR, t0);
    }

    // Advance time past 1 second (dead is now expired, protected is still active)
    const t1 = t0 + 5000;

    // Inserting 'sweep:trigger' causes a sweep in the 'sweep' partition.
    checkRateLimit('sweep:trigger', 5, HOUR, t1);

    // 'sweep:protected' must survive: 2nd hit allowed, 3rd hit blocked
    expect(checkRateLimit('sweep:protected', 2, HOUR, t1 + 100).allowed).toBe(true);
    expect(checkRateLimit('sweep:protected', 2, HOUR, t1 + 200).allowed).toBe(false);
  });

  it('bounds the reclaim scan to MAX_SCAN (50): a dead bucket beyond the 50th position is not reached, and the true LRU head is evicted instead', () => {
    const t0 = 1_000_000;

    // 50 live buckets at the head (oldest-first in Map insertion order), 1-hour window.
    // 'maxscan:head-victim' is the true head — the one the LRU fallback must evict.
    checkRateLimit('maxscan:head-victim', 1, HOUR, t0);
    for (let i = 1; i < 50; i++) {
      checkRateLimit(`maxscan:live:${i}`, 1, HOUR, t0);
    }

    // A dead bucket at position 51 — a 1-second window, expired by the time the scan runs.
    // If the scan reached it, this is what it "should" reclaim instead of the live head.
    checkRateLimit('maxscan:dead-beyond-scan', 2, 1000, t0);

    // Fill the rest of the partition to capacity.
    for (let i = 0; i < DEFAULT_PREFIX_CAPACITY - 51; i++) {
      checkRateLimit(`maxscan:fill:${i}`, 5, HOUR, t0 + 100);
    }

    // 'maxscan:dead-beyond-scan' has expired (1s window); the 50 head entries (1hr window) have not.
    const t1 = t0 + 5000;

    // Trigger a sweep + eviction: the scan examines only the first 50 entries (all live),
    // never reaches position 51, and gives up — so the fallback evicts the true LRU head.
    checkRateLimit('maxscan:trigger', 5, HOUR, t1);

    // The true head was evicted: its single pre-existing hit is gone, so a fresh hit is allowed.
    expect(checkRateLimit('maxscan:head-victim', 1, HOUR, t1 + 100).allowed).toBe(true);

    // Every one of the 49 live entries the scan walked over (but did not delete, since none
    // were expired) is untouched: each still carries its original hit, so a further hit is blocked.
    expect(checkRateLimit('maxscan:live:1', 1, HOUR, t1 + 100).allowed).toBe(false);
    expect(checkRateLimit('maxscan:live:49', 1, HOUR, t1 + 100).allowed).toBe(false);
  });

  it('re-touching an older key preserves it over older untouched keys (LRU order)', () => {
    const t0 = 1_000_000;
    // k1 inserted first, k2 inserted second in 'lru' partition
    checkRateLimit('lru:k1', 2, MINUTE, t0);
    checkRateLimit('lru:k2', 2, MINUTE, t0);

    // Re-touch k1 so k1 moves to MRU and k2 becomes LRU
    checkRateLimit('lru:k1', 2, MINUTE, t0 + 100);

    // Fill the rest of the partition to DEFAULT_PREFIX_CAPACITY
    for (let i = 0; i < DEFAULT_PREFIX_CAPACITY - 2; i++) {
      checkRateLimit(`lru:flood:${i}`, 5, MINUTE, t0 + 200);
    }

    // Insert 1 more key to force 1 eviction
    checkRateLimit('lru:overflow:1', 5, MINUTE, t0 + 300);

    // k1 (MRU) was touched and survives, blocked on 3rd hit
    expect(checkRateLimit('lru:k1', 2, MINUTE, t0 + 400).allowed).toBe(false);

    // k2 (LRU) was evicted, so a new check treats it as a fresh bucket
    expect(checkRateLimit('lru:k2', 2, MINUTE, t0 + 400).allowed).toBe(true);
  });

  it('re-touching a blocked key moves it to MRU so it is not evicted before older keys', () => {
    const t0 = 1_000_000;
    // Exhaust limit on 'block:blocked-key' (limit 1)
    checkRateLimit('block:blocked-key', 1, MINUTE, t0);
    expect(checkRateLimit('block:blocked-key', 1, MINUTE, t0 + 10).allowed).toBe(false);

    // Insert 'block:untouched-key'
    checkRateLimit('block:untouched-key', 1, MINUTE, t0 + 20);

    // Hammer 'block:blocked-key' while blocked at t0 + 30 — must move it to MRU
    expect(checkRateLimit('block:blocked-key', 1, MINUTE, t0 + 30).allowed).toBe(false);

    // Fill map to capacity in 'block' partition
    for (let i = 0; i < DEFAULT_PREFIX_CAPACITY - 2; i++) {
      checkRateLimit(`block:fill:${i}`, 5, MINUTE, t0 + 40);
    }

    // Trigger 1 eviction
    checkRateLimit('block:overflow', 5, MINUTE, t0 + 50);

    // 'block:blocked-key' (MRU) was preserved, so it remains blocked within its window
    expect(checkRateLimit('block:blocked-key', 1, MINUTE, t0 + 60).allowed).toBe(false);

    // 'block:untouched-key' (LRU) was evicted, so it allows a fresh hit
    expect(checkRateLimit('block:untouched-key', 1, MINUTE, t0 + 60).allowed).toBe(true);
  });

  it('refreshes expiresAt on subsequent allowed hits so active rolling keys are not misclassified as dead', () => {
    const t0 = 1_000_000;
    // Initial hit on 'roll:rolling-key' with 1-minute window (initial expiresAt = t0 + 60_000)
    checkRateLimit('roll:rolling-key', 3, MINUTE, t0);

    // 2nd allowed hit on 'roll:rolling-key' at t0 + 40_000 (refreshes expiresAt = t0 + 100_000)
    checkRateLimit('roll:rolling-key', 3, MINUTE, t0 + 40_000);

    // 'roll:dead-key' inserted AFTER rolling-key at t0 + 41_000 with 1-second window (expiresAt = t0 + 42_000)
    checkRateLimit('roll:dead-key', 2, 1000, t0 + 41_000);

    // Fill partition to DEFAULT_PREFIX_CAPACITY with HOUR-length keys at t0 + 45_000
    for (let i = 0; i < DEFAULT_PREFIX_CAPACITY - 2; i++) {
      checkRateLimit(`roll:other:${i}`, 5, HOUR, t0 + 45_000);
    }

    // At t0 + 70_000 (past initial t0 + 60_000, but within refreshed t0 + 100_000):
    // Trigger sweep with new insert in 'roll' partition.
    checkRateLimit('roll:trigger-sweep', 5, HOUR, t0 + 70_000);

    // 'roll:rolling-key' retained its hit at t0 + 40s (t0 hit aged out of the 1-min sliding window).
    // Thus hits #2 and #3 within the window are allowed, and hit #4 is blocked.
    expect(checkRateLimit('roll:rolling-key', 3, MINUTE, t0 + 70_100).allowed).toBe(true);
    expect(checkRateLimit('roll:rolling-key', 3, MINUTE, t0 + 70_200).allowed).toBe(true);
    expect(checkRateLimit('roll:rolling-key', 3, MINUTE, t0 + 70_300).allowed).toBe(false);
  });

  it('flooding the magic-link:email partition with 15,000 keys never evicts state in another prefix (cross-prefix isolation)', () => {
    const t0 = 1_000_000;
    // Record 2 hits on teacher in 'students' prefix with limit 3 (expires in 1 hour)
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0).allowed).toBe(true);
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0 + 1000).allowed).toBe(true);

    // Flood 'magic-link:email' with 15,000 distinct keys (exceeding any global 10k capacity)
    for (let i = 0; i < 15_000; i++) {
      checkRateLimit(`magic-link:email:flood-${i}@test.local`, 5, HOUR, t0 + 2000);
    }

    // In a partitioned architecture, magic-link's email partition is capped at its own
    // 5,000 capacity. 'students:teacher-target' in the 'students' partition must be
    // completely untouched. (If partitioned storage were mutated to a global map of
    // 10,000, 15,000 keys would have evicted it!)
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0 + 3000).allowed).toBe(true);
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0 + 4000).allowed).toBe(false);
  });

  it('magic-link:ip and magic-link:email are independent partitions despite sharing the "magic-link" prefix', () => {
    const t0 = 1_000_000;
    const ipCapacity = PREFIX_CAPACITIES['magic-link:ip'];

    expect(checkRateLimit('magic-link:email:victim@example.com', 3, HOUR, t0).allowed).toBe(true);
    expect(checkRateLimit('magic-link:email:victim@example.com', 3, HOUR, t0 + 1000).allowed).toBe(true);

    // Flood the magic-link:ip partition past its own (smaller) capacity.
    for (let i = 0; i < ipCapacity + 100; i++) {
      checkRateLimit(`magic-link:ip:flood-${i}`, 10, HOUR, t0 + 2000);
    }

    // The email-keyed bucket, in a different partition, is untouched by the ip-partition flood.
    expect(checkRateLimit('magic-link:email:victim@example.com', 3, HOUR, t0 + 3000).allowed).toBe(true);
    expect(checkRateLimit('magic-link:email:victim@example.com', 3, HOUR, t0 + 4000).allowed).toBe(false);
  });

  it('eviction warnings and log throttling are isolated per prefix', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);

    const t0 = 1_000_000;
    const magicEmailCapacity = PREFIX_CAPACITIES['magic-link:email'];
    const studentsCapacity = PREFIX_CAPACITIES['students'];

    // Fill 'magic-link:email' partition to capacity and trigger 1 eviction
    for (let i = 0; i < magicEmailCapacity; i++) {
      checkRateLimit(`magic-link:email:user-${i}@example.com`, 5, HOUR, t0);
    }
    checkRateLimit('magic-link:email:overflow', 5, HOUR, t0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keyPrefix: 'magic-link:email',
        capacity: magicEmailCapacity,
        evictedCount: 1,
      }),
      'Rate limit bucket evicted under memory pressure',
    );

    // Second eviction in 'magic-link:email' within 60s is throttled
    checkRateLimit('magic-link:email:overflow-2', 5, HOUR, t0 + 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Eviction in 'students' prefix happens at same timestamp: must NOT be throttled by magic-link:email!
    for (let i = 0; i < studentsCapacity; i++) {
      checkRateLimit(`students:teacher-${i}`, 5, HOUR, t0);
    }
    checkRateLimit('students:overflow-teacher', 5, HOUR, t0 + 1000);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keyPrefix: 'students',
        capacity: studentsCapacity,
        evictedCount: 1,
      }),
      'Rate limit bucket evicted under memory pressure',
    );

    warnSpy.mockRestore();
  });

  it('flushes a suppressed eviction count on the next call to the same prefix, even if that call does not itself evict', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const t0 = 1_000_000;
    const capacity = PREFIX_CAPACITIES['teacher-signup'];

    // Fill 'teacher-signup' to capacity.
    for (let i = 0; i < capacity; i++) {
      checkRateLimit(`teacher-signup:host-${i}`, 5, HOUR, t0);
    }
    // First eviction: logged immediately (nothing was pending before it).
    checkRateLimit('teacher-signup:overflow-1', 5, HOUR, t0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ evictedCount: 1 }), expect.any(String));

    // Two more evictions inside the 60s throttle window are suppressed, not logged.
    checkRateLimit('teacher-signup:overflow-2', 5, HOUR, t0 + 1000);
    checkRateLimit('teacher-signup:overflow-3', 5, HOUR, t0 + 2000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Attack pressure stops — no further eviction ever happens on this prefix. Time passes the
    // throttle window, and this next call only re-touches an EXISTING key (no eviction).
    checkRateLimit('teacher-signup:overflow-1', 5, HOUR, t0 + 61_000);

    // The 2 suppressed evictions from the cooldown are flushed here rather than lost forever.
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ evictedCount: 2 }),
      'Rate limit bucket evicted under memory pressure',
    );

    warnSpy.mockRestore();
  });
});

describe('rateLimitKey', () => {
  it('joins a registered prefix and an id with a colon', () => {
    expect(rateLimitKey('magic-link:ip', '203.0.113.1')).toBe('magic-link:ip:203.0.113.1');
    expect(rateLimitKey('students', 'teacher-42')).toBe('students:teacher-42');
  });
});

describe('respondRateLimited', () => {
  it('builds the message from the caller-supplied action, not a hardcoded one', async () => {
    const res = respondRateLimited({ allowed: false, retryAfterSeconds: 90 }, 'Too many signup attempts.');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Too many signup attempts. Try again in 2 minutes.');
  });

  it('pluralizes "minute" correctly at exactly one minute', async () => {
    const res = respondRateLimited({ allowed: false, retryAfterSeconds: 60 }, 'Too many address checks.');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Too many address checks. Try again in 1 minute.');
  });

  it('never falls back to the old hardcoded invitation copy for a non-invitation action', async () => {
    const res = respondRateLimited({ allowed: false, retryAfterSeconds: 30 }, 'Too many signup attempts.');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toMatch(/invitation/i);
  });
});

describe('checkIpRateLimit', () => {
  beforeEach(() => resetRateLimits());

  const MINUTE = 60_000;

  it('rate-limits a resolved IP under its own key', () => {
    const t0 = 1_000_000;
    expect(checkIpRateLimit('magic-link:ip', '203.0.113.1', 2, MINUTE, 'test', t0).allowed).toBe(true);
    expect(checkIpRateLimit('magic-link:ip', '203.0.113.1', 2, MINUTE, 'test', t0 + 10).allowed).toBe(true);
    expect(checkIpRateLimit('magic-link:ip', '203.0.113.1', 2, MINUTE, 'test', t0 + 20).allowed).toBe(false);
    // A different IP is unaffected.
    expect(checkIpRateLimit('magic-link:ip', '203.0.113.2', 2, MINUTE, 'test', t0 + 30).allowed).toBe(true);
  });

  it('shares one bucket across every caller whose IP could not be resolved, and warns (throttled)', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const t0 = 1_000_000;

    // Two different "unresolved" callers land in the same shared bucket rather than
    // bypassing the limit entirely.
    expect(checkIpRateLimit('teacher-signup', 'unknown', 2, MINUTE, 'teachers', t0).allowed).toBe(true);
    expect(checkIpRateLimit('teacher-signup', 'unknown', 2, MINUTE, 'teachers', t0 + 10).allowed).toBe(true);
    expect(checkIpRateLimit('teacher-signup', 'unknown', 2, MINUTE, 'teachers', t0 + 20).allowed).toBe(false);
    expect(checkRateLimit(rateLimitKey('teacher-signup', UNRESOLVED_IP_ID), 2, MINUTE, t0 + 20).allowed).toBe(
      false,
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenLastCalledWith(
      { route: 'teachers' },
      'Rate limit IP check degraded to a shared bucket: client IP could not be resolved',
    );

    // A second unresolved-IP call on a DIFFERENT route within 60s is throttled — this is a
    // global signal ("the trusted-proxy assumption broke"), not a per-route counter.
    checkIpRateLimit('magic-link:ip', 'unknown', 2, MINUTE, 'magic-link/send', t0 + 30);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // A resolved IP never triggers the warning.
    checkIpRateLimit('magic-link:ip', '203.0.113.5', 2, MINUTE, 'magic-link/send', t0 + 40);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe('clientIp', () => {
  it('extracts the last IP from x-forwarded-for to defeat client-spoofed prefixes', () => {
    const request = {
      headers: new Headers({
        'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.195',
      }),
    };
    expect(clientIp(request)).toBe('203.0.113.195');
  });

  it('handles single-entry x-forwarded-for', () => {
    const request = {
      headers: new Headers({
        'x-forwarded-for': '203.0.113.195',
      }),
    };
    expect(clientIp(request)).toBe('203.0.113.195');
  });

  it('falls back to x-real-ip when x-forwarded-for is missing', () => {
    const request = {
      headers: new Headers({
        'x-real-ip': '198.51.100.1',
      }),
    };
    expect(clientIp(request)).toBe('198.51.100.1');
  });

  it('returns unknown when neither header is set', () => {
    const request = {
      headers: new Headers(),
    };
    expect(clientIp(request)).toBe('unknown');
  });

  it('treats a trailing empty segment as unresolved rather than an empty-string IP', () => {
    const request = {
      headers: new Headers({
        'x-forwarded-for': '1.1.1.1, 2.2.2.2,',
      }),
    };
    expect(clientIp(request)).toBe('unknown');
  });
});
