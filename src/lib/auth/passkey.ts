import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticatorTransportFuture,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/types';
import { log } from '@/lib/log';

// ---------------------------------------------------------------------------
// Challenge store — one bounded, in-memory partition per purpose
// ---------------------------------------------------------------------------

interface StoredChallenge {
  challenge: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Which flow minted a challenge.
 *
 * They get separate maps for two reasons: a flood on the ungated side cannot
 * evict the gated side's entries, and a caller-supplied authentication key
 * cannot reach a registration challenge. See docs/technical-architecture.md
 * ("Passkey challenge store") for the cross-purpose reachability this closes
 * and for which flow is gated by what.
 */
export type ChallengePurpose = 'registration' | 'authentication';

/**
 * Per-partition ceilings. `satisfies` makes a new purpose a compile error here
 * rather than a partition that silently grows without one.
 *
 * See docs/technical-architecture.md ("Passkey challenge store") for the
 * per-entry memory arithmetic behind these capacities.
 */
export const CHALLENGE_CAPACITIES = {
  registration: 1_000,
  authentication: 10_000,
} as const satisfies Record<ChallengePurpose, number>;

const challengeStores: Record<ChallengePurpose, Map<string, StoredChallenge>> = {
  registration: new Map(),
  authentication: new Map(),
};

/** Eviction warnings are flushed at most this often, per partition. */
const EVICTION_LOG_THROTTLE_MS = 60_000;

const evictionLogState: Record<ChallengePurpose, { lastLogTime: number; suppressed: number }> = {
  registration: { lastLogTime: 0, suppressed: 0 },
  authentication: { lastLogTime: 0, suppressed: 0 },
};

/**
 * Emits a partition's pending eviction count, throttled. Called at the top
 * of `storeChallenge` (flushing any count carried over from a prior call),
 * once after that call's own eviction loop (summarizing the whole burst),
 * and periodically by the backstop timer below — so a partition that goes
 * quiet after a burst still flushes on its own, and a ceiling being reached
 * never passes silently.
 */
function flushPendingEvictionLog(purpose: ChallengePurpose, now: number): void {
  const state = evictionLogState[purpose];
  if (state.suppressed === 0) return;
  if (now - state.lastLogTime < EVICTION_LOG_THROTTLE_MS) return;
  log.warn(
    { purpose, capacity: CHALLENGE_CAPACITIES[purpose], evictedCount: state.suppressed },
    'Passkey challenge evicted under capacity pressure',
  );
  state.lastLogTime = now;
  state.suppressed = 0;
}

/**
 * Deletes every expired entry in a partition.
 *
 * Walking from the head and stopping at the first live entry is complete, not
 * a sample: the TTL is a constant and `expiresAt` is never refreshed on read,
 * so iteration order is non-decreasing in `expiresAt` (see `storeChallenge`),
 * and everything behind a live entry is therefore also live.
 */
function cleanupExpired(store: Map<string, StoredChallenge>, now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt > now) break;
    store.delete(key);
  }
}

/**
 * Store a WebAuthn challenge in `purpose`'s partition with a 5-minute TTL.
 * Cleans up expired entries, and evicts the oldest if the partition is full.
 */
export function storeChallenge(purpose: ChallengePurpose, key: string, challenge: string): void {
  const store = challengeStores[purpose];
  const now = Date.now();
  flushPendingEvictionLog(purpose, now);

  // Delete before the cleanup walk, not after. `Map.set` on a key already
  // present keeps its original position, so re-storing one would leave a
  // refreshed (live) expiry sitting at the head — the walk would stop there and
  // never reach the expired entries behind it. Removing it first restores the
  // invariant that iteration order is non-decreasing in `expiresAt`, which both
  // the walk above and the eviction below depend on.
  store.delete(key);
  cleanupExpired(store, now);

  while (store.size >= CHALLENGE_CAPACITIES[purpose]) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
    evictionLogState[purpose].suppressed++;
  }
  flushPendingEvictionLog(purpose, now);

  store.set(key, { challenge, expiresAt: now + CHALLENGE_TTL_MS });
}

/**
 * Retrieve and delete a challenge from `purpose`'s partition (one-time use).
 * Returns null if not found or expired.
 */
export function getAndDeleteChallenge(purpose: ChallengePurpose, key: string): string | null {
  const store = challengeStores[purpose];
  const entry = store.get(key);
  if (!entry) {
    return null;
  }
  store.delete(key);
  if (entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.challenge;
}

/** Exposed for testing only. */
export function _getChallengeStore(purpose: ChallengePurpose): Map<string, StoredChallenge> {
  return challengeStores[purpose];
}

/** Test helper: empty every partition and forget eviction bookkeeping. */
export function _resetChallengeStores(): void {
  for (const purpose of Object.keys(challengeStores) as ChallengePurpose[]) {
    challengeStores[purpose].clear();
    evictionLogState[purpose] = { lastLogTime: 0, suppressed: 0 };
  }
}

/**
 * Backstop for the throttled eviction log: flushes any partition whose
 * suppressed count would otherwise sit unflushed forever once that
 * partition goes quiet. `storeChallenge` only flushes on its own next call
 * into the same partition — a burst that stops cold has no such call.
 * Safe for this deployment: a single always-on Node process (see
 * docs/technical-architecture.md), not serverless/edge.
 */
setInterval(() => {
  const now = Date.now();
  for (const purpose of Object.keys(challengeStores) as ChallengePurpose[]) {
    flushPendingEvictionLog(purpose, now);
  }
}, EVICTION_LOG_THROTTLE_MS).unref();

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
// Verification refusals
// ---------------------------------------------------------------------------

/** Which ceremony a verification refusal belongs to, carried on its warn line. */
type PasskeyCeremony = 'registration' | 'authentication';

/**
 * Several of the library's thrown messages echo a client-sent string
 * (`clientDataJSON`'s own challenge or origin) of unbounded length, so a
 * caught reason is capped before it reaches the log.
 */
const REASON_MAX_LENGTH = 300;

function formatCaughtReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, REASON_MAX_LENGTH);
}

/**
 * The one `warn` a verification refusal emits, never `error`: a refused
 * response is a client fault, not something for an on-call alert to act on.
 * `reason` is written for this log line; callers decide what the client sees.
 */
function warnRefused(ceremony: PasskeyCeremony, reason: string): void {
  log.warn({ ceremony, reason }, 'passkey verification refused');
}

/**
 * Transport names this app will persist. `credential.transports` crosses an
 * attacker-controlled boundary despite its declared type: a `fmt: 'none'`
 * attestation verifies with no signature, so a signed-in caller can make the
 * library resolve with whatever `response.transports` they sent, including
 * values that are not `AuthenticatorTransportFuture` members at all.
 * `satisfies Record<AuthenticatorTransportFuture, true>` makes a new member
 * of that type a compile error here, rather than a filter silently missing
 * it.
 */
const KNOWN_TRANSPORTS = {
  ble: true,
  cable: true,
  hybrid: true,
  internal: true,
  nfc: true,
  'smart-card': true,
  usb: true,
} as const satisfies Record<AuthenticatorTransportFuture, true>;

function isKnownTransport(value: unknown): value is AuthenticatorTransportFuture {
  return typeof value === 'string' && Object.hasOwn(KNOWN_TRANSPORTS, value);
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

  storeChallenge('registration', accountId, options.challenge);

  return options;
}

/**
 * Verifies a registration response, resolving to a refusal rather than
 * rejecting. `@simplewebauthn/server` signals almost every refused response
 * by throwing a plain `Error`; left uncaught, `withErrorHandler` would answer
 * that as a 500 logged `unhandled API error`, so the `try` below encloses the
 * library call.
 *
 * A verified result is still client-derived past the `try`: a `fmt: 'none'`
 * attestation verifies with no signature, and the library neither checks
 * that the credential id it parses from the authenticator data equals
 * `response.id` nor validates `transports`. This function therefore refuses
 * an id mismatch the same way as a library throw — the id it returns is
 * always the caller's `response.id` — and keeps only known transport names,
 * treating a `transports` that is not an array as none.
 *
 * The library's `Error`s are untyped, so this catch cannot distinguish a
 * hostile response from a server-side cause — every one of the following is
 * refused the same way, one `warn`, never `error`:
 * - a wrong `NEXT_PUBLIC_APP_URL`: every origin check fails, and `reason`
 *   names the origin this function expected;
 * - the user-verification mismatch: `generatePasskeyRegistrationOptions`
 *   asks for `userVerification: 'preferred'`, but this function does not
 *   pass `requireUserVerification`, so the library's own default of `true`
 *   still demands it — refusing an authenticator that honours "preferred" by
 *   skipping UV. Such a refusal is identifiable by its `reason` naming user
 *   verification. Decision tracked as #732, not fixed here;
 * - a runtime without WebCrypto.
 */
export async function verifyPasskeyRegistration(params: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<
  | {
      verified: true;
      credentialId: string;
      publicKey: Uint8Array;
      counter: number;
      transports: AuthenticatorTransportFuture[];
    }
  | { verified: false; reason: string }
> {
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: params.expectedChallenge,
      expectedOrigin: getExpectedOrigin(),
      expectedRPID: getRpId(),
    });
  } catch (error) {
    const reason = formatCaughtReason(error);
    warnRefused('registration', reason);
    return { verified: false, reason };
  }

  const { verified, registrationInfo } = verification;

  if (!verified || !registrationInfo) {
    const reason = 'Registration response was not verified';
    warnRefused('registration', reason);
    return { verified: false, reason };
  }

  const { credential } = registrationInfo;

  if (credential.id !== params.response.id) {
    const reason = 'Authenticator data credential id does not match response.id';
    warnRefused('registration', reason);
    return { verified: false, reason };
  }

  return {
    verified: true,
    credentialId: credential.id,
    publicKey: new Uint8Array(credential.publicKey),
    counter: credential.counter,
    transports: Array.isArray(credential.transports)
      ? credential.transports.filter(isKnownTransport)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Mints an authentication challenge with no `allowCredentials` list.
 *
 * There is deliberately no credential-list parameter. #187: passing one made
 * the response vary with whether the posted address had an account, whether it
 * had a passkey, and how many — readable by any unauthenticated caller.
 * Restoring that is a signature change rather than an added argument, so a
 * reviewer has to see it.
 *
 * The cost is that the ceremony needs a discoverable credential, since the
 * authenticator gets no list to pre-select from. See
 * docs/technical-architecture.md ("Passkey authentication options") for the
 * decision record.
 */
export async function generatePasskeyAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: getRpId(),
    userVerification: 'preferred',
  });
}

/**
 * Verifies an authentication response, resolving to a refusal rather than
 * rejecting. `@simplewebauthn/server` signals almost every refused response
 * by throwing a plain `Error`; left uncaught, `withErrorHandler` would answer
 * that as a 500 logged `unhandled API error`, so the `try` below encloses the
 * library call. What it returns past the `try` is the library's own counter,
 * read from a response it verified against the stored public key.
 *
 * The library's `Error`s are untyped, so this catch cannot distinguish a
 * hostile response from a server-side cause — every one of the following is
 * refused the same way, one `warn`, never `error`:
 * - a wrong `NEXT_PUBLIC_APP_URL`: every origin check fails, and `reason`
 *   names the origin this function expected;
 * - the user-verification mismatch: `generatePasskeyAuthenticationOptions`
 *   asks for `userVerification: 'preferred'`, but this function does not
 *   pass `requireUserVerification`, so the library's own default of `true`
 *   still demands it — refusing an authenticator that honours "preferred" by
 *   skipping UV. Such a refusal is identifiable by its `reason` naming user
 *   verification. Decision tracked as #732, not fixed here;
 * - a counter regression — the library's cloned-authenticator signal;
 * - a corrupt stored public key, or a runtime without WebCrypto.
 */
export async function verifyPasskeyAuthentication(params: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credentialPublicKey: Uint8Array;
  credentialCounter: number;
}): Promise<{ verified: true; newCounter: number } | { verified: false; reason: string }> {
  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
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
  } catch (error) {
    const reason = formatCaughtReason(error);
    warnRefused('authentication', reason);
    return { verified: false, reason };
  }

  if (!verification.verified) {
    const reason = 'Authentication response was not verified';
    warnRefused('authentication', reason);
    return { verified: false, reason };
  }

  return {
    verified: true,
    newCounter: verification.authenticationInfo.newCounter,
  };
}
