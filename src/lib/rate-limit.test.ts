import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimits } from './rate-limit';

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
});
