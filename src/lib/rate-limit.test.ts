import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkRateLimit, resetRateLimits, clientIp, MAX_KEYS } from './rate-limit';
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

    // 'protected' is at the head of the map with a 1-hour window (expiresAt = t0 + HOUR)
    checkRateLimit('protected', 2, HOUR, t0);

    // 'dead' sits behind 'protected' with a short 1-second window (expiresAt = t0 + 1000)
    checkRateLimit('dead', 2, 1000, t0);

    // Fill the rest of the map to MAX_KEYS
    for (let i = 0; i < MAX_KEYS - 2; i++) {
      checkRateLimit(`fill:${i}`, 5, HOUR, t0);
    }

    // Advance time past 1 second (dead is now expired, protected is still active)
    const t1 = t0 + 5000;

    // Inserting 'trigger' causes a sweep. The bounded scan skips 'protected' (unexpired),
    // finds 'dead' (expired), and deletes 'dead'.
    // If the sweep were absent, plain FIFO/LRU would evict 'protected' at the head!
    checkRateLimit('trigger', 5, HOUR, t1);

    // 'protected' must survive: 2nd hit allowed, 3rd hit blocked
    expect(checkRateLimit('protected', 2, HOUR, t1 + 100).allowed).toBe(true);
    expect(checkRateLimit('protected', 2, HOUR, t1 + 200).allowed).toBe(false);
  });

  it('re-touching an older key preserves it over older untouched keys (LRU order)', () => {
    const t0 = 1_000_000;
    // k1 inserted first, k2 inserted second
    checkRateLimit('k1', 2, MINUTE, t0);
    checkRateLimit('k2', 2, MINUTE, t0);

    // Re-touch k1 so k1 moves to MRU and k2 becomes LRU
    checkRateLimit('k1', 2, MINUTE, t0 + 100);

    // Fill the rest of the map to MAX_KEYS
    for (let i = 0; i < MAX_KEYS - 2; i++) {
      checkRateLimit(`flood:${i}`, 5, MINUTE, t0 + 200);
    }

    // Insert 1 more key to force 1 eviction
    checkRateLimit('overflow:1', 5, MINUTE, t0 + 300);

    // k1 (MRU) was touched and survives, blocked on 3rd hit
    expect(checkRateLimit('k1', 2, MINUTE, t0 + 400).allowed).toBe(false);

    // k2 (LRU) was evicted, so a new check treats it as a fresh bucket
    expect(checkRateLimit('k2', 2, MINUTE, t0 + 400).allowed).toBe(true);
  });

  it('re-touching a blocked key moves it to MRU so it is not evicted before older keys', () => {
    const t0 = 1_000_000;
    // Exhaust limit on 'blocked-key' (limit 1)
    checkRateLimit('blocked-key', 1, MINUTE, t0);
    expect(checkRateLimit('blocked-key', 1, MINUTE, t0 + 10).allowed).toBe(false);

    // Insert 'untouched-key'
    checkRateLimit('untouched-key', 1, MINUTE, t0 + 20);

    // Hammer 'blocked-key' while blocked at t0 + 30 — must move it to MRU
    expect(checkRateLimit('blocked-key', 1, MINUTE, t0 + 30).allowed).toBe(false);

    // Fill map to capacity
    for (let i = 0; i < MAX_KEYS - 2; i++) {
      checkRateLimit(`fill:${i}`, 5, MINUTE, t0 + 40);
    }

    // Trigger 1 eviction
    checkRateLimit('overflow', 5, MINUTE, t0 + 50);

    // 'blocked-key' (MRU) was preserved, so it remains blocked within its window
    expect(checkRateLimit('blocked-key', 1, MINUTE, t0 + 60).allowed).toBe(false);

    // 'untouched-key' (LRU) was evicted, so it allows a fresh hit
    expect(checkRateLimit('untouched-key', 1, MINUTE, t0 + 60).allowed).toBe(true);
  });

  it('refreshes expiresAt on subsequent allowed hits so active rolling keys are not misclassified as dead', () => {
    const t0 = 1_000_000;
    // Initial hit on 'rolling-key' with 1-minute window (initial expiresAt = t0 + 60_000)
    checkRateLimit('rolling-key', 3, MINUTE, t0);

    // 2nd allowed hit on 'rolling-key' at t0 + 40_000 (refreshes expiresAt = t0 + 100_000)
    checkRateLimit('rolling-key', 3, MINUTE, t0 + 40_000);

    // 'dead-key' inserted AFTER rolling-key at t0 + 41_000 with 1-second window (expiresAt = t0 + 42_000)
    checkRateLimit('dead-key', 2, 1000, t0 + 41_000);

    // Fill map to MAX_KEYS with HOUR-length keys at t0 + 45_000
    // Map order is now: ['rolling-key', 'dead-key', 'other:0', ... 'other:9997']
    for (let i = 0; i < MAX_KEYS - 2; i++) {
      checkRateLimit(`other:${i}`, 5, HOUR, t0 + 45_000);
    }

    // At t0 + 70_000 (past initial t0 + 60_000, but within refreshed t0 + 100_000):
    // Trigger sweep with new insert.
    // The sweep inspects index 0 ('rolling-key'):
    // - With expiresAt refreshed (t0 + 100_000 > t0 + 70_000), it skips 'rolling-key'.
    // - Next it inspects index 1 ('dead-key', t0 + 42_000 <= t0 + 70_000), deleting 'dead-key'.
    // - Without expiresAt refreshed, 'rolling-key' (t0 + 60_000 <= t0 + 70_000) would be deleted as dead!
    checkRateLimit('trigger-sweep', 5, HOUR, t0 + 70_000);

    // 'rolling-key' retained its hit at t0 + 40s (t0 hit aged out of the 1-min sliding window).
    // Thus hits #2 and #3 within the window are allowed, and hit #4 is blocked.
    expect(checkRateLimit('rolling-key', 3, MINUTE, t0 + 70_100).allowed).toBe(true);
    expect(checkRateLimit('rolling-key', 3, MINUTE, t0 + 70_200).allowed).toBe(true);
    expect(checkRateLimit('rolling-key', 3, MINUTE, t0 + 70_300).allowed).toBe(false);
  });

  it('logs a throttled warning with key prefix when an unexpired bucket is evicted under memory pressure', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);

    const t0 = 1_000_000;
    // Fill the map to MAX_KEYS with unexpired keys (1-hour window)
    for (let i = 0; i < MAX_KEYS; i++) {
      checkRateLimit(`magic-link:email:user-${i}@example.com`, 5, HOUR, t0);
    }

    // 1st eviction: logs warning
    checkRateLimit('overflow-1', 5, HOUR, t0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPrefix: 'magic-link',
        capacity: MAX_KEYS,
        evictedCount: 1,
      }),
      'Rate limit bucket evicted under memory pressure',
    );

    // 2nd eviction within 60s: throttled (no additional log call)
    checkRateLimit('overflow-2', 5, HOUR, t0 + 1000);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 3rd eviction past 60s: logs warning with accumulated count
    checkRateLimit('overflow-3', 5, HOUR, t0 + 61_000);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        keyPrefix: 'magic-link',
        capacity: MAX_KEYS,
        evictedCount: 2,
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
