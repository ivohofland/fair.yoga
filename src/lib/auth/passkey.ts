import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/types';

// ---------------------------------------------------------------------------
// Challenge store — in-memory Map with 5-minute TTL
// ---------------------------------------------------------------------------

interface StoredChallenge {
  challenge: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const challengeStore = new Map<string, StoredChallenge>();

/** Exposed for testing only. */
export function _getChallengeStore(): Map<string, StoredChallenge> {
  return challengeStore;
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [key, entry] of challengeStore) {
    if (entry.expiresAt <= now) {
      challengeStore.delete(key);
    }
  }
}

/**
 * Store a WebAuthn challenge under a key (the accountId for registration,
 * a random challengeId for authentication) with a 5-minute TTL.
 * Cleans up any expired entries on each call.
 */
export function storeChallenge(key: string, challenge: string): void {
  cleanupExpired();
  challengeStore.set(key, {
    challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });
}

/**
 * Retrieve and delete a challenge by its key (one-time use).
 * Returns null if not found or expired.
 */
export function getAndDeleteChallenge(key: string): string | null {
  const entry = challengeStore.get(key);
  if (!entry) {
    return null;
  }
  challengeStore.delete(key);
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.challenge;
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getRpName(): string {
  return process.env.PASSKEY_RP_NAME ?? 'fair.yoga';
}

function getRpId(): string {
  return process.env.PASSKEY_RP_ID ?? 'localhost';
}

function getExpectedOrigin(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function generatePasskeyRegistrationOptions(params: {
  accountId: string;
  userName: string;
  userDisplayName: string;
  existingCredentialIds?: string[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { accountId, userName, userDisplayName, existingCredentialIds } = params;

  const options = await generateRegistrationOptions({
    rpName: getRpName(),
    rpID: getRpId(),
    userName,
    userDisplayName,
    userID: new TextEncoder().encode(accountId),
    excludeCredentials: (existingCredentialIds ?? []).map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  storeChallenge(accountId, options.challenge);

  return options;
}

export async function verifyPasskeyRegistration(params: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<{
  verified: boolean;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}> {
  const verification = await verifyRegistrationResponse({
    response: params.response,
    expectedChallenge: params.expectedChallenge,
    expectedOrigin: getExpectedOrigin(),
    expectedRPID: getRpId(),
  });

  const { verified, registrationInfo } = verification;

  if (!verified || !registrationInfo) {
    return {
      verified: false,
      credentialId: '',
      publicKey: new Uint8Array(),
      counter: 0,
      transports: [],
    };
  }

  const { credential } = registrationInfo;

  return {
    verified: true,
    credentialId: credential.id,
    publicKey: new Uint8Array(credential.publicKey),
    counter: credential.counter,
    transports: (credential.transports ?? []) as string[],
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function generatePasskeyAuthenticationOptions(
  allowedCredentialIds?: string[],
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    allowCredentials: allowedCredentialIds?.map((id) => ({ id })),
    userVerification: 'preferred',
  });

  return options;
}

export async function verifyPasskeyAuthentication(params: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credentialPublicKey: Uint8Array;
  credentialCounter: number;
}): Promise<{
  verified: boolean;
  newCounter: number;
}> {
  const verification = await verifyAuthenticationResponse({
    response: params.response,
    expectedChallenge: params.expectedChallenge,
    expectedOrigin: getExpectedOrigin(),
    expectedRPID: getRpId(),
    credential: {
      id: params.response.id,
      publicKey: new Uint8Array(params.credentialPublicKey),
      counter: params.credentialCounter,
    },
  });

  return {
    verified: verification.verified,
    newCounter: verification.authenticationInfo.newCounter,
  };
}
