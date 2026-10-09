# Admin Surface Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the admin grant, the admin host, the passkey-and-recency gate, and a read-only platform-counts dashboard behind them (#60).

**Architecture:** `AdminGrant` rows on `Account`, made only by a CLI. The same Next.js process answers on `ADMIN_HOST`. The proxy shapes admin-host *pages*, and the real gate is `resolveAdminAccess` (pure, DB-tested), which mints a runtime-bound, branded `AdminProof`. A thin Next wrapper, `requireAdminSession`, turns its answer into `notFound()`/`redirect()`. Admin services take the proof as a parameter.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, `@simplewebauthn/server`, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-admin-surface-scaffold-design.md`

## Global Constraints

- `ADMIN_AUTH_WINDOW_MS = 5 * 60 * 1000`, its own constant. Never reuse `RECENT_AUTH_WINDOW_MS`.
- An unset `ADMIN_HOST` turns the whole admin surface off: every admin page answers 404.
- Every refusal a non-grantee can reach is the same 404 as a nonexistent route. The only sign-in redirect a signed-in non-grantee could ever see is the one for having *no* session.
- Authority is keyed on `accountId`. No email allowlist anywhere.
- No in-app route creates, revokes or lists grants.
- The dashboard returns aggregates only: no names, emails or addresses.
- `src/services/admin-grants.ts` imports only from `@prisma/client` (the `migrate` image has no `@/` alias and no app code).
- TDD: every task writes its failing test first. Tests assert codes/kinds, never message copy.
- Comment discipline (CLAUDE.md): no counts or member lists in comments, comments annotate only their own code, and migration comments describe only their own SQL.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Use Node 24 (`PATH="$HOME/.nvm/versions/node/v24*/bin:/usr/sbin:$PATH"` if the shell defaults to 22).

## Review Focus

1. **`ADMIN_HOST` with a different case or a trailing space** (`Admin.Localhost:3000 `): the surface should still match the `Host` header. Pinned in Task 4 (`isAdminHost` tests).
2. **A forged `AdminProof` (`{ accountId, sessionId } as AdminProof`):** an admin service should throw, not serve. Pinned in Task 5 (`assertAdminProof`) and Task 7.
3. **A passkey session that was valid, followed by grant revocation mid-window:** the next page load should 404. Pinned in Task 5 ("revoked grant").
4. **Concurrent `admin:grant` for one account:** the result should be one active row and an "unchanged" answer, not a crash. Pinned in Task 3 (P2002 test).
5. **`/admin/sign-in?redirect=https://evil.example` or `?redirect=/schedule`:** sign-in should land on `/admin`, never off the admin tree. Pinned in Task 4 (`adminReturnPath`).

## Spec refinements this plan makes

The plan departs from the spec in the places below. Task 10 updates the spec text to match:

- **The gate is split in two files.** `src/lib/admin-access.ts` holds the brand, `resolveAdminAccess` and `assertAdminProof`, and is the only module that mints. `src/lib/admin-session.ts` is the Next wrapper. This keeps the gate testable without mocking `next/headers`.
- **The proof is also bound at runtime (`WeakSet`),** because a `unique symbol` brand is erased at runtime and an `as AdminProof` cast passes every type check.
- **The proxy does not 404 `/admin` on the main host.** It passes through, and the page-level host check renders the real 404 page. Other pages on the admin host **redirect to `/admin`** instead of 404ing, because an admin-host session would otherwise render teacher pages there.
- **No visual baseline.** The dashboard's numbers are whole-database counts, so a screenshot can't be stable. The counts test uses `scopeSweep` for exact numbers in the parallel tier.
- **The counts transaction runs at `RepeatableRead`.** A batch `$transaction` at the default Read Committed gives each statement its own snapshot.

---

### Task 1: Spike — passkey sign-in across `localhost` → `admin.localhost` (throwaway)

**Files:**
- Create (scratch, never committed): `$SCRATCHPAD/admin-host-spike.spec.ts`

**Interfaces:** Produces only a go/no-go verdict, recorded in the PR body.

- [ ] **Step 1: Start the dev server with an admin host**

```bash
ADMIN_HOST=admin.localhost:3000 pnpm run dev
```
(detached, per the local-dev memory). Confirm `curl -sI http://admin.localhost:3000/login` returns a response.

- [ ] **Step 2: Write the probe**

The probe:
- seeds a student with an account (copy `tests/e2e/passkey.spec.ts` lines 104-113)
- adds a CDP virtual authenticator (lines 142-153)
- seeds a session and adds a passkey at `http://localhost:3000/account`
- clears cookies, goes to `http://admin.localhost:3000/login`, and clicks **Sign in with a passkey**. `/login` still exists on the admin host before Task 6.

It records:
- **(a)** whether `navigator.credentials.get` resolves (no `SecurityError` in the console)
- **(b)** the verify response status. Expect **400 `PASSKEY_NOT_VERIFIED`** before Task 4, because the origin isn't allowed yet. That proves the browser half works.
- **(c)** any Next dev warning about cross-origin dev resources (`allowedDevOrigins`) in the server log

- [ ] **Step 3: Run it from the repo root so it resolves `@/`**

`pnpm exec playwright test $SCRATCHPAD/admin-host-spike.spec.ts --project=chromium`

- [ ] **Step 4: Record the verdict**

- **Go:** (a) resolved. If (c) warned or blocked, Task 4 adds `allowedDevOrigins: ['admin.localhost']` to `next.config.ts` (its Step 6).
- **No-go:** (a) threw `SecurityError`. STOP and report to the human. The fallback is a hosts-file alias under a registrable test domain, which changes Tasks 4 and 9.

Delete the scratch file. Nothing is committed.

---

### Task 2: `AdminGrant` model and migration

**Files:**
- Modify: `prisma/schema.prisma` (add model; add `adminGrants AdminGrant[]` to `Account`)
- Create: `prisma/migrations/20261009120000_admin_grant/migration.sql`
- Test: `src/services/admin-grant-constraints.test.ts`

**Interfaces:**
- Produces: Prisma model `AdminGrant { id, accountId, grantedAt, grantedBy, revokedAt, revokedBy }`, partial unique index `AdminGrant_account_active_unique`, check `AdminGrant_revoke_pair_check`.

- [ ] **Step 1: Write the failing constraint test**

```ts
// src/services/admin-grant-constraints.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';

const db = new PrismaClient();
const suffix = uniqueSuffix();
let accountId: string;

beforeAll(async () => {
  accountId = (await db.account.create({ data: { email: `admin-grant-c-${suffix}@test.local` } })).id;
});

afterAll(async () => {
  if (accountId) {
    await db.adminGrant.deleteMany({ where: { accountId } });
    await db.account.deleteMany({ where: { id: accountId } });
  }
  await db.$disconnect();
});

function uniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

describe('AdminGrant constraints, inserted directly', () => {
  it('refuses a second active grant for one account', async () => {
    await db.adminGrant.create({ data: { accountId, grantedBy: 'test' } });
    const second = db.adminGrant.create({ data: { accountId, grantedBy: 'test' } });
    await expect(second).rejects.toSatisfy(uniqueViolation);
  });

  it('allows a new active grant once the earlier one is revoked', async () => {
    await db.adminGrant.updateMany({
      where: { accountId, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: 'test' },
    });
    await expect(db.adminGrant.create({ data: { accountId, grantedBy: 'test' } })).resolves.toBeDefined();
  });

  it('refuses revokedAt without revokedBy, and the reverse', async () => {
    const active = await db.adminGrant.findFirstOrThrow({ where: { accountId, revokedAt: null } });
    await expect(
      db.adminGrant.update({ where: { id: active.id }, data: { revokedAt: new Date() } }),
    ).rejects.toThrow(/AdminGrant_revoke_pair_check/);
    await expect(
      db.adminGrant.update({ where: { id: active.id }, data: { revokedBy: 'test' } }),
    ).rejects.toThrow(/AdminGrant_revoke_pair_check/);
  });

  it('refuses deleting an account that holds a grant (Restrict)', async () => {
    await expect(db.account.delete({ where: { id: accountId } })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm exec vitest run --project unit src/services/admin-grant-constraints.test.ts`
Expected: FAIL, because `db.adminGrant` is undefined (a type error at compile time, or `Cannot read properties of undefined`).

- [ ] **Step 3: Add the model to `prisma/schema.prisma`**

Add `adminGrants AdminGrant[]` to `model Account`, then add the model after it:

```prisma
/// An account's authority to use the admin surface (#60). Active while
/// `revokedAt` is null. Carries two rules Prisma cannot express and therefore
/// cannot show: `AdminGrant_account_active_unique` on (accountId) WHERE
/// "revokedAt" IS NULL — at most one active grant per account — and
/// `AdminGrant_revoke_pair_check`, which sets the two revoke columns together.
/// Rows are never deleted; see docs/data-model.md (AdminGrant).
model AdminGrant {
  id        String    @id @default(uuid())
  accountId String
  grantedAt DateTime  @default(now())
  grantedBy String
  revokedAt DateTime?
  revokedBy String?

  account Account @relation(fields: [accountId], references: [id])

  @@index([accountId])
}
```

- [ ] **Step 4: Generate the migration SQL without `migrate dev`, which refuses a non-interactive shell**

Run: `pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`

Create `prisma/migrations/20261009120000_admin_grant/migration.sql` with that output plus the two hand-written rules. The result should read:

```sql
-- CreateTable
CREATE TABLE "AdminGrant" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedBy" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,

    CONSTRAINT "AdminGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminGrant_accountId_idx" ON "AdminGrant"("accountId");

-- AddForeignKey
ALTER TABLE "AdminGrant" ADD CONSTRAINT "AdminGrant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one grant per account with "revokedAt" IS NULL.
CREATE UNIQUE INDEX "AdminGrant_account_active_unique" ON "AdminGrant"("accountId") WHERE "revokedAt" IS NULL;

-- "revokedAt" and "revokedBy" are both null or both set.
ALTER TABLE "AdminGrant" ADD CONSTRAINT "AdminGrant_revoke_pair_check" CHECK (("revokedAt" IS NULL) = ("revokedBy" IS NULL));
```

If the diff output differs from the generated part above, keep the diff's version.

- [ ] **Step 5: Apply and regenerate**

Run: `pnpm exec prisma migrate deploy && pnpm exec prisma generate`
Expected: `1 migration applied`. The test DB migrates itself on the next `pnpm test` run.

- [ ] **Step 6: Run the test and watch it pass**

Run: `pnpm exec vitest run --project unit src/services/admin-grant-constraints.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Mutation check**

Comment out the `CREATE UNIQUE INDEX` line in a scratch copy of the SQL, apply it to a throwaway DB, and confirm the first test goes red. Simpler alternative: `DROP INDEX "AdminGrant_account_active_unique"` on the test DB, run the test, see the red, then re-create the index from the migration line. Confirm `git status` is clean afterwards.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261009120000_admin_grant src/services/admin-grant-constraints.test.ts
git commit -m "feat: AdminGrant — an account's revocable admin authority, one active per account (#60)"
```

---

### Task 3: Grant service, CLI and the `migrate` image

**Files:**
- Create: `src/services/admin-grants.ts`
- Create: `src/services/admin-grants.test.ts`
- Create: `scripts/admin-grant.ts`
- Modify: `package.json` (scripts)
- Modify: `Dockerfile` (`migrate` stage)

**Interfaces:**
- Consumes: the `AdminGrant` model (Task 2).
- Produces:

```ts
export type GrantRefusal = 'no_account' | 'no_passkey' | 'no_operator';
export type GrantOutcome = { kind: 'granted' } | { kind: 'unchanged' } | { kind: 'refused'; reason: GrantRefusal };
export type RevokeOutcome = { kind: 'revoked' } | { kind: 'unchanged' } | { kind: 'refused'; reason: 'no_account' | 'no_operator' };
export interface AdminListing { accountId: string; email: string; grantedAt: Date; grantedBy: string; dormant: boolean }
export function grantAdmin(db: PrismaClient, input: { email: string; by: string }): Promise<GrantOutcome>;
export function revokeAdmin(db: PrismaClient, input: { email: string; by: string }): Promise<RevokeOutcome>;
export function listAdmins(db: PrismaClient): Promise<AdminListing[]>;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/services/admin-grants.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';
import { grantAdmin, revokeAdmin, listAdmins } from './admin-grants';

const db = new PrismaClient();
const suffix = uniqueSuffix();
const emailOf = (label: string) => `admin-grants-${label}-${suffix}@test.local`;
const accountIds: string[] = [];

async function studentAccount(label: string, opts: { passkey: boolean }): Promise<string> {
  const email = emailOf(label);
  const student = await db.student.create({
    data: {
      firstName: 'Admin',
      lastName: label,
      email,
      account: { create: { email } },
      claimedAt: new Date(),
      incomeTier: 3,
    },
    select: { accountId: true },
  });
  const accountId = student.accountId!;
  accountIds.push(accountId);
  if (opts.passkey) {
    await db.passkeyCredential.create({
      data: { id: `cred-${label}-${suffix}`, accountId, publicKey: Buffer.from([1]), counter: 0, transports: [] },
    });
  }
  return accountId;
}

afterAll(async () => {
  if (accountIds.length > 0) {
    await db.adminGrant.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.student.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await db.$disconnect();
});

describe('grantAdmin', () => {
  let accountId: string;
  beforeAll(async () => {
    accountId = await studentAccount('grant', { passkey: true });
  });

  it('grants an account that holds a passkey', async () => {
    expect(await grantAdmin(db, { email: emailOf('grant'), by: 'tester' })).toEqual({ kind: 'granted' });
    const rows = await db.adminGrant.findMany({ where: { accountId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ grantedBy: 'tester', revokedAt: null });
  });

  it('answers unchanged for an account already granted, writing nothing', async () => {
    expect(await grantAdmin(db, { email: emailOf('grant'), by: 'tester' })).toEqual({ kind: 'unchanged' });
    expect(await db.adminGrant.count({ where: { accountId } })).toBe(1);
  });

  it('matches the address case-insensitively and trimmed', async () => {
    expect(await grantAdmin(db, { email: `  ${emailOf('grant').toUpperCase()} `, by: 'tester' })).toEqual({
      kind: 'unchanged',
    });
  });

  it('collapses concurrent grants into one active row', async () => {
    const racer = await studentAccount('race', { passkey: true });
    const outcomes = await Promise.all([
      grantAdmin(db, { email: emailOf('race'), by: 'a' }),
      grantAdmin(db, { email: emailOf('race'), by: 'b' }),
    ]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(['granted', 'unchanged']);
    expect(await db.adminGrant.count({ where: { accountId: racer, revokedAt: null } })).toBe(1);
  });

  it('refuses an address with no account', async () => {
    expect(await grantAdmin(db, { email: emailOf('nobody'), by: 'tester' })).toEqual({
      kind: 'refused',
      reason: 'no_account',
    });
  });

  it('refuses an account without a passkey', async () => {
    await studentAccount('nopasskey', { passkey: false });
    expect(await grantAdmin(db, { email: emailOf('nopasskey'), by: 'tester' })).toEqual({
      kind: 'refused',
      reason: 'no_passkey',
    });
  });

  it('refuses an empty operator name', async () => {
    expect(await grantAdmin(db, { email: emailOf('grant'), by: '  ' })).toEqual({
      kind: 'refused',
      reason: 'no_operator',
    });
  });
});

describe('revokeAdmin', () => {
  let accountId: string;
  beforeAll(async () => {
    accountId = await studentAccount('revoke', { passkey: true });
    await grantAdmin(db, { email: emailOf('revoke'), by: 'tester' });
  });

  it('stamps the active grant', async () => {
    expect(await revokeAdmin(db, { email: emailOf('revoke'), by: 'remover' })).toEqual({ kind: 'revoked' });
    const row = await db.adminGrant.findFirstOrThrow({ where: { accountId } });
    expect(row.revokedBy).toBe('remover');
    expect(row.revokedAt).not.toBeNull();
  });

  it('answers unchanged when nothing is active', async () => {
    expect(await revokeAdmin(db, { email: emailOf('revoke'), by: 'remover' })).toEqual({ kind: 'unchanged' });
  });

  it('grant after revoke inserts a new row and keeps the old one', async () => {
    expect(await grantAdmin(db, { email: emailOf('revoke'), by: 'tester' })).toEqual({ kind: 'granted' });
    expect(await db.adminGrant.count({ where: { accountId } })).toBe(2);
  });
});

describe('listAdmins', () => {
  it('lists active grants and marks one dormant once its only profile is erased', async () => {
    const accountId = await studentAccount('dormant', { passkey: true });
    await grantAdmin(db, { email: emailOf('dormant'), by: 'tester' });

    const before = (await listAdmins(db)).find((a) => a.accountId === accountId);
    expect(before).toMatchObject({ email: emailOf('dormant'), grantedBy: 'tester', dormant: false });

    await db.student.updateMany({ where: { accountId }, data: { deletedAt: new Date() } });
    const after = (await listAdmins(db)).find((a) => a.accountId === accountId);
    expect(after?.dormant).toBe(true);
  });

  it('omits revoked grants', async () => {
    const accountId = await studentAccount('listrevoked', { passkey: true });
    await grantAdmin(db, { email: emailOf('listrevoked'), by: 'tester' });
    await revokeAdmin(db, { email: emailOf('listrevoked'), by: 'tester' });
    expect((await listAdmins(db)).some((a) => a.accountId === accountId)).toBe(false);
  });
});

describe('admin-grants.ts imports', () => {
  it('imports only @prisma/client, which is all the migrate image carries', () => {
    const source = readFileSync(path.join(__dirname, 'admin-grants.ts'), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(specifiers.every((s) => s === '@prisma/client')).toBe(true);
  });
});
```

Note on the erased-student fixture: if setting `deletedAt` alone trips an erasure constraint, read `src/services/gdpr.ts` for the columns erasure writes together and set the same ones in the fixture.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec vitest run --project unit src/services/admin-grants.test.ts`
Expected: FAIL with `Cannot find module './admin-grants'`.

- [ ] **Step 3: Implement the service**

```ts
// src/services/admin-grants.ts
import { Prisma, type PrismaClient } from '@prisma/client';

export type GrantRefusal = 'no_account' | 'no_passkey' | 'no_operator';
export type GrantOutcome = { kind: 'granted' } | { kind: 'unchanged' } | { kind: 'refused'; reason: GrantRefusal };
export type RevokeOutcome =
  | { kind: 'revoked' }
  | { kind: 'unchanged' }
  | { kind: 'refused'; reason: 'no_account' | 'no_operator' };

export interface AdminListing {
  accountId: string;
  email: string;
  grantedAt: Date;
  grantedBy: string;
  /** No live teacher or student profile, so no session of this account validates. Derived on read. */
  dormant: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Grants admin to the account at `email`. Refuses an address with no account
 * (this never creates one) and an account with no passkey, which could never
 * pass the admin gate.
 */
export async function grantAdmin(db: PrismaClient, input: { email: string; by: string }): Promise<GrantOutcome> {
  const by = input.by.trim();
  if (by === '') return { kind: 'refused', reason: 'no_operator' };

  const account = await db.account.findUnique({ where: { email: normalizeEmail(input.email) }, select: { id: true } });
  if (!account) return { kind: 'refused', reason: 'no_account' };
  // `PasskeyCredential` carries `accountId` without a Prisma relation, so this is a count, not a `_count`.
  if ((await db.passkeyCredential.count({ where: { accountId: account.id } })) === 0) {
    return { kind: 'refused', reason: 'no_passkey' };
  }

  const active = await db.adminGrant.findFirst({ where: { accountId: account.id, revokedAt: null }, select: { id: true } });
  if (active) return { kind: 'unchanged' };

  try {
    await db.adminGrant.create({ data: { accountId: account.id, grantedBy: by } });
    return { kind: 'granted' };
  } catch (err) {
    // A concurrent grant won `AdminGrant_account_active_unique` between the read above and this insert.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { kind: 'unchanged' };
    throw err;
  }
}

export async function revokeAdmin(db: PrismaClient, input: { email: string; by: string }): Promise<RevokeOutcome> {
  const by = input.by.trim();
  if (by === '') return { kind: 'refused', reason: 'no_operator' };

  const account = await db.account.findUnique({ where: { email: normalizeEmail(input.email) }, select: { id: true } });
  if (!account) return { kind: 'refused', reason: 'no_account' };

  const { count } = await db.adminGrant.updateMany({
    where: { accountId: account.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: by },
  });
  return count === 0 ? { kind: 'unchanged' } : { kind: 'revoked' };
}

export async function listAdmins(db: PrismaClient): Promise<AdminListing[]> {
  const grants = await db.adminGrant.findMany({
    where: { revokedAt: null },
    orderBy: { grantedAt: 'asc' },
    select: {
      accountId: true,
      grantedAt: true,
      grantedBy: true,
      account: {
        select: {
          email: true,
          teachers: { where: { deletedAt: null }, select: { id: true } },
          students: { where: { deletedAt: null }, select: { id: true } },
        },
      },
    },
  });
  return grants.map((g) => ({
    accountId: g.accountId,
    email: g.account.email,
    grantedAt: g.grantedAt,
    grantedBy: g.grantedBy,
    dormant: g.account.teachers.length === 0 && g.account.students.length === 0,
  }));
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm exec vitest run --project unit src/services/admin-grants.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation checks**

One at a time, and restore each before the next:
- delete the `no_passkey` line → only "refuses an account without a passkey" goes red
- delete the P2002 catch → only the concurrent test goes red. Run it 3×; a race may not lose on the first run.
- change `dormant` to `false` → only the dormant test goes red

Finish with `git status`/`git diff` clean except the intended files.

- [ ] **Step 6: The CLI wrapper**

```ts
// scripts/admin-grant.ts
/**
 * Operator CLI for admin grants (#60). The only way a grant is made or revoked:
 *   pnpm admin:grant  <email> --by <name>
 *   pnpm admin:revoke <email> --by <name>
 *   pnpm admin:list
 * In production it runs from the `migrate` image (DEPLOYMENT.md, Admin access).
 */
import { PrismaClient } from '@prisma/client';
import { grantAdmin, revokeAdmin, listAdmins } from '../src/services/admin-grants';

const USAGE = 'usage: admin-grant.ts grant|revoke <email> --by <name>  |  admin-grant.ts list';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, email, flag, by] = process.argv.slice(2);
  const db = new PrismaClient();
  try {
    if (command === 'list') {
      for (const a of await listAdmins(db)) {
        console.log(`${a.email}\tgranted ${a.grantedAt.toISOString()} by ${a.grantedBy}${a.dormant ? '\tDORMANT (no live profile)' : ''}`);
      }
      return;
    }
    if ((command !== 'grant' && command !== 'revoke') || !email || flag !== '--by' || !by) fail(USAGE);

    const outcome = command === 'grant' ? await grantAdmin(db, { email, by }) : await revokeAdmin(db, { email, by });
    if (outcome.kind === 'refused') fail(`refused: ${outcome.reason}`);
    console.log(outcome.kind);
  } finally {
    await db.$disconnect();
  }
}

void main();
```

Add to `package.json` `scripts`, next to the other `tsx scripts/*` entries:

```json
"admin:grant": "tsx scripts/admin-grant.ts grant",
"admin:revoke": "tsx scripts/admin-grant.ts revoke",
"admin:list": "tsx scripts/admin-grant.ts list",
```

- [ ] **Step 7: Smoke-test the CLI against the dev DB**

Run: `pnpm admin:list`, which should print nothing or the existing rows. Then run `pnpm admin:grant nobody@example.invalid --by me`, expecting `refused: no_account` and exit 1.

- [ ] **Step 8: Put it in the `migrate` image**

In `Dockerfile`, after `COPY prisma ./prisma` in the `migrate` stage:

```dockerfile
# Not a migration: the operator's admin-grant CLI (DEPLOYMENT.md, Admin
# access). This stage is the only image with tsx and the full dependencies.
COPY scripts/admin-grant.ts ./scripts/admin-grant.ts
COPY src/services/admin-grants.ts ./src/services/admin-grants.ts
```

Verify: `docker build --target migrate -t fy-migrate . && docker run --rm --entrypoint pnpm fy-migrate admin:grant x@y.invalid --by me`. Expect a database connection error, not a module-resolution error: the script loaded.

- [ ] **Step 9: Commit**

```bash
git add src/services/admin-grants.ts src/services/admin-grants.test.ts scripts/admin-grant.ts package.json Dockerfile
git commit -m "feat: admin grants are made and revoked only from the operator CLI (#60)"
```

---

### Task 4: Admin host configuration and passkey origins

**Files:**
- Create: `src/lib/admin-host.ts`
- Create: `src/lib/admin-host.test.ts`
- Modify: `src/lib/auth/passkey.ts:189-191` (`getExpectedOrigin`)
- Modify: `src/lib/auth/passkey.test.ts` (new describe after the forged-registration block)
- Modify: `src/lib/worktree/env-overrides.ts` and its test
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml` and `.github/workflows/e2e-flake-repro.yml` (every job env block that sets `NEXT_PUBLIC_APP_URL`)
- Modify (only if the Task 1 spike flagged it): `next.config.ts`

**Interfaces:**
- Produces:

```ts
export const ADMIN_ROOT_PATH = '/admin';
export const ADMIN_SIGN_IN_PATH = '/admin/sign-in';
export function adminHost(): string | null;           // ADMIN_HOST trimmed + lowercased; null when unset/blank
export function isAdminHost(host: string | null): boolean;
export function adminOrigin(): string | null;         // scheme of NEXT_PUBLIC_APP_URL + adminHost()
export function isAdminPath(pathname: string): boolean;
export function adminReturnPath(raw: string | undefined): string; // a safe /admin/** destination, else '/admin'
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/admin-host.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { adminHost, isAdminHost, adminOrigin, isAdminPath, adminReturnPath } from './admin-host';

afterEach(() => vi.unstubAllEnvs());

describe('adminHost / isAdminHost', () => {
  it('is off when ADMIN_HOST is unset or blank', () => {
    vi.stubEnv('ADMIN_HOST', '');
    expect(adminHost()).toBeNull();
    expect(isAdminHost('admin.localhost:3000')).toBe(false);
  });

  it('matches the Host header case-insensitively, trimming the setting', () => {
    vi.stubEnv('ADMIN_HOST', ' Admin.Localhost:3000 ');
    expect(isAdminHost('admin.localhost:3000')).toBe(true);
    expect(isAdminHost('ADMIN.LOCALHOST:3000')).toBe(true);
  });

  it('does not match another port, the main host, or a missing header', () => {
    vi.stubEnv('ADMIN_HOST', 'admin.localhost:3000');
    expect(isAdminHost('admin.localhost:3001')).toBe(false);
    expect(isAdminHost('localhost:3000')).toBe(false);
    expect(isAdminHost(null)).toBe(false);
  });
});

describe('adminOrigin', () => {
  it('borrows the app URL scheme', () => {
    vi.stubEnv('ADMIN_HOST', 'admin.fair.yoga');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    expect(adminOrigin()).toBe('https://admin.fair.yoga');
  });

  it('is null when the surface is off', () => {
    vi.stubEnv('ADMIN_HOST', '');
    expect(adminOrigin()).toBeNull();
  });
});

describe('isAdminPath', () => {
  it('is /admin and below, not a lookalike', () => {
    expect(isAdminPath('/admin')).toBe(true);
    expect(isAdminPath('/admin/sign-in')).toBe(true);
    expect(isAdminPath('/administrator')).toBe(false);
    expect(isAdminPath('/')).toBe(false);
  });
});

describe('adminReturnPath', () => {
  it('keeps a safe path inside the admin tree', () => {
    expect(adminReturnPath('/admin')).toBe('/admin');
    expect(adminReturnPath('/admin/rooms?x=1')).toBe('/admin/rooms?x=1');
  });

  it('falls back to /admin for anything else', () => {
    for (const raw of [undefined, '', 'https://evil.example/admin', '//evil.example/admin', '/schedule', '/administrator', '/admin/sign-in']) {
      expect(adminReturnPath(raw)).toBe('/admin');
    }
  });
});
```

Add to `src/lib/auth/passkey.test.ts` after the `verifyPasskeyRegistration, forged fmt: none attestation` describe:

```ts
describe('verifyPasskeyRegistration from the admin origin', () => {
  const ADMIN_ORIGIN = `https://admin.${FORGED_RP_ID}`;

  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', FORGED_ORIGIN);
    vi.stubEnv('PASSKEY_RP_ID', FORGED_RP_ID);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function fromAdminOrigin() {
    const credentialId = new Uint8Array(randomBytes(16));
    return forgedNoneRegistration({
      ...FORGED,
      origin: ADMIN_ORIGIN,
      authDataCredentialId: credentialId,
      responseId: isoBase64URL.fromBuffer(credentialId),
    });
  }

  it('verifies when ADMIN_HOST names that origin', async () => {
    vi.stubEnv('ADMIN_HOST', `admin.${FORGED_RP_ID}`);
    const result = await verifyPasskeyRegistration({ response: fromAdminOrigin(), expectedChallenge: FORGED_CHALLENGE });
    expect(result.verified).toBe(true);
  });

  it('refuses when ADMIN_HOST is unset', async () => {
    vi.stubEnv('ADMIN_HOST', '');
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const result = await verifyPasskeyRegistration({ response: fromAdminOrigin(), expectedChallenge: FORGED_CHALLENGE });
    expect(result.verified).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `pnpm exec vitest run --project unit src/lib/admin-host.test.ts src/lib/auth/passkey.test.ts`
Expected: `admin-host` fails to resolve. In passkey, "verifies when ADMIN_HOST names that origin" fails with `verified: false`.

- [ ] **Step 3: Implement `src/lib/admin-host.ts`**

```ts
import { isSafeRelativePath } from '@/lib/schemas';

/**
 * Where the admin surface lives (#60). Pure: read by the proxy, which stays
 * off the database. docs/technical-architecture.md (Admin surface).
 */
export const ADMIN_ROOT_PATH = '/admin';
export const ADMIN_SIGN_IN_PATH = '/admin/sign-in';

/** `ADMIN_HOST`, trimmed and lowercased; null when unset or blank, which turns the surface off. */
export function adminHost(): string | null {
  const raw = process.env.ADMIN_HOST?.trim().toLowerCase();
  return raw ? raw : null;
}

/** True when a request's `Host` header names the admin host. */
export function isAdminHost(host: string | null): boolean {
  const admin = adminHost();
  return admin !== null && host !== null && host.toLowerCase() === admin;
}

/** The admin origin, with the scheme `NEXT_PUBLIC_APP_URL` uses; null when the surface is off. */
export function adminOrigin(): string | null {
  const admin = adminHost();
  if (admin === null) return null;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  return `${new URL(appUrl).protocol}//${admin}`;
}

export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_ROOT_PATH || pathname.startsWith(`${ADMIN_ROOT_PATH}/`);
}

/** Where sign-in lands: `raw` when it is a safe path inside the admin tree other than sign-in itself, else the root. */
export function adminReturnPath(raw: string | undefined): string {
  if (!raw || !isSafeRelativePath(raw)) return ADMIN_ROOT_PATH;
  const pathname = raw.split('?')[0] ?? '';
  if (!isAdminPath(pathname) || pathname === ADMIN_SIGN_IN_PATH) return ADMIN_ROOT_PATH;
  return raw;
}
```

Check that `@/lib/schemas` is safe for the proxy to import transitively (no Prisma/DB import). If it isn't, move `isSafeRelativePath` out or import it directly from wherever it is defined. Run `grep -n "^import" src/lib/schemas.ts`.

- [ ] **Step 4: Widen `getExpectedOrigin` in `src/lib/auth/passkey.ts`**

```ts
import { adminOrigin } from '@/lib/admin-host';
// …
/** The app origin, plus the admin origin when `ADMIN_HOST` is set (docs/technical-architecture.md, Admin surface). */
function getExpectedOrigin(): string | string[] {
  const app = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const admin = adminOrigin();
  return admin === null ? app : [app, admin];
}
```

Both call sites pass it straight into `expectedOrigin`, which accepts `string | string[]`.

- [ ] **Step 5: Run and watch both pass**

Run: `pnpm exec vitest run --project unit src/lib/admin-host.test.ts src/lib/auth/passkey.test.ts`
Expected: PASS.

- [ ] **Step 6: Environment wiring**

In `.env.example`, under `# Auth`:

```
# The admin surface's host and port (#60). Unset turns it off: every admin
# page answers 404. Production: admin.<your domain>, with PASSKEY_RP_ID set to
# the parent domain so a passkey made on the main host signs in here too.
ADMIN_HOST="admin.localhost:3000"
```

`src/lib/worktree/env-overrides.ts`: add `ADMIN_HOST: \`admin.localhost:${port}\`` to the returned object. Update the first test's expected object in `env-overrides.test.ts` to include `ADMIN_HOST: 'admin.localhost:3100'`. The second test then passes because `.env.example`'s new line names `localhost:3000`.

In both workflow files, add `ADMIN_HOST: admin.localhost:3000` beside every `NEXT_PUBLIC_APP_URL: http://localhost:3000`.

Only if Task 1 recorded a dev-origin warning or block: add `allowedDevOrigins: ['admin.localhost']` to the `next.config.ts` config object.

- [ ] **Step 7: Run the worktree and env tests**

Run: `pnpm exec vitest run --project unit src/lib/worktree/env-overrides.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/admin-host.ts src/lib/admin-host.test.ts src/lib/auth/passkey.ts src/lib/auth/passkey.test.ts src/lib/worktree .env.example .github/workflows next.config.ts
git commit -m "feat: ADMIN_HOST names the admin surface, and passkeys verify from its origin (#60)"
```

---

### Task 5: The gate core — `resolveAdminAccess` and `AdminProof`

**Files:**
- Create: `src/lib/admin-access.ts`
- Create: `src/lib/admin-access.test.ts`
- Create: `tests/admin-fixtures.ts`

**Interfaces:**
- Consumes: `isAdminHost` (Task 4), `validateSession` (`src/lib/auth/session.ts`), `AdminGrant` (Task 2).
- Produces:

```ts
export const ADMIN_AUTH_WINDOW_MS: number; // 300_000
export type AdminProof = { readonly accountId: string; readonly sessionId: string; readonly [adminProofBrand]: true };
export type AdminAccess = { kind: 'not_found' } | { kind: 'sign_in' } | { kind: 'granted'; proof: AdminProof };
export function resolveAdminAccess(
  db: PrismaClient,
  input: { host: string | null; sessionToken: string | null; now?: number },
): Promise<AdminAccess>;
export function assertAdminProof(proof: AdminProof): void; // throws for anything resolveAdminAccess did not mint
```

and, in `tests/admin-fixtures.ts`:

```ts
export const TEST_ADMIN_HOST = 'admin.localhost:3000';
export interface AdminFixture { accountId: string; credentialId: string; email: string }
export function createAdminFixture(db: PrismaClient, label: string, opts?: { grant?: boolean }): Promise<AdminFixture>;
export function seedPasskeySession(db: PrismaClient, f: AdminFixture, ageMs?: number): Promise<string>; // returns raw token
export function cleanupAdminFixtures(db: PrismaClient, accountIds: string[]): Promise<void>;
```

- [ ] **Step 1: Write the fixtures module (not a test file, so importing it doesn't rerun a suite)**

```ts
// tests/admin-fixtures.ts
import type { PrismaClient } from '@prisma/client';
import { seedSession, hashToken, uniqueSuffix } from './helpers';

/** The host the unit tests stub `ADMIN_HOST` to. */
export const TEST_ADMIN_HOST = 'admin.localhost:3000';

export interface AdminFixture {
  accountId: string;
  credentialId: string;
  email: string;
}

/** A student-profile account holding a passkey and, unless `grant: false`, an active admin grant. */
export async function createAdminFixture(
  db: PrismaClient,
  label: string,
  opts: { grant?: boolean } = {},
): Promise<AdminFixture> {
  const email = `admin-fx-${label}-${uniqueSuffix()}@test.local`;
  const student = await db.student.create({
    data: { firstName: 'Admin', lastName: label, email, account: { create: { email } }, claimedAt: new Date(), incomeTier: 3 },
    select: { accountId: true },
  });
  const accountId = student.accountId!;
  const credentialId = `admin-fx-cred-${label}-${uniqueSuffix()}`;
  await db.passkeyCredential.create({
    data: { id: credentialId, accountId, publicKey: Buffer.from([1]), counter: 0, transports: [] },
  });
  if (opts.grant !== false) {
    await db.adminGrant.create({ data: { accountId, grantedBy: 'fixture' } });
  }
  return { accountId, credentialId, email };
}

/** A session that signed in with the fixture's passkey, created `ageMs` ago. */
export async function seedPasskeySession(db: PrismaClient, f: AdminFixture, ageMs = 0): Promise<string> {
  const token = await seedSession(db, f.accountId);
  await db.session.update({
    where: { id: hashToken(token) },
    data: { passkeyCredentialId: f.credentialId, createdAt: new Date(Date.now() - ageMs) },
  });
  return token;
}

export async function cleanupAdminFixtures(db: PrismaClient, accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.adminGrant.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.student.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}
```

- [ ] **Step 2: Write the failing gate tests, one per step of the gate**

```ts
// src/lib/admin-access.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { seedSession } from '../../tests/helpers';
import {
  TEST_ADMIN_HOST,
  createAdminFixture,
  seedPasskeySession,
  cleanupAdminFixtures,
  type AdminFixture,
} from '../../tests/admin-fixtures';
import { resolveAdminAccess, assertAdminProof, ADMIN_AUTH_WINDOW_MS, type AdminProof } from './admin-access';

const db = new PrismaClient();
let admin: AdminFixture;
let plain: AdminFixture;

beforeAll(async () => {
  admin = await createAdminFixture(db, 'gate');
  plain = await createAdminFixture(db, 'gate-plain', { grant: false });
});

afterAll(async () => {
  await cleanupAdminFixtures(db, [admin?.accountId, plain?.accountId].filter((id): id is string => Boolean(id)));
  await db.$disconnect();
});

beforeEach(() => vi.stubEnv('ADMIN_HOST', TEST_ADMIN_HOST));
afterEach(() => vi.unstubAllEnvs());

describe('resolveAdminAccess', () => {
  it('pins the window at five minutes', () => {
    expect(ADMIN_AUTH_WINDOW_MS).toBe(300_000);
  });

  it('grants a fresh passkey session of a granted account on the admin host', async () => {
    const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
    expect(access.kind).toBe('granted');
    if (access.kind === 'granted') expect(access.proof.accountId).toBe(admin.accountId);
  });

  it('is not_found on another host, even for a valid admin session', async () => {
    const token = await seedPasskeySession(db, admin);
    expect(await resolveAdminAccess(db, { host: 'localhost:3000', sessionToken: token })).toEqual({ kind: 'not_found' });
  });

  it('is not_found everywhere when ADMIN_HOST is unset', async () => {
    vi.stubEnv('ADMIN_HOST', '');
    const token = await seedPasskeySession(db, admin);
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'not_found' });
  });

  it('asks for sign-in with no session token, or one that matches no session', async () => {
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: null })).toEqual({ kind: 'sign_in' });
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: 'no-such-token' })).toEqual({ kind: 'sign_in' });
  });

  it('is not_found for a signed-in account without a grant — even with a fresh passkey session', async () => {
    const token = await seedPasskeySession(db, plain);
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'not_found' });
  });

  it('is not_found once the grant is revoked, for a session that was granted a moment before', async () => {
    const revokee = await createAdminFixture(db, 'gate-revoke');
    try {
      const token = await seedPasskeySession(db, revokee);
      expect((await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).kind).toBe('granted');
      await db.adminGrant.updateMany({
        where: { accountId: revokee.accountId, revokedAt: null },
        data: { revokedAt: new Date(), revokedBy: 'test' },
      });
      expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'not_found' });
    } finally {
      await cleanupAdminFixtures(db, [revokee.accountId]);
    }
  });

  it('asks a grantee to sign in again when the session came from a magic link', async () => {
    const token = await seedSession(db, admin.accountId);
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token })).toEqual({ kind: 'sign_in' });
  });

  it('asks a grantee to sign in again once the window has passed (open at its far end)', async () => {
    const token = await seedPasskeySession(db, admin);
    const row = await db.session.findFirstOrThrow({
      where: { accountId: admin.accountId, passkeyCredentialId: admin.credentialId },
      orderBy: { createdAt: 'desc' },
    });
    const edge = row.createdAt.getTime() + ADMIN_AUTH_WINDOW_MS;
    expect(await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token, now: edge })).toEqual({ kind: 'sign_in' });
    expect((await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: token, now: edge - 1 })).kind).toBe('granted');
  });
});

describe('assertAdminProof', () => {
  it('accepts a proof resolveAdminAccess minted', async () => {
    const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
    if (access.kind !== 'granted') throw new Error('expected a grant');
    expect(() => assertAdminProof(access.proof)).not.toThrow();
  });

  it('refuses a cast literal and a spread copy of a real proof', async () => {
    const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
    if (access.kind !== 'granted') throw new Error('expected a grant');
    const forged = { accountId: admin.accountId, sessionId: 'x' } as unknown as AdminProof;
    expect(() => assertAdminProof(forged)).toThrow();
    expect(() => assertAdminProof({ ...access.proof })).toThrow();
  });

  it('does not typecheck a hand-built object', () => {
    // @ts-expect-error — an AdminProof is minted, never written
    const literal: AdminProof = { accountId: 'a', sessionId: 's' };
    expect(literal).toBeDefined();
  });
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `pnpm exec vitest run --project unit src/lib/admin-access.test.ts`
Expected: FAIL with `Cannot find module './admin-access'`.

- [ ] **Step 4: Implement `src/lib/admin-access.ts`**

```ts
import type { PrismaClient } from '@prisma/client';
import { validateSession } from '@/lib/auth/session';
import { isAdminHost } from '@/lib/admin-host';

/**
 * How recently an admin session must have signed in with a passkey, measured
 * from the session row's `createdAt` like `RECENT_AUTH_WINDOW_MS` — and
 * separate from it, which governs adding a passkey.
 */
export const ADMIN_AUTH_WINDOW_MS = 5 * 60 * 1000;

declare const adminProofBrand: unique symbol;

/**
 * Proof that a request passed the admin gate. Minted only by
 * `resolveAdminAccess` and frozen. Admin services take one as a parameter and
 * call `assertAdminProof`, which refuses anything this module did not mint —
 * a cast literal, a spread copy.
 */
export type AdminProof = {
  readonly accountId: string;
  readonly sessionId: string;
  readonly [adminProofBrand]: true;
};

const minted = new WeakSet<object>();

export type AdminAccess = { kind: 'not_found' } | { kind: 'sign_in' } | { kind: 'granted'; proof: AdminProof };

/**
 * The admin gate, in order: the admin host, a session, an active grant, a
 * passkey sign-in within `ADMIN_AUTH_WINDOW_MS`. A non-grantee can reach only
 * `not_found` or the no-session `sign_in`, so the answer never says whether an
 * account holds a grant. docs/technical-architecture.md (Admin surface).
 */
export async function resolveAdminAccess(
  db: PrismaClient,
  input: { host: string | null; sessionToken: string | null; now?: number },
): Promise<AdminAccess> {
  if (!isAdminHost(input.host)) return { kind: 'not_found' };
  if (!input.sessionToken) return { kind: 'sign_in' };

  const session = await validateSession(db, input.sessionToken);
  if (!session) return { kind: 'sign_in' };

  const grant = await db.adminGrant.findFirst({
    where: { accountId: session.accountId, revokedAt: null },
    select: { id: true },
  });
  if (!grant) return { kind: 'not_found' };

  const row = await db.session.findUnique({
    where: { id: session.sessionId },
    select: { passkeyCredentialId: true, createdAt: true },
  });
  const now = input.now ?? Date.now();
  if (!row || row.passkeyCredentialId === null || now - row.createdAt.getTime() >= ADMIN_AUTH_WINDOW_MS) {
    return { kind: 'sign_in' };
  }

  const proof = Object.freeze({ accountId: session.accountId, sessionId: session.sessionId }) as AdminProof;
  minted.add(proof);
  return { kind: 'granted', proof };
}

export function assertAdminProof(proof: AdminProof): void {
  if (!minted.has(proof)) throw new Error('AdminProof was not minted by resolveAdminAccess');
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `pnpm exec vitest run --project unit src/lib/admin-access.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation checks**

One at a time, restoring each and committing nothing in between:
1. Delete the `isAdminHost` line → the "another host" and "unset" tests go red.
2. Delete the grant check → the "without a grant" and "revoked" tests go red.
3. Drop `row.passkeyCredentialId === null ||` → "magic link" goes red.
4. Change `>=` to `>` → the window-edge test goes red.
5. Delete `minted.add(proof)` → both `assertAdminProof` "accepts" tests go red.

If a mutation leaves everything green, the test for it is inert: fix the test, not the code. Finish with `git status` clean apart from the intended files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/admin-access.ts src/lib/admin-access.test.ts tests/admin-fixtures.ts
git commit -m "feat: the admin gate — host, session, grant, fresh passkey — mints a runtime-bound AdminProof (#60)"
```

---

### Task 6: Proxy host routing, cookie scope and same-site writes

**Files:**
- Modify: `src/proxy.ts`
- Modify: `src/proxy.test.ts`
- Modify: `src/lib/auth/session.test.ts` (the `setSessionCookie` describe)
- Modify: `src/lib/cross-origin.test.ts`

**Interfaces:**
- Consumes: `isAdminHost`, `isAdminPath`, `ADMIN_ROOT_PATH`, `ADMIN_SIGN_IN_PATH` (Task 4).
- Produces: no new exports.

- [ ] **Step 1: Write the failing proxy tests**

Add to `src/proxy.test.ts`:

```ts
import { afterEach, beforeEach, vi } from 'vitest';

function adminRequest(path: string, cookies?: Record<string, string>): NextRequest {
  const headers = new Headers({ host: 'admin.localhost:3000' });
  if (cookies) headers.set('cookie', Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '));
  return new NextRequest(`http://admin.localhost:3000${path}`, { headers });
}

describe('proxy on the admin host', () => {
  beforeEach(() => vi.stubEnv('ADMIN_HOST', 'admin.localhost:3000'));
  afterEach(() => vi.unstubAllEnvs());

  it('redirects / to /admin', () => {
    const response = proxy(adminRequest('/'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://admin.localhost:3000/admin');
  });

  it('redirects any non-admin page to /admin, signed in or not', () => {
    for (const path of ['/schedule', '/login', '/administrator']) {
      const response = proxy(adminRequest(path, { fair_yoga_session: 't' }));
      expect(response.headers.get('location')).toBe('http://admin.localhost:3000/admin');
    }
  });

  it('sends a cookieless /admin request to admin sign-in with its destination', () => {
    const response = proxy(adminRequest('/admin?x=1'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://admin.localhost:3000/admin/sign-in?redirect=%2Fadmin%3Fx%3D1',
    );
  });

  it('serves admin sign-in without a cookie, marked noindex', () => {
    const response = proxy(adminRequest('/admin/sign-in'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('passes a cookie-bearing /admin request through, marked noindex, with x-pathname stamped', () => {
    const response = proxy(adminRequest('/admin', { fair_yoga_session: 't' }));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/admin');
  });
});

describe('proxy on the main host', () => {
  beforeEach(() => vi.stubEnv('ADMIN_HOST', 'admin.localhost:3000'));
  afterEach(() => vi.unstubAllEnvs());

  it('leaves /admin to the page, whose host check answers 404', () => {
    const response = proxy(makeRequest('/admin'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });
});
```

If the existing tests read the stamped `x-pathname` differently from the `x-middleware-request-*` header, copy their idiom. Grep `x-pathname` in `src/proxy.test.ts`.

- [ ] **Step 2: Write the failing cookie and cross-origin tests**

In `src/lib/auth/session.test.ts`, inside `describe('setSessionCookie')`:

```ts
it('is host-only: no Domain attribute, so the admin host and the main host never share it', () => {
  const headers = new Headers();
  setSessionCookie(headers, 'my-token-value');
  expect(headers.get('Set-Cookie')).not.toMatch(/;\s*Domain=/i);
});
```

This one passes immediately. It is a pin, not a red-first test. Mutate it to confirm it can fail: add `; Domain=localhost` to `setSessionCookie`, watch it go red, then restore.

In `src/lib/cross-origin.test.ts`:

```ts
it('refuses a same-site write from the admin host to the main host as host-mismatch', () => {
  expect(
    crossOriginRefusal(req('POST', { host: 'localhost:3000', origin: 'http://admin.localhost:3000', 'sec-fetch-site': 'same-site' })),
  ).toEqual({ reason: 'host-mismatch', originHost: 'admin.localhost:3000', host: 'localhost:3000' });
});

it('refuses a same-site write from the main host to the admin host as host-mismatch', () => {
  expect(
    crossOriginRefusal(req('POST', { host: 'admin.localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' })),
  ).toEqual({ reason: 'host-mismatch', originHost: 'localhost:3000', host: 'admin.localhost:3000' });
});
```

These also pass immediately as pins of existing behaviour. Mutate by deleting the final `host-mismatch` comparison (return `null`) and watch both go red, then restore.

- [ ] **Step 3: Run the proxy tests and watch them fail**

Run: `pnpm exec vitest run --project unit src/proxy.test.ts`
Expected: the admin-host tests FAIL (no redirects or noindex yet). All existing tests still pass.

- [ ] **Step 4: Implement it in `src/proxy.ts`**

```ts
import { ADMIN_ROOT_PATH, ADMIN_SIGN_IN_PATH, isAdminHost, isAdminPath } from '@/lib/admin-host';
// …
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const onAdminHost = isAdminHost(request.headers.get('host'));

  // The admin host serves only the admin tree; an admin-host session would
  // otherwise render teacher and student pages here.
  if (onAdminHost && !isAdminPath(pathname)) {
    return NextResponse.redirect(new URL(ADMIN_ROOT_PATH, request.url));
  }
  if (onAdminHost && pathname !== ADMIN_SIGN_IN_PATH && !request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const signIn = new URL(ADMIN_SIGN_IN_PATH, request.url);
    signIn.searchParams.set('redirect', pathname + search);
    return NextResponse.redirect(signIn);
  }

  if (!onAdminHost && requiresSession(pathname) && !request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    // … existing /login redirect unchanged …
  }

  // … existing CSP + x-pathname code unchanged, ending in `const response = NextResponse.next(…)` …
  response.headers.set('Content-Security-Policy', csp);
  if (onAdminHost) response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return response;
}
```

The main-host `/admin` case needs no branch: the page's own host check answers it.

- [ ] **Step 5: Run and watch everything pass**

Run: `pnpm exec vitest run --project unit src/proxy.test.ts src/lib/auth/session.test.ts src/lib/cross-origin.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts src/lib/auth/session.test.ts src/lib/cross-origin.test.ts
git commit -m "feat: the admin host serves only the admin tree, and the cookie and same-site write isolation are pinned (#60)"
```

---

### Task 7: The platform-counts service

**Files:**
- Create: `src/services/admin-metrics.ts`
- Create: `src/services/admin-metrics.test.ts`

**Interfaces:**
- Consumes: `AdminProof`, `assertAdminProof`, `resolveAdminAccess` (Task 5), and `tests/admin-fixtures.ts` (Task 5).
- Produces:

```ts
export interface PlatformCounts {
  teachers: number;
  students: { withAccount: number; walkInOnly: number };
  rooms: { public: number; private: number };
}
export function getPlatformCounts(proof: AdminProof, db: PrismaClient): Promise<PlatformCounts>;
```

- [ ] **Step 1: Write the failing test**

```ts
// src/services/admin-metrics.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';
import { scopeSweep } from '../../tests/scoped-sweep';
import { TEST_ADMIN_HOST, createAdminFixture, seedPasskeySession, cleanupAdminFixtures, type AdminFixture } from '../../tests/admin-fixtures';
import { resolveAdminAccess, type AdminProof } from '@/lib/admin-access';
import { getPlatformCounts } from './admin-metrics';

/**
 * Counts are whole-table, and this file runs in the parallel `unit` tier, so
 * every call goes through a `scopeSweep` client narrowed to this file's own
 * rows. Expected counts are pairwise distinct, so a swapped field cannot pass.
 */
const db = new PrismaClient();
const suffix = uniqueSuffix();
let admin: AdminFixture;
let proof: AdminProof;
const teacherIds: string[] = [];
const studentIds: string[] = [];
const roomIds: string[] = [];

async function teacher(label: string, erased: boolean): Promise<string> {
  const email = `metrics-t-${label}-${suffix}@test.local`;
  const t = await db.teacher.create({
    data: { firstName: 'M', lastName: label, email, bio: 'metrics', pageSlug: `metrics-${label}-${suffix}`, account: { create: { email } } },
  });
  if (erased) await db.teacher.update({ where: { id: t.id }, data: { deletedAt: new Date() } });
  teacherIds.push(t.id);
  return t.id;
}

async function student(label: string, kind: 'claimed' | 'walk-in' | 'erased'): Promise<void> {
  const email = `metrics-s-${label}-${suffix}@test.local`;
  const s = await db.student.create({
    data:
      kind === 'walk-in'
        ? { firstName: 'M', lastName: label, email, incomeTier: 3 }
        : { firstName: 'M', lastName: label, email, incomeTier: 3, claimedAt: new Date(), account: { create: { email } } },
  });
  if (kind === 'erased') await db.student.update({ where: { id: s.id }, data: { deletedAt: new Date() } });
  studentIds.push(s.id);
}

async function room(label: string, isPublic: boolean, createdById: string): Promise<void> {
  const r = await db.room.create({
    data: { venueName: `V ${label}`, address: `${label} ${suffix} Street`, city: 'Utrecht', postcode: '3511AA', maxCapacity: 10, isPublic, createdById },
  });
  roomIds.push(r.id);
}

beforeAll(async () => {
  vi.stubEnv('ADMIN_HOST', TEST_ADMIN_HOST);
  admin = await createAdminFixture(db, 'metrics');
  const access = await resolveAdminAccess(db, { host: TEST_ADMIN_HOST, sessionToken: await seedPasskeySession(db, admin) });
  if (access.kind !== 'granted') throw new Error('fixture admin was not granted');
  proof = access.proof;

  // Expected: teachers 3, withAccount 2, walkInOnly 4, public 5, private 6.
  const creator = await teacher('t0', false);
  await teacher('t1', false);
  await teacher('t2', false);
  await teacher('t3', true);
  for (const l of ['s0', 's1']) await student(l, 'claimed');
  await student('s2', 'erased');
  for (const l of ['w0', 'w1', 'w2', 'w3']) await student(l, 'walk-in');
  for (const l of ['p0', 'p1', 'p2', 'p3', 'p4']) await room(l, true, creator);
  for (const l of ['q0', 'q1', 'q2', 'q3', 'q4', 'q5']) await room(l, false, creator);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (roomIds.length) await db.room.deleteMany({ where: { id: { in: roomIds } } });
  if (studentIds.length) await db.student.deleteMany({ where: { id: { in: studentIds } } });
  if (teacherIds.length) await db.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await db.account.deleteMany({ where: { email: { contains: `-${suffix}@test.local` }, adminGrants: { none: {} } } });
  if (admin) await cleanupAdminFixtures(db, [admin.accountId]);
  await db.$disconnect();
});

describe('getPlatformCounts', () => {
  it('counts live teachers, claimed and walk-in students, and public and private rooms', async () => {
    const { db: scoped } = scopeSweep(db, {
      Teacher: { id: { in: teacherIds } },
      Student: { id: { in: studentIds } },
      Room: { id: { in: roomIds } },
    });
    expect(await getPlatformCounts(proof, scoped)).toEqual({
      teachers: 3,
      students: { withAccount: 2, walkInOnly: 4 },
      rooms: { public: 5, private: 6 },
    });
  });

  it('refuses a proof it was not handed by the gate', async () => {
    const forged = { accountId: admin.accountId, sessionId: 'x' } as unknown as AdminProof;
    await expect(getPlatformCounts(forged, db)).rejects.toThrow();
  });
});
```

If a fixture write trips a constraint (erasure's paired columns, `Room_*_identity_unique`), read the constraint named in the error and adjust the fixture, not the service.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm exec vitest run --project unit src/services/admin-metrics.test.ts`
Expected: FAIL with `Cannot find module './admin-metrics'`.

- [ ] **Step 3: Implement it**

```ts
// src/services/admin-metrics.ts
import { Prisma, type PrismaClient } from '@prisma/client';
import { assertAdminProof, type AdminProof } from '@/lib/admin-access';

/** Platform-wide counts for the admin dashboard. Aggregates only; totals are the page's sum of the parts. */
export interface PlatformCounts {
  teachers: number;
  students: { withAccount: number; walkInOnly: number };
  rooms: { public: number; private: number };
}

export async function getPlatformCounts(proof: AdminProof, db: PrismaClient): Promise<PlatformCounts> {
  assertAdminProof(proof);
  // Repeatable Read so the batch reads one snapshot; at Read Committed each statement takes its own.
  const [teachers, withAccount, walkInOnly, publicRooms, privateRooms] = await db.$transaction(
    [
      db.teacher.count({ where: { deletedAt: null } }),
      db.student.count({ where: { deletedAt: null, accountId: { not: null } } }),
      db.student.count({ where: { deletedAt: null, accountId: null } }),
      db.room.count({ where: { isPublic: true } }),
      db.room.count({ where: { isPublic: false } }),
    ],
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return {
    teachers,
    students: { withAccount, walkInOnly },
    rooms: { public: publicRooms, private: privateRooms },
  };
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm exec vitest run --project unit src/services/admin-metrics.test.ts`
Expected: PASS. If the scoped client fails inside the batch `$transaction`, check that `scopeSweep`'s extension applies to batched queries. If it doesn't, replace the batch with `db.$transaction(async (tx) => …, { isolationLevel })`, run the five counts sequentially on `tx`, and re-run.

- [ ] **Step 5: Mutation checks**

One at a time, restoring each:
- swap `withAccount`/`walkInOnly` in the return
- drop `deletedAt: null` from the teacher count
- delete `assertAdminProof(proof)`

Each must turn a test red.

- [ ] **Step 6: Commit**

```bash
git add src/services/admin-metrics.ts src/services/admin-metrics.test.ts
git commit -m "feat: platform counts for the admin dashboard, read from one snapshot (#60)"
```

---

### Task 8: Admin routes — sign-in, gated layout, dashboard

**Files:**
- Create: `src/lib/admin-session.ts`
- Create: `src/app/(admin)/admin/sign-in/page.tsx`
- Create: `src/app/(admin)/admin/(gated)/layout.tsx`
- Create: `src/app/(admin)/admin/(gated)/page.tsx`
- Create: `src/components/admin/platform-counts.tsx`
- Create: `src/components/admin/platform-counts.test.tsx`
- Modify: `src/components/booking/passkey-sign-in.tsx` (an `emailFallback` prop)
- Modify: the component test for `passkey-sign-in` if one exists (`ls src/components/booking/passkey-sign-in*.test.tsx`)
- Modify: `src/lib/loading-coverage.test.ts` (`FALLBACK_ROUTES`)

**Interfaces:**
- Consumes: `resolveAdminAccess`, `AdminProof` (Task 5); `getPlatformCounts`, `PlatformCounts` (Task 7); `isAdminHost`, `adminReturnPath`, `ADMIN_SIGN_IN_PATH` (Task 4).
- Produces: `requireAdminSession(): Promise<AdminProof>` (React-`cache`d per request); `<PlatformCountsView counts={PlatformCounts} />`; `PasskeySignIn` gains `emailFallback?: boolean` (default `true`).

- [ ] **Step 1: Write the failing component tests**

```tsx
// src/components/admin/platform-counts.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlatformCountsView } from './platform-counts';

const counts = { teachers: 3, students: { withAccount: 2, walkInOnly: 4 }, rooms: { public: 5, private: 6 } };

describe('PlatformCountsView', () => {
  it('shows each total as the sum of its parts, with the split beneath', () => {
    render(<PlatformCountsView counts={counts} />);
    expect(screen.getByRole('region', { name: 'Teachers' })).toHaveTextContent('3');
    const students = screen.getByRole('region', { name: 'Students' });
    expect(students).toHaveTextContent('6');
    expect(students).toHaveTextContent('with an account 2 · walk-in only 4');
    const rooms = screen.getByRole('region', { name: 'Rooms' });
    expect(rooms).toHaveTextContent('11');
    expect(rooms).toHaveTextContent('public 5 · private 6');
  });
});
```

Add to the `PasskeySignIn` component test file, creating `src/components/booking/passkey-sign-in.test.tsx` if none exists, following the stubbing pattern of a sibling component test:

```tsx
it('does not offer the email link when emailFallback is false', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })));
  render(<PasskeySignIn redirect="/admin" emailFallback={false} />);
  await userEvent.click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).not.toMatch(/email/i);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm exec vitest run --project components src/components/admin src/components/booking`
Expected: FAIL, because the module is missing and the prop is unknown.

- [ ] **Step 3: Implement `PlatformCountsView`**

```tsx
// src/components/admin/platform-counts.tsx
import type { PlatformCounts } from '@/services/admin-metrics';

function CountCard({ title, total, split }: { title: string; total: number; split?: string }) {
  const id = `count-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-border bg-sand-soft p-4">
      <h2 id={id} className="type-label">{title}</h2>
      <p className="type-number">{total}</p>
      {split !== undefined && <p className="type-caption">{split}</p>}
    </section>
  );
}

export function PlatformCountsView({ counts }: { counts: PlatformCounts }) {
  const { teachers, students, rooms } = counts;
  return (
    <div className="flex flex-col gap-3">
      <CountCard title="Teachers" total={teachers} />
      <CountCard
        title="Students"
        total={students.withAccount + students.walkInOnly}
        split={`with an account ${students.withAccount} · walk-in only ${students.walkInOnly}`}
      />
      <CountCard
        title="Rooms"
        total={rooms.public + rooms.private}
        split={`public ${rooms.public} · private ${rooms.private}`}
      />
    </div>
  );
}
```

Check the token class names (`bg-sand-soft`, `border-border`, `rounded-2xl` = 16px) against `src/app/globals.css` `@theme` and an existing sand-soft card (e.g. a class card component). Use exactly the names the codebase uses.

- [ ] **Step 4: Add `emailFallback` to `PasskeySignIn`**

In `src/components/booking/passkey-sign-in.tsx`:
- add `emailFallback?: boolean` to `PasskeySignInProps`, with the doc comment `/** False where no email sign-in exists (the admin host): the copy then offers only a retry. */`
- destructure `{ redirect, emailFallback = true }`
- replace the two copy strings with a ternary on `emailFallback`. The no-fallback versions are `"Passkey sign-in didn't work here. Try again."` and `"Nothing came back from your device. Try again."`. `DEFAULT_ERROR_MESSAGE` stays the email-fallback copy; add `const RETRY_ONLY_ERROR_MESSAGE = "Passkey sign-in didn't work here. Try again."` beside it.

Run: `pnpm exec vitest run --project components src/components/admin src/components/booking`
Expected: PASS.

- [ ] **Step 5: The Next wrapper**

```ts
// src/lib/admin-session.ts
import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { ADMIN_SIGN_IN_PATH } from '@/lib/admin-host';
import { resolveAdminAccess, type AdminProof } from '@/lib/admin-access';

/**
 * `resolveAdminAccess` for a page or route handler: `notFound()` and
 * `redirect()` for its refusals. Cached per request, so a layout and its page
 * share one answer. Every admin page calls it itself — a layout's redirect
 * does not stop its page from rendering.
 */
export const requireAdminSession = cache(async (): Promise<AdminProof> => {
  const headerList = await headers();
  const access = await resolveAdminAccess(prisma, {
    host: headerList.get('host'),
    sessionToken: (await cookies()).get(SESSION_COOKIE_NAME)?.value ?? null,
  });
  if (access.kind === 'not_found') notFound();
  if (access.kind === 'sign_in') {
    const destination = headerList.get('x-pathname');
    redirect(destination ? `${ADMIN_SIGN_IN_PATH}?redirect=${encodeURIComponent(destination)}` : ADMIN_SIGN_IN_PATH);
  }
  return access.proof;
});
```

`adminReturnPath` on the sign-in page validates whatever arrives, so this file does not re-validate.

- [ ] **Step 6: The pages**

```tsx
// src/app/(admin)/admin/sign-in/page.tsx
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { isAdminHost, adminReturnPath } from '@/lib/admin-host';
import { PasskeySignIn } from '@/components/booking/passkey-sign-in';

export const metadata: Metadata = { title: 'Admin sign-in · fair.yoga', robots: { index: false, follow: false } };

export default async function AdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  if (!isAdminHost((await headers()).get('host'))) notFound();
  const { redirect } = await searchParams;
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-4 px-4 py-8">
      <h1 className="type-title">Admin</h1>
      <p className="type-body">Sign in with your passkey. The admin pages ask again five minutes after each sign-in.</p>
      <PasskeySignIn redirect={adminReturnPath(redirect)} emailFallback={false} />
    </main>
  );
}
```

```tsx
// src/app/(admin)/admin/(gated)/layout.tsx
import { prisma } from '@/lib/db';
import { requireAdminSession } from '@/lib/admin-session';
import { SignOutButton } from '@/components/admin/sign-out-button';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const proof = await requireAdminSession();
  const account = await prisma.account.findUniqueOrThrow({ where: { id: proof.accountId }, select: { email: true } });
  return (
    <main className="mx-auto flex max-w-[640px] flex-col gap-6 px-4 py-8">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="type-title">Platform</h1>
          <p className="type-caption">{account.email}</p>
        </div>
        <SignOutButton />
      </header>
      {children}
    </main>
  );
}
```

```tsx
// src/app/(admin)/admin/(gated)/page.tsx
import { prisma } from '@/lib/db';
import { requireAdminSession } from '@/lib/admin-session';
import { getPlatformCounts } from '@/services/admin-metrics';
import { PlatformCountsView } from '@/components/admin/platform-counts';

export const dynamic = 'force-dynamic';

export default async function AdminDashboardPage() {
  const proof = await requireAdminSession();
  return <PlatformCountsView counts={await getPlatformCounts(proof, prisma)} />;
}
```

For `SignOutButton`, find the existing sign-out control (`grep -rln "auth/session" src/components | grep -v test`). If one is reusable with a post-sign-out destination, use it with the destination `/admin/sign-in`. Otherwise create `src/components/admin/sign-out-button.tsx`, a `'use client'` text button that does `fetch('/api/auth/session', { method: 'DELETE' })` and then `window.location.assign('/admin/sign-in')` (a full navigation, so no cached admin page survives). Copy the existing sign-out's error handling.

**Route-group check:** `(gated)` is a route group, so the URL is `/admin`, and `sign-in` sits beside it outside the gated layout. Confirm with `pnpm run build`'s route list that `/admin` and `/admin/sign-in` both appear exactly once.

- [ ] **Step 7: The loading-coverage census**

`src/lib/loading-coverage.test.ts` fails on the two new pages. Add them to `FALLBACK_ROUTES`, sorted with their neighbours:

```ts
  '(admin)/admin/(gated)': 'none',
  '(admin)/admin/sign-in': 'none',
```

`'none'` because the admin group has no skeleton by design. The dashboard is five counts on a five-minute session.

Run: `pnpm exec vitest run --project unit src/lib/loading-coverage.test.ts`
Expected: PASS.

- [ ] **Step 8: Verify in the running app**

With `ADMIN_HOST=admin.localhost:3000` in `.env`, restart the dev server. Then:
- grant your own dev account (`pnpm admin:grant <you> --by dev`, after adding a passkey at `/settings/profile` or `/account`)
- open `http://admin.localhost:3000/` → it redirects to sign-in → sign in with the passkey → the dashboard shows three cards
- `http://localhost:3000/admin` → the 404 page
- wait five minutes and reload → back to sign-in

Also check the browser console on the admin host for errors from `recordPushDeviceForSignIn` or `clearOfflinePages`. If either throws there, guard that call on `!isAdminPath(location.pathname)` inside `PasskeySignIn` and say so in the PR.

- [ ] **Step 9: Typecheck, lint and commit**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

```bash
git add src/lib/admin-session.ts "src/app/(admin)" src/components/admin src/components/booking/passkey-sign-in.tsx src/components/booking/passkey-sign-in.test.tsx src/lib/loading-coverage.test.ts
git commit -m "feat: the admin host's passkey sign-in and its platform-counts dashboard (#60)"
```

---

### Task 9: End-to-end on the admin host

**Files:**
- Modify: `playwright.config.ts` (an `admin` project; the existing projects ignore admin specs)
- Create: `tests/e2e/admin/admin-dashboard.spec.ts`

**Interfaces:**
- Consumes: everything above. The CI env carries `ADMIN_HOST` (Task 4).

- [ ] **Step 1: Add the project**

In `playwright.config.ts`, above `export default`:

```ts
/** The admin host for whatever origin the app under test answers on: admin.<host>:<port>. */
function adminBaseUrl(): string {
  const url = new URL(process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000');
  url.hostname = `admin.${url.hostname}`;
  return url.origin;
}
```

Then change `projects` to:

```ts
projects: [
  { name: 'chromium', testIgnore: /admin\//, use: { ...devices['Desktop Chrome'] } },
  { name: 'Mobile Chrome', testIgnore: /admin\//, use: { ...devices['Pixel 5'] } },
  { name: 'admin', testMatch: /admin\/.*\.spec\.ts/, use: { ...devices['Desktop Chrome'], baseURL: adminBaseUrl() } },
],
```

- [ ] **Step 2: Write the spec**

```ts
// tests/e2e/admin/admin-dashboard.spec.ts
import { test, expect } from '../fixtures';
import { createGuardedPrismaClient } from '../prisma';
import { uniqueSuffix, seedSession, sessionCookie, BASE_URL } from '../../helpers';

/**
 * One long test on purpose: the virtual authenticator, and the passkey it
 * holds, lives in the per-test browser context (tests/e2e/passkey.spec.ts).
 */
const prisma = createGuardedPrismaClient();
const suffix = uniqueSuffix();
const adminEmail = `e2e-admin-${suffix}@test.local`;
const plainEmail = `e2e-admin-plain-${suffix}@test.local`;
const accountIds: string[] = [];

async function studentAccount(email: string): Promise<string> {
  const s = await prisma.student.create({
    data: { firstName: 'Ad', lastName: 'Min', email, account: { create: { email } }, claimedAt: new Date(), incomeTier: 3 },
    select: { accountId: true },
  });
  accountIds.push(s.accountId!);
  return s.accountId!;
}

test.describe('Admin dashboard', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    // Guarded: an `undefined` in a deleteMany filter matches everything.
    if (accountIds.length > 0) {
      await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.adminGrant.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    await prisma.$disconnect();
  });

  test('a grantee signs in with a passkey and sees the counts; others get 404', async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });

    // A passkey made on the main host, as every user makes one.
    const adminAccount = await studentAccount(adminEmail);
    await context.addCookies([sessionCookie(await seedSession(prisma, adminAccount))]);
    await page.goto(`${BASE_URL}/account`);
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText(/next sign-in is one tap/)).toBeVisible();
    await prisma.adminGrant.create({ data: { accountId: adminAccount, grantedBy: 'e2e' } });

    // The main host has no admin surface.
    const mainAdmin = await page.goto(`${BASE_URL}/admin`);
    expect(mainAdmin?.status()).toBe(404);

    // The admin host sends a cookieless visitor to passkey sign-in, and lands them on the dashboard.
    await context.clearCookies();
    await page.goto('/');
    await page.waitForURL('**/admin/sign-in?redirect=%2Fadmin');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.waitForURL((url) => url.pathname === '/admin', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible();
    for (const name of ['Teachers', 'Students', 'Rooms']) {
      await expect(page.getByRole('region', { name })).toBeVisible();
    }

    // A signed-in account without a grant gets the same 404 as a missing page.
    await context.clearCookies();
    const plainAccount = await studentAccount(plainEmail);
    const plainToken = await seedSession(prisma, plainAccount);
    await context.addCookies([{ name: 'fair_yoga_session', value: plainToken, url: page.url() }]);
    const plainAdmin = await page.goto('/admin');
    expect(plainAdmin?.status()).toBe(404);
  });
});
```

The last block uses a magic-link-style session for the non-grantee. That's sufficient, because the grant check (404) runs before the passkey check.

`page.goto` on a not-found page should report 404. If Next's streaming reports 200 there (see the "page redirect under loading.tsx is a 200" memory; the admin group has no `loading.tsx`, so it shouldn't), assert the not-found page's text instead. Copy the heading from `src/app/not-found.tsx`.

- [ ] **Step 3: Run it**

Run: `pnpm exec playwright test --project=admin`
Expected: PASS. Also run `pnpm exec playwright test --project=chromium tests/e2e/passkey.spec.ts` to confirm the existing projects still find their specs and ignore `admin/`.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts tests/e2e/admin
git commit -m "test: e2e — passkey sign-in on the admin host, its dashboard, and 404s for everyone else (#60)"
```

---

### Task 10: Documentation and the spec's refinements

**Files:**
- Modify: `docs/data-model.md` (new `AdminGrant` section beside `Account`)
- Modify: `docs/technical-architecture.md` (new "Admin surface" section under Session Management; this is the anchor the code comments link to)
- Modify: `DEPLOYMENT.md` (new section "Admin access")
- Modify: `deploy/nginx.conf.example` (an admin `server` block)
- Modify: `docs/information-architecture.md` (one line)
- Modify: `docs/superpowers/specs/2026-10-09-admin-surface-scaffold-design.md` (the refinements listed at the top of this plan)

- [ ] **Step 1: `docs/data-model.md` — AdminGrant**

Cover:
- the fields
- active means `revokedAt IS NULL`, and `AdminGrant_account_active_unique` (re-derive with `grep -n AdminGrant_account_active_unique prisma/migrations/*/migration.sql`)
- `AdminGrant_revoke_pair_check`
- rows are never deleted; Restrict
- erasure does not revoke, and a grant whose account has no live profile is *dormant* (derived by `listAdmins`, not stored)
- an admin must hold a live teacher or student profile, because `SessionUser` has no profile-less arm

- [ ] **Step 2: `docs/technical-architecture.md` — Admin surface**

Cover:
- `ADMIN_HOST` and "unset is off"
- the proxy shapes pages only, because its matcher excludes `/api`
- the gate's order (`resolveAdminAccess`) and why non-grantees see only 404 or the no-session redirect
- `ADMIN_AUTH_WINDOW_MS` versus `RECENT_AUTH_WINDOW_MS`
- `AdminProof`: compile-time brand plus runtime `WeakSet`
- `requireAdminSession` is called by every page, not just the layout
- passkey origins as an array, and `PASSKEY_RP_ID` set to the parent domain
- what the host split buys (host-only cookies, pinned by a test) and what it doesn't (a stolen token; same-site requests, where writes are stopped by `crossOriginRefusal`'s `host-mismatch`)

- [ ] **Step 3: `DEPLOYMENT.md` and the Nginx example**

`DEPLOYMENT.md` gets an "Admin access" section:
1. a DNS `A`/`AAAA` record for `admin.<domain>`
2. copy the admin `server` block from `deploy/nginx.conf.example`
3. `certbot --nginx -d <domain> -d admin.<domain>` (one certificate, two names)
4. set `ADMIN_HOST=admin.<domain>` and `PASSKEY_RP_ID=<domain>`
5. the operator registers a passkey on the main site, then runs `docker compose -f docker-compose.prod.yml run --rm migrate pnpm admin:grant <email> --by <name>`, plus `admin:revoke` and `admin:list`
6. optional: `allow <ip>; deny all;` in the admin vhost if your admins have fixed addresses

In `deploy/nginx.conf.example`, add a second pair of `server` blocks for `admin.yourdomain.example`: port 80 redirect, plus 443 with the same security headers and a single `location /` that `proxy_pass`es to `127.0.0.1:3000` with the same `proxy_set_header` lines. Add no photo or SSE locations, since the admin tree uses neither.

- [ ] **Step 4: The IA line**

In `docs/information-architecture.md`, near the tab-bar description: "The admin surface (#60) is outside this IA: its own host, no tab bar (docs/technical-architecture.md, Admin surface)."

- [ ] **Step 5: Align the spec**

Apply the "Spec refinements this plan makes" list to the spec:
- the gate is split into `admin-access.ts` and `admin-session.ts`
- the runtime binding
- the proxy table's main-host row (passes through; the page answers 404) and the other-pages row (redirect to `/admin`)
- no visual baseline, and the `scopeSweep` counts test
- `RepeatableRead`

- [ ] **Step 6: Check every pointer resolves**

Each code comment written in Tasks 4-8 that names `docs/technical-architecture.md (Admin surface)` or `docs/data-model.md (AdminGrant)` must land on a heading that exists:

```bash
grep -rn "Admin surface\|(AdminGrant)" src prisma | grep -v node_modules
grep -n "Admin surface" docs/technical-architecture.md
grep -n "AdminGrant" docs/data-model.md
```

- [ ] **Step 7: Commit**

```bash
git add docs DEPLOYMENT.md deploy/nginx.conf.example
git commit -m "docs: the admin surface — AdminGrant, the gate, the admin host, and how to deploy and grant it (#60)"
```

---

### Task 11: Whole-branch verification

- [ ] **Step 1:** `pnpm typecheck && pnpm lint && pnpm test` → all green. Then `pnpm exec playwright test` (all projects) → green.
- [ ] **Step 2:** `pnpm run check-migrations` and `pnpm run check-visual-baseline-freshness` → green. No baseline should be affected; `passkey-sign-in.tsx` sits on the login page. If the freshness check flags `login`, regenerate the login baseline: it changed source but not pixels, so run `pnpm run attest-visual-baseline login`.
- [ ] **Step 3:** `docker build --target runner .` and `docker build --target migrate .` both succeed.
- [ ] **Step 4:** `git status` is clean, and `git log --oneline main..` shows one commit per task.
- [ ] **Step 5:** Invoke `/verify` before the PR (per the repo's commit rule), then open the PR with the Task 1 spike verdict in its body.
