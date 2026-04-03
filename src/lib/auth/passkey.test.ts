import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeChallenge,
  getAndDeleteChallenge,
  generatePasskeyRegistrationOptions,
  generatePasskeyAuthenticationOptions,
  _getChallengeStore,
} from './passkey';

describe('passkey challenge store', () => {
  beforeEach(() => {
    // Clear the challenge store between tests
    const store = _getChallengeStore();
    store.clear();
  });

  it('storeChallenge + getAndDeleteChallenge: stores and retrieves a challenge, then deletes it', () => {
    storeChallenge('user-1', 'challenge-abc');

    const result = getAndDeleteChallenge('user-1');
    expect(result).toBe('challenge-abc');

    // Should be deleted after retrieval (one-time use)
    const secondResult = getAndDeleteChallenge('user-1');
    expect(secondResult).toBeNull();
  });

  it('getAndDeleteChallenge returns null for expired challenges', () => {
    // Manually insert an expired entry into the store
    const store = _getChallengeStore();
    store.set('user-expired', {
      challenge: 'old-challenge',
      expiresAt: Date.now() - 1000, // Expired 1 second ago
    });

    const result = getAndDeleteChallenge('user-expired');
    expect(result).toBeNull();
  });

  it('getAndDeleteChallenge returns null for unknown userId', () => {
    const result = getAndDeleteChallenge('nonexistent-user');
    expect(result).toBeNull();
  });

  it('storeChallenge cleans up expired entries on each call', () => {
    const store = _getChallengeStore();

    // Insert an expired entry manually
    store.set('user-old', {
      challenge: 'expired-challenge',
      expiresAt: Date.now() - 1000,
    });

    // Store a new challenge — should clean up the expired one
    storeChallenge('user-new', 'fresh-challenge');

    expect(store.has('user-old')).toBe(false);
    expect(store.has('user-new')).toBe(true);
  });
});

describe('generatePasskeyRegistrationOptions', () => {
  it('returns options with challenge, rp, and user fields', async () => {
    const options = await generatePasskeyRegistrationOptions({
      userId: 'test-user-id',
      userType: 'teacher',
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
      userId: 'store-test-user',
      userType: 'student',
      userName: 'student@example.com',
      userDisplayName: 'Student',
    });

    const storedChallenge = getAndDeleteChallenge('store-test-user');
    expect(storedChallenge).toBe(options.challenge);
  });

  it('passes excludeCredentials when existingCredentialIds provided', async () => {
    const options = await generatePasskeyRegistrationOptions({
      userId: 'exclude-test',
      userType: 'teacher',
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
  it('returns options with a challenge field when called with no credentials', async () => {
    const options = await generatePasskeyAuthenticationOptions();

    expect(options).toBeDefined();
    expect(typeof options.challenge).toBe('string');
    expect(options.challenge.length).toBeGreaterThan(0);
  });

  it('returns options with allowCredentials when credential IDs provided', async () => {
    const options = await generatePasskeyAuthenticationOptions(['cred-a', 'cred-b']);

    expect(options).toBeDefined();
    expect(options.allowCredentials).toBeDefined();
    expect(options.allowCredentials).toHaveLength(2);
    expect(options.allowCredentials?.[0]?.id).toBe('cred-a');
    expect(options.allowCredentials?.[1]?.id).toBe('cred-b');
  });
});
