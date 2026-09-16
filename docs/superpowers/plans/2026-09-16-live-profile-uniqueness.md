# One Live Profile Per Account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An account whose profile was erased can hold a new one, so the control that led to `/account/privacy` succeeds instead of bouncing the person to `/schedule` with no explanation (#623).

**Architecture:** `Teacher.accountId` and `Student.accountId` trade a hard `@unique` for hand-authored partial unique indexes scoped `WHERE "deletedAt" IS NULL`. Prisma cannot express a partial unique key, so both reverse relations on `Account` become lists and every reader filters `deletedAt: null` in the query. A small helper keeps "at most one" a loud runtime failure now that it is no longer a compile-time fact.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (four projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-live-profile-uniqueness-design.md`

## Global Constraints

- **Task order is load-bearing.** 1 → 2 → 3 → 4. Task 2 changes the Prisma schema; nothing after it compiles against the old client, and nothing before it may depend on the new relation names.
- **Work in a git worktree, never against `:3000`.** The dev server on `:3000` belongs to the user, hot-reloads their uncommitted edits, and holds a stale Prisma client after a schema change. Never kill or restart it.
- **Worktree bootstrap, in this order, once:** `pnpm install --frozen-lockfile` (a fresh worktree has no `node_modules`, and `verifyDepsBeforeRun: error` makes every `pnpm run`/`pnpm exec` exit 1 until it does), then `pnpm run worktree:setup`, then `pnpm run worktree:up` before any `--project integration` or Playwright run. `pnpm run worktree:down` when finished.
- **Never edit an applied migration** — comment-only edits included. The checksum changes while `prisma migrate status` compares only names.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **TypeScript `strict: true`** — no `any`, no implicit types.
- **Comment discipline:** a comment annotates the code it sits on. No prose counts or member rosters; anything wider goes in `docs/` with a link.
- **Index names, fixed:** `Teacher_account_live_unique`, `Student_account_live_unique`.
- **Helper name and location, fixed:** `liveProfile`, in `src/lib/live-profile.ts`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/live-profile.ts` | Create — the one live profile of a kind, or null; throws on more than one | 1 |
| `src/lib/live-profile.test.ts` | Create — unit tests for the above | 1 |
| `prisma/migrations/<ts>_live_profile_unique_per_account/migration.sql` | Create — drop two unique indexes, create two partial ones | 2 |
| `prisma/schema.prisma` | Modify — `@unique` off both `accountId`s, both relations become lists, two `///` index docblocks | 2 |
| `src/lib/auth/session.ts:75-85` | Modify — filter liveness in the query | 2 |
| `src/lib/auth/account.ts:31-47` | Modify — same | 2 |
| `src/app/api/auth/passkey/register/options/route.ts:18-31` | Modify — same, and stop naming credentials after a tombstone | 2 |
| `src/app/api/auth/passkey/authenticate/verify/route.ts:50-54` | Modify — same | 2 |
| `src/services/invitations.ts:665-674` | Modify — same; an erased teacher must not be notified | 2 |
| `tests/integration/live-profile-unique.test.ts` | Create — the two indexes, both directions | 2 |
| `src/services/invitations.notify.test.ts` | Modify — an erased teacher beside a live one does not divert the dispatch | 2 |
| `tests/integration/passkey-api.test.ts` | Modify — the credential is named after the live profile | 2 |
| `tests/integration/erased-profile-restart.test.ts` | Create — acceptance criteria 1 and 3, both families | 3 |
| `scripts/verify-account-backfill.sql` | Modify — a standing invariant for the fact the indexes buy | 4 |
| `docs/data-model.md` | Modify — three falsified claims | 4 |
| `src/services/rule-lifecycle.ts:1087` | Modify — comment only | 4 |
| `src/app/api/account/teacher-profile/route.ts:44,92` | Modify — comment and log string only | 4 |
| `src/app/api/account/student-profile/route.ts:120` | Modify — comment only | 4 |
| `src/lib/unique-conflict.ts:7-14` | Modify — comment only, census 2 → 4 | 4 |
| `tests/integration/account-api.test.ts:821` | Modify — comment only, names a dropped index | 4 |

---

## Task 1: The `liveProfile` helper

**Files:**
- Create: `src/lib/live-profile.ts`
- Test: `src/lib/live-profile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function liveProfile<T>(rows: readonly T[]): T | null` — returns `rows[0]` when there is exactly one, `null` when there are none, and throws an `Error` when there are two or more. Task 2 calls it at five sites.

This task is independent of the schema change and lands first so Task 2 has it available.

- [ ] **Step 1: Write the failing test**

Create `src/lib/live-profile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { liveProfile } from './live-profile';

describe('liveProfile', () => {
  it('returns null when the account holds no live profile of this kind', () => {
    expect(liveProfile([])).toBeNull();
  });

  it('returns the only live profile', () => {
    expect(liveProfile([{ id: 'only' }])).toEqual({ id: 'only' });
  });

  // The partial unique index makes two live rows unreachable. This asserts
  // what happens if it is ever absent: a loud throw, not an arbitrary pick.
  // Two of the five call sites can be handed a tombstone by an arbitrary
  // pick, which is why silence is the wrong default here.
  it('throws rather than choosing between two live profiles', () => {
    expect(() => liveProfile([{ id: 'a' }, { id: 'b' }])).toThrow(
      /account holds 2 live profiles/,
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm exec vitest run --project unit src/lib/live-profile.test.ts`

Expected: FAIL — the module does not exist, so the import cannot resolve.

- [ ] **Step 3: Write the implementation**

Create `src/lib/live-profile.ts`:

```ts
/**
 * The one live profile of a kind on an account, or null.
 *
 * `Account.teachers` and `Account.students` are lists because `accountId`'s
 * uniqueness is partial — see each model's own docblock in
 * `prisma/schema.prisma` for the index that enforces it. Prisma cannot
 * express a partial unique key, so it cannot type either relation as
 * at-most-one; callers select with `where: { deletedAt: null }`, which those
 * indexes make single-valued.
 *
 * The throw is what keeps the lost compile-time guarantee loud. Without an
 * index, a caller taking `[0]` picks arbitrarily and silently, and an
 * arbitrary pick can be a soft-deleted row.
 */
export function liveProfile<T>(rows: readonly T[]): T | null {
  if (rows.length > 1) {
    throw new Error(`account holds ${rows.length} live profiles of one kind`);
  }
  return rows[0] ?? null;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm exec vitest run --project unit src/lib/live-profile.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/live-profile.ts src/lib/live-profile.test.ts
git commit -m "feat(accounts): a helper for the one live profile of a kind (#623)"
```

---

## Task 2: The partial indexes, and the five sites that must filter on liveness

**Files:**
- Create: `prisma/migrations/<timestamp>_live_profile_unique_per_account/migration.sql`
- Modify: `prisma/schema.prisma`
- Modify: `src/lib/auth/session.ts`
- Modify: `src/lib/auth/account.ts`
- Modify: `src/app/api/auth/passkey/register/options/route.ts`
- Modify: `src/app/api/auth/passkey/authenticate/verify/route.ts`
- Modify: `src/services/invitations.ts`
- Test: `tests/integration/live-profile-unique.test.ts` (create)
- Test: `src/services/invitations.notify.test.ts` (modify)
- Test: `tests/integration/passkey-api.test.ts` (modify)

**Interfaces:**
- Consumes: `liveProfile` from Task 1.
- Produces: `Account.teachers: Teacher[]` and `Account.students: Student[]` in the generated Prisma client. Task 3 relies on `POST /api/account/student-profile` answering 201 for an account holding a live teacher and an erased student.

This task is indivisible: the schema edit breaks all five sites at once, so they must land together.

- [ ] **Step 1: Write the constraint test**

Create `tests/integration/live-profile-unique.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { isUniqueConflictOn } from '@/lib/unique-conflict';

const prisma = new PrismaClient();
const suffix = `live-profile-${Date.now()}`;
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { email: `${tag}-${suffix}@test.local` },
  });
  accountIds.push(account.id);
  return account.id;
}

/**
 * These assert the DATABASE refuses the write. `liveProfile`
 * (`src/lib/live-profile.ts`) throws on the state these indexes make
 * unreachable, so if they are absent that throw silently becomes the only
 * thing standing — and at two call sites the alternative to throwing is
 * handing out a soft-deleted row.
 *
 * `isUniqueConflictOn` rather than a message match: it is the predicate two
 * production routes use to turn this exact conflict into a coded 409, so
 * asserting it here is what proves those routes still work over a partial
 * index rather than falling through to their unrecognised-P2002 throw.
 */
describe('one live profile per account (#623)', () => {
  it('accepts a new live Student beside an erased one on the same account', async () => {
    const accountId = await makeAccount('student-restart');
    await prisma.student.create({
      data: {
        accountId,
        firstName: 'Deleted', lastName: 'Student',
        email: `erased-student-${suffix}@deleted.invalid`,
        claimedAt: new Date(), deletedAt: new Date(),
      },
    });

    const live = await prisma.student.create({
      data: {
        accountId,
        firstName: 'Fresh', lastName: 'Start',
        email: `live-student-${suffix}@test.local`,
        claimedAt: new Date(),
      },
    });
    expect(live.accountId).toBe(accountId);
  });

  it('refuses a second LIVE Student on one account', async () => {
    const accountId = await makeAccount('student-double');
    await prisma.student.create({
      data: {
        accountId,
        firstName: 'First', lastName: 'Live',
        email: `first-live-${suffix}@test.local`,
        claimedAt: new Date(),
      },
    });

    let caught: unknown;
    try {
      await prisma.student.create({
        data: {
          accountId,
          firstName: 'Second', lastName: 'Live',
          email: `second-live-${suffix}@test.local`,
          claimedAt: new Date(),
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConflictOn(caught, ['accountId'])).toBe(true);
  });

  it('accepts a new live Teacher beside an erased one on the same account', async () => {
    const accountId = await makeAccount('teacher-restart');
    await prisma.teacher.create({
      data: {
        accountId,
        firstName: 'Deleted', lastName: 'Teacher',
        email: `erased-teacher-${suffix}@deleted.invalid`,
        bio: '', pageSlug: `deleted-teacher-${suffix}`,
        deletedAt: new Date(),
      },
    });

    const live = await prisma.teacher.create({
      data: {
        accountId,
        firstName: 'Fresh', lastName: 'Teacher',
        email: `live-teacher-${suffix}@test.local`,
        bio: '', pageSlug: `live-teacher-${suffix}`,
      },
    });
    expect(live.accountId).toBe(accountId);
  });

  it('refuses a second LIVE Teacher on one account', async () => {
    const accountId = await makeAccount('teacher-double');
    await prisma.teacher.create({
      data: {
        accountId,
        firstName: 'First', lastName: 'Teacher',
        email: `first-teacher-${suffix}@test.local`,
        bio: '', pageSlug: `first-teacher-${suffix}`,
      },
    });

    let caught: unknown;
    try {
      await prisma.teacher.create({
        data: {
          accountId,
          firstName: 'Second', lastName: 'Teacher',
          email: `second-teacher-${suffix}@test.local`,
          bio: '', pageSlug: `second-teacher-${suffix}`,
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConflictOn(caught, ['accountId'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm the two "accepts" cases fail**

Run: `pnpm exec vitest run --project integration tests/integration/live-profile-unique.test.ts`

Expected: the two "accepts a new live … beside an erased one" tests FAIL (the hard `@unique` refuses the second row); the two "refuses a second LIVE" tests already PASS, because a hard unique refuses that too. Record the failure text.

- [ ] **Step 3: Edit the schema**

In `prisma/schema.prisma`, `model Account` becomes:

```prisma
model Account {
  id        String   @id @default(uuid())
  email     String   @unique
  createdAt DateTime @default(now())

  teachers Teacher[]
  students Student[]
}
```

On `model Teacher`, change `accountId String @unique` to `accountId String`, and add a `///` docblock immediately above `model Teacher` (the convention `model Room` sets — a partial index cannot appear in this file unless a comment keeps it visible):

```prisma
/// Carries a partial unique index Prisma cannot express and therefore cannot
/// show: `Teacher_account_live_unique` on (accountId) WHERE "deletedAt" IS
/// NULL (#623). One account holds at most one LIVE teacher profile and any
/// number of erased ones, so an erasure does not bar the account from ever
/// holding another. Invisible to `migrate diff`, so it will not appear as
/// drift and will not be dropped — and equally will not appear in this file
/// unless someone keeps this comment true.
model Teacher {
```

On `model Student`, change `accountId String? @unique` to `accountId String?`, and add the mirror docblock above `model Student`:

```prisma
/// Carries a partial unique index Prisma cannot express and therefore cannot
/// show: `Student_account_live_unique` on (accountId) WHERE "deletedAt" IS
/// NULL (#623). One account holds at most one LIVE student profile and any
/// number of erased ones. `accountId` is nullable and Postgres treats NULLs
/// as distinct in a unique index, so rows with no account continue to
/// coexist freely. Same visibility caveat as `Teacher`'s.
model Student {
```

Leave the existing comment on the `accountId` field itself unchanged — it is about nullability and unclaimed rows, and stays true.

Finally, correct the `model Account` header comment above it (currently lines
131-138). Two of its sentences are falsified:

- "Teacher/Student are profiles optionally hanging off it" reads as 0-or-1.
  It is now 0-or-1 **live** plus any number of erased.
- "live linked profiles match the account's email by construction" stays
  true, but "live" now carries real weight: an erased profile on the same
  account holds a tombstoned address that matches nothing.

Reword both to say what is true now. Do not annotate what they used to say —
that belongs in the PR body.

- [ ] **Step 4: Generate the migration, then hand-author the partial indexes**

Run: `pnpm exec prisma migrate dev --create-only --name live_profile_unique_per_account`

**`--create-only` is load-bearing, not a convenience.** Without it Prisma
generates AND APPLIES in one step, and the edit below would then be amending
an *applied* migration — which `pnpm run check-migrations` fails by design
(applied migrations are checksummed and immutable) and which leaves any
database that already ran it needing a destructive reset. Generate, edit,
then apply.

Prisma generates a migration containing only the two `DROP INDEX` statements. Open the generated `migration.sql` and replace its contents with the following, keeping the generated drops:

```sql
-- One LIVE profile per account, not one profile ever (#623).
--
-- `deleteStudentAccount`/`deleteTeacherAccount` soft-delete the row and keep
-- `accountId`, so a hard unique made a GDPR erasure permanently bar the
-- account from holding that kind of profile again. The student half of that
-- surfaced as a silent bounce: the control that offered a student side
-- answered 409, its caller read the code as success, and the page it
-- navigated to requires a live student profile.
--
-- Hand-authored because Prisma cannot express a WHERE clause on an index.
-- Measured on the precedent this follows
-- (20260811202634_teacher_slot_unique_indexes): `prisma migrate diff
-- --from-schema-datasource --to-schema-datamodel --exit-code` does NOT see a
-- partial index, so these do not read as drift in CI. The DROPs below are
-- visible to Prisma and arrive with the schema edit that removed `@unique`.
DROP INDEX "Teacher_accountId_key";
DROP INDEX "Student_accountId_key";

CREATE UNIQUE INDEX "Teacher_account_live_unique"
  ON "Teacher" ("accountId")
  WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "Student_account_live_unique"
  ON "Student" ("accountId")
  WHERE "deletedAt" IS NULL;
```

Then apply it: `pnpm exec prisma migrate dev`

Confirm the edit was legal: `pnpm run check-migrations` must print
`✓ No applied migrations amended`. If it reports a violation, the migration
was applied before it was edited — the `--create-only` step was missed.

- [ ] **Step 5: Translate `src/lib/auth/session.ts`**

Add `import { liveProfile } from '@/lib/live-profile';` to the imports. Replace the account read and the two liveness lines (currently lines 71-85) with:

```ts
  // Resolve the account's LIVE profiles. GDPR erasure soft-deletes
  // (deletedAt) and keeps the link, so the selects below filter on it — an
  // erased profile must not resurface through a surviving session. An
  // account with no live profiles left cannot use any surface.
  const account = await db.account.findUnique({
    where: { id: session.accountId },
    select: {
      id: true,
      teachers: {
        where: { deletedAt: null },
        select: { id: true, defaultTimezone: true },
      },
      students: {
        where: { deletedAt: null },
        select: { id: true },
      },
    },
  });

  const liveTeacher = account ? liveProfile(account.teachers) : null;
  const liveStudent = account ? liveProfile(account.students) : null;
```

Everything below (`if (!account || (!liveTeacher && !liveStudent))` onward) is unchanged.

This translation needs no new test. `src/lib/auth/session.test.ts` already
pins all three outcomes — a soft-deleted student side disappearing, a
soft-deleted teacher side disappearing with its `defaultTimezone`, and the
session dying when every profile is erased. They are the guard on this edit;
if the query filter is written wrong they go red. Run that file specifically
after this step rather than waiting for Step 13.

- [ ] **Step 6: Translate `src/lib/auth/account.ts`**

Add `import { liveProfile } from '@/lib/live-profile';`. Replace the account read and the `if (account)` block (currently lines 31-47) with:

```ts
  const account = await db.account.findUnique({
    where: { email },
    select: {
      id: true,
      teachers: { where: { deletedAt: null }, select: { id: true } },
      students: { where: { deletedAt: null }, select: { id: true } },
    },
  });
  if (account) {
    // Erased (soft-deleted) profiles never resurface through sign-in — the
    // selects above are where that is enforced.
    return {
      accountId: account.id,
      teacherId: liveProfile(account.teachers)?.id ?? null,
      studentId: liveProfile(account.students)?.id ?? null,
    };
  }
```

- [ ] **Step 7: Translate `src/app/api/auth/passkey/register/options/route.ts`**

Add `import { liveProfile } from '@/lib/live-profile';`. Replace lines 16-31 with:

```ts
  // The passkey belongs to the account; name it after whichever LIVE profile
  // exists (teacher first — the account email is the same either way). The
  // `deletedAt` filters are not decoration: an erasure anonymises the row's
  // name to "Deleted Teacher"/"Deleted Student", and this display name lands
  // permanently in the viewer's own credential manager (#623).
  const account = await prisma.account.findUnique({
    where: { id: session.accountId },
    select: {
      email: true,
      teachers: {
        where: { deletedAt: null },
        select: { firstName: true, lastName: true },
      },
      students: {
        where: { deletedAt: null },
        select: { firstName: true, lastName: true },
      },
    },
  });
  if (!account) {
    return respondError('Account not found', 404);
  }
  const profile = liveProfile(account.teachers) ?? liveProfile(account.students);
  if (!profile) {
    return respondError('Account has no profile', 404);
  }
```

- [ ] **Step 8: Translate `src/app/api/auth/passkey/authenticate/verify/route.ts`**

Add `import { liveProfile } from '@/lib/live-profile';`. Replace lines 50-54 with:

```ts
  const account = await prisma.account.findUnique({
    where: { id: credential.accountId },
    select: { teachers: { where: { deletedAt: null }, select: { id: true } } },
  });
  const hasTeacherProfile = account !== null && liveProfile(account.teachers) !== null;
```

Bind `account` and test it before the call rather than writing
`liveProfile(account?.teachers ?? [])`: an empty array literal infers
`never[]`, which makes the type parameter `never` and the result unusable
under `strict`.

- [ ] **Step 9: Translate `src/services/invitations.ts`**

Add `import { liveProfile } from '@/lib/live-profile';` to the imports. Replace lines 665-674 with:

```ts
  // Only an address with no `Student` row gets here, so an account holding
  // both profiles was answered above. Who each branch reaches:
  // `docs/data-model.md` (Invitation, "Who an invitation reaches").
  //
  // The `deletedAt` filter is load-bearing. An account may hold erased
  // teacher rows beside a live one, so a row's existence no longer means a
  // teacher is there to read a notification — and an unfiltered read could
  // address this dispatch to a tombstone.
  const account = await db.account.findUnique({
    where: { email },
    select: { teachers: { where: { deletedAt: null }, select: { id: true } } },
  });
  const inviteeTeacher = account ? liveProfile(account.teachers) : null;
  if (inviteeTeacher) {
    const inviteeTeacherId = inviteeTeacher.id;
```

Everything inside that branch, and the stranger-email path after it, is unchanged.

- [ ] **Step 10: Run the constraint test and confirm it now passes**

Run: `pnpm exec vitest run --project integration tests/integration/live-profile-unique.test.ts`

Expected: PASS, 4 tests. The two that failed at Step 2 now pass.

- [ ] **Step 11: Write the two liveness regression tests**

Both prove a site that has **no** liveness filter today does not hand work to
a tombstone once erased rows may sit beside live ones.

In `src/services/invitations.notify.test.ts`, add a case to the existing
`describe`. It reuses that file's `prisma`, `suffix` and `teacherId` (the
inviter created in its `beforeAll`) rather than introducing new fixtures:

```ts
  it('notifies the live teacher, not an erased one on the same account (#623)', async () => {
    const address = `erased-beside-live-${suffix}@test.local`;
    const account = await prisma.account.create({ data: { email: address } });
    const erased = await prisma.teacher.create({
      data: {
        accountId: account.id,
        firstName: 'Deleted', lastName: 'Teacher',
        email: `erased-beside-live-${suffix}@deleted.invalid`,
        bio: '', pageSlug: `erased-beside-live-${suffix}`,
        deletedAt: new Date(),
      },
    });
    const live = await prisma.teacher.create({
      data: {
        accountId: account.id,
        firstName: 'Live', lastName: 'Teacher',
        email: address,
        bio: '', pageSlug: `live-beside-erased-${suffix}`,
      },
    });
    const invitation = await prisma.invitation.create({
      data: { teacherId, email: address },
    });

    await notifyInvitee(prisma, {
      teacherId,
      email: address,
      teacherName: 'Notify Teacher',
      invitationId: invitation.id,
      claimedAt: new Date(),
    });

    // Scoped to these two ids rather than counting every teacher_invitation
    // in the database: other cases in this file create their own.
    const notified = await prisma.notification.findMany({
      where: {
        recipientType: 'teacher',
        type: 'teacher_invitation',
        recipientId: { in: [live.id, erased.id] },
      },
      select: { recipientId: true },
    });
    expect(notified).toHaveLength(1);
    expect(notified[0].recipientId).toBe(live.id);
  });
```

Register `account.id` and both teacher ids for cleanup in that file's existing
`afterAll`, following how it already tears down its own teachers.

In `tests/integration/passkey-api.test.ts`, add a new `describe` — the file's
existing ones cover the authenticate routes and have no session fixture. Add
`cookie` and `seedSession` to its import from `../helpers`:

```ts
/**
 * #623. `account.teacher ?? account.student` filtered neither side for
 * liveness, so an account whose teacher side was erased named its credential
 * after the tombstone — and an erasure anonymises that name to "Deleted
 * Teacher". A passkey's display name lands permanently in the viewer's own
 * credential manager, so this is not a cosmetic string.
 */
describe('POST /api/auth/passkey/register/options', () => {
  const suffix = uniqueSuffix();
  const accountIds: string[] = [];
  let token: string;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { email: `pk-live-name-${suffix}@test.local` },
    });
    accountIds.push(account.id);
    // The erased teacher is deliberately the `??`'s LEFT operand: an
    // unfiltered read selects it, which is the regression being pinned.
    await prisma.teacher.create({
      data: {
        accountId: account.id,
        firstName: 'Deleted', lastName: 'Teacher',
        email: `pk-erased-teacher-${suffix}@deleted.invalid`,
        bio: '', pageSlug: `pk-erased-teacher-${suffix}`,
        deletedAt: new Date(),
      },
    });
    await prisma.student.create({
      data: {
        accountId: account.id,
        firstName: 'Live', lastName: 'Student',
        email: `pk-live-name-${suffix}@test.local`,
        claimedAt: new Date(),
      },
    });
    token = await seedSession(prisma, account.id);
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  it('names the credential after the live profile, not an erased one (#623)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/register/options`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.user.displayName).toBe('Live Student');
  });
});
```

- [ ] **Step 12: Run both regression tests**

Run: `pnpm exec vitest run --project unit src/services/invitations.notify.test.ts`
Run: `pnpm exec vitest run --project integration tests/integration/passkey-api.test.ts`

Expected: PASS. If the passkey case passes without the Step 7 edit applied, the fixture is wrong — the erased teacher must be the one the old `??` would have selected.

- [ ] **Step 13: Run the whole suite**

Run: `pnpm run typecheck`, then `pnpm exec vitest run --project unit --project components`, then `pnpm exec vitest run --project unit-sweeps --project integration`.

Expected: green. `pnpm test` chains its two invocations with `&&`, so while anything in the first is red the second never runs and reports nothing — run the tiers separately until the first is green.

- [ ] **Step 14: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/auth/session.ts src/lib/auth/account.ts src/services/invitations.ts src/app/api/auth/passkey/register/options/route.ts src/app/api/auth/passkey/authenticate/verify/route.ts tests/integration/live-profile-unique.test.ts src/services/invitations.notify.test.ts tests/integration/passkey-api.test.ts
git commit -m "feat(accounts): one LIVE profile per account, not one ever (#623)"
```

---

## Task 3: The acceptance criteria, over HTTP, with the guard proven

**Files:**
- Test: `tests/integration/erased-profile-restart.test.ts` (create)

**Interfaces:**
- Consumes: the partial indexes and the translated sites from Task 2.
- Produces: nothing other tasks depend on.

This is issue #623's acceptance criteria 1 and 3, asserted end to end at the HTTP layer rather than at the database.

- [ ] **Step 1: Write the acceptance tests**

Create `tests/integration/erased-profile-restart.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, freshIp, seedSession, uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

/**
 * Returns the id AND the address, because a live profile's `email` is a
 * denormalised copy of the account's, set at link time. Fixtures below keep
 * them equal: the liveness reasoning this change rests on interlocks with
 * that agreement, so a fixture that let them drift would not be the state
 * under test.
 */
async function account(tag: string): Promise<{ id: string; email: string }> {
  const row = await prisma.account.create({
    data: { email: `${tag}-${suffix}@test.local` },
  });
  accountIds.push(row.id);
  return { id: row.id, email: row.email };
}

function liveTeacher(acct: { id: string; email: string }, slugTag: string) {
  return prisma.teacher.create({
    data: {
      accountId: acct.id,
      firstName: 'Live', lastName: 'Teacher',
      email: acct.email,
      bio: '', pageSlug: `${slugTag}-${suffix}`,
    },
  });
}

/**
 * Exactly what `deleteStudentAccount` (services/gdpr.ts) leaves behind: the
 * name anonymised, the address tombstoned, `deletedAt` set — and `accountId`
 * and `claimedAt` both RETAINED. The retention is the whole point; a fixture
 * that cleared them would not reproduce the state under test.
 */
function erasedStudent(accountId: string, tag: string) {
  return prisma.student.create({
    data: {
      accountId,
      firstName: 'Deleted', lastName: 'Student',
      email: `${tag}-erased-${suffix}@deleted.invalid`,
      claimedAt: new Date(), deletedAt: new Date(),
    },
  });
}

describe('an erased profile no longer bars its account (#623)', () => {
  it('gives a live teacher with an erased student side a NEW student side', async () => {
    const acct = await account('student-restart');
    await liveTeacher(acct, 'student-restart-teacher');
    const erased = await erasedStudent(acct.id, 'student-restart');
    const token = await seedSession(prisma, acct.id);

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });

    // 201, not the 409 ALREADY_STUDENT that `SetUpStudentSide` read as
    // success before navigating to a page this session could not open.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.studentId).not.toBe(erased.id);
  });

  it('opens /account/privacy for that session instead of bouncing it', async () => {
    const acct = await account('privacy-opens');
    await liveTeacher(acct, 'privacy-opens-teacher');
    await erasedStudent(acct.id, 'privacy-opens');
    const token = await seedSession(prisma, acct.id);

    await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });

    const page = await fetch(`${BASE_URL}/account/privacy`, {
      headers: { ...cookie(token), ...freshIp() },
    });

    // Acceptance criterion 3. Before this change the `(student)` layout found
    // no `session.studentId` and redirected to `/schedule` saying nothing.
    expect(page.status).toBe(200);
    expect(new URL(page.url).pathname).toBe('/account/privacy');
  });

  it('gives a live student with an erased teacher side a NEW teacher side', async () => {
    const acct = await account('teacher-restart');
    await prisma.student.create({
      data: {
        accountId: acct.id,
        firstName: 'Live', lastName: 'Student',
        email: acct.email,
        claimedAt: new Date(),
      },
    });
    await prisma.teacher.create({
      data: {
        accountId: acct.id,
        firstName: 'Deleted', lastName: 'Teacher',
        email: `teacher-restart-erased-${suffix}@deleted.invalid`,
        bio: '', pageSlug: `teacher-restart-erased-${suffix}`,
        deletedAt: new Date(),
      },
    });
    const token = await seedSession(prisma, acct.id);

    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
      body: JSON.stringify({
        firstName: 'Second', lastName: 'Innings', bio: '',
        pageSlug: `teacher-restart-new-${suffix}`,
      }),
    });

    expect(res.status).toBe(201);
  });

  it('still answers ALREADY_STUDENT when the student side is genuinely live', async () => {
    const acct = await account('already-live');
    await liveTeacher(acct, 'already-live-teacher');
    await prisma.student.create({
      data: {
        accountId: acct.id,
        firstName: 'Already', lastName: 'Live',
        email: acct.email,
        claimedAt: new Date(),
      },
    });
    const token = await seedSession(prisma, acct.id);

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });

    // This exercises the route's PRE-CHECK (`if (session.studentId)`), which
    // returns before the create is attempted — not the catch. Worth pinning
    // in its own right: the pre-check is what keeps `ALREADY_STUDENT` meaning
    // "you already have a live student side" now that an erased one no longer
    // produces that code. The proof that `isUniqueConflictOn(err,
    // ['accountId'])` still matches over a PARTIAL index is Task 2's
    // constraint test, which asserts that predicate on a real violation.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_STUDENT');
  });
});
```

Note the second case navigates rather than asserting on the first case's
response: acceptance criterion 3 is about the page opening, and only a real
request through the `(student)` layout can show that.

- [ ] **Step 2: Run them and confirm they pass**

Run: `pnpm exec vitest run --project integration tests/integration/erased-profile-restart.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 3: Prove the guard bites — mutate the index**

The tests above pass because of Task 2's indexes. Demonstrate that by removing what they rest on. Against the worktree database:

```sql
DROP INDEX "Student_account_live_unique";
CREATE UNIQUE INDEX "Student_account_live_unique" ON "Student" ("accountId");
```

Run the acceptance file again. Expected: the first two cases FAIL — the POST answers `409` where `201` is expected, and `/account/privacy` redirects away. Record the exact assertion text in the task report.

Those fixtures still build under the mutation — the erased student is the account's only `Student` row at that point — so the failure is the POST's refusal, not a broken fixture. That is what makes this a mutation of the guard rather than of the test.

- [ ] **Step 4: Restore and re-verify**

```sql
DROP INDEX "Student_account_live_unique";
CREATE UNIQUE INDEX "Student_account_live_unique" ON "Student" ("accountId") WHERE "deletedAt" IS NULL;
```

Run the acceptance file again. Expected: PASS, 4 tests. Confirm the restored index matches the migration's definition exactly.

The mutation lives in the database, not in a file, so restoring it is a SQL statement and cannot discard uncommitted work the way a `git checkout` of a mutated source file would.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/erased-profile-restart.test.ts
git commit -m "test(accounts): an erased profile no longer bars its account (#623)"
```

---

## Task 4: The claims this change falsifies

**Files:**
- Modify: `scripts/verify-account-backfill.sql`
- Modify: `docs/data-model.md`
- Modify: `src/services/rule-lifecycle.ts`
- Modify: `src/app/api/account/teacher-profile/route.ts`
- Modify: `src/app/api/account/student-profile/route.ts`
- Modify: `src/lib/unique-conflict.ts`
- Modify: `tests/integration/account-api.test.ts`

**Interfaces:**
- Consumes: Task 2's index names.
- Produces: nothing.

Comment and documentation only, except the SQL invariant. No behaviour changes, so this is reviewable as one diff. **Correct each claim by replacing it, never by annotating it** — "this previously read X" turns one stale sentence into two. The before-and-after belongs in the PR body.

- [ ] **Step 1: Re-derive the partial-index census**

Run against the worktree database:

```sql
SELECT indexname FROM pg_indexes WHERE schemaname='public'
  AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%WHERE%';
```

Expected: 4 rows — `Room_public_identity_unique`, `Room_private_identity_unique`, `Teacher_account_live_unique`, `Student_account_live_unique`. Record the output; Step 2 cites it.

- [ ] **Step 2: Correct `src/lib/unique-conflict.ts:7-14`**

That docblock says a hand-authored partial index reports `meta.target` as the column-name array, "measured on `Room_private_identity_unique`". The claim holds and is now load-bearing for two more indexes. Extend the citation so it names the measurement this branch made — `Teacher_account_live_unique` and `Student_account_live_unique` reaching `isUniqueConflictOn(err, ['accountId'])` — and keep the `pg_indexes` command that re-derives the set. Do not write a count.

- [ ] **Step 3: Correct `src/services/rule-lifecycle.ts:1087`**

Currently: ``Teacher.email`, `pageSlug` and `accountId` are all `@unique`, so an update touching any of them … takes `FOR UPDATE` there instead of `FOR NO KEY UPDATE``.

Remove `accountId` from the roster. The conclusion stands on `email` and `pageSlug`, both still plainly `@unique` in the model next door. Do **not** replace it with a claim about whether Postgres counts a partial unique index among a relation's key columns — that is unmeasured here and nothing in the repository updates `Teacher.accountId` at all.

- [ ] **Step 4: Correct the two profile routes**

- `src/app/api/account/teacher-profile/route.ts:44` and `src/app/api/account/student-profile/route.ts:120` both say "every branch of the catch below names a unique constraint on the … row". One branch now names a partial unique *index*, a distinction `unique-conflict.ts` treats as load-bearing. Reword so it covers both.
- `src/app/api/account/teacher-profile/route.ts:92`'s log string says "neither the slug, the email nor the account key". "The account key" no longer names anything. Reword to the column it actually means.

- [ ] **Step 5: Correct `tests/integration/account-api.test.ts:821`**

That comment names `Student_accountId_key`, which this branch drops. Replace the name with `Student_account_live_unique`. Confirm the surrounding explanation — that a session-path double-tap leaves a pending entry in both the account and the email key, so Postgres reports whichever it reaches first — is still accurate, and that the test it annotates still passes.

- [ ] **Step 6: Correct `docs/data-model.md`**

Three places:
- `:18` — "linked to it via their own **unique** `account_id`". The uniqueness is now partial. State what it is: at most one LIVE profile of each kind per account, and name the two indexes.
- `:659` — the same claim in the Account section. Correct it the same way.
- `:151` — "an erased *teacher's* account keeps a truthy `account.teacher` (the erasure is a soft delete)". This names a field that no longer exists and rests on the behaviour being restructured. Restate it for the list relation and the liveness filter. `src/services/invitations.ts` cites this section for who each branch reaches, so the two must agree after this edit — re-read that comment against the corrected text.

- [ ] **Step 7: Add the standing invariant**

In `scripts/verify-account-backfill.sql`, whose header already promises every count in it is zero, add both tables:

```sql
SELECT 'accounts with two live students' AS invariant, count(*) FROM (
  SELECT "accountId" FROM "Student"
   WHERE "accountId" IS NOT NULL AND "deletedAt" IS NULL
   GROUP BY "accountId" HAVING count(*) > 1) t;

SELECT 'accounts with two live teachers' AS invariant, count(*) FROM (
  SELECT "accountId" FROM "Teacher"
   WHERE "deletedAt" IS NULL
   GROUP BY "accountId" HAVING count(*) > 1) t;
```

Run the file against the worktree database and confirm both return 0.

- [ ] **Step 8: Sweep for what was invalidated, not what was edited**

Grep the repository for the names this branch removed and give every hit a verdict. Expect legitimate survivors — migration history is one.

```bash
grep -rn "Teacher_accountId_key\|Student_accountId_key" --include="*.ts" --include="*.tsx" --include="*.md" --include="*.prisma" --include="*.sql" .
grep -rn "account\.teacher\b\|account\.student\b\|account?\.teacher\b\|account?\.student\b" src tests docs --include="*.ts" --include="*.tsx" --include="*.md"
```

Files under `prisma/migrations/` and dated records under `docs/superpowers/specs/` and `docs/superpowers/plans/` are legitimate survivors: a migration is immutable and a plan is a record of what was decided then. Everything else needs a verdict recorded in the task report.

- [ ] **Step 9: Run the full verification**

Run: `pnpm run verify`

Expected: green. If anything earlier in the chain is red, run `pnpm exec vitest run --project integration` directly rather than reading a red `verify` as evidence about that tier.

- [ ] **Step 10: Commit**

```bash
git add scripts/verify-account-backfill.sql docs/data-model.md src/services/rule-lifecycle.ts src/app/api/account/teacher-profile/route.ts src/app/api/account/student-profile/route.ts src/lib/unique-conflict.ts tests/integration/account-api.test.ts
git commit -m "docs(accounts): correct what the hard unique key's removal falsifies (#623)"
```

---

## After the tasks

With four tasks, the whole-branch review applies: one review on the most capable model, one fix wave, one scoped re-review, before the PR.

**For the PR body, carry forward:**

- The three premise corrections from the spec's §1, including that `JoinAsStudent` has never navigated to `/account/privacy` and the command that re-derives it.
- Case 2 closed with its measurement — population 0 and unfillable, both `Student` creators setting `claimedAt` unconditionally.
- The passkey display name folded in (§6), and `JoinAsStudent`'s loose 409 handling declined with its path named (§7).
- The mutation result from Task 3 Step 3 — the exact text the acceptance case failed with when the index was made non-partial.
- The partial-index census going from 2 to 4, with the `pg_indexes` command.
- That `/inbox/invitations`'s copy — "Connecting adds a student side to your account" — needed no change: this fix makes it true for the erased-student account rather than correcting it.
- Which `integration` files this branch touched, by path: `tests/integration/live-profile-unique.test.ts`, `tests/integration/erased-profile-restart.test.ts`, `tests/integration/passkey-api.test.ts`, `tests/integration/account-api.test.ts`.
- **#622 is unaffected.**
