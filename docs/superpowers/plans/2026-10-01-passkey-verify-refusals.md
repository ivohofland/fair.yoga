# Passkey verify refusals (#729) — implementation plan

**Spec:** `docs/superpowers/specs/2026-10-01-passkey-verify-refusals-design.md` — the binding
authority. Read its Design and Tests sections before starting either task.

**Goal:** a malformed or mismatched WebAuthn response answers a coded 400 on both
`POST /api/auth/passkey/register/verify` and `POST /api/auth/passkey/authenticate/verify`, never a
500, and is logged at `warn`, never as `unhandled API error`; `register/verify`'s refusals are
tested.

## Global Constraints

- TypeScript `strict`; no `any`, no non-null `!` on values a test controls without a preceding
  assertion that would fail first.
- **Task order is load-bearing.** Task 2's integration cases expecting `PASSKEY_NOT_VERIFIED` for
  a wrong-challenge response only pass once Task 1 stops the helpers rejecting.
- No new assertion reads `error.message` against a literal (`docs/technical-architecture.md`,
  Error responses). Coded refusals are asserted with `expectRefusal` (`tests/api-assertions.ts`).
  A validation 400 is asserted as status 400, `code` absent, and message equal to `formatIssues`
  (`src/lib/validation-message.ts`) applied to the schema's own `safeParse` issues for the body
  sent — the module's output, never a quoted string.
- Comment discipline (CLAUDE.md): comments annotate the code they sit on, state what is true now,
  carry no counts or rosters, and no "this used to…" history.
- Wrong-challenge fixtures are **not** signed: the library refuses on the `clientDataJSON`
  challenge before it reads the attestation object or signature. Test names and comments must
  not call them "signed".
- Every mutation check: apply the mutation, warm the touched route with one request if it is an
  integration check (`next dev` compiles lazily — a first-request compile can read as a timeout),
  run the covering test, record the exact failure text in the report, restore, re-run green, and
  confirm `git status` shows no stray change before committing.
- Shell: this machine's default Node is 22; the repo needs 24. Prefix commands with
  `export PATH=/Users/ivohofland/.nvm/versions/node/v24.21.0/bin:$PATH;`. The worktree's own dev
  server is already running on :3102 (`pnpm run worktree:up`); never start, stop or restart any
  dev server. `INTEGRATION_BASE_URL` is read from `.env` automatically.
- Stage exact paths; never `git add -A` / `git add .`. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and reference `(#729)`.

---

### Task 1: The verify helpers resolve to a refusal instead of rejecting

**Files:** `src/lib/auth/passkey.ts`, `src/lib/auth/passkey.test.ts`, and one new unit test file
beside them for the transports filter (e.g. `src/lib/auth/passkey-transports.test.ts`). The two
verify routes must still typecheck against the new return types; touch them only if narrowing
requires it.

**Behaviour (spec Design §1, §2, §4):**

- `verifyPasskeyRegistration` returns
  `{ verified: true; credentialId: string; publicKey: Uint8Array; counter: number; transports: AuthenticatorTransportFuture[] }`
  or `{ verified: false; reason: string }`. The sentinel failure shape (`credentialId: ''`, empty
  key, zero counter, empty transports) goes. (`transports` may stay typed `string[]` if the route's
  Prisma write needs it — the filter is what matters; say which in the report.)
- `verifyPasskeyAuthentication` returns `{ verified: true; newCounter: number }` or
  `{ verified: false; reason: string }`.
- In each helper, a `try`/`catch` encloses **only** the `verifyRegistrationResponse` /
  `verifyAuthenticationResponse` call. A caught throw becomes `{ verified: false, reason }` with
  `reason = error instanceof Error ? error.message : String(error)`, truncated to 300 characters.
  The library returning `verified: false` (or registration's missing `registrationInfo`) also
  becomes `{ verified: false, reason }` with a fixed reason string.
- Every refusal emits exactly one `log.warn({ ceremony, reason }, 'passkey verification refused')`,
  `ceremony` being `'registration'` or `'authentication'`. Never `log.error`. `reason` is never
  returned to a route for sending — it exists for the log.
- The registration helper filters the library's `credential.transports` to known
  `AuthenticatorTransportFuture` members (from `@simplewebauthn/types`), using a set declared with
  `satisfies Record<AuthenticatorTransportFuture, true>` so a new member is a compile error there.
  The `as string[]` cast goes.
- Each helper's docblock states, about its own code: why the throw is caught here (the library
  signals refusals by throwing untyped `Error`s, which the route's error wrapper would answer as a
  500), and the server-side causes that now answer 400 + warn instead — spec Design §2's list:
  origin misconfiguration; the user-verification mismatch (state it as a fact about this file —
  the options ask for `'preferred'` while verification keeps the library's UV requirement — and
  that such a refusal is identifiable by its `reason`; cite #732, the decision issue for it);
  counter regression; corrupt stored key / missing WebCrypto. No counts, no rosters
  of other files.

**Tests first.**

`src/lib/auth/passkey.test.ts` (unit tier — real library, no mock of it). Build each fixture from
a base64url-encoded `clientDataJSON` whose `challenge` differs from the one passed as
`expectedChallenge`, passing every earlier library check (spec Tests, "Wrong-challenge fixtures"):

- registration response: `{ id, rawId: id, type: 'public-key', response: { clientDataJSON, attestationObject: '' }, clientExtensionResults: {} }`
  with base64url `id` and `clientDataJSON.type = 'webauthn.create'`;
- authentication response: `{ id, rawId: id, type: 'public-key', response: { clientDataJSON, authenticatorData: '', signature: '' }, clientExtensionResults: {} }`
  with `clientDataJSON.type = 'webauthn.get'`, and any `credentialPublicKey` / `credentialCounter: 0`.

Per helper, one case asserting all of: the promise **resolves**; the result has
`verified: false` and a `reason` matching `/challenge/`; among `log.warn` calls whose first
argument carries that helper's `ceremony`, exactly one, with message
`'passkey verification refused'`; `log.error` was not called. Spies are fresh per case (restore
in `afterEach`, or `mockClear` after creating) — the file already has an un-restored
`vi.spyOn(log, 'warn')` in an eviction test, and eviction warns share the logger.

New transports file: mock `@simplewebauthn/server`'s `verifyRegistrationResponse` to resolve a
verified result whose `registrationInfo.credential.transports` mixes known members (e.g.
`'usb'`, `'internal'`) with junk (a number, a string containing `\u0000`, `'carrier-pigeon'`);
assert the helper returns `verified: true` with exactly the known members, in order.

Run them and confirm they fail first (unit cases: the promise rejects; transports: junk survives):
`pnpm exec vitest run --project unit src/lib/auth/passkey.test.ts src/lib/auth/passkey-transports.test.ts`.

**Then implement**, re-run green, and run `pnpm run typecheck` and `pnpm run lint`.

**Mutation checks (record exact failure text for each):**

1. Remove the `try`/`catch` from `verifyPasskeyRegistration` → the registration case fails on a
   rejection. Restore.
2. Same for `verifyPasskeyAuthentication`. Restore.
3. Change the registration helper's `log.warn` to `log.error` → its case fails. Restore.
4. Drop the transports filter (pass the library's array through) → the transports case fails.
   Restore.

**Commit:** `fix(passkey): verify helpers resolve to a refusal instead of rejecting (#729)`.

---

### Task 2: Coded 400s at both routes, a credential-id schema, and the refusal tests

**Files:** `src/lib/api-error-codes.ts`, `src/lib/schemas.ts`,
`src/app/api/auth/passkey/register/verify/route.ts`,
`src/app/api/auth/passkey/authenticate/verify/route.ts`,
`src/app/api/auth/passkey/authenticate/verify/route.test.ts`,
`tests/integration/passkey-api.test.ts`.

**Behaviour (spec Design §3, §5, §6):**

- Register, in alphabetical position: `PASSKEY_CHALLENGE_MISSING: 400` and
  `PASSKEY_NOT_VERIFIED: 400`.
- `src/lib/schemas.ts`: one named credential-id schema — `z.string().regex(/^[A-Za-z0-9_-]+$/).max(1364)`
  — with a one-line comment giving the bound's derivation (1023-byte WebAuthn cap, unpadded
  base64url). Both `passkeyRegisterVerifySchema.response` and `passkeyAuthVerifySchema.response`
  become `z.looseObject({ id: <that schema> })`. Keep the "validated loosely" comment accurate.
- `register/verify`: the missing-challenge refusal sends `PASSKEY_CHALLENGE_MISSING` with
  `This passkey setup expired. Please try again.`; the `!result.verified` refusal sends
  `PASSKEY_NOT_VERIFIED` with `This passkey could not be verified. Please try again.` Status 400.
- `authenticate/verify`: the expired-attempt refusal sends `PASSKEY_CHALLENGE_MISSING` (message
  unchanged); the `!result.verified` refusal sends `PASSKEY_NOT_VERIFIED` with
  `This passkey could not be verified. Please try again.` `Credential not found` stays uncoded and
  unchanged.

**Existing tests to update (spec Tests, last bullet):**

- `route.test.ts`'s `verify()` builder sends a `response` whose `id` is valid base64url and matches
  the credential `primeCredential` returns (its cases assert 200 and would otherwise go red).
- `passkey-api.test.ts`, `authenticate/verify` describe: all three cases send a `response` with a
  valid `id`, so each pins one rejection. "a safe redirect passes validation and fails only on the
  challenge" asserts `expectRefusal(res, 'PASSKEY_CHALLENGE_MISSING')` instead of an absent code.
  Correct the describe's docblock (it calls the challenge refusal "an uncoded 400").

**New integration cases (`tests/integration/passkey-api.test.ts`, spec Tests, first bullet).**

A **validation 400** below means, in this order: precondition
`expect(schema.safeParse(body).success).toBe(false)`; status 400; `body.error.code` undefined;
`body.error.message` equal to `formatIssues` (`@/lib/validation-message`) of that `safeParse`'s
issues. Never a quoted message.

A new `describe('POST /api/auth/passkey/register/verify')`. Fixture: one account with a **live
student profile** (`validateSession` refuses a session whose account has no live profile — it
answers 401 `Session expired`) and a seeded session. Cases:

1. No cookie → 401.
2. Cookie, body that is not JSON → 400 with no `code`.
3. Cookie, `{ response: 'x' }` → validation 400 against `passkeyRegisterVerifySchema`.
4. Cookie, no prior `register/options`, a well-formed body → `PASSKEY_CHALLENGE_MISSING`.
5. `register/options`, then `{ response: {} }` → validation 400. `parseBody` runs before the
   challenge is taken, so this leaves the challenge in place — case 6 starts with its own
   `register/options` call regardless.
6. `register/options`, then a wrong-challenge registration response → `PASSKEY_NOT_VERIFIED`;
   then the same body again → `PASSKEY_CHALLENGE_MISSING` (the refused attempt burned the
   challenge).

In the `authenticate/verify` area, cases needing a live `challengeId` from
`POST /api/auth/passkey/authenticate/options` (it answers `data.challengeId`; send `freshIp()` —
that route is rate-limited per address):

7. `{ challengeId, response: {} }` → validation 400 against `passkeyAuthVerifySchema`.
8. `{ challengeId, response: { id: 'ab\u0000cd' } }` → validation 400 against
   `passkeyAuthVerifySchema`.
9. A `PasskeyCredential` row seeded for a fixture account with id = the response's `id`, then a
   wrong-challenge authentication response → `PASSKEY_NOT_VERIFIED`.

Wrong-challenge fixtures as in Task 1, with `origin` set to `BASE_URL`, and a base64url `id`.

Cleanup: `afterAll` deletes by arrays of ids collected in `beforeAll`, never by a single variable
that a failed `beforeAll` could leave `undefined` — an `undefined` Prisma filter matches every
row. Delete credentials, sessions and students before accounts.

**Order within the task: tests first.** Write cases 1–9 and the existing-test updates before
touching codes, schemas or routes; run them and record which fail and how (expected at Task 1's
head: 4, 6 and 9 on a missing `code`; 5 on a message mismatch; 7 and 8 answer 500; the
"fails only on the challenge" update on a missing code; 1–3 may already pass — they pin behaviour
that exists). Then implement.

**Run:** `pnpm exec vitest run --project integration tests/integration/passkey-api.test.ts`,
`pnpm exec vitest run --project unit src/app/api/auth/passkey/authenticate/verify/route.test.ts src/lib/auth/passkey.test.ts`,
`pnpm run typecheck`, `pnpm run lint`.

**Mutation checks (record exact failure text for each; warm the route first):**

1. Remove the `try`/`catch` from `verifyPasskeyRegistration` → case 6 answers 500. Restore.
2. Remove it from `verifyPasskeyAuthentication` → case 9 answers 500. Restore.
3. Revert `passkeyAuthVerifySchema.response` to `z.record(z.string(), z.unknown())` → case 7
   answers 500. Restore.
4. Drop only the `.regex(...)` from the credential-id schema → case 8 answers 500. Restore.
5. Revert `passkeyRegisterVerifySchema.response` to `z.record(...)` → case 5 answers
   `PASSKEY_NOT_VERIFIED` instead of the validation 400. Restore.
6. Drop the `PASSKEY_NOT_VERIFIED` code from `register/verify`'s refusal → case 6 fails. Restore.

**Commit:** one commit — tests and implementation together, since the new cases are red without
it — `fix(passkey): coded 400s for verify refusals; credential id checked at the boundary (#729)`.
