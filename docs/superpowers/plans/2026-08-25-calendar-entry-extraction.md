# CalendarEntry Extraction (stage B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the entry-level calendar identity shared by `Class` and `StudioClass` into `CalendarEntry`, replacing the last four #296 triggers and two partial slot indexes with one range exclusion constraint, and collapsing the two spellings of liveness into one column.

**Architecture:** `CalendarEntry` owns `teacherId`, `kind`, `classType`, `date`, `startTime`, `durationMinutes`, `cancelledAt` and a generated `span` (`tsrange`). `Class` and `StudioClass` keep only their economics and hang off it by a composite foreign key `(calendarEntryId, kind)` → `CalendarEntry (id, kind)`, each pinning its own `kind` literal with a `CHECK` — the structure stage A shipped one layer up. Occupancy becomes `EXCLUDE USING gist (teacherId WITH =, span WITH &&) WHERE (cancelledAt IS NULL)`. Terminality reaches the entry through a trigger-maintained `classCompletedAt`, so the freeze guard is single-table.

**Tech Stack:** PostgreSQL 16 (`btree_gist`, generated columns, exclusion constraints), Prisma 6.19, Next.js 16 App Router, TypeScript strict, vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-calendar-entry-extraction-stage-b-design.md` (stage B), which defers to `docs/superpowers/specs/2026-08-24-calendar-entry-extraction-design.md` (parent) for everything it does not override. **Read stage B §6 first** — it names the one parent section that must not be read literally.

---

## Global Constraints

- **Wire format stays `"HH:MM"`.** The column becomes `time`; API surface, Zod schemas and every component keep the string. `src/lib/time-of-day.ts` (`timeToHHmm`, `hhmmToTime`) is the only conversion boundary. Parent spec §6.
- **Half-open ranges, `'[)'`.** A class ending 20:00 and one starting 20:00 are legal. Parent spec §4.2 row 2.
- **The generated column must be declared `Unsupported("tsrange")? @default(dbgenerated())`** in `schema.prisma`, or `prisma migrate dev` offers `DROP COLUMN "span"` and cascade-drops the exclusion constraint.
- **Never edit an applied migration**, comments included — it changes the checksum while `prisma migrate status` compares names. Prose about a migration goes in `docs/`.
- **Never start or restart the dev server on :3000.** The user runs it. After Task 2a's migration it serves a stale Prisma client and **must be restarted by the user** before any integration result means anything.
- **Stage exact paths.** Never `git add -A`. Quote paths containing `(public)`, `(teacher)`, `(student)`.
- **Never write "does not close #N".** GitHub's parser matches the keyword and ignores the negation. Write "#N is unaffected".
- **Ownership follows stage A's shipped pattern**, inline, no helper: `entry.teacherId !== session.teacherId` for the 403, `where: { calendarEntry: { teacherId: session.teacherId } }` for the scope. Do not introduce an abstraction; stage A deliberately did not, and its ownership gate came back clean under independent review.

## Measured baseline (2026-08-25, `npm run verify` green, exit 0)

| project | files | tests |
|---|---|---|
| unit | 64 | 961 |
| components | 45 | 296 |
| unit-sweeps | 10 | 122 |
| integration | 33 | 519 |
| **total** | **152** | **1898** |

`64 + 45 + 10 + 33 = 152`; `961 + 296 + 122 + 519 = 1898`. The two `npm test` invocations report `109 / 1257` and `43 / 641`.

**Re-measure at the end rather than predicting.** Stage A's inherited baseline was stale in structure, not only in count.

## The migration carries no data, and the seed is why

This app is pre-production. Production's first `prisma migrate deploy` runs
against an empty database; CI runs `migrate deploy` against a fresh service
container; and `prisma/seed.ts` opens by `deleteMany()`-ing every table, so the
dev database is destroy-and-rebuild by design. **A backfill would never execute
meaningfully anywhere** — its only real effect would be inventing `cancelledAt`
and `classCompletedAt` timestamps the rows never recorded.

So the rewire migration requires empty tables and refuses loudly otherwise. That
is strictly safer than a backfill: it declines rather than inventing, which is
what a future populated database actually wants.

**The shape comes from `prisma/seed.ts` instead** (Task 2a step 5b).

**`npx prisma migrate reset` is NOT available here.** Prisma's agent safety guard
refuses a whole-database wipe without freshly-given human consent, which a
subagent has no channel to obtain — stage A's plan records this. So the tables
are emptied by scoped, ordered deletes instead, which is the same "scoped
inverse rather than a wipe" discipline stage A used for mutation testing, and it
leaves every other table alone:

```bash
# EMPTY_CLASSES — run against dev, then against ethical_yoga_test.
# Order mirrors prisma/seed.ts's own teardown: dependents before Class.
docker exec -i fairyoga-db-1 psql -U yoga -d "$DB" -X -c '
  DELETE FROM "Announcement";  DELETE FROM "Notification";
  DELETE FROM "Payment";       DELETE FROM "WaitlistEntry";
  DELETE FROM "Registration";  DELETE FROM "Class";
  DELETE FROM "StudioClass";'
```

Then `npx prisma migrate deploy`, `npx prisma generate`, and `npx prisma db seed`
to rebuild dev. The test database needs no seed — `docs/test-database.md` states
that unit tests build their own fixtures and never seed it; its current contents
(42 classes, 6 studio classes, 457 teachers) are accumulated fixture litter.

**Hand-authored migrations are created with `--create-only`, never by naming a
file and then running `migrate dev`.** `migrate dev --name X` applies pending
migrations *and* diffs the schema, so against a file you already wrote by hand it
can author a *second* migration carrying the name you passed. Stage A's sequence
is the one to copy:

```bash
npx prisma migrate dev --create-only --name <name>   # Prisma makes the empty dir
# ... hand-author migration.sql, edit schema.prisma ...
npx prisma migrate deploy                            # applies; never authors
npx prisma generate
npx prisma migrate status                            # the drift check
```

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `prisma/migrations/<ts>_calendar_entry/migration.sql` | `CalendarEntry` table, generated `span`, exclusion constraint, duration CHECK. |
| `prisma/migrations/<ts>_calendar_entry_rewire/migration.sql` | Empty-tables guard, attach children by composite FK, shrink `ClassStatus`, drop the moved columns, install the three new triggers and drop the six old ones. One explicit transaction, no data movement. |
| `src/lib/entry-conflict.ts` | The failure-path probe that names the conflicting entry. |
| `src/app/api/classes/[id]/cancel/route.ts` | The regular family's cancel door. |
| `src/services/calendar-entry.test.ts` | Constraint and trigger behaviour, raw SQL. |

**Modified (principal):** `prisma/schema.prisma`, `src/lib/db-locks.ts`, `src/services/class-lifecycle.ts`, `src/services/class-transitions.ts`, `src/services/waitlist-retention.ts`, `src/services/class-generator.ts`, `src/services/studio-class-generator.ts`, `src/lib/generation.ts`, `prisma/seed.ts`, `tests/migration-sql.ts`, `src/services/slot-constraints.test.ts`, and the twelve ownership sites enumerated in Task 2b.

---

## Task order, and which constraints are load-bearing

1. **Task 1 before everything.** An exclusion constraint cannot be built over a text column — the cast is not `IMMUTABLE`. Parent spec §4.1 measured this. It is a prerequisite, not a preference.
2. **Task 2a and 2b are one atomic change split across two review gates.** 2a ends with the tree **knowingly red under `tsc`**; that is the single deliberate exception in this plan, and §Task 2a says how to test it instead. Keeping the tree green across the boundary would need throwaway sync machinery between the old columns and the new table.
3. **Tasks 3–5 sit on a working extraction** and are independently rejectable.
4. **Task 6 last**, because a sweep for invalidated claims must run against the finished diff.

---

## Task 1: `startTime` becomes `@db.Time` on `Class` and `StudioClass`

Self-contained and ships green. It also closes an inconsistency stage A created: `ScheduleRule.startTime` is already `@db.Time` while the two entry tables are `String`, so both generators convert on every write.

**Files:**
- Create: `prisma/migrations/<ts>_entry_start_time_to_time/migration.sql`
- Modify: `prisma/schema.prisma` (`Class.startTime`, `StudioClass.startTime`)
- Modify: every site the compiler flags (measured lower bound: 54 non-test files, 268 refs; the exact set is whatever `tsc` reports)
- Test: `tests/integration/classes-api.test.ts`, `tests/integration/studio-api.test.ts`, `src/services/class-generator.test.ts`, `src/services/studio-class-generator.test.ts`

**Interfaces:**
- Consumes: `timeToHHmm(t: Date): string` and `hhmmToTime(s: string): Date` from `@/lib/time-of-day` — already exist, already used by the rule layer.
- Produces: `Class.startTime` and `StudioClass.startTime` typed `Date` in the Prisma client. Every wire boundary still emits and accepts `"HH:MM"`.

- [ ] **Step 1: Write the failing test**

Add to `tests/integration/classes-api.test.ts`:

```ts
it('accepts and returns startTime as "HH:MM" while the column is time', async () => {
  const created = await postJson('/api/classes', {
    ...validClassBody(), date: '2027-03-01', startTime: '19:00', durationMinutes: 90,
  });
  expect(created.status).toBe(201);
  expect(created.body.startTime).toBe('19:00');

  // The column, not the wire: a text column would come back as a string here.
  const [row] = await prisma.$queryRaw<Array<{ t: Date }>>`
    SELECT "startTime" AS t FROM "Class" WHERE id = ${created.body.id}`;
  expect(row?.t).toBeInstanceOf(Date);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts -t 'while the column is time'`
Expected: FAIL — `expect(received).toBeInstanceOf(Date)` with `received` a string `"19:00"`.

- [ ] **Step 3: Write the migration**

`prisma/migrations/<ts>_entry_start_time_to_time/migration.sql`:

```sql
-- Pre-production: the column converts in place with a cast, no data migration.
-- `USING` is required — PostgreSQL will not implicitly cast text to time.
ALTER TABLE "Class"       ALTER COLUMN "startTime" TYPE TIME USING "startTime"::time;
ALTER TABLE "StudioClass" ALTER COLUMN "startTime" TYPE TIME USING "startTime"::time;
```

Both partial slot indexes (`Class_teacher_slot_unique`, `StudioClass_teacher_slot_unique`) and the four cross-family triggers reference `startTime`. Indexes are rebuilt automatically by the type change; the trigger functions compare `"startTime" = NEW."startTime"`, which stays valid because both sides become `time`. Task 2a deletes all six anyway.

- [ ] **Step 4: Update the schema**

In `prisma/schema.prisma`, both models:

```prisma
  startTime       DateTime  @db.Time
```

- [ ] **Step 5: Apply and regenerate**

```bash
npx prisma migrate dev --create-only --name entry_start_time_to_time
# hand-author the migration.sql above into the directory Prisma just made
npx prisma migrate deploy
npx prisma generate
npx prisma migrate status
```

`--create-only` then `deploy`, never `migrate dev --name` against a file you wrote: the latter applies pending migrations *and* diffs, so it can author a second migration carrying your name. Expected: applied, and `migrate status` reports no drift. **If anything offers to drop or recreate something else, stop** — that is drift this plan has not accounted for.

- [ ] **Step 6: Fix every compiler error**

Run `npm run typecheck` and work the list. The three shapes, all of which the rule layer already demonstrates:

```ts
// Reading, at a wire or render boundary:
startTime: timeToHHmm(cls.startTime),

// Writing, from a validated "HH:MM":
data: { startTime: hhmmToTime(parsed.data.startTime) },

// Comparing two stored times — now Date, so compare the primitive:
a.startTime.getTime() === b.startTime.getTime()
```

`classStartInstant` lives in **`src/lib/timezone.ts:159`** — verified 2026-08-25; if that line has drifted, fix this reference and report it. Its signature today is:

```ts
export function classStartInstant(classDate: Date, startTime: string, timeZone: string): Date {
  const d = new Date(classDate);
  const [hours, minutes] = startTime.split(':').map(Number) as [number, number];
```

Change the second parameter to `Date` and read the parts off it (`getUTCHours()` / `getUTCMinutes()`, matching how `timeToHHmm` reads a `@db.Time` value) rather than calling `timeToHHmm` at each of its call sites. The `as [number, number]` assertion goes with the split — do not carry it forward, it exists only to satisfy `noUncheckedIndexedAccess` on the string path.

**Do not widen `timeHHmm`.** It validates the wire format and keeps doing exactly that. 12 sites, unchanged.

- [ ] **Step 7: Run the test and watch it pass**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts -t 'while the column is time'`
Expected: PASS.

- [ ] **Step 8: Ask the user to restart the dev server, then verify**

The Prisma client changed shape. `next dev` never reloads `node_modules/@prisma/client` — it is a `globalThis` singleton — so integration results taken across this boundary are meaningless. **Stage A lost 97 test results to exactly this for most of a branch; the tell was an unrelated suite (`account-api`) failing.**

Ask the user to restart :3000. Then:

```bash
npm run verify
```

Expected: green, 152 files / 1898 tests. A number below that means something was deleted; investigate rather than accepting it.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/<ts>_entry_start_time_to_time src tests
git commit -m "refactor: startTime becomes @db.Time on Class and StudioClass

The exclusion constraint entry-layer occupancy needs cannot be built over a
text column — the text-to-time cast is not IMMUTABLE, measured in the parent
design §4.1. This is that prerequisite.

It also closes an inconsistency stage A created: ScheduleRule.startTime has
been @db.Time since PR #326 while both entry tables stayed String, so each
generator converted on every write.

Wire format is unchanged. time-of-day.ts is the only boundary; timeHHmm still
validates HH:MM at all 12 sites.

Refs issue 327."
```

---

## Task 2a: The database — `CalendarEntry`, its constraints, and the six triggers that go

**This task ends with `tsc` knowingly failing.** Its deliverable is the schema, and it is tested at the SQL level. Do not run `npm run verify` here and do not try to make it pass; Task 2b is what greens the tree.

**Files:**
- Create: `prisma/migrations/<ts>_calendar_entry/migration.sql`
- Create: `prisma/migrations/<ts>_calendar_entry_rewire/migration.sql`
- Modify: `prisma/seed.ts` — the source of dev data, since the migration carries none
- Create: `src/services/calendar-entry.test.ts`
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces, for Task 2b: `CalendarEntry` with fields `id`, `teacherId`, `kind: ClassFamily`, `classType: string`, `date: Date @db.Date`, `startTime: Date @db.Time`, `durationMinutes: number`, `cancelledAt: Date | null`, `classCompletedAt: Date | null`, `scheduleRuleId: string | null`. Relations `classes: Class[]`, `studioClasses: StudioClass[]`, `teacher`, `scheduleRule`.
- Produces: `Class.calendarEntryId: string`, `Class.kind: ClassFamily`, and the same pair on `StudioClass`.
- Produces: constraint names `CalendarEntry_teacher_slot_excl`, `CalendarEntry_duration_positive`, `Class_kind_check`, `StudioClass_kind_check`, `Class_calendarEntryId_kind_fkey`, `StudioClass_calendarEntryId_kind_fkey`. The `kind` CHECKs are on the **children**; the parent carries no such check, because its `kind` is the value the children are pinned against.
- Produces: trigger names `class_terminal_status_guard` (function `class_reject_terminal_status_change`), `class_sync_entry_completed_guard` (function `class_sync_entry_completed`), `entry_frozen_schedule_guard` (function `entry_reject_frozen_schedule_change`).
- Produces: `ClassStatus` with four members — `draft | open | in_progress | completed`.

- [ ] **Step 1: Re-run the stop condition against live data**

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga -X <<'SQL'
WITH e AS (SELECT "teacherId", date, "startTime"::time t, "durationMinutes" d, id FROM "Class" WHERE status <> 'cancelled'
           UNION ALL
           SELECT "teacherId", date, "startTime"::time, "durationMinutes", id FROM "StudioClass" WHERE "cancelledAt" IS NULL),
     s AS (SELECT *, tsrange(date+t, date+t+(d*interval '1 minute'), '[)') span FROM e)
SELECT * FROM s a JOIN s b ON a."teacherId"=b."teacherId" AND a.id<b.id AND a.span && b.span;
SQL
```

Expected: `(0 rows)`. **If it returns rows, stop and report them.** An exclusion constraint cannot be added `NOT VALID` (parent spec §7.2, measured), so the migration would abort; the resolution is a decision about those specific rows, never a weakening of the constraint.

- [ ] **Step 2: Write the failing constraint tests**

`src/services/calendar-entry.test.ts`. These run against the real database via raw SQL, so they survive Task 2a's red `tsc` — vitest compiles only what a test imports.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/prisma';

// Every case here is a MUTATION with a verdict. A guard that cannot be
// observed failing certifies nothing.
describe('CalendarEntry_teacher_slot_excl', () => {
  let teacherId: string;
  beforeEach(async () => { teacherId = await freshTeacher(); });

  const entry = (o: Partial<{ date: string; start: string; mins: number; cancelled: boolean }> = {}) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","cancelledAt","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','yoga',$2::date,$3::time,$4,$5,now(),now())`,
      teacherId, o.date ?? '2027-09-01', o.start ?? '19:00', o.mins ?? 90,
      o.cancelled ? new Date() : null,
    );

  it('refuses an entry overlapping the tail of another', async () => {
    await entry();
    await expect(entry({ start: '19:30', mins: 60 })).rejects.toThrow(/exclusion constraint/i);
  });

  it('ALLOWS back-to-back — the half-open boundary', async () => {
    await entry();                                   // 19:00-20:30
    await expect(entry({ start: '20:30', mins: 60 })).resolves.toBeDefined();
  });

  it('refuses one minute before that boundary', async () => {
    await entry();
    await expect(entry({ start: '20:29', mins: 60 })).rejects.toThrow(/exclusion constraint/i);
  });

  it('catches a collision ACROSS MIDNIGHT, which no per-date key could', async () => {
    await entry({ date: '2027-09-03', start: '23:30', mins: 60 });   // ends 00:30 on the 4th
    await expect(entry({ date: '2027-09-04', start: '00:15', mins: 30 }))
      .rejects.toThrow(/exclusion constraint/i);
  });

  it('a cancelled entry releases its slot', async () => {
    await entry({ cancelled: true });
    await expect(entry()).resolves.toBeDefined();
  });

  it('refuses un-cancelling back into an occupied slot', async () => {
    await entry({ cancelled: true });
    await entry();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "cancelledAt" = NULL WHERE "teacherId" = $1 AND "cancelledAt" IS NOT NULL`,
      teacherId,
    )).rejects.toThrow(/exclusion constraint/i);
  });

  it('refuses a DURATION edit that creates an overlap', async () => {
    await entry();                                   // 19:00-20:30
    await entry({ start: '21:00', mins: 30 });       // 21:00-21:30
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "durationMinutes" = 150 WHERE "teacherId" = $1 AND "startTime" = '19:00'`,
      teacherId,
    )).rejects.toThrow(/exclusion constraint/i);
  });

  it('does not constrain a different teacher', async () => {
    await entry();
    const other = await freshTeacher();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','yoga','2027-09-01','19:30',60,now(),now())`, other,
    )).resolves.toBeDefined();
  });
});

describe('disjoint occupancy — one entry, one child', () => {
  it('refuses a studio child on a regular entry (composite FK)', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'studio','P',50,now(),now())`, entryId,
    )).rejects.toThrow(/foreign key/i);
  });

  it('refuses forging the child kind to satisfy that FK (CHECK)', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','P',50,now(),now())`, entryId,
    )).rejects.toThrow(/check constraint/i);
  });

  // NOT /foreign key/i. Both composite FKs carry ON UPDATE CASCADE, so flipping
  // the parent's kind cascades into the child's kind column FIRST and the
  // child's own CHECK raises. The FK never gets a chance to reject anything.
  // Measured; the parent design recorded 23503 here and was corrected.
  it('refuses flipping the parent kind while a child is attached', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET kind = 'studio' WHERE id = $1`, entryId,
    )).rejects.toThrow(/check constraint/i);
  });
});

describe('the freeze: a trigger maintains the marker, the guard reads its own row', () => {
  it('sets classCompletedAt when the owning class completes', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    const [e] = await prisma.$queryRawUnsafe<Array<{ m: Date | null }>>(
      `SELECT "classCompletedAt" AS m FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.m).toBeInstanceOf(Date);
  });

  it('then refuses moving the date, the startTime, and the duration', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    for (const set of [`date='2027-12-01'`, `"startTime"='07:00'`, `"durationMinutes"=45`]) {
      await expect(prisma.$executeRawUnsafe(
        `UPDATE "CalendarEntry" SET ${set} WHERE id=$1`, entryId,
      )).rejects.toThrow(/frozen/i);
    }
  });

  it('freezes a CANCELLED regular entry without any marker', async () => {
    const { entryId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "CalendarEntry" SET "cancelledAt"=now() WHERE id=$1`, entryId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date='2027-12-01' WHERE id=$1`, entryId,
    )).rejects.toThrow(/frozen/i);
  });

  // The asymmetry, pinned. A studio cancellation is reversible and its
  // un-cancel path is live, so a cancelled studio entry must stay editable.
  it('does NOT freeze a cancelled STUDIO entry', async () => {
    const { entryId } = await studioEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "CalendarEntry" SET "cancelledAt"=now() WHERE id=$1`, entryId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date='2027-12-01' WHERE id=$1`, entryId,
    )).resolves.toBeDefined();
  });

  it('leaves a frozen entry editable on columns the guard does not name', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "classType"='vinyasa' WHERE id=$1`, entryId,
    )).resolves.toBeDefined();
  });
});
```

Write `freshTeacher`, `regularEntryWithClass` and `studioEntryWithClass` as local helpers in this file, following the fixture style already in `src/services/schedule-rule-constraints.test.ts` — **open that file and match it**, rather than inventing a second convention.

**Fixture spacing.** Range overlap is a change of KIND, not of degree. Space fixtures generously (hours apart, not minutes) **except where the case is about the collision** — there, the tight spacing is the test. Stage A had to re-space roughly 150 fixtures for exactly this reason.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run --project unit src/services/calendar-entry.test.ts`
Expected: every case fails with `relation "CalendarEntry" does not exist`.

- [ ] **Step 4: Write the create-table migration**

`prisma/migrations/<ts>_calendar_entry/migration.sql`. The exclusion constraint is added here, on a table that is empty and stays empty until the seed runs — so the first thing that can violate it is seed data, which is editable, rather than an `ALTER` over rows you would have to reason about.

```sql
-- The two families' shared enum. Renamed from `RuleKind`, which stage A named
-- for the only layer that then had one; it now discriminates at both.
ALTER TYPE "RuleKind" RENAME TO "ClassFamily";

CREATE TABLE "CalendarEntry" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "kind" "ClassFamily" NOT NULL,
    "classType" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "startTime" TIME NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "classCompletedAt" TIMESTAMP(3),
    "scheduleRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CalendarEntry_teacherId_date_idx" ON "CalendarEntry"("teacherId", "date");

-- The parent key for each child's composite foreign key, without which one
-- entry could carry a child of each family. Emitted by Prisma from
-- @@unique([id, kind]); declared here only because this table is hand-authored.
CREATE UNIQUE INDEX "CalendarEntry_id_kind_key" ON "CalendarEntry"("id", "kind");

-- Replaces the two @@unique([templateId, date]) indexes. TOTAL, not partial:
-- a cancelled entry releases its SLOT but goes on holding its DATE against the
-- hourly sweep, so a date the teacher cancelled is not refilled.
CREATE UNIQUE INDEX "CalendarEntry_scheduleRuleId_date_key"
  ON "CalendarEntry"("scheduleRuleId", "date");

ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_teacherId_fkey"
  FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_scheduleRuleId_fkey"
  FOREIGN KEY ("scheduleRuleId") REFERENCES "ScheduleRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_duration_positive"
  CHECK ("durationMinutes" > 0);

-- `date + time` and `+ interval` are IMMUTABLE, so the range can be a STORED
-- generated column rather than an expression index. A naive tsrange with no
-- zone is correct BECAUSE the constraint is scoped `teacherId WITH =`: two
-- entries are only ever compared inside one teacher's own calendar.
ALTER TABLE "CalendarEntry"
  ADD COLUMN "span" tsrange GENERATED ALWAYS AS (
    tsrange("date" + "startTime",
            "date" + "startTime" + ("durationMinutes" * interval '1 minute'),
            '[)')
  ) STORED;

-- Half-open '[)' so back-to-back teaching stays legal. Partial on liveness so a
-- cancelled entry releases its slot to a replacement.
ALTER TABLE "CalendarEntry"
  ADD CONSTRAINT "CalendarEntry_teacher_slot_excl"
  EXCLUDE USING gist ("teacherId" WITH =, "span" WITH &&)
  WHERE ("cancelledAt" IS NULL);
```

- [ ] **Step 5: Write the rewire migration**

`prisma/migrations/<ts>_calendar_entry_rewire/migration.sql`.

**There is no backfill, and that is deliberate.** This app is pre-production: production's first `prisma migrate deploy` runs against an empty database, CI runs against a fresh service container, and `prisma/seed.ts` opens by `deleteMany()`-ing every table, so the dev database is destroy-and-rebuild by design. A backfill here would never execute meaningfully anywhere — and its only real effect would be inventing `cancelledAt` and `classCompletedAt` timestamps that were never recorded. **Migration code that cannot run is worse than absent in a file this project may never edit again.**

So the migration requires empty tables and says so. A guard is strictly safer than a backfill would have been: it refuses rather than inventing, which is the behaviour a future populated database actually wants.

```sql
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. This migration MOVES columns between tables and does not carry data.
--    Pre-production: production's first deploy runs against an empty database
--    and the dev/test databases are disposable. Refuse loudly rather than
--    half-moving a schema or inventing timestamps the rows never recorded.
--
--    Remedy: the ordered deletes in the plan (dependents before Class), against
--    BOTH ethical_yoga and ethical_yoga_test, then `prisma migrate deploy` and
--    `prisma db seed`. NOT `prisma migrate reset` — Prisma's agent guard
--    refuses a whole-database wipe without fresh human consent, and a scoped
--    delete leaves every other table alone anyway.
--
--    This is a ONE-SHOT check, not an enforcement predicate — do not count it
--    as one in any later liveness or constraint audit. The block at the same
--    position in 20260821120000_cross_family_slot_guard was miscounted exactly
--    that way (design §1.3).
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT (SELECT count(*) FROM "Class") + (SELECT count(*) FROM "StudioClass") INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION
      'CalendarEntry rewire needs empty Class/StudioClass tables (found % rows). '
      'Empty them with the ordered deletes in the plan, then migrate deploy.', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Drop the six triggers FIRST: four read columns block 4 drops, and the two
--    terminality guards gate the status column block 3 retypes.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS class_cross_family_slot_insert_guard        ON "Class";
DROP TRIGGER IF EXISTS class_cross_family_slot_update_guard        ON "Class";
DROP TRIGGER IF EXISTS studio_class_cross_family_slot_insert_guard ON "StudioClass";
DROP TRIGGER IF EXISTS studio_class_cross_family_slot_update_guard ON "StudioClass";
DROP TRIGGER IF EXISTS class_terminal_status_guard                 ON "Class";
DROP TRIGGER IF EXISTS class_terminal_date_guard                   ON "Class";
DROP FUNCTION IF EXISTS class_reject_cross_family_slot();
DROP FUNCTION IF EXISTS studio_class_reject_cross_family_slot();
DROP FUNCTION IF EXISTS class_reject_terminal_date_change();
-- class_reject_terminal_status_change() is REPLACED in block 5, not dropped.

-- ---------------------------------------------------------------------------
-- 2. Each child hangs off an entry. NOT NULL immediately — the tables are
--    empty, which block 0 has already established.
-- ---------------------------------------------------------------------------
ALTER TABLE "Class"
  ADD COLUMN "calendarEntryId" TEXT NOT NULL,
  ADD COLUMN "kind" "ClassFamily" NOT NULL;
ALTER TABLE "StudioClass"
  ADD COLUMN "calendarEntryId" TEXT NOT NULL,
  ADD COLUMN "kind" "ClassFamily" NOT NULL;

-- The CHECK is what makes the composite FK mean "regular children hang off
-- regular entries"; without it the pair would merely have to AGREE, which both
-- children can do at once. Load-bearing, not redundant with the FK — and the
-- constraint that actually raises when a parent's kind is flipped, because the
-- FK's ON UPDATE CASCADE rewrites the child first.
ALTER TABLE "Class"       ADD CONSTRAINT "Class_kind_check"       CHECK ("kind" = 'regular');
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_kind_check" CHECK ("kind" = 'studio');

-- Names and ON UPDATE follow Prisma's conventions so `prisma migrate dev` does
-- not read this as drift.
ALTER TABLE "Class" ADD CONSTRAINT "Class_calendarEntryId_kind_fkey"
  FOREIGN KEY ("calendarEntryId","kind") REFERENCES "CalendarEntry"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_calendarEntryId_kind_fkey"
  FOREIGN KEY ("calendarEntryId","kind") REFERENCES "CalendarEntry"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Class"       ADD CONSTRAINT "Class_calendarEntryId_key"       UNIQUE ("calendarEntryId");
ALTER TABLE "StudioClass" ADD CONSTRAINT "StudioClass_calendarEntryId_key" UNIQUE ("calendarEntryId");

-- ---------------------------------------------------------------------------
-- 3. Liveness has moved to the entry, so `cancelled` leaves ClassStatus.
--    PostgreSQL cannot drop an enum value, so the type is recreated. No USING
--    cast can fail here: the table is empty.
-- ---------------------------------------------------------------------------
ALTER TYPE "ClassStatus" RENAME TO "ClassStatus_old";
CREATE TYPE "ClassStatus" AS ENUM ('draft', 'open', 'in_progress', 'completed');
ALTER TABLE "Class" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Class" ALTER COLUMN "status" TYPE "ClassStatus" USING "status"::text::"ClassStatus";
ALTER TABLE "Class" ALTER COLUMN "status" SET DEFAULT 'draft';
DROP TYPE "ClassStatus_old";

-- ---------------------------------------------------------------------------
-- 4. Only now drop the moved columns. The two partial slot indexes and the two
--    @@unique([templateId, date]) indexes go with them.
-- ---------------------------------------------------------------------------
ALTER TABLE "Class"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "date",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "templateId";
ALTER TABLE "StudioClass"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "date",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "templateId";

-- ---------------------------------------------------------------------------
-- 5. The three triggers that replace the six.
-- ---------------------------------------------------------------------------

-- (a) A terminal class cannot leave its status. Same guarantee as before, on a
--     terminal set that is now one member because cancellation is not a status.
CREATE OR REPLACE FUNCTION class_reject_terminal_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IN ('completed') THEN
    RAISE EXCEPTION
      'Class % is %, which is terminal; cannot change status to %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_terminal_status_guard
  BEFORE UPDATE OF status ON "Class"
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION class_reject_terminal_status_change();

-- (b) Terminality reaches the entry as a WRITE, not as a cross-table read. A
--     guard on CalendarEntry that read "Class".status would acquire
--     Entry -> Class, against lockClassRow's Class -> Entry: a measured ABBA
--     (40P01) on the schedule-write hot path. This fires inside the completing
--     transaction, so marker and status commit atomically, and it acquires
--     Class -> Entry, which composes with lockClassRow.
--
--     A marker synced from TypeScript instead would miss a raw
--     `UPDATE "Class" SET status='completed'` — and reaching clients that
--     bypass the services is the whole reason the freeze is a trigger.
--
--     `NEW.status IN (...)`, deliberately: `tests/migration-sql.ts` parses that
--     shape, so one parser pins this trigger and (a) above.
CREATE OR REPLACE FUNCTION class_sync_entry_completed()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('completed') THEN
    UPDATE "CalendarEntry" SET "classCompletedAt" = now()
     WHERE id = NEW."calendarEntryId" AND "classCompletedAt" IS NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_sync_entry_completed_guard
  AFTER UPDATE OF status ON "Class"
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION class_sync_entry_completed();

-- (c) The freeze. Single-table: it reads OLD on the very row the statement
--     already holds, so a concurrent completion cannot slip past it — when the
--     completing transaction commits, EvalPlanQual re-fetches and OLD carries
--     the fresh marker. Measured.
--
--     THREE columns, not one. The predecessor was BEFORE UPDATE OF date
--     because Class had one column to name; here the frozen thing is the span,
--     and the span is generated from three.
--
--     The kind conjunct is the two families' asymmetry: cancelling a Class is
--     terminal, cancelling a StudioClass is reversible and its un-cancel path
--     is live, so a cancelled studio entry must stay editable.
CREATE OR REPLACE FUNCTION entry_reject_frozen_schedule_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."classCompletedAt" IS NOT NULL
     OR (OLD.kind = 'regular' AND OLD."cancelledAt" IS NOT NULL) THEN
    RAISE EXCEPTION
      'CalendarEntry % is frozen; cannot change its date, start time or duration',
      OLD.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entry_frozen_schedule_guard
  BEFORE UPDATE OF "date", "startTime", "durationMinutes" ON "CalendarEntry"
  FOR EACH ROW EXECUTE FUNCTION entry_reject_frozen_schedule_change();

COMMIT;
```

**A second pre-flight for `CalendarEntry_scheduleRuleId_date_key` was proposed at review and is not needed** — the concern is real but lands somewhere else. That index is new and total where its two predecessors were per-family, so it *can* refuse data the old schema accepted. But this migration inserts nothing, so nothing can violate it here; the first writer is the seed, where a `23505` is a seed bug with an editable fix (step 7 names it). The review's supporting inference — that `ScheduleRule.classTemplates` being an array means two templates can share a rule — does not hold: `ClassTemplate.scheduleRuleId` and `StudioClassTemplate.scheduleRuleId` are both `String @unique`, and `ScheduleRule`'s own comment explains that the array is a Prisma modelling artifact, not cardinality.

- [ ] **Step 5b: Update `prisma/seed.ts` — this is where the data comes from**

`prisma/seed.ts` (1107 lines) opens by `deleteMany()`-ing every table and rebuilds from scratch, so it — not a backfill — is the source of the shape. Two changes:

1. **Add `calendarEntry.deleteMany()` to the teardown block**, positioned *after* `class` and `studioClass` (children first; the FK is `ON DELETE CASCADE` from parent to child, so deleting entries first would take the classes with them and make the ordering misleading even though it would work).
2. **Every `class.create` and `studioClass.create` becomes a nested create through the entry**, which is what keeps parent and child in one statement:

```ts
await prisma.calendarEntry.create({
  data: {
    teacherId: ivo.id,
    kind: 'regular',
    classType: 'Vinyasa Flow',
    date: someDate,
    startTime: hhmmToTime('19:00'),
    durationMinutes: 90,
    scheduleRuleId: template.scheduleRuleId,
    classes: {
      create: {
        kind: 'regular',
        teacherRoomId: room.id,
        roomCost: 20, minRate: 30, targetRate: 60,
        minStudents: 3, maxStudents: 12,
        status: 'open',
      },
    },
  },
});
```

**A cancelled seed class sets `cancelledAt` on the entry**, not `status`. **A completed one sets `status: 'completed'` on the child and lets the sync trigger write `classCompletedAt`** — do not set the marker by hand in the seed, or the seed stops exercising the trigger it depends on.

**`prisma/seed.ts` is inside the typecheck scope** — `tsconfig.json` includes `**/*.ts` and excludes only `node_modules` — so step 1's compiler enumeration *does* reach it and it cannot be silently missed. Verified 2026-08-25. It still needs its own attention, because a type-correct seed can still produce data the new constraints reject.

**Re-space seeded times.** Range overlap is a change of kind: the seed's classes are spaced for an exact-start key. Any two live classes of one teacher whose `[start, start+duration)` windows touch will now abort the seed with `23P01`. Read `prisma/seed.ts`'s existing header comment about the UTC-hour window before editing times — it warns about a related trap.

- [ ] **Step 6: Update `schema.prisma`**

```prisma
enum ClassFamily {
  regular
  studio
}

enum ClassStatus {
  draft
  open
  in_progress
  completed
}

model CalendarEntry {
  id               String      @id @default(uuid())
  teacherId        String
  kind             ClassFamily
  classType        String
  date             DateTime    @db.Date
  startTime        DateTime    @db.Time
  durationMinutes  Int

  /// Liveness, for both families. A cancelled entry releases its SLOT (the
  /// exclusion constraint is partial on this) but keeps its DATE against the
  /// hourly sweep, so a date a teacher cancelled is not refilled.
  cancelledAt      DateTime?

  /// The owning class completed. Written ONLY by `class_sync_entry_completed`,
  /// never from TypeScript — a marker synced by application code would miss a
  /// raw `UPDATE "Class" SET status='completed'`, and the freeze exists
  /// precisely to reach clients that bypass the services.
  ///
  /// Populated for `kind = 'regular'` only, because only that family has a
  /// `status`. That is not a gap: the freeze's cancel half is expressed
  /// directly from `kind` and `cancelledAt` in
  /// `entry_frozen_schedule_guard`, and a cancelled STUDIO entry is
  /// deliberately not frozen — that cancellation is reversible.
  ///
  /// Not a general "is this row editable" flag. #276's studio editability rule
  /// is date-derived and lives in `studio-class-editability.ts`.
  classCompletedAt DateTime?

  scheduleRuleId   String?

  /// The generated occupancy range. Declared so `prisma migrate dev` does not
  /// read it as drift; `Unsupported` keeps it out of the generated client, so
  /// it can be neither read nor written from TypeScript.
  span             Unsupported("tsrange")? @default(dbgenerated())

  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt

  teacher       Teacher       @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  scheduleRule  ScheduleRule? @relation(fields: [scheduleRuleId], references: [id], onDelete: SetNull)
  classes       Class[]
  studioClasses StudioClass[]

  @@unique([id, kind])
  @@unique([scheduleRuleId, date])
  @@index([teacherId, date])
}
```

On `Class`: remove `teacherId`, `classType`, `date`, `startTime`, `durationMinutes`, `templateId`, the `teacher` and `template` relations, `@@index([teacherId, date])` and `@@unique([templateId, date])`. Add:

```prisma
  calendarEntryId String      @unique
  kind            ClassFamily
  calendarEntry   CalendarEntry @relation(fields: [calendarEntryId, kind], references: [id, kind], onDelete: Cascade)
```

Same on `StudioClass`. Replace every `RuleKind` with `ClassFamily`.

**Keep `ScheduleRule.classTemplates` / `studioClassTemplates` plural** and add `calendarEntries` the same way — the existing comment on `ScheduleRule` explains why Prisma forces arrays here; read it before changing anything.

- [ ] **Step 7: Apply, and check what Prisma offers**

```bash
# 1. Empty Class/StudioClass in BOTH databases — see EMPTY_CLASSES above.
#    The rewire migration's block 0 refuses otherwise, by design.
# 2. Apply.
npx prisma migrate deploy
npx prisma generate
npx prisma migrate status
# 3. Rebuild dev data from the seed you updated in step 5b.
npx prisma db seed
```

Expected: both migrations applied, no drift, and the seed completes. **A `23P01` from the seed means two of its classes now overlap** — re-space them (step 5b), do not weaken the constraint. **A `23505` on `CalendarEntry_scheduleRuleId_date_key` means the seed puts two classes of one rule on one date**; that index is new and total where its two predecessors were per-family, so it is the seed that must change. **If it offers `DROP COLUMN "span"`, the `Unsupported(...)` declaration is wrong — fix it rather than accepting the drop**, which cascade-drops the exclusion constraint.

- [ ] **Step 8: Run the constraint tests**

Run: `npx vitest run --project unit src/services/calendar-entry.test.ts`
Expected: all pass.

**Then prove each guard bites.** For each of the three triggers and the exclusion constraint, break it, record the exact error text, restore, re-verify:

| Mutation | Expect |
|---|---|
| `entry_frozen_schedule_guard` → `BEFORE UPDATE OF "date"` only | the `startTime` and `durationMinutes` cases fail |
| the guard's `kind = 'regular'` conjunct removed | 'does NOT freeze a cancelled STUDIO entry' fails |
| `class_sync_entry_completed` → `IF false` | 'sets classCompletedAt' fails |
| `Class_kind_check` dropped | 'refuses flipping the parent kind' fails |
| `'[)'` → `'[]'` in the span expression | 'ALLOWS back-to-back' fails |

A mutation must use a value the code under test cannot produce; do not reach for one inside the range the system itself generates.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/calendar-entry.test.ts
git commit -m "feat: CalendarEntry takes the entry-level calendar identity

Four cross-family triggers, two trigger functions and two partial slot indexes
are replaced by one EXCLUDE USING gist over a generated tsrange, plus a
composite FK that makes disjoint occupancy declarative.

The migration carries no data and refuses non-empty tables. Pre-production:
production's first deploy runs against an empty database, CI against a fresh
container, and prisma/seed.ts is destroy-and-rebuild, so a backfill would never
execute meaningfully anywhere — and would have had to invent cancelledAt and
classCompletedAt timestamps the rows never recorded. The guard declines instead
of inventing, which is what a populated database would actually want. The seed
is updated in the same commit; it is where the shape comes from.

The range catches a collision no per-date key could: a 23:30 class running 60
minutes ends 00:30 the NEXT day, on a different date value.

Liveness collapses to CalendarEntry.cancelledAt and ClassStatus drops to four
members. Terminality reaches the entry through a trigger-maintained
classCompletedAt, so the freeze guard is single-table and lock-free; a guard
that read Class.status instead would acquire Entry then Class against
lockClassRow's Class then Entry, a measured 40P01.

tsc is knowingly red at this commit; the port is the next one.

Refs issue 327."
```

---

## Task 2b: The port — every TypeScript site the extraction moved

**Files:** the set `npm run typecheck` reports. Measured anchors, to be re-derived rather than trusted:

| Surface | Measured now |
|---|---|
| explicit 403 checks on a `Class`/`StudioClass` row | **12**, in 8 files (listed below) |
| `prisma.class.*` blocks referencing `teacherId` | 25 |
| `prisma.studioClass.*` blocks referencing `teacherId` | 16 |
| `'cancelled'` references in non-test `src/` | 48, of which 1 is a `case` arm |

The twelve 403 sites: `api/studio-classes/[id]/route.ts` (×3), `api/classes/[id]/route.ts` (×2), `api/classes/[id]/transition/route.ts`, `api/classes/[id]/complete/route.ts`, `api/announcements/route.ts`, `(teacher)/class/[id]/page.tsx`, `(teacher)/class/[id]/edit/page.tsx`, `(teacher)/studio-class/[id]/page.tsx`, `(teacher)/studio-class/[id]/edit/page.tsx`.

**Interfaces:**
- Consumes: everything Task 2a produced.
- Produces, for Tasks 3–5: `updateClass` returning `slot_conflict` unchanged in name; `lockClassRow(tx, classId)` with an unchanged signature and widened effect; `TERMINAL_CLASS_STATUSES` of length 1.

- [ ] **Step 1: Let the compiler enumerate the work**

```bash
npm run typecheck 2>&1 | tee /tmp/port.txt | tail -5
grep -c "error TS" /tmp/port.txt
```

This list **is** the task. Record the starting count in the commit message; it is the only honest measure of the port's size, and it is a compiler-derived number rather than a prose one.

- [ ] **Step 2: Widen `lockClassRow` to both rows**

`src/lib/db-locks.ts`:

```ts
/**
 * Locks a `Class` row AND its `CalendarEntry`, in that order.
 *
 * Both, because #327 moved `date`, `startTime` and `durationMinutes` to the
 * entry. `completeClass` decides `NOT_ENDED_YET` from those three, and
 * `updateClass` — which takes no lock of its own — used to serialise against
 * that decision only because its plain `UPDATE` hit the same row. After the
 * split that free lock covered the wrong table, which restores #182: a class
 * completed against a start time it no longer had, and completion bills.
 *
 * TWO STATEMENTS naming two tables, not one join. `FOR UPDATE OF c` locks only
 * `c`, and a waiting statement's joined predicate has already been evaluated
 * against the pre-wait snapshot — `EvalPlanQual` never re-fetches a non-locked
 * join member. Stage A measured that 6/6.
 *
 * `Class` first. Every writer that touches both must take them in this order;
 * `docs/lock-order.md` carries the rule.
 */
export async function lockClassRow(tx: TransactionClientOnly, classId: string): Promise<void> {
  await setLockTimeout(tx);
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
  await tx.$queryRaw`
    SELECT e.id FROM "CalendarEntry" e
    JOIN "Class" c ON c."calendarEntryId" = e.id
    WHERE c.id = ${classId}
    FOR UPDATE OF e`;
}
```

- [ ] **Step 3: Write the failing race test, then rewrite `updateClass`**

**Drive the interleaving deterministically — no `setTimeout`.** A sleep passes locally and flakes in CI, and worse, under the new lock the reschedule *blocks* on the completion, so `setLockTimeout` can fire first and the assertion passes for a reason unrelated to the fix. `src/services/template-lock-order.test.ts` is this repo's worked example of a two-connection lock test; **open it and follow its shape** rather than inventing one.

Assert the **reason**, never the boolean:

```ts
it('refuses a reschedule that races a completion, and says why', async () => {
  const { classId } = await openClassInThePast();

  // Connection A holds Class + CalendarEntry through completeClass. Connection
  // B attempts the reschedule while A is open. A lock timeout would ALSO make
  // ok false, so the reason is what distinguishes the fix from a flake.
  const outcome = await withCompletionHeldOpen(classId, async () => {
    return updateClass(dbOnSecondConnection, classId, { startTime: '23:00' });
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.reason).toBe('frozen');        // not 'terminal', not a timeout
});
```

Then rewrite `updateClass`. It writes both tables now — `classType`, `date`, `startTime`, `durationMinutes` to the entry; `description` and the five economic fields to `Class` — so it must become an explicit transaction, and it takes `lockClassRow` rather than relying on emergent statement order.

**Two things the naive shape gets wrong**, both raised at plan review:

1. **The two CAS results are different refusals and must not collapse into one reason.** A `Class` miss means terminal *status*; a `CalendarEntry` miss means a frozen *schedule*. They map to different sentences for the teacher.
2. **A request may legitimately touch only one table.** Editing only `startTime` leaves `classData` empty, and an unconditional `updateMany` with nothing to set is not a reliable count-of-1. Guard both sides symmetrically on whether that side has work.

```ts
return db.$transaction(async (tx) => {
  await lockClassRow(tx, classId);          // Class, then CalendarEntry

  // Symmetric: each side runs only if it has work, and each has its OWN
  // refusal. A request that touches neither table never reaches here —
  // `updateClassSchema` rejects an empty body upstream.
  if (classData !== null) {
    const r = await tx.class.updateMany({
      where: { id: classId, status: { notIn: [...TERMINAL_CLASS_STATUSES] }, ...lockedEconomics },
      data: classData,
    });
    if (r.count !== 1) return { ok: false, reason: 'terminal' };
  }

  if (entryData !== null) {
    // The CAS moved with the columns. `status: { notIn: TERMINAL }` sat on
    // `Class`, and four of the ten editable fields left that table, so this
    // filter is the entry's OWN columns — the same predicate
    // `entry_frozen_schedule_guard` enforces. The trigger is the backstop that
    // reaches raw SQL; this is the path that returns a 409.
    const r = await tx.calendarEntry.updateMany({
      where: {
        id: entryId,
        classCompletedAt: null,
        NOT: { kind: 'regular', cancelledAt: { not: null } },
      },
      data: entryData,
    });
    if (r.count !== 1) return { ok: false, reason: 'frozen' };
  }
  ...
});
```

`'frozen'` is a new reason and needs a sentence and an error code at `api/classes/[id]/route.ts`, beside the existing `terminal` / `slot_conflict` / `template_date_conflict` arms — read how those four are worded before adding a fifth.

**`updateClass` changes from lock-free-with-CAS to lock-taking.** Say so in its docblock, and delete the sentence that currently reads "This function takes no lock at all" — it becomes false at this commit.

- [ ] **Step 4: Give each `lockClassRowsOrdered` caller a written verdict**

Four production sites: `gdpr.ts` (×2), `waitlist.ts`, `class-template-lifecycle.ts`. For each, write one line in the commit message answering: *does this transaction read or write entry-level scheduling fields?* Widen only those that do. Widening all four by reflex adds wait edges nothing needs.

- [ ] **Step 5: Port the reaper**

`waitlist-retention.ts`'s `reapable` — both halves of its predicate now live on the entry, which is a simplification worth noting in the docblock:

```ts
const reapable = {
  registrationId: null,
  status: { notIn: [...FULFILLED_WAITLIST_STATUSES] },
  class: {
    calendarEntry: {
      date: { lt: cutoff },
      // Terminality, in the same shape `entry_frozen_schedule_guard` enforces:
      // the entry is frozen iff its class completed, or it is a cancelled
      // regular entry. One predicate, one row, one guard.
      OR: [
        { classCompletedAt: { not: null } },
        { kind: 'regular', cancelledAt: { not: null } },
      ],
    },
  },
} satisfies Prisma.WaitlistEntryWhereInput;
```

Its docblock's safety argument names two triggers by their old identities. **Rewrite the whole argument** — this is the paragraph most likely to survive as a stale description, because a keyword sweep finds a stale name and never a stale description.

- [ ] **Step 6: Port the two generators and the end-instant call sites**

`class-generator.ts` and `studio-class-generator.ts`: the cross-family `foreign` read and its `blocked_by_other_family` branch are deleted — under one table there is no other family. The occupancy read becomes one query over `CalendarEntry`.

`class-lifecycle.ts` (`completeClass`) and `class-transitions.ts` (`autoCompleteClasses`): both compute `classStartInstant(date, startTime, tz) + durationMinutes` from a single `Class` row. All three fields move, so both need the entry. `completeClass` already reads `teacher` under its lock via `include`, so adding `calendarEntry` to the same `include` is the shape that file already uses — and Step 2 makes that read lock-covered.

- [ ] **Step 6b: Audit every POSITIVE `status` filter — the compiler cannot see these**

**Raised at plan review, and it is the sharpest finding on this plan.** Task 2b step 1 leans on Prisma's string-literal union to enumerate the work, and it does — *for sites that express liveness negatively*. `status: { not: 'cancelled' }` and `notIn: ['cancelled']` stop compiling the moment the member leaves, so the compiler hands you that list.

**Sites that express liveness positively keep compiling and silently change meaning.** After this branch a cancelled class *keeps its status* — cancellation is `CalendarEntry.cancelledAt`, not a status — so `status: { in: ['draft','open'] }` now matches cancelled classes that it used to exclude. Nothing in step 1 surfaces it, and Task 6's sweep greps *removed names*, which these sites do not contain.

This is the one place the plan's known-gap policy does **not** apply: the list has to be hand-derived, because no compiler output contains it.

```bash
grep -rn "status: '\(draft\|open\|in_progress\|completed\)'\|status: { in:" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

Measured 2026-08-25: **50 hits.** Most are `Registration.status`, `Payment.status` or `WaitlistEntry.status` and are unaffected — **give each hit a verdict rather than a blanket rewrite**; rewriting a still-correct filter is the mirror-image defect.

The `Class.status` ones are the task, and the named sets are where to start, because a named set is a tether and a literal array is not:

| Site | Constant | Did it mean "live"? |
|---|---|---|
| `gdpr.ts:325`, `gdpr.ts:468` | literal `['draft','open']` | verdict required |
| `gdpr.ts:933`, `gdpr.ts:1057` | `CANCELLABLE_STATUSES` | verdict required |
| `room-archive.ts:116` | `BLOCKING_CLASS_STATUSES` | verdict required |
| `class-template-lifecycle.ts:1377` | `SCHEDULED_STATUSES` | verdict required |
| `class-lifecycle.ts:413` | `sourceStatesFor(targetStatus)` | derived from `VALID_TRANSITIONS` |
| `waitlist-retention.ts:379` | `TERMINAL_CLASS_STATUSES` | handled in step 5 |
| `api/classes/[id]/transition/route.ts:78` | literal `['draft','open']` | moves to the cancel route (step 8) |

Where a filter meant "live", it gains `calendarEntry: { cancelledAt: null }` alongside — the status half no longer carries that meaning on its own.

**Each of the four named constants is derived or hand-declared against `ClassStatus`.** Open each definition: shrinking the enum changes what a derived one contains and silently leaves a hand-declared one wrong. `CANCELLABLE_STATUSES` is the one to read first — its name is about the operation this branch removes from the enum.

Write a test for at least one user-visible consequence, so the finding is pinned rather than merely fixed:

```ts
it('a cancelled class is not offered as bookable', async () => {
  const { classId } = await openClass();
  await cancelClass(classId);                    // writes calendarEntry.cancelledAt
  const bookable = await listBookableClasses(teacherId);
  expect(bookable.map((c) => c.id)).not.toContain(classId);
});
```

- [ ] **Step 7: Port the twelve ownership sites, inline**

```ts
// before
const cls = await prisma.class.findUnique({ where: { id } });
if (cls.teacherId !== session.teacherId) return respondError('Not your class', 403);

// after — stage A's shipped shape, no helper
const cls = await prisma.class.findUnique({
  where: { id },
  include: { calendarEntry: true },
});
if (cls.calendarEntry.teacherId !== session.teacherId) return respondError('Not your class', 403);
```

and scoping:

```ts
where: { calendarEntry: { teacherId: session.teacherId } },
```

**Every one of these is gate 4.** Do not batch them past review; the 403 must land in exactly the same place, and a query that loses its scope still compiles.

- [ ] **Step 8: Add the regular family's cancel door**

Cancellation is no longer a transition, so `transitionClassSchema` stops accepting `'cancelled'` and `VALID_TRANSITIONS` becomes:

```ts
export const VALID_TRANSITIONS: Record<ClassStatus, readonly ClassStatus[]> = {
  draft: ['open'],
  open: ['in_progress'],
  in_progress: ['completed'],
  completed: [],
};
```

Create `src/app/api/classes/[id]/cancel/route.ts`, moving the duty-of-care block out of `transition/route.ts` verbatim — registered students must still be notified and the waitlist must still close. Point `cancel-class-button.tsx` at it. The studio family keeps its existing PUT, which already writes `cancelledAt`.

- [ ] **Step 9: Green the tree**

```bash
npm run typecheck && npm run lint
```

Then **ask the user to restart :3000** (the client changed shape again), and:

```bash
npm run verify
```

Expected: green. If a unit test is red, the integration project reports **nothing at all** — `npm test` joins two invocations with `&&`. Run `npx vitest run --project integration` directly rather than reading a red `verify` as evidence about that tier.

- [ ] **Step 10: Commit**

```bash
git add src tests prisma/schema.prisma
git commit -m "refactor: port every site the extraction moved

Started from N typecheck errors (recorded, not estimated).

lockClassRow now takes Class then CalendarEntry as two statements naming two
tables — a joined FOR UPDATE OF would not re-fetch the non-locked member.
updateClass writes both tables so it becomes an explicit transaction and takes
that lock rather than relying on Prisma's statement order; its CAS moved to the
entry's own columns, the predicate entry_frozen_schedule_guard enforces.

The reaper's two halves are now both on the entry, so its safety argument is one
predicate over one row rather than two triggers over two tables. Rewritten in
full rather than patched.

Ownership stays inline, per stage A: entry.teacherId for the 403,
where: { calendarEntry: { teacherId } } for the scope. 12 checks, 8 files.

Refs issue 327."
```

---

## Task 3: The refusal names the conflicting entry

**Files:** Create `src/lib/entry-conflict.ts`; modify `api/classes/route.ts`, `api/classes/[id]/route.ts`, `api/studio-classes/route.ts`, `api/studio-classes/[id]/route.ts`.

**Interfaces:**
- Consumes: `isExclusionConflictOn(err, 'CalendarEntry_teacher_slot_excl')` from `@/lib/exclusion-conflict` — exists, unchanged.
- Produces: `probeConflictingEntry(db, teacherId, span): Promise<ConflictingEntry | null>` where `ConflictingEntry = { id, kind, date, startTime, durationMinutes }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('names the conflicting class, not just the family', async () => {
  await createClass({ date: '2027-09-01', startTime: '19:00', durationMinutes: 90 });
  const res = await postJson('/api/studio-classes', {
    ...validStudioBody(), date: '2027-09-01', startTime: '19:30', durationMinutes: 60,
  });
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/19:00/);
});

// The case the family discriminator could not serve: the conflict is not on
// the date being edited, so naming only "your recurring classes" strands the
// teacher on the wrong day.
it('names a conflict that spilled from the previous day', async () => {
  await createClass({ date: '2027-09-03', startTime: '23:30', durationMinutes: 60 });
  const res = await postJson('/api/studio-classes', {
    ...validStudioBody(), date: '2027-09-04', startTime: '00:15', durationMinutes: 30,
  });
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/3 September|2027-09-03/);
});

it('answers without naming anything when the conflict vanished', async () => {
  // 'unknown' is a real state: the conflicting entry can be cancelled between
  // the refusal and the probe, and naming the wrong half of a teacher's
  // schedule is worse than naming neither.
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts -t 'conflicting class'`
Expected: FAIL — the message names a family, or the request 500s.

- [ ] **Step 3: Write the probe**

`span` is `Unsupported` in Prisma, so this is raw SQL — the same concession `ScheduleRule.slot` already makes. It runs **after** the refusal, on the base client, never on the aborted `tx`: a statement that fails inside a transaction aborts it, and a probe issued on `tx` returns `25P02` rather than an answer.

**Do not parse the `23P01` `DETAIL`.** It does carry the conflicting key values in both error shapes — measured — but reading it means two escapings across two error classes with no compiler tether. `isExclusionConflictOn` already declined to read past the constraint name.

- [ ] **Step 4: Run and watch them pass, then commit**

---

## Task 4: `blocked_by_other_family` becomes an overlap reason

A rename of a member, not a seventh member: under the extraction there is no other family, and the condition becomes "an existing entry overlaps this candidate". Nine non-test sites carry the current member.

`COUNT_KEYS`'s `satisfies Record<keyof T, true>` in `template-action-messages.ts` is what makes the rename total — a missed member fails the build rather than vanishing. Read that file's docblock before touching the enum.

Generation can still be blocked for two reasons the rule layer cannot anticipate: a rule that spills past midnight (the rule constraint keys on `dayOfWeek` and cannot see it), and a manually created class, which is an entry with no rule behind it.

---

## Task 5: The pinning tests, re-pointed

**Two texts now hard-code the terminal status list, not one** — `class_terminal_status_guard` and `class_sync_entry_completed`, both on `Class`. That is the cost the trigger-synced marker adds, and it is exactly the drift these pins exist to catch.

- [ ] **Step 1: Widen the parser**

`tests/migration-sql.ts` matches `OLD\.status IN \(([^)]+)\)`. The sync trigger says `NEW.status`. Widen to `(?:OLD|NEW)\.status IN \(([^)]+)\)` and update the docblock's "TWO CALL SITES, ONE PARSER" paragraph to say three.

- [ ] **Step 2: Re-point `class-terminal-date.test.ts`**

Its migration no longer hard-codes any status — terminality reaches the entry through the marker — so `enforcedTerminalStatuses` would throw its named shape error. Replace that pin with one against the **sync trigger's** migration, preserving the design intent: two independent frozen texts that nothing forces to agree, each pinned separately.

- [ ] **Step 3: Re-derive the `slot-constraints.test.ts` census from the file, never from parent §7.1**

Parent §7.1 is stale in both directions (stage B §1.3.2): four `*_teacher_slot_unique` indexes are two, 731 lines are 421, four deletable cases are two, and every line citation is off.

```bash
wc -l src/services/slot-constraints.test.ts
grep -n "^describe\|^  it(" src/services/slot-constraints.test.ts
```

Port group by group against **that** output. `Room identity indexes` is untouched — it shares the file, not the subject.

---

## Task 6: Sweep for what was invalidated, not for what was edited

Stage A hit this ten times in one branch. Every early sweep was keyed on the code that changed; every stale claim was about the objects that went.

- [ ] **Step 1: List what was REMOVED, then grep for those names**

```
Class.teacherId  Class.date  Class.startTime  Class.durationMinutes
Class.classType  Class.templateId          (and the StudioClass twins)
ClassStatus.cancelled     RuleKind
Class_teacher_slot_unique     StudioClass_teacher_slot_unique
Class_templateId_date_key     StudioClass_templateId_date_key
class_cross_family_slot_insert_guard   class_cross_family_slot_update_guard
studio_class_cross_family_slot_insert_guard
studio_class_cross_family_slot_update_guard
class_reject_cross_family_slot   studio_class_reject_cross_family_slot
class_terminal_date_guard   class_reject_terminal_date_change
YG001    blocked_by_other_family
```

Grep each across `src/`, `tests/`, `docs/`, `prisma/schema.prisma`, `CLAUDE.md`. **Expect legitimate survivors** and give every hit its own verdict — rewriting a still-true claim is the mirror-image defect and costs more than the staleness did.

**This sweep cannot find a positive-liveness filter** — those contain none of the removed names. Task 2b step 6b is where they are enumerated; confirm it was done rather than re-deriving it here.

- [ ] **Step 2: Read whole docblocks in every touched function**

A grep finds a stale NAME; it never finds a stale DESCRIPTION. Stage A's one Critical review finding was a docblock whose third sentence had been correctly rewritten and whose seventh still described the same object wrongly — in a paragraph that branch had itself edited. It survived nine keyword sweeps.

**Include runtime log strings.** The same shape turned up there on stage A, and that is the only category that reaches an operator's `grep`.

- [ ] **Step 3: Update CLAUDE.md**

*Class Lifecycle* (the five-member `ClassStatus` sentence, the two-doors paragraph, the #296 bullet's class half), *Data Model*, and `docs/lock-order.md`'s cross-family section — #296's residual race is **deleted**, not weakened: the unlocked cross-table `SELECT` it describes no longer exists.

- [ ] **Step 4: Re-measure the baseline and run `npm run verify`**

Record files and tests per project with totals that reconcile. Do not predict; stage A predicted 1294 and measured 1296.

---

## Self-Review

**Spec coverage.** §1.3.1 disjoint occupancy → Task 2a steps 4–5, tested step 2. §1.3.2 census → Task 5 step 3. §1.4 stop condition → Task 2a steps 1 and 5 (block 0). §2 lock coverage → Task 2b steps 2–4. §3 probe → Task 3. §4 freeze → Task 2a step 5 blocks 5(b)(c), tested step 2. §4.4 three columns → Task 2a block 5(c). §4.5 asymmetry + two pins → Task 2a schema docblock, Task 5. §5 cancel door → Task 2b step 8. §6 `startTime` → Task 1. §7 stop conditions → Task 2a step 1, Task 1 step 8, Task 2b step 9.

**Review findings folded in (2026-08-25):** positive-liveness filters → Task 2b step 6b (the one hand-derived list in this plan); `updateClass`'s two refusals and its empty-`data` case → step 3; the race test's timing → step 3, driven by a two-connection fixture and asserting the reason; `prisma/seed.ts` → File Structure, Task 2a step 5b, and confirmed inside the typecheck scope; `migrate dev --name` against hand-authored files → `--create-only` then `deploy` throughout; `migrate reset` unavailable to a subagent → scoped ordered deletes instead. One finding rejected with evidence: the second pre-flight (see Task 2a step 5).

**Known gap, stated rather than hidden:** the plan does not enumerate every one of the ~41 query blocks Task 2b must port. That is deliberate — hand-listing them is the habit that left 20 of 26 integration files unobserved on #170. The compiler enumerates them exactly, and Task 2b step 1 makes that list the task.
