# Passkey ceremonies require user verification, in the options and the verifier alike (#732)

## Problem

`src/lib/auth/passkey.ts` asks the browser for **optional** user verification (UV) in both
ceremonies and then verifies both responses with `@simplewebauthn/server`'s default, which
**requires** it. An authenticator that honours "preferred" by skipping UV — in practice a
roaming security key with no PIN set — completes the browser ceremony and is then refused by
the server. Since #729 that refusal is a coded 400 `PASSKEY_NOT_VERIFIED` and a warn; the
person sees only the component's generic copy ("Could not add a passkey on this device.") and
nothing says why.

## Premise check — measured, not taken from the issue

On `origin/main` at `a5046a1a`, `@simplewebauthn/server` 13.3.2, `@simplewebauthn/browser`
13.3.0.

| Claim | Held? | Evidence |
|---|---|---|
| Both generators send `'preferred'` | Yes | `passkey.ts` — `generatePasskeyRegistrationOptions` (`authenticatorSelection.userVerification`), `generatePasskeyAuthenticationOptions` (`userVerification`) |
| Neither verifier passes `requireUserVerification` | Yes | no hit for the name in `src/` |
| The library defaults it to `true` and refuses `!flags.uv` | Yes | `esm/registration/verifyRegistrationResponse.js` (destructure default, then `if (requireUserVerification && !flags.uv)`); `esm/authentication/verifyAuthenticationResponse.js` likewise |
| Nothing else in the repo states a UV posture | Yes | the two `userVerified` hits outside `passkey.ts` are fields of mocked library results in `passkey-verify-mocked.test.ts`, asserting nothing about UV |

Re-derive:

```sh
grep -rn "userVerification\|requireUserVerification\|userVerified" src tests
grep -n "requireUserVerification" \
  node_modules/@simplewebauthn/server/esm/registration/verifyRegistrationResponse.js \
  node_modules/@simplewebauthn/server/esm/authentication/verifyAuthenticationResponse.js
```

Two facts the issue did not state, both of which the design leans on:

- **Every passkey stored today was registered with UV.** The registration verifier has always
  required it, so no row was written without it. Requiring UV in the options therefore cannot
  strand an existing credential, and no backfill or re-registration exists to plan.
- **The e2e virtual authenticator already verifies.** `tests/e2e/passkey.spec.ts` adds a
  `ctap2`/`internal` authenticator with `hasUserVerification: true, isUserVerified: true`, so
  `'required'` leaves the existing e2e path as it is.

## Options considered

1. **Require UV everywhere** — options send `'required'`; verification keeps requiring it.
   Passkeys stay two-factor (possession + PIN/biometric). A PIN-less key is stopped by the
   browser before the ceremony produces anything, where the browser's own UI can say why
   (Chrome typically offers to set a PIN on the key). **Chosen.**
2. **Accept possession alone** — verifiers pass `requireUserVerification: false`. PIN-less keys
   work; a stolen key becomes a full sign-in for any authenticator that skips UV. Rejected: it
   loosens the posture for every authenticator, not only the PIN-less one, to rescue a small
   population that has the magic link to fall back on.
3. **Split by ceremony** — UV for sign-in, presence for registration. Rejected: a key
   registered without UV could then never sign in.

**Who option 1 changes things for.** The verifier was already the strictest point, so anyone
who succeeds today already supplies UV and sees the same prompt afterwards. Only a person whose
authenticator skips UV sees a difference: a browser-side stop instead of a server refusal after
the ceremony.

## Design

### One statement of the posture

`passkey.ts` gains one module-level constant from which both sides are derived:

- `generatePasskeyRegistrationOptions` sends it as `authenticatorSelection.userVerification`;
- `generatePasskeyAuthenticationOptions` sends it as `userVerification`;
- `verifyPasskeyRegistration` and `verifyPasskeyAuthentication` pass `requireUserVerification`
  derived from it, rather than relying on the library default nothing in this repo names.

Moving to option 2 or 3 later is then an edit to that one declaration, and the tests below go
red when it happens. The constant's exact shape (a `'required'` literal the verifiers compare
against, or a boolean from which both values are chosen) is settled in the plan against the
lint configuration; either satisfies this section.

### Client components — unchanged

When the browser refuses a ceremony for want of UV it rejects `navigator.credentials` with
`NotAllowedError`. `add-passkey.tsx` already maps that to idle ("the user dismissed the
prompt"), and `passkey-sign-in.tsx` to `incomplete`. No component or copy changes: the add
button's caption ("fingerprint, face, or device PIN") already describes a UV-only world.

### Server refusal path — unchanged

A response with UV absent now arrives only from a client that ignores `'required'`. It is
refused exactly as #729 built: `{ verified: false, reason }`, one warn, coded 400
`PASSKEY_NOT_VERIFIED`. No route changes.

## Tests

### Fixtures — `tests/passkey-fixtures.ts`

`forgedNoneRegistration` and `signedAssertion` gain an optional `userVerified` parameter,
default `true`, which when `false` clears the UV bit (`0x04`) from the authenticator-data
flags. Existing callers are untouched.

### Unit — `src/lib/auth/passkey.test.ts`

- `generatePasskeyRegistrationOptions` returns `authenticatorSelection.userVerification ===
  'required'`; `generatePasskeyAuthenticationOptions` returns `userVerification ===
  'required'`.
- `verifyPasskeyRegistration` refuses a forged `fmt: 'none'` registration that differs from a
  verifying one only in the UV bit, with one warn whose `reason` names user verification.
- `verifyPasskeyAuthentication` refuses a correctly signed assertion that differs from a
  verifying one only in the UV bit, likewise.
- Each refusal case sits beside a UV-set twin built from the same parameters that verifies, so
  the refusal is pinned to the bit rather than to some other defect in the fixture. The
  existing "verifies" cases already are that twin where they share parameters; the plan says
  which.

### E2e — `tests/e2e/passkey.spec.ts`

A signed-in user with a `ctap2` virtual authenticator that has **no** user verification
(`hasUserVerification: false`) presses "Add a passkey". Asserted: no request reaches
`/api/auth/passkey/register/verify`, no passkey row exists for the account, and the
component shows no error alert.

**Measure before writing the assertion.** Headless Chrome's behaviour here is an inference
until observed. The plan's first e2e step runs the scenario against both `'preferred'` and
`'required'` and records what happens. If `'required'` does not stop the ceremony in the
browser, stop and report: the case for option 1 rests on that behaviour.

**Measured.** The registration behaviour held: with `'required'` Chrome refused the UV-less
virtual authenticator and no request reached `register/verify`; with `'preferred'` the
ceremony completed and the server refused it (400). Sign-in could not be pinned in the
browser: an authenticator without UV holding a discoverable credential for the RP was
refused with `NotAllowedError` under `'preferred'` as well as `'required'` — a bare
`navigator.credentials.get()` included, so not this app's code. This app's sign-in sends no
`allowCredentials` (#187), which is the likely reason; it was not isolated further. A test
green under both values certifies nothing, so the e2e covers registration only, and the
authentication options' `'required'` is pinned at the unit tier. Measured with Chromium's
CDP virtual authenticator; a physical key may behave differently.

## Mutation checks

Each recorded with the exact failure text in the plan's execution:

| Mutation | Expected |
|---|---|
| Verifiers pass `requireUserVerification: false` | Both UV-cleared verifier cases go red |
| Registration generator back to `'preferred'` | Registration options pin red; e2e red (the ceremony completes and the verify request is sent) |
| Authentication generator back to `'preferred'` | Authentication options pin red |
| `requireUserVerification` argument deleted from both verifiers | **Inert** — the library default is `true`. This is the equivalence the explicit argument exists to name; the run confirms it rather than revealing a blind test |

## Docs and comments

- `docs/technical-architecture.md` gains a "Passkey user verification" subsection beside
  "Passkey authentication options": the choice, the two alternatives, who it affects, and the
  fact that no stored credential lacks UV.
- Both verifier docblocks in `passkey.ts` lose their "user-verification mismatch … Decision
  tracked as #732" bullet: the mismatch no longer exists, and a comment states what is true
  now. The before-and-after goes in the PR body.
- The #729 spec and plan mention #732; they are records and stay as written.

## Out of scope

- The generic add-passkey / sign-in error copy. Nothing in this change makes it reachable
  more often; the case it used to show for now ends at the browser.
- `residentKey: 'preferred'` and the discoverable-credential trade-off recorded under
  "Passkey authentication options".
