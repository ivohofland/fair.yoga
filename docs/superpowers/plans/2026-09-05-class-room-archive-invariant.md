# Class Room-Archive Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make *"a live `Class` may not sit in an archived `TeacherRoom`"* a database constraint, so the two remaining racy application doors become pre-checks that produce words while the database does the enforcing.

**Architecture:** Mirror both parents' state down onto `Class` through widened composite foreign keys — `entryLive` from `CalendarEntry.live` (a new generated column, `cancelledAt IS NULL`) and `roomArchived` from `TeacherRoom.isArchived` — so a predicate spanning three tables can be checked against one row by a single `CHECK`. This is issue 272's mechanism applied one table further; nothing about it is novel except that liveness now reaches through `CalendarEntry`.

**Tech Stack:** PostgreSQL (hand-authored migration SQL — Prisma cannot express CHECK constraints), Prisma, TypeScript strict, vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-class-room-archive-invariant-design.md`

## Global Constraints

- **Never edit an applied migration**, comment-only edits included. The checksum changes while `prisma migrate status` compares only names, so nothing catches it until the next `prisma migrate dev` demands a reset.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses.
- `BLOCKING_CLASS_STATUSES` stays `['open', 'in_progress']`. Changing which statuses block is out of scope; `draft`'s exclusion is deliberate and documented.
- Referential actions on both widened foreign keys are **preserved exactly**:
  - `Class_teacherRoomId_fkey` → `ON DELETE RESTRICT ON UPDATE CASCADE` (`20260403092044_init/migration.sql:345`)
  - `Class_calendarEntryId_kind_fkey` → `ON DELETE CASCADE ON UPDATE CASCADE` (`20260826080100_calendar_entry_rewire/migration.sql:94-96`)
- **Comment discipline** (CLAUDE.md): a comment annotates the code it sits on. No prose counts, no member rosters, no correction history — that goes in the PR body. Where membership matters, tether it to the compiler or a test.
- **Correct a claim by replacing it**, never by annotating it. No "this previously read X".
- **Which database does what** (`docs/test-database.md`): the `unit` and `unit-sweeps` tiers run against `ethical_yoga_test` (`DATABASE_URL_TEST`), whose global setup (`tests/setup/unit-db.ts`) runs `prisma migrate deploy` automatically — so every constraint test in this plan picks the new migration up with no manual step. The `integration` tier talks to the app on `:3000` against the **dev** database. **A worktree has neither a `.env` nor the dev server**, so: copy `.env` in before running anything, scope `npm run verify` to typecheck/lint/unit/components, and cite CI for the integration and e2e tiers.

**Task order is load-bearing.** Task 1's migration renames `Class_teacherRoomId_fkey`, which Task 2 fixes, and makes `POST /api/classes` refuse a legal write, which Task 3 fixes. Running them out of order leaves the tree red for reasons unrelated to the task under review.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `prisma/migrations/20260905120000_class_room_archive_invariant/migration.sql` | **Create.** The generated column, the remediation, the mirrors, the two widened FKs, the CHECK. | 1 |
| `prisma/schema.prisma` | **Modify.** `CalendarEntry.live`, `Class.entryLive`/`.roomArchived`, both relation definitions, the docblocks. | 1 |
| `src/services/class-room-constraint.test.ts` | **Create.** What the constraint refuses and permits, driven against the database. Sibling to `template-room-constraint.test.ts`. | 1 |
| `src/services/room-deletion.ts:43-46` | **Modify.** `ROOM_DELETE_RESTRICT_FKS` carries the new FK name. | 2 |
| `src/services/room-deletion.test.ts` | **Modify.** A case that reaches the catch rather than stopping at the pre-check. | 2 |
| `src/app/api/classes/route.ts:101-140` | **Modify.** Copy the room's `isArchived` under `FOR KEY SHARE`. | 3 |
| `src/services/class-generator.ts:48-62` | **Modify.** Copy `template.roomArchived`. | 3 |
| `src/services/class-lifecycle.ts:497-544` | **Modify.** Catch the CHECK around the CAS; return `ROOM_ARCHIVED`. | 4 |
| `src/services/room-archive.ts` | **Modify.** Class count into a closure, catch re-counts both, `KNOWN-OPEN` deleted. | 5 |
| `src/services/class-room-race.test.ts` | **Create.** The two door interleavings, with negative controls. | 5 |
| `src/services/room-archive-lock-order.test.ts` | **Modify.** The two new cascade edges. | 6 |
| `vitest.config.ts` | **Modify.** `class-room-race.test.ts` into `LOCK_CONTENTION_TESTS`. | 5 |
| `docs/lock-order.md` | **Modify.** A `#339` section under the `#272` one. | 6 |

---

## Task 1: The constraint

**Files:**
- Create: `prisma/migrations/20260905120000_class_room_archive_invariant/migration.sql`
- Modify: `prisma/schema.prisma` (models `CalendarEntry`, `Class`)
- Test: `src/services/class-room-constraint.test.ts`

**Interfaces:**
- Consumes: `TeacherRoom_id_isArchived_key` and `isCheckViolationOn` (`@/lib/check-violation`), both from issue 272.
- Produces: the constraint name `Class_live_needs_open_room`; the FK names `Class_teacherRoomId_roomArchived_fkey` and `Class_calendarEntryId_kind_entryLive_fkey`; the columns `Class.entryLive`, `Class.roomArchived`, `CalendarEntry.live`. Tasks 2-6 all refer to these by name.

- [ ] **Step 1: Write the failing constraint test**

Create `src/services/class-room-constraint.test.ts`. It drives the database directly, not the service — the point is what Postgres refuses, not what a function returns. Model it on `template-room-constraint.test.ts`, which imports the **production** matchers rather than hand-rolling them (a test asserting a weaker predicate than production can pass while production fails).

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type ClassStatus } from '@prisma/client';
import { isCheckViolationOn } from '@/lib/check-violation';
import { isRestrictViolationOn } from '@/lib/api-errors';
import { BLOCKING_CLASS_STATUSES } from './room-archive';

const prisma = new PrismaClient();
const suffix = `croom-${Date.now()}`;
const CHECK = 'Class_live_needs_open_room';
const ROOM_FK = 'Class_teacherRoomId_roomArchived_fkey';
const ENTRY_FK = 'Class_calendarEntryId_kind_entryLive_fkey';

let teacherId: string;
let openRoomId: string;
let shelvedRoomId: string;
const accountIds: string[] = [];

// Every row this file creates is tagged with `suffix`, so the file owns
// everything it touches and `afterAll` can delete by that tag. `makeRoom`
// follows `template-room-constraint.test.ts`'s helper of the same name.

/** Creates an entry and its class in one go, returning the class id. */
async function makeClass(teacherRoomId: string, status: ClassStatus): Promise<string> {
  const room = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: teacherRoomId } });
  const entry = await prisma.calendarEntry.create({
    data: {
      teacherId,
      kind: 'regular',
      classType: `c-${suffix}`,
      date: new Date('2027-01-04T00:00:00Z'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
    },
  });
  const cls = await prisma.class.create({
    data: {
      calendarEntryId: entry.id,
      kind: 'regular',
      teacherRoomId,
      // COPIED, not defaulted — the mirror is one column of a foreign key, so
      // a fixture that assumed `false` could not build a class in an archived
      // room at all, and half this file's cases need one.
      roomArchived: room.isArchived,
      roomCost: 0, minRate: 0, targetRate: 0, minStudents: 1, maxStudents: 10,
      status,
    },
  });
  return cls.id;
}

const entryIdOf = async (classId: string): Promise<string> =>
  (await prisma.class.findUniqueOrThrow({ where: { id: classId } })).calendarEntryId;

describe('Class_live_needs_open_room', () => {
  it('refuses an open class in an archived room', async () => {
    await expect(makeClass(shelvedRoomId, 'open')).rejects.toSatisfy(
      (e: unknown) => isCheckViolationOn(e, CHECK),
    );
  });

  it('permits a draft in an archived room', async () => {
    const id = await makeClass(shelvedRoomId, 'draft');
    expect(id).toBeTruthy();
  });

  it('permits a cancelled open class in an archived room', async () => {
    // Liveness is status AND the entry's cancelledAt — this is the case a
    // status-only predicate would get wrong, and the one that keeps
    // "cancel the class, then archive the room" working.
    const id = await makeClass(openRoomId, 'open');
    await prisma.calendarEntry.update({
      where: { id: await entryIdOf(id) },
      data: { cancelledAt: new Date() },
    });
    await expect(
      prisma.teacherRoom.update({
        where: { id: openRoomId },
        data: { isArchived: true },
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses archiving a room that holds a live class', async () => {
    await makeClass(openRoomId, 'open');
    await expect(
      prisma.teacherRoom.update({
        where: { id: openRoomId },
        data: { isArchived: true },
      }),
    ).rejects.toSatisfy((e: unknown) => isCheckViolationOn(e, CHECK));
  });

  it('refuses a mirror that disagrees with its room', async () => {
    // The mirrors cannot drift because each is one column of a composite
    // foreign key. Claiming a value the parent does not hold is 23503.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Class" SET "roomArchived" = true WHERE "teacherRoomId" = $1`,
        openRoomId,
      ),
    ).rejects.toSatisfy((e: unknown) => isRestrictViolationOn(e, [ROOM_FK]));
  });

  it('refuses a mirror that disagrees with its entry', async () => {
    const id = await makeClass(openRoomId, 'draft');
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Class" SET "entryLive" = false WHERE "id" = $1`,
        id,
      ),
    ).rejects.toSatisfy((e: unknown) => isRestrictViolationOn(e, [ENTRY_FK]));
  });
});

describe('the CHECK and BLOCKING_CLASS_STATUSES agree', () => {
  // The SQL spells two literals the TypeScript constant also spells. A
  // database constraint cannot import a constant, so a TEST is the tether:
  // iterate the ENUM, not a hand-written list, so a new ClassStatus member
  // fails here until someone decides its side.
  const ALL: ClassStatus[] = ['draft', 'open', 'in_progress', 'completed'];

  it.each(ALL)('status %s blocks iff it is in BLOCKING_CLASS_STATUSES', async (status) => {
    const blocks = BLOCKING_CLASS_STATUSES.includes(status);
    const attempt = makeClass(shelvedRoomId, status);
    if (blocks) {
      await expect(attempt).rejects.toSatisfy((e: unknown) => isCheckViolationOn(e, CHECK));
    } else {
      await expect(attempt).resolves.toBeTruthy();
    }
  });
});
```

`ALL` is hand-written and that is the weakness this step accepts: Prisma does not emit a runtime array of enum members. Pin it so a shrink or a growth is caught at compile time by adding, beside it:

```ts
// Compile-time tether: a new ClassStatus member makes this assignment fail,
// which is the signal to add it to ALL above and decide its side.
const _exhaustive: Record<ClassStatus, true> = {
  draft: true, open: true, in_progress: true, completed: true,
};
void _exhaustive;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run --project unit src/services/class-room-constraint.test.ts
```

Expected: FAIL. The constraint does not exist, so the "refuses" cases resolve instead of rejecting.

- [ ] **Step 3: Hand-author the migration**

Create the directory and `migration.sql`. Hand-authored because Prisma cannot express a CHECK, following `prisma/migrations/20260721061528_student_claim_link_check/`. Write it in exactly this order — step 2 must precede step 3, for the reason its own comment gives.

```sql
-- Invariant, DB-enforced: a live Class may not sit in an archived
-- TeacherRoom. Held until now by two application doors, both
-- non-transactional reads (issue 339).
--
-- The predicate spans three tables, so it is collapsed onto one row by
-- mirroring each parent's state through a composite foreign key. The mirrors
-- cannot drift: each is one column of a key whose other columns are the
-- parent's, so a disagreeing row is refused rather than stored, and
-- ON UPDATE CASCADE rewrites the children when a parent changes.
--
-- Liveness reaches one table further than issue 272's did. Cancellation left
-- Class in #327, so it is the ENTRY's cancelledAt that decides whether a
-- class is still a commitment the room has to honour.

-- Entry liveness, per row, so a foreign key can reference it.
ALTER TABLE "CalendarEntry"
  ADD COLUMN "live" BOOLEAN GENERATED ALWAYS AS ("cancelledAt" IS NULL) STORED;
-- NOT NULL is required, not tidy: a generated column is nullable by default
-- and Prisma's Boolean is required, so without this the drift check in CI
-- fails.
ALTER TABLE "CalendarEntry" ALTER COLUMN "live" SET NOT NULL;
ALTER TABLE "CalendarEntry"
  ADD CONSTRAINT "CalendarEntry_id_kind_live_key" UNIQUE ("id", "kind", "live");

-- REMEDIATION, and it must precede the backfill below.
-- `ADD CONSTRAINT ... CHECK` validates every existing row, and the backfill
-- mirrors each parent faithfully — so a database that already holds a live
-- class in an archived room mirrors that state into a violating row and the
-- constraint at the foot of this file refuses it, aborting the migration.
-- That state is not hypothetical: it is the premise of issue 339, and the
-- doors this constraint replaces were measured letting it through.
--
-- UN-ARCHIVING THE ROOM, where issue 272's sibling migration paused the
-- template. The mirror image here would be cancelling the class, and that is
-- refused: cancelling a Class is terminal, may carry registered students, and
-- everywhere else in the app notifies them. Un-archiving is also already the
-- documented recovery for exactly this state, so this repairs it the way the
-- application tells a teacher to. The teacher re-archives afterwards, and the
-- constraint then either allows it or names what to clear.
--
-- The cascade this fires — ClassTemplate.roomArchived := false, through issue
-- 272's foreign key — can only satisfy ClassTemplate_live_needs_open_room
-- further and can never violate it.
UPDATE "TeacherRoom" tr SET "isArchived" = false
 WHERE tr."isArchived"
   AND EXISTS (SELECT 1 FROM "Class" c
                 JOIN "CalendarEntry" ce ON ce."id" = c."calendarEntryId"
                WHERE c."teacherRoomId" = tr."id"
                  AND c."status" IN ('open','in_progress')
                  AND ce."cancelledAt" IS NULL);

-- The mirrors, backfilled from the parents they mirror.
ALTER TABLE "Class" ADD COLUMN "entryLive"    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Class" ADD COLUMN "roomArchived" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Class" c SET "entryLive"    = ce."live"
  FROM "CalendarEntry" ce WHERE ce."id" = c."calendarEntryId";
UPDATE "Class" c SET "roomArchived" = tr."isArchived"
  FROM "TeacherRoom"  tr WHERE tr."id" = c."teacherRoomId";

-- The two existing foreign keys, widened to carry the mirrored column.
-- Referential actions are preserved exactly; delete behaviour is unchanged.
ALTER TABLE "Class" DROP CONSTRAINT "Class_calendarEntryId_kind_fkey";
ALTER TABLE "Class" ADD  CONSTRAINT "Class_calendarEntryId_kind_entryLive_fkey"
  FOREIGN KEY ("calendarEntryId", "kind", "entryLive")
  REFERENCES "CalendarEntry"("id", "kind", "live")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Class" DROP CONSTRAINT "Class_teacherRoomId_fkey";
ALTER TABLE "Class" ADD  CONSTRAINT "Class_teacherRoomId_roomArchived_fkey"
  FOREIGN KEY ("teacherRoomId", "roomArchived")
  REFERENCES "TeacherRoom"("id", "isArchived")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The invariant. The two statuses are also spelled in BLOCKING_CLASS_STATUSES
-- (`src/services/room-archive.ts`); a constraint cannot import a constant, so
-- what keeps them together is a test that iterates the enum
-- (`class-room-constraint.test.ts`), not this comment.
ALTER TABLE "Class" ADD CONSTRAINT "Class_live_needs_open_room"
  CHECK (NOT ("status" IN ('open','in_progress') AND "entryLive" AND "roomArchived"));
```

- [ ] **Step 4: Update `prisma/schema.prisma` to match**

Three edits, then the drift check decides whether they are right.

On `CalendarEntry`, after `cancelledAt`:

```prisma
  /// GENERATED, by Postgres, as `cancelledAt IS NULL`. It exists so a foreign
  /// key can reference liveness — a key needs a real column, and `Class`
  /// mirrors this one through
  /// `Class_calendarEntryId_kind_entryLive_fkey` so that
  /// `Class_live_needs_open_room` can ask about a cancellation without
  /// leaving the row it is checking (issue 339).
  ///
  /// `StudioClass` does NOT mirror it. That family has no room and no
  /// invariant of this shape, so its own foreign key still references
  /// `CalendarEntry(id, kind)` unchanged.
  ///
  /// What Prisma cannot show here: the column is
  /// `GENERATED ALWAYS AS (...) STORED`, so nothing may write it. It is
  /// mapped as a plain required Boolean, which is why
  /// `20260905120000_class_room_archive_invariant` sets NOT NULL explicitly —
  /// without it the generated column stays nullable and CI's drift check
  /// fails.
  live Boolean
```

and `@@unique([id, kind, live])` beside the existing `@@unique([id, kind])`.

On `Class`, replacing nothing and sitting immediately above the two new columns, the docblock from spec §5:

```prisma
  /// MIRRORS. Neither column is state this row owns, and neither may disagree
  /// with the parent it mirrors. `entryLive` mirrors `CalendarEntry.live`
  /// (`cancelledAt IS NULL`, generated); `roomArchived` mirrors
  /// `TeacherRoom.isArchived`.
  ///
  /// Neither can drift, and that is enforced rather than intended: each is one
  /// column of a composite foreign key whose remaining columns are the
  /// parent's key, so a row claiming a value its parent does not hold is
  /// refused with `23503` instead of stored, and `ON UPDATE CASCADE` rewrites
  /// every mirroring child in the same statement that changes the parent.
  ///
  /// They are not written the same way. `entryLive` is maintained by Postgres
  /// alone: a class is created with a fresh, uncancelled entry, so the
  /// column's default is the only value it can start with, and nothing writes
  /// it afterwards. `roomArchived` is written by the two create paths, which
  /// COPY the room's value — copy rather than assert, unlike
  /// `ClassTemplate.roomArchived`, because a `draft` may legally sit in an
  /// archived room. Neither is written by an update: no path moves a class
  /// between rooms (`updateClassSchema` carries no `teacherRoomId`), and
  /// cancellation writes the entry.
  ///
  /// They exist so a predicate spanning three tables can be checked against
  /// one row. That check is `Class_live_needs_open_room`, hand-authored in the
  /// migration because Prisma cannot express it — the constraint that makes "a
  /// live class may not sit in an archived room" unrepresentable rather than
  /// merely guarded (issue 339).
  entryLive    Boolean @default(true)
  roomArchived Boolean @default(false)
```

and both relations widened:

```prisma
  calendarEntry CalendarEntry @relation(fields: [calendarEntryId, kind, entryLive], references: [id, kind, live], onDelete: Cascade)
  teacherRoom   TeacherRoom   @relation(fields: [teacherRoomId, roomArchived], references: [id, isArchived])
```

- [ ] **Step 5: Apply and verify no drift**

```bash
npx prisma migrate deploy
npx prisma generate
npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-schema-datasource prisma/schema.prisma \
  --exit-code
```

Expected: exit `0`. A non-zero exit means the schema and the SQL disagree — fix the schema, never the applied migration.

- [ ] **Step 6: Prove the drift check bites**

A check that cannot fail certifies nothing. Temporarily delete the `ALTER COLUMN "live" SET NOT NULL` line **from a scratch copy of the database, not from the applied migration** — reset a scratch DB, apply the edited SQL there, and re-run the diff:

```bash
createdb -h localhost -U postgres ethical_yoga_drift_probe   # or the container equivalent
# apply the migration history to it with the NOT NULL line removed, then:
npx prisma migrate diff \
  --from-schema-datamodel prisma/schema.prisma \
  --to-url "postgresql://…/ethical_yoga_drift_probe" \
  --exit-code
```

Expected: exit `2`, with the drift naming `live` as nullable. **Record the exact output in the PR body**, then drop the probe database. The applied migration is never edited.

- [ ] **Step 7: Run the constraint test to verify it passes**

```bash
npx vitest run --project unit src/services/class-room-constraint.test.ts
```

Expected: PASS, every case.

- [ ] **Step 8: Prove the CHECK bites**

Drop it, re-run, restore, re-run. Against `ethical_yoga_test`, never dev:

```bash
psql "$DATABASE_URL_TEST" -c 'ALTER TABLE "Class" DROP CONSTRAINT "Class_live_needs_open_room";'
npx vitest run --project unit src/services/class-room-constraint.test.ts   # expect FAIL
psql "$DATABASE_URL_TEST" -c 'ALTER TABLE "Class" ADD CONSTRAINT "Class_live_needs_open_room" CHECK (NOT ("status" IN (''open'',''in_progress'') AND "entryLive" AND "roomArchived"));'
npx vitest run --project unit src/services/class-room-constraint.test.ts   # expect PASS
```

Record the exact failure text. Do the same for each widened foreign key, narrowing it to its old column list and confirming the two "refuses a mirror that disagrees" cases redden.

- [ ] **Step 9: Prove the remediation actually remediates**

The remediation is a branch nothing else in this plan exercises: every test database is built by `migrate deploy` on an empty schema, so the `UPDATE` matches zero rows and passes vacuously. Build a scratch database that carries the violating state and apply the migration to it:

```bash
PROBE="postgresql://postgres:postgres@localhost:5432/ethical_yoga_remediation_probe"

# 1. Scratch DB carrying the history UP TO BUT NOT INCLUDING this migration.
psql "$DATABASE_URL_TEST" -c 'CREATE DATABASE ethical_yoga_remediation_probe;'
mkdir /tmp/hist && cp -r prisma/migrations/* /tmp/hist/ \
  && rm -rf /tmp/hist/20260905120000_class_room_archive_invariant
DATABASE_URL="$PROBE" npx prisma migrate deploy --schema prisma/schema.prisma
#   (point the migrations dir at /tmp/hist for this run)

# 2. Plant the violating state the doors were measured producing.
psql "$PROBE" <<'SQL'
  UPDATE "TeacherRoom" SET "isArchived" = true WHERE "id" = '<the probe room>';
  -- the room now holds a Class with status 'open' whose entry has
  -- cancelledAt IS NULL: exactly what door 1's race leaves behind.
SQL
psql "$PROBE" -c 'SELECT "id","isArchived" FROM "TeacherRoom" WHERE "id" = ''<the probe room>'';'
psql "$PROBE" -c 'SELECT "id","status" FROM "Class" WHERE "teacherRoomId" = ''<the probe room>'';'

# 3. Apply this migration alone.
psql "$PROBE" -f prisma/migrations/20260905120000_class_room_archive_invariant/migration.sql

# 4. Re-run both SELECTs above.
```

Expected: the migration exits `0`; the room's `isArchived` is now `false`; the class is untouched — same id, same `status`, its entry's `cancelledAt` still `NULL`. Drop the probe database afterwards.

Record the before/after row states in the PR body. **This is the acceptance criterion the migration would otherwise pass without ever running its own remediation branch** — every other database in this plan is built by `migrate deploy` on an empty schema, where the `UPDATE` matches zero rows and succeeds vacuously.

- [ ] **Step 10: Commit**

```bash
git add prisma/migrations/20260905120000_class_room_archive_invariant/migration.sql \
        prisma/schema.prisma \
        src/services/class-room-constraint.test.ts
git commit -m "feat(db): a live class may not sit in an archived room (#339)"
```

---

## Task 2: The foreign-key rename that room deletion matches by name

**Files:**
- Modify: `src/services/room-deletion.ts:43-46`
- Test: `src/services/room-deletion.test.ts`

**Interfaces:**
- Consumes: `Class_teacherRoomId_roomArchived_fkey` (Task 1).
- Produces: nothing new; `isRoomDeleteBlocked` keeps its signature.

**Why this is second.** Task 1 renamed a constraint that `ROOM_DELETE_RESTRICT_FKS` matches by literal string. Until this task lands, `isRoomDeleteBlocked` no longer recognises a class blocker and `DELETE /api/rooms/[id]` returns a 500 where it returned a clean 409 naming the remedy.

- [ ] **Step 1: Write the failing test**

The existing suite does not catch this. `isRoomDeleteBlocked`'s own docblock records the measurement: replacing the list with `[]` at both call sites left every case in both integration suites green, because both routes stop at their pre-check and never reach the catch. So the new case must provoke a **real** database refusal.

Add to `src/services/room-deletion.test.ts`:

```ts
it('classifies a class-blocked delete that reaches the database', async () => {
  // NOT via the route: both routes pre-check and never reach the catch, which
  // is why this wiring went unpinned. Delete the room directly so Postgres
  // raises the RESTRICT itself, then assert the production classifier
  // recognises it.
  const err = await prisma.teacherRoom
    .delete({ where: { id: roomWithACompletedClassId } })
    .then(() => null)
    .catch((e: unknown) => e);

  expect(err).not.toBeNull();
  expect(isRoomDeleteBlocked(err)).toBe(true);
});
```

Use a **completed** class for the fixture, deliberately: the room-delete door counts every class because a foreign key does, unlike the archive door which counts only `BLOCKING_CLASS_STATUSES`. A completed class is a blocker here and not there, so this case cannot pass for the archive door's reasons.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project unit src/services/room-deletion.test.ts
```

Expected: FAIL — `isRoomDeleteBlocked(err)` is `false`, because the list still names `Class_teacherRoomId_fkey` and Postgres reported `Class_teacherRoomId_roomArchived_fkey`.

- [ ] **Step 3: Update the list**

In `src/services/room-deletion.ts`:

```ts
export const ROOM_DELETE_RESTRICT_FKS = [
  'ClassTemplate_teacherRoomId_roomArchived_fkey',
  'Class_teacherRoomId_roomArchived_fkey',
] as const;
```

- [ ] **Step 4: Run it to verify it passes**

```bash
npx vitest run --project unit src/services/room-deletion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prove the new test bites**

Revert the list entry to `'Class_teacherRoomId_fkey'`, re-run, confirm the new case reddens and record the exact message, then restore and re-run. Without this the test could be passing for an unrelated reason.

- [ ] **Step 6: Commit**

```bash
git add src/services/room-deletion.ts src/services/room-deletion.test.ts
git commit -m "fix(rooms): the class blocker's FK was renamed, and nothing pinned it (#339)"
```

---

## Task 3: The create paths copy the room's state

**Files:**
- Modify: `src/app/api/classes/route.ts:101-140`
- Modify: `src/services/class-generator.ts:48-62`
- Test: `src/services/class-room-constraint.test.ts` (extend), `tests/integration/classes-api.test.ts`

**Interfaces:**
- Consumes: `Class.roomArchived` (Task 1).
- Produces: no new exports.

**The asymmetry this task exists for.** Issue 272's create path *asserts* `roomArchived: false` and maps the resulting `23503` to a 409. That is right for a template and wrong for a class: a **draft** may legally sit in an archived room, so asserting would refuse a legal write. Both class create paths must **copy**.

- [ ] **Step 1: Write the failing test for the route**

In `tests/integration/classes-api.test.ts`:

```ts
it('creates a draft in an archived room', async () => {
  // A draft is a parked intention with no registrations — door 1 lets a
  // draft-only room be archived, and door 2 is where the room starts to
  // matter. Creating one here must succeed.
  const res = await fetch(`${BASE}/api/classes`, {
    method: 'POST',
    headers: authHeaders(freshIp()),
    body: JSON.stringify({ ...validBody, teacherRoomId: archivedRoomId }),
  });
  expect(res.status).toBe(201);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run --project integration tests/integration/classes-api.test.ts
```

Expected: FAIL with a 500 — the insert defaults `roomArchived` to `false`, which disagrees with the archived room, and the foreign key refuses it with `23503`.

*(This tier needs the app on `:3000` and the dev database. From a worktree, write the test, confirm the equivalent failure at the service level in `class-room-constraint.test.ts`, and let CI be the signal for this tier.)*

- [ ] **Step 3: Copy the room's value in the route**

Replace the read-then-insert with a re-read inside the transaction. The ownership check at `:79` stays where it is — it decides a 400 and needs no lock.

```ts
  const outcome = await prisma.$transaction(async (tx) => {
    // The room's CURRENT `isArchived`, read inside the transaction and held.
    // `Class.roomArchived` is one column of a composite foreign key, so a
    // value that disagrees with the room is refused with `23503` rather than
    // stored — and the ownership read above is outside this transaction, so
    // its value can be stale by now. A draft in an archived room is LEGAL
    // (that is the asymmetry with `ClassTemplate`, which asserts `false`
    // instead), so the value has to be accurate rather than assumed.
    //
    // `FOR KEY SHARE` is the weakest lock that conflicts with the archive:
    // `isArchived` became part of an FK-referenced unique key in issue 272,
    // so flipping it is a KEY update and takes `FOR UPDATE`. It does not
    // conflict with the `KEY SHARE` the insert below takes on the same row,
    // nor with the generator's.
    const [room] = await tx.$queryRaw<{ isArchived: boolean }[]>`
      SELECT "isArchived" FROM "TeacherRoom"
       WHERE "id" = ${body.teacherRoomId}
       FOR KEY SHARE`;
    if (!room) return { ok: false as const };

    const [entry] = await tx.calendarEntry.createManyAndReturn({ /* unchanged */ });
    if (!entry) return { ok: false as const };

    const cls = await tx.class.create({
      data: {
        // …unchanged fields…
        roomArchived: room.isArchived,
        status: 'draft',
      },
    });
    return { ok: true as const, entry, cls };
  });
```

- [ ] **Step 4: Copy the template's mirror in the generator**

In `class-generator.ts`'s `createChildren`:

```ts
        teacherRoomId: template.teacherRoomId,
        // The template's own mirror, not a fresh read. Accurate by the lock
        // this path already holds: `claimTemplateForGeneration` keeps this
        // row `FOR UPDATE` across this insert, and archiving the room
        // cascades into it — so the archive cannot commit in between.
        roomArchived: template.roomArchived,
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run --project unit src/services/class-room-constraint.test.ts src/services/class-generator.test.ts
npx vitest run --project integration tests/integration/classes-api.test.ts   # where a live app exists
```

Expected: PASS.

- [ ] **Step 6: Prove both copies bite**

Two mutations, each restored and re-verified, each error text recorded:

1. Change the route's `roomArchived: room.isArchived` to `roomArchived: false`. The draft-in-an-archived-room case must fail with `23503` naming `Class_teacherRoomId_roomArchived_fkey`. This is the exact bug that copying issue 272 would produce.
2. Change the generator's `roomArchived: template.roomArchived` to `false`. Add a case that archives a room holding a **paused** template (legal: `ruleLive` false), then runs the generator, and confirm it is unaffected — then confirm the mutation is caught by a case that generates into a live template whose room flips mid-sweep.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/classes/route.ts src/services/class-generator.ts \
        src/services/class-room-constraint.test.ts tests/integration/classes-api.test.ts
git commit -m "fix(classes): the create paths copy the room's state, they do not assert it (#339)"
```

---

## Task 4: Door 2 — the publish race

**Files:**
- Modify: `src/services/class-lifecycle.ts:497-544`
- Test: `src/services/class-transitions.test.ts` or a case in `class-room-race.test.ts` (Task 5 creates that file; if this task runs first, put the unit-level case beside the existing transition tests)

**Interfaces:**
- Consumes: `Class_live_needs_open_room`, `isCheckViolationOn`.
- Produces: no new refusal reason — `ROOM_ARCHIVED` already exists in `transitionClass`'s result union.

- [ ] **Step 1: Write the failing test**

```ts
it('refuses a publish when the room archives after the pre-check', async () => {
  // The pre-check reads `teacherRoom.isArchived` outside the transaction
  // (`class-lifecycle.ts`), and the CAS carries no predicate on the room. The
  // constraint is what closes that window; this asserts the refusal is the
  // same sentence the pre-check would have produced, not a 500.
  const classId = await makeDraft(openRoomId);
  await prisma.teacherRoom.update({
    where: { id: openRoomId },
    data: { isArchived: true },
  });

  const result = await transitionClass(prisma, classId, 'open');
  expect(result).toMatchObject({ ok: false, reason: 'ROOM_ARCHIVED' });
});
```

This case passes today via the pre-check, so it is not yet the race. It exists to pin that the *catch* produces an identical answer; the true interleaving lands in Task 5, where the archive commits between the pre-check and the CAS.

- [ ] **Step 2: Run it to verify it fails once the pre-check is bypassed**

Temporarily comment out the pre-check block at `class-lifecycle.ts:428-445` and run:

```bash
npx vitest run --project unit src/services/class-transitions.test.ts -t 'room archives after the pre-check'
```

Expected: FAIL — an unhandled `23514` escapes as a throw rather than a `ROOM_ARCHIVED` result. Restore the pre-check afterwards.

- [ ] **Step 3: Catch the constraint around the CAS**

Wrap `transitionClass`'s `$transaction` (`:497`):

```ts
  let moved: boolean;
  try {
    moved = await db.$transaction(async (tx) => { /* unchanged body */ });
  } catch (e) {
    // The pre-check above read the room outside this transaction, so a room
    // archived in between is invisible to it — this is that window closing
    // (issue 339). The constraint refuses the write, and the answer is the
    // same sentence the pre-check produces, because a teacher who lost this
    // race and a teacher who never had it need the same thing done.
    if (isCheckViolationOn(e, 'Class_live_needs_open_room')) {
      log.info(
        { classId, targetStatus },
        'class publish refused by the constraint: the room archived mid-request',
      );
      return {
        ok: false,
        reason: 'ROOM_ARCHIVED',
        error: 'This room is archived. Unarchive it to publish classes here.',
      };
    }
    throw e;
  }
```

The two error strings must be identical. Extract the literal to a module-level constant used by both the pre-check and this catch, so they cannot drift.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run --project unit src/services/class-transitions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Prove the catch bites**

Narrow the catch to a constraint name that never fires (`'Class_live_needs_open_room_typo'`), re-run with the pre-check commented out, confirm the throw escapes, record the text, restore both.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-transitions.test.ts
git commit -m "fix(classes): publish loses no race to an archiving room (#339)"
```

---

## Task 5: Door 1 — the archive race, and the note that goes

**Files:**
- Modify: `src/services/room-archive.ts`
- Modify: `vitest.config.ts` (`LOCK_CONTENTION_TESTS`)
- Test: `src/services/class-room-race.test.ts` (create), `src/services/room-archive.test.ts`, `src/services/room-archive-doors.test.ts`

**Interfaces:**
- Consumes: `Class_live_needs_open_room`, `isCheckViolationOn`, `RoomBlockers`.
- Produces: no signature change — `ArchiveRoomResult` is unchanged; what changes is that its `blockers.classes` can now be non-zero on the constraint path.

- [ ] **Step 1: Write the failing race test**

Create `src/services/class-room-race.test.ts`. It stages the real interleaving: hold a transaction open that publishes a class, run the archive concurrently, release. Model the mechanics on `template-room-race.test.ts`.

```ts
it('refuses an archive when a class is published mid-request', async () => {
  // The counts in `setTeacherRoomArchived` are read before its write, so a
  // class published in another tab between them is invisible to them. This is
  // the KNOWN-OPEN this issue closes: without the constraint the archive
  // succeeds and leaves an archived room holding an `open` class.
  const classId = await makeDraft(openRoomId);

  const publishing = holdOpen(async (tx) => {
    await tx.class.updateMany({ where: { id: classId }, data: { status: 'open' } });
  });
  await publishing.reachedTheWrite;

  const archive = setTeacherRoomArchived(prisma, openRoomId, teacherId, 'archived');
  await publishing.release();

  const result = await archive;
  expect(result).toMatchObject({ ok: false, reason: 'in_use' });
  expect(result).toMatchObject({ blockers: { classes: 1 } });

  const room = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: openRoomId } });
  expect(room.isArchived).toBe(false);
});
```

The last assertion is the one that matters: the archive must have rolled back, not merely reported.

- [ ] **Step 1b: Write door 2's interleaving in the same file**

Task 4's unit case passes through the pre-check, so it is not the race. This is:

```ts
it('refuses a publish when the room archives mid-transition', async () => {
  // The mirror image of the case above: there the class moved under the
  // archive, here the room moves under the publish. `transitionClass` reads
  // `teacherRoom.isArchived` outside its transaction, so an archive
  // committing after that read and before the CAS is invisible to it.
  const classId = await makeDraft(openRoomId);

  const archiving = holdOpen(async (tx) => {
    await tx.teacherRoom.update({
      where: { id: openRoomId },
      data: { isArchived: true },
    });
  });
  await archiving.reachedTheWrite;

  const publish = transitionClass(prisma, classId, 'open');
  await archiving.release();

  expect(await publish).toMatchObject({ ok: false, reason: 'ROOM_ARCHIVED' });

  const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
  expect(cls.status).toBe('draft');
});
```

The status assertion is the one that matters — the class must not have been published, not merely have been reported as refused.

- [ ] **Step 2: Add the file to the serial tier**

In `vitest.config.ts`, add `'src/services/class-room-race.test.ts'` to `LOCK_CONTENTION_TESTS` with a one-line comment saying which kind it is — it holds a real row lock for the length of a staged race, the same shape as `room-archive-lock-order.test.ts`. A file that holds locks in the parallel tier is what that list exists to prevent.

- [ ] **Step 3: Run it to verify it fails**

```bash
npx vitest run --project unit-sweeps src/services/class-room-race.test.ts
```

Expected: FAIL — `blockers.classes` is `0` (the catch hardcodes it) even once the constraint fires.

- [ ] **Step 4: Re-shape the counts and the catch**

In `room-archive.ts`, lift the class count into a closure beside `countLiveTemplates`, under the same discipline its comment already states:

```ts
  // ONE EXPRESSION, TWO READERS, and now on both halves. The pre-write counts
  // and the post-rollback re-counts in the catch must ask the same questions:
  // the catch's `blockers` is only "the answer the counts would have given a
  // moment later" if it asks what they asked.
  const countLiveTemplates = (): Promise<number> =>
    db.classTemplate.count({ where: { teacherRoomId, ...ACTIVE_TEMPLATE_WHERE } });

  const countBlockingClasses = (): Promise<number> =>
    db.class.count({
      where: {
        teacherRoomId,
        status: { in: [...BLOCKING_CLASS_STATUSES] },
        calendarEntry: { cancelledAt: null },
      },
    });
```

and widen the catch to either constraint, re-counting both:

```ts
    if (
      isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room') ||
      isCheckViolationOn(e, 'Class_live_needs_open_room')
    ) {
      log.warn(
        { err: e, teacherRoomId, teacherId },
        'room archive refused by a constraint: the room went back into use mid-request',
      );
      // BOTH, whichever fired. `blockers` is not a record of what tripped; it
      // is the input to `describeRoomBlockers`, whose job is to name what the
      // teacher must clear. Counting only the constraint that fired reports a
      // room as blocked by one thing when it is blocked by two.
      const [classes, templates] = await Promise.all([
        countBlockingClasses(),
        countLiveTemplates(),
      ]);
      return { ok: false, reason: 'in_use', blockers: { classes, templates } };
    }
```

- [ ] **Step 5: Delete the `KNOWN-OPEN` note**

Remove the whole block at `room-archive.ts:178-199`. **Deleted, not narrowed** — the state it describes stops being reachable, and a note saying "this used to be racy" is the correction-history this repo keeps out of comments. What it used to say goes in the PR body.

What replaces it is short, and only what is true now: the transaction's lock-ordering comment stays (it is about the pre-lock, not the race), and one sentence records that both halves of the archive refusal are now constraint-enforced.

- [ ] **Step 6: Run to verify it passes**

```bash
npx vitest run --project unit-sweeps src/services/class-room-race.test.ts
npx vitest run --project unit src/services/room-archive.test.ts src/services/room-archive-doors.test.ts
```

Expected: PASS.

- [ ] **Step 7: Prove both race tests bite — the negative control**

Drop `Class_live_needs_open_room` on `ethical_yoga_test`, re-run `class-room-race.test.ts`, and confirm both cases fail **by reproducing their original bugs** rather than merely going red:

- the archive case: the archive *succeeds* and the room ends up `isArchived = true` while holding an `open` class;
- the publish case: the publish *succeeds* and the class ends up `open` in a room that is `isArchived = true`.

That is a stronger control than "the test goes red" — it proves each test watches its defect rather than the mechanism. A test that reddens with a `23503` from some other column would pass a weaker control while pinning nothing. Record the exact output of both, restore the constraint, re-run.

- [ ] **Step 8: Commit**

```bash
git add src/services/room-archive.ts src/services/class-room-race.test.ts vitest.config.ts
git commit -m "fix(rooms): the archive's class half is a constraint, not a count (#339)"
```

---

## Task 6: The wait edges, written down and measured

**Files:**
- Modify: `src/services/room-archive-lock-order.test.ts`
- Modify: `docs/lock-order.md` (a `#339` section after the `#272` one)
- Possibly create: `prisma/migrations/20260905130000_index_class_room_fk/migration.sql`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: documentation, and possibly one index.

- [ ] **Step 1: Pin the `CalendarEntry → Class` edge**

The `ON UPDATE CASCADE` into `Class.entryLive` makes a cancel take a `Class` row lock while holding the entry — the reverse of this repo's fixed order. What makes it safe is that every regular-entry `cancelledAt` writer takes the `Class` lock **first**, so the cascade re-locks a row its own transaction already owns.

```ts
it('a cancel that takes the class lock first does not deadlock its own cascade', async () => {
  const classId = await makeOpenClass();
  const entryId = await entryIdOf(classId);

  // The shape every production writer uses: lockClassRow, then write the
  // entry. The cascade back into Class.entryLive re-locks a row this
  // transaction already holds, so it waits on nothing.
  const cancelling = prisma.$transaction(async (tx) => {
    await lockClassRow(tx, classId);
    await tx.calendarEntry.update({
      where: { id: entryId },
      data: { cancelledAt: new Date() },
    });
  });

  // Concurrently, a writer that wants the same class row.
  const competing = prisma.$transaction(async (tx) => {
    await lockClassRow(tx, classId);
    await tx.class.update({ where: { id: classId }, data: { description: 'x' } });
  });

  const results = await Promise.allSettled([cancelling, competing]);
  const errs = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []));
  // Neither a deadlock nor a lock timeout: one waits for the other.
  expect(errs.join('\n')).not.toMatch(/40P01|55P03/);
});

it('a cancel that writes the entry FIRST deadlocks against a class-lock holder', async () => {
  // THE MUTATION, as a test rather than a manual step: this is what a fifth
  // `cancelledAt` writer added without `lockClassRow` would do, and it is the
  // regression the ordering rule exists to prevent. It documents the edge by
  // showing it biting.
  const classId = await makeOpenClass();
  const entryId = await entryIdOf(classId);

  const holder = holdOpen(async (tx) => { await lockClassRow(tx, classId); });
  await holder.reachedTheWrite;

  const backwards = prisma.$transaction(async (tx) => {
    await setLockTimeout(tx);
    await tx.calendarEntry.update({
      where: { id: entryId },
      data: { cancelledAt: new Date() },
    });
  });

  await expect(backwards).rejects.toThrow(/40P01|55P03/);
  await holder.release();
});
```

Record the exact error text of the second case. The first case is meaningless without it — on its own it would pass against a schema with no cascade at all.

- [ ] **Step 2: Pin the `TeacherRoom → Class` edge**

The archive's write now cascades into every `Class` row in the room as well as every `ClassTemplate`. The pre-lock on `ClassTemplate` is what keeps the archive and the generator waiting in the same direction.

A case for the template cascade already exists in this file. **Extend it rather than duplicating it** — same staging, an assertion that names both cascades — so there is one description of one mechanism:

```ts
it('the archive pre-lock orders BOTH cascades against a generation sweep', async () => {
  // The archive holds TeacherRoom while its ON UPDATE CASCADE rewrites two
  // child tables: ClassTemplate.roomArchived (#272) and Class.roomArchived
  // (#339). Both are backward edges against the generator, which holds a
  // ClassTemplate FOR UPDATE and then takes KEY SHARE on the room. Pre-locking
  // the room's templates makes this transaction start where the generator
  // starts, so every wait runs forward.
  //
  // The Class rows matter here even though this door takes no Class lock of
  // its own: the cascade takes them regardless, which is the whole point.
  const staged = await stageArchiveAgainstGeneration();
  expect(staged.errors.join('\n')).not.toMatch(/40P01/);
  expect(staged.roomIsArchived).toBe(false);   // refused by the constraint, not by a deadlock
});
```

The mutation: remove the `if (archiving)` pre-lock block from `room-archive.ts` and confirm this case reddens with `40P01`. Record the text, restore, re-verify.

- [ ] **Step 3: Measure the referencing-side index**

`Class` has no index on `teacherRoomId`. Two paths read the referencing side of `Class_teacherRoomId_roomArchived_fkey`: the archive's `ON UPDATE CASCADE`, and the room-delete `ON DELETE RESTRICT` check. (Issue 272 had a third — the archive's explicit `ClassTemplate` pre-lock — and this door has no counterpart, because it takes no `Class` lock.)

Measure before adding, the way issue 272's §7.3 asked:

```sql
EXPLAIN (ANALYZE, BUFFERS)
UPDATE "TeacherRoom" SET "isArchived" = true WHERE "id" = '<a room with children>';

EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM "TeacherRoom" WHERE "id" = '<a room with children>';
```

on a scratch database at 10k and 100k `Class` rows, median of 15 runs, with and without the index. **Add the index only if the numbers show the slope issue 272's did** — a sequential scan growing linearly while a lock is held. Record the table either way; a measured "no" is a result.

If it lands, it is its own migration, as `20260828120000_index_template_room_fk` was, and its comment carries the measurement's location rather than the numbers.

- [ ] **Step 4: Write the `docs/lock-order.md` section**

After "The room mirror's foreign keys are wait edges (#272)". It carries the writer table from spec §4.2 and the command that re-derives it — this is where a count legitimately lives, because it has an owner and ships with its re-derivation:

```
## The class mirrors' foreign keys are wait edges (#339)
```

State: the two edges; that all four regular-entry `cancelledAt` writers take the `Class` lock first, with the table; the re-derivation command and its arithmetic (`7 hits − 3 on Registration = 4`); that the flip is one-way for this family because `entry_terminal_liveness_guard` refuses it on a terminal regular entry; and that a status-only `UPDATE` on `Class` triggers no referential check, which is why `transitionClass` and `completeClass` take no room lock despite holding `Class`.

- [ ] **Step 5: Sweep for what this branch invalidated**

Not what it edited — what it *removed or renamed*. Give every hit a verdict; expect legitimate survivors (migrations and this plan among them):

```bash
grep -rn "Class_teacherRoomId_fkey\|Class_calendarEntryId_kind_fkey" \
  --include="*.ts" --include="*.md" --include="*.prisma" . | grep -v node_modules
grep -rn "KNOWN-OPEN" --include="*.ts" src/
```

Then the harder half, which no grep finds: the change alters what `room-archive.ts`'s header *describes*, not what anything is *called*. Read the whole docblock at `room-archive.ts:7-31` and the `BLOCKING_CLASS_STATUSES` docblock at `:33-45`, and correct any sentence that is no longer true — by replacing it, not annotating it.

- [ ] **Step 6: Full verification**

```bash
npm run typecheck && npm run lint
npx vitest run --project unit --project unit-sweeps --project components
```

From a worktree, that is the whole of what can run — `integration` and `e2e` need the app on `:3000` and the dev database, and hang on `ECONNREFUSED` without them. Push and read CI for those two tiers; cite the CI run in the PR body, not a local `verify`.

- [ ] **Step 7: Commit**

```bash
git add src/services/room-archive-lock-order.test.ts docs/lock-order.md
git commit -m "docs(lock-order): the class mirrors' two wait edges, measured (#339)"
```

---

## After the tasks

Per `solve-issue` §5, a plan with 2+ tasks gets **one whole-branch review on the most capable model, one fix wave, one scoped re-review** before the PR. Its purpose here is cross-task blindness, and this branch has a specific instance to hunt: Task 1 defines the mirrors' contract, Task 3 writes them, Task 5 reads them, and no task reviewer sees more than one of those.

The PR body records: the four premise corrections from spec §1; the arithmetic behind the `cancelledAt` writer count (`7 − 3 = 4`) and the count error it corrects; what `room-archive.ts`'s `KNOWN-OPEN` note used to say; every mutation's exact error text; the remediation's before/after row states; the index measurement whichever way it went; and — since this is a worktree — the CI run for the integration and e2e tiers rather than a local `verify`.
