# passkey/authenticate/verify's teacher-bounce guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `passkey/authenticate/verify`'s destination logic actually mirrors `magic-link/verify`'s #431 guard, instead of a comment merely claiming it does. An account that already has a live teacher profile is no longer sent to `/signup/profile` through the passkey sign-in door, matching the magic-link door.

**Architecture:** One change, no new subsystem. #431 gave `magic-link/verify` a one-destination refusal: `body.redirect === TEACHER_PROFILE_PATH && resolved.teacherId !== null` falls through to the role fallback instead of honouring the caller's destination. #439 found that `passkey/authenticate/verify`'s comment claims to mirror that guard but the code never got it — #431 touched one route, not both doors. This plan adds the same refusal to the passkey route, reusing the teacher-profile fact the route already computes for its fallback (`account?.teacher && !account.teacher.deletedAt`) rather than introducing a second way to ask the same question.

This is issue #439's **option 2** (extend the guard for consistency between the two sign-in doors), not option 1 (narrow the comment to admit the routes have diverged). Chosen because the two doors landing on different behaviour for the same input is what a future reader would find surprising, and the fix is a four-line diff reusing an existing, already-tested pattern.

**Tech Stack:** Next.js App Router route handlers, TypeScript strict, vitest (`unit` project — this route's crypto dependency (`verifyPasskeyAuthentication`) rules out the `integration` project, see below), Prisma.

**Issue:** #439

## Why this is a unit test, not an integration test

`magic-link/verify`'s #431 guard is pinned by full HTTP integration tests (`tests/integration/teacher-signup-api.test.ts`) because a magic-link token is just a DB row — the test can mint one with `generateMagicLinkToken` and POST a real request end to end.

`passkey/authenticate/verify` cannot be driven that way: reaching the destination logic requires `verifyPasskeyAuthentication` to return `{ verified: true }`, which means producing a real WebAuthn assertion signature — not something an integration test can fabricate over HTTP. This route already has no full-success integration test for exactly this reason (`tests/integration/passkey-api.test.ts`'s own docblock stops at "fails only on the challenge").

The established pattern for this exact situation is `src/app/api/auth/magic-link/verify/account-not-found.test.ts`: a route-adjacent unit test that imports the real `POST` handler and mocks only the two calls the integration tier cannot reach or fake (there: `verifyWithHandoff`/`resolveOrClaimAccount`; here: `verifyPasskeyAuthentication`/`createSession`/the `prisma` calls). Everything else in the handler — `withErrorHandler`, `parseBody`, the schema, the destination logic itself — runs for real. This plan follows that pattern.

## Global Constraints

- **TypeScript strict.** No `any`, no implicit types.
- **Comment Discipline (CLAUDE.md).** The stale comment this issue is about is replaced with what is true now, not annotated with what it used to claim.
- **Never restart the dev server on the worktree's assigned port.** Not needed for this task — the new test is a `unit`-project test with everything DB/crypto mocked, so it does not need the app live.
- **Stage exact paths**, never `git add -A`/`git add .`.

---

### Task 1: extend the guard and pin it

**Files:**
- Modify: `src/app/api/auth/passkey/authenticate/verify/route.ts` (import line, and the destination block at the current lines 47-53)
- Create: `src/app/api/auth/passkey/authenticate/verify/route.test.ts`

**Interfaces:**
- Consumes: `TEACHER_PROFILE_PATH` from `@/lib/schemas` (already exported, already imported by `magic-link/verify/route.ts`).
- Produces: nothing new — the route's response shape (`{ data: { accountId, redirectTo } }`) is unchanged.

**Context the implementer needs.** The route today, at `src/app/api/auth/passkey/authenticate/verify/route.ts:47-53`:

```ts
  const sessionToken = await createSession(prisma, credential.accountId);
  // Prefer the caller's destination (booking flow) — schema-validated to a
  // relative path — over the role default, mirroring magic-link verify.
  // Dual-role accounts default to the teacher home.
  const account = await prisma.account.findUnique({
    where: { id: credential.accountId },
    select: { teacher: { select: { deletedAt: true } } },
  });
  const fallback = account?.teacher && !account.teacher.deletedAt ? '/schedule' : '/bookings';
  const redirectTo = body.redirect ?? fallback;
```

Unlike `magic-link/verify`'s `tokenRedirect` (which comes from a DB token row and needs an explicit `isSafeRelativePath` check at the point of use), this route's `body.redirect` is already `relativePath.optional()` in `passkeyAuthVerifySchema` — `parseBody` at the top of the handler has already rejected an absolute or protocol-relative path with a 400 before this line runs. So the new guard needs no `isSafeRelativePath` call; it only needs the one-destination refusal.

**The mutation this must survive** — same shape as #431's, and the reason both directions are tested — is the one-directional guard:

```ts
// WRONG: breaks an existing STUDENT-only account passing /signup/profile through this door
body.redirect === TEACHER_PROFILE_PATH ? fallback : body.redirect
```

That satisfies the teacher case and silently destroys the second-hat flow, where a student-only account must still reach `/signup/profile`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/auth/passkey/authenticate/verify/route.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { storeChallenge } from '@/lib/auth';

/**
 * #439. `passkey/authenticate/verify`'s destination logic claimed to mirror
 * `magic-link/verify`'s #431 guard but never got it — #431 touched one
 * route, not both sign-in doors. This proves the guard now actually fires
 * here, in both directions: refused for an account that already teaches,
 * honoured for one that doesn't (the second-hat flow).
 *
 * WHY THIS IS MOCKED, following `magic-link/verify/account-not-found.test.ts`
 * (which names the same reasoning): reaching this branch needs
 * `verifyPasskeyAuthentication` to return `{ verified: true }`, which means a
 * real WebAuthn assertion signature — not something the `integration` tier's
 * HTTP-only driving can produce. `verifyPasskeyAuthentication` and
 * `createSession` are mocked; the handler underneath them is real —
 * `withErrorHandler`, `parseBody`, the schema, and the destination logic all
 * run.
 */

const verifyPasskeyAuthentication = vi.fn();
const createSession = vi.fn();

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    verifyPasskeyAuthentication: (...args: unknown[]) => verifyPasskeyAuthentication(...args),
    createSession: (...args: unknown[]) => createSession(...args),
  };
});

const passkeyCredentialFindUnique = vi.fn();
const passkeyCredentialUpdate = vi.fn();
const accountFindUnique = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    passkeyCredential: {
      findUnique: (...args: unknown[]) => passkeyCredentialFindUnique(...args),
      update: (...args: unknown[]) => passkeyCredentialUpdate(...args),
    },
    account: {
      findUnique: (...args: unknown[]) => accountFindUnique(...args),
    },
  },
}));

const { POST } = await import('./route');

function verify(challengeId: string, redirect?: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/passkey/authenticate/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response: {}, challengeId, ...(redirect ? { redirect } : {}) }),
  });
}

function primeCredential(accountId: string) {
  passkeyCredentialFindUnique.mockResolvedValue({
    id: 'cred-1',
    accountId,
    publicKey: Buffer.from('pk'),
    counter: 0n,
  });
  passkeyCredentialUpdate.mockResolvedValue({});
  verifyPasskeyAuthentication.mockResolvedValue({ verified: true, newCounter: 1 });
  createSession.mockResolvedValue('session-token');
}

describe('POST /api/auth/passkey/authenticate/verify — teacher-signup destination for an existing account', () => {
  it('sends an account that already teaches to its schedule, not to a page it would be bounced from', async () => {
    primeCredential('acc-teacher');
    accountFindUnique.mockResolvedValue({ teacher: { deletedAt: null } });
    storeChallenge('authentication', 'chal-teacher', 'expected-challenge');

    const res = await POST(verify('chal-teacher', '/signup/profile'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { redirectTo: string } };
    expect(body.data.redirectTo).toBe('/schedule');
  });

  it('still sends an account with no teacher profile to the profile form', async () => {
    primeCredential('acc-student');
    accountFindUnique.mockResolvedValue({ teacher: null });
    storeChallenge('authentication', 'chal-student', 'expected-challenge');

    const res = await POST(verify('chal-student', '/signup/profile'));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { redirectTo: string } };
    // The second-hat flow: a student becoming a teacher too. This is what a
    // guard written as `redirect === TEACHER_PROFILE_PATH ? fallback : redirect`
    // would destroy while the case above still passed.
    expect(body.data.redirectTo).toBe('/signup/profile');
  });
});
```

Before finalizing, check `storeChallenge`'s real signature in `src/lib/auth/passkey.ts` (purpose, key, challenge) and confirm the two call sites above pass the key (`'chal-teacher'`/`'chal-student'`) as the same value used as `challengeId` in the request body, and confirm `getAndDeleteChallenge` (used internally by the route, unmocked) looks up by that same key. Adjust the calls if the drafted signature is wrong.

- [ ] **Step 2: Run the test and watch the first case fail**

Run: `pnpm exec vitest run --project unit src/app/api/auth/passkey/authenticate/verify/route.test.ts`

Expected: the first case FAILS — `expected '/signup/profile' to be '/schedule'`. The second case PASSES, pinning the direction that must not move.

- [ ] **Step 3: Implement**

In `src/app/api/auth/passkey/authenticate/verify/route.ts`, extend the schemas import:

```ts
import { passkeyAuthVerifySchema, TEACHER_PROFILE_PATH } from '@/lib/schemas';
```

Replace the destination block:

```ts
  const sessionToken = await createSession(prisma, credential.accountId);
  const account = await prisma.account.findUnique({
    where: { id: credential.accountId },
    select: { teacher: { select: { deletedAt: true } } },
  });
  const hasTeacherProfile = account?.teacher != null && !account.teacher.deletedAt;
  const fallback = hasTeacherProfile ? '/schedule' : '/bookings';
  // Prefer the caller's destination (booking flow) — schema-validated to a
  // relative path — over the role default; dual-role accounts default to
  // the teacher home. One destination is refused rather than honoured
  // (#439, the guard `magic-link/verify` got in #431): the teacher profile
  // form, for an account that already has a live teacher profile. That
  // page's own first line would bounce such a browser to `/schedule`
  // anyway. Scoped to `hasTeacherProfile`, not to the destination alone —
  // a student-only account's second-hat flow still reaches this path.
  const bouncedTeacherForm = body.redirect === TEACHER_PROFILE_PATH && hasTeacherProfile;
  const redirectTo = body.redirect && !bouncedTeacherForm ? body.redirect : fallback;
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm exec vitest run --project unit src/app/api/auth/passkey/authenticate/verify/route.test.ts`

Expected: PASS, 2 cases.

Then run the whole existing passkey integration file, since `parseBody`/schema behaviour on this route is covered there and must not regress:

Run: `pnpm exec vitest run --project integration tests/integration/passkey-api.test.ts` (needs this worktree's dev server live — `pnpm run worktree:up` if not already).

Expected: all green (3 pre-existing cases).

- [ ] **Step 5: Prove both directions bite**

*Mutation A — the guard is what redirects the teacher.* Change `bouncedTeacherForm` to `const bouncedTeacherForm = false;`. Run the two new cases. Expected: the teacher case fails, `expected '/signup/profile' to be '/schedule'`. Record the exact message. Restore, re-run green.

*Mutation B — the direction a one-sided guard destroys.* Replace the condition with `const bouncedTeacherForm = body.redirect === TEACHER_PROFILE_PATH;` — dropping the `hasTeacherProfile` half. Run the two new cases. Expected: the teacher case still PASSES and the student case FAILS, `expected '/bookings' to be '/signup/profile'`. Record both halves — a mutation only half the suite notices is the whole reason the second case exists. Restore, re-run green.

- [ ] **Step 6: Sweep for what this invalidated**

```bash
grep -rn "mirroring magic-link verify\|passkey/authenticate/verify" src docs --include='*.ts' --include='*.tsx' --include='*.md'
```

Confirm no other file repeats the now-fixed stale claim, and give every hit a verdict.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/auth/passkey/authenticate/verify/route.ts src/app/api/auth/passkey/authenticate/verify/route.test.ts
git commit -m "fix(auth): passkey verify actually mirrors magic-link's teacher-bounce guard"
```

---

## Closing out

- [ ] **Whole-branch review skipped by design.** Single task, one file plus its test — per the solve-issue skill, a single-task plan's "whole branch" is that task's diff, already reviewed at the task level. Do the task-level review (spec compliance + quality) with the same rigor a whole-branch pass would get, given this touches auth.

- [ ] **`pnpm run verify` before pushing.** Needs the app live on this worktree's port. Report the pass/fail with the arithmetic (unit + components + integration project counts), per the solve-issue skill's "the word green is load-bearing" rule.
