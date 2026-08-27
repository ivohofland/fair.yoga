# Template/Room Archive Invariant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "an active `ClassTemplate` may not reference an archived `TeacherRoom`" unrepresentable in PostgreSQL, so the four application doors that currently hold it become messages rather than enforcement.

**Architecture:** Two mirrored columns on `ClassTemplate` (`ruleLive`, `roomArchived`), held current by widening the two foreign keys that already exist rather than adding new ones, plus one `CHECK`. The mirrors cannot drift — each is one column of a composite foreign key whose remaining columns are the parent's key — which is what lets a three-table predicate be checked against a single row. No trigger.

**Tech Stack:** PostgreSQL 16, Prisma 6, Next.js 14 App Router, TypeScript strict, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-template-room-archive-invariant-design.md`

## Global Constraints

- **Never edit an applied migration.** A comment-only edit changes its checksum while `prisma migrate status` compares only names. Prose about a migration goes in `docs/`.
- **Never start or restart the dev server on :3000.** The user runs it; integration tests need it live.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses.
- **Never write a GitHub auto-close keyword immediately before `#<number>`** in any commit message, PR body or issue comment — including when quoting this rule. Write "#N is unaffected", or separate the token from the number.
- TypeScript `strict: true`. No `any`, no implicit types.
- Comments annotate the code they sit on. No prose counts, no rosters. See CLAUDE.md *Comment Discipline*.
- The migration is **hand-authored**, following `prisma/migrations/20260721061528_student_claim_link_check/`.
- Commit per task — the PR is rebase-merged and the per-task history is the record.

## Names this plan fixes (used across tasks)

| Thing | Name |
|---|---|
| Migration directory | `20260827120000_template_room_archive_invariant` |
| Room parent key | `TeacherRoom_id_isArchived_key` |
| Rule generated column | `ScheduleRule.live` |
| Rule parent key | `ScheduleRule_id_kind_live_key` |
| Rule foreign key (widened) | `ClassTemplate_scheduleRuleId_kind_ruleLive_fkey` |
| Room foreign key (widened) | `ClassTemplate_teacherRoomId_roomArchived_fkey` |
| The invariant | `ClassTemplate_live_needs_open_room` |
| New matcher module | `src/lib/check-violation.ts` |
| New constraint test | `src/services/template-room-constraint.test.ts` |
| New race test | `src/services/template-room-race.test.ts` |

---

### Task 1: The constraint — migration, schema declarations, docblocks, door tests

**Files:**
- Create: `prisma/migrations/20260827120000_template_room_archive_invariant/migration.sql`
- Create: `src/services/template-room-constraint.test.ts`
- Modify: `prisma/schema.prisma` (models `TeacherRoom`, `ScheduleRule`, `ClassTemplate`)

**Interfaces:**
- Consumes: nothing.
- Produces: the six constraint objects named in the table above. Later tasks match on `ClassTemplate_live_needs_open_room` (a `23514`) and on the two foreign key names (a `23503`).

**Read first:** spec §3 (the SQL), §4.3 (why `SET NOT NULL` is load-bearing), §5 (the docblocks, already written — copy them, do not rewrite them).

- [ ] **Step 1: Write the failing test**

Modelled on `src/services/schedule-rule-constraints.test.ts`, which is the house pattern for "assert the DATABASE refused". Create `src/services/template-room-constraint.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const suffix = `troom-${Date.now()}`;
const accountIds: string[] = [];
let teacherId: string;
let roomId: string;
let openRoomId: string;
let shelvedRoomId: string;

/** SQLSTATE 23514 raised by `constraint`, in either Prisma error shape. */
function isCheck(err: unknown, constraint: string): boolean {
  const m = err instanceof Error ? err.message : '';
  return (m.includes('code: "23514"') || m.includes('Code: `23514`')) && m.includes(constraint);
}
/** SQLSTATE 23503 raised by `constraint` — a mirror that disagrees with its parent. */
function isFk(err: unknown, constraint: string): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    return err.meta?.constraint === constraint;
  }
  const m = err instanceof Error ? err.message : '';
  return (m.includes('code: "23503"') || m.includes('Code: `23503`')) && m.includes(constraint);
}

const CHECK = 'ClassTemplate_live_needs_open_room';
const ROOM_FK = 'ClassTemplate_teacherRoomId_roomArchived_fkey';
const at = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

async function makeRoom(tag: string, archived: boolean): Promise<string> {
  const room = await prisma.room.create({
    data: {
      venueName: `Venue ${tag}`, address: `${suffix} ${tag} Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: tag, maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  const link = await prisma.teacherRoom.create({
    data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12, isArchived: archived },
  });
  return link.id;
}

/**
 * A rule and its template, at a weekday/time chosen per test so
 * `ScheduleRule_teacher_slot_excl` never fires and mask a result here.
 */
async function makeTemplate(
  dayOfWeek: number, teacherRoomId: string,
  opts: { isActive?: boolean; ruleLive?: boolean; roomArchived?: boolean } = {},
): Promise<string> {
  const isActive = opts.isActive ?? true;
  const rule = await prisma.scheduleRule.create({
    data: {
      teacherId, kind: 'regular', classType: 'Yoga',
      dayOfWeek, startTime: at('19:00'), durationMinutes: 90, isActive,
    },
  });
  const tmpl = await prisma.classTemplate.create({
    data: {
      scheduleRuleId: rule.id, kind: 'regular', teacherRoomId,
      ruleLive: opts.ruleLive ?? isActive,
      roomArchived: opts.roomArchived ?? false,
      roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
    },
  });
  return tmpl.id;
}

beforeAll(async () => {
  await prisma.$connect();
  const email = `owner-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Room', lastName: 'Guard', email, bio: 'room invariant fixture',
      pageSlug: `owner-${suffix}`, account: { create: { email } },
    },
  });
  teacherId = t.id; accountIds.push(t.accountId);
  roomId = await makeRoom('base', false);
  openRoomId = await makeRoom('open', false);
  shelvedRoomId = await makeRoom('shelved', true);
});

afterAll(async () => {
  // Order matters: `ClassTemplate_teacherRoomId_roomArchived_fkey` is
  // ON DELETE RESTRICT, so templates must go before the rooms they point at.
  // Deleting the rules cascades the templates away.
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { createdById: teacherId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('ClassTemplate_live_needs_open_room', () => {
  it('door 1: refuses archiving a room a LIVE template sits on', async () => {
    const room = await makeRoom('door1', false);
    await makeTemplate(1, room);
    await expect(
      prisma.teacherRoom.update({ where: { id: room }, data: { isArchived: true } }),
    ).rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 1b: ALLOWS archiving a room only a PAUSED template sits on', async () => {
    const room = await makeRoom('door1b', false);
    const tmpl = await makeTemplate(2, room, { isActive: false, ruleLive: false });
    await prisma.teacherRoom.update({ where: { id: room }, data: { isArchived: true } });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tmpl } });
    // The cascade carried the parent's new value down, without the app writing it.
    expect(after.roomArchived).toBe(true);
    expect(after.ruleLive).toBe(false);
  });

  it('door 3: refuses resuming a template whose room is archived', async () => {
    const room = await makeRoom('door3', false);
    const tmpl = await makeTemplate(3, room, { isActive: false, ruleLive: false });
    await prisma.teacherRoom.update({ where: { id: room }, data: { isArchived: true } });
    const { scheduleRuleId } = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tmpl } });
    await expect(
      prisma.scheduleRule.update({ where: { id: scheduleRuleId }, data: { isActive: true } }),
    ).rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 4: refuses creating a LIVE template on an archived room', async () => {
    await expect(makeTemplate(4, shelvedRoomId, { roomArchived: true }))
      .rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 4: a create that ASSERTS the room is open fails on the FK, not the CHECK', async () => {
    // This is the shape `createClassTemplate` uses (Task 4): it writes
    // `roomArchived: false` rather than reading the room, so an archived room
    // has no matching parent key.
    await expect(makeTemplate(5, shelvedRoomId, { roomArchived: false }))
      .rejects.toSatisfy((e: unknown) => isFk(e, ROOM_FK));
  });

  it('door 5: refuses moving a LIVE template onto an archived room', async () => {
    const tmpl = await makeTemplate(6, openRoomId);
    await expect(prisma.classTemplate.update({
      where: { id: tmpl },
      data: { teacherRoomId: shelvedRoomId, roomArchived: true },
    })).rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 5b: ALLOWS moving a PAUSED template onto an archived room', async () => {
    const tmpl = await makeTemplate(0, openRoomId, { isActive: false, ruleLive: false });
    const moved = await prisma.classTemplate.update({
      where: { id: tmpl },
      data: { teacherRoomId: shelvedRoomId, roomArchived: true },
    });
    expect(moved.teacherRoomId).toBe(shelvedRoomId);
  });

  it('the mirror cannot lie: denying an archived room fails on the FK', async () => {
    const tmpl = await makeTemplate(0, shelvedRoomId, {
      isActive: false, ruleLive: false, roomArchived: true,
    });
    await expect(prisma.classTemplate.update({
      where: { id: tmpl }, data: { roomArchived: false },
    })).rejects.toSatisfy((e: unknown) => isFk(e, ROOM_FK));
  });
});
```

**If a `dayOfWeek` collides with `ScheduleRule_teacher_slot_excl`, change the number — do not change the constraint.** Two of this teacher's live rules on the same weekday and overlapping time conflict by design (#296/#298). A `23P01` here means the fixture is wrong, not the invariant.

- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
npx vitest run --project unit src/services/template-room-constraint.test.ts
```

Expected: every `it` fails. The refusal cases fail because the write **succeeds** (there is no constraint yet), not because of a fixture error — read the output and confirm that. `door 1b` and `door 5b` will also fail, at the `roomArchived`/`ruleLive` assertions, because those columns do not exist yet; Prisma will reject the unknown field. That is the expected shape.

- [ ] **Step 3: Hand-author the migration**

Create `prisma/migrations/20260827120000_template_room_archive_invariant/migration.sql`:

```sql
-- Invariant, DB-enforced: an active ClassTemplate may not reference an
-- archived TeacherRoom. Held until now by four application doors, every one a
-- non-transactional read; two of them were measured losing the race.
--
-- The predicate spans three tables, so it is collapsed onto one row by
-- mirroring each parent's state through a composite foreign key. The mirrors
-- cannot drift: each is one column of a key whose other columns are the
-- parent's, so a disagreeing row is refused rather than stored, and
-- ON UPDATE CASCADE rewrites the children when a parent changes.

-- The parent key the room mirror points at.
ALTER TABLE "TeacherRoom"
  ADD CONSTRAINT "TeacherRoom_id_isArchived_key" UNIQUE ("id", "isArchived");

-- Rule liveness, per row, so a foreign key can reference it.
ALTER TABLE "ScheduleRule"
  ADD COLUMN "live" BOOLEAN GENERATED ALWAYS AS ("isActive" AND NOT "isArchived") STORED;
-- NOT NULL is required, not tidy: a generated column is nullable by default and
-- Prisma's Boolean is required, so without this the drift check in CI fails.
ALTER TABLE "ScheduleRule" ALTER COLUMN "live" SET NOT NULL;
ALTER TABLE "ScheduleRule"
  ADD CONSTRAINT "ScheduleRule_id_kind_live_key" UNIQUE ("id", "kind", "live");

-- The mirrors, backfilled from the parents they mirror.
ALTER TABLE "ClassTemplate" ADD COLUMN "ruleLive"     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClassTemplate" ADD COLUMN "roomArchived" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ClassTemplate" ct SET "ruleLive"     = sr."live"
  FROM "ScheduleRule" sr WHERE sr."id" = ct."scheduleRuleId";
UPDATE "ClassTemplate" ct SET "roomArchived" = tr."isArchived"
  FROM "TeacherRoom"  tr WHERE tr."id" = ct."teacherRoomId";

-- The two existing foreign keys, widened to carry the mirrored column.
-- Referential actions are preserved exactly; delete behaviour is unchanged.
ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_scheduleRuleId_kind_fkey";
ALTER TABLE "ClassTemplate" ADD  CONSTRAINT "ClassTemplate_scheduleRuleId_kind_ruleLive_fkey"
  FOREIGN KEY ("scheduleRuleId", "kind", "ruleLive")
  REFERENCES "ScheduleRule"("id", "kind", "live") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_teacherRoomId_fkey";
ALTER TABLE "ClassTemplate" ADD  CONSTRAINT "ClassTemplate_teacherRoomId_roomArchived_fkey"
  FOREIGN KEY ("teacherRoomId", "roomArchived")
  REFERENCES "TeacherRoom"("id", "isArchived") ON UPDATE CASCADE ON DELETE RESTRICT;

-- The invariant.
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_live_needs_open_room"
  CHECK (NOT ("ruleLive" AND "roomArchived"));
```

- [ ] **Step 4: Declare it in `prisma/schema.prisma`**

Three models change. `TeacherRoom` gains one line beside its existing `@@unique`:

```prisma
  @@unique([teacherId, roomId])
  @@unique([id, isArchived])
```

`ScheduleRule` gains the generated column after `isArchived`, with the docblock **copied verbatim from spec §5** (`ScheduleRule.live`):

```prisma
  live       Boolean @default(dbgenerated())
```

and the parent key beside its existing one:

```prisma
  @@unique([id, kind])
  @@unique([id, kind, live])
```

`ClassTemplate` gains the two mirrors after `teacherRoomId`, with the docblock **copied verbatim from spec §5** (the `MIRRORS, MAINTAINED BY POSTGRES` block) sitting above them:

```prisma
  ruleLive        Boolean         @default(true)
  roomArchived    Boolean         @default(false)
```

and both relations widened:

```prisma
  scheduleRule ScheduleRule @relation(fields: [scheduleRuleId, kind, ruleLive], references: [id, kind, live], onDelete: Cascade)
  teacherRoom  TeacherRoom  @relation(fields: [teacherRoomId, roomArchived], references: [id, isArchived])
```

- [ ] **Step 5: Apply, and confirm Prisma agrees the SQL matches the schema**

```bash
npx prisma migrate dev
```

Expected: the pending migration applies and **no new migration is generated**. If Prisma offers to create one, the hand-authored SQL and the schema disagree — fix the SQL, not the schema, and **delete the migration Prisma created** before re-running. Do not edit the applied file afterwards.

**The fallback, if the generated column cannot be made driftless (spec §7.1).**
Should Step 6 prove unwinnable, drop `ScheduleRule.live` entirely and reference
`(id, kind, isActive, isArchived)` directly: `ClassTemplate` then mirrors
`ruleIsActive` and `ruleIsArchived` as plain booleans, and the CHECK becomes
`NOT ("ruleIsActive" AND NOT "ruleIsArchived" AND "roomArchived")`. Three mirrored
columns instead of two, no generated column, and no Prisma unknowns at all. This
is a contingency, not a preference — the generated form is measured green against
the required check, so take the fallback only on evidence, and record what forced
it.

- [ ] **Step 6: Run the required CI check**

```bash
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                        --to-schema-datamodel  prisma/schema.prisma --exit-code
echo "exit=$?"
```

Expected: `No difference detected.` and `exit=0`. This is the check that matters — **not** `prisma migrate status`, which compares migration names and is structurally incapable of seeing a column the datamodel cannot express.

- [ ] **Step 7: Prove that check can fail (mutation 1)**

Temporarily remove `ALTER TABLE "ScheduleRule" ALTER COLUMN "live" SET NOT NULL;` from a **scratch copy** of the flow — do this by dropping the constraint live rather than editing the applied migration:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -c \
  'ALTER TABLE "ScheduleRule" ALTER COLUMN "live" DROP NOT NULL;'
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                        --to-schema-datamodel  prisma/schema.prisma --exit-code; echo "exit=$?"
```

Expected: `exit=2`, reporting `Altered column \`live\` (changed from Nullable to Required)`. **Record that exact text in the PR body.** Restore and re-verify:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -c \
  'ALTER TABLE "ScheduleRule" ALTER COLUMN "live" SET NOT NULL;'
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                        --to-schema-datamodel  prisma/schema.prisma --exit-code; echo "exit=$?"
```

Expected: back to `exit=0`.

- [ ] **Step 8: Run the door tests**

```bash
npx vitest run --project unit src/services/template-room-constraint.test.ts
```

Expected: all pass, including `door 1b` and `door 5b`, which are the cases an over-broad constraint would break.

- [ ] **Step 9: Prove the CHECK bites (mutation 2)**

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
  'ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_live_needs_open_room";'
npx vitest run --project unit src/services/template-room-constraint.test.ts
```

Expected: doors 1, 3, 4 and 5 go RED (the writes now succeed); the two FK cases and both `b` cases stay green. **Record which cases went red.** Restore:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
  'ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_live_needs_open_room" CHECK (NOT ("ruleLive" AND "roomArchived"));'
npx vitest run --project unit src/services/template-room-constraint.test.ts
```

Expected: green again. If the `ADD CONSTRAINT` fails with *"is violated by some row"*, the mutation run left a forbidden row behind — delete it, then restore.

- [ ] **Step 10: Prove the FK bites (mutation 3)**

Narrow the room foreign key back to one column, run, restore:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
  'ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_teacherRoomId_roomArchived_fkey";
   ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_teacherRoomId_roomArchived_fkey"
     FOREIGN KEY ("teacherRoomId") REFERENCES "TeacherRoom"("id") ON UPDATE CASCADE ON DELETE RESTRICT;'
npx vitest run --project unit src/services/template-room-constraint.test.ts
```

Expected: the two FK cases go RED — the mirror can now lie. Restore the two-column form and re-verify green.

- [ ] **Step 11: Confirm the `23514` sweep is not disturbed**

```bash
npx vitest run --project unit src/lib/api-errors.test.ts
```

Expected: green. That suite sweeps live migration bodies for `USING ERRCODE = '23514'`; a plain `CHECK` carries no such clause, so this constraint is outside its census. If it reddens, read the failure rather than adding a tail to `TERMINAL_TRIGGER_TAILS` — this constraint is not a terminality guard.

- [ ] **Step 12: Verify what the Prisma client does with `live` (spec §7.2)**

The spec flags this as **unverified** — `prisma generate` could not be run during
the design spike. Prisma has no generated-column concept, so `live` may appear as
a writable field. Find out rather than assume:

```bash
npx prisma generate
grep -n "live" node_modules/.prisma/client/index.d.ts | grep -iE "ScheduleRule(Unchecked)?(Create|Update)Input" | head
```

Then confirm what a write actually does:

```bash
npx tsx -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
p.\$queryRaw\`SELECT 1\`.then(async () => {
  const r = await p.scheduleRule.findFirst();
  if (!r) return console.log('no rule to test against');
  try {
    // @ts-expect-error - if this line does NOT error, the client exposes it
    await p.scheduleRule.update({ where: { id: r.id }, data: { live: false } });
    console.log('WRITE ACCEPTED - client exposes a generated column');
  } catch (e) { console.log('refused:', (e as Error).message.slice(0, 200)); }
  await p.\$disconnect();
});"
```

Expected: Postgres refuses with `428C9` ("cannot insert a non-DEFAULT value into
column"). **Record the outcome in the PR body either way.**

- If the `@ts-expect-error` is itself unused (a compile error), TypeScript already
  refuses the write and nothing more is needed — say so.
- If the write compiles and is refused only at runtime, that is acceptable but
  worth one line in the `ScheduleRule.live` docblock stating that the column is
  writable to the client and refused by the database. Do not build a guard for
  it; no code writes `live`, and a test pinning "nobody writes this" is the kind
  of claim that goes stale silently.

- [ ] **Step 13: Measure whether `teacherRoomId` wants an index (spec §7.3)**

Archiving a room must now find every `ClassTemplate` that mirrors it. PostgreSQL
does not index the referencing side of a foreign key automatically, and this
column has only the key:

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -c \
  'EXPLAIN ANALYZE UPDATE "TeacherRoom" SET "isArchived" = "isArchived" WHERE id = (SELECT id FROM "TeacherRoom" LIMIT 1);'
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -c \
  '\d "ClassTemplate"' | grep -i index
```

**Measure, then decide — do not add an index on principle.** A sequential scan
over a table this size costs nothing, and an index that is never needed is a
write cost on every template insert forever. If the plan is to skip it, say so in
the PR body with the row count that justifies it, so a future reader knows it was
considered rather than missed.

- [ ] **Step 14: Commit**

```bash
git add prisma/migrations/20260827120000_template_room_archive_invariant/migration.sql \
        prisma/schema.prisma src/services/template-room-constraint.test.ts
git commit -m "feat: the template/room invariant is a constraint, not four doors (issue 272)"
```

---

### Task 2: The race, as a passing test

**Files:**
- Create: `src/services/template-room-race.test.ts`

**Interfaces:**
- Consumes: the constraint objects from Task 1.
- Produces: nothing other tasks import.

Issue 272's own acceptance criterion is that its reproduction becomes a passing test. Task 1 proves the constraint refuses **sequentially**; that is not the same claim. With the constraint absent, every Task 1 case would still pass on a sequential retry — the defect only exists under contention.

- [ ] **Step 1: Write the failing test**

Two connections, so one can hold a transaction open while the other writes. Create `src/services/template-room-race.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

/** Two clients, because one connection cannot hold a transaction open for another. */
const a = new PrismaClient();
const b = new PrismaClient();
const suffix = `race-${Date.now()}`;
let teacherId: string;
let accountId: string;
let teacherRoomId: string;
let ruleId: string;

beforeAll(async () => {
  await Promise.all([a.$connect(), b.$connect()]);
  const email = `race-${suffix}@test.local`;
  const t = await a.teacher.create({
    data: {
      firstName: 'Race', lastName: 'Fixture', email, bio: 'race fixture',
      pageSlug: `race-${suffix}`, account: { create: { email } },
    },
  });
  teacherId = t.id; accountId = t.accountId;
  const room = await a.room.create({
    data: {
      venueName: 'Race Venue', address: `${suffix} Race Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  const link = await a.teacherRoom.create({
    data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
  });
  teacherRoomId = link.id;
  // A PAUSED template on an OPEN room — the state door 3's race starts from.
  const rule = await a.scheduleRule.create({
    data: {
      teacherId, kind: 'regular', classType: 'Yoga', dayOfWeek: 4,
      startTime: new Date('1970-01-01T19:00:00Z'), durationMinutes: 90, isActive: false,
    },
  });
  ruleId = rule.id;
  await a.classTemplate.create({
    data: {
      scheduleRuleId: rule.id, kind: 'regular', teacherRoomId,
      ruleLive: false, roomArchived: false,
      roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
    },
  });
});

afterAll(async () => {
  await a.scheduleRule.deleteMany({ where: { teacherId } });
  await a.teacherRoom.deleteMany({ where: { teacherId } });
  await a.room.deleteMany({ where: { createdById: teacherId } });
  await a.teacher.deleteMany({ where: { id: teacherId } });
  await a.account.deleteMany({ where: { id: accountId } });
  await Promise.all([a.$disconnect(), b.$disconnect()]);
});

describe('the room archive that used to slip past door 3', () => {
  it('refuses the archive that commits while a resume is in flight', async () => {
    let archiveError: unknown;
    let archiveSettledAt = 0;
    let resumeCommittedAt = 0;

    // A: resume the template, then hold the transaction open.
    const resume = a.$transaction(async (tx) => {
      await tx.scheduleRule.update({ where: { id: ruleId }, data: { isActive: true } });
      await new Promise((r) => setTimeout(r, 1500));
    }).then(() => { resumeCommittedAt = Date.now(); });

    // B: archive the room from the other connection, mid-flight.
    await new Promise((r) => setTimeout(r, 500));
    const archive = b.teacherRoom
      .update({ where: { id: teacherRoomId }, data: { isArchived: true } })
      .catch((e: unknown) => { archiveError = e; })
      .finally(() => { archiveSettledAt = Date.now(); });

    await Promise.all([resume, archive]);

    // The archive was refused...
    expect(archiveError).toBeDefined();
    expect(String(archiveError)).toContain('ClassTemplate_live_needs_open_room');
    // ...and it WAITED for the resume rather than racing past it. Without the
    // wait this assertion is what fails, and the wait is the whole property:
    // a check that merely read the room would have passed and then been wrong.
    expect(archiveSettledAt).toBeGreaterThanOrEqual(resumeCommittedAt);

    // The resume stands; the room is still open.
    const room = await a.teacherRoom.findUniqueOrThrow({ where: { id: teacherRoomId } });
    expect(room.isArchived).toBe(false);
    const rule = await a.scheduleRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(rule.isActive).toBe(true);
  }, 20_000);
});
```

- [ ] **Step 2: Run it**

```bash
npx vitest run --project unit src/services/template-room-race.test.ts
```

Expected: PASS. (It is written after Task 1, so it passes immediately; Step 3 is what earns it.)

- [ ] **Step 3: Prove it can fail — this is the test's whole value**

```bash
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c \
  'ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_live_needs_open_room";'
npx vitest run --project unit src/services/template-room-race.test.ts
```

Expected: RED at `expect(archiveError).toBeDefined()` — the archive succeeds, which **is issue 272 reproduced**. Record the failure output in the PR body. Restore the constraint and re-verify green, deleting any forbidden row the mutation left behind if `ADD CONSTRAINT` refuses.

- [ ] **Step 4: Confirm the timing assertion is not vacuous**

Reduce the transaction hold from `1500` to `0` in a scratch edit, run, and confirm the test still passes — then **restore 1500**. If it passes at `0`, the two statements never overlapped and the timing assertion proves nothing; increase the hold until the ordering is real. Note in the PR body which hold was used.

- [ ] **Step 5: Commit**

```bash
git add src/services/template-room-race.test.ts
git commit -m "test: the archive that used to slip past door 3 is refused, and waits (issue 272)"
```

---

### Task 3: `isCheckViolationOn` — a matcher for this SQLSTATE

**Files:**
- Create: `src/lib/check-violation.ts`
- Create: `src/lib/check-violation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function isCheckViolationOn(err: unknown, constraint: string): boolean
  ```
  Task 4 and Task 5 import it.

**Read first:** `src/lib/exclusion-conflict.ts` — this module is its sibling and must follow its two-shape structure. Also `isTerminalStatusViolation` in `src/lib/api-errors.ts`, whose docblock explains why `23514` alone is never a safe match.

- [ ] **Step 1: Write the failing test**

Create `src/lib/check-violation.test.ts`. The two message shapes are copied from real errors observed in `api-errors.test.ts`; **do not invent them**:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isCheckViolationOn } from './check-violation';

const NAME = 'ClassTemplate_live_needs_open_room';

/** Shape 1: a typed model call. The SQLSTATE survives only in `message`. */
const typedCall = new Prisma.PrismaClientUnknownRequestError(
  'Invalid `prisma.teacherRoom.update()` invocation:\n\n\nError occurred during query execution:\n'
  + 'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { '
  + 'code: "23514", message: "new row for relation \\"ClassTemplate\\" violates check constraint '
  + `\\"${NAME}\\"", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: '6.19.3' },
);

/** Shape 2: a raw query. Prisma wraps it as P2010 and spells the code differently. */
const rawQuery = new Prisma.PrismaClientKnownRequestError(
  'Raw query failed. Code: `23514`. Message: `ERROR: new row for relation "ClassTemplate" '
  + `violates check constraint "${NAME}"\``,
  { code: 'P2010', clientVersion: '6.19.3' },
);

describe('isCheckViolationOn', () => {
  it('matches a typed model call', () => {
    expect(isCheckViolationOn(typedCall, NAME)).toBe(true);
  });

  it('matches a raw query', () => {
    expect(isCheckViolationOn(rawQuery, NAME)).toBe(true);
  });

  it('does not match a different constraint carrying the same SQLSTATE', () => {
    expect(isCheckViolationOn(typedCall, 'Student_claim_link_check')).toBe(false);
  });

  it('does not match a terminality trigger, which also raises 23514', () => {
    const terminal = new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "23514", message: "Class abc is completed, which is terminal; '
      + 'cannot change status to open" }',
      { clientVersion: '6.19.3' },
    );
    expect(isCheckViolationOn(terminal, NAME)).toBe(false);
  });

  it('does not match a message that merely quotes the name without the SQLSTATE', () => {
    const noCode = new Error(`something mentioning ${NAME} but no sqlstate`);
    expect(isCheckViolationOn(noCode, NAME)).toBe(false);
  });

  it('does not match a non-error', () => {
    expect(isCheckViolationOn('a string', NAME)).toBe(false);
    expect(isCheckViolationOn(null, NAME)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project unit src/lib/check-violation.test.ts
```

Expected: FAIL — `Failed to resolve import "./check-violation"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/check-violation.ts`:

```ts
/**
 * True when `err` is a PostgreSQL `23514` raised by the CHECK constraint named
 * `constraint`.
 *
 * BOTH the SQLSTATE and the name are required, and requiring the name is the
 * whole design. `23514` is Postgres's default for every plain CHECK in this
 * schema, and it is additionally what this repo's terminality triggers raise
 * with an explicit `USING ERRCODE` — so a matcher keyed on the code alone would
 * relabel unrelated refusals. `isTerminalStatusViolation` (`./api-errors`)
 * discriminates by message wording for the same reason; this one discriminates
 * by constraint name, which is available here and is not available there.
 *
 * Two error shapes carry the SQLSTATE and both are admitted, as
 * `isExclusionConflictOn` (`./exclusion-conflict`) admits both for `23P01`:
 *
 *   1. A typed model call — the SQLSTATE and the constraint name survive only
 *      in `message`, and Postgres's own quoting arrives escaped.
 *   2. A raw query — Prisma's `P2010`, which spells the code `` Code: `23514` ``
 *      and leaves the name quoted as Postgres wrote it.
 *
 * Matching the name as a bare substring covers both quotings without a second
 * branch; the SQLSTATE is matched inside its Postgres framing rather than as a
 * bare number, which is the trap `isTransientDbError` documents.
 */
export function isCheckViolationOn(err: unknown, constraint: string): boolean {
  if (!(err instanceof Error)) return false;
  const carriesCode =
    err.message.includes('code: "23514"') || err.message.includes('Code: `23514`');
  return carriesCode && err.message.includes(constraint);
}
```

- [ ] **Step 4: Run it**

```bash
npx vitest run --project unit src/lib/check-violation.test.ts
```

Expected: all pass.

- [ ] **Step 5: Prove each half of the predicate bites (mutation 4)**

Two mutations, one per conjunct. Apply, run, record, restore:

- Delete `carriesCode &&` → expect "does not match a message that merely quotes the name" to go RED.
- Replace `err.message.includes(constraint)` with `true` → expect both "different constraint" and "terminality trigger" to go RED.

Record both error outputs. Restore and re-verify green after each.

- [ ] **Step 6: Commit**

```bash
git add src/lib/check-violation.ts src/lib/check-violation.test.ts
git commit -m "feat: a matcher for 23514 that discriminates by constraint name (issue 272)"
```

---

### Task 4: The template family's room refusal moves to the route

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` — `PauseTemplateResult` (the `room_archived` arm), `UpdateClassTemplateResult` (its `room_archived` arm), the door 3 guard, the door 5 guard, `createClassTemplate`
- Modify: `src/app/api/class-templates/[id]/route.ts:129-137` (door 5 arm), `:295-302` (door 3 arm), and both handlers' pre-checks
- Modify: `src/app/api/class-templates/route.ts:65-80` (door 4)
- Modify: the existing tests that assert `reason: 'room_archived'`

**Interfaces:**
- Consumes: `isCheckViolationOn` (Task 3); the constraint names from Task 1.
- Produces: `PauseTemplateResult` without a `room_archived` arm — which is what makes its reason set equal `PauseStudioTemplateResult`'s.

**Read first:** spec §6. Each service here has exactly **one** caller and it is the route (verified by grep), so moving a refusal out of a service union changes one call site each.

**The shape to build, stated once so the three doors do not drift:**

| Door | Where the message comes from | Where enforcement comes from |
|---|---|---|
| 3 (resume) | route pre-check before calling the service | `23514` on the CHECK, caught in the route |
| 4 (create) | route pre-check, already there | `23503` on the room FK — `createClassTemplate` writes `roomArchived: false`, *asserting* an open room, so no read is needed |
| 5 (move) | route pre-check before calling the service | `23514` or `23503` — the service mirrors the target room's real `isArchived`, so a stale read gives `23503` and a fresh-but-forbidden one gives `23514` |

Both codes mean the same thing to a teacher and get the identical 409.

- [ ] **Step 1: Write the failing tests**

Add to `src/services/class-template-lifecycle.test.ts` (or the file that currently covers these — find it with `grep -rn "room_archived" src/services/*.test.ts`):

```ts
it('resuming a template whose room is archived now throws the constraint, not a typed refusal', async () => {
  // The refusal moved to the route (issue 272). The service no longer reads the
  // room, so what stops it is the database.
  await expect(pauseOrResumeTemplate(prisma, templateId, teacherId, 'active'))
    .rejects.toSatisfy((e: unknown) =>
      isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room'));
});
```

and, in the route tests (`tests/integration/` — find with `grep -rln "ROOM_ARCHIVED" tests/`), assert the wire behaviour is unchanged:

```ts
it('still answers 409 ROOM_ARCHIVED when resuming onto an archived room', async () => {
  const res = await fetch(`${BASE}/api/class-templates/${templateId}?state=active`, {
    method: 'PATCH', headers: authHeaders,
  });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('ROOM_ARCHIVED');
});
```

**The route contract must not change.** Same status, same code, same copy — only where the decision is made moves.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
```

Expected: the new service test FAILS because the service still returns `{ ok: false, reason: 'room_archived' }` rather than throwing.

- [ ] **Step 3: Remove the door 3 guard and its union arm**

In `src/services/class-template-lifecycle.ts`:
- Delete the `room_archived` arm from `PauseTemplateResult` **and its docblock**.
- Delete the guard (`if (desiredActive && template.teacherRoom.isArchived) { … }`) and the whole `KNOWN-OPEN (issue 116)` paragraph above it — the state it describes is no longer reachable, so the note is not "updated", it is **removed**.
- Drop `teacherRoom: { select: { isArchived: true } }` from the `findUnique`'s `include`, and the `teacherRoom: _tr` from the destructuring that strips it. **The compiler will point at both**; if it does not, the include was feeding something else and that must be understood before deleting it.

- [ ] **Step 4: Remove the door 5 guard and its union arm**

Same file: delete `UpdateClassTemplateResult`'s `room_archived` arm and the guard at the `data.teacherRoomId !== undefined` branch, keeping the ownership check (`!teacherRoom || teacherRoom.teacherId !== teacherId` → `invalid_room`) — that is a different rule and it stays.

Then make the write mirror the target room, in the same transaction:

```ts
// The mirror is written, not defaulted: moving to a different room means the
// child's `roomArchived` must equal that room's `isArchived` or the composite
// foreign key refuses the row. A PAUSED template may legitimately move onto an
// archived room, so this cannot assert `false` the way the create path does.
const childData = {
  ...rest,
  ...(data.teacherRoomId !== undefined
    ? { teacherRoomId: data.teacherRoomId, roomArchived: teacherRoom.isArchived }
    : {}),
};
```

- [ ] **Step 5: Make the create path assert an open room**

In `createClassTemplate`, add `roomArchived: false` to the `tx.classTemplate.create` data:

```ts
        data: {
          scheduleRuleId: rule.id,
          kind: 'regular',
          teacherRoomId: input.teacherRoomId,
          // ASSERTS the room is open rather than reading it. There is no
          // matching parent key for an archived room, so this is refused by the
          // foreign key without a read that could go stale between the two.
          roomArchived: false,
```

`ruleLive` is left to its `true` default: a rule is born `isActive: true`, and the FK refuses the row if that is ever untrue.

- [ ] **Step 6: Add the route pre-checks and the constraint catches**

In `src/app/api/class-templates/[id]/route.ts`, in the PATCH handler, before `pauseOrResumeTemplate`:

```ts
  // Door 3 of the room archive lifecycle (issue 76), as a PRE-CHECK rather
  // than enforcement (issue 272). What actually refuses this is
  // `ClassTemplate_live_needs_open_room`; this read exists so the common case
  // gets a sentence a teacher can act on instead of a raced 409. The same
  // shape the slot invariant uses: constraint underneath, probe for the copy.
  if (state === 'active') {
    const tmpl = await prisma.classTemplate.findUnique({
      where: { id }, select: { roomArchived: true },
    });
    if (tmpl?.roomArchived) return roomArchivedResponse('resume');
  }
```

Note this reads `ClassTemplate.roomArchived` — the mirror — not a join to `TeacherRoom`. It is the same value by construction and needs no join.

Wrap the service call so a lost race answers the same 409 as the pre-check:

```ts
  let result;
  try {
    result = await pauseOrResumeTemplate(prisma, id, session.teacherId, state);
  } catch (e) {
    if (isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room')) {
      log.warn({ templateId: id }, 'template resume lost the room-archive race');
      return roomArchivedResponse('resume');
    }
    throw e;
  }
```

Add one shared helper in that file so the two verbs cannot drift apart in copy:

```ts
/**
 * The 409 both room-archive doors in this file answer with. One function
 * because the two differ only in the verb, and they were measured drifting
 * apart in wording once already.
 */
function roomArchivedResponse(verb: 'resume' | 'move'): Response {
  return respondError(
    verb === 'resume'
      ? 'This room is archived. Unarchive it to resume this recurring class.'
      : 'This room is archived. Unarchive it to move this recurring class here.',
    409,
    'ROOM_ARCHIVED',
  );
}
```

Do the same for the PUT handler (door 5), catching **both** `isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room')` and `isRestrictViolationOn(e, ['ClassTemplate_teacherRoomId_roomArchived_fkey'])`. In `src/app/api/class-templates/route.ts`, door 4's existing pre-check stays exactly as it is; add the same two-code catch around `createClassTemplate`.

- [ ] **Step 7: Run the suites**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
npx vitest run --project integration tests/integration
```

Expected: green. The integration project needs the app running on :3000 — **do not start it**; if it is down, say so and stop.

- [ ] **Step 8: Prove the route catch bites (mutation 5)**

Delete the `catch` in the PATCH handler and run the race path. Expected: a 500 rather than a 409, because an unmatched `23514` falls through `classifyApiError` to the server-error branch. Record the status and body. Restore, re-verify.

- [ ] **Step 9: Prove the pre-check is not load-bearing (mutation 6)**

Delete the PATCH pre-check but keep the catch. Expected: the route test **still passes** with a 409 — proving enforcement is the constraint and the pre-check is only about which path produces the sentence. Record that. Restore.

If this mutation makes a test RED, the pre-check is doing enforcement work and this task is not finished.

- [ ] **Step 10: Run the #336 trigger**

```bash
diff <(sed -n '/^export type PauseTemplateResult/,/^$/p'       src/services/class-template-lifecycle.ts \
        | grep -oE "reason: '[a-z_]+'" | sort -u) \
     <(sed -n '/^export type PauseStudioTemplateResult/,/^$/p' src/services/studio-class-template-lifecycle.ts \
        | grep -oE "reason: '[a-z_]+'" | sort -u)
echo "exit=$?"
```

Expected: **empty output, `exit=0`** — the two reason sets now agree, which is issue 336's stated condition for becoming due. Record the output verbatim in the PR body whatever it is; if it is non-empty, report what remains rather than adjusting the types to force it.

- [ ] **Step 11: Commit**

```bash
git add src/services/class-template-lifecycle.ts \
        "src/app/api/class-templates/route.ts" \
        "src/app/api/class-templates/[id]/route.ts" \
        src/services/class-template-lifecycle.test.ts
git commit -m "refactor: the room refusal is the route's message, the constraint's enforcement (issue 272)"
```

---

### Task 5: Door 1 answers `in_use` when it loses the race

**Files:**
- Modify: `src/services/room-archive.ts:95-172` (`setTeacherRoomArchived`)
- Modify: `src/services/room-archive.test.ts`

**Interfaces:**
- Consumes: `isCheckViolationOn` (Task 3).
- Produces: `ArchiveRoomResult`'s existing `in_use` arm, now also reachable from a lost race.

`setTeacherRoomArchived` counts blockers, then writes. The counts are still worth keeping — they produce `blockers`, which `describeRoomBlockers` turns into the teacher's sentence. What changes is that the write can now throw, and an uncaught `23514` here is a 500 on a request the teacher can act on.

- [ ] **Step 1: Write the failing test**

In `src/services/room-archive.test.ts`:

```ts
it('answers in_use rather than throwing when the constraint refuses the archive', async () => {
  // The counts are read before the write, so a template resumed in between is
  // invisible to them. The constraint is what catches it; this asserts the
  // service turns that into the same answer the count would have given.
  const result = await setTeacherRoomArchived(prisma, teacherRoomId, teacherId, 'archived');
  expect(result).toEqual({
    ok: false, reason: 'in_use', blockers: { classes: 0, templates: 0 },
  });
});
```

Drive it by making the counts pass and the constraint fail — use the interposing-`$extends` lever `class-template-lifecycle.test.ts` already uses for "X lands between the read and the write", resuming the template after the counts and before the update.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project unit src/services/room-archive.test.ts
```

Expected: FAIL — the error propagates rather than being classified.

- [ ] **Step 3: Catch the constraint**

Replace the bare update with:

```ts
  try {
    await db.teacherRoom.update({
      where: { id: teacherRoomId },
      data: { isArchived: archiving },
    });
  } catch (e) {
    // The counts above are read before this write, so a template resumed in
    // between is invisible to them — this is that window closing, and it is
    // now a refusal rather than a wrong success (issue 272). `blockers` is
    // reported as the counts saw it: zero, which is honest about what this
    // function measured rather than inventing a number it did not.
    if (isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room')) {
      log.info(
        { teacherRoomId, teacherId },
        'room archive refused by the constraint: a template went live mid-request',
      );
      return { ok: false, reason: 'in_use', blockers: { classes: 0, templates: 0 } };
    }
    throw e;
  }
```

- [ ] **Step 4: Delete the KNOWN-OPEN note**

`src/services/room-archive.ts:157-167` describes an accepted race. **The template half of it is now closed** — but the *class* half is not: a class published into the room between the count and the write is still possible, because the class invariant is out of scope (spec §8). Rewrite the note to say only what is still true, naming the class side. Do not annotate the old text; replace it.

- [ ] **Step 5: Run and mutate**

```bash
npx vitest run --project unit src/services/room-archive.test.ts
```

Expected: green. Then delete the `if (isCheckViolationOn(...))` line and confirm the new test goes RED with an uncaught error rather than a typed result. Record, restore, re-verify.

- [ ] **Step 6: Commit**

```bash
git add src/services/room-archive.ts src/services/room-archive.test.ts
git commit -m "fix: a room archive that loses the race answers in_use, not a 500 (issue 272)"
```

---

### Task 6: Retire the notes, record the lock edges, sweep for what was invalidated

**Files:**
- Modify: `src/services/class-generator.ts:817-845` (the KNOWN-OPEN / REACHABLE note)
- Modify: `docs/lock-order.md` (new section)
- Modify: `src/lib/template-selection.ts` (only if its docblock's claims went stale)
- Modify: `CLAUDE.md` (only if a claim there went stale)

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

**Read first:** the solve-issue skill's §4 — *"Sweep for what you INVALIDATED, not for what you edited."*

- [ ] **Step 1: List what was removed, then grep for those names**

The sweep is derived from the objects that went, not the files that changed. Write the list down first:

```
reason: 'room_archived'                       (PauseTemplateResult, UpdateClassTemplateResult)
ClassTemplate_scheduleRuleId_kind_fkey        (replaced)
ClassTemplate_teacherRoomId_fkey              (replaced)
the door-3 guard in pauseOrResumeTemplate
the door-5 guard in updateClassTemplate
the KNOWN-OPEN note in class-generator.ts
the KNOWN-OPEN note in room-archive.ts
"five application doors"                      (the count itself)
```

Then, for each:

```bash
grep -rn "room_archived" src/ docs/ tests/ CLAUDE.md
grep -rn "ClassTemplate_teacherRoomId_fkey\|ClassTemplate_scheduleRuleId_kind_fkey" src/ docs/ tests/ prisma/
grep -rn "five application doors\|five doors\|five separate" src/ docs/ CLAUDE.md
grep -rn "door 1\|door 3\|door 4\|door 5\|door 2" src/ docs/ CLAUDE.md
```

**Give every hit a verdict.** Expect legitimate survivors — door 2 and door 4 still exist, `ROOM_ARCHIVED` is still a wire code, and `room-archive.ts`'s header still names the doors by verb. Rewriting a still-true claim is the mirror-image defect.

- [ ] **Step 2: Read whole docblocks in every function this branch touched**

A grep finds a stale *name*, never a stale *description*. The claims at risk here describe rather than name:

- `class-generator.ts`'s note says the state is "REACHABLE and measured" — it no longer is.
- `template-selection.ts`'s docblock says `ACTIVE_TEMPLATE_WHERE` reads only the template's own flags and never `teacherRoom.isArchived`. **That is still true and must not be "corrected"** — but the sentence explaining why that is acceptable may not be.
- `room-archive.ts`'s header calls itself "what gives `isArchived` meaning". After this branch the constraint does, for templates. Re-read that whole docblock.
- CLAUDE.md's *Class Lifecycle* section describes template/room rules — check whether any sentence there now describes a state that cannot occur.

- [ ] **Step 3: Rewrite `class-generator.ts`'s note**

Replace the `KNOWN-OPEN` / `REACHABLE and measured` block with what is true now: the selection still reads only the template's own flags, and it no longer needs to, because an active template on an archived room is not a representable state. Name the constraint. **Do not write what the comment used to say** — that belongs in the PR body.

- [ ] **Step 4: Add the lock-order section**

Append to `docs/lock-order.md`, following the style of *"One teacher, one slot: two exclusion constraints"*:

```markdown
## The room mirror's foreign keys are wait edges (#272)

`ClassTemplate_teacherRoomId_roomArchived_fkey` and
`ClassTemplate_scheduleRuleId_kind_ruleLive_fkey` acquire locks no application
code asks for, and they are the mechanism, not a side effect:

- updating `TeacherRoom."isArchived"` must rewrite every `ClassTemplate` row
  that mirrors it, so it locks those rows (`TeacherRoom → ClassTemplate`)
- updating `ClassTemplate."teacherRoomId"` or `."roomArchived"` takes
  `KEY SHARE` on the referenced `TeacherRoom` row
  (`ClassTemplate → TeacherRoom`)

Measured: with a resume holding its transaction open, a concurrent archive
blocked on the child row and was refused with `23514` once the resume
committed — the same shape as the exclusion constraints above, with a row lock
in place of an index entry. Re-derive the constraint set with:

    SELECT conrelid::regclass AS "table", conname, pg_get_constraintdef(oid)
      FROM pg_constraint
     WHERE conname LIKE '%roomArchived%' OR conname LIKE '%ruleLive%'
        OR conname = 'ClassTemplate_live_needs_open_room';

A deadlock still requires two transactions touching two rooms in opposite
orders, which is a pre-existing shape rather than one these keys introduce.
```

- [ ] **Step 5: Re-run the deadlock probe and record the result**

Drive two transactions that touch two rooms in opposite orders and record what happens — a `40P01` is an acceptable outcome to document, not a defect to fix, but it must not be a surprise in production. Put the result in the PR body.

- [ ] **Step 6: Full verification**

```bash
npm run verify
```

Expected: green — typecheck, lint, and every vitest project. It needs the app running on :3000; a wall of `ECONNREFUSED` means the server is down, which is the user's to start.

**While anything earlier is red, `integration` reports nothing at all** — `npm test` joins two invocations with `&&`. If the unit tier is red, run `npx vitest run --project integration` directly rather than reading a red `verify` as evidence about that tier.

Record the per-project file and test counts, with arithmetic that reconciles, for the PR body.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-generator.ts docs/lock-order.md
git commit -m "docs: the note the constraint retired, and the lock edges it added (issue 272)"
```

---

## After the tasks

1. **Whole-branch review** on the most capable model — task reviewers see only their own diff, and the defect class this branch is most exposed to is cross-task: three doors that must answer identically and a mirror-writing rule that differs per door.
2. **One fix wave, then one scoped re-review.** Derive the re-review's sweep from the wave's diff, not from a keyword: list the files the wave changed, list the files it was supposed to change, reconcile. A finding naming N locations gets N verdicts.
3. **Push, open the PR, run `/pr-review-toolkit:review-pr <N>`.** Include the type-design reviewer — `PauseTemplateResult` losing an arm is a type change with invariants attached, which is exactly its remit.
4. **The PR body records:** every mutation and its exact error text; the drift-check control (`exit=2`) beside the pass (`exit=0`); the race test's negative control; the #336 `diff` output; which suites ran with reconciling arithmetic; what this branch does **not** do — the class-side invariant (door 2) is unaffected and stays racy — and the two follow-ups filed. Write "#N is unaffected", never the auto-close phrasing.
