# Passkey user verification — Implementation Plan (#732)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both passkey ceremonies ask for user verification (`'required'`) and both verifiers
require it, from one declaration, so options and verification can no longer disagree.

**Architecture:** One module-level constant in `src/lib/auth/passkey.ts` feeds the two option
generators and, through `requireUserVerification`, the two verifiers. Unit tests pin each side
against real library-verified responses with only the UV flag varied; an e2e test pins that
Chrome stops a UV-less authenticator before anything reaches the server.

**Tech Stack:** `@simplewebauthn/server` 13.3.2, `@simplewebauthn/browser` 13.3.0,
`@simplewebauthn/types`, Vitest, Playwright (Chromium CDP virtual authenticator).

**Spec:** `docs/superpowers/specs/2026-10-01-passkey-user-verification-design.md`

## Global Constraints

- The posture is **require UV in both ceremonies** (spec, Options considered → 1).
- Options and verification derive from **one** declaration in `passkey.ts`; no second literal
  `'required'` / `'preferred'` for user verification anywhere in `src/`.
- No change to `add-passkey.tsx`, `passkey-sign-in.tsx`, any route, or any error code.
- Comments state what is true now; the before-and-after goes in the PR body (CLAUDE.md,
  *Comment Discipline*). No counts or rosters in comments.
- Stage exact paths; never `git add -A` / `git add .`.
- Every commit message ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **A UV-capable authenticator, the common path, still registers and signs in.** Expected:
   unchanged. Pinned by the existing e2e journey in `tests/e2e/passkey.spec.ts`, which Task 2
   re-runs unedited after the change.
2. **Sign-in on an authenticator holding a credential but lacking UV.** Expected: the browser
   stops the ceremony, the sign-in button shows its "Nothing came back from your device" status,
   and no request reaches `/api/auth/passkey/authenticate/verify`. Task 2, second e2e test.
3. **A response with UV cleared that reaches the server anyway** (a client ignoring
   `'required'`). Expected: refused, one warn naming user verification. Task 1 unit tests;
   the route's mapping of any refusal to 400 `PASSKEY_NOT_VERIFIED` is #729's existing pin.
4. **A library upgrade that changes the `requireUserVerification` default.** Expected: no
   change in behaviour, since the argument is now explicit. Task 1, mutation table (deleting the
   argument is inert today; the explicit argument is what makes a default change irrelevant).
5. **Somebody relaxes one side only** (e.g. options back to `'preferred'`). Expected: a test
   goes red. Task 1 option pins + Task 2 e2e, each mutation-checked.

---

### Task 1: One user-verification declaration, pinned on both sides

**Files:**
- Modify: `tests/passkey-fixtures.ts` (`forgedNoneRegistration`, `signedAssertion`)
- Modify: `src/lib/auth/passkey.ts` (new constant; both generators; both verifiers; both
  verifier docblocks)
- Modify: `src/lib/auth/passkey.test.ts`
- Modify: `docs/technical-architecture.md` (new subsection after "Passkey authentication
  options", before "Passkey challenge store")

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `forgedNoneRegistration` / `signedAssertion` accept optional
  `userVerified?: boolean` (default `true`). Generated registration options carry
  `authenticatorSelection.userVerification === 'required'`; authentication options carry
  `userVerification === 'required'`. Task 2 relies on the latter two through the running app.

- [ ] **Step 1: Give the fixtures a UV switch**

In `tests/passkey-fixtures.ts`, `forgedNoneRegistration`: widen the parameter type and derive
the flags byte from it.

```ts
export function forgedNoneRegistration(
  params: ExpectedCeremony & {
    authDataCredentialId: Uint8Array;
    responseId: string;
    userVerified?: boolean;
  },
): RegistrationResponseJSON {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  // UP | AT, plus UV unless `userVerified` is false: user present, attested
  // credential data, user verified.
  const flags = Uint8Array.of(0x01 | 0x40 | (params.userVerified === false ? 0 : 0x04));
```

and in `signedAssertion`:

```ts
export function signedAssertion(
  params: ExpectedCeremony & {
    credentialId: string;
    counter: number;
    privateKey: KeyObject;
    userVerified?: boolean;
  },
): AuthenticationResponseJSON {
  // UP, plus UV unless `userVerified` is false: user present, user verified.
  const flags = Uint8Array.of(0x01 | (params.userVerified === false ? 0 : 0x04));
```

Update each builder's docblock with one sentence: "`userVerified: false` clears the UV flag
and nothing else." Nothing else in the file changes.

- [ ] **Step 2: Write the option pins (these fail first)**

In `src/lib/auth/passkey.test.ts`, add to `describe('generatePasskeyRegistrationOptions')`:

```ts
  it('asks the authenticator for user verification', async () => {
    const options = await generatePasskeyRegistrationOptions({
      accountId: 'uv-test',
      userName: 'uv@example.com',
      userDisplayName: 'UV',
    });

    expect(options.authenticatorSelection?.userVerification).toBe('required');
  });
```

and to `describe('generatePasskeyAuthenticationOptions')`:

```ts
  it('asks the authenticator for user verification', async () => {
    const options = await generatePasskeyAuthenticationOptions();

    expect(options.userVerification).toBe('required');
  });
```

- [ ] **Step 3: Write the verifier pins (these pass already — the library default)**

Add to `describe('verifyPasskeyRegistration, forged fmt: none attestation')`, directly after
`'verifies when response.id matches the authenticator data id'` — that test is this one's
twin: same builder, same `FORGED` parameters, UV set.

```ts
  it('refuses, with one warn, a response whose authenticator did not verify the user', async () => {
    const credentialId = new Uint8Array(randomBytes(16));
    const responseId = isoBase64URL.fromBuffer(credentialId);
    const response = forgedNoneRegistration({
      ...FORGED,
      authDataCredentialId: credentialId,
      responseId,
      userVerified: false,
    });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = await verifyPasskeyRegistration({
      response,
      expectedChallenge: FORGED_CHALLENGE,
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe('User verification was required, but user could not be verified');
    const refusalWarnings = warnSpy.mock.calls.filter(
      (call) => (call[0] as { ceremony?: string }).ceremony === 'registration',
    );
    expect(refusalWarnings).toHaveLength(1);
    expect(refusalWarnings[0]?.[0]).toMatchObject({ credentialId: responseId });
    expect(errorSpy).not.toHaveBeenCalled();
  });
```

Add to `describe('verifyPasskeyAuthentication, signed assertion')`, directly after
`'verifies an assertion signed by the key whose public half is stored'` — its twin: same key,
same counter, UV set.

```ts
  it('refuses, with one warn, an assertion whose authenticator did not verify the user', async () => {
    const response = signedAssertion({
      ...FORGED,
      credentialId,
      counter: 1,
      privateKey: keyA.privateKey,
      userVerified: false,
    });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    const result = await verifyPasskeyAuthentication({
      response,
      expectedChallenge: FORGED_CHALLENGE,
      credentialPublicKey: coseES256PublicKey(keyA.publicKey),
      credentialCounter: 0,
    });

    if (result.verified) {
      throw new Error('expected a refusal');
    }
    expect(result.reason).toBe('User verification required, but user could not be verified');
    const refusalWarnings = warnSpy.mock.calls.filter(
      (call) => (call[0] as { ceremony?: string }).ceremony === 'authentication',
    );
    expect(refusalWarnings).toHaveLength(1);
    expect(refusalWarnings[0]?.[0]).toMatchObject({ credentialId });
    expect(errorSpy).not.toHaveBeenCalled();
  });
```

The two `reason` strings are the library's own (`verifyRegistrationResponse.js` and
`verifyAuthenticationResponse.js`, the `requireUserVerification && !flags.uv` branches); if
the run shows different text, read it from the library source and record the discrepancy in
the task report rather than loosening to a regex.

- [ ] **Step 4: Run, and record what fails**

Run: `pnpm exec vitest run src/lib/auth/passkey.test.ts`
Expected: the two `asks the authenticator for user verification` tests FAIL
(`expected 'preferred' to be 'required'`); the two new refusal tests PASS, because the library
already requires UV by default. Every pre-existing test still passes (the fixtures' default
keeps their flags unchanged). Record the failure lines verbatim.

- [ ] **Step 5: One declaration, both sides**

In `src/lib/auth/passkey.ts`, add `UserVerificationRequirement` to the existing
`import type { … } from '@simplewebauthn/types'` list, and place this above the
`// Registration` section banner:

```ts
// ---------------------------------------------------------------------------
// User verification
// ---------------------------------------------------------------------------

/**
 * What both ceremonies ask the authenticator for, and — through
 * `requireUserVerification` below — what both verifiers then demand. One
 * declaration so the request and the check cannot disagree. See
 * docs/technical-architecture.md ("Passkey user verification") for why it is
 * `'required'`.
 */
const USER_VERIFICATION: UserVerificationRequirement = 'required';
```

The annotation, not `satisfies`, is deliberate: `satisfies` would narrow the constant to the
literal `'required'`, and then changing it to `'preferred'` would make
`USER_VERIFICATION === 'required'` a TS2367 "no overlap" error — the one edit that should move
both sides would fail to compile.

Then:

- `generatePasskeyRegistrationOptions`: `authenticatorSelection.userVerification: USER_VERIFICATION`
- `generatePasskeyAuthenticationOptions`: `userVerification: USER_VERIFICATION`
- `verifyPasskeyRegistration`, in the `verifyRegistrationResponse({ … })` argument, after
  `expectedRPID`: `requireUserVerification: USER_VERIFICATION === 'required',`
- `verifyPasskeyAuthentication`, in the `verifyAuthenticationResponse({ … })` argument, after
  `expectedRPID`: `requireUserVerification: USER_VERIFICATION === 'required',`

- [ ] **Step 6: Run, all green**

Run: `pnpm exec vitest run src/lib/auth/passkey.test.ts src/lib/auth/passkey-verify-mocked.test.ts`
Expected: PASS, all tests.

- [ ] **Step 7: The verifier docblocks state what is true now**

In `verifyPasskeyRegistration`'s docblock, the closing lines currently read:

```
 * library-named error (`UnexpectedRPIDHash`) from a plain `Error`. Causes
 * other than a hostile response are refused the same way:
 * - a wrong `NEXT_PUBLIC_APP_URL`: every origin check fails with a plain
 *   `Error`, and `reason` names the origin this function expected;
 * - the user-verification mismatch: `generatePasskeyRegistrationOptions`
 *   …(four more lines)…
 *   verification. Decision tracked as #732.
 */
```

Replace everything from the `library-named error` line through ` */` with:

```
 * library-named error (`UnexpectedRPIDHash`) from a plain `Error`. A cause
 * other than a hostile response is refused the same way: a wrong
 * `NEXT_PUBLIC_APP_URL` fails every origin check with a plain `Error`, and
 * `reason` names the origin this function expected.
 */
```

In `verifyPasskeyAuthentication`'s docblock, delete the whole bullet beginning
`- the user-verification mismatch:` through `verification. Decision tracked as #732;`. The
bullets before and after it are unchanged.

Then grep: `grep -n "#732\|mismatch\|preferred" src/lib/auth/passkey.ts`
Expected: no hit for `#732`; no hit for user-verification `preferred` (the
`residentKey: 'preferred'` line is expected and correct).

- [ ] **Step 8: Record the decision in `docs/technical-architecture.md`**

Insert, between the end of "### Passkey authentication options" (after its "This population
cannot be measured from our data." paragraph) and "### Passkey challenge store":

```markdown
### Passkey user verification

Both ceremonies ask the authenticator for user verification (`'required'`) and
both verifiers require it, derived from one declaration in
`src/lib/auth/passkey.ts` (`USER_VERIFICATION`) so the request and the check
cannot disagree (#732). A passkey is therefore two-factor: the device, plus the
PIN or biometric that unlocks it.

The options used to ask for `'preferred'` while the verifiers, by
`@simplewebauthn/server`'s default, required verification anyway. An
authenticator that honours "preferred" by skipping it — a roaming security key
with no PIN set — completed the browser ceremony and was then refused by the
server, behind generic copy. With `'required'` the browser stops that key up
front, where its own UI can say why (Chrome typically offers to set a PIN).

Nobody who could use a passkey before is affected: the server already demanded
verification, so every stored credential was registered with it and every
successful sign-in supplied it.

Rejected:

- **Accept possession alone** (`requireUserVerification: false`). A PIN-less
  key would work, but a stolen key would become a full sign-in for any
  authenticator that skips verification — a looser posture for everyone, to
  rescue a population that has the magic link to fall back on.
- **Split by ceremony** (presence for registration, verification for sign-in).
  A key registered without verification could then never sign in.
```

- [ ] **Step 9: Prove each pin bites**

Commit nothing yet. For each mutation: apply it, run
`pnpm exec vitest run src/lib/auth/passkey.test.ts`, record the exact failing test names and
assertion lines in the task report, restore, and confirm `git diff --stat` shows only this
task's intended edits.

| # | Mutation (exact text) | Expected |
|---|---|---|
| M1 | both verifiers: `requireUserVerification: USER_VERIFICATION === 'required',` → `requireUserVerification: false,` | both `…did not verify the user` tests red ("expected a refusal") |
| M2 | `generatePasskeyRegistrationOptions`: `userVerification: USER_VERIFICATION` → `userVerification: 'preferred'` | registration `asks the authenticator for user verification` red |
| M3 | `generatePasskeyAuthenticationOptions`: `userVerification: USER_VERIFICATION` → `userVerification: 'preferred'` | authentication `asks the authenticator for user verification` red |
| M4 | delete both `requireUserVerification: …` lines | **inert** — every test green, because the library default is `true`. Expected, not a gap: the explicit argument names the default rather than changing behaviour |
| M5 | `const USER_VERIFICATION = 'required'` → `'preferred'` | both option pins red **and** both refusal tests red — one edit moves both sides |

After the last restore: `git status --short` lists exactly `tests/passkey-fixtures.ts`,
`src/lib/auth/passkey.ts`, `src/lib/auth/passkey.test.ts`, `docs/technical-architecture.md`,
and `git diff src/lib/auth/passkey.ts` shows no mutation text.

- [ ] **Step 10: Typecheck, lint, commit**

Run: `pnpm run typecheck && pnpm run lint`
Expected: both clean.

```bash
git add tests/passkey-fixtures.ts src/lib/auth/passkey.ts src/lib/auth/passkey.test.ts docs/technical-architecture.md
git commit -m "fix(passkey): require user verification in both ceremonies, from one declaration (#732)"
```

---

### Task 2: E2e — the browser stops a UV-less authenticator

**Order:** after Task 1. This task's assertions are about the app with Task 1's options in it.

**Files:**
- Modify: `tests/e2e/passkey.spec.ts`

**Interfaces:**
- Consumes: Task 1's options (`'required'` in both ceremonies), through the running app.
- Produces: nothing other tasks use.

- [ ] **Step 1: Bring up this worktree's own app**

```bash
pnpm install --frozen-lockfile
pnpm run worktree:setup
pnpm run worktree:up
```

Never touch a server on :3000. Playwright reads `INTEGRATION_BASE_URL` from the worktree
setup automatically.

- [ ] **Step 2: Add the two tests**

In `tests/e2e/passkey.spec.ts`:

1. Add `import { generateKeyPairSync, randomBytes } from 'node:crypto';` and
   `import type { CDPSession } from '@playwright/test';` at the top.
2. Add a module-level `let uvlessStudentId: string;` beside the existing `let` block.
3. In `beforeAll`, after the existing student is created, create a second one:

```ts
    const uvlessStudent = await prisma.student.create({
      data: {
        firstName: 'No',
        lastName: 'Pin',
        email: `e2e-passkey-nopin-${suffix}@test.local`,
        account: { create: { email: `e2e-passkey-nopin-${suffix}@test.local` } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    uvlessStudentId = uvlessStudent.id;
```

4. In `afterAll`, before the `if (teacherId)` block (the student/account deletes by `suffix`
   already cover the row itself; a credential row has no relation to cascade from):

```ts
    if (uvlessStudentId) {
      await prisma.passkeyCredential.deleteMany({ where: { accountId: await accountIdOfStudent(prisma, uvlessStudentId) } });
      await prisma.session.deleteMany({ where: { accountId: await accountIdOfStudent(prisma, uvlessStudentId) } });
    }
```

5. Add a helper above `test.describe`:

```ts
/**
 * A CTAP2 security key with no PIN and no biometric: it can prove presence
 * (a touch) but never user verification.
 */
async function addUvlessAuthenticator(cdp: CDPSession): Promise<string> {
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'usb',
      hasResidentKey: true,
      hasUserVerification: false,
      isUserVerified: false,
      automaticPresenceSimulation: true,
    },
  });
  return authenticatorId;
}
```

6. Add the two tests after the existing one, inside the same `test.describe`:

```ts
  test('a security key with no PIN cannot add a passkey, and the server is never asked', async ({
    page,
    context,
  }) => {
    const cdp = await context.newCDPSession(page);
    await addUvlessAuthenticator(cdp);
    const verifyRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/passkey/register/verify')) verifyRequests.push(request.url());
    });

    await context.addCookies([
      sessionCookie(await seedSession(prisma, await accountIdOfStudent(prisma, uvlessStudentId))),
    ]);
    await page.goto('/account');
    const optionsResponse = page.waitForResponse('**/api/auth/passkey/register/options');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await optionsResponse;

    // The browser refuses the ceremony; the component treats that as a
    // dismissal and returns to idle, with nothing sent for verification.
    await expect(page.getByRole('button', { name: 'Add a passkey' })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(verifyRequests).toEqual([]);
    expect(
      await prisma.passkeyCredential.count({
        where: { accountId: await accountIdOfStudent(prisma, uvlessStudentId) },
      }),
    ).toBe(0);
  });

  test('a security key with no PIN cannot sign in with a passkey it holds, and the server is never asked', async ({
    page,
    context,
  }) => {
    const cdp = await context.newCDPSession(page);
    const authenticatorId = await addUvlessAuthenticator(cdp);
    // A discoverable credential for this RP already on the key, so a refusal
    // cannot be "no credential to offer".
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: {
        credentialId: randomBytes(16).toString('base64'),
        isResidentCredential: true,
        rpId: new URL(BASE_URL).hostname,
        privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        userHandle: Buffer.from('uvless-user').toString('base64'),
        signCount: 0,
      },
    });
    const verifyRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/passkey/authenticate/verify')) verifyRequests.push(request.url());
    });

    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

    await expect(page.getByRole('status')).toHaveText(
      'Nothing came back from your device. Try again, or use the email link.',
    );
    expect(verifyRequests).toEqual([]);
  });
```

If `BASE_URL`'s hostname is not the app's RP ID in this environment, read `PASSKEY_RP_ID`
from the worktree's env instead and say so in the report. If `getByRole('status')` matches
more than one element on `/login`, scope it to the passkey button's container and say so.

- [ ] **Step 3: Measure — required vs preferred (the spec's stop condition)**

Run: `pnpm exec playwright test tests/e2e/passkey.spec.ts`
Expected: all three tests PASS. Record the run summary.

Then apply both Task 1 generator mutations (M2 and M3 text: `userVerification:
USER_VERIFICATION` → `userVerification: 'preferred'` in both generators), warm the routes
(`curl -s -o /dev/null -X POST "$INTEGRATION_BASE_URL/api/auth/passkey/authenticate/options"`),
and run again.
Expected: both new tests RED — registration with `verifyRequests` holding the verify URL
(the ceremony completes and the server refuses it), sign-in with an error alert instead of the
status line and a recorded verify request. Record the exact failure text. Restore, confirm
`git diff src/lib/auth/passkey.ts` is empty, and re-run: all three PASS.

**Stop condition:** if either new test is red with `'required'` in place, or green with
`'preferred'`, stop and report what Chrome did. Do not adjust assertions to fit — the case for
the chosen posture rests on this behaviour (spec, E2e).

- [ ] **Step 4: Lint, typecheck, commit**

Run: `pnpm run typecheck && pnpm run lint`
Expected: clean.

```bash
git add tests/e2e/passkey.spec.ts
git commit -m "test(passkey): the browser stops a PIN-less key before the server is asked (#732)"
```

---

## After both tasks

- Whole-branch review (two tasks), one fix wave, one scoped re-review.
- `pnpm run verify` in this worktree, then push and open the PR. The PR body carries the
  premise table, both docblock bullets as they read before, the mutation results from both
  tasks (including M4's expected inertness), and the e2e measurement.
- `pnpm run worktree:down` when done.
