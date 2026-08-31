import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimits, clientIp } from './rate-limit';

describe('checkRateLimit', () => {
  beforeEach(() => resetRateLimits());

  const MINUTE = 60_000;

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

  it('an established active key survives sibling map saturation past MAX_KEYS when re-touched', () => {
    const t0 = 1_000_000;
    // active-teacher is inserted first
    expect(checkRateLimit('active-teacher', 3, MINUTE, t0).allowed).toBe(true);

    // Insert 9,998 other keys (map size becomes 9,999)
    for (let i = 0; i < 9998; i++) {
      checkRateLimit(`other:${i}`, 5, MINUTE, t0 + 500);
    }

    // Re-touch active-teacher at t0 + 1000 so it moves to MRU (tail)
    expect(checkRateLimit('active-teacher', 3, MINUTE, t0 + 1000).allowed).toBe(true);

    // Insert keys past MAX_KEYS to trigger eviction
    checkRateLimit('filler-1', 5, MINUTE, t0 + 2000);
    checkRateLimit('filler-2', 5, MINUTE, t0 + 2000);

    // In old FIFO code, active-teacher was inserted first and would have been evicted.
    // In LRU code, active-teacher was touched and moved to MRU, so other:0/other:1 were evicted instead.
    // The 3rd hit on active-teacher within the same minute is allowed, and 4th hit is blocked.
    expect(checkRateLimit('active-teacher', 3, MINUTE, t0 + 3000).allowed).toBe(true);
    const blocked = checkRateLimit('active-teacher', 3, MINUTE, t0 + 4000);
    expect(blocked.allowed).toBe(false);
  });

  it('re-touching an older key preserves it over older untouched keys (LRU order)', () => {
    const t0 = 1_000_000;
    // k1 inserted first, k2 inserted second
    checkRateLimit('k1', 2, MINUTE, t0);
    checkRateLimit('k2', 2, MINUTE, t0);

    // Re-touch k1 so k1 moves to MRU and k2 becomes LRU
    checkRateLimit('k1', 2, MINUTE, t0 + 100);

    // Fill the rest of the map to MAX_KEYS (currently has 2 keys, add 9998 more)
    for (let i = 0; i < 9998; i++) {
      checkRateLimit(`flood:${i}`, 5, MINUTE, t0 + 200);
    }

    // Insert 1 more key to force 1 eviction
    checkRateLimit('overflow:1', 5, MINUTE, t0 + 300);

    // k1 (MRU) survives and is blocked on 3rd hit
    expect(checkRateLimit('k1', 2, MINUTE, t0 + 400).allowed).toBe(false);

    // k2 (LRU) was evicted, so a new check treats it as a fresh bucket
    expect(checkRateLimit('k2', 2, MINUTE, t0 + 400).allowed).toBe(true);
  });

  it('reclaims expired dead buckets before evicting unexpired buckets under capacity pressure', () => {
    const t0 = 1_000_000;
    // Insert 10 expired keys at t0
    for (let i = 0; i < 10; i++) {
      checkRateLimit(`expired:${i}`, 2, MINUTE, t0);
    }

    // Advance time past the 1-minute window
    const t1 = t0 + MINUTE + 5000;

    // Insert an active key at t1
    checkRateLimit('active-key', 2, MINUTE, t1);

    // Fill map with 9,989 unexpired keys (total map entries = 10 + 1 + 9989 = 10,000)
    for (let i = 0; i < 9989; i++) {
      checkRateLimit(`fill:${i}`, 5, MINUTE, t1);
    }

    // Insert one more key. The sweep should reclaim the 10 expired keys from the head
    // without evicting 'active-key'.
    checkRateLimit('trigger-sweep', 5, MINUTE, t1 + 100);

    // 'active-key' should still retain its previous hit (2nd hit allowed, 3rd blocked)
    expect(checkRateLimit('active-key', 2, MINUTE, t1 + 200).allowed).toBe(true);
    expect(checkRateLimit('active-key', 2, MINUTE, t1 + 300).allowed).toBe(false);
  });

  it('logs a warning with sanitized PII when an unexpired bucket is evicted under memory pressure', async () => {
    const { log } = await import('./log');
    const { vi } = await import('vitest');
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => log);

    const t0 = 1_000_000;
    // Insert a key containing an email address
    checkRateLimit('magic-link:email:sensitive-user@example.com', 3, MINUTE, t0);

    // Fill the map to MAX_KEYS with unexpired keys
    for (let i = 0; i < 9999; i++) {
      checkRateLimit(`active:${i}`, 5, MINUTE, t0);
    }

    // Force an eviction
    checkRateLimit('overflow-trigger', 5, MINUTE, t0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'magic-link:email:***',
        mapSize: expect.any(Number),
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
