# Passkey verify: a bad authenticator response is a 400, not a 500 (#729)

## Problem

`POST /api/auth/passkey/register/verify` and `POST /api/auth/passkey/authenticate/verify`
answer **500 `Internal server error`** to a malformed or mismatched WebAuthn response, and log
it at error level as `unhandled API error`. A client fault reads as a server fault in both the
response and the log. `register/verify`'s refusals are also untested.

## Premise check — measured, not taken from the issue

Probed over HTTP against this worktree's own dev server (`worktree:up`, :3102), on `origin/main`
at `fd7a396d`, with an account holding a live student profile and a seeded session. The
`unhandled API error` lines were read back from `worktree-dev.log`.

| # | Route | Request | Answer | What threw |
|---|---|---|---|---|
| 1 | `register/verify` | no cookie | 401 `Authentication required` | — |
| 2 | `register/verify` | body `{nope` | 400 `Invalid JSON` | — |
| 3 | `register/verify` | `{ response: 'x' }` | 400 `response: Invalid input: expected record, received string` | — |
| 4 | `register/verify` | signed in, no `register/options` first | 400 `No pending registration challenge` | — |
| 5 | `register/verify` | after `register/options`, `clientDataJSON.challenge` ≠ issued | **500** | `Error: Unexpected registration response challenge …` (library) |
| 6 | `register/verify` | after `register/options`, `response: {}` | **500** | `Error: Missing credential ID` (library) |
| 7 | `authenticate/verify` | live `challengeId`, `response: {}` | **500** | **`PrismaClientValidationError`** — `passkeyCredential.findUnique({ where: { id: undefined } })` |
| 8 | `authenticate/verify` | live `challengeId`, credential row exists, wrong challenge | **500** | `Error: Unexpected authentication response challenge …` (library) |

What held: every branch the issue lists (rows 1–5, 8), and its reading of the library —
`@simplewebauthn/server` 13.3.2 signals almost every rejection by `throw new Error(...)` and
returns `verified: false` only from its late attestation/signature checks
(`esm/registration/verifyRegistrationResponse.js`, `esm/authentication/verifyAuthenticationResponse.js`).

What the issue missed: **row 7.** `authenticate/verify` reads `response.id` before it ever calls
the library, and `passkeyAuthVerifySchema` accepts any record as `response`, so a response with
no string `id` reaches Prisma as `where: { id: undefined }` — a different throw site, which a
catch around the library call alone would not close. Row 6 is the same gap on the registration
side, closed there by the library catch anyway.

Row 7 is one instance of a class: **a client-derived value reaching Prisma unvalidated.** The spec
review found two more, by reading and one measurement:

- `{ challengeId: <live>, response: { id: "ab\u0000cd" } }` to `authenticate/verify` answered
  500 — `PrismaClientUnknownRequestError`, Postgres `22021` (NUL in a UTF-8 string), from the same
  `findUnique`. A non-empty-string check would not have stopped it.
- `register/verify` writes `registrationInfo.credential.transports` to the `String[]` column. The
  library passes the client's `response.transports` through untouched, and a `fmt: 'none'`
  attestation verifies with no signature, so any signed-in caller can build a response the
  library accepts carrying `transports: [1]` or a NUL-bearing string — a 500 **after** a
  successful verification, past any catch. Reasoned from the library source, not measured.

A client-chosen credential id that already exists is a P2002, which `classifyApiError` already
answers 409 `UNIQUE_CONFLICT` at warn — not a 500, and not in scope.

Neither browser component surfaces these routes' messages (`add-passkey.tsx` and
`passkey-sign-in.tsx` both throw a generic `'verify'` on any non-OK answer), so no message on
either route is user-visible copy today.

## Options considered

**A. Catch at the library call, inside the `src/lib/auth/passkey.ts` helpers** (chosen).
`verifyPasskeyRegistration` / `verifyPasskeyAuthentication` wrap only the
`verifyRegistrationResponse` / `verifyAuthenticationResponse` call, and a throw from it becomes a
`{ verified: false }` result. The routes' existing `if (!result.verified) return 400` branches
then carry every refusal.

**B. A typed `PasskeyVerificationError`, classified in `classifyApiError`.** Rejected: `ApiFailure`'s
status is a deliberate `409 | 500 | 503` union, widening it to 400 for one module changes a
shared contract, and the classifier would still need the helper to wrap the library's untyped
`Error` first — B is A plus a type and a classifier branch.

## Design

1. **Helpers never reject for a refused response.** Each helper's return type becomes a
   discriminated union — `{ verified: true; …fields }` | `{ verified: false; reason: string }` —
   replacing the registration helper's sentinel `credentialId: ''` / empty-key shape. The `try`
   encloses only the library call. The registration helper's verified result is still
   client-derived past it (a `fmt: 'none'` attestation verifies with no signature), so that
   helper also checks what it returns — Design 3 and 4. `reason` is
   `error instanceof Error ? error.message : String(error)`, truncated to 300 characters (several
   library messages echo client-sent strings of unbounded length), or a fixed string when the
   library returned `verified: false` or the helper refused a verified result. **`reason` goes to the log only, never to
   the client.**
2. **One `warn` line per refusal, from the helper,** carrying the ceremony
   (`'registration' | 'authentication'`) and the reason — never `error`, never
   `unhandled API error`. The library's errors are untyped, so the catch cannot tell a hostile
   client from a server-side cause, and some server-side causes now answer 400 + warn instead of
   500 + error. Each is accepted, and the helper's docblock names them:
   - a wrong `NEXT_PUBLIC_APP_URL` — every origin check fails, and `reason` names the expected
     origin. (A wrong `PASSKEY_RP_ID` mostly fails earlier, in the browser's options ceremony;
     what reaches the server says only `Unexpected RP ID hash`.)
   - **the user-verification mismatch** — both option generators ask for
     `userVerification: 'preferred'`, but neither verifier passes `requireUserVerification`, so the
     library's default `true` refuses an authenticator that honours "preferred" by skipping UV (a
     security key with no PIN). That is a live defect for such users today, as a 500. Fixing it
     changes the security posture (accept single-factor possession, or demand UV up front), so it
     is **filed as a decision issue (#732), not fixed here**; this design only moves it from 500 to 400
     and leaves its `reason` greppable.
   - a counter regression (the library's cloned-authenticator signal) — the attempt already fails
     closed, there is no alerting that a level would route to, and its `reason` names the counters.
   - a corrupt stored public key, or a runtime without WebCrypto — server-side, negligible.
3. **Both schemas require `response.id` to be a credential id's shape,** still loose elsewhere:
   `z.looseObject({ id: <credential id> })`, where the credential id is one named schema in
   `src/lib/schemas.ts` used by both — base64url characters only (`/^[A-Za-z0-9_-]+$/`), at most
   1364 characters (WebAuthn caps a credential id at 1023 bytes; ⌈1023 × 4 / 3⌉ = 1364 unpadded
   base64url characters). Closes row 7 and its NUL-byte sibling at the request boundary, before
   the challenge is consumed. Applied to `passkeyRegisterVerifySchema` too so the two stay one
   shape; row 6 then answers at `parseBody` as well.

   On registration the schema bound reaches the stored id only through **the id binding**: the id
   the library returns is parsed from the client-supplied authenticator data (a uint16 length, so
   up to 65535 bytes), and the library never checks it against `response.id`. A 4000-byte id
   verified and Postgres refused it as a btree key (SQLSTATE 54000) — a 500 on the `create`. The
   registration helper therefore refuses, through the same `{ verified: false, reason }` + one
   `warn` path, a result whose credential id differs from `response.id`; a genuine authenticator
   always satisfies this. With it, the stored id is the schema-checked one, and `.max(1364)` is
   what keeps an oversized id out of the primary key.
4. **The registration helper keeps only transports it knows.** The library passes the client's
   `response.transports` through untouched. **A value that is not an array is treated as no
   transports** (`.filter` on a string, object or number throws a `TypeError` after
   verification, past the catch — a 500), and an array is filtered to `AuthenticatorTransportFuture` members, with the set tethered
   to the type by `satisfies Record<AuthenticatorTransportFuture, true>`; the `as string[]` cast
   goes. The container check and the filter together close the post-verification 500 and stop
   arbitrary client strings landing in the column.
5. **Two refusals gain registered 400 codes, shared by both routes.** Status unchanged.
   `PASSKEY_NOT_VERIFIED` is sent by each route's `!result.verified` branch;
   `PASSKEY_CHALLENGE_MISSING` by each route's missing-challenge branch. Why codes: today both of
   `register/verify`'s refusals are uncoded 400s, so a test telling them apart — the burned
   challenge below needs exactly that — could only read `error.message`, which
   `docs/technical-architecture.md` (Error responses) forbids for a new assertion. 400 codes have
   precedent (`ROOM_NOT_ON_LIST`). `Credential not found` stays uncoded: no test needs to tell it
   apart, since a coded `PASSKEY_NOT_VERIFIED` already proves a request got past it. The challenge
   stays consumed before verification, so a refused attempt burns it.
6. **The three messages these lines send are reworded to the copy register** (full sentence,
   closing period, the user's terms, the next step) while the lines are open for their codes. No
   client renders them and no test reads them, so this costs nothing:
   `No pending registration challenge` → `This passkey setup expired. Please try again.`;
   `Registration verification failed` and `Authentication verification failed` → `This passkey
   could not be verified. Please try again.` The authenticate route's expired-attempt message
   already meets the register and is kept.

## Tests

- **Integration (`tests/integration/passkey-api.test.ts`)**, over HTTP. Coded refusals are asserted
  with `expectRefusal`, never by copy. A validation 400 is asserted as: precondition
  `schema.safeParse(body).success === false` (so a schema mutation fails an assertion, not the
  harness); status 400; `code` absent (`expectRefusal` cannot say "uncoded", and both new codes
  are 400s too); message equal to `formatIssues` of that `safeParse`'s issues — the module's
  output, never a literal.
  - `register/verify`: no session → 401; unparseable JSON → uncoded 400; `{ response: 'x' }` →
    validation 400; no pending challenge → `PASSKEY_CHALLENGE_MISSING`; after `register/options`,
    `{ response: {} }` → validation 400 (a body the old schema accepted, so it sees a revert);
    after `register/options`, a wrong-challenge response → `PASSKEY_NOT_VERIFIED`, and the same
    body again → `PASSKEY_CHALLENGE_MISSING` (the refused attempt burned the challenge); a
    1365-character base64url `response.id` → validation 400 (pins `.max(1364)`).
  - `authenticate/verify`: live `challengeId`, `response: {}` → validation 400; live
    `challengeId`, `response.id` containing a NUL byte → validation 400; wrong-challenge response
    against a seeded credential row → `PASSKEY_NOT_VERIFIED`. The existing "fails only on the
    challenge" case asserts `PASSKEY_CHALLENGE_MISSING` rather than an absent code.
- **Unit (`src/lib/auth/passkey.test.ts`)**, the "not logged as an unhandled error" half: each
  helper, given a wrong-challenge response, resolves (never rejects) to `{ verified: false }` with
  a `reason` matching `/challenge/` (the library's message, not this repo's copy — it proves the
  fixture reached the check it is named for), logs exactly one `warn` carrying its ceremony, and
  logs no `error`. Real library, no mock. Spies are fresh per case and the warn count is filtered
  on the ceremony field, since `storeChallenge`'s eviction warns share the logger.
- **Unit, transports:** the registration helper, with the library mocked to return a verified
  result whose `transports` mixes known members with junk (a number, a NUL-bearing string, an
  unknown name), returns only the known members. In its own file, since `passkey.test.ts` runs the
  real library.
- **Unit, forged `fmt: 'none'` attestation (real library, `passkey.test.ts`):** a registration
  response built without an authenticator — `clientDataJSON` with the issued challenge,
  `webauthn.create` and the expected origin; authData = sha256(rpId) ‖ flags UP|UV|AT ‖ counter ‖
  AAGUID ‖ id length ‖ id ‖ COSE ES256 key; attestation object CBOR
  `{ fmt: 'none', attStmt: {}, authData }`. With `response.id` equal to the authData id it
  verifies (proving every case below reaches the post-verification code); with
  `transports: 'usb'` it verifies with `transports: []`; with the authData id differing from
  `response.id` it resolves `{ verified: false }` with one `registration` warn and no `error`.
- **How the route-level half follows:** no HTTP test can read the server log. The claim that a
  refused response no longer produces `unhandled API error` rests on the coded 400: a
  `PASSKEY_NOT_VERIFIED` answer comes from the route's own `respondError`, and `withErrorHandler`'s
  classifier can only produce 409, 500 or 503 — so a request answered with that code never passed
  through the unhandled path.
- **Existing tests that post `response: {}` to reach a later branch** must send a valid `id`:
  `authenticate/verify/route.test.ts`'s `verify()` builder (its cases assert 200, so they would go
  red, not pass wrongly), and in `passkey-api.test.ts` the "fails only on the challenge" case (which
  would pass for the wrong reason — the silent one) and the two redirect cases, so each pins one
  rejection rather than two. That file's docblock, which calls the challenge refusal "an uncoded
  400", is corrected to what is true now.

**Wrong-challenge fixtures** need no real signature: the library checks the challenge before the
attestation object or signature. To reach that check a fixture must pass every earlier one —
`id === rawId`, base64url `id`, `type: 'public-key'`, and a base64url `clientDataJSON` string whose
JSON `type` is `'webauthn.create'` (registration) or `'webauthn.get'` (authentication). Tests say
"names another challenge", never "signed". The origin check comes after the challenge check, so
these cases do not depend on the server's configured origin or port.

## Mutation checks (in the plan, per guard)

- Remove the registration helper's `try`/`catch` → the register wrong-challenge integration case
  answers 500 and its unit case rejects.
- Remove the authentication helper's `try`/`catch` → the authenticate wrong-challenge integration
  case answers 500 and its unit case rejects.
- Revert `passkeyAuthVerifySchema.response` to `z.record(z.string(), z.unknown())` → the
  authenticate `response: {}` case answers 500 (row 7).
- Drop only the base64url pattern from the credential id schema → the NUL-byte case answers 500.
- Revert `passkeyRegisterVerifySchema.response` likewise → the register `response: {}` case
  (challenge pending) answers `PASSKEY_NOT_VERIFIED` instead of the validation 400.
- Change a helper's `log.warn` to `log.error` → its unit case fails on the no-`error` assertion.
- Drop the transports filter → the transports unit case fails.
- Drop the registration helper's `Array.isArray` container check → the forged-attestation
  `transports: 'usb'` case rejects with a `TypeError`.
- Drop the registration helper's credential-id binding → the forged-attestation id-mismatch case
  resolves `verified: true`.
- Drop `.max(1364)` from the credential id schema → the register 1365-character id case fails.
- Drop `PASSKEY_NOT_VERIFIED` from `register/verify`'s refusal → the register wrong-challenge case
  fails.

## Out of scope

- **The success path** of `register/verify` stays covered by `tests/e2e/passkey.spec.ts`, unchanged.
- **The user-verification mismatch** (Design 2) — #732.
- No change to the challenge store or the client components.
