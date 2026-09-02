import { describe, it, expect, beforeEach, vi } from 'vitest';
import { log } from '@/lib/log';
import {
  storeChallenge,
  getAndDeleteChallenge,
  generatePasskeyRegistrationOptions,
  generatePasskeyAuthenticationOptions,
  _getChallengeStore,
  _resetChallengeStores,
  CHALLENGE_CAPACITIES,
} from './passkey';

describe('passkey challenge store', () => {
  beforeEach(() => {
    _resetChallengeStores();
  });

  it('storeChallenge + getAndDeleteChallenge: stores and retrieves a challenge, then deletes it', () => {
    storeChallenge('registration', 'user-1', 'challenge-abc');

    expect(getAndDeleteChallenge('registration', 'user-1')).toBe('challenge-abc');
    // One-time use
    expect(getAndDeleteChallenge('registration', 'user-1')).toBeNull();
  });

  it('getAndDeleteChallenge returns null for expired challenges', () => {
    _getChallengeStore('registration').set('user-expired', {
      challenge: 'old-challenge',
      expiresAt: Date.now() - 1000,
    });

    expect(getAndDeleteChallenge('registration', 'user-expired')).toBeNull();
  });

  it('getAndDeleteChallenge returns null for an unknown key', () => {
    expect(getAndDeleteChallenge('registration', 'nonexistent-user')).toBeNull();
  });

  it('storeChallenge cleans up expired entries on each call', () => {
    const store = _getChallengeStore('registration');
    store.set('user-old', { challenge: 'expired-challenge', expiresAt: Date.now() - 1000 });

    storeChallenge('registration', 'user-new', 'fresh-challenge');

    expect(store.has('user-old')).toBe(false);
    expect(store.has('user-new')).toBe(true);
  });

  // --- partitioning ---

  it('a registration challenge is not reachable under the authentication purpose', () => {
    storeChallenge('registration', 'acct-1', 'reg-challenge');

    // Cross-purpose reachability: see docs/technical-architecture.md
    // ("Passkey challenge store"). Before partitioning, a key from one flow
    // could consume the other flow's in-flight challenge.
    expect(getAndDeleteChallenge('authentication', 'acct-1')).toBeNull();
    expect(getAndDeleteChallenge('registration', 'acct-1')).toBe('reg-challenge');
  });

  it('caps the authentication partition at its capacity', () => {
    const store = _getChallengeStore('authentication');

    for (let i = 0; i < CHALLENGE_CAPACITIES.authentication + 50; i++) {
      storeChallenge('authentication', `k-${i}`, `c-${i}`);
    }

    expect(store.size).toBe(CHALLENGE_CAPACITIES.authentication);
  });

  it('logs the true evicted count for a burst, not just the first eviction', () => {
    const store = _getChallengeStore('authentication');

    // Push the partition 50 entries past capacity directly (bypassing
    // storeChallenge's own one-eviction-per-call growth path), so the
    // single storeChallenge call below must walk off all 50 in one pass of
    // its own while loop. That's the scenario the old per-eviction flush
    // call inside the loop got wrong: every iteration shares one `now`, so
    // once the first eviction's flush opens the throttle window, every
    // later iteration in the same call is throttled and its count is lost.
    for (let i = 0; i < CHALLENGE_CAPACITIES.authentication + 49; i++) {
      store.set(`k-${i}`, { challenge: `c-${i}`, expiresAt: Date.now() + 60_000 });
    }

    const warnSpy = vi.spyOn(log, 'warn');

    storeChallenge('authentication', 'trigger', 'trigger-challenge');

    const totalEvicted = warnSpy.mock.calls.reduce(
      (sum, call) => sum + (call[0] as { evictedCount: number }).evictedCount,
      0,
    );

    expect(totalEvicted).toBe(50);
  });

  it('flushes a burst that goes idle, via the periodic backstop', async () => {
    // Not exported from passkey.ts — must match EVICTION_LOG_THROTTLE_MS
    // there (currently 60_000ms).
    const EVICTION_LOG_THROTTLE_MS = 60_000;

    vi.useFakeTimers();
    vi.resetModules();

    // A module instance separate from the one this file statically imports
    // at its top: its own `challengeStores`/`evictionLogState` closures, and
    // its own module-level `setInterval` call — captured by the fake clock
    // because it runs during this dynamic import, which happens after
    // `vi.useFakeTimers()`.
    const passkeyModule = await import('./passkey');
    // Resolves to the very instance passkeyModule's internal `log.warn`
    // calls use: passkeyModule's own `import { log } from '@/lib/log'`
    // already populated the (just-cleared) module cache for this specifier,
    // so this import hits that cache rather than creating another instance.
    const { log: freshLog } = await import('@/lib/log');
    const warnSpy = vi.spyOn(freshLog, 'warn');

    try {
      const store = passkeyModule._getChallengeStore('authentication');
      const capacity = passkeyModule.CHALLENGE_CAPACITIES.authentication;

      // Burst 1: pre-load 49 entries past capacity directly (mirrors "logs
      // the true evicted count for a burst" above), then one storeChallenge
      // call evicts 50 and flushes immediately — the per-call flush path,
      // not the backstop this test is about. Confirm it fired, then reset
      // the spy so what follows isolates the backstop.
      for (let i = 0; i < capacity + 49; i++) {
        store.set(`k-${i}`, { challenge: `c-${i}`, expiresAt: Date.now() + 60_000 });
      }
      passkeyModule.storeChallenge('authentication', 'trigger-1', 'trigger-challenge-1');

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ evictedCount: 50 });
      warnSpy.mockClear();

      // Burst 2: add 4 more entries directly, then one more storeChallenge
      // call evicts 5 (same arithmetic as burst 1: entries pushed past
      // capacity, plus one for reaching capacity again). No fake-clock time
      // passes between burst 1's flush and this call, so this call's own
      // after-loop flush lands inside the throttle window burst 1 just
      // opened and is suppressed rather than logged. No further
      // storeChallenge call follows to flush it on its own next call — the
      // idle-partition scenario the backstop exists for.
      for (let i = 0; i < 4; i++) {
        store.set(`k2-${i}`, { challenge: `c2-${i}`, expiresAt: Date.now() + 60_000 });
      }
      passkeyModule.storeChallenge('authentication', 'trigger-2', 'trigger-challenge-2');

      expect(warnSpy).not.toHaveBeenCalled();

      // Advance the fake clock past the throttle window with no further
      // storeChallenge call in between. The module-level setInterval
      // registered at import time fires and flushes burst 2's suppressed
      // count on its own.
      await vi.advanceTimersByTimeAsync(EVICTION_LOG_THROTTLE_MS);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({ evictedCount: 5 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an authentication flood does not evict a registration challenge', () => {
    storeChallenge('registration', 'acct-keep', 'reg-challenge');

    for (let i = 0; i < CHALLENGE_CAPACITIES.authentication + 50; i++) {
      storeChallenge('authentication', `k-${i}`, `c-${i}`);
    }

    expect(getAndDeleteChallenge('registration', 'acct-keep')).toBe('reg-challenge');
  });

  it('evicts the oldest authentication entry when full', () => {
    for (let i = 0; i < CHALLENGE_CAPACITIES.authentication; i++) {
      storeChallenge('authentication', `k-${i}`, `c-${i}`);
    }

    storeChallenge('authentication', 'newest', 'c-newest');

    expect(getAndDeleteChallenge('authentication', 'k-0')).toBeNull();
    expect(getAndDeleteChallenge('authentication', 'newest')).toBe('c-newest');
  });

  it('re-storing a key moves it to the tail, so cleanup still reaches entries behind it', () => {
    const store = _getChallengeStore('authentication');
    const now = Date.now();

    // Built with direct `set` so both positions and both expiry times are
    // explicit. `A` is live and sits at the head; `expired` sits behind it.
    // These direct insertions are in non-decreasing expiresAt order on purpose
    // — bypassing storeChallenge means the ordering invariant is the test's
    // responsibility to honour.
    store.set('A', { challenge: 'a-old', expiresAt: now + 1_000 });
    store.set('expired', { challenge: 'gone', expiresAt: now - 1_000 });

    // Re-storing `A` must remove it from the head before the cleanup walk.
    // Leaving it there gives the head a live expiry, the walk stops on it, and
    // `expired` is never reached.
    storeChallenge('authentication', 'A', 'a-new');

    expect(store.has('expired')).toBe(false);
    expect(getAndDeleteChallenge('authentication', 'A')).toBe('a-new');
  });
});

describe('generatePasskeyRegistrationOptions', () => {
  it('returns options with challenge, rp, and user fields', async () => {
    const options = await generatePasskeyRegistrationOptions({
      accountId: 'test-user-id',
      userName: 'jane@example.com',
      userDisplayName: 'Jane Doe',
    });

    expect(options).toBeDefined();
    expect(typeof options.challenge).toBe('string');
    expect(options.challenge.length).toBeGreaterThan(0);
    expect(options.rp).toBeDefined();
    expect(options.rp.name).toBe('fair.yoga');
    expect(options.rp.id).toBe('localhost');
    expect(options.user).toBeDefined();
    expect(options.user.name).toBe('jane@example.com');
    expect(options.user.displayName).toBe('Jane Doe');
  });

  it('stores the challenge for later retrieval', async () => {
    const options = await generatePasskeyRegistrationOptions({
      accountId: 'store-test-user',
      userName: 'student@example.com',
      userDisplayName: 'Student',
    });

    expect(getAndDeleteChallenge('registration', 'store-test-user')).toBe(options.challenge);
  });

  it('passes excludeCredentials when existingCredentialIds provided', async () => {
    const options = await generatePasskeyRegistrationOptions({
      accountId: 'exclude-test',
      userName: 'teacher@example.com',
      userDisplayName: 'Teacher',
      existingCredentialIds: ['cred-1', 'cred-2'],
    });

    expect(options.excludeCredentials).toBeDefined();
    expect(options.excludeCredentials).toHaveLength(2);
    expect(options.excludeCredentials?.[0]?.id).toBe('cred-1');
    expect(options.excludeCredentials?.[1]?.id).toBe('cred-2');
  });
});

describe('generatePasskeyAuthenticationOptions', () => {
  it('returns options with a challenge field', async () => {
    const options = await generatePasskeyAuthenticationOptions();

    expect(options).toBeDefined();
    expect(typeof options.challenge).toBe('string');
    expect(options.challenge.length).toBeGreaterThan(0);
  });

  it('never carries a credential list', async () => {
    const options = await generatePasskeyAuthenticationOptions();

    // The library builds the key unconditionally and leaves it undefined, which
    // JSON.stringify then drops — the integration test asserts the wire form.
    expect(options.allowCredentials).toBeUndefined();
  });
});
