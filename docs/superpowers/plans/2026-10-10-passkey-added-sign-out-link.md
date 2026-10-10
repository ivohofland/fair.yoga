# Passkey-added "This wasn't me" button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The email sent when a passkey is added carries a **This wasn't me** button that signs the account out everywhere, deletes its pending sign-in links and removes that one passkey.

**Architecture:** A new account-keyed `PasskeyRevokeToken` (hash only, no foreign keys) is minted when the notice is delivered. A public page reads the token from the URL fragment and posts it on a button press to `POST /api/passkey-revoke`, which calls `revokePasskeyByLink`: one transaction that takes the account's teacher lock first (if any), consumes the token, removes the passkey through the same locked removal `deletePasskey` uses (so the two cannot drift), then signs out and deletes sign-in links.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (unit, components, integration), Zod.

**Spec:** `docs/superpowers/specs/2026-10-10-passkey-added-sign-out-link-design.md`

## Global Constraints

- TypeScript `strict: true`, no `any`. Test first on every task: see it fail, then implement.
- Services take typed inputs and return typed outputs; no HTTP or framework imports in `src/services/`.
- Work that must not be awaited returns `FireAndForget`, not `Promise<void>`.
- Every refusal from `respondError` names a code registered in `src/lib/api-error-codes.ts`; tests assert the code, not the message. New code: `REVOKE_LINK_INVALID`, status `404`.
- A transaction's first lock is the account's live `Teacher` row, when it has one (`docs/lock-order.md`, "The `Teacher` row is the first lock"), taken with `lockTeacherForNoKeyUpdate`. The token is consumed after that lock, never before.
- The token rides in the URL fragment as `#t=<raw>` and is sent only by a button press (POST body). Stored as `hashToken(raw)`; the raw value exists only in the returned string and the email.
- Token lifetime 14 days. Rate limit 20 per 15 minutes per IP, prefix `passkey-revoke`.
- The response is `{ revoked: true }` whether the passkey was removed, already gone, or kept by a pause. A link that cannot act answers `404 REVOKE_LINK_INVALID`; a second click is `invalid`.
- The removal writes a `RemovedPasskey` row exactly as `deletePasskey` does, and is skipped (sign-out still happens) while the account's teacher has payments paused.
- Comments state what is true now; no counts or rosters in prose (CLAUDE.md, *Comment Discipline*). Prose about a migration goes in `docs/`; never edit an applied migration.
- Stage exact paths; quote paths with parentheses (`"src/app/(public)/passkey-revoke/page.tsx"`). Post nothing to GitHub from `--body "..."`; use `--body-file`.

## Review Focus

Failure modes the spec implies that a person could hit, most likely first. Each has a test in the task that owns the code.

1. **A paused teacher clicks the link.** Signed out everywhere, passkey kept, `{ revoked: true }`. (Task 3.)
2. **The passkey is already gone** (removed in Settings before the click). Still signs out, still `{ revoked: true }`. (Task 3.)
3. **A mail scanner opens the link** (GET, page load). Nothing is sent, nothing is removed. (Task 5.)
4. **The token mint fails** when the passkey is added. The email still goes out, without the button, and the remedy words stay. (Task 6.)
5. **A student account** (no teacher row) clicks it. Works, takes no teacher lock. (Task 3.)

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` + new migration | `PasskeyRevokeToken` |
| `src/services/passkey-revoke-token.ts` (new) | `mintPasskeyRevokeToken`, `PASSKEY_REVOKE_TOKEN_TTL_DAYS` |
| `src/services/passkey-credentials.ts` | extract `lockForPasskeyRemoval` and `removePasskeyLocked`; `deletePasskey` uses them |
| `src/services/passkey-revoke.ts` (new) | `revokePasskeyByLink` |
| `src/services/passkey-notice.ts` | `deliverPasskeyAddedNotice` mints the token |
| `src/services/auth-cleanup.ts`, `gdpr.ts` | reap expired tokens; erasure deletes them |
| `src/lib/email-templates.ts`, `email.ts` | the optional button |
| `src/lib/schemas.ts`, `rate-limit.ts`, `api-error-codes.ts` | schema, prefix, code, reserved slug |
| `src/app/api/passkey-revoke/route.ts` (new) | the redemption route |
| `src/app/(public)/passkey-revoke/` (new) | page and form |
| `docs/` | data model, lock order, architecture, route census |

Task order is load-bearing: 1 (table) → 2 (shared removal) → 3 (service) → 4 (route) → 5 (page) → 6 (email, which mints and links to the page) → 7 (sweep and verify).

## Environment, once

A fresh worktree needs, in order: `pnpm install --frozen-lockfile`, `pnpm run worktree:setup`, then `pnpm run worktree:up` before any `--project integration` run. `pnpm run worktree:down` when finished. Never touch a dev server on `:3000`.

---

### Task 1: The token table, its mint, its cleanup and its erasure

**Files:**
- Modify: `prisma/schema.prisma` (after `PayoutPauseToken`)
- Create: `prisma/migrations/<timestamp>_passkey_revoke_token/migration.sql` (generated)
- Create: `src/services/passkey-revoke-token.ts`
- Create: `src/services/passkey-revoke-token.test.ts`
- Modify: `src/services/auth-cleanup.ts`, `src/services/auth-cleanup.test.ts`
- Modify: `src/services/gdpr.ts` (two sites), `src/services/gdpr.test.ts`

**Interfaces:**
- Produces: `PASSKEY_REVOKE_TOKEN_TTL_DAYS = 14`; `mintPasskeyRevokeToken(db: PrismaClient, input: { accountId: string; credentialId: string }): Promise<string>` (the raw token); model `PasskeyRevokeToken` with `tokenHash`, `accountId`, `credentialId`, `expiresAt`, `createdAt`; `cleanupExpiredAuth` result gains `passkeyRevokeTokens: number`.

- [ ] **Step 1: Write the failing mint test**

`src/services/passkey-revoke-token.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { mintPasskeyRevokeToken, PASSKEY_REVOKE_TOKEN_TTL_DAYS } from './passkey-revoke-token';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('mintPasskeyRevokeToken', () => {
  it('returns a raw secret and stores only its hash, scoped to the account and credential', async () => {
    const account = await prisma.account.create({
      data: { email: `revoke-mint-${uniqueSuffix()}@test.local` },
      select: { id: true },
    });
    accountIds.push(account.id);

    const before = Date.now();
    const raw = await mintPasskeyRevokeToken(prisma, { accountId: account.id, credentialId: 'cred-1' });

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    const row = await prisma.passkeyRevokeToken.findUniqueOrThrow({ where: { tokenHash: hashToken(raw) } });
    expect(row).toMatchObject({ accountId: account.id, credentialId: 'cred-1' });
    expect(JSON.stringify(row)).not.toContain(raw);
    const ttlMs = PASSKEY_REVOKE_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + ttlMs);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run src/services/passkey-revoke-token.test.ts`
Expected: FAIL, cannot resolve `./passkey-revoke-token` (and `prisma.passkeyRevokeToken` undefined).

- [ ] **Step 3: Add the model and migration**

Append to `prisma/schema.prisma` after `PayoutPauseToken`:

```prisma
/// The hash of the secret in a passkey-added email's "This wasn't me" link.
/// Keyed by account, not teacher: the email goes to students too. No foreign
/// keys: `PasskeyCredential` has no relation to `Account`, and the credential
/// may be gone by the time the link is used.
model PasskeyRevokeToken {
  id           String   @id @default(uuid())
  tokenHash    String   @unique
  accountId    String
  credentialId String
  expiresAt    DateTime
  createdAt    DateTime @default(now())

  @@index([accountId])
}
```

Run: `pnpm exec prisma migrate dev --name passkey_revoke_token`
Expected: a new migration directory; open its `migration.sql` and confirm it holds only a `CREATE TABLE "PasskeyRevokeToken"`, a unique index on `tokenHash` and an index on `accountId`, and **no** `ADD CONSTRAINT ... FOREIGN KEY`.

- [ ] **Step 4: Write the mint**

`src/services/passkey-revoke-token.ts`:

```ts
import crypto from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';

/** How long a passkey-added email's "This wasn't me" link works. */
export const PASSKEY_REVOKE_TOKEN_TTL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mints the secret behind one passkey-added email's "This wasn't me" link and
 * returns it raw. Only its SHA-256 is stored, so a database read cannot be
 * turned into a link; the raw value is never persisted, only its hash is
 * stored. `revokePasskeyByLink` looks it up by `hashToken(raw)`.
 */
export async function mintPasskeyRevokeToken(
  db: PrismaClient,
  input: { accountId: string; credentialId: string },
): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  await db.passkeyRevokeToken.create({
    data: {
      tokenHash: hashToken(raw),
      accountId: input.accountId,
      credentialId: input.credentialId,
      expiresAt: new Date(Date.now() + PASSKEY_REVOKE_TOKEN_TTL_DAYS * DAY_MS),
    },
  });
  return raw;
}
```

- [ ] **Step 5: Run the mint test, expect PASS**

Run: `pnpm exec vitest run src/services/passkey-revoke-token.test.ts`

- [ ] **Step 6: Failing cleanup assertions**

In `src/services/auth-cleanup.test.ts`, beside `livePauseHash`/`deadPauseHash` add:

```ts
const liveRevokeHash = crypto.randomBytes(32).toString('hex');
const deadRevokeHash = crypto.randomBytes(32).toString('hex');
```

In `beforeAll`, after the `payoutPauseToken.createMany`:

```ts
    await prisma.passkeyRevokeToken.createMany({
      data: [
        { tokenHash: liveRevokeHash, accountId: teacherAccountId, credentialId: 'c-live', expiresAt: new Date(now.getTime() + 86400000) },
        { tokenHash: deadRevokeHash, accountId: teacherAccountId, credentialId: 'c-dead', expiresAt: new Date(now.getTime() - 1000) },
      ],
    });
```

In the `scopeSweep` map add `PasskeyRevokeToken: { tokenHash: { in: [liveRevokeHash, deadRevokeHash] } },`; after `expect(result.payoutPauseTokens).toBe(1);` add:

```ts
    expect(result.passkeyRevokeTokens).toBe(1);
    expect(await prisma.passkeyRevokeToken.findUnique({ where: { tokenHash: liveRevokeHash } })).not.toBeNull();
    expect(await prisma.passkeyRevokeToken.findUnique({ where: { tokenHash: deadRevokeHash } })).toBeNull();
```

Also delete both hashes in that file's `afterAll` the way the pause hashes are removed (follow the existing `payoutPauseToken.deleteMany` line there).

Run: `pnpm exec vitest run src/services/auth-cleanup.test.ts`
Expected: FAIL (`passkeyRevokeTokens` is `undefined`).

- [ ] **Step 7: Implement the cleanup**

In `src/services/auth-cleanup.ts` add `passkeyRevokeTokens: number;` to the return type, a fifth `Promise.all` entry
`db.passkeyRevokeToken.deleteMany({ where: { expiresAt: { lt: now } } })` named `revokeTokens`, and `passkeyRevokeTokens: revokeTokens.count` in the result. Re-run the cleanup test: PASS.

- [ ] **Step 8: Failing erasure assertions**

In `src/services/gdpr.test.ts`, in the describe block whose `beforeAll` seeds `removedPasskey` for `accountId` and `soloAccountId` (search `removedPasskey.createMany`), add after it:

```ts
    await prisma.passkeyRevokeToken.createMany({
      data: [accountId, soloAccountId].map((id) => ({
        tokenHash: `erasure-revoke-${id}`, accountId: id, credentialId: 'c', expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
```

Add the matching `prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: [accountId, soloAccountId] } } })` to that block's `afterAll`. In its three tests, beside the `removedPasskey` assertions: the first (living teacher profile still uses the account) expects `await prisma.passkeyRevokeToken.count({ where: { accountId } })` to be `1`; the solo test expects `count({ where: { accountId: soloAccountId } })` to be `0`; the composed-order test expects `count({ where: { accountId } })` to be `0`.

Run: `pnpm exec vitest run src/services/gdpr.test.ts -t "removedPasskey|composed route order|solo"` (use the describe's own name if the filter misses).
Expected: FAIL on the solo and composed assertions (tokens still present).

- [ ] **Step 9: Implement the erasure**

In `src/services/gdpr.ts`, at both places that run `tx.removedPasskey.deleteMany({ where: { accountId: ... } })` (student half near line 815, teacher half near line 1574), add on the next line the same `accountId` with `tx.passkeyRevokeToken.deleteMany(...)`. Re-run the gdpr tests: PASS.

- [ ] **Step 10: Verify and commit**

Run: `pnpm exec prisma validate && pnpm exec tsc --noEmit`
Expected: both clean.

```bash
git add prisma/schema.prisma prisma/migrations src/services/passkey-revoke-token.ts src/services/passkey-revoke-token.test.ts src/services/auth-cleanup.ts src/services/auth-cleanup.test.ts src/services/gdpr.ts src/services/gdpr.test.ts
git commit -m "feat: PasskeyRevokeToken, its mint, its cleanup and its erasure"
```

---

### Task 2: One locked removal, shared by the Settings route and the link

**Files:**
- Modify: `src/services/passkey-credentials.ts`
- Modify: `src/services/passkey-credentials.test.ts`
- Modify: `src/lib/db-locks.ts` (the brand register in `TransactionClientOnly`'s docblock)

**Interfaces:**
- Consumes: `lockTeacherForNoKeyUpdate`, `TransactionClientOnly` (`src/lib/db-locks.ts`).
- Produces:
  - `lockForPasskeyRemoval(tx: TransactionClientOnly, accountId: string): Promise<{ paused: boolean }>`: takes the account's live teacher row's lock first, when there is one, and reports `paymentsPausedAt !== null` read under it.
  - `removePasskeyLocked(tx: TransactionClientOnly, input: { accountId: string; credentialId: string }): Promise<{ status: 'deleted'; removedAt: Date } | { status: 'not_found' }>`: the credential read, delete and `RemovedPasskey` insert; the caller holds the lock.
  - `deletePasskey` keeps its signature and `DeletePasskeyOutcome`.

This is a refactor: the existing `deletePasskey` tests and `passkey-credentials-lock-order.test.ts` are the regression net. Add one test for the new seam.

- [ ] **Step 1: Write the failing test for the new seam**

Append to `src/services/passkey-credentials.test.ts` (reusing its `makeAccount`, `passkey`, `prisma`):

```ts
import { lockForPasskeyRemoval, removePasskeyLocked } from './passkey-credentials';

describe('lockForPasskeyRemoval and removePasskeyLocked', () => {
  it('report paused under the lock and leave a paused account untouched until the caller decides', async () => {
    const accountId = await makeAccount({ pausedAt: new Date() });
    const id = await passkey(accountId, new Date('2026-01-02T03:04:05Z'));

    const paused = await prisma.$transaction(async (tx) => (await lockForPasskeyRemoval(tx, accountId)).paused);

    expect(paused).toBe(true);
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(1);
  });

  it('reports not paused for an account with no teacher profile, and removes with a record', async () => {
    const account = await prisma.account.create({ data: { email: `pk-lock-${uniqueSuffix()}@test.local` }, select: { id: true } });
    accountIds.push(account.id);
    const id = await passkey(account.id, new Date('2026-01-02T03:04:05Z'));

    const out = await prisma.$transaction(async (tx) => {
      expect((await lockForPasskeyRemoval(tx, account.id)).paused).toBe(false);
      return removePasskeyLocked(tx, { accountId: account.id, credentialId: id });
    });

    expect(out.status).toBe('deleted');
    expect(await prisma.removedPasskey.count({ where: { accountId: account.id } })).toBe(1);
  });

  it('answers not_found for a credential of another account', async () => {
    const mine = await makeAccount();
    const theirs = await makeAccount();
    const id = await passkey(theirs, new Date('2026-01-02T03:04:05Z'));

    const out = await prisma.$transaction((tx) => removePasskeyLocked(tx, { accountId: mine, credentialId: id }));

    expect(out).toEqual({ status: 'not_found' });
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(1);
  });
});
```

(Move the new import to the file's import block.)

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm exec vitest run src/services/passkey-credentials.test.ts`
Expected: FAIL, the two functions are not exported.

- [ ] **Step 3: Extract**

In `src/services/passkey-credentials.ts` add `import type { TransactionClientOnly } from '@/lib/db-locks';` (extend the existing `db-locks` import) and replace `deletePasskey` and add the two helpers:

```ts
/**
 * The account's live teacher row's lock, taken first (`docs/lock-order.md`,
 * "The `Teacher` row is the first lock"), and whether that teacher has
 * payments paused, read under it. An account with no live teacher profile is
 * never paused and takes no teacher lock.
 */
export async function lockForPasskeyRemoval(
  tx: TransactionClientOnly,
  accountId: string,
): Promise<{ paused: boolean }> {
  const teacher = await tx.teacher.findFirst({ where: { accountId, deletedAt: null }, select: { id: true } });
  if (teacher === null || (await lockTeacherForNoKeyUpdate(tx, teacher.id)) === null) return { paused: false };
  const { paymentsPausedAt } = await tx.teacher.findUniqueOrThrow({
    where: { id: teacher.id },
    select: { paymentsPausedAt: true },
  });
  return { paused: paymentsPausedAt !== null };
}

/**
 * Delete one of the account's passkeys and record the removal as a
 * `RemovedPasskey`, so the passkey is never neither standing nor recorded as
 * removed. The filter carries `accountId`: another account's credential is
 * indistinguishable from one that does not exist. The caller holds the lock
 * `lockForPasskeyRemoval` takes and has refused a paused account.
 */
export async function removePasskeyLocked(
  tx: TransactionClientOnly,
  input: { accountId: string; credentialId: string },
): Promise<{ status: 'deleted'; removedAt: Date } | { status: 'not_found' }> {
  const owned = { id: input.credentialId, accountId: input.accountId };
  const credential = await tx.passkeyCredential.findFirst({ where: owned, select: { createdAt: true } });
  if (credential === null) return { status: 'not_found' };
  const { count } = await tx.passkeyCredential.deleteMany({ where: owned });
  if (count === 0) return { status: 'not_found' };
  const removal = await tx.removedPasskey.create({
    data: { accountId: input.accountId, credentialCreatedAt: credential.createdAt },
    select: { removedAt: true },
  });
  return { status: 'deleted', removedAt: removal.removedAt };
}

export async function deletePasskey(
  db: PrismaClient,
  input: { accountId: string; credentialId: string },
): Promise<DeletePasskeyOutcome> {
  return db.$transaction(async (tx): Promise<DeletePasskeyOutcome> => {
    const { paused } = await lockForPasskeyRemoval(tx, input.accountId);
    if (paused) {
      const owned = { id: input.credentialId, accountId: input.accountId };
      return (await tx.passkeyCredential.count({ where: owned })) > 0
        ? { status: 'payments_paused' }
        : { status: 'not_found' };
    }
    return removePasskeyLocked(tx, input);
  });
}
```

Keep `deletePasskey`'s existing docblock above it, edited so it names `lockForPasskeyRemoval` and `removePasskeyLocked` as the two steps instead of restating their bodies.

- [ ] **Step 4: Run the whole passkey removal surface, expect PASS**

Run: `pnpm exec vitest run --project integration src/services/passkey-credentials.test.ts src/services/passkey-credentials-lock-order.test.ts tests/integration/passkey-credentials-api.test.ts`
Expected: PASS, including every pre-existing case.

- [ ] **Step 5: Record the brand decision**

In the `TransactionClientOnly` docblock register in `src/lib/db-locks.ts`, add an `adopt` line for `lockForPasskeyRemoval` (issues `SET LOCAL` and a row lock through `lockTeacherForNoKeyUpdate`) and one for `removePasskeyLocked` (a write that trusts its caller's lock, the reason `closeQueueOnStart` is branded). Run `pnpm exec vitest run src/lib/db-locks.test.ts`: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/passkey-credentials.ts src/services/passkey-credentials.test.ts src/lib/db-locks.ts
git commit -m "refactor: passkey removal's lock and write are two shared steps"
```

---

### Task 3: `revokePasskeyByLink`

**Files:**
- Create: `src/services/passkey-revoke.ts`
- Create: `src/services/passkey-revoke.test.ts`
- Create: `src/services/passkey-revoke-lock-order.test.ts`
- Modify: `docs/lock-order.md` (new entry after the passkey removal's)

**Interfaces:**
- Consumes: `hashToken` (`@/lib/auth/magic-link`), `signOutEverywhereTx` (`@/services/account-sign-out`), `lockForPasskeyRemoval`, `removePasskeyLocked` (Task 2), model `PasskeyRevokeToken` (Task 1).
- Produces:

```ts
export type RevokeOutcome =
  | { status: 'revoked'; removal: { accountId: string; removedAt: Date } | null }
  | { status: 'invalid' };
export async function revokePasskeyByLink(db: PrismaClient, rawToken: string, now?: Date): Promise<RevokeOutcome>;
```

`removal` is non-null only when a `RemovedPasskey` row was written; the route sends the removed notice from it.

- [ ] **Step 1: Write the failing service tests**

`src/services/passkey-revoke.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { mintPasskeyRevokeToken } from './passkey-revoke-token';
import { revokePasskeyByLink } from './passkey-revoke';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const accountIds: string[] = [];
const teacherIds: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture { accountId: string; email: string }

async function makeAccount(opts: { teacher?: boolean; pausedAt?: Date } = {}): Promise<Fixture> {
  const s = uniqueSuffix();
  const email = `revoke-${s}@test.local`;
  if (opts.teacher === true) {
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Re', lastName: 'Voke', email, bio: '', pageSlug: `revoke-${s}`,
        account: { create: { email } }, paymentsPausedAt: opts.pausedAt ?? null,
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(t.id);
    accountIds.push(t.accountId);
    return { accountId: t.accountId, email };
  }
  const a = await prisma.account.create({ data: { email }, select: { id: true } });
  accountIds.push(a.id);
  return { accountId: a.id, email };
}

async function passkey(accountId: string, createdAt = new Date('2026-01-02T03:04:05Z')): Promise<string> {
  const id = `revoke-pk-${uniqueSuffix()}`;
  await prisma.passkeyCredential.create({
    data: { id, accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt },
  });
  return id;
}

async function session(accountId: string): Promise<string> {
  const id = crypto.randomBytes(16).toString('hex');
  await prisma.session.create({ data: { id, accountId, expiresAt: new Date(Date.now() + DAY_MS) } });
  return id;
}

async function signInLink(email: string): Promise<string> {
  const tokenHash = crypto.randomBytes(16).toString('hex');
  await prisma.magicLinkToken.create({ data: { tokenHash, email, expiresAt: new Date(Date.now() + DAY_MS) } });
  return tokenHash;
}

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.magicLinkToken.deleteMany({ where: { email: { startsWith: 'revoke-' } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('revokePasskeyByLink', () => {
  it('signs out, deletes sign-in links, removes the passkey and records the removal', async () => {
    const { accountId, email } = await makeAccount({ teacher: true });
    const credentialId = await passkey(accountId);
    const sessionId = await session(accountId);
    const linkHash = await signInLink(email);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out.status).toBe('revoked');
    if (out.status !== 'revoked') return;
    expect(out.removal?.accountId).toBe(accountId);
    expect(await prisma.session.count({ where: { id: sessionId } })).toBe(0);
    expect(await prisma.magicLinkToken.count({ where: { tokenHash: linkHash } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(0);
    expect(await prisma.removedPasskey.count({ where: { accountId } })).toBe(1);
  });

  it('works for an account with no teacher profile', async () => {
    const { accountId } = await makeAccount();
    const credentialId = await passkey(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out.status).toBe('revoked');
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(0);
  });

  it('answers invalid for a second use, an expired token and an unknown one', async () => {
    const { accountId } = await makeAccount();
    const credentialId = await passkey(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });
    await revokePasskeyByLink(prisma, raw);

    expect(await revokePasskeyByLink(prisma, raw)).toEqual({ status: 'invalid' });
    expect(await revokePasskeyByLink(prisma, 'f'.repeat(64))).toEqual({ status: 'invalid' });

    const second = await makeAccount();
    const credential2 = await passkey(second.accountId);
    const expired = await mintPasskeyRevokeToken(prisma, { accountId: second.accountId, credentialId: credential2 });
    expect(await revokePasskeyByLink(prisma, expired, new Date(Date.now() + 15 * DAY_MS))).toEqual({ status: 'invalid' });
    expect(await prisma.passkeyCredential.count({ where: { id: credential2 } })).toBe(1);
  });

  it('still signs out when the passkey is already gone, and records nothing', async () => {
    const { accountId } = await makeAccount();
    const credentialId = await passkey(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });
    await prisma.passkeyCredential.deleteMany({ where: { id: credentialId } });
    const sessionId = await session(accountId);

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out).toEqual({ status: 'revoked', removal: null });
    expect(await prisma.session.count({ where: { id: sessionId } })).toBe(0);
    expect(await prisma.removedPasskey.count({ where: { accountId } })).toBe(0);
  });

  it('while payments are paused: signs out, keeps the passkey, records nothing', async () => {
    const { accountId } = await makeAccount({ teacher: true, pausedAt: new Date() });
    const credentialId = await passkey(accountId);
    const sessionId = await session(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out).toEqual({ status: 'revoked', removal: null });
    expect(await prisma.session.count({ where: { id: sessionId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(1);
    expect(await prisma.removedPasskey.count({ where: { accountId } })).toBe(0);
  });

  it('cannot remove a credential of another account, even from a forged token row', async () => {
    const mine = await makeAccount();
    const theirs = await makeAccount();
    const theirCredential = await passkey(theirs.accountId);
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.passkeyRevokeToken.create({
      data: { tokenHash: hashToken(raw), accountId: mine.accountId, credentialId: theirCredential, expiresAt: new Date(Date.now() + DAY_MS) },
    });

    await revokePasskeyByLink(prisma, raw);

    expect(await prisma.passkeyCredential.count({ where: { id: theirCredential } })).toBe(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm exec vitest run src/services/passkey-revoke.test.ts`
Expected: FAIL, cannot resolve `./passkey-revoke`.

- [ ] **Step 3: Implement**

`src/services/passkey-revoke.ts`:

```ts
import type { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { signOutEverywhereTx } from '@/services/account-sign-out';
import { lockForPasskeyRemoval, removePasskeyLocked } from '@/services/passkey-credentials';

/**
 * `revoked` carries the removal when one was written, so the caller can send
 * the removed notice once the transaction has committed; null when the passkey
 * was already gone or a pause kept it. `invalid` is the one answer for an
 * unknown, used or expired link.
 */
export type RevokeOutcome =
  | { status: 'revoked'; removal: { accountId: string; removedAt: Date } | null }
  | { status: 'invalid' };

/**
 * Redeems a passkey-added email's "This wasn't me" link: signs the account out
 * everywhere, deletes its pending sign-in links and removes the one passkey
 * the email is about, in one transaction
 * (`docs/superpowers/specs/2026-10-10-passkey-added-sign-out-link-design.md`).
 *
 * The account's live teacher row is the first lock, as for `deletePasskey`
 * (`docs/lock-order.md`); the token is consumed under it, so a failure in any
 * later statement rolls the consume back and the link still works. The removal
 * is `removePasskeyLocked`, the step `deletePasskey` shares, so a removal by
 * link is recorded for the payout gate; a paused account keeps its passkey and
 * is still signed out. The passkey goes before the sessions: a passkey
 * sign-in that inserts a `Session` after the passkey's delete fails its foreign
 * key, and one that inserted before it is caught by the session delete that
 * follows. Sessions first would let a sign-in land between the two deletes and
 * survive, its `passkeyCredentialId` merely nulled.
 */
export async function revokePasskeyByLink(
  db: PrismaClient,
  rawToken: string,
  now: Date = new Date(),
): Promise<RevokeOutcome> {
  const tokenHash = hashToken(rawToken);
  return db.$transaction(async (tx): Promise<RevokeOutcome> => {
    const token = await tx.passkeyRevokeToken.findUnique({
      where: { tokenHash },
      select: { accountId: true, credentialId: true },
    });
    if (token === null) return { status: 'invalid' };

    const { paused } = await lockForPasskeyRemoval(tx, token.accountId);

    const consumed = await tx.passkeyRevokeToken.deleteMany({ where: { tokenHash, expiresAt: { gt: now } } });
    if (consumed.count === 0) return { status: 'invalid' };

    const account = await tx.account.findUniqueOrThrow({ where: { id: token.accountId }, select: { email: true } });
    const removed = paused ? null : await removePasskeyLocked(tx, token);
    await signOutEverywhereTx(tx, token.accountId);
    await tx.magicLinkToken.deleteMany({ where: { email: account.email } });

    return {
      status: 'revoked',
      removal: removed !== null && removed.status === 'deleted' ? { accountId: token.accountId, removedAt: removed.removedAt } : null,
    };
  });
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm exec vitest run src/services/passkey-revoke.test.ts`

- [ ] **Step 5: Prove each guard bites**

For each mutation: apply it, run `pnpm exec vitest run src/services/passkey-revoke.test.ts`, record the failing test name and message here in the PR notes, restore the line, re-run to green.

| Guard | Mutation | Must fail |
|---|---|---|
| `RemovedPasskey` is written | in `removePasskeyLocked`, comment out the `tx.removedPasskey.create` call and return `removedAt: new Date()` | `signs out, deletes sign-in links, removes the passkey and records the removal` (`removedPasskey.count` is 0, not 1); and `passkey-credentials.test.ts`'s first case |
| a pause skips the removal | in `revokePasskeyByLink`, make the removal unconditional (drop `paused ? null :`) | `while payments are paused: signs out, keeps the passkey, records nothing` |
| the credential filter carries `accountId` | in `removePasskeyLocked`, change `owned` to `{ id: input.credentialId }` | `cannot remove a credential of another account, even from a forged token row` |
| the token is consumed once | replace the `deleteMany` consume with a `count` read | `answers invalid for a second use…` |

The mutations touch `passkey-credentials.ts` and `passkey-revoke.ts`; use a value or edit the code cannot otherwise produce, never a change to a fixture.

- [ ] **Step 6: Lock-order test**

`src/services/passkey-revoke-lock-order.test.ts`, modelled on `payout-pause-lock-order.test.ts` (read its header, its `latch` helper and its second-connection pattern first, and carry its `@serial-tier lock-contention` header comment with this file's own reasoning). One case: a failure after the consume leaves the token usable. Hold one of the account's `Session` rows `FOR UPDATE` on a second connection so the passkey delete (whose `SET NULL` updates it) times out under the shared `lock_timeout` (`isLockTimeout` from `@/lib/api-errors`), assert `revokePasskeyByLink` rejects with that error, release the hold, and assert the same raw token now answers `revoked`.
Run: `pnpm exec vitest run src/services/passkey-revoke-lock-order.test.ts`. Expected: PASS. Then break it (move the consume's `deleteMany` outside the transaction onto `db`), expect the second assertion to FAIL (the token was spent), restore.

- [ ] **Step 7: Document the lock order**

In `docs/lock-order.md`, after the passkey removal's entry add one for the link: a plain read of the `PasskeyRevokeToken` row by hash; then `lockForPasskeyRemoval` (the teacher row first, when the account has a live teacher profile, `lockTeacherForNoKeyUpdate`); under it the token's `deleteMany`, a read of the `Account`, when not paused the `PasskeyCredential` delete (its `SET NULL` reaches `Session`) and the `RemovedPasskey` insert, then the `Session` and `PushSubscription` deletes and the `MagicLinkToken` delete (the passkey first, so a passkey sign-in cannot insert a surviving `Session` between the two deletes). Say why it cannot deadlock against a pause (both serialise on `Teacher` before touching a session or passkey) and name the test files that hold it. Cite `passkey-revoke-lock-order.test.ts`. Do not add a count; if a call-site list is needed, it is the existing `grep` that section already ships.

- [ ] **Step 8: Verify and commit**

Run: `pnpm exec tsc --noEmit && pnpm exec vitest run src/services/passkey-revoke.test.ts src/services/passkey-revoke-lock-order.test.ts src/services/passkey-credentials.test.ts`

```bash
git add src/services/passkey-revoke.ts src/services/passkey-revoke.test.ts src/services/passkey-revoke-lock-order.test.ts docs/lock-order.md
git commit -m "feat: revokePasskeyByLink signs out, clears sign-in links and removes the passkey"
```

---

### Task 4: `POST /api/passkey-revoke`

**Files:**
- Create: `src/app/api/passkey-revoke/route.ts`
- Create: `tests/integration/passkey-revoke-api.test.ts`
- Modify: `src/lib/schemas.ts` (add `passkeyRevokeSchema`)
- Modify: `src/lib/api-error-codes.ts` (add `REVOKE_LINK_INVALID: 404`, in its alphabetical place)
- Modify: `src/lib/rate-limit.ts` (prefix, capacity, `IpRateLimitPrefix`)

**Interfaces:**
- Consumes: `revokePasskeyByLink` (Task 3), `deliverPasskeyRemovedNotice` (`@/services/passkey-notice`).
- Produces: `POST /api/passkey-revoke` with body `{ token: string }` answering `200 { data: { revoked: true } }` or `404 REVOKE_LINK_INVALID`; `429` over the IP budget.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/passkey-revoke-api.test.ts`, following `payout-pause-api.test.ts` (same imports and helpers: `BASE_URL`, `uniqueSuffix`, `freshIp`, `expectApplied`, `expectRefusal`, `hashToken`; read that file for the exact assertion helper signatures before writing the assertions). Cases:

```ts
const revoke = (body: unknown, ip: Record<string, string> = freshIp()) =>
  fetch(`${BASE_URL}/api/passkey-revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ip },
    body: JSON.stringify(body),
  });
```

1. A minted token for an account with a session and a passkey: `200`, body `data.revoked === true`; the session and the passkey are gone; one `RemovedPasskey` exists.
2. The same token again: `404`, code `REVOKE_LINK_INVALID`.
3. An unknown token, an empty token (`400` from validation, assert the status the shared `parseBody` gives for that shape in `payout-pause-api.test.ts`) and a body with no `token`.
4. A paused teacher: `200 { revoked: true }`, session gone, passkey still there.
5. Rate limit: 21 requests from one `freshIp()` address, the 21st is `429`.
Fixture helpers (`makeAccount`, `passkey`, session via `seedSession` from `../helpers`) as in Task 3; clean up in `afterAll` like the pause API test.

- [ ] **Step 2: Run, expect FAIL**

Run (worktree app up): `pnpm exec vitest run --project integration tests/integration/passkey-revoke-api.test.ts`
Expected: FAIL (`404` from Next for the missing route, not `REVOKE_LINK_INVALID`).

- [ ] **Step 3: Implement**

`src/lib/schemas.ts`, beside `payoutPauseSchema`:

```ts
export const passkeyRevokeSchema = z.object({
  token: z.string().trim().min(1).max(256),
});
```

`src/lib/api-error-codes.ts`: add `REVOKE_LINK_INVALID: 404,` between `RECENT_AUTH_REQUIRED` and the next key alphabetically. `src/lib/rate-limit.ts`: add `| 'passkey-revoke'` to `RateLimitPrefix`, `'passkey-revoke': 1_000,` to `PREFIX_CAPACITIES`, and `| 'passkey-revoke'` to the `Extract` in `IpRateLimitPrefix`.

`src/app/api/passkey-revoke/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { respondTyped, respondError, parseBody, withErrorHandler } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { passkeyRevokeSchema } from '@/lib/schemas';
import { checkIpRateLimit, clientIp, respondRateLimited } from '@/lib/rate-limit';
import { revokePasskeyByLink } from '@/services/passkey-revoke';
import { deliverPasskeyRemovedNotice } from '@/services/passkey-notice';

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 20;

/**
 * Redeems a passkey-added email's "This wasn't me" link. Needs no session: the
 * link is the credential, and all it can do is sign the account out and remove
 * that one passkey.
 *
 * One answer whether the passkey was removed, was already gone or was kept by
 * a pause, and one refusal for every link that cannot act: an unauthenticated
 * caller learns nothing about the account from the answer. A removal emails the
 * account address once it has committed.
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const limit = checkIpRateLimit('passkey-revoke', clientIp(request), PER_IP_LIMIT, WINDOW_MS, 'passkey-revoke');
  if (!limit.allowed) return respondRateLimited(limit, 'Too many attempts.');

  const body = await parseBody(request, passkeyRevokeSchema);
  if ('error' in body) return body.error;

  const outcome = await revokePasskeyByLink(prisma, body.data.token);
  switch (outcome.status) {
    case 'revoked':
      if (outcome.removal !== null) deliverPasskeyRemovedNotice(prisma, outcome.removal);
      return respondTyped<{ revoked: true }>({ revoked: true });
    case 'invalid':
      return respondError(
        'This link no longer works. It may have been used already, or it has expired.',
        404,
        'REVOKE_LINK_INVALID',
      );
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled passkey revoke outcome: ${String((unhandled as { status?: unknown }).status)}`);
    }
  }
});
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm exec vitest run --project integration tests/integration/passkey-revoke-api.test.ts` and `pnpm exec vitest run src/lib/api-error-codes.test.ts src/lib/rate-limit.test.ts`
Expected: PASS. If the registry or rate-limit tests name a count or a roster, update the fixture they assert and note it for the PR body.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/passkey-revoke/route.ts tests/integration/passkey-revoke-api.test.ts src/lib/schemas.ts src/lib/api-error-codes.ts src/lib/rate-limit.ts
git commit -m "feat: POST /api/passkey-revoke redeems the passkey-added link"
```

---

### Task 5: The page

**Files:**
- Create: `src/app/(public)/passkey-revoke/page.tsx`
- Create: `src/app/(public)/passkey-revoke/passkey-revoke-form.tsx`
- Create: `src/app/(public)/passkey-revoke/passkey-revoke-form.test.tsx`
- Modify: `src/lib/schemas.ts` (`RESERVED_SLUGS` gains `'passkey-revoke'`), `src/lib/schemas.test.ts` (the `it.each` list)
- Modify: `src/lib/loading-coverage.test.ts` (`'(public)/passkey-revoke': 'none'`)

**Interfaces:**
- Consumes: `POST /api/passkey-revoke` (Task 4), `readError`, `logRequestFailure` (`@/lib/client-errors`), `Button` (`@/components/ui/button`).
- Produces: `PasskeyRevokeForm` component; the route `/passkey-revoke#t=<token>`.

Copy follows the spec's Decision 10 and keeps the register of the `/payout-pause` page: no exclamation marks, no urgency framing.

- [ ] **Step 1: Write the failing component tests**

`passkey-revoke-form.test.tsx`, modelled line for line on `payout-pause-form.test.tsx` (same `respond`, `stubFetch`, `settle` helpers). Cases:

```ts
const TOKEN = 'a'.repeat(64);

it('posts nothing on load, even with a token in the fragment', async () => {
  window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
  const fetchMock = stubFetch(() => respond(200, { data: { revoked: true } }));
  render(<PasskeyRevokeForm />);
  await settle();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: "This wasn't me" })).toBeEnabled();
});

it("posts the fragment's token on the button, confirms, and drops it from the address", async () => {
  window.history.replaceState(null, '', `/passkey-revoke#t=${TOKEN}`);
  const fetchMock = stubFetch(() => respond(200, { data: { revoked: true } }));
  render(<PasskeyRevokeForm />);
  await settle();
  fireEvent.click(screen.getByRole('button', { name: "This wasn't me" }));
  await settle();
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe('/api/passkey-revoke');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN });
  expect(screen.getByRole('status')).toHaveTextContent('signed out on every device');
  expect(window.location.hash).toBe('');
});
```

Plus: `REVOKE_LINK_INVALID` shows "This link no longer works"; a missing fragment shows "This link is incomplete" and no button; `429` shows the too-many-attempts line; a network failure shows the "couldn't confirm" line and a later `REVOKE_LINK_INVALID` reads "perhaps by your earlier attempt". Copy these state-by-state from `payout-pause-form.test.tsx`, replacing names, URL, code and the strings below.

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm exec vitest run --project components "src/app/(public)/passkey-revoke"`
Expected: FAIL, cannot resolve `./passkey-revoke-form`.

- [ ] **Step 3: Implement the form and page**

`passkey-revoke-form.tsx`: copy `payout-pause-form.tsx` and change: the type and function names (`PasskeyRevokeForm`), the fetch URL `/api/passkey-revoke`, the log tag `'passkey-revoke'`, the code compared `'REVOKE_LINK_INVALID'`, the button label `This wasn't me` (pending label `Signing you out…`), and the states' copy:

- done (`role="status"`): subtitle "You are signed out everywhere", body "Every device has been signed out. If the passkey is still listed under your passkeys, you can remove it there once you sign in. Anyone who can read your inbox can still ask for a new sign-in link, so check your email account too.", a `Sign in` link to `/login`.
- invalid / incomplete: the same two sentences as the pause form, the closing line "If you're worried about your account, sign in and check your passkeys."
- `unknown`: "We couldn't confirm that you were signed out. To check, press This wasn't me again: if it says this link no longer works, the link has been used."
- `failed`, `rejected`, `limited`: as the pause form with "paused" replaced by "signed out".

`page.tsx`:

```tsx
import { PasskeyRevokeForm } from './passkey-revoke-form';

/**
 * Where a passkey-added email's "This wasn't me" button lands. Public and the
 * same for everyone: the page names no account, and the token stays in the
 * fragment until the button sends it.
 */
export default function PasskeyRevokePage() {
  return (
    <div className="flex-1 flex flex-col py-10">
      <h1 className="type-display mb-5">Didn&rsquo;t add a passkey?</h1>
      <p className="type-body mb-4">If you didn&rsquo;t add it, this:</p>
      <ul className="type-body list-disc pl-5 mb-6 flex flex-col gap-1">
        <li>signs you out on every device,</li>
        <li>cancels any sign-in links already sent,</li>
        <li>removes the passkey that was added.</li>
      </ul>
      <p className="type-body mb-8">You can sign in again afterwards with a new link.</p>
      <PasskeyRevokeForm />
    </div>
  );
}
```

Add `'passkey-revoke'` to `RESERVED_SLUGS` and to the `it.each` list in `schemas.test.ts`; add `'(public)/passkey-revoke': 'none',` to `FALLBACK_ROUTES` in alphabetical place.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm exec vitest run --project components "src/app/(public)/passkey-revoke" && pnpm exec vitest run src/lib/schemas.test.ts src/lib/loading-coverage.test.ts`

- [ ] **Step 5: Commit**

```bash
git add "src/app/(public)/passkey-revoke" src/lib/schemas.ts src/lib/schemas.test.ts src/lib/loading-coverage.test.ts
git commit -m "feat: the passkey-revoke page posts only on a button press"
```

---

### Task 6: The email carries the button, and the notice mints it

**Files:**
- Modify: `src/lib/email-templates.ts` (`renderPasskeyAddedEmail`, `renderPasskeyRemovedEmail` docblock, `renderPayoutChangedEmail` docblock)
- Modify: `src/lib/email-templates.test.ts`
- Modify: `src/lib/email.ts` (`sendPasskeyAddedEmail`)
- Modify: `src/services/passkey-notice.ts`, `src/services/passkey-notice.test.ts`
- Modify: `src/app/api/auth/passkey/register/verify/route.ts`
- Modify: `docs/technical-architecture.md`, `docs/data-model.md`

**Interfaces:**
- Consumes: `mintPasskeyRevokeToken` (Task 1); the page `/passkey-revoke` (Task 5).
- Produces: `renderPasskeyAddedEmail(addedAt: Date, revokeUrl?: string | null): RenderedEmail`; `sendPasskeyAddedEmail(to: string, addedAt: Date, revokeUrl?: string | null): Promise<void>`; `deliverPasskeyAddedNotice(db, input: { accountId: string; addedAt: Date; credentialId: string }): FireAndForget`.

- [ ] **Step 1: Failing template tests**

In `src/lib/email-templates.test.ts`, replace the `'carries no link, so there is no token to forward or phish with'` case with:

```ts
    it('carries no link when no revoke url is given, so the remedy stays in words', () => {
      const { html } = renderPasskeyAddedEmail(addedAt);
      expect(html).not.toContain('<a ');
      expect(html).toContain('sign out everywhere');
    });

    it("carries one This wasn't me button to the given url, and keeps the remedy in words", () => {
      const url = 'https://fair.yoga/passkey-revoke#t=abc123';
      const { html } = renderPasskeyAddedEmail(addedAt, url);
      expect(html.match(/<a /g)?.length).toBe(1);
      expect(html).toContain(`href="${url}"`);
      expect(html).toContain("This wasn&#39;t me");
      expect(html).toContain('sign out everywhere');
      expect(html).toContain('check your email account');
    });

    it('escapes the url as an attribute', () => {
      const { html } = renderPasskeyAddedEmail(addedAt, 'https://x.test/p#t="><script>');
      expect(html).not.toContain('<script>');
    });
```

(Check how `wrapEmail` escapes an apostrophe in `payout`'s own button test and match that exact entity in the assertion.) Run `pnpm exec vitest run src/lib/email-templates.test.ts`: FAIL.

- [ ] **Step 2: Implement the template**

In `renderPasskeyAddedEmail` add the parameter and, after the existing remedy paragraph, when `revokeUrl` is a non-empty string:

```ts
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', lines: [`A passkey was added to your fair.yoga account on ${when} UTC. It can now sign in to your account.`] },
    {
      kind: 'paragraph',
      lines: ['If that was you, there is nothing to do. If it was not, sign in, find your passkeys under Settings → Profile if you teach (under Account if you are a student), remove the passkey and choose sign out everywhere.'],
    },
  ];
  if (revokeUrl) {
    blocks.push(
      {
        kind: 'paragraph',
        lines: ['Or do it now: this signs you out on every device, cancels any sign-in links already sent, and removes this passkey where it can. Anyone who can read this inbox can still ask for a new sign-in link, so check your email account too.'],
      },
      { kind: 'button', label: "This wasn't me", href: revokeUrl },
    );
  }
```

and pass `blocks` to `wrapEmail('A passkey was added', blocks, ACCOUNT_ACTIVITY_FOOTER)`. Replace the docblocks: `renderPasskeyAddedEmail`'s now says what is true (the remedy is named in words; a button to `revokeUrl` is added when the caller minted one, and its link carries no credential and signs no one in); `renderPasskeyRemovedEmail`'s reason becomes "No link: a removal is not undone by a button."; `renderPayoutChangedEmail`'s "Unlike `renderPasskeyAddedEmail`, this one carries a link, on purpose" paragraph is rewritten to cite the spec decision without the contrast (both now carry one). Update the `renders no link` removed-email test name only if its wording cited the added email. Run the template tests: PASS.

- [ ] **Step 3: Failing notice tests**

In `src/services/passkey-notice.test.ts`: extend the mocked `db` with `passkeyRevokeToken: { create }` (`const create = vi.fn<(args: unknown) => Promise<unknown>>()`, reset in `beforeEach`, default `mockResolvedValue({})`), extend `input` with `credentialId: 'cred-1'`, and add:

```ts
  it('mints a link for the credential and sends it with the notice', async () => {
    sendPasskeyAddedEmail.mockResolvedValue(undefined);

    deliverPasskeyAddedNotice(db, input);

    await vi.waitFor(() => expect(sendPasskeyAddedEmail).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ accountId: 'acct-1', credentialId: 'cred-1' }),
    });
    expect(sendPasskeyAddedEmail).toHaveBeenCalledWith(
      'a@test.local',
      input.addedAt,
      expect.stringMatching(/\/passkey-revoke#t=[0-9a-f]{64}$/),
    );
  });

  it('still sends the notice, without a link, when the mint fails, and logs it', async () => {
    create.mockRejectedValue(new Error('db down'));
    sendPasskeyAddedEmail.mockResolvedValue(undefined);

    deliverPasskeyAddedNotice(db, input);

    await vi.waitFor(() => expect(sendPasskeyAddedEmail).toHaveBeenCalledWith('a@test.local', input.addedAt, null));
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-1' }), expect.stringContaining('revoke link'));
  });
```

Update the existing `'sends the notice to the account address'` assertion to `toHaveBeenCalledWith('a@test.local', input.addedAt, expect.any(String))`. Run `pnpm exec vitest run src/services/passkey-notice.test.ts`: FAIL.

- [ ] **Step 4: Implement the notice, the sender and the route**

`src/lib/email.ts`:

```ts
export async function sendPasskeyAddedEmail(to: string, addedAt: Date, revokeUrl: string | null = null): Promise<void> {
  const result = await sendEmail({ to, audience: 'platform', content: renderPasskeyAddedEmail(addedAt, revokeUrl) });
  if (!result.ok) throw new Error(`Failed to send passkey-added email: ${result.reason}`);
}
```

`passkey-notice.ts`: import `mintPasskeyRevokeToken`; the input gains `credentialId: string`; inside the IIFE after the account lookup:

```ts
    let revokeUrl: string | null = null;
    try {
      const raw = await mintPasskeyRevokeToken(db, { accountId: input.accountId, credentialId: input.credentialId });
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      revokeUrl = `${baseUrl}/passkey-revoke#t=${raw}`;
    } catch (err) {
      // The notice is the signal and the button its convenience: a failed mint
      // sends the notice with its remedy in words.
      log.error({ err, accountId: input.accountId }, 'passkey-added notice sent without its revoke link');
    }
    await sendPasskeyAddedEmail(account.email, input.addedAt, revokeUrl);
```

Update the function's docblock to say the mint is inside the body for the same reason as the send. In `register/verify/route.ts` pass `credentialId: result.credentialId` to `deliverPasskeyAddedNotice`. Run the notice, template and `email.test.ts` tests, and `pnpm exec tsc --noEmit`: PASS. If `tsc` finds another caller of `deliverPasskeyAddedNotice` or `sendPasskeyAddedEmail`, give it the new argument.

- [ ] **Step 5: Docs, replaced not annotated**

- `docs/technical-architecture.md`, the passage ending "A successful registration emails the account address (`deliverPasskeyAddedNotice`…": add that the email carries a **This wasn't me** button to `/passkey-revoke` and what redeeming does (`revokePasskeyByLink`: sign out everywhere, delete sign-in links, remove the one passkey with a `RemovedPasskey` record, keep it while paused), and that a failed mint sends the email without it. Update the "passkey-added email … is the signal" sentence to say the button acts on it: before a pause it removes that passkey, during one it signs out and keeps it. In "Unauthenticated API routes" re-run that section's own two commands and update the counts it states with the arithmetic (78 routes + 1; no-session-guard + 1; rate-limited + 1; the unprotected remainder is unchanged), and add `passkey-revoke` to its list of rate-limited routes and to the rate-limiting paragraph beside `payout-pause`.
- `docs/data-model.md`: a paragraph after `PayoutPauseToken`'s: `PasskeyRevokeToken` holds the hash of the secret in the passkey-added email's link: `token_hash` (unique), `account_id`, `credential_id` (neither a foreign key, and why), `expires_at`, `created_at`; erasure deletes the account's rows and `cleanupExpiredAuth` the expired ones.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email-templates.ts src/lib/email-templates.test.ts src/lib/email.ts src/services/passkey-notice.ts src/services/passkey-notice.test.ts "src/app/api/auth/passkey/register/verify/route.ts" docs/technical-architecture.md docs/data-model.md
git commit -m "feat: the passkey-added email carries the This wasn't me button"
```

---

### Task 7: Sweep, drive it, verify

**Files:** whatever the sweep finds; no new feature code.

- [ ] **Step 1: Sweep for what was invalidated, from the diff**

Run `git diff main --stat`, list what changed, and reconcile against what the spec says should change. Then grep, and give every hit a verdict (fixed, or a legitimate survivor with the reason):

```bash
grep -rnE "no link|No link and no token|carries no link|passkey-added.*no link" src docs --include='*.ts' --include='*.tsx' --include='*.md' | grep -v "docs/superpowers/specs/2026-10-08"
grep -rn "PasskeyRevokeToken\|passkey-revoke" src docs prisma/schema.prisma | grep -v "\.test\."
grep -rn "deliverPasskeyAddedNotice\|sendPasskeyAddedEmail\|renderPasskeyAddedEmail" src docs
```

The payout spec's Decision 2 stays as written (the record of a decision at its date). A *description* check, not a name check: read the whole docblocks of `deletePasskey`, `deliverPasskeyAddedNotice`, `renderPasskeyAddedEmail`, `renderPasskeyRemovedEmail` and `renderPayoutChangedEmail`.

- [ ] **Step 2: Drive it in the running app**

Follow the `verify` skill's recipe for the worktree app: sign in without email, register a passkey in the dev authenticator (or insert a `PasskeyCredential` and a minted token directly), open `/passkey-revoke#t=<raw>`, confirm nothing happens on load, press the button, confirm the session is gone and the passkey is removed in the database, and that the page reads correctly at phone width. Note what was actually observed in the PR body; do not claim a browser check that was not run.

- [ ] **Step 3: Full verification**

Run: `pnpm run verify`, then `pnpm exec prisma validate`, `pnpm exec prisma migrate status` and `pnpm run build` (the CI-only gates named in the `solve-issue` skill). Expected: all green. State the suite arithmetic for the PR body as `N = a unit + b components + c integration` from the run's own output.

- [ ] **Step 4: Whole-branch review, then PR**

Dispatch the whole-branch review on the most capable model (2+ tasks), one fix wave, one scoped re-review; push; open the PR from a `--body-file` that records what was measured, where the errors were (including any of mine), the guard-bite results from Task 3 step 5, the `integration` files touched by path, and "**#<issue> is unaffected**"-style wording for anything adjacent. File the GitHub issue this PR implements first and put its number in the PR title and body.
