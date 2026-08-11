# Duplicate-Create Constraints (#196 branch 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make five create endpoints retry-safe by putting their natural key in Postgres, so a retried or double-submitted request can no longer produce a duplicate class, studio class, template or room.

**Architecture:** Six hand-authored **partial** unique indexes (Prisma cannot express a `WHERE` clause on an index, so they are raw SQL following `prisma/migrations/20260721061528_student_claim_link_check/`). Each affected route catches `P2002` on its own column set and returns a 409 naming the clash instead of the generic fallback. The generators already tolerate these indexes — PR #204 built for them deliberately — so no generator behaviour changes; only its now-false future-tense comments do.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma 6 + PostgreSQL, Vitest (three projects: `unit`, `integration`, `components`).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project talks to it over HTTP.
- **Never edit an applied migration.** New migration only.
- **The migration must be applied to BOTH databases** — dev (`DATABASE_URL`, which the app on :3000 and the `integration` project use) and test (`DATABASE_URL_TEST`, which the `unit` project uses).
- **Index predicates and route/pre-check predicates must agree.** `Class` excludes `status <> 'cancelled'`; `StudioClass` excludes `cancelledAt IS NULL`; templates exclude `isArchived = false`. `class-generator.ts:160` and `studio-class-generator.ts:165` mirror these in TypeScript — widen or narrow one without the other and they disagree silently.
- **`P2002.meta.target` is the column-name array, not the index name.** Measured: an index Prisma cannot see still yields `{"modelName":"StudioClass","target":["teacherId","date","startTime"]}`, the same shape as a known `@unique` (`["email"]`). All route branching and all test assertions use the column list.
- **Error body shape is `{ error: { message, code } }`** (`api-utils.ts:18`); tests assert `body.error.code`.
- **#196 is not closed by this branch.** Branch 2 closes it. Never write "does not close #196" in a commit or PR body — GitHub's auto-close parser ignores the negation (this is how #191 closed #113).
- **A task that changes the database schema runs the whole `integration` project before it reports DONE** — `npx vitest run --project integration`, not only its own new test file. **Added mid-execution, and the reason is worth carrying:** Task 1 applied a global migration, verified it against its own unit file, and passed two clean reviews while 53 integration tests were red. A per-task review sees one diff; a migration's blast radius is the whole suite. This is the same failure `docs/backlog-roadmap.md` records for #170, where a dark test file and a red lint reached a pushed branch past nine reviews.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/migrations/<ts>_teacher_slot_unique_indexes/migration.sql` | **create** — the six partial unique indexes |
| `prisma/schema.prisma` | **modify** — `///` comments recording indexes Prisma cannot see |
| `src/lib/unique-conflict.ts` | **create** — one predicate, `isUniqueConflictOn(err, columns)`. No Prisma-client value import chain into any `'use client'` module |
| `src/services/slot-constraints.test.ts` | **create** — DB-invariant tests (`unit` project, test DB, no HTTP surface — following where #174's review moved `invitations-lock-order.test.ts`) |
| `src/app/api/classes/route.ts` | **modify** — 409 `DUPLICATE_CLASS_SLOT` |
| `src/app/api/studio-classes/route.ts` | **modify** — 409 `DUPLICATE_STUDIO_SLOT` |
| `src/app/api/rooms/route.ts` | **modify** — private dedupe + 409 on both branches |
| `src/app/api/class-templates/route.ts` | **modify** — 409 `DUPLICATE_TEMPLATE_SLOT` |
| `src/app/api/studio-class-templates/route.ts` | **modify** — 409 `DUPLICATE_STUDIO_TEMPLATE_SLOT` |
| `src/services/class-generator.ts`, `src/services/studio-class-generator.ts` | **modify** — comments only; four claims written in the future tense by #204 become false when the migration lands (the plan first said five; `studio-class-generator.ts:107` turned out already present-tense — see Task 2 Step 1) |
| `tests/integration/{classes,studio,rooms,class-templates}-api.test.ts` | **modify** — HTTP-level duplicate + concurrent tests |
| `docs/lock-order.md` | **modify, conditionally** — only if Task 7's probe finds a new edge |

---

## Task 0: Violation gate — NOT APPLICABLE, and why that is recorded rather than deleted

`CREATE UNIQUE INDEX` fails outright against violating rows, so a data check normally gates this migration.

**There is no production database. The project is development-only** (confirmed by Ivo, 2026-08-11). So there is no dataset this migration can fail against except dev and test, and both were measured clean: 0 duplicate groups on each of the six keys, against 16 `Class`, 7 `StudioClass` and 1 `ClassTemplate` rows.

Kept in the plan rather than deleted, because the reasoning expires: **the moment a production database exists, it will be created by running this migration history**, so the index is in place before any row is written and no violating row can ever accumulate. That is a stronger guarantee than a pre-flight count would have given — but it holds only for a database built from these migrations. A database seeded any other way needs the six counting queries first; they are preserved below for that reader.

<details><summary>The six counting queries, for a database not built from this migration history</summary>

```sql
SELECT 'Class live dup groups' AS k, count(*) FROM (
  SELECT "teacherId","date","startTime" FROM "Class" WHERE status <> 'cancelled'
  GROUP BY 1,2,3 HAVING count(*)>1) s
UNION ALL SELECT 'StudioClass live dup groups', count(*) FROM (
  SELECT "teacherId","date","startTime" FROM "StudioClass" WHERE "cancelledAt" IS NULL
  GROUP BY 1,2,3 HAVING count(*)>1) s
UNION ALL SELECT 'ClassTemplate live dup groups', count(*) FROM (
  SELECT "teacherId","dayOfWeek","startTime" FROM "ClassTemplate" WHERE "isArchived" = false
  GROUP BY 1,2,3 HAVING count(*)>1) s
UNION ALL SELECT 'StudioClassTemplate live dup groups', count(*) FROM (
  SELECT "teacherId","dayOfWeek","startTime" FROM "StudioClassTemplate" WHERE "isArchived" = false
  GROUP BY 1,2,3 HAVING count(*)>1) s
UNION ALL SELECT 'Room public dup groups', count(*) FROM (
  SELECT "address","floor","roomName" FROM "Room" WHERE "isPublic" = true
  GROUP BY 1,2,3 HAVING count(*)>1) s
UNION ALL SELECT 'Room private dup groups', count(*) FROM (
  SELECT "createdById","address","floor","roomName" FROM "Room" WHERE "isPublic" = false
  GROUP BY 1,2,3,4 HAVING count(*)>1) s;
```

</details>

**No steps. Proceed directly to Task 1.**

---

## Task 1: The six partial unique indexes

**Files:**
- Create: `prisma/migrations/<timestamp>_teacher_slot_unique_indexes/migration.sql`
- Modify: `prisma/schema.prisma` (comments only)
- Test: `src/services/slot-constraints.test.ts`

**Interfaces:**
- Produces: six indexes named `Class_teacher_slot_unique`, `StudioClass_teacher_slot_unique`, `ClassTemplate_teacher_slot_unique`, `StudioClassTemplate_teacher_slot_unique`, `Room_public_identity_unique`, `Room_private_identity_unique`. Tasks 3–6 branch on their **column lists**, not these names.

- [ ] **Step 1: Write the failing DB-invariant test**

Create `src/services/slot-constraints.test.ts`. It runs in the `unit` project against `DATABASE_URL_TEST`. Each test makes its own teacher and uses 2027 dates, so no mutation can leave a row another suite trips over.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const suffix = `slot-${Date.now()}`;
let teacherId: string;
let otherTeacherId: string;

async function makeTeacher(tag: string): Promise<string> {
  const email = `${tag}-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Slot', lastName: tag, email, bio: 'slot constraint fixture',
      pageSlug: `${tag}-${suffix}`, account: { create: { email } },
    },
  });
  return t.id;
}

let roomId: string;
let teacherRoomId: string;

const studio = (teacher: string, day: number) => ({
  teacherId: teacher, classType: 'Yoga', date: new Date(Date.UTC(2027, 0, day)),
  startTime: '09:00', durationMinutes: 60, location: 'Studio', hourlyRate: 40,
});

const cls = (teacher: string, day: number) => ({
  teacherId: teacher, teacherRoomId, classType: 'Yoga',
  date: new Date(Date.UTC(2027, 1, day)), startTime: '09:00', durationMinutes: 60,
  roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
});

const tpl = (teacher: string, day: number) => ({
  teacherId: teacher, teacherRoomId, classType: 'Yoga', dayOfWeek: day,
  startTime: '09:00', durationMinutes: 60, roomCost: 20, minRate: 30,
  targetRate: 60, minStudents: 3, maxStudents: 10,
});

const studioTpl = (teacher: string, day: number) => ({
  teacherId: teacher, classType: 'Yoga', dayOfWeek: day, startTime: '09:00',
  durationMinutes: 60, location: 'Studio', hourlyRate: 40,
});

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner');
  otherTeacherId = await makeTeacher('other');
  const room = await prisma.room.create({
    data: {
      venueName: 'Slot Venue', address: `${suffix} Slot Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  roomId = room.id;
  const tr = await prisma.teacherRoom.create({
    // `capacityOverride` is required and has no default (schema.prisma).
    data: { teacherId, roomId, rentalRate: 20, capacityOverride: 12 },
  });
  teacherRoomId = tr.id;
});

afterAll(async () => {
  const teachers = [teacherId, otherTeacherId];
  await prisma.class.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.studioClass.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.classTemplate.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.room.deleteMany({ where: { createdById: { in: teachers } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teachers } } });
  await prisma.$disconnect();
});

/**
 * These assert the DATABASE rejects the write. The route-level 409s in
 * tests/integration only prove a route's own branch; with the index absent
 * they would still pass on a sequential retry and fail only under a race,
 * which is the case that motivated #196.
 *
 * The assertions name `meta.target` — the column list — rather than matching
 * a message. A bare `rejects.toThrow()` would be satisfied by any masking
 * failure (an FK violation from a stale fixture, a different unique key).
 */
describe('teacher slot unique indexes', () => {
  it('rejects a second live studio class at the same teacher/date/startTime', async () => {
    await prisma.studioClass.create({ data: studio(teacherId, 4) });
    const err = await prisma.studioClass.create({ data: studio(teacherId, 4) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'date', 'startTime']);
  });

  it('does not block another teacher at the same date and time', async () => {
    await expect(prisma.studioClass.create({ data: studio(otherTeacherId, 4) })).resolves.toBeTruthy();
  });

  it('a cancelled studio class does not block re-creating that slot', async () => {
    await prisma.studioClass.create({ data: { ...studio(teacherId, 5), cancelledAt: new Date() } });
    await expect(prisma.studioClass.create({ data: studio(teacherId, 5) })).resolves.toBeTruthy();
  });
});

describe('Class_teacher_slot_unique', () => {
  it('rejects a second live class at the same teacher/date/startTime', async () => {
    await prisma.class.create({ data: cls(teacherId, 4) });
    const err = await prisma.class.create({ data: cls(teacherId, 4) }).catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'date', 'startTime']);
  });

  it('a cancelled class does not block re-creating that slot', async () => {
    const c = await prisma.class.create({ data: cls(teacherId, 5) });
    // Created as `draft` then moved, because `class_terminal_status_guard`
    // governs status changes. If a direct `status: 'cancelled'` insert is
    // accepted, use it — but do not assume; run it and see.
    await prisma.class.update({ where: { id: c.id }, data: { status: 'cancelled' } });
    await expect(prisma.class.create({ data: cls(teacherId, 5) })).resolves.toBeTruthy();
  });
});

describe('ClassTemplate_teacher_slot_unique', () => {
  it('rejects a second live template on the same teacher/dayOfWeek/startTime', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 1) });
    const err = await prisma.classTemplate.create({ data: tpl(teacherId, 1) }).catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'dayOfWeek', 'startTime']);
  });

  it('an archived template does not block a replacement on that slot', async () => {
    const t = await prisma.classTemplate.create({ data: tpl(teacherId, 2) });
    await prisma.classTemplate.update({ where: { id: t.id }, data: { isArchived: true } });
    await expect(prisma.classTemplate.create({ data: tpl(teacherId, 2) })).resolves.toBeTruthy();
  });
});

describe('StudioClassTemplate_teacher_slot_unique', () => {
  it('rejects a second live studio template on the same slot', async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 3) });
    const err = await prisma.studioClassTemplate
      .create({ data: studioTpl(teacherId, 3) }).catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'dayOfWeek', 'startTime']);
  });

  it('an archived studio template does not block a replacement', async () => {
    const t = await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 4) });
    await prisma.studioClassTemplate.update({ where: { id: t.id }, data: { isArchived: true } });
    await expect(prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 4) }))
      .resolves.toBeTruthy();
  });
});

describe('Room identity indexes', () => {
  const room = (creator: string, isPublic: boolean, name: string) => ({
    venueName: 'V', address: `${suffix} Identity Street`, city: 'Amsterdam',
    postcode: '1011AB', floor: '3', roomName: name, maxCapacity: 10,
    isPublic, createdById: creator,
  });

  it('rejects a second public room with the same address/floor/roomName', async () => {
    await prisma.room.create({ data: room(teacherId, true, 'PubA') });
    const err = await prisma.room.create({ data: room(otherTeacherId, true, 'PubA') })
      .catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['address', 'floor', 'roomName']);
  });

  it('scopes private rooms per creator: same teacher twice is rejected', async () => {
    await prisma.room.create({ data: room(teacherId, false, 'PrivA') });
    const err = await prisma.room.create({ data: room(teacherId, false, 'PrivA') })
      .catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['createdById', 'address', 'floor', 'roomName']);
  });

  it('scopes private rooms per creator: a different teacher is allowed', async () => {
    await expect(prisma.room.create({ data: room(otherTeacherId, false, 'PrivA') }))
      .resolves.toBeTruthy();
  });
});
```

**Why all six and not just one.** The spec's §9 promises a mutation per guard. Testing one index and asserting the other five would be the same defect this issue exists to remove — a guard that exists and cannot fail. The per-model fixtures are the cost of that; the `Class` and `ClassTemplate` ones need the `Room`/`TeacherRoom` rows created in `beforeAll`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/slot-constraints.test.ts`

Expected: **six failures** — one "rejects a second …" per index. Each fails because the duplicate create *succeeds*, so `err` is a model row rather than a `PrismaClientKnownRequestError`.

The six "does not block" tests pass **vacuously** at this point, since nothing blocks anything yet. That is expected and is exactly why they are not evidence on their own: they only start meaning something after Step 6, and Step 9's predicate mutations are what prove they can fail at all.

- [ ] **Step 3: Create the migration directory**

```bash
TS=$(date -u +%Y%m%d%H%M%S)
mkdir -p "prisma/migrations/${TS}_teacher_slot_unique_indexes"
```

(`prisma migrate dev --create-only` is not used: `schema.prisma` has no structural change, so Prisma reports "no changes" and writes nothing. The precedent for a hand-authored migration is `prisma/migrations/20260721061528_student_claim_link_check/`.)

- [ ] **Step 4: Write the migration SQL**

Into `prisma/migrations/<TS>_teacher_slot_unique_indexes/migration.sql`:

```sql
-- Invariant, DB-enforced: one teacher cannot hold two live classes at the
-- same date and start time (#196). Partial on purpose — a cancelled class
-- must not make its slot permanently unfillable, which is the bug a
-- non-partial index would trade for the one being fixed.
--
-- Hand-authored because Prisma cannot express a WHERE clause on an index.
-- Measured: `prisma migrate diff --from-schema-datasource --to-schema-datamodel
-- --exit-code` does NOT see a partial index (a plain one on the same columns
-- exits 2), so this does not read as drift in CI.
CREATE UNIQUE INDEX "Class_teacher_slot_unique"
  ON "Class" ("teacherId", "date", "startTime")
  WHERE "status" <> 'cancelled';

CREATE UNIQUE INDEX "StudioClass_teacher_slot_unique"
  ON "StudioClass" ("teacherId", "date", "startTime")
  WHERE "cancelledAt" IS NULL;

-- Templates key on dayOfWeek rather than date: a recurring class recurs on a
-- weekday. Archived templates are excluded so archiving frees the slot.
CREATE UNIQUE INDEX "ClassTemplate_teacher_slot_unique"
  ON "ClassTemplate" ("teacherId", "dayOfWeek", "startTime")
  WHERE "isArchived" = false;

CREATE UNIQUE INDEX "StudioClassTemplate_teacher_slot_unique"
  ON "StudioClassTemplate" ("teacherId", "dayOfWeek", "startTime")
  WHERE "isArchived" = false;

-- The room identity key is not chosen here: it is the key the existing
-- dedupe at api/rooms/route.ts already used for public rooms. The private
-- index is scoped by creator because two teachers each keeping a private
-- room at one address is legitimate — that is what TeacherRoom's per-teacher
-- rate model assumes.
CREATE UNIQUE INDEX "Room_public_identity_unique"
  ON "Room" ("address", "floor", "roomName")
  WHERE "isPublic" = true;

CREATE UNIQUE INDEX "Room_private_identity_unique"
  ON "Room" ("createdById", "address", "floor", "roomName")
  WHERE "isPublic" = false;
```

- [ ] **Step 5: Apply to both databases**

```bash
npx prisma migrate deploy
DATABASE_URL="$(grep -E '^DATABASE_URL_TEST=' .env | sed 's/^DATABASE_URL_TEST=//; s/"//g')" npx prisma migrate deploy
```

Expected: "All migrations have been successfully applied." twice. Do **not** restart :3000 — an index changes no generated client code.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run --project unit src/services/slot-constraints.test.ts`
Expected: **12 passed** — `3 (StudioClass) + 2 (Class) + 2 (ClassTemplate) + 2 (StudioClassTemplate) + 3 (Room) = 12`.

- [ ] **Step 7: Confirm CI's drift check still passes**

Run: `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code; echo "exit=$?"`
Expected: `No difference detected.` and `exit=0`.

- [ ] **Step 8: Record the indexes in `schema.prisma`**

Prisma cannot see these, so nothing in the schema would otherwise mention them and no future `migrate dev` will drop them — safe, but silent. Add a `///` doc comment directly above each of the five models (`Class`, `StudioClass`, `ClassTemplate`, `StudioClassTemplate`, `Room`), e.g. above `model Class {`:

```prisma
/// Carries a partial unique index Prisma cannot express and therefore cannot
/// show: `Class_teacher_slot_unique` on (teacherId, date, startTime) WHERE
/// status <> 'cancelled' (#196). It is invisible to `migrate diff`, so it
/// will not appear as drift and will not be dropped — and equally will not
/// appear in this file unless someone keeps this comment true.
```

Write the equivalent for the other four, naming each index and its predicate exactly as the SQL does.

- [ ] **Step 9: Prove each guard bites**

Per guard, apply the mutation, record the exact failure text, revert, re-verify green. Do this against the **test** database only.

| # | Mutation | Must break |
|---|---|---|
| 1 | `DROP INDEX "StudioClass_teacher_slot_unique";` | "rejects a second live studio class" |
| 2 | Recreate it without `WHERE "cancelledAt" IS NULL` | "a cancelled studio class does not block re-creating that slot" |
| 3 | Recreate it on `("date","startTime")` only | "does not block another teacher at the same date and time" |
| 4 | `DROP INDEX "Class_teacher_slot_unique";` | "rejects a second live class" |
| 5 | Recreate it without `WHERE "status" <> 'cancelled'` | "a cancelled class does not block re-creating that slot" |
| 6 | `DROP INDEX "ClassTemplate_teacher_slot_unique";` | "rejects a second live template" |
| 7 | Recreate it without `WHERE "isArchived" = false` | "an archived template does not block a replacement on that slot" |
| 8 | `DROP INDEX "StudioClassTemplate_teacher_slot_unique";` | "rejects a second live studio template" |
| 9 | Recreate it without `WHERE "isArchived" = false` | "an archived studio template does not block a replacement" |
| 10 | `DROP INDEX "Room_public_identity_unique";` | "rejects a second public room…" |
| 11 | `DROP INDEX "Room_private_identity_unique";` | "scopes private rooms per creator: same teacher twice is rejected" |
| 12 | Recreate the private index without `"createdById"` | "scopes private rooms per creator: a different teacher is allowed" |

Twelve mutations for twelve tests. If any mutation leaves its test **passing**, that test is not testing what it claims and the finding goes in the PR body — that outcome is more valuable than a green run.

Restore with the migration's own SQL afterwards and re-run the file.

- [ ] **Step 10: Commit**

```bash
git add prisma/migrations prisma/schema.prisma src/services/slot-constraints.test.ts
git commit -m "fix: the slot key a teacher cannot violate twice, now in Postgres"
```

---

## Task 2: Make #204's future-tense claims true

PR #204 was written against an index that did not exist. Four comments say so, and each becomes false the moment Task 1 lands. This is its own task because "correct the claim in every artifact" is a deliverable here, not a tidy-up — a comment asserting a missing backstop is what stops the next reader trusting the one that now exists.

**Files:**
- Modify: `src/services/class-generator.ts:86`, `:88-90`, `:160-163`
- Modify: `src/services/studio-class-generator.ts:107`, `:165`

**Interfaces:** none — comments only. No behaviour changes, no test changes.

- [ ] **Step 1: List every stale site before editing**

Run: `grep -rn '#196' src/ | grep -iE 'will |yet|no such|today the only'`
Expected: four hits across the two generator files. Fix **all** of them; a task that fixes three of four reports success either way. (This plan originally said five, counting `studio-class-generator.ts:107` as a site needing an edit; on execution that line turned out to already be present-tense and accurate, so it needed none — recorded here rather than silently corrected.)

- [ ] **Step 2: Rewrite each to the present tense**

At `class-generator.ts:86`, `the partial index #196 *will* add` becomes `the partial index #196 added`. At `:88-90`, the sentence beginning `Note the tense: today the only unique key here is…` is replaced by:

```
 *     Since #196 that backstop exists: `Class_teacher_slot_unique` on
 *     (teacherId, date, startTime) WHERE status <> 'cancelled'. The bare
 *     `ON CONFLICT DO NOTHING` was measured absorbing exactly that index —
 *     inside a transaction, which then went on to run another statement and
 *     commit — so a slot race now costs its own date and nothing else.
```

At `:160-163`, `no such index exists yet, so this pre-check is currently the only thing enforcing it` becomes `the index backs it since #196; this pre-check is what names the reason, not what enforces it`. Make the equivalent edit at `studio-class-generator.ts:165`, naming `StudioClass_teacher_slot_unique` and its `WHERE "cancelledAt" IS NULL` predicate. (This originally said "two edits"; `studio-class-generator.ts:107` was the presumed second and needed none — the same miscount recorded in Step 1.)

- [ ] **Step 3: Verify nothing else went stale**

Run: `grep -rn '#196' src/ docs/lock-order.md docs/technical-architecture.md | grep -iE 'will |yet|no such'`
Expected: no output.

- [ ] **Step 4: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/services/class-generator.ts src/services/studio-class-generator.ts
git commit -m "docs: four comments that described a backstop this branch just built"
```

---

## Task 3: `POST /api/classes` names the clash

**Files:**
- Create: `src/lib/unique-conflict.ts`
- Modify: `src/app/api/classes/route.ts:62-83`
- Test: `tests/integration/classes-api.test.ts`

**Interfaces:**
- Produces: `isUniqueConflictOn(err: unknown, columns: readonly string[]): boolean` — used unchanged by Tasks 4, 5 and 6.
- Produces: error code `DUPLICATE_CLASS_SLOT`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/classes-api.test.ts`, inside the existing top-level `describe`. Reuse the file's existing `ownerToken`, `ownerId` and `teacherRoomId` fixtures.

```ts
describe('POST /api/classes is retry-safe on the slot key (#196)', () => {
  const slotBody = () => ({
    teacherRoomId, classType: 'Slot Yoga', date: '2027-04-05', startTime: '07:15',
    durationMinutes: 60, roomCost: 20, minRate: 30, targetRate: 60,
    minStudents: 3, maxStudents: 10,
  });
  const post = (body: unknown) =>
    fetch(`${BASE_URL}/api/classes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify(body),
    });

  it('answers a repeated identical create with 409 and leaves exactly one class', async () => {
    const first = await post(slotBody());
    expect(first.status).toBe(201);

    const second = await post(slotBody());
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('DUPLICATE_CLASS_SLOT');

    const rows = await prisma.class.findMany({
      where: { teacherId: ownerId, date: new Date('2027-04-05'), startTime: '07:15' },
    });
    expect(rows).toHaveLength(1);
  });

  it('leaves exactly one class when two identical creates are in flight at once', async () => {
    const body = { ...slotBody(), startTime: '07:45' };
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const loser = a.status === 409 ? a : b;
    expect((await loser.json()).error.code).toBe('DUPLICATE_CLASS_SLOT');

    const rows = await prisma.class.findMany({
      where: { teacherId: ownerId, date: new Date('2027-04-05'), startTime: '07:45' },
    });
    expect(rows).toHaveLength(1);
  });
});
```

The second test is the one a sequential-only suite cannot write, and it is the case #196 exists for: a pre-check would pass it only by luck.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts -t '#196'`
Expected: test 1 FAILS with `expected 500 to be 409` or `expected 409 to be …` depending on ordering — the route has no branch, so `P2002` reaches the generic fallback as 409 `"Resource already exists"` with `code` undefined. Test 2 FAILS on the code assertion for the same reason: it reads whichever response came back 409 and asserts `error.code`, same as test 1. **Both must fail on the `code`, not on the row count** — the row count already passes because Task 1's index is doing its job. Record that distinction; it is what shows the tests are testing the route and not the index.

*(Correction, recorded after Task 3's review: an earlier draft of test 2 asserted only the status pair and row count, with no `code` check. Both of those already held before the route branch existed — Task 1's index alone serializes the concurrent writes to `[201, 409]`, and the pre-existing generic P2002→409 fallback already returned a bare 409. That draft passed at Step 2 and stayed passing under the Step 6 mutation, giving the concurrent path no coverage of this task's own change. The `code` assertion above is the fix; it is what actually pins the new branch under concurrency.)*

- [ ] **Step 3: Write the shared predicate**

Create `src/lib/unique-conflict.ts`:

```ts
import { Prisma } from '@prisma/client';

/**
 * True when `err` is a P2002 raised by the unique key covering exactly
 * `columns`.
 *
 * Branching on columns rather than on the index name is not a preference: an
 * index Prisma cannot see (every partial index this project hand-authors) still
 * reports `meta.target` as the column-name array, identically to a declared
 * `@unique`. Measured on `StudioClass_teacher_slot_unique`:
 * `{"modelName":"StudioClass","target":["teacherId","date","startTime"]}`.
 *
 * Compared as a set. Two unique keys over the same columns in a different
 * order cannot meaningfully coexist, and an order-sensitive check would turn a
 * harmless index rewrite into a silently unreachable branch.
 *
 * Deliberately ignores `err.meta?.modelName`, so this is safe only as long as
 * a single `try` block can raise P2002 from just one model. That holds for
 * every caller today, but not by any guarantee: `(teacherId, date,
 * startTime)` names both `Class_teacher_slot_unique` and
 * `StudioClass_teacher_slot_unique`, and `(teacherId, dayOfWeek, startTime)`
 * names both `ClassTemplate_teacher_slot_unique` and
 * `StudioClassTemplate_teacher_slot_unique`. A route whose transaction can
 * raise P2002 from two models sharing a column-name set — e.g. a
 * `ClassTemplate` create that also generates `Class` rows, if `dayOfWeek` and
 * `date` ever converged — would need `modelName` added to disambiguate them.
 */
export function isUniqueConflictOn(err: unknown, columns: readonly string[]): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (!Array.isArray(target)) return false;
  if (target.length !== columns.length) return false;
  const got = [...(target as string[])].sort();
  const want = [...columns].sort();
  return got.every((c, i) => c === want[i]);
}
```

- [ ] **Step 4: Branch in the route**

In `src/app/api/classes/route.ts`, add `import { isUniqueConflictOn } from '@/lib/unique-conflict';` and wrap the existing `prisma.class.create`:

```ts
  try {
    const cls = await prisma.class.create({
      data: {
        // ...unchanged...
      },
    });
    return respondOk(cls, 201);
  } catch (err) {
    // The slot key, not the template key. `@@unique([templateId, date])` also
    // raises P2002 here and means something else entirely, so the column list
    // is what tells them apart.
    if (isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])) {
      return respondError(
        'You already have a class at that date and time.',
        409,
        'DUPLICATE_CLASS_SLOT',
      );
    }
    throw err;
  }
```

There is deliberately **no pre-check**. A pre-check would produce the same message while remaining race-unsafe, and `api-errors.ts:246` logs `"unique constraint escaped a route to the 409 fallback"` at `warn` precisely to flag routes that let this through unhandled — a warning a teacher's ordinary double-tap should not produce.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: the whole file passes, including the pre-existing tests.

- [ ] **Step 6: Prove the guard bites**

Change the column list in the route to `['teacherId', 'date']` and re-run. Expected: both new tests fail on `code` (the branch no longer matches; the fallback answers). Revert and re-run green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/unique-conflict.ts src/app/api/classes/route.ts tests/integration/classes-api.test.ts
git commit -m "fix: a second identical class create now says which slot is taken"
```

---

## Task 3b: Repair the integration fixtures the index exposed

**Added mid-execution. This task exists because of a defect in this plan, recorded rather than quietly patched.**

Task 1 applied a global migration and verified it with `npx vitest run --project unit src/services/slot-constraints.test.ts` — its own new file. The migration's blast radius lands in a project Task 1 never ran. Task 1 passed two clean reviews while the branch was red:

```
Test Files  5 failed | 22 passed (27)
     Tests  53 failed | 288 passed | 9 skipped (350)
```

Failing: `class-templates-api`, `invitations-api`, `registrations-api`, `studio-api`, `waitlist-api`. All failures are constraint-shaped — 26 on `(teacherId, date, startTime)`, 9 on `(teacherId, dayOfWeek, startTime)`, the rest cascading from broken `beforeAll` hooks.

**The fixtures were wrong, not the constraint.** `classes-api.test.ts`'s `beforeAll` created five classes for one teacher at one date and start time — a state the product rule behind this issue says cannot exist. The index did not break valid test data; it exposed test data that was never valid. Repair means spacing the fixtures so each represents a state the domain permits, **never** weakening the index or adding a status/`cancelledAt` escape to make bad data legal.

**Files:**
- Modify: `tests/integration/class-templates-api.test.ts`
- Modify: `tests/integration/invitations-api.test.ts`
- Modify: `tests/integration/registrations-api.test.ts`
- Modify: `tests/integration/studio-api.test.ts`
- Modify: `tests/integration/waitlist-api.test.ts`

**Interfaces:** none. Test fixtures only; no production code changes.

- [ ] **Step 1: Record the failing baseline**

Run: `npx vitest run --project integration`
Capture the failing file list and per-file counts into the report before changing anything. A repair with no recorded baseline cannot be shown to have repaired anything.

- [ ] **Step 2: Repair each file's fixtures, one file per commit**

For each failing file: find the fixtures that collide on `(teacherId, date, startTime)` or `(teacherId, dayOfWeek, startTime)` and separate them — distinct `startTime` values are usually the smallest change, distinct dates where a test's meaning depends on the time.

**The rule that governs every edit:** a fixture may be moved, never made legal by weakening what the test proves. Before changing a colliding fixture, read every downstream assertion that references it. If a test depends on two rows sharing a slot, that test is asserting something the domain forbids and the finding goes in the report rather than being silently rewritten.

Prefer giving a colliding fixture its own teacher over contorting times, where the test does not care which teacher owns the row — the index is per-teacher, so a separate teacher removes the collision without touching any time-dependent assertion.

- [ ] **Step 3: Verify each file green before moving to the next**

Run: `npx vitest run --project integration tests/integration/<file>` after each repair.

- [ ] **Step 4: The whole project green**

Run: `npx vitest run --project integration`
Expected: `27 passed (27)` files, 0 failed tests. Record the before/after totals side by side in the report.

- [ ] **Step 5: Commit per file**

```bash
git add tests/integration/<file>
git commit -m "test: <what that file's fixture was asserting that the domain forbids>"
```

---

## Task 4: `POST /api/studio-classes` names the clash

**Files:**
- Modify: `src/app/api/studio-classes/route.ts:30-40`
- Test: `tests/integration/studio-api.test.ts`

**Interfaces:**
- Consumes: `isUniqueConflictOn` from Task 3.
- Produces: error code `DUPLICATE_STUDIO_SLOT`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/studio-api.test.ts`, reusing that file's teacher fixture and its session cookie helper (match the names already in that file rather than assuming `ownerToken`).

```ts
describe('POST /api/studio-classes is retry-safe on the slot key (#196)', () => {
  const slotBody = () => ({
    classType: 'Slot Studio', date: '2027-04-12', startTime: '11:00',
    durationMinutes: 60, location: 'Some Studio', hourlyRate: 45,
  });
  const post = (body: unknown, token: string) =>
    fetch(`${BASE_URL}/api/studio-classes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    });

  it('answers a repeated identical create with 409 and leaves exactly one row', async () => {
    expect((await post(slotBody(), teacherToken)).status).toBe(201);
    const second = await post(slotBody(), teacherToken);
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('DUPLICATE_STUDIO_SLOT');

    const rows = await prisma.studioClass.findMany({
      where: { teacherId, date: new Date('2027-04-12'), startTime: '11:00' },
    });
    expect(rows).toHaveLength(1);
  });

  it('leaves exactly one row when two identical creates are in flight at once', async () => {
    const body = { ...slotBody(), startTime: '11:30' };
    const [a, b] = await Promise.all([post(body, teacherToken), post(body, teacherToken)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rows = await prisma.studioClass.findMany({
      where: { teacherId, date: new Date('2027-04-12'), startTime: '11:30' },
    });
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts -t '#196'`
Expected: both fail on the `code` assertion, not the row count.

- [ ] **Step 3: Branch in the route**

Add `import { isUniqueConflictOn } from '@/lib/unique-conflict';` and wrap `prisma.studioClass.create`:

```ts
  try {
    const studioClass = await prisma.studioClass.create({
      data: {
        // ...unchanged...
      },
    });
    return respondOk(studioClass, 201);
  } catch (err) {
    if (isUniqueConflictOn(err, ['teacherId', 'date', 'startTime'])) {
      return respondError(
        'You already have a studio class at that date and time.',
        409,
        'DUPLICATE_STUDIO_SLOT',
      );
    }
    throw err;
  }
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/studio-classes/route.ts tests/integration/studio-api.test.ts
git commit -m "fix: a repeated studio-class create no longer double-counts the week"
```

---

## Task 5: `POST /api/rooms` dedupes private rooms too

The existing check at `rooms/route.ts:60-72` runs **only** when `isPublic`, so a private room had no dedupe at all — and the public one is a `findFirst` then `create` with nothing behind it, so two concurrent identical public rooms both inserted.

**Files:**
- Modify: `src/app/api/rooms/route.ts:49-91`
- Test: `tests/integration/rooms-api.test.ts`

**Interfaces:**
- Consumes: `isUniqueConflictOn` from Task 3.
- Produces: error code `DUPLICATE_ROOM` on both branches (the public branch's existing code, kept).

- [ ] **Step 1: Write the failing tests**

```ts
describe('POST /api/rooms dedupes both branches (#196)', () => {
  const roomBody = (over: Record<string, unknown> = {}) => ({
    venueName: 'Slot Venue', address: `${suffix} Slot Street 1`, city: 'Amsterdam',
    postcode: '1011 AB', floor: '2', roomName: 'Back', maxCapacity: 12,
    equipment: [], isPublic: true, ...over,
  });
  const post = (body: unknown, token: string) =>
    fetch(`${BASE_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    });

  it('rejects a second identical PRIVATE room from the same teacher', async () => {
    const body = roomBody({ isPublic: false, roomName: 'PrivateBack' });
    expect((await post(body, ownerToken)).status).toBe(201);
    const second = await post(body, ownerToken);
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('DUPLICATE_ROOM');
  });

  it('still lets a DIFFERENT teacher keep their own private room at that address', async () => {
    const body = roomBody({ isPublic: false, roomName: 'PrivateBack' });
    expect((await post(body, otherTeacherToken)).status).toBe(201);
  });

  it('leaves one row when two identical PUBLIC creates are in flight at once', async () => {
    const body = roomBody({ roomName: 'RaceRoom' });
    const [a, b] = await Promise.all([post(body, ownerToken), post(body, ownerToken)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const rows = await prisma.room.findMany({
      where: { isPublic: true, address: body.address, floor: body.floor, roomName: 'RaceRoom' },
    });
    expect(rows).toHaveLength(1);
  });
});
```

Use whatever teacher-token variables that file already defines; add a second teacher there only if it has none.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project integration tests/integration/rooms-api.test.ts -t '#196'`
Expected: test 1 fails (a private duplicate currently returns 201); test 3 fails on the `code` assertion.

- [ ] **Step 3: Wrap the create**

Keep the existing public `findFirst` pre-check exactly as it is — it avoids the `warn` log on the common path and its message is already correct. Add the catch as the backstop that the pre-check never was:

```ts
  try {
    const room = await prisma.room.create({
      data: {
        // ...unchanged...
      },
    });
    return respondOk(room, 201);
  } catch (err) {
    // Two indexes, two shapes: public rooms are unique across the whole
    // shared namespace, private rooms only within their creator.
    if (
      isUniqueConflictOn(err, ['address', 'floor', 'roomName']) ||
      isUniqueConflictOn(err, ['createdById', 'address', 'floor', 'roomName'])
    ) {
      return respondError(
        isPublic
          ? 'A public room at this address already exists'
          : 'You already have a room at this address',
        409,
        'DUPLICATE_ROOM',
      );
    }
    throw err;
  }
```

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project integration tests/integration/rooms-api.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/rooms/route.ts tests/integration/rooms-api.test.ts
git commit -m "fix: private rooms had no dedupe at all, and the public one lost its race"
```

---

## Task 6: Both template creates name the clash

Both create inside a `$transaction` that also generates the window. A `P2002` on the template row aborts that transaction before generation begins, so the catch belongs **outside** `prisma.$transaction`, and rolling the whole thing back is correct — a template that duplicates an existing one should not exist.

**Files:**
- Modify: `src/app/api/class-templates/route.ts:42-70`
- Modify: `src/app/api/studio-class-templates/route.ts:39-55`
- Test: `tests/integration/class-templates-api.test.ts`
- Test: `tests/integration/studio-api.test.ts` (the studio template sibling)

**Interfaces:**
- Consumes: `isUniqueConflictOn` from Task 3.
- Produces: `DUPLICATE_TEMPLATE_SLOT`, `DUPLICATE_STUDIO_TEMPLATE_SLOT`.

- [ ] **Step 1: Write the failing test**

```ts
describe('POST /api/class-templates is retry-safe on the slot key (#196)', () => {
  const tplBody = () => ({
    teacherRoomId, classType: 'Slot Recurring', dayOfWeek: 2, startTime: '06:30',
    durationMinutes: 60, roomCost: 20, minRate: 30, targetRate: 60,
    minStudents: 3, maxStudents: 10,
  });
  const post = (body: unknown) =>
    fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify(body),
    });

  it('answers a repeated identical create with 409 and leaves one template and one window', async () => {
    expect((await post(tplBody())).status).toBe(201);
    const second = await post(tplBody());
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe('DUPLICATE_TEMPLATE_SLOT');

    const templates = await prisma.classTemplate.findMany({
      where: { teacherId: ownerId, dayOfWeek: 2, startTime: '06:30', isArchived: false },
    });
    expect(templates).toHaveLength(1);

    // The half the endpoint's severity actually lives in: a second template
    // would have generated a second full four-week set of bookable classes.
    const generated = await prisma.class.findMany({ where: { templateId: templates[0]!.id } });
    expect(generated).toHaveLength(4);
  });
});
```

Then add the studio sibling. It has its own route change in Step 3, so leaving it untested would be a route modified with no test — the gap this plan's self-review caught once already. Put it in `tests/integration/studio-api.test.ts` next to Task 4's block, using that file's fixtures:

```ts
it('answers a repeated identical studio-template create with 409 (#196)', async () => {
  const body = {
    classType: 'Slot Studio Recurring', dayOfWeek: 5, startTime: '19:00',
    durationMinutes: 60, location: 'Some Studio', hourlyRate: 45,
  };
  const post = () =>
    fetch(`${BASE_URL}/api/studio-class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify(body),
    });

  expect((await post()).status).toBe(201);
  const second = await post();
  expect(second.status).toBe(409);
  expect((await second.json()).error.code).toBe('DUPLICATE_STUDIO_TEMPLATE_SLOT');

  const templates = await prisma.studioClassTemplate.findMany({
    where: { teacherId, dayOfWeek: 5, startTime: '19:00', isArchived: false },
  });
  expect(templates).toHaveLength(1);
});
```

- [ ] **Step 2: Run and watch both fail**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts -t '#196'`
Expected: both new tests FAIL on the `code` assertion (the generic fallback answers 409 with `code` undefined), not on the row counts.

- [ ] **Step 3: Branch in both routes**

In `class-templates/route.ts`, wrap the whole `await prisma.$transaction(...)` call:

```ts
  let template;
  try {
    template = await prisma.$transaction(async (tx) => {
      // ...unchanged body...
    });
  } catch (err) {
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return respondError(
        'You already have a recurring class on that day at that time.',
        409,
        'DUPLICATE_TEMPLATE_SLOT',
      );
    }
    throw err;
  }
```

Make the same change in `studio-class-templates/route.ts` with the message `'You already have a recurring studio class on that day at that time.'` and the code `DUPLICATE_STUDIO_TEMPLATE_SLOT`.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/class-templates/route.ts" "src/app/api/studio-class-templates/route.ts" \
        tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts
git commit -m "fix: a duplicated template generated a second four-week window"
```

---

## Task 7: Measure whether the new keys add a deadlock edge

`docs/lock-order.md:315` records that *"two concurrent INSERTs of one unique key make the second wait on the first's uncommitted tuple, and that wait deadlocks like any other."* This branch adds six unique keys, and that document records two sites (`syncTemplateInstances`, `archiveOrUnarchiveTemplate`) already locking `Class` rows in heap order, with a reproduced `40P01`. The analysis in the spec's §5.2 says the risk is low. **That is reasoning, and this project's convention is to measure.**

**Files:**
- Modify (conditionally): `docs/lock-order.md`

- [ ] **Step 1: Write a probe against a throwaway database**

Build it the way `docs/lock-order.md` built its own: two real transactions, a handshake to widen the window, and a third connection probing with `FOR UPDATE NOWAIT`. Pair a `POST /api/class-templates`-shaped transaction (create template, generate window) against a `syncTemplateInstances`-shaped one on the same teacher and overlapping dates. Run each ordering three times.

Create the probe database, apply the migration history including this branch's migration, and drop it afterwards. Do **not** run this against dev or test.

- [ ] **Step 2: Record the outcome verbatim**

Both orderings, three runs each, with the exact `40P01` text if it appears. A probe whose result is not written down is not a measurement.

- [ ] **Step 3: If an edge is found, document it**

Add an entry to `docs/lock-order.md` under "Ordering WITHIN `Class`" naming the pairing and the reproduction. **Do not attempt to fix a deadlock here** — that document records two known unfixed pairings and explains at length why the cheap fix does not work. Filing beats a wrong fix.

- [ ] **Step 4: If no edge is found, say that too**

Add one line to the PR body stating what was paired, how many runs, and that no `40P01` appeared — so the next reader knows the question was asked rather than skipped.

- [ ] **Step 5: Commit (only if the doc changed)**

```bash
git add docs/lock-order.md
git commit -m "docs: the deadlock edge these six unique keys were measured for"
```

---

## Task 8: Whole-branch verification and PR

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck, lint and all three vitest projects green. It needs the app running on :3000; without it the `integration` project gives a wall of `ECONNREFUSED`. **Do not start or restart :3000** — ask the user if it is down.

Record the total test count and its breakdown (`N = unit + components + integration`) — that is what turns "every integration file ran" from a reassurance into a checkable claim.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin fix/196-duplicate-create-constraints
```

Body must record: Task 0's production query output verbatim; the arithmetic behind the census figures (`56 = 27 + 29`, `56 = 27 IDEMPOTENT + 20 CONFLICT + 9 DUPLICATE`); which inherited claims were checked and which held; the two feasibility measurements (drift-blindness with its control, and `skipDuplicates` absorbing a partial index inside a transaction that then committed); Task 7's result either way; and the suites that ran, naming the `integration` files this branch touched by path.

State plainly what this branch does **not** do: the nine endpoints of branch 2, and the `edit-room-form.tsx` item parked in #196's Update. **Write "#196 remains open; branch 2 closes it"** — never "does not close #196", which GitHub's parser reads as a close directive.

- [ ] **Step 3: Multi-agent review**

Run `/pr-review-toolkit:review-pr <N>`. Give each reviewer its specific risk: for the silent-failure agent, the `throw err` re-raise paths; for the test analyst, whether the concurrent tests could pass with the index dropped; for the comment analyst, Task 2's tense corrections. Skip type-design — this branch's subject is a database constraint, not a type.
