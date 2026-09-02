# Passkey `authenticate/options` Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the account-enumeration oracle on `POST /api/auth/passkey/authenticate/options` and give the in-memory WebAuthn challenge store a per-purpose ceiling.

**Architecture:** The oracle closes by deleting the input rather than equalising the response — the route stops reading the request body, so no request-controlled value reaches the response and the timing channel goes with the response shape. The challenge store splits into one bounded map per `ChallengePurpose`, so an unauthenticated flood cannot evict a session-gated registration challenge and a caller-supplied key cannot reach one. An IP rate limit on the route bounds churn against that ceiling.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, `@simplewebauthn/server`, Vitest (projects: `unit`, `components`, `integration`), Prisma/PostgreSQL, pino.

**Spec:** `docs/superpowers/specs/2026-09-02-passkey-options-enumeration-design.md`

## Global Constraints

- **TypeScript strict.** No `any`, no implicit types.
- **Never write a count or a member list in a comment.** Counts and censuses go in `docs/`, with the command that re-derives them. Membership claims get a compiler tether (`satisfies Record<keyof T, true>`) or go in `docs/`.
- **Correct a claim by replacing it**, never by annotating it ("this previously read X"). Before-and-after belongs in the PR body.
- **Copy string, exact:** `Cancelled, or no passkey on this device. Try again, or use the email link.`
- **Existing hard-failure copy is unchanged:** `Passkey sign-in didn't work here — use the email link instead.`
- **Rate limit values:** `100` requests per `60 * 60 * 1000` ms, IP-keyed, prefix `'passkey-auth-options'`, bucket capacity `2_000`.
- **Challenge capacities:** `registration: 1_000`, `authentication: 10_000`. TTL stays `5 * 60 * 1000`.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **This is a worktree.** `integration` and `e2e` cannot run locally, and 33 DB-touching `unit` files fail on an empty `DATABASE_URL`. Local verification means `typecheck`, `lint`, `--project components`, and the named DB-free `unit` files. Do **not** copy the main checkout's `.env` in — it points at the shared dev database the user's dev server is using.
- **Every guard gets a mutation proof:** break it, record the exact failure text, restore, re-verify. A step in each task.

---

### Task 1: Partition and bound the challenge store

The store's two writers have different trust levels: registration is session-gated and keys by `accountId`; authentication is unauthenticated and keys by a random id. One map for both means an ungated flood evicts gated entries, and means `authenticate/verify`'s caller-supplied `challengeId` can reach a registration challenge.

**Files:**
- Modify: `src/lib/auth/passkey.ts:14-68` (the challenge-store section), `:111` (`storeChallenge` call in `generatePasskeyRegistrationOptions`)
- Modify: `src/app/api/auth/passkey/authenticate/options/route.ts:33`
- Modify: `src/app/api/auth/passkey/authenticate/verify/route.ts:18`
- Modify: `src/app/api/auth/passkey/register/verify/route.ts:22`
- Test: `src/lib/auth/passkey.test.ts`

**Interfaces:**
- Produces: `type ChallengePurpose = 'registration' | 'authentication'`; `CHALLENGE_CAPACITIES: Record<ChallengePurpose, number>` (exported); `storeChallenge(purpose: ChallengePurpose, key: string, challenge: string): void`; `getAndDeleteChallenge(purpose: ChallengePurpose, key: string): string | null`; `_getChallengeStore(purpose: ChallengePurpose): Map<string, StoredChallenge>`; `_resetChallengeStores(): void`
- Consumes: `log` from `@/lib/log` (safe — no `'use client'` file imports `@/lib/auth`, verified 2026-09-02)

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe('passkey challenge store', ...)` block in `src/lib/auth/passkey.test.ts` with the following, and update the import list at the top of the file to pull `ChallengePurpose` helpers:

```ts
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
```

Also update the two existing `generatePasskeyRegistrationOptions` assertions further down the same file that call `getAndDeleteChallenge` with one argument:

```ts
  it('stores the challenge for later retrieval', async () => {
    const options = await generatePasskeyRegistrationOptions({
      accountId: 'store-test-user',
      userName: 'student@example.com',
      userDisplayName: 'Student',
    });

    expect(getAndDeleteChallenge('registration', 'store-test-user')).toBe(options.challenge);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts`
Expected: FAIL — TypeScript/runtime errors that `_resetChallengeStores` and `CHALLENGE_CAPACITIES` are not exported, and that `storeChallenge` takes 2 arguments not 3.

- [ ] **Step 3: Replace the challenge-store section of `src/lib/auth/passkey.ts`**

Replace lines 14-68 (from the `// Challenge store` banner through the end of `getAndDeleteChallenge`) with:

```ts
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
 * Registration is session-gated and keys by `accountId`; authentication is
 * unauthenticated and keys by a server-generated random id. They get separate
 * maps for two reasons: a flood on the ungated side cannot evict the gated
 * side's entries, and a caller-supplied authentication key cannot reach a
 * registration challenge — `authenticate/verify` passes the client's
 * `challengeId` straight through to `getAndDeleteChallenge`.
 */
export type ChallengePurpose = 'registration' | 'authentication';

/**
 * Per-partition ceilings. `satisfies` makes a new purpose a compile error here
 * rather than a partition that silently grows without one.
 *
 * See docs/technical-architecture.md ("Passkey challenge store") for the
 * per-entry memory arithmetic behind these two numbers.
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
 * Emits a partition's pending eviction count, throttled. Called both right
 * after an eviction and on every subsequent store into the same partition —
 * the latter is what stops a burst that tapers off inside the throttle window
 * from being lost, so a ceiling being reached never passes silently.
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
  // the walk above and the eviction below depend on. Reachable today:
  // registration keys by `accountId`, so reopening the add-passkey screen
  // re-stores the same key.
  store.delete(key);
  cleanupExpired(store, now);

  while (store.size >= CHALLENGE_CAPACITIES[purpose]) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
    evictionLogState[purpose].suppressed++;
    flushPendingEvictionLog(purpose, now);
  }

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
```

Add the logger import to the top of the file, after the `@simplewebauthn/types` import block:

```ts
import { log } from '@/lib/log';
```

- [ ] **Step 4: Update the four production call sites**

`src/lib/auth/passkey.ts`, inside `generatePasskeyRegistrationOptions` (was line 111):

```ts
  storeChallenge('registration', accountId, options.challenge);
```

`src/app/api/auth/passkey/register/verify/route.ts` (was line 22):

```ts
  const challenge = getAndDeleteChallenge('registration', session.accountId);
```

`src/app/api/auth/passkey/authenticate/options/route.ts` (was line 33):

```ts
  storeChallenge('authentication', challengeId, options.challenge);
```

`src/app/api/auth/passkey/authenticate/verify/route.ts` (was line 18):

```ts
  const challenge = getAndDeleteChallenge('authentication', body.challengeId);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts`
Expected: PASS, all cases.

Then: `npm run typecheck`
Expected: clean — this is what catches any call site missed in Step 4.

- [ ] **Step 6: Mutation proof — the ceiling**

Temporarily change the eviction loop condition in `storeChallenge` to `while (false)`.

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts`
Expected: FAIL on `caps the authentication partition at its capacity` and `evicts the oldest authentication entry when full`.

Record the exact failure text in the commit body. Restore the line and re-run — expect PASS.

- [ ] **Step 7: Mutation proof — partition isolation**

Temporarily point both purposes at one map:

```ts
const sharedForMutationTest = new Map<string, StoredChallenge>();
const challengeStores: Record<ChallengePurpose, Map<string, StoredChallenge>> = {
  registration: sharedForMutationTest,
  authentication: sharedForMutationTest,
};
```

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts`
Expected: FAIL on `a registration challenge is not reachable under the authentication purpose` and on `an authentication flood does not evict a registration challenge`.

Record the exact failure text. Restore and re-run — expect PASS.

- [ ] **Step 8: Mutation proof — the ordering invariant**

Temporarily delete the `store.delete(key);` line that precedes `cleanupExpired(store, now);`.

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts`
Expected: FAIL on `re-storing a key moves it to the tail, so cleanup still reaches entries behind it`.

Record the exact failure text. Restore and re-run — expect PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/passkey.ts src/lib/auth/passkey.test.ts \
  src/app/api/auth/passkey/authenticate/options/route.ts \
  src/app/api/auth/passkey/authenticate/verify/route.ts \
  src/app/api/auth/passkey/register/verify/route.ts
git commit -m "fix(passkey): give the challenge store one bounded partition per purpose"
```

The commit body records the three mutation proofs' exact failure text, and notes that partitioning also stops a caller-supplied `challengeId` from consuming an in-flight registration challenge.

---

### Task 2: Close the enumeration oracle

**Files:**
- Modify: `src/app/api/auth/passkey/authenticate/options/route.ts` (whole file)
- Modify: `src/lib/auth/passkey.ts` — `generatePasskeyAuthenticationOptions`
- Modify: `src/lib/schemas.ts:143-145` — delete `passkeyAuthOptionsSchema`
- Modify: `src/components/booking/passkey-sign-in.tsx` — drop the `email` prop
- Modify: `src/app/(public)/login/page.tsx:75`, `src/components/booking/booking-sign-in.tsx:108`
- Modify: `src/lib/auth/passkey.test.ts` — the `generatePasskeyAuthenticationOptions` describe block
- Modify: `tests/integration/auth-email-case.test.ts` — remove the vacuous passkey arm
- Test: `tests/integration/passkey-api.test.ts` — new describe block

**Interfaces:**
- Consumes: `storeChallenge('authentication', …)` from Task 1
- Produces: `generatePasskeyAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>` — **no parameters**

- [ ] **Step 1: Write the failing tests**

In `src/lib/auth/passkey.test.ts`, replace the whole `describe('generatePasskeyAuthenticationOptions', …)` block:

```ts
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
```

In `tests/integration/passkey-api.test.ts`, replace the file's two import lines
(currently `import { describe, it, expect } from 'vitest';` and
`import { BASE_URL } from '../helpers';`) with:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();
```

Then add this describe block after the existing `authenticate/verify` one:

```ts
/**
 * #187. The route used to look up the posted address and return its credential
 * ids, so the response shape told an unauthenticated caller whether an address
 * had an account, whether it had a passkey, and how many. It now reads nothing
 * from the request body at all.
 */
describe('POST /api/auth/passkey/authenticate/options', () => {
  const suffix = uniqueSuffix();
  const withPasskey = `pk-has-${suffix}@test.local`;
  const withoutPasskey = `pk-none-${suffix}@test.local`;
  const noAccount = `pk-absent-${suffix}@test.local`;
  const credentialId = `cred-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '-');
  let accountIds: string[] = [];

  beforeAll(async () => {
    const withCred = await prisma.account.create({ data: { email: withPasskey } });
    const without = await prisma.account.create({ data: { email: withoutPasskey } });
    accountIds = [withCred.id, without.id];

    await prisma.passkeyCredential.create({
      data: {
        id: credentialId,
        accountId: withCred.id,
        publicKey: Buffer.from([1, 2, 3]),
        counter: BigInt(0),
        transports: ['internal'],
      },
    });
  });

  afterAll(async () => {
    await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  async function optionsFor(email?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/authenticate/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify(email ? { email } : {}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.data.options as Record<string, unknown>;
  }

  it('the with-passkey fixture really holds a credential', async () => {
    // Without this, the "has a passkey" arm below would pass vacuously against
    // an account that never had one — which is exactly why the #170 passkey
    // test it replaces was the weakest of its three.
    const count = await prisma.passkeyCredential.count({
      where: { accountId: accountIds[0] },
    });
    expect(count).toBe(1);
  });

  it('answers with the same key set for every address, and never sends allowCredentials', async () => {
    const hasPasskey = await optionsFor(withPasskey);
    const hasAccount = await optionsFor(withoutPasskey);
    const unknown = await optionsFor(noAccount);
    const omitted = await optionsFor();

    for (const options of [hasPasskey, hasAccount, unknown, omitted]) {
      expect('allowCredentials' in options).toBe(false);
    }

    // Not byte-identical — challenge and challengeId are random per request —
    // so the assertable property is the key set.
    const keys = Object.keys(hasPasskey).sort();
    expect(Object.keys(hasAccount).sort()).toEqual(keys);
    expect(Object.keys(unknown).sort()).toEqual(keys);
    expect(Object.keys(omitted).sort()).toEqual(keys);
  });
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts`
Expected: FAIL on `never carries a credential list` — currently `allowCredentials` is `undefined` only because nothing was passed, so this may PASS by accident. If it passes, that is expected at this point; the guard that matters is Step 7's mutation, which cannot pass once the parameter is gone.

The integration test cannot run in this worktree. Note it and continue.

- [ ] **Step 3: Delete the parameter from `generatePasskeyAuthenticationOptions`**

In `src/lib/auth/passkey.ts`:

```ts
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
```

- [ ] **Step 4: Rewrite the options route**

Replace `src/app/api/auth/passkey/authenticate/options/route.ts` entirely:

```ts
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { generatePasskeyAuthenticationOptions, storeChallenge } from '@/lib/auth';
import { respondOk, withErrorHandler } from '@/lib/api-utils';

/**
 * Mints a WebAuthn authentication challenge.
 *
 * Reads nothing from the request — not even an email. #187: this route used to
 * look the posted address up and return its credential ids in
 * `allowCredentials`, which told an unauthenticated caller whether the address
 * had an account, whether it had a passkey, how many, and what their ids were.
 * Equalising the response shape alone would not have been enough: the lookup
 * itself is a timing signal, one query for an unknown address against two for a
 * known one. Removing the input removes both, and leaves an invariant that can
 * be checked by reading the signature — no request-controlled value reaches the
 * response.
 *
 * The cost is that the ceremony now needs a discoverable credential. See
 * docs/technical-architecture.md ("Passkey authentication options").
 */
export const POST = withErrorHandler(async (_request: NextRequest) => {
  const options = await generatePasskeyAuthenticationOptions();

  // Random key so the verify endpoint can retrieve it; the challenge id is the
  // only handle the client gets.
  const challengeId = crypto.randomBytes(16).toString('hex');
  storeChallenge('authentication', challengeId, options.challenge);

  return respondOk({ options, challengeId });
});
```

- [ ] **Step 5: Delete the schema and update the client**

Delete `passkeyAuthOptionsSchema` from `src/lib/schemas.ts` (was lines 143-145). Leave `passkeyAuthVerifySchema` untouched.

In `src/components/booking/passkey-sign-in.tsx`, remove the `email` prop from the interface and the fetch body:

```tsx
interface PasskeySignInProps {
  /** Where to land after sign-in (relative path) — defaults to the role home. */
  redirect?: string;
}

export function PasskeySignIn({ redirect }: PasskeySignInProps) {
```

and in `handleSignIn`:

```tsx
      const optionsRes = await fetch('/api/auth/passkey/authenticate/options', {
        method: 'POST',
      });
```

In `src/app/(public)/login/page.tsx:75`:

```tsx
            <PasskeySignIn />
```

In `src/components/booking/booking-sign-in.tsx:108`:

```tsx
          <PasskeySignIn redirect={redirect} />
```

Leave the `email` state in both pages — the magic-link form still uses it.

- [ ] **Step 6: Remove the now-vacuous #170 passkey arm**

Delete the `it('finds a passkey account when the address is typed in mixed case', …)` case from `tests/integration/auth-email-case.test.ts`, along with the `teacherEmail` fixture setup **only if** nothing else in the file uses it — check before removing. The property it covered is case-insensitive email lookup, which this route no longer performs; #170 keeps its `magic-link/send` and `student-signup` arms, where the property is load-bearing.

- [ ] **Step 7: Verify, then mutation-proof the oracle**

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts && npm run typecheck && npm run lint`
Expected: PASS and clean. Typecheck is what proves no caller still passes an argument or imports the deleted schema.

Mutation: temporarily restore the parameter and the lookup in the route (the pre-change version of both files), and add `allowCredentials: ['AAAA']` to the returned options.

Run: `npx vitest run --project unit src/lib/auth/passkey.test.ts`
Expected: FAIL on `never carries a credential list`.

Record the exact failure text. Restore and re-run — expect PASS.

The integration mutation cannot be scored locally; note in the commit body that the integration arm is proven by CI.

- [ ] **Step 8: Sweep for what was invalidated**

Run and give every hit a verdict — expect legitimate survivors:

```bash
grep -rn "passkeyAuthOptionsSchema" src tests docs
grep -rn "allowCredentials" src tests docs
grep -rn "PasskeySignIn" src
```

Any surviving reference to `passkeyAuthOptionsSchema` is a defect. References to `allowCredentials` should remain only in the two docblocks and the tests that assert its absence.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/auth/passkey/authenticate/options/route.ts src/lib/auth/passkey.ts \
  src/lib/auth/passkey.test.ts src/lib/schemas.ts \
  src/components/booking/passkey-sign-in.tsx src/components/booking/booking-sign-in.tsx \
  "src/app/(public)/login/page.tsx" \
  tests/integration/auth-email-case.test.ts tests/integration/passkey-api.test.ts
git commit -m "fix(passkey): close the authenticate/options enumeration oracle by deleting its input"
```

Note the quoted path — `(public)` must be quoted or the shell matches nothing silently.

---

### Task 3: IP rate limit on `authenticate/options`

Bounding the store fixes the memory leak; without a limiter an attacker can still churn the authentication partition and evict other users' in-flight challenges.

**Files:**
- Modify: `src/lib/rate-limit.ts:37-56` (`RateLimitPrefix`, `PREFIX_CAPACITIES`), `:253` (`IpRateLimitPrefix`)
- Modify: `src/app/api/auth/passkey/authenticate/options/route.ts`
- Modify: `docs/technical-architecture.md` — the "Rate limiting" section and the rate-limited-routes paragraph
- Test: `tests/integration/passkey-api.test.ts`

**Interfaces:**
- Consumes: `checkIpRateLimit`, `clientIp`, `respondRateLimited` from `@/lib/rate-limit`
- Produces: prefix literal `'passkey-auth-options'`

- [ ] **Step 1: Write the failing test**

Add to the `POST /api/auth/passkey/authenticate/options` describe block in `tests/integration/passkey-api.test.ts`:

```ts
  /**
   * One address for all 101 requests, deliberately — that is the bucket under
   * test. The route has no second budget, so nothing else can produce the 429.
   */
  it('refuses the 101st request from one address within the hour', async () => {
    const ip = freshIp();
    const statuses: number[] = [];

    for (let i = 0; i < 101; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/passkey/authenticate/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ip },
        body: JSON.stringify({}),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 100)).toEqual(Array(100).fill(200));
    expect(statuses[100]).toBe(429);
  });
```

- [ ] **Step 2: Note that it cannot run locally**

The `integration` project needs the dev server on `:3000` and the shared dev database, neither of which exists in this worktree. Do not run it; CI scores this one.

- [ ] **Step 3: Register the prefix**

In `src/lib/rate-limit.ts`, add the literal to all three places:

```ts
export type RateLimitPrefix =
  | 'magic-link:ip'
  | 'magic-link:email'
  | 'passkey-auth-options'
  | 'student-signup:ip'
  | 'student-signup:email'
  | 'students'
  | 'teacher-signup'
  | 'teacher-signup:email'
  | 'slug-available';

export const PREFIX_CAPACITIES = {
  'magic-link:email': 5_000,
  'magic-link:ip': 2_000,
  'passkey-auth-options': 2_000,
  'student-signup:email': 2_000,
  'student-signup:ip': 1_000,
  students: 2_000,
  'teacher-signup': 1_000,
  'teacher-signup:email': 2_000,
  'slug-available': 1_000,
} as const satisfies Record<RateLimitPrefix, number>;
```

and extend the IP-keyed union:

```ts
export type IpRateLimitPrefix = Extract<RateLimitPrefix, 'magic-link:ip' | 'passkey-auth-options' | 'student-signup:ip' | 'teacher-signup' | 'slug-available'>;
```

- [ ] **Step 4: Apply the limit in the route**

Add to `src/app/api/auth/passkey/authenticate/options/route.ts`, keeping the docblock from Task 2 and extending its first line to mention the limit:

```ts
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';

const WINDOW_MS = 60 * 60 * 1000;
const PER_IP_LIMIT = 100;
```

and as the first statements of the handler, changing `_request` back to `request`:

```ts
export const POST = withErrorHandler(async (request: NextRequest) => {
  // The IP is the only thing read from the request, and it never reaches the
  // response. With the oracle closed there is nothing left to enumerate, so
  // this budget exists to bound challenge-store churn: without it a flood can
  // still evict other callers' in-flight challenges.
  const ip = clientIp(request);
  const check = checkIpRateLimit(
    'passkey-auth-options',
    ip,
    PER_IP_LIMIT,
    WINDOW_MS,
    'passkey/authenticate/options',
  );
  if (!check.allowed) return respondRateLimited(check, 'Too many sign-in attempts.');

  const options = await generatePasskeyAuthenticationOptions();
```

- [ ] **Step 5: Update the two documentation passages**

In `docs/technical-architecture.md`, append this sentence to the rate-limited-routes paragraph (around line 32):

> `POST /api/auth/passkey/authenticate/options` is IP-keyed too (100/hour), covered in `passkey-api.test.ts`. With #187 that route reads nothing from the request body, so there is no address to enumerate and no per-email bucket to pair with the IP one; the budget is there to bound challenge-store churn, since a flood can otherwise evict other callers' in-flight challenges before they are redeemed.

The "Rate limiting" section (around line 459) needs no structural change — read its partitioning claim and confirm it still reads correctly with a ninth prefix registered, then leave it alone.

Write only what is true now. Do not add "this previously listed N routes" — the before-and-after goes in the PR body.

- [ ] **Step 6: Verify what can be verified locally**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit src/lib/rate-limit.test.ts`
Expected: clean and PASS. The `satisfies` tether is what makes a missing `PREFIX_CAPACITIES` entry a typecheck failure rather than a silent fallback to `DEFAULT_PREFIX_CAPACITY`.

- [ ] **Step 7: Mutation proof — the tether**

Temporarily delete the `'passkey-auth-options': 2_000,` line from `PREFIX_CAPACITIES`.

Run: `npm run typecheck`
Expected: FAIL — the `satisfies Record<RateLimitPrefix, number>` no longer holds.

Record the exact error text. Restore and re-run — expect clean.

The route-level 429 mutation (removing the `checkIpRateLimit` call) cannot be scored locally; note in the commit body that CI scores it.

- [ ] **Step 8: Commit**

```bash
git add src/lib/rate-limit.ts src/app/api/auth/passkey/authenticate/options/route.ts \
  tests/integration/passkey-api.test.ts docs/technical-architecture.md
git commit -m "fix(passkey): bound authenticate/options with a per-IP hourly budget"
```

---

### Task 4: Tell the visitor when the ceremony did not complete

`passkey-sign-in.tsx` currently resets to `idle` silently on `NotAllowedError`. The browser returns that same error for a deliberate cancel and for no-credential-matched, so the message must name both without claiming either.

**Files:**
- Modify: `src/components/booking/passkey-sign-in.tsx`
- Test: `src/components/booking/passkey-sign-in.test.tsx:85-102` (an existing test changes meaning)

**Interfaces:**
- Consumes: nothing from earlier tasks. Independent — may be built in parallel with Tasks 1-3.

- [ ] **Step 1: Update the existing test and add the new one**

In `src/components/booking/passkey-sign-in.test.tsx`, replace the final test (`returns silently to idle when the user dismisses the OS prompt`, lines 85-102) with:

```ts
  /**
   * The browser reports a deliberate cancel and a no-credential-matched
   * ceremony as the same `NotAllowedError`, so this one message has to serve
   * both readers.
   */
  it('names both causes when the ceremony does not complete', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const dismissed = new Error('dismissed');
    dismissed.name = 'NotAllowedError';
    startAuthentication.mockRejectedValue(dismissed);
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Cancelled, or no passkey on this device. Try again, or use the email link.',
    );
    // Not the hard-failure copy, and not an alert — a cancel is not an error.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('re-enables the button after an incomplete ceremony', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const dismissed = new Error('dismissed');
    dismissed.name = 'NotAllowedError';
    startAuthentication.mockRejectedValue(dismissed);
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in with a passkey/i })).toBeEnabled(),
    );
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project components src/components/booking/passkey-sign-in.test.tsx`
Expected: FAIL on `names both causes when the ceremony does not complete` — no element with role `status` is found, because the current code renders nothing.

- [ ] **Step 3: Add the state and the message**

In `src/components/booking/passkey-sign-in.tsx`, widen the state union:

```tsx
  const [state, setState] = useState<'idle' | 'working' | 'incomplete' | 'error'>('idle');
```

Replace the catch block, keeping the existing `#40` comment above `setState('idle')` on the success path untouched:

```tsx
    } catch (err) {
      // The browser reports a deliberate cancel and a ceremony that matched no
      // credential as the same `NotAllowedError`, and does not say which —
      // WebAuthn conflates them so the client cannot become an enumeration
      // oracle. Do not try to tell them apart by probing the device for
      // credentials: that reopens on the client the disclosure #187 closed on
      // the server. Naming both possibilities lets each reader take the step
      // that works — a retry for one, the email link for the other.
      if (err instanceof Error && err.name === 'NotAllowedError') {
        setState('incomplete');
        return;
      }
      setState('error');
    }
```

Add the message alongside the existing error paragraph:

```tsx
      {state === 'incomplete' && (
        <p role="status" className="type-caption">
          Cancelled, or no passkey on this device. Try again, or use the email link.
        </p>
      )}
      {state === 'error' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger">
          Passkey sign-in didn&apos;t work here — use the email link instead.
        </p>
      )}
```

`role="status"` is polite and does not interrupt a screen reader mid-sentence, which `role="alert"` would; a cancel is not an error. `type-caption` is one of the six permitted type styles and is not `text-danger`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project components src/components/booking/passkey-sign-in.test.tsx`
Expected: PASS, all cases including the three pre-existing ones.

Then the whole tier, to prove nothing else asserted on the old silence:
Run: `npx vitest run --project components`
Expected: 52 files pass (the baseline from the spec).

- [ ] **Step 5: Mutation proof**

Temporarily change `setState('incomplete')` back to `setState('idle')`.

Run: `npx vitest run --project components src/components/booking/passkey-sign-in.test.tsx`
Expected: FAIL on `names both causes when the ceremony does not complete`.

Record the exact failure text. Restore and re-run — expect PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/booking/passkey-sign-in.tsx src/components/booking/passkey-sign-in.test.tsx
git commit -m "fix(passkey): say why a passkey ceremony did not complete instead of resetting silently"
```

---

### Task 5: Record the census and the decision

The issue requires the `allowCredentials` decision recorded beside the code. Per CLAUDE.md's *Comment Discipline*, the parts that annotate their own code are already in docblocks (Tasks 2-4); the census and the wider decision record reach past every file they could sit in, so they go in `docs/` where they have an owner and ship with their re-derivation command.

**Files:**
- Modify: `docs/technical-architecture.md`

**Interfaces:**
- Consumes: every prior task's landed state. **Task order is load-bearing here** — the counts must be re-derived after Tasks 1-4, not copied from the spec.

- [ ] **Step 1: Re-derive the census against the branch**

Run:

```bash
find src/app/api -name route.ts | wc -l
for f in $(find src/app/api -name route.ts | sort); do
  ids=$(grep -ohE "require[A-Za-z]+|getSession[A-Za-z]*|CRON_SECRET|checkIpRateLimit|checkRateLimit|checkStudentWriteLimit" "$f" \
        | sort -u | tr '\n' ' ')
  printf "%-60s %s\n" "${f#src/app/api/}" "$ids"
done
```

Expected after Task 3: still 62 routes and 8 without a session guard, but **5** rate-limited and **3** remaining unguarded-and-unthrottled (`health`, `auth/magic-link/verify`, `auth/passkey/authenticate/verify`). Write down the numbers this command actually prints; do not copy the spec's, which were measured before this branch.

- [ ] **Step 2: Add the two documentation sections**

Add the following to `docs/technical-architecture.md`, substituting the bracketed
slots with the numbers Step 1 actually printed. **Only the bracketed slots are
to be filled in** — the surrounding prose is final text, not a sketch.

````markdown
### Unauthenticated API routes

`find src/app/api -name route.ts` finds **[N]** routes. **[U]** carry no session
guard; **[R]** of those are rate-limited (`magic-link/send`, `student-signup`,
`teacher-signup`, `slug-available`, `passkey/authenticate/options`), leaving
**[N − … ]** with neither:

| route | why that is correct |
|---|---|
| `health` | Public health check. |
| `auth/magic-link/verify` | Token is `crypto.randomBytes(32)` — 256 bits, stored hashed, 15-minute TTL. Brute force is infeasible. |
| `auth/passkey/authenticate/verify` | Gated on a one-time 5-minute challenge plus WebAuthn signature verification; `redirect` is `relativePath.optional()` in `passkeyAuthVerifySchema`. |

Re-derive with:

```sh
find src/app/api -name route.ts | wc -l
for f in $(find src/app/api -name route.ts | sort); do
  ids=$(grep -ohE "require[A-Za-z]+|getSession[A-Za-z]*|CRON_SECRET|checkIpRateLimit|checkRateLimit|checkStudentWriteLimit" "$f" \
        | sort -u | tr '\n' ' ')
  printf "%-60s %s\n" "${f#src/app/api/}" "$ids"
done
```

The loop prints one row per route and expects all of them to be read, rather
than filtering to a count. A filtering grep gets this wrong:
`notifications/stream` guards with `getSessionToken`, not `requireSession`, so a
pattern listing only the `require*` helpers files it as unguarded.

### Passkey authentication options

`POST /api/auth/passkey/authenticate/options` never sends `allowCredentials`,
and reads nothing at all from the request body.

It used to accept an email, look up the account, and return that account's
credential ids. The key was absent for an unknown address, an empty array for
an account with no passkey, and a populated array otherwise — so an
unauthenticated caller could read account existence, passkey count and the
credential ids themselves off the response shape.

Equalising the response would not have been enough. The lookup is a timing
signal in its own right: one query for an unknown address, two for a known one.
Deleting the input removes both channels and leaves an invariant a reviewer can
check from the signature — no request-controlled value reaches the response.
`generatePasskeyAuthenticationOptions` therefore takes no parameter rather than
an unused optional one, so restoring the leak is a signature change.

**The cost.** Without a credential list the authenticator cannot pre-select,
so the ceremony needs a *discoverable* credential. Registration uses
`residentKey: 'preferred'`, so platform authenticators (iCloud Keychain,
Windows Hello, Android) are unaffected, while a hardware key whose resident
slots are full produces a non-discoverable credential that can no longer sign
in — that person falls back to the magic link, which is what the sign-in
button's failure copy points at.

**This population cannot be measured from our data.** Knowing whether a stored
credential is discoverable needs the `credProps` extension at registration,
which this codebase neither requests nor stores; `transports` is the only proxy
(a row without `'internal'`). The decision rests on inference about
authenticator behaviour, not measurement.

### Passkey challenge store

`src/lib/auth/passkey.ts` keeps WebAuthn challenges in memory, one bounded
partition per `ChallengePurpose`: `registration` (1,000) and `authentication`
(10,000).

They are separate because their writers differ in trust. Registration is
session-gated and keys by `accountId`; authentication is unauthenticated and
keys by a server-generated random id. One shared map would let a flood on the
ungated side evict the gated side's entries, and would let
`authenticate/verify`'s caller-supplied `challengeId` reach a registration
challenge — consuming a victim's in-flight one if their `accountId` were known.

Sizing: roughly 200 B per entry (32 B key, 43 B base64url challenge, 8 B
timestamp, ~120 B Map and object overhead), so both partitions full is about
2.2 MB against the 2 GB VPS. `registration`'s ceiling is a backstop rather than
a working limit — that partition holds at most one entry per account with a
registration in flight.

**Ordering invariant:** within a partition, iteration order is non-decreasing
in `expiresAt`. It holds because the TTL is constant, `expiresAt` is never
refreshed on read, and `storeChallenge` deletes a key before re-inserting it so
a re-stored entry moves to the tail. Two things depend on it: cleanup walks
from the head and stops at the first live entry (complete, not a sample), and
the head is the correct eviction victim under capacity pressure.
````

Every number here is legitimate — this is `docs/`, it has an owner, and the
census ships with the command that re-derives it. None of them may be copied
into a comment.

- [ ] **Step 3: Verify the docs claims against the code**

Confirm by reading, not assuming:
- the capacities in the doc match `CHALLENGE_CAPACITIES` in `src/lib/auth/passkey.ts`
- the rate limit in the doc matches `PER_IP_LIMIT` and `WINDOW_MS` in the route
- `residentKey: 'preferred'` is still what `generatePasskeyRegistrationOptions` passes

- [ ] **Step 4: Sweep every artifact for claims this branch invalidated**

```bash
grep -rn "allowCredentials" docs
grep -rn "56 routes\|MAX_KEYS" docs
grep -rn "passkeyAuthOptionsSchema" .
```

Give each hit a verdict. The spec's §1 deliberately records the *old* numbers as history and is correct to keep them; a live reference doc claiming them is not.

- [ ] **Step 5: Commit**

```bash
git add docs/technical-architecture.md
git commit -m "docs: record the route census and the passkey options decision"
```

---

## After all tasks

- [ ] **Whole-branch review** — the plan has 5 tasks, so this is required. One review on the most capable model, one fix wave, one scoped re-review. Its purpose is cross-task blindness: a claim consistent inside one task but wrong across two, and any docblock in Tasks 2-4 that a later task falsified.
- [ ] **Local verification, scoped honestly:**
  ```bash
  npm run typecheck && npm run lint
  npx vitest run --project components
  npx vitest run --project unit src/lib/auth/passkey.test.ts src/lib/rate-limit.test.ts
  ```
  This is **not** `npm run verify` and must not be described as one. The 33 DB-touching `unit` files and both `integration` and `e2e` are CI's to score.
- [ ] **Push and open the PR.** The body cites the CI run for `integration`, `e2e` and the DB-touching `unit` files; states the census correction (56/7/3/4 → 62/8/4/4 → 62/8/5/3 after this branch); names the three defects fixed beyond the issue's two (the three-way oracle arm, the cross-namespace registration-challenge read, the silent `NotAllowedError`); records what each corrected comment used to say; and states that **#170 is unaffected**.
- [ ] **`/pr-review-toolkit:review-pr <N>`** — code, tests, comments, silent-failure. Skip type-design: the only new type is a two-member string union, not a type worth a specialist pass.
