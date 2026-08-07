# Email Normalisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Foo@x.com` and `foo@x.com` the same person, by normalising every
email at HTTP ingress through one Zod primitive and rejecting anything
non-lowercase at the database.

**Architecture:** One invariant — *every email column is lowercase* — stated in
exactly two places. `emailField` in `src/lib/schemas.ts` normalises the six
address fields that arrive over HTTP; four `CHECK (email = lower(email))`
constraints reject anything reaching storage by another route (seed, GDPR
anonymisation, raw SQL). The 15 scattered `.toLowerCase()` / `mode:'insensitive'`
compensations that exist only because the invariant did not hold are then
deleted.

**Tech Stack:** TypeScript strict, Zod 4.4.3, Prisma + PostgreSQL 16, Vitest
(projects: `unit`, `integration`, `components`), Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-08-07-email-normalisation-design.md`
**Issue:** #170 · **Branch:** `fix/170-email-normalisation`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `npm run typecheck`
  must be clean at the end of every task.
- **Never run `npx vitest run --project integration` without a file path.** One
  file in that project is IP rate-limited and a whole-project run trips it. Run
  single files by explicit path.
- **Never start or restart the dev server on :3000.** The user runs it. If a
  change needs it restarted (a Prisma client regeneration does), *ask the user*
  and wait.
- **Never edit an applied migration.** Create a new one.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths
  containing parentheses: `"src/app/(teacher)/..."`.
- **`docs/backlog-roadmap.md` is untracked and must stay untracked.** Never stage
  it.
- **Prisma cannot express CHECK constraints.** Hand-author them, following
  `prisma/migrations/20260805074500_invitation_check_constraints/migration.sql`
  for both SQL structure and its explanatory-docblock style.
- **Every guard gets a break-record-restore step.** A pin that compiles but
  cannot fail certifies nothing. Break it, record the *verbatim* error, restore,
  re-verify. This is a required step, not a suggestion.
- **The `unit` project auto-migrates the test database.** `tests/setup/unit-db.ts`
  runs `prisma migrate deploy` against `DATABASE_URL_TEST` on every `unit` run,
  so a new migration reaches `ethical_yoga_test` automatically. The `integration`
  project talks to the app on :3000, which reads `ethical_yoga` (dev) — that one
  is migrated by `npx prisma migrate dev`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/schemas.ts` | Owns `emailField`; the six address fields adopt it | 1 |
| `src/lib/schemas.test.ts` | Exhaustive pin: every exported schema with an `email` key normalises | 1 |
| `tests/integration/auth-email-case.test.ts` | **Create.** The three user-facing regressions | 1 |
| `prisma/migrations/<ts>_email_lowercase_checks/migration.sql` | **Create.** Backfill, then 4 CHECK constraints | 2 |
| `tests/integration/email-lowercase-constraints.test.ts` | **Create.** Each constraint rejects uppercase, at the database | 2 |
| `src/services/invitations.ts` | 7 compensations removed; 2 lookups revert to `findUnique` | 3 |
| `src/services/gdpr.ts` | 2 compensations removed | 3 |
| `src/services/link-consent.ts` | 1 compensation removed | 3 |
| `src/app/api/students/route.ts` | 1 compensation removed | 3 |
| `src/app/api/invitations/[id]/route.ts` | 1 compensation removed | 3 |
| `src/app/api/auth/magic-link/send/route.ts` | 1 rate-limit-key compensation removed | 3 |
| `src/app/api/auth/student-signup/route.ts` | 1 rate-limit-key compensation removed | 3 |
| `docs/data-model.md` | Lowercase invariant extended to four more tables | 4 |

**Task order is load-bearing and non-negotiable.** Task 2's CHECK constraints can
only land *after* Task 1's normalisation, or an integration test posting mixed
case returns 500 instead of passing. Task 3's deletions are safe only once Tasks
1 and 2 both hold. Do not reorder.

---

### Task 1: `emailField`, adopted everywhere, pinned exhaustively

**Files:**
- Modify: `src/lib/schemas.ts` (add module-private primitive in the shared-validators section after line 17; adopt at lines 44, 51, 64, 97, 137, 148)
- Modify: `src/lib/schemas.test.ts` (append one `describe` block)
- Create: `tests/integration/auth-email-case.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a **module-private** `emailField` in `src/lib/schemas.ts` — not
  exported. Task 3 relies on its existence to justify deleting the 13
  compensations; Task 2's constraints assume it is already normalising. Neither
  imports it.

> **Do not export it.** The three existing shared field validators in this file
> — `isoDate`, `timeHHmm`, `relativePath` — are all module-private `const`, and
> nothing outside `schemas.ts` validates an email (measured: `grep -rn "\.email()"`
> over `src/` returns hits only in that file). An earlier draft of this plan said
> `export const`, and it broke the build: `schemas.test.ts`'s server-owned-field
> walk asserts that every exported `ZodType` has a readable `.shape`, and a field
> primitive has none. The walk is correct and must not be weakened to accommodate
> an export nothing needs.

- [ ] **Step 1: Write the failing schema pin**

Append to `src/lib/schemas.test.ts`. This walks the module rather than listing
schemas by hand, so a seventh schema with an `email` field is covered
automatically — the same philosophy as the `SERVER_OWNED_FIELDS` walk already in
this file.

```ts
describe('email fields normalise', () => {
  // Exhaustive by construction: walks every export rather than a hand-kept
  // list, so a new schema with an `email` field is covered the moment it is
  // written. The roster assertion below is what makes adding one a deliberate
  // act rather than a silent opt-out.
  //
  // Asserts against `shape.email` — the field schema — not the parent object,
  // because parsing the parent would need valid values for every sibling
  // required field and would test those instead.
  const emailBearing: string[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    if (!(schema instanceof z.ZodType)) continue;
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (!shape || !('email' in shape)) continue;
    emailBearing.push(name);
  }

  it('covers exactly the six schemas that carry an address', () => {
    expect([...emailBearing].sort()).toEqual([
      'createInvitationSchema',
      'createTeacherSchema',
      'magicLinkSendSchema',
      'passkeyAuthOptionsSchema',
      'studentSignupSchema',
      'updateInvitationSchema',
    ]);
  });

  it.each(emailBearing)('%s lowercases its email field', (name) => {
    const schema = (schemas as Record<string, unknown>)[name];
    const shape = (schema as { shape: Record<string, unknown> }).shape;
    const field = shape.email as z.ZodType<unknown, unknown>;
    expect(field.parse('Mixed@Example.COM')).toBe('mixed@example.com');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run --project unit src/lib/schemas.test.ts -t "email fields normalise"
```

Expected: the roster test PASSES (six schemas already carry the field), and all
six `lowercases its email field` cases FAIL with
`expected 'Mixed@Example.COM' to be 'mixed@example.com'`.

**Record the verbatim failure for one case in the task report.** If the roster
test fails instead, the export list has changed since the spec was measured —
stop and report rather than editing the expected array to match.

- [ ] **Step 3: Write the three failing integration regressions**

Create `tests/integration/auth-email-case.test.ts`. These are the user-facing
defect, asserted through the HTTP app rather than through a schema.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * #170. The stored address is lowercase; the caller types whatever they type.
 * Every fixture below is created lowercase and then addressed in mixed case —
 * an all-lowercase probe would pass against the unfixed code and prove nothing.
 */
describe('sign-in and signup are case-insensitive on email', () => {
  const studentEmail = `case-student-${suffix}@test.local`;
  const teacherEmail = `case-teacher-${suffix}@test.local`;
  let studentAccountId = '';
  let teacherAccountId = '';

  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Case', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { accountId: true },
    });
    studentAccountId = student.accountId ?? '';

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Case', lastName: 'Teacher', email: teacherEmail,
        bio: 'Fixture for #170', pageSlug: `case-teacher-${suffix}`,
        account: { create: { email: teacherEmail } },
      },
      select: { accountId: true },
    });
    teacherAccountId = teacher.accountId;
  });

  afterAll(async () => {
    await prisma.magicLinkToken.deleteMany({
      where: { email: { in: [studentEmail, teacherEmail] } },
    });
    await prisma.student.deleteMany({ where: { email: studentEmail } });
    await prisma.teacher.deleteMany({ where: { email: teacherEmail } });
    await prisma.account.deleteMany({
      where: { id: { in: [studentAccountId, teacherAccountId].filter(Boolean) } },
    });
    await prisma.$disconnect();
  });

  it('issues a magic-link token when the address is typed in mixed case', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/magic-link/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: studentEmail.toUpperCase() }),
    });
    expect(res.status).toBe(200);

    // The route answers 200 either way to prevent enumeration, so the response
    // body cannot distinguish success from silent failure. The token row is the
    // only observable difference — assert on it, not on the message.
    const tokens = await prisma.magicLinkToken.findMany({
      where: { email: studentEmail },
    });
    expect(tokens).toHaveLength(1);
  });

  it('does not create a second Account for a mixed-case signup', async () => {
    const before = await prisma.account.count();

    const res = await fetch(`${BASE_URL}/api/auth/student-signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Dup', lastName: 'Attempt',
        email: studentEmail.toUpperCase(),
      }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.account.count()).toBe(before);
    expect(await prisma.account.count({ where: { email: studentEmail } })).toBe(1);
  });

  it('finds a passkey account when the address is typed in mixed case', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/authenticate/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: teacherEmail.toUpperCase() }),
    });
    expect(res.status).toBe(200);

    // No credential is registered for this fixture, so the assertion is that
    // the route resolved the account at all rather than that ids came back.
    // A 200 with the account unresolved is indistinguishable here, so this
    // test is the weakest of the three — it is the mutation check in Step 7
    // that gives it teeth.
    const body = await res.json();
    expect(body).toHaveProperty('data.options');
  });
});
```

- [ ] **Step 4: Run them and confirm the first two fail**

```bash
npx vitest run --project integration tests/integration/auth-email-case.test.ts
```

Expected: test 1 FAILS (`expected [] to have a length of 1`) — the raw-string
lookup misses, so no token is issued. Test 2 FAILS (account count grew by 1).
Test 3 may pass; that is expected and is why Step 7 mutation-checks it.

**Record both verbatim failures in the task report.** This is the evidence the
issue's premise was real.

- [ ] **Step 5: Add the primitive and adopt it**

In `src/lib/schemas.ts`, in the `// Shared field validators` section at the top
of the file — immediately after `timeHHmm` (line 17) and before the
`MAX_CLASS_SIZE` docblock — add the following. It goes there, beside `isoDate`
and `timeHHmm`, because it is cross-cutting: AUTH schemas and STUDENTS schemas
both use it. Note it is `const`, **not** `export const`:

```ts
/**
 * Every email that enters over HTTP, lowercased once (#170).
 *
 * Postgres compares these columns case-sensitively under `en_US.utf8`, and the
 * unique keys on Account/Teacher/Student are plain btree over the raw column —
 * so without this, `Foo@x.com` and `foo@x.com` are two distinct keys. That cost
 * a person their sign-in (the lookup misses and the route still answers "if an
 * account exists, a magic link has been sent") and could hand them a second
 * Account with their bookings split across both.
 *
 * Field-level, deliberately: an object-level `.transform()` would remove the
 * schema's `.shape` and blind the server-owned-field walk in `schemas.test.ts`.
 * A field-level one does not — measured against Zod 4.4.3, `.shape` stays
 * readable and the walk still sees every key.
 *
 * This normalises HTTP ingress only. Writers that bypass Zod — `prisma/seed.ts`,
 * `gdpr.ts`'s anonymisation, raw SQL — are not normalised, they are rejected by
 * the `*_email_lowercase_check` constraints. That asymmetry is intentional: a
 * writer that skips the schema layer should fail loudly, not be quietly fixed.
 */
const emailField = z.string().email().transform((s) => s.toLowerCase());
```

Module-private, matching `isoDate`, `timeHHmm` and `relativePath` above it.
Exporting it fails `schemas.test.ts`'s server-owned-field walk, which requires
every exported `ZodType` to have a readable `.shape` — a field primitive has
none, and that walk is right to refuse to guess.

Then replace the address field at each of the six sites. Lines 44, 51, 97 and 137
become:

```ts
  email: emailField,
```

Lines 64 and 148 (both currently `z.string().email().optional()`) become:

```ts
  email: emailField.optional(),
```

- [ ] **Step 6: Run both suites and confirm they pass**

```bash
npx vitest run --project unit src/lib/schemas.test.ts
npx vitest run --project integration tests/integration/auth-email-case.test.ts
npm run typecheck
```

Expected: all three green. `schemas.test.ts` must pass **in full**, not only the
new block — the `SERVER_OWNED_FIELDS` walk runs in this file and the whole point
of choosing a field-level transform was that it stays readable.

**If the `are declared only where EXPECTED says so` test now fails**, the
transform has hidden a `.shape` after all. Stop and report — do not work around
it by extending the register.

- [ ] **Step 7: Prove each guard bites**

Three mutations, each recorded verbatim, each restored before the next.

1. Revert **line 44 only** (`magicLinkSendSchema.email`) to
   `z.string().email()`. Run
   `npx vitest run --project unit src/lib/schemas.test.ts -t "email fields normalise"`.
   Expected: exactly one case fails, naming `magicLinkSendSchema`. Record it.
   Restore.
2. With line 44 still reverted, run
   `npx vitest run --project integration tests/integration/auth-email-case.test.ts`.
   Expected: the magic-link test fails. Record it. Restore.
3. Delete one entry from the roster array in the pin. Run the unit file.
   Expected: the roster test fails naming the missing schema. Record it. Restore.

- [ ] **Step 8: Measure the `z.infer` risk the spec flagged**

`src/components/students/create-student-form.tsx:30` and
`src/components/students/contact-form.tsx:19` derive their wire types via
`z.infer<typeof createInvitationSchema>` / `<typeof updateInvitationSchema>`.
`z.infer` is the **output** type, and a transform can make input and output
diverge.

```bash
npm run typecheck
npx vitest run --project components src/components/students/create-student-form.test.tsx src/components/students/contact-form.test.tsx
```

Expected: clean, because `string → string` leaves both sides `string`.

**If either reports an error**, do not widen the type to silence it. The correct
fix is `z.input<typeof …>` on those two lines, and it is a latent defect this
change exposed rather than created — apply it and say so explicitly in the task
report so the PR body can record it.

- [ ] **Step 9: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts tests/integration/auth-email-case.test.ts
git commit -m "fix: one email primitive normalises at ingress, and mixed-case sign-in stops failing silently (#170)"
```

---

### Task 2: The migration and its constraint tests

**Files:**
- Create: `prisma/migrations/<timestamp>_email_lowercase_checks/migration.sql`
- Create: `tests/integration/email-lowercase-constraints.test.ts`

**Interfaces:**
- Consumes: `emailField` from Task 1 — the constraints assume HTTP ingress is
  already normalised, or every mixed-case request becomes a 500.
- Produces: four constraints named `Account_email_lowercase_check`,
  `Teacher_email_lowercase_check`, `Student_email_lowercase_check`,
  `MagicLinkToken_email_lowercase_check`. Task 3 relies on these existing to
  justify deleting the compensations.

- [ ] **Step 1: Create the empty migration**

```bash
npx prisma migrate dev --create-only --name email_lowercase_checks
```

`prisma/schema.prisma` is unchanged, so this produces an empty `migration.sql`
directory to hand-fill — the same route
`20260805074500_invitation_check_constraints` took.

- [ ] **Step 2: Write the migration SQL**

Replace the generated `migration.sql` with the following, in this order. The
prose docblock is required, matching the precedent's style.

```sql
-- Invariant, DB-enforced: every stored email address is lowercase (#170).
--
-- Postgres compares text case-sensitively under this database's `en_US.utf8`
-- collation, and the unique keys on Account, Teacher and Student are plain
-- btree over the raw column. Without this constraint `Foo@x.com` and
-- `foo@x.com` are two distinct keys: sign-in looks accounts up with the raw
-- string and misses (answering "if an account exists, a magic link has been
-- sent" either way), and the pre-create uniqueness gates in
-- `POST /api/auth/student-signup` and `POST /api/teachers` walk straight past
-- both the gate and the index, producing a second Account for one human.
--
-- `emailField` in `src/lib/schemas.ts` normalises everything arriving over
-- HTTP. This constraint covers what does not: `prisma/seed.ts`, the five
-- synthesized `deleted-<uuid>@deleted.invalid` addresses `gdpr.ts` writes
-- during erasure (uuid is lowercase hex, so they satisfy it), test fixtures,
-- and psql. Those are rejected rather than rewritten — a writer that skips the
-- schema layer should fail loudly.
--
-- Mirrors `20260805074500_invitation_check_constraints`, which did the same for
-- the two columns #166 added. Those two are already constrained and untouched
-- here.

-- Backfill first, because `ADD CONSTRAINT ... CHECK` validates rows that
-- already exist — measured:
--
--   ERROR:  check constraint "probe_lower" of relation "probe_check"
--           is violated by some row
--
-- so on any database holding one mixed-case row, the constraint below fails
-- without this. A measured no-op on both `ethical_yoga` (711 accounts) and
-- `ethical_yoga_test` (10,636) at authoring time, and fair.yoga has no
-- production data — this exists for a contributor's database nobody has
-- measured, where `db:reset` would be the alternative and would destroy their
-- work.
--
-- There is deliberately NO collision pre-check here. Two rows differing only
-- in case would collide on the unique key, and an earlier draft guarded that
-- with a `DO $$ ... RAISE EXCEPTION` block. Both of its justifications were
-- measured false. Prisma 6.19.3 runs each migration in a transaction, so a
-- collision rolls the whole file back having changed nothing — verified by
-- applying a deliberately-colliding migration and confirming its first
-- statement left no row behind. And Postgres's own error is *better* than the
-- one that block raised, because it names the offending address rather than
-- counting them:
--
--   ERROR: duplicate key value violates unique constraint "Account_email_key"
--   DETAIL: Key (email)=(foo@x.com) already exists.
--
-- MagicLinkToken cannot collide at all: its `email` column carries no unique
-- index.
UPDATE "Account"        SET email = lower(email) WHERE email <> lower(email);
UPDATE "Teacher"        SET email = lower(email) WHERE email <> lower(email);
UPDATE "Student"        SET email = lower(email) WHERE email <> lower(email);
UPDATE "MagicLinkToken" SET email = lower(email) WHERE email <> lower(email);

ALTER TABLE "Account" ADD CONSTRAINT "Account_email_lowercase_check"
  CHECK (email = lower(email));

ALTER TABLE "Teacher" ADD CONSTRAINT "Teacher_email_lowercase_check"
  CHECK (email = lower(email));

ALTER TABLE "Student" ADD CONSTRAINT "Student_email_lowercase_check"
  CHECK (email = lower(email));

ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_email_lowercase_check"
  CHECK (email = lower(email));
```

- [ ] **Step 3: Apply it and confirm it ran**

```bash
npx prisma migrate dev
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -tAc \
  "SELECT conname FROM pg_constraint WHERE conname LIKE '%email_lowercase_check' ORDER BY conname;"
```

Expected six constraint names: the four new ones plus
`Invitation_email_lowercase_check` and `TeacherBlock_email_lowercase_check` from
#166.

- [ ] **Step 4: Write the constraint test**

Create `tests/integration/email-lowercase-constraints.test.ts`. Modelled on
`tests/integration/invitation-constraints.test.ts`, including its two load-bearing
choices: match each constraint *by name* (a bare `rejects.toThrow()` would be
satisfied by a masking unique-key collision), and give every fixture uppercase
somewhere (an all-lowercase probe makes `email = lower(email)` indistinguishable
from `TRUE`).

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * The four CHECK constraints #170 added, asserted at the DATABASE rather than
 * through any service — same standing as `invitation-constraints.test.ts` and
 * for the same reason. `emailField` is exactly what these exist to survive; a
 * test that went through a route would prove the schema, not the constraint.
 */
describe('email lowercase check constraints', () => {
  const created: string[] = [];

  afterAll(async () => {
    await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.account.deleteMany({ where: { id: { in: created } } });
    await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.$disconnect();
  });

  it('rejects a mixed-case Account.email on create', async () => {
    await expect(
      prisma.account.create({ data: { email: `Case-Acct-${suffix}@Test.Local` } }),
    ).rejects.toThrow(/Account_email_lowercase_check/);
  });

  it('rejects a mixed-case Account.email on update, and leaves the row alone', async () => {
    const email = `case-acct-upd-${suffix}@test.local`;
    const row = await prisma.account.create({ data: { email }, select: { id: true } });
    created.push(row.id);

    await expect(
      prisma.account.update({ where: { id: row.id }, data: { email: email.toUpperCase() } }),
    ).rejects.toThrow(/Account_email_lowercase_check/);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.email).toBe(email);
  });

  it('rejects a mixed-case Teacher.email on create', async () => {
    await expect(
      prisma.teacher.create({
        data: {
          firstName: 'Mixed', lastName: 'Case',
          email: `Case-Teach-${suffix}@Test.Local`,
          bio: 'Fixture for the #170 CHECK constraints',
          pageSlug: `case-teach-${suffix}`,
          account: { create: { email: `case-teach-acct-${suffix}@test.local` } },
        },
      }),
    ).rejects.toThrow(/Teacher_email_lowercase_check/);
  });

  it('rejects a mixed-case Student.email on create', async () => {
    await expect(
      prisma.student.create({
        data: {
          firstName: 'Mixed', lastName: 'Case',
          email: `Case-Stud-${suffix}@Test.Local`,
        },
      }),
    ).rejects.toThrow(/Student_email_lowercase_check/);
  });

  it('rejects a mixed-case MagicLinkToken.email on create', async () => {
    await expect(
      prisma.magicLinkToken.create({
        data: {
          tokenHash: `case-token-${suffix}`,
          email: `Case-Token-${suffix}@Test.Local`,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow(/MagicLinkToken_email_lowercase_check/);
  });

  it('accepts the lowercase form every writer is expected to produce', async () => {
    const email = `case-ok-${suffix}@test.local`;
    const row = await prisma.account.create({ data: { email }, select: { id: true } });
    created.push(row.id);
    expect(row.id).toBeTruthy();
  });

  it("accepts gdpr.ts's synthesized erasure address", async () => {
    // `deleted-<uuid>@deleted.invalid` is the shape gdpr.ts writes at five
    // sites during erasure, bypassing Zod entirely. Prisma's `@default(uuid())`
    // is lowercase hex, so it satisfies the constraint — pinned here because a
    // CHECK that rejected it would break the right-to-erasure path, and that
    // failure would surface only when someone actually erased an account.
    //
    // Uses a real uuid rather than a hand-shaped literal: the point is that
    // whatever `uuid()` produces passes, so generating one is the honest probe.
    const row = await prisma.account.create({
      data: { email: `deleted-${randomUUID()}@deleted.invalid` },
      select: { id: true },
    });
    created.push(row.id);
    expect(row.id).toBeTruthy();
  });
});
```

- [ ] **Step 5: Run it**

```bash
npx vitest run --project integration tests/integration/email-lowercase-constraints.test.ts
```

Expected: all seven green.

- [ ] **Step 6: Prove each constraint bites**

For **each** of the four constraints, in turn:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -c \
  'ALTER TABLE "Account" DROP CONSTRAINT "Account_email_lowercase_check";'
npx vitest run --project integration tests/integration/email-lowercase-constraints.test.ts
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -c \
  'ALTER TABLE "Account" ADD CONSTRAINT "Account_email_lowercase_check" CHECK (email = lower(email));'
```

Expected with the constraint dropped: the two `Account` tests FAIL (the insert
now succeeds). **Record the verbatim failure per constraint.** Restore before
moving to the next table, and re-run the file green at the end.

This is the step that distinguishes "the test passes" from "the test is testing
the constraint". Four drops, four recorded failures, four restores.

- [ ] **Step 7: Confirm the test database got the migration**

```bash
npx vitest run --project unit src/lib/schemas.test.ts
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname LIKE '%email_lowercase_check';"
```

Expected: `6`. The `unit` project's `globalSetup` runs `prisma migrate deploy`
against `DATABASE_URL_TEST`, so this should need no manual step — verify rather
than assume.

- [ ] **Step 8: Commit**

```bash
git add prisma/migrations tests/integration/email-lowercase-constraints.test.ts
git commit -m "fix: four CHECK constraints make the lowercase email invariant unbypassable (#170)"
```

---

### Task 3: Delete the 15 compensations

**Files:**
- Modify: `src/services/invitations.ts` (lines 111, 176, 366, 383, 447, 530, 636, 791)
- Modify: `src/services/gdpr.ts` (lines 69, 414)
- Modify: `src/services/link-consent.ts` (line 63)
- Modify: `src/app/api/students/route.ts` (line 164)
- Modify: `src/app/api/invitations/[id]/route.ts` (line 100)
- Modify: `src/app/api/auth/magic-link/send/route.ts` (line 29)
- Modify: `src/app/api/auth/student-signup/route.ts` (line 29)

**Interfaces:**
- Consumes: `emailField` (Task 1) and the four constraints (Task 2). Neither
  deletion is safe without both.
- Produces: no new exports. `hasRosterLink` changes from `findFirst` to
  `findUnique` — same signature, same return type.

> **Line numbers drift.** Every line number in issue #170 was stale by up to 116
> lines. Locate each site by the function named beside it, not by the number.

- [ ] **Step 1: Delete the 13 `.toLowerCase()` calls**

| file | line | function | change |
|---|---|---|---|
| `src/services/invitations.ts` | 176 | `inviteContact` | `const email = input.email.toLowerCase();` → `const email = input.email;` |
| `src/services/invitations.ts` | 366 | `notifyInvitee` | `const email = input.email.toLowerCase();` → `const email = input.email;` |
| `src/services/invitations.ts` | 447 | `listPendingInvitations` | drop `.toLowerCase()` |
| `src/services/invitations.ts` | 530 | `acceptInvitation` | drop `.toLowerCase()` |
| `src/services/invitations.ts` | 636 | `declineInvitation` | drop `.toLowerCase()` in the `where` |
| `src/services/invitations.ts` | 791 | `unlinkTeacher` | drop `.toLowerCase()` |
| `src/services/link-consent.ts` | 63 | `resolveInvitationOnLink` | drop `.toLowerCase()` |
| `src/services/gdpr.ts` | 69 | `exportStudentData` | drop `.toLowerCase()` |
| `src/services/gdpr.ts` | 414 | `deleteStudentAccount` | drop `.toLowerCase()` |
| `src/app/api/students/route.ts` | 164 | the `deliverInvitation` call | drop `.toLowerCase()` |
| `src/app/api/invitations/[id]/route.ts` | 100 | `PUT /api/invitations/[id]` | `data: { ...rest, ...(email !== undefined ? { email } : {}) }` |
| `src/app/api/auth/magic-link/send/route.ts` | 29 | rate-limit key | `` `magic-link:email:${email}` `` |
| `src/app/api/auth/student-signup/route.ts` | 29 | rate-limit key | `` `student-signup:email:${email}` `` |

Where dropping the call leaves a local binding that no longer transforms
anything (`const email = input.email;`), inline it at its use sites instead if
that reads better — but do not change any other behaviour in the same edit.

**On the two rate-limit keys:** both routes destructure `email` from the parsed
body *before* the rate-limit call (`magic-link/send:16`, `student-signup:27`), so
the value is already normalised by the time the key is built. Verify that
ordering still holds in the file before deleting; if a future edit moved the
throttle above `parseBody`, the deletion would reopen two buckets per address.

- [ ] **Step 2: Revert the two `mode:'insensitive'` lookups to `findUnique`**

`src/services/invitations.ts:111` in `hasRosterLink`, and `:383` in
`notifyInvitee`. Both currently read:

```ts
  const student = await db.student.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  });
```

Both become:

```ts
  const student = await db.student.findUnique({
    where: { email },
    select: { id: true },
  });
```

This is a performance repair, not tidying: the docblock at `invitations.ts:99`
records that the insensitive match cannot use the unique index and accepts a
scan of `Student` in exchange. That trade no longer needs making.

- [ ] **Step 3: Verify the census is exactly as predicted**

```bash
grep -rn "toLowerCase" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\."
grep -rn "insensitive" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Expected, exactly:
- **3** `toLowerCase` lines — the `gdpr.ts` comment, `profile-form.tsx:175`
  (`pageSlug`), `format.ts:12` (last initial). 16 − 13 = 3.
- **9** `insensitive` lines — 5 `contains` search filters (students, rooms) and
  4 comments, with **zero** equality matches. 11 − 2 = 9.

If either count differs, stop and report the discrepancy rather than adjusting
the expectation.

- [ ] **Step 4: Run everything the deletions touch**

```bash
npm run typecheck
npx vitest run --project unit src/services/gdpr.test.ts src/lib/schemas.test.ts
npx vitest run --project integration tests/integration/invitations-api.test.ts
npx vitest run --project integration tests/integration/invitation-constraints.test.ts
npx vitest run --project integration tests/integration/students-api.test.ts
npx vitest run --project integration tests/integration/account-api.test.ts
npx vitest run --project integration tests/integration/auth-email-case.test.ts
npx vitest run --project integration tests/integration/email-lowercase-constraints.test.ts
```

All green. Run each integration file by path — never the whole project.

- [ ] **Step 5: Prove the deletions were load-bearing-free**

Confirm the compensations were genuinely redundant rather than that their tests
are weak. Temporarily revert `createInvitationSchema.email` (Task 1, line 137)
to bare `z.string().email()`, then:

```bash
npx vitest run --project integration tests/integration/invitations-api.test.ts
```

Expected: something fails — with the schema no longer normalising and the
service no longer compensating, a mixed-case invitation now hits
`Invitation_email_lowercase_check`. Record the verbatim error, then restore.

If **nothing** fails, the invitation path has no mixed-case coverage at all;
report that rather than moving on, because it means Step 1's deletions are
unverified.

- [ ] **Step 6: Commit**

```bash
git add src/services/invitations.ts src/services/gdpr.ts src/services/link-consent.ts \
        src/app/api/students/route.ts "src/app/api/invitations/[id]/route.ts" \
        src/app/api/auth/magic-link/send/route.ts src/app/api/auth/student-signup/route.ts
git commit -m "refactor: 15 compensations for an invariant that now holds, deleted (#170)"
```

---

### Task 4: Correct every claim the change falsified

**Files:**
- Modify: `src/services/invitations.ts` (comments at 91, 99, 164-167, 169-175, 351, 377)
- Modify: `src/services/gdpr.ts` (comments at 64-65, 396-397, 408)
- Modify: `docs/data-model.md`
- Comment on issue #170 (via `gh`)

**Interfaces:** none. Prose only — no behaviour changes in this task.

- [ ] **Step 1: Correct `invitations.ts:164-167` — the sentence that misled #170**

It currently reads:

```
  // Normalised here rather than in `createInvitationSchema`, because a
  // `.transform()` there would hide the schema's `.shape` from the
  // server-owned-field walk in `src/lib/schemas.test.ts` ("are declared only
  // where EXPECTED says so, and everywhere it says so").
```

This is false for field-level transforms and is what led #170 to declare the
right fix unavailable. Replace the whole `inviteContact` normalisation docblock
(roughly lines 158-175, ending at the `const email =` line) with:

```ts
  // Normalisation lives in `emailField` (`src/lib/schemas.ts`), not here (#170).
  //
  // The comment this replaces claimed a `.transform()` in the schema would hide
  // `.shape` from the server-owned-field walk in `schemas.test.ts`. That is true
  // only of an OBJECT-level transform, one wrapping the whole `z.object({...})`.
  // A field-level transform leaves `.shape` fully readable — measured against
  // Zod 4.4.3 — and that imprecision is why #170 was filed believing the obvious
  // fix was unavailable.
  //
  // Account, Student, Teacher and MagicLinkToken emails are now lowercase too,
  // by `emailField` at ingress and `*_email_lowercase_check` at rest, so the
  // JS-side lowercasing that used to bridge the two normalisations is gone.
```

- [ ] **Step 2: Correct the four case-insensitivity comments**

At `invitations.ts:91`, `:99`, `:351` and `:377`. Each explains why a lookup is
case-insensitive; none of them is any longer. `:99` in particular reads:

```
 * `findFirst`, not `findUnique`: an insensitive match cannot use the unique
```

Rewrite each to describe what the code now does. Where a comment's only content
was the insensitivity rationale, delete it rather than narrowing it — an accurate
short comment beats a corrected long one, and the roadmap records deleting a
sentence as the thing that worked when narrowing failed.

- [ ] **Step 3: Correct the two `gdpr.ts` claims**

`:64-65` and `:396-397` both assert some form of *"`Invitation.email` is
lowercase by CHECK constraint, `Student.email` is stored as typed"*. The second
half is now false. Both become a single statement that all six email columns are
lowercase by CHECK.

Check `:408` in the same pass — it explains that `uuid + @deleted.invalid`
satisfies `Invitation_email_lowercase_check`. That reasoning now also applies to
`Account`, `Student` and `Teacher`; extend it rather than leaving it scoped to
one table.

- [ ] **Step 4: Extend `docs/data-model.md`**

Four exact edits. The invariant is currently documented only for the #166 pair
(`:100` Invitation, `:123` and `:128` TeacherBlock); these three rows are where it
now also belongs.

| line | current `Description` cell | becomes |
|---|---|---|
| 14 (`Account.email`) | `The authenticated identity — sessions and passkeys key off this, not off Teacher/Student` | append: ` Lowercased on write by `emailField` and pinned by `Account_email_lowercase_check` (#170) — Postgres compares this column case-sensitively, so without it a case variant is a second identity.` |
| 27 (`Teacher.email`) | `Denormalized copy of the account email` | append: ` Lowercase by `Teacher_email_lowercase_check` (#170).` |
| 53 (`Student.email`) | `Required. Contact email; copies the account email once claimed` | append: ` Lowercase by `Student_email_lowercase_check` (#170).` |

Then add one line to the **Design Notes** section (`:388`), beside the existing
authentication note at `:396`:

```markdown
- **Email is lowercase everywhere** (#170). All six email columns — Account,
  Teacher, Student, MagicLinkToken, Invitation, TeacherBlock — carry a
  `CHECK (email = lower(email))` constraint. `emailField` in `src/lib/schemas.ts`
  normalises everything arriving over HTTP; anything else (seed, GDPR
  anonymisation, psql) is rejected rather than rewritten. Before this, the plain
  btree unique keys under `en_US.utf8` made `Foo@x.com` and `foo@x.com` two
  distinct identities: sign-in silently missed, and signup could create a second
  Account for one human.
```

`MagicLinkToken` has no table of its own in this document (it is an auth-layer
table, like Session and PasskeyCredential) — the Design Notes line above is the
only place it needs naming. Do not add a section for it.

- [ ] **Step 5: Verify no stale claim survives**

```bash
grep -rn "stored as typed\|stored exactly as typed\|case-sensitiv\|insensitive" \
  src/ docs/data-model.md --include="*.ts" --include="*.md" | grep -v "\.test\."
```

Read every hit. Any sentence still describing email comparison as
case-sensitive, or the normalisation as scoped to `Invitation`/`TeacherBlock`, is
a survivor — fix it. Also re-read the spec and this plan: a claim corrected in
source but left standing in an artifact is the failure mode this project has hit
repeatedly.

- [ ] **Step 6: Typecheck, run the touched suites, commit**

```bash
npm run typecheck
npx vitest run --project unit src/services/gdpr.test.ts
git add src/services/invitations.ts src/services/gdpr.ts docs/data-model.md
git commit -m "docs: the comment that told #170 the obvious fix was blocked, and three claims this change falsified (#170)"
```

- [ ] **Step 7: Record the correction on the issue**

```bash
gh issue comment 170 --body "$(cat <<'EOF'
Correction from the implementation, recorded here because acceptance criterion 1 rests on it.

**The blocker in criterion 1 is false.** It states that normalising in `src/lib/schemas.ts` via `.transform()` is "blocked" because a transform hides a schema's `.shape` from the server-owned-field walk. Measured against Zod 4.4.3:

| | parent `.shape` | keys the register reads |
|---|---|---|
| field-level `.transform()` | **defined** | all of them |
| object-level `.transform()` | `undefined` | — |

Only an object-level transform — one wrapping the whole `z.object({...})` — removes `.shape`. The source comment the claim came from (`invitations.ts:164-167`) did not distinguish the two, and this issue inherited that. The fix therefore uses a shared `emailField` primitive in `schemas.ts`, which is what criterion 1 ruled out.

**Criterion 2 is also overbuilt.** It asks the migration to state a collision policy because "a migration that assumes no collision and dies half-way is worse than none." Measured: **Prisma 6.19.3 runs each migration in a transaction** — a deliberately-colliding two-statement migration applied to a scratch database left its first statement's row absent (`probe_marker rows: 0`), so half-application is not available. And Postgres's native error names the offending address (`DETAIL: Key (email)=(foo@x.com) already exists.`), which is strictly better than the count a custom `RAISE EXCEPTION` could report. The migration therefore backfills and constrains, with no collision guard. The backfill itself is kept, because `ADD CONSTRAINT ... CHECK` validates pre-existing rows — also measured.

Two further corrections: "8 email lines in schemas.ts" is **6**; and the five named ingress points are **ten** (`gdpr.ts` writes five synthesized addresses that bypass Zod).
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every section of
`docs/superpowers/specs/2026-08-07-email-normalisation-design.md` maps to a task:
the primitive and its six adoptions → Task 1; the migration's three parts →
Task 2; "The 15 sites" → Task 3; "Comments that currently say something untrue" →
Task 4; "Guards, and proving each one bites" → Task 1 Step 7, Task 2 Step 6, Task
3 Step 5. The spec's eight acceptance criteria map to: 1 → T1S5, 2 → T1S3, 3 →
T1S3, 4 → T1S3, 5 → T2S4+T2S6, 6 → T3S3, 7 → T3S2+T3S3, 8 → T4.

**Type consistency.** `emailField` is the only new export and is referenced by
that name in Tasks 1, 2, 3 and 4. Constraint names are spelled identically in the
migration SQL, the constraint test regexes, the drop/restore commands, and Task
3's verification. `hasRosterLink` keeps its signature across the `findFirst` →
`findUnique` change.

**Known weak spot, stated rather than hidden.** Task 1's third integration test
(passkey) asserts only that the route answered `200` with an options object,
which it would also do with the account unresolved — the fixture has no
registered credential to assert on. Its teeth come from the Step 7 mutation
check, not from the assertion. A reviewer who wants it stronger should register a
credential in the fixture; that was judged more machinery than the assertion is
worth, and is recorded here so the weakness is a decision rather than an
oversight.
