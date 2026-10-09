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
  UserVerificationRequirement,
} from '@simplewebauthn/types';
import { log } from '@/lib/log';
import { adminOrigin } from '@/lib/admin-host';

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

/** The app origin, plus the admin origin when `ADMIN_HOST` is set (docs/technical-architecture.md, Admin surface). */
function getExpectedOrigin(): string | string[] {
  const app = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const admin = adminOrigin();
  return admin === null ? app : [app, admin];
}

// ---------------------------------------------------------------------------
// Verification refusals
// ---------------------------------------------------------------------------

/** Which ceremony a verification refusal belongs to, carried on its warn line. */
type PasskeyCeremony = 'registration' | 'authentication';

/**
 * Several of the library's thrown messages echo client-sent strings verbatim,
 * at unbounded length, so a caught reason is capped before it reaches the log.
 */
const REASON_MAX_LENGTH = 300;

const FRAME_MAX_LENGTH = 200;

/** Why a verification was refused, as the refusal's warn line carries it. */
interface RefusalCause {
  reason: string;
  /** A caught `Error`'s `name`, e.g. `TypeError` or `UnexpectedRPIDHash`. */
  errorName?: string;
  /** A caught `Error`'s first stack frame, trimmed: where it was thrown. */
  frame?: string;
}

/**
 * The first `at …` line of `error.stack` after the message. A V8 stack starts
 * with the error's name and message, and the message can echo client-sent
 * text containing a newline and an `at`, so the search starts past it; a
 * stack that does not contain the message yields no frame rather than a
 * guess.
 */
function firstStackFrame(error: Error): string | undefined {
  const stack = error.stack;
  if (stack === undefined) return undefined;
  const messageStart = stack.indexOf(error.message);
  if (messageStart === -1) return undefined;
  return stack
    .slice(messageStart + error.message.length)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('at '))
    ?.slice(0, FRAME_MAX_LENGTH);
}

function describeCaught(error: unknown): RefusalCause {
  if (!(error instanceof Error)) {
    return { reason: String(error).slice(0, REASON_MAX_LENGTH) };
  }
  return {
    reason: error.message.slice(0, REASON_MAX_LENGTH),
    errorName: error.name,
    frame: firstStackFrame(error),
  };
}

/**
 * Logs a verification refusal: one `warn` per refusal, never `error`,
 * whatever the cause — a hostile response and a misconfigured server both
 * arrive here. It names the credential id the caller sent and, for a caught
 * throw, the error's `name` and first stack frame. `reason` is written for
 * this log line; callers decide what the client sees.
 */
function warnRefused(ceremony: PasskeyCeremony, credentialId: string, cause: RefusalCause): void {
  log.warn({ ceremony, credentialId, ...cause }, 'passkey verification refused');
}

/**
 * Transport names this app will persist. `credential.transports` is the
 * caller's own `params.response.response.transports`: the library passes it
 * through unchecked, and no attestation format's signature covers it, so
 * despite its declared type it can hold any value the caller sent —
 * including values that are not `AuthenticatorTransportFuture` members at
 * all. `satisfies Record<AuthenticatorTransportFuture, true>` makes a new
 * member of that type a compile error here, rather than a filter silently
 * missing it.
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
// User verification
// ---------------------------------------------------------------------------

/**
 * What the ceremonies ask the authenticator for, and — through
 * `requireUserVerification` below — what the verifiers then demand. One
 * declaration so the request and the check cannot disagree. See
 * docs/technical-architecture.md ("Passkey user verification") for the
 * decision.
 */
const USER_VERIFICATION: UserVerificationRequirement = 'required';

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
      userVerification: USER_VERIFICATION,
    },
  });

  storeChallenge('registration', accountId, options.challenge);

  return options;
}

/**
 * Verifies a registration response, resolving to a refusal rather than
 * rejecting: `@simplewebauthn/server` signals almost every refused response
 * by throwing, and the `try` below encloses the library call so that a throw
 * becomes `{ verified: false, reason }`.
 *
 * A verified result is still client-derived past the `try`: a `fmt: 'none'`
 * attestation is signed by nothing, no attestation format's signature covers
 * `transports`, and the library neither checks that the credential id it
 * parses from the authenticator data equals `response.id` nor validates
 * `transports`. This function therefore refuses an id mismatch the same way
 * as a library throw — the id it returns is always the caller's
 * `response.id` — and keeps only known transport names, treating a
 * `transports` that is not an array as none.
 *
 * The catch does not branch on what was thrown: every refusal gets one
 * `warn`, never `error`, and the warn's `errorName` is what separates a
 * library-named error (`UnexpectedRPIDHash`) from a plain `Error`. A cause
 * other than a hostile response is refused the same way: a wrong
 * `NEXT_PUBLIC_APP_URL` fails every origin check with a plain `Error`, and
 * `reason` names the origin this function expected.
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
      requireUserVerification: USER_VERIFICATION === 'required',
    });
  } catch (error) {
    const cause = describeCaught(error);
    warnRefused('registration', params.response.id, cause);
    return { verified: false, reason: cause.reason };
  }

  const { verified, registrationInfo } = verification;

  if (!verified || !registrationInfo) {
    const reason = 'Attestation statement did not verify';
    warnRefused('registration', params.response.id, { reason });
    return { verified: false, reason };
  }

  const { credential } = registrationInfo;

  if (credential.id !== params.response.id) {
    // Lengths only: the authenticator data id is client-supplied and can run
    // to 65535 bytes.
    const reason = `Authenticator data credential id (${credential.id.length} chars) does not match response.id (${params.response.id.length} chars)`;
    warnRefused('registration', params.response.id, { reason });
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
    userVerification: USER_VERIFICATION,
  });
}

/**
 * Verifies an authentication response, resolving to a refusal rather than
 * rejecting: `@simplewebauthn/server` signals almost every refused response
 * by throwing, and the `try` below encloses the library call so that a throw
 * becomes `{ verified: false, reason }`. The one refusal the library resolves
 * rather than throws is a signature that does not verify against the stored
 * public key. What this returns past both is the library's own counter, read
 * from a response it verified against that key.
 *
 * The catch does not branch on what was thrown: every refusal gets one
 * `warn`, never `error`, and the warn's `errorName` is what separates a
 * library-named error (`UnexpectedRPIDHash`) from a plain `Error`. Causes
 * other than a hostile response are refused the same way:
 * - a wrong `NEXT_PUBLIC_APP_URL`: every origin check fails with a plain
 *   `Error`, and `reason` names the origin this function expected;
 * - a counter at or below a non-zero stored counter, the library's
 *   cloned-authenticator signal: a cloned credential, or a hostile
 *   response; its `reason` names both counters;
 * - a stored public key the library cannot use.
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
      requireUserVerification: USER_VERIFICATION === 'required',
      credential: {
        id: params.response.id,
        publicKey: new Uint8Array(params.credentialPublicKey),
        counter: params.credentialCounter,
      },
    });
  } catch (error) {
    const cause = describeCaught(error);
    warnRefused('authentication', params.response.id, cause);
    return { verified: false, reason: cause.reason };
  }

  if (!verification.verified) {
    const reason = 'Signature did not verify against the stored public key';
    warnRefused('authentication', params.response.id, { reason });
    return { verified: false, reason };
  }

  return {
    verified: true,
    newCounter: verification.authenticationInfo.newCounter,
  };
}
