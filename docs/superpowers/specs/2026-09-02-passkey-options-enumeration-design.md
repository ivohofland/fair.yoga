# Passkey `authenticate/options`: closing the enumeration oracle and bounding the challenge store

**Issue:** #187 (child of #383, `security` label)
**Date:** 2026-09-02

`POST /api/auth/passkey/authenticate/options` is unauthenticated and
unthrottled. It answers differently depending on whether the posted email has
an account, and every call adds an entry to an in-memory map with no ceiling.
This spec closes both, and folds in two smaller defects found while verifying
the first.

---

## 1. Verifying the issue's premise

Three of the issue's claims moved between filing and now, and one was wrong.
Recording all four so nobody re-derives them.

### 1.1 The census is stale; its conclusion survives

| | issue, at filing | 2026-09-02 | why it moved |
|---|---|---|---|
| `route.ts` files under `src/app/api` | 56 | **62** | six routes added since |
| no session guard | 7 | **8** | `auth/teacher-signup` is new |
| …of those, rate-limited | 3 | **4** | `teacher-signup` added; `teachers` became `teachers/slug-available` |
| …remaining, unguarded and unthrottled | 4 | **4** | **membership unchanged** |

Arithmetic: 62 routes − 54 session-guarded = 8 unguarded; 8 − 4 rate-limited
(`magic-link/send`, `student-signup`, `teacher-signup`, `slug-available`) = 4
remaining.

The four remaining are still exactly `health`, `auth/magic-link/verify`,
`auth/passkey/authenticate/verify`, `auth/passkey/authenticate/options` — so
the issue's exclusion table still holds, and its three "ruled out" verdicts
were re-checked and still stand.

Re-derivation command, and the reason it is shaped this way:

```sh
find src/app/api -name route.ts | wc -l              # 62
for f in $(find src/app/api -name route.ts | sort); do
  ids=$(grep -ohE "require[A-Za-z]+|getSession[A-Za-z]*|CRON_SECRET|checkIpRateLimit|checkRateLimit|checkStudentWriteLimit" "$f" \
        | sort -u | tr '\n' ' ')
  printf "%-60s %s\n" "${f#src/app/api/}" "$ids"
done
```

This prints one row per route and expects the reader to read all 62, rather
than filtering to a count. A filtering grep gets this wrong: `notifications/stream`
guards with `getSessionToken`, not `requireSession`, and a pattern listing only
the `require*` helpers files it as unguarded. The census in
`docs/technical-architecture.md` ships with this command.

### 1.2 Defect 2's supporting quote no longer exists — the argument is stronger

The issue cites `src/lib/rate-limit.ts`'s `MAX_KEYS = 10_000` and the comment
*"so a scanner cycling keys cannot grow memory unbounded"*. Neither string is
in the repo any more; that module was rewritten into per-prefix partitioned LRU
(`PREFIX_CAPACITIES`, `DEFAULT_PREFIX_CAPACITY`). The precedent it sets is
therefore not merely "bound the map" but "bound it **per partition**, so a
flood on one key class cannot evict another's" — which is precisely the
distinction this spec needs, since the challenge store's two writers have
different trust levels.

### 1.3 Defect 1 is understated: the oracle is three-way, not two-way

The issue states `allowCredentials` is "present when the email maps to an
account with at least one passkey and absent otherwise". That is wrong in one
arm. `generateAuthenticationOptions` does `allowCredentials?.map(...)`
(`@simplewebauthn/server`, `script/authentication/generateAuthenticationOptions.js`),
so `undefined` short-circuits to absent but `[]` survives as `[]`; and
`JSON.stringify` omits `undefined`-valued keys while serializing `[]`. The
route sets `credentialIds = []` for an account with no passkeys. Result:

| posted email | `credentialIds` | response |
|---|---|---|
| none, or no such account | `undefined` | key **absent** |
| account, 0 passkeys | `[]` | `"allowCredentials":[]` |
| account, N passkeys | `[id, …]` | array of **N entries** |

So an unauthenticated caller separates *account-without-passkey* from
*no-account* — a state the issue's framing collapses — and additionally learns
the passkey **count** and the **credential IDs themselves**.
`PasskeyCredential.id` is `@id String` with no `@default`, written from
`credential.id` in `verifyPasskeyRegistration`: it is the WebAuthn credential
ID, not a surrogate key.

### 1.4 "Byte-identical" is not achievable; the testable claim is shape

The issue's acceptance criterion asks for a response "byte-identical" across
three email classes. The `challenge` and `challengeId` are freshly random per
request, so no two responses are ever byte-identical. The property that can be
asserted, and that closes the oracle, is **identical key set** with
`allowCredentials` absent in every case. §6 tests that.

### 1.5 Both roles, one endpoint

The flow is account-level and serves teachers and students alike:
`PasskeyCredential` hangs off `Account`; `PasskeySignIn` renders on
`(public)/login/page.tsx` and in `booking-sign-in.tsx`; `authenticate/verify`
resolves `/schedule` for a live teacher and `/bookings` otherwise; `AddPasskey`
renders on both `(student)/account/page.tsx` and
`(teacher)/settings/profile/page.tsx`. Neither role's email address is exposed
on the public teacher page, so the disclosure has equal value against both.

---

## 2. Decision on `allowCredentials`: option A, by deleting the input

The issue offers A (uniform response), B (keep the hint, throttle) and C
(accept and document). **We take A**, in its strongest form: the route stops
reading the request body entirely.

`generatePasskeyAuthenticationOptions` **loses its parameter** rather than
keeping an unused optional one. Reintroducing the leak then requires changing a
signature, not adding an argument — a compiler tether in the sense CLAUDE.md's
*Comment Discipline* means.

### Why deletion rather than equalising the branches

Equalising the response shape while keeping the lookup would leave a **timing**
channel: an existing account costs two queries (`account.findUnique` +
`passkeyCredential.findMany`), a non-existent one costs one. Deleting the
lookup removes the channel with the branch, and buys a single invariant a
reviewer can check by reading one signature:

> No request-controlled value influences this route's response.

### What it costs

`allowCredentials` lets the authenticator pre-select a credential. Without it
the ceremony needs a **discoverable** credential. Registration uses
`residentKey: 'preferred'` (`passkey.ts`), so:

- platform authenticators (iCloud Keychain, Windows Hello, Android) produce
  discoverable credentials essentially always — unaffected;
- a hardware security key whose resident-credential slots are full falls back
  to non-discoverable — **passkey sign-in stops working for that credential**,
  and the magic link becomes that person's route in.

**We cannot measure this population from our own data.** Knowing whether a
stored credential is discoverable requires the `credProps` extension at
registration, which this codebase neither requests nor stores. The `transports`
column is the only proxy — a row without `'internal'` is the group at risk.
This decision therefore rests on inference about authenticator behaviour, not
on measurement, and a future reader should know which.

The cost is smaller than it first appears: the hint is already unused on the
common path. On `/login` the email box starts empty and `PasskeySignIn` receives
`email={email || undefined}`, so clicking the button without typing — the normal
sequence — already sends `{}` and already gets no `allowCredentials`. Option A
makes the uncommon ordering match the common one.

### Consequential deletions

- `passkeyAuthOptionsSchema` (`src/lib/schemas.ts`) loses its only caller and
  is removed.
- `PasskeySignIn`'s `email` prop, and the argument at `login/page.tsx:75` and
  `booking-sign-in.tsx:108`. The `email` **state** stays in both — the
  magic-link form still uses it.
- `passkey.test.ts`'s *"returns options with allowCredentials when credential
  IDs provided"* tests a capability that no longer exists.
- `tests/integration/auth-email-case.test.ts`'s passkey arm, *"finds a passkey
  account when the address is typed in mixed case"*, exists to prove the email
  lookup is case-insensitive. With no lookup it asserts nothing, and its own
  comment already concedes it "is the weakest of the three". It is removed;
  **#170 keeps its other two arms** (`magic-link/send` and `student-signup`),
  which is where that property is actually load-bearing.

---

## 3. Challenge store: partitioned and bounded

### 3.1 Why partitioned, not one ceiling

`storeChallenge` has two writers at different trust levels:

| purpose | key | written by | gated? | growth |
|---|---|---|---|---|
| registration | `accountId` | `generatePasskeyRegistrationOptions` | session | one entry per account with a registration in flight |
| authentication | random 16-byte hex | `authenticate/options` | **none** | **unbounded** |

A single global ceiling with LRU eviction would let the ungated writer evict
the gated one's entries — trading an OOM for a cross-flow DoS on registration.
Separate budgets confine the blast radius, mirroring `rate-limit.ts`, whose
header docblock and `docs/technical-architecture.md` already commit to exactly
this reasoning for the same reason.

```ts
export type ChallengePurpose = 'registration' | 'authentication';

const CHALLENGE_CAPACITIES = {
  registration: 1_000,
  authentication: 10_000,
} as const satisfies Record<ChallengePurpose, number>;
```

The `satisfies Record<ChallengePurpose, number>` is the membership tether
CLAUDE.md asks for: a third purpose is a compile error here, not a silent
fallback.

`storeChallenge`, `getAndDeleteChallenge` and the test-only
`_getChallengeStore` all take the purpose as their first argument, so a caller
cannot reach a partition without naming it. The four production call sites are
`generatePasskeyRegistrationOptions` and `register/verify` (`'registration'`),
and `authenticate/options` and `authenticate/verify` (`'authentication'`).

### 3.2 It also closes a cross-namespace read the issue did not find

`authenticate/verify:18` passes `body.challengeId` — fully client-controlled,
validated only as `z.string().min(1)` — into `getAndDeleteChallenge`, which
reads the same map `register/options` writes under `accountId`. A caller who
knows a victim's `accountId` can therefore consume that account's in-flight
registration challenge, and the victim's registration fails with "Invalid or
expired challenge".

**Reachability, stated honestly:** this needs the victim's `accountId` *and* a
call inside their 5-minute registration window. `accountId` is returned only to
the account's own owner (`magic-link/verify:51`, `authenticate/verify`), so
there is no known path by which an attacker obtains one. This is "could hit",
not "will hit", and on its own it would be declined rather than filed.
Partitioning closes it by construction at zero additional cost, so it is folded
in rather than tracked.

### 3.3 The ordering invariant, and what it buys

The TTL is a constant and `expiresAt` is never refreshed on read, so entries
expire in the order they were inserted — **provided** re-storing an existing key
moves it to the tail. `Map.set` on an existing key keeps its original position,
so `storeChallenge` must `delete` before `set` to hold the invariant. (This is
reachable today: registration keys by `accountId`, and a user who reopens the
add-passkey screen re-stores the same key.)

> **Invariant:** within a partition, iteration order is non-decreasing in
> `expiresAt`.

Two things follow, and both are why the invariant is worth holding:

- `cleanupExpired` walks from the head and **stops at the first live entry**.
  It still removes every expired entry — so the existing docblock's claim
  ("cleans up any expired entries on each call") stays true — at O(expired)
  instead of O(n) per store.
- Under capacity pressure the head is both the least-recently-inserted and the
  soonest-to-expire entry, so it is the correct eviction victim on either
  reading.

The invariant is stated in a comment on the code it governs, and §6 gives it a
test that fails if the `delete` is removed.

One trap for whoever writes those tests: several existing tests insert entries
by reaching through `_getChallengeStore()` and calling `Map.set` with a
hand-chosen `expiresAt`, which bypasses `storeChallenge` and can therefore
place a live entry ahead of an expired one — violating the invariant and making
early-stop cleanup look broken when it is not. Direct insertions must stay in
non-decreasing `expiresAt` order. The existing cases happen to satisfy this
already (each inserts its expired entry at the head), so they keep passing
unchanged; a new one must be written deliberately.

### 3.4 Memory arithmetic

Per entry: ~32 B key (32 hex chars) + ~43 B challenge (base64url of 32 bytes)
+ 8 B number + ~120 B Map-entry and object overhead ≈ **200 B**.

Worst case `(10_000 + 1_000) × 200 B ≈ 2.2 MB` against the 2 GB VPS this
project targets — negligible, and the point is the ceiling's existence, not its
height.

`registration: 1_000` is a backstop rather than a working limit: that partition
holds at most one entry per account with a registration in flight, and this
project will not have 1,000 concurrent registrations.

Eviction emits a throttled warning, matching `rate-limit.ts`'s
`WARNING_LOG_THROTTLE_MS` pattern, so an operator learns a ceiling was reached
rather than it happening silently.

---

## 4. Rate limit on `authenticate/options`

A new IP-keyed limit at **100 requests/hour**, via the existing
`checkIpRateLimit`. Requires adding `'passkey-auth-options'` to
`RateLimitPrefix`, to `PREFIX_CAPACITIES` (2,000 IP buckets, matching
`magic-link:ip`) and to `IpRateLimitPrefix`; the `satisfies` tether forces the
second of those.

**Not part of the issue's acceptance criteria.** Bounding the store already
fixes the memory leak. The limiter is added because a bounded store alone still
lets an attacker churn the authentication partition and evict other users'
in-flight challenges — a sign-in DoS. The bound stops the OOM; the limiter
stops the flood that causes the eviction.

**Why 100, and not a number chosen for enumeration resistance:** with §2 there
is nothing left to enumerate, so this limiter's only job is bounding store
churn, and it should sit far above plausible legitimate use. Passkey sign-in is
click-driven, not keystroke-driven; a studio's shared NAT with twenty students
signing in, retries included, stays well under it. Its strength is statable:
100/hour is 8.3 requests per 5-minute TTL window, so filling the 10,000-entry
partition within one window needs `10_000 ÷ 8.3 ≈ 1,200` distinct source
addresses.

The refusal reuses `respondRateLimited`, whose `action` argument names what was
refused: `'Too many sign-in attempts.'`

---

## 5. Client copy for a ceremony that did not complete

`passkey-sign-in.tsx` currently treats `NotAllowedError` as a deliberate cancel
and resets to `idle` **silently**. The browser returns that same error both
when the user cancels and when no credential matches — WebAuthn conflates them
deliberately, so that the client cannot become an enumeration oracle either.
The silent reset therefore leaves someone with no usable passkey clicking a
button that will never work and saying nothing about the route that does.

Option A slightly widens who lands there, so the copy is fixed here rather than
filed.

A fourth state joins `'idle' | 'working' | 'error'` — named for what is known
(the ceremony did not complete) rather than for a cause that cannot be
determined:

> **Cancelled, or no passkey on this device. Try again, or use the email link.**

Naming both possibilities without claiming either is the point: the canceller
reads the first clause and ignores the message; the person with no passkey
reads the second and takes the email link. "Try again" alone would serve only
the reader who needs no help.

Styling and semantics differ from the genuine-failure state: neutral caption
text rather than `text-danger`, and `role="status"` (polite) rather than
`role="alert"` (assertive) — a cancel is not an error and should not interrupt
a screen reader mid-sentence. The existing hard-failure message is unchanged.

A comment records why the message must not try to detect the cause: probing the
device for credentials to write a better message would reintroduce on the
client the oracle §2 closes on the server.

---

## 6. Tests, and the mutation that proves each guard bites

Every guard is broken, its exact error text recorded, then restored and
re-verified. A pin that compiles but cannot fail certifies nothing.

| # | guard | test | mutation |
|---|---|---|---|
| 1 | no oracle | integration: post an email with a passkey, one with an account but no passkey, and one with no account → identical key set, `allowCredentials` absent in all three | reintroduce the lookup and pass the ids |
| 2 | no oracle, at the source | unit: options never carry `allowCredentials` | pass a credential list |
| 3 | partition ceiling | unit: drive `authentication` past `CHALLENGE_CAPACITIES.authentication`; size stays capped | delete the capacity check |
| 4 | partition isolation | unit: flood `authentication`; a `registration` entry survives | merge the two maps into one |
| 5 | cross-namespace | unit: a `registration` challenge is not retrievable under `'authentication'` | share one map |
| 6 | ordering invariant | unit: re-store an existing key, then assert cleanup still evicts every expired entry | revert `delete`-then-`set` |
| 7 | rate limit | integration: exceed 100/hour from one `freshIp()` address → 429 | remove the check |
| 8 | copy | component: a `NotAllowedError` rejection renders the incomplete message, not silence | restore the silent `idle` reset |

Test 1 requires a fixture with a **real** `PasskeyCredential` row. The existing
email-case fixture has none — which is exactly why its own comment calls it the
weakest of its three — and without one the "has a passkey" arm passes
vacuously.

Test 3 must read `CHALLENGE_CAPACITIES` rather than hardcode 10,000, so
changing a capacity cannot silently stop exercising the ceiling.

**Where the tiers run**, measured on this worktree at 2026-09-02 rather than
assumed:

| tier | local | measured baseline |
|---|---|---|
| `components` | runs | **52 files / 387 tests, all passing** |
| `unit`, DB-free | runs | targets green — `passkey.test.ts` + `rate-limit.test.ts` = 34 passing |
| `unit`, DB-touching | **cannot** | 33 files fail: `DATABASE_URL` resolves to an empty string |
| `integration`, `e2e` | **cannot** | need `:3000` and the shared dev database |

The worktree has no `.env`, so the 33 failures are a pre-existing environment
condition, not a signal about this branch — every one is a `services/` or
`lib/` test issuing a Prisma call, and none is a file this branch touches. They
are *not* fixed by copying the main checkout's `.env`: that would point the
worktree at the shared dev database the user's own dev server is using, and
these tests create and delete teacher rows.

So local verification here means typecheck, lint, `components`, and the DB-free
`unit` files. **CI is the signal for `integration`, `e2e`, and the DB-touching
`unit` files**, and the PR body cites the CI run for those rather than a local
`verify` — a green local run would be a claim about a strictly smaller set than
usual, and saying "verify is green" without that qualification would be false.

---

## 7. Where each claim lives

Per CLAUDE.md's *Comment Discipline* — a comment annotates the code it sits on;
anything wider goes in `docs/` with a link.

| claim | home | why |
|---|---|---|
| why the route reads nothing from the request; what A costs | docblock on `authenticate/options/route.ts` | about its own code |
| why there is no credential-list parameter, and that adding one reopens the oracle | docblock on `generatePasskeyAuthenticationOptions` | about its own signature |
| the ordering invariant | comment in `passkey.ts` beside the `delete`-then-`set` | about its own code, and tested |
| why the copy must not detect the cause | comment in `passkey-sign-in.tsx` | about its own code |
| the 62/8/4/4 census and the three ruled-out routes | `docs/technical-architecture.md`, with §1.1's command | a census reaches past every file it could sit in |
| the new rate-limit prefix and its coverage | `docs/technical-architecture.md`, both existing passages | facts about another module |

No count or roster appears in any comment.

---

## 8. Non-goals

- **`residentKey: 'preferred'` stays.** Flipping it to `'required'` would
  guarantee future credentials are discoverable but strand any existing
  non-discoverable one permanently, with no way to detect who holds it. That
  harm is silent; the fallback to the magic link is not.
- **The `credProps` extension is not added.** Storing discoverability would let
  us measure the affected population, but it is a registration-side data-model
  change with its own migration, and it does not change this decision.
- **The other three unguarded routes are unchanged.** `health`,
  `magic-link/verify` and `passkey/authenticate/verify` were re-checked against
  the issue's verdicts (§1.1) and remain correctly ruled out.
- **#170 is unaffected** — its property keeps the two test arms where it is
  load-bearing (§2).
- No change to magic-link sign-in, session handling, or passkey registration
  beyond the challenge store's signature.
