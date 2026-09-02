import { describe, it, expect, beforeEach } from 'vitest';
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

    // `authenticate/verify` passes a caller-supplied challengeId straight into
    // getAndDeleteChallenge. Before partitioning, passing a known accountId
    // consumed that account's in-flight registration challenge.
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
