import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkRateLimit,
  resetRateLimits,
  clientIp,
  DEFAULT_PREFIX_CAPACITY,
  PREFIX_CAPACITIES,
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

  it('flooding one prefix with 15,000 keys never evicts state in another prefix (cross-prefix isolation)', () => {
    const t0 = 1_000_000;
    // Record 2 hits on teacher in 'students' prefix with limit 3 (expires in 1 hour)
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0).allowed).toBe(true);
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0 + 1000).allowed).toBe(true);

    // Flood 'magic-link' prefix with 15,000 distinct keys (exceeding any global 10k capacity)
    for (let i = 0; i < 15_000; i++) {
      checkRateLimit(`magic-link:email:flood-${i}@test.local`, 5, HOUR, t0 + 2000);
    }

    // In a partitioned architecture, magic-link capped at its own 5,000 capacity.
    // 'students:teacher-target' in the 'students' partition must be completely untouched.
    // (If partitioned storage were mutated to a global map of 10,000, 15,000 keys would have evicted it!)
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0 + 3000).allowed).toBe(true);
    expect(checkRateLimit('students:teacher-target', 3, HOUR, t0 + 4000).allowed).toBe(false);
  });

  it('eviction warnings and log throttling are isolated per prefix', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);

    const t0 = 1_000_000;
    const magicCapacity = PREFIX_CAPACITIES['magic-link']!;
    const studentsCapacity = PREFIX_CAPACITIES['students']!;

    // Fill 'magic-link' partition to capacity and trigger 1 eviction
    for (let i = 0; i < magicCapacity; i++) {
      checkRateLimit(`magic-link:email:user-${i}@example.com`, 5, HOUR, t0);
    }
    checkRateLimit('magic-link:email:overflow', 5, HOUR, t0);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keyPrefix: 'magic-link',
        capacity: magicCapacity,
        evictedCount: 1,
      }),
      'Rate limit bucket evicted under memory pressure',
    );

    // Second eviction in 'magic-link' within 60s is throttled
    checkRateLimit('magic-link:email:overflow-2', 5, HOUR, t0 + 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Eviction in 'students' prefix happens at same timestamp: must NOT be throttled by magic-link!
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
});
