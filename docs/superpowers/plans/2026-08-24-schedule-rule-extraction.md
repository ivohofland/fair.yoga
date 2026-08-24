# ScheduleRule Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the rule-level calendar identity shared by `ClassTemplate` and
`StudioClassTemplate` into one `ScheduleRule` table, and replace the two
exact-start partial unique indexes plus four cross-family triggers with a single
range-overlap exclusion constraint.

**Architecture:** `ScheduleRule` owns the slot (`teacherId`, `kind`,
`classType`, `dayOfWeek`, `startTime`, `durationMinutes`) and the shared
lifecycle flags (`isActive`, `isArchived`, `archivedAt`, `withdrawnCount`). The
two template tables survive holding only their economics and become children via
a composite foreign key `(scheduleRuleId, kind)` → `ScheduleRule (id, kind)`,
which makes it structurally impossible for one rule to carry a template of each
family. Occupancy is enforced by `EXCLUDE USING gist` over a generated
`int4range` of minutes-since-midnight.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma + PostgreSQL
16, vitest (three projects: `unit`, `components`, `integration`), `btree_gist`.

**Spec:** `docs/superpowers/specs/2026-08-24-calendar-entry-extraction-design.md`

---

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
  `noUncheckedIndexedAccess` is on — indexing yields `T | undefined`.
- **Test-first.** Every task writes a failing test, runs it to see it fail,
  implements, re-runs. A guard that has not been observed failing is not done
  (`.claude/skills/solve-issue` §3).
- **Never edit an applied migration**, comment-only edits included — it changes
  the checksum while `prisma migrate status` compares names, so nothing catches
  it until the next `prisma migrate dev` demands a reset. Prose about a
  migration goes in `docs/`.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths
  containing parentheses (`"src/app/(teacher)/…"`).
- **Never start or restart the dev server on :3000.** The user runs it; the
  `integration` project talks to it over HTTP.
- **Prisma cannot express** exclusion constraints, partial indexes, `CHECK`
  constraints, or generated columns. All are hand-authored following
  `prisma/migrations/20260721061528_student_claim_link_check/`, and are invisible
  to `prisma migrate diff` — so they do not read as drift in CI.
- **Commit per task.** The PR is rebase-merged, never squashed.
- **`@/lib/log` is pino and server-only.** Do not import it into any module a
  `'use client'` component value-imports.
- Run `npm run verify` before pushing. It needs :3000 live.

## Measured baseline (2026-08-24, on `main` at `284e84a`)

| Project | Files | Tests |
|---|---|---|
| `unit` | 68 | 1068 |
| `components` | 45 | 294 |
| `integration` | 33 | 513 |
| **Total** | **146** | **1875** |

`68 + 45 + 33 = 146`. `1068 + 294 + 513 = 1875`. All passing.

**Re-measure this at execution time rather than trusting it.** It was taken
before any of this work and the repo moves; on #212 a predicted after-figure was
wrong by two because that branch's own review added tests the prediction could
not have known about.

---

## Scope: what this plan is, and the two plans it is not

The spec covers two independently shippable subsystems. This plan is the first.

**In scope — the rule layer (#298's option D).** `ScheduleRule`, its constraint,
the composite FK, deleting the four template-level triggers and two template
slot indexes.

**Out of scope — the entry layer (#298's option C).** `CalendarEntry`,
`ClassStatus` shrinking to four members, `cancelledAt` unifying, the
`startTime → @db.Time` change on `Class`/`StudioClass`, the entry-level
exclusion. That is a second plan, written after this one lands, and it depends
on this one only for `CalendarEntry.scheduleRuleId`.

**Out of scope — merging the two lifecycle service triads.** `class-template-
lifecycle.ts` (2181 lines) and `studio-class-template-lifecycle.ts` (1378 lines)
expose parallel `update` / `pauseOrResume` / `archiveOrUnarchive` triads. Under
this extraction they operate on the same `ScheduleRule` columns and could become
one triad. **They are deliberately not merged here.** The invariant is the point
of this work; the merge is a pure refactor with no schema consequence, and
riding a 3559-line refactor along with the migration that changes what the
database refuses would make both halves harder to review — which is where this
project has caught its slot bugs.

**And the triads are not uniformly parallel, which splits that follow-up in
two.** Measured:

| Operation | Divergence | Ready after this plan? |
|---|---|---|
| `pauseOrResume` | none material — same `action` vocabulary, same failure reasons, identical docblocks, and the studio file already imports `LastScheduledClass` from the class file (`studio-class-template-lifecycle.ts:58`) | **yes** |
| `archiveOrUnarchive` | none material — same three actions, same reasons including `cross_family_slot_conflict` | **yes** |
| `update` | **substantial** — `generationState` / `firstFreeWeek` appears 9 times in the class file and 0 times in the studio file | **no** |

```
grep -c "generationState\|firstFreeWeek" src/services/class-template-lifecycle.ts        # 9
grep -c "generationState\|firstFreeWeek" src/services/studio-class-template-lifecycle.ts # 0
```

That asymmetry is #194's "first week the new schedule reaches", which the studio
family has never had — and #284's rule 4 is the open question of whether it
should. Merging `update` before that is decided would extract a shared
abstraction across two implementations without knowing whether their difference
is essential, which is the failure this issue's own sequencing argument exists to
avoid. **`update` waits on #284; the other two do not.**

**Also out of scope, from the design's §11 carried-forward list:** item 2 (a
written verdict per liveness SQL predicate) is entirely entry-layer — all 14
predicates spell *cancellation*, and the four template-level trigger functions
contain none of them, which is why Task 5 can delete those triggers without
touching that audit. Item 6 (`api/studio-classes/[id]/route.ts:143`'s re-entry
comment) is about `cancelledAt` and moves with the entry layer. Item 7 (which
generator survives) is the generator merge, which rides with the triad refactor.

**Also out of scope: the `SkipReason` rename.** #298's decision comment says
`blocked_by_other_family` becomes the overlap reason. That is an *instance*-level
skip, produced when a generator finds an occupied slot for a candidate
`Class`/`StudioClass` — it belongs to the entry layer. The generators' template
*reads* change here (Task 6); their cross-family instance pre-check does not.

---

## File structure

**Created**

| File | Responsibility |
|---|---|
| `prisma/migrations/<ts>_schedule_rule/migration.sql` | Create `ScheduleRule`, its generated `slot`, the exclusion constraint, `UNIQUE (id, kind)` |
| `prisma/migrations/<ts>_schedule_rule_backfill/migration.sql` | One rule per live template; add + populate `scheduleRuleId`/`kind` on both children; composite FK; drop the nine moved columns from each child |
| `prisma/migrations/<ts>_drop_template_slot_guards/migration.sql` | Drop the four template triggers, two functions, two partial unique indexes |
| `src/services/schedule-rule-constraints.test.ts` | The exclusion constraint's mutation table (§4.4), driven through Prisma |
| `src/lib/exclusion-conflict.ts` | Detect a 23P01 for a named constraint; `isUniqueConflictOn`'s sibling |
| `src/lib/exclusion-conflict.test.ts` | Its tests, including one that proves the matcher can fail |

**Modified** (the compile surface — see Task 3 for how it is enumerated rather
than listed by hand)

`prisma/schema.prisma`; the two lifecycle services; the four template API routes
(`api/class-templates/route.ts`, `api/class-templates/[id]/route.ts`,
`api/studio-class-templates/route.ts`, `api/studio-class-templates/[id]/route.ts`);
the two generators; `src/lib/api-errors.ts`; `src/lib/template-selection.ts`;
`src/lib/db-locks.ts`; the six settings pages; the four settings components;
`src/services/room-archive.ts`, `room-deletion.ts`, `gdpr.ts`.

**Deliberately not hand-listed:** the integration files. `npm run verify` runs
all 33, and hand-listing them is the habit that left 20 of 26 unobserved on #170.
Name a file only where its *order* matters, which here is nowhere.

---

## Task 1: The conflict matcher, `ScheduleRule`, and proof the constraint bites

**Files:**
- Create: `src/lib/exclusion-conflict.ts`, `src/lib/exclusion-conflict.test.ts`
- Create: `prisma/migrations/<timestamp>_schedule_rule/migration.sql`
- Create: `src/services/schedule-rule-constraints.test.ts`
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing.
- Produces: `isExclusionConflictOn(err: unknown, constraint: string): boolean`,
  and the Prisma model `ScheduleRule` with `id: string`, `teacherId: string`,
  `kind: RuleKind` (`'regular' | 'studio'`), `classType: string`,
  `dayOfWeek: number`, `startTime: Date` (`@db.Time`), `durationMinutes: number`,
  `isActive: boolean`, `isArchived: boolean`, `archivedAt: Date | null`,
  `withdrawnCount: number`. The generated `slot` column is **not** in the Prisma
  model — it is unmappable and never written.

**Why the matcher comes first.** `slot-constraints.test.ts`'s own docblock rules
out the assertion style this task would otherwise reach for: *"The assertions
name `meta.target` — the column list — rather than matching a message. A bare
`rejects.toThrow()` would be satisfied by any masking failure."* An exclusion
violation has **no** `meta.target` (measured: `code` and `meta` are both
`undefined`), so the constraint tests need a matcher that names the constraint,
and it has to exist before they are written.

- [ ] **Step 1: Run the stop-condition query. If it returns a row, STOP.**

This is the one step that can fail on data rather than on code (design §7.2).
Run against the dev database **and** the test database:

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga <<'SQL'
WITH r AS (
  SELECT id, "teacherId", "dayOfWeek" dow, "startTime"::time st, "durationMinutes" dur FROM "ClassTemplate" WHERE "isArchived"=false
  UNION ALL
  SELECT id, "teacherId", "dayOfWeek", "startTime"::time, "durationMinutes" FROM "StudioClassTemplate" WHERE "isArchived"=false),
     x AS (SELECT *, int4range((EXTRACT(HOUR FROM st)*60+EXTRACT(MINUTE FROM st))::int,
                               (EXTRACT(HOUR FROM st)*60+EXTRACT(MINUTE FROM st))::int + dur, '[)') slot FROM r)
SELECT * FROM x a JOIN x b ON a."teacherId"=b."teacherId" AND a.dow=b.dow AND a.id<b.id AND a.slot && b.slot;
SQL
```

Expected: `(0 rows)`. Measured 0 on 2026-08-24 against 5 live `ClassTemplate` +
1 live `StudioClassTemplate` — but templates accumulate faster than classes do,
so re-run rather than trust.

If it returns rows, the resolution is a decision about *those specific rows*
with the user, **not** a weakening of the constraint. Stop and report.

- [ ] **Step 2: Write the matcher's failing test**

```typescript
// src/lib/exclusion-conflict.test.ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isExclusionConflictOn } from './exclusion-conflict';

// The measured shape of a 23P01 through Prisma Client: `code` and `meta` are
// both undefined, and the SQLSTATE and constraint name survive only in
// `message`. Captured from a real violation, not composed by hand.
const raise = (constraint: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    'Invalid `db.scheduleRule.create()` invocation\n\nError occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError ' +
      `{ code: "23P01", message: "conflicting key value violates exclusion constraint \\\\"${constraint}\\\\"", ` +
      'severity: "ERROR", detail: Some("Key ..."), column: None, hint: None }), transient: false })',
    { clientVersion: 'test' },
  );

describe('isExclusionConflictOn', () => {
  it('matches the named constraint', () => {
    expect(isExclusionConflictOn(raise('ScheduleRule_teacher_slot_excl'), 'ScheduleRule_teacher_slot_excl')).toBe(true);
  });

  it('does not match a different constraint', () => {
    expect(isExclusionConflictOn(raise('SomeOther_excl'), 'ScheduleRule_teacher_slot_excl')).toBe(false);
  });

  it('does not match a unique violation', () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['teacherId', 'dayOfWeek'] },
    });
    expect(isExclusionConflictOn(p2002, 'ScheduleRule_teacher_slot_excl')).toBe(false);
  });

  it('does not match a plain string that happens to quote the constraint', () => {
    expect(isExclusionConflictOn(
      'conflicting key value violates exclusion constraint "ScheduleRule_teacher_slot_excl"',
      'ScheduleRule_teacher_slot_excl',
    )).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run --project unit src/lib/exclusion-conflict.test.ts
```

Expected: FAIL — `Cannot find module './exclusion-conflict'`.

- [ ] **Step 4: Implement the matcher**

```typescript
// src/lib/exclusion-conflict.ts
import { Prisma } from '@prisma/client';

/**
 * True when `err` is a PostgreSQL 23P01 raised by the exclusion constraint
 * named `constraint`.
 *
 * Matched on the message rather than on `err.code`, because Prisma has no
 * mapped error for an exclusion violation: it arrives as
 * `PrismaClientUnknownRequestError` with `code` and `meta` both `undefined`.
 * That is why this is a separate predicate from `isUniqueConflictOn`
 * (`./unique-conflict`), which gates on `P2002` and cannot see this at all.
 *
 * Both the SQLSTATE and the constraint name are required, so a message that
 * merely quotes a name does not match.
 */
export function isExclusionConflictOn(err: unknown, constraint: string): boolean {
  if (!(err instanceof Prisma.PrismaClientUnknownRequestError)) return false;
  return err.message.includes('23P01')
    && err.message.includes(`exclusion constraint \\"${constraint}\\"`);
}
```

- [ ] **Step 5: Run to green, then prove it can fail in both directions**

```bash
npx vitest run --project unit src/lib/exclusion-conflict.test.ts
```

Expected: 4 passed.

Then mutate `return err.message.includes('23P01') && …` to `return true` —
expected: the three negative cases go red. Mutate to `return false` — expected:
the positive case goes red. Restore and re-run.

A one-directional mutation would leave a matcher that says yes to everything
looking correct. This one is message-shape dependent, so it is exactly the kind
that rots silently when a Prisma upgrade rewords the error.

- [ ] **Step 6: Add the Prisma model**

In `prisma/schema.prisma`, after `StudioClassTemplate`:

```prisma
enum RuleKind {
  regular
  studio
}

/// The calendar identity shared by the two template families (#298).
///
/// Two invisible constraints live on this table and cannot be expressed here:
/// an `EXCLUDE USING gist` over a generated `slot` column, and
/// `UNIQUE (id, kind)`, the parent key for each child's composite foreign key.
/// Both are hand-authored; `docs/lock-order.md` carries the argument.
model ScheduleRule {
  id              String    @id @default(uuid())
  teacherId       String
  kind            RuleKind
  classType       String
  dayOfWeek       Int
  startTime       DateTime  @db.Time
  durationMinutes Int
  isActive        Boolean   @default(true)
  isArchived      Boolean   @default(false)
  archivedAt      DateTime?
  withdrawnCount  Int       @default(0)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  teacher             Teacher              @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  classTemplate       ClassTemplate?
  studioClassTemplate StudioClassTemplate?

  @@index([teacherId, dayOfWeek])
}
```

Add the back-relation to `Teacher`: `scheduleRules ScheduleRule[]`.

- [ ] **Step 7: Write the constraint's failing test**

Create `src/services/schedule-rule-constraints.test.ts`. It belongs to the
`unit` project and talks to the test database directly.

**Copy the fixture block from `src/services/slot-constraints.test.ts:1`–`:92`
verbatim** — `makeTeacher(tag)`, the `suffix` built from `Date.now()`, the
`accountIds` array, the `beforeAll` that creates two teachers plus a `Room` and
a `TeacherRoom` (`capacityOverride` is required and has no default), and the
`afterAll` whose delete order matters: `Account` is removed **after** `Teacher`,
because `Teacher.accountId` has no `onDelete: Cascade`. Do not invent a shared
helpers module; that file has none, and neither should this one.

Then:

```typescript
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';

const EXCL = 'ScheduleRule_teacher_slot_excl';
const at = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

const rule = (teacher: string, over: Record<string, unknown> = {}) => ({
  teacherId: teacher, kind: 'regular' as const, classType: 'Yoga',
  dayOfWeek: 1, startTime: at('19:00'), durationMinutes: 90, ...over,
});

/** Asserts the DATABASE refused, and that it was THIS constraint that did. */
async function expectSlotRefusal(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toSatisfy((e: unknown) => isExclusionConflictOn(e, EXCL));
}

describe('ScheduleRule slot exclusion', () => {
  it('refuses an overlapping rule in the other family', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId) });
    await expectSlotRefusal(() => prisma.scheduleRule.create({
      data: rule(teacherId, { kind: 'studio', startTime: at('19:30'), durationMinutes: 60 }),
    }));
  });

  it('refuses a same-start rule in the other family', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 2 }) });
    await expectSlotRefusal(() => prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 2, kind: 'studio', durationMinutes: 60 }),
    }));
  });

  it('allows a rule starting exactly when the first ends', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 3 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 3, kind: 'studio', startTime: at('20:30'), durationMinutes: 60 }),
    })).resolves.toBeDefined();
  });

  it('allows the same slot on a different weekday', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 4 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 5, startTime: at('19:30') }),
    })).resolves.toBeDefined();
  });

  it('lets an ARCHIVED rule sit on an occupied slot — archiving frees it', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 6 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 6, isArchived: true, archivedAt: new Date(), startTime: at('19:30') }),
    })).resolves.toBeDefined();
  });

  it('does NOT free the slot when a rule is merely PAUSED', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 0, isActive: false }) });
    await expectSlotRefusal(() => prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 0, startTime: at('19:30') }),
    }));
  });

  it('does not block another teacher', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 2, startTime: at('07:00') }) });
    await expect(prisma.scheduleRule.create({
      data: rule(otherTeacherId, { dayOfWeek: 2, startTime: at('07:30') }),
    })).resolves.toBeDefined();
  });

  it('does NOT catch a rule spilling past midnight into the next weekday', async () => {
    // A deliberate blind spot, pinned so it is recorded rather than discovered.
    // A (dayOfWeek, slot) key cannot see Monday 23:30+60 reaching Tuesday
    // 00:30; the ENTRY-level constraint catches it when the two rules
    // generate. Design doc §4.4, "What this does not reach".
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 3, startTime: at('23:30'), durationMinutes: 60 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 4, startTime: at('00:15'), durationMinutes: 30 }),
    })).resolves.toBeDefined();
  });
});
```

Each case uses its own `dayOfWeek` so the cases cannot interfere; there is one
teacher fixture for the whole file, as in `slot-constraints.test.ts`.

- [ ] **Step 8: Run it and watch every case fail**

```bash
npx vitest run --project unit src/services/schedule-rule-constraints.test.ts
```

Expected: all 8 fail — `prisma.scheduleRule` is undefined; neither the table nor
the generated client member exists yet.

- [ ] **Step 9: Create the migration by hand**

```bash
npx prisma migrate dev --create-only --name schedule_rule
```

Keep Prisma's generated `CREATE TYPE "RuleKind"` and `CREATE TABLE
"ScheduleRule"`, and append the parts Prisma cannot express:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Minutes since midnight, so the range is over a built-in type: PostgreSQL has
-- no range type over `time`. EXTRACT on a time value is IMMUTABLE, which is
-- what allows a stored generated column rather than an expression index.
ALTER TABLE "ScheduleRule"
  ADD COLUMN "slot" int4range GENERATED ALWAYS AS (
    int4range(
      (EXTRACT(HOUR FROM "startTime") * 60 + EXTRACT(MINUTE FROM "startTime"))::int,
      (EXTRACT(HOUR FROM "startTime") * 60 + EXTRACT(MINUTE FROM "startTime"))::int
        + "durationMinutes",
      '[)'
    )
  ) STORED;

-- Half-open '[)' so back-to-back teaching stays legal: a rule ending 20:30 and
-- one starting 20:30 do not overlap.
ALTER TABLE "ScheduleRule"
  ADD CONSTRAINT "ScheduleRule_teacher_slot_excl"
  EXCLUDE USING gist ("teacherId" WITH =, "dayOfWeek" WITH =, "slot" WITH &&)
  WHERE ("isArchived" = false);

-- Parent key for each child's composite foreign key. Without it one rule could
-- carry a template of each family, which is the defect being removed.
ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_id_kind_key" UNIQUE ("id", "kind");

ALTER TABLE "ScheduleRule" ADD CONSTRAINT "ScheduleRule_duration_positive"
  CHECK ("durationMinutes" > 0);
```

- [ ] **Step 10: Apply and re-run**

```bash
npx prisma migrate dev
npx vitest run --project unit src/services/schedule-rule-constraints.test.ts
```

Expected: 8 passed.

- [ ] **Step 11: Prove the constraint bites — two mutations, applied as raw SQL**

Never edit the applied migration to mutate it; a comment-only edit already
changes its checksum. Apply mutations to the **test** database directly and
restore with `npx prisma migrate reset` afterwards.

*Mutation A — close the range.* Rebuild the generated column with `'[]'` instead
of `'[)'`. Expected: `allows a rule starting exactly when the first ends` goes
red. Record the exact failure text. Without this, a boundary test that cannot
detect a closed range certifies nothing.

*Mutation B — swap the partial predicate* from `WHERE ("isArchived" = false)` to
`WHERE ("isActive" = true)`. Expected: **both** `lets an ARCHIVED rule sit on an
occupied slot` and `does NOT free the slot when a rule is merely PAUSED` go red.
One mutation must break both, or the archived-frees / paused-holds asymmetry is
not actually pinned — only half of it is.

- [ ] **Step 12: Commit**

```bash
git add prisma/schema.prisma "prisma/migrations/"*_schedule_rule \
        src/lib/exclusion-conflict.ts src/lib/exclusion-conflict.test.ts \
        src/services/schedule-rule-constraints.test.ts
git commit -m "feat: ScheduleRule holds the rule-level slot, as a range not an instant (issue 298)"
```

---

## Task 2: Backfill, and make the two template tables its children

**Files:**
- Create: `prisma/migrations/<timestamp>_schedule_rule_backfill/migration.sql`
- Modify: `prisma/schema.prisma`
- Test: `src/services/schedule-rule-constraints.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `ScheduleRule` from Task 1.
- Produces: `ClassTemplate.scheduleRuleId: string`, `ClassTemplate.kind: RuleKind`
  (pinned `regular`); the same shape on `StudioClassTemplate` (pinned `studio`).
  Both children **lose nine columns**: `teacherId`, `classType`, `dayOfWeek`,
  `startTime`, `durationMinutes`, `isActive`, `isArchived`, `archivedAt`,
  `withdrawnCount`.

**`teacherId` moves too, and that is deliberate.** The census counts it among
the substantive shared fields, and a copy on each child is a value that can
drift from the rule's with nothing enforcing agreement — the exact class of bug
this extraction exists to remove. Ownership checks re-point to
`scheduleRule.teacherId` in Task 3. `ClassTemplate.teacherRoomId` **stays**: the
rented room is economics, not calendar (design §9), and the "this room belongs
to this teacher" check simply compares against `scheduleRule.teacherId` instead.

- [ ] **Step 1: Write the failing test**

Append to `src/services/schedule-rule-constraints.test.ts`:

```typescript
describe('ScheduleRule composite foreign key', () => {
  it('refuses a studio template on a regular rule', async () => {
    const r = await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 5, startTime: at('06:00') }) });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "StudioClassTemplate" ("id","scheduleRuleId","kind","location","hourlyRate","createdAt","updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'studio', 'Probe', 40, now(), now())`,
        r.id,
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('refuses flipping a rule kind while a child is attached', async () => {
    const r = await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 5, startTime: at('06:30') }) });
    // teacherRoomId is required on ClassTemplate and does NOT move to the rule.
    await prisma.classTemplate.create({
      data: {
        scheduleRuleId: r.id, kind: 'regular', teacherRoomId,
        roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ScheduleRule" SET "kind"='studio' WHERE "id"=$1`, r.id),
    ).rejects.toThrow(/foreign key/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --project unit src/services/schedule-rule-constraints.test.ts -t 'composite foreign key'
```

Expected: both fail — `scheduleRuleId` exists on neither child.

- [ ] **Step 3: Write the backfill migration**

```bash
npx prisma migrate dev --create-only --name schedule_rule_backfill
```

**Replace the generated body entirely.** Prisma's default would drop the columns
before the data moves. Hand-author, in this order:

```sql
-- ---------------------------------------------------------------------------
-- Pre-flight, against real rows this time. Design doc §7.2.
-- `prisma db execute` surfaces RAISE EXCEPTION and swallows RAISE NOTICE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  WITH r AS (
    SELECT id, "teacherId", "dayOfWeek" dow, "startTime"::time st, "durationMinutes" dur
      FROM "ClassTemplate" WHERE "isArchived" = false
    UNION ALL
    SELECT id, "teacherId", "dayOfWeek", "startTime"::time, "durationMinutes"
      FROM "StudioClassTemplate" WHERE "isArchived" = false
  ), x AS (
    SELECT *, int4range((EXTRACT(HOUR FROM st)*60 + EXTRACT(MINUTE FROM st))::int,
                        (EXTRACT(HOUR FROM st)*60 + EXTRACT(MINUTE FROM st))::int + dur,
                        '[)') slot FROM r
  )
  SELECT count(*) INTO n
    FROM x a JOIN x b ON a."teacherId" = b."teacherId" AND a.dow = b.dow
                     AND a.id < b.id AND a.slot && b.slot;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing to install ScheduleRule: % overlapping live template pair(s). Resolve them before migrating.', n;
  END IF;
END $$;

-- 1. One rule per template. The id is preserved so children link by it.
INSERT INTO "ScheduleRule" ("id","teacherId","kind","classType","dayOfWeek","startTime",
                            "durationMinutes","isActive","isArchived","archivedAt",
                            "withdrawnCount","createdAt","updatedAt")
SELECT "id","teacherId",'regular',"classType","dayOfWeek","startTime"::time,
       "durationMinutes","isActive","isArchived","archivedAt",
       "withdrawnCount","createdAt","updatedAt"
  FROM "ClassTemplate";

INSERT INTO "ScheduleRule" ("id","teacherId","kind","classType","dayOfWeek","startTime",
                            "durationMinutes","isActive","isArchived","archivedAt",
                            "withdrawnCount","createdAt","updatedAt")
SELECT "id","teacherId",'studio',"classType","dayOfWeek","startTime"::time,
       "durationMinutes","isActive","isArchived","archivedAt",
       "withdrawnCount","createdAt","updatedAt"
  FROM "StudioClassTemplate";

-- 2. Link each child to its rule; the ids match by construction above.
ALTER TABLE "ClassTemplate"       ADD COLUMN "scheduleRuleId" TEXT, ADD COLUMN "kind" "RuleKind";
ALTER TABLE "StudioClassTemplate" ADD COLUMN "scheduleRuleId" TEXT, ADD COLUMN "kind" "RuleKind";
UPDATE "ClassTemplate"       SET "scheduleRuleId" = "id", "kind" = 'regular';
UPDATE "StudioClassTemplate" SET "scheduleRuleId" = "id", "kind" = 'studio';
ALTER TABLE "ClassTemplate"       ALTER COLUMN "scheduleRuleId" SET NOT NULL, ALTER COLUMN "kind" SET NOT NULL;
ALTER TABLE "StudioClassTemplate" ALTER COLUMN "scheduleRuleId" SET NOT NULL, ALTER COLUMN "kind" SET NOT NULL;

-- 3. Pin each child's kind to its own literal, THEN attach by (id, kind). The
--    CHECK is what makes the composite FK mean "regular children hang off
--    regular rules"; without it the pair would merely have to agree.
ALTER TABLE "ClassTemplate"       ADD CONSTRAINT "ClassTemplate_kind_check" CHECK ("kind" = 'regular');
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_kind_check" CHECK ("kind" = 'studio');

ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_rule_fkey"
  FOREIGN KEY ("scheduleRuleId","kind") REFERENCES "ScheduleRule"("id","kind") ON DELETE CASCADE;
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_rule_fkey"
  FOREIGN KEY ("scheduleRuleId","kind") REFERENCES "ScheduleRule"("id","kind") ON DELETE CASCADE;

ALTER TABLE "ClassTemplate"       ADD CONSTRAINT "ClassTemplate_rule_unique" UNIQUE ("scheduleRuleId");
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_rule_unique" UNIQUE ("scheduleRuleId");

-- 4. Only now drop the moved columns. Nine per table.
ALTER TABLE "ClassTemplate"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "dayOfWeek",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "isActive",
  DROP COLUMN "isArchived", DROP COLUMN "archivedAt", DROP COLUMN "withdrawnCount";
ALTER TABLE "StudioClassTemplate"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "dayOfWeek",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "isActive",
  DROP COLUMN "isArchived", DROP COLUMN "archivedAt", DROP COLUMN "withdrawnCount";
```

**Order is load-bearing.** Block 4 must follow block 1, or the data is gone
before it is copied. Block 3's `CHECK` must precede its FK, or a child could
attach to a rule of the other kind in the window between.

- [ ] **Step 4: Update the Prisma schema to match**

Remove the nine moved fields (and the `teacher` relation) from both template
models; add to each:

```prisma
  scheduleRuleId String       @unique
  kind           RuleKind
  scheduleRule   ScheduleRule @relation(fields: [scheduleRuleId, kind], references: [id, kind], onDelete: Cascade)
```

Remove `classTemplates` / `studioClassTemplates` from `Teacher` if they become
unreferenced; the teacher reaches both through `scheduleRules`.

- [ ] **Step 5: Apply, regenerate, run**

```bash
npx prisma migrate dev && npx prisma generate
npx vitest run --project unit src/services/schedule-rule-constraints.test.ts
```

Expected: the two new cases pass. **Everything else in the repo now fails to
compile.** That is Task 3, and it is the intended state.

- [ ] **Step 6: Verify the backfill lost nothing**

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga -c "
  SELECT (SELECT count(*) FROM \"ScheduleRule\" WHERE kind='regular') AS rules_regular,
         (SELECT count(*) FROM \"ClassTemplate\")                     AS class_templates,
         (SELECT count(*) FROM \"ScheduleRule\" WHERE kind='studio')  AS rules_studio,
         (SELECT count(*) FROM \"StudioClassTemplate\")               AS studio_templates;"
```

Expected: `rules_regular = class_templates` and `rules_studio =
studio_templates`, exactly. Any drift means a row was lost — stop and diagnose;
it is unrecoverable once block 4 has run.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma "prisma/migrations/"*_schedule_rule_backfill \
        src/services/schedule-rule-constraints.test.ts
git commit -m "feat: the two template families become children of one rule (issue 298)"
```

---

## Task 3: Make the codebase compile again

**Files:** enumerated by the compiler, not by hand. Expect ~29 non-test and ~24
test files (measured 2026-08-24; re-derive rather than trust).

**Interfaces:**
- Consumes: Task 2's schema.
- Produces: a green `npx tsc --noEmit` and a green suite.

This task is mechanical and compiler-driven. It is one task because no
intermediate state is independently reviewable: the branch does not build until
it is finished.

- [ ] **Step 1: Enumerate the work**

```bash
npx tsc --noEmit 2>&1 | grep -oE "^[^(]+" | sort -u | tee /tmp/repoint-files.txt | wc -l
```

Keep that file. Step 6 reconciles against it — deriving the post-fix sweep from
the actual diff rather than from a keyword is what §4 of the solve-issue skill
exists to enforce.

- [ ] **Step 2: Apply the read transformation**

Every read of a moved field goes through the rule. Worked example, from
`src/lib/template-selection.ts`:

```typescript
// before
export const ACTIVE_TEMPLATE_WHERE = { isActive: true, isArchived: false } as const;

// after — the flags are on the rule now
export const ACTIVE_TEMPLATE_WHERE = {
  scheduleRule: { isActive: true, isArchived: false },
} as const;
```

And from `src/services/studio-class-generator.ts`, where the template's own slot
fields are read:

```typescript
// before
const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)

// after
const dates = getNextOccurrences(template.scheduleRule.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
```

Every `select`/`include` that named a moved field must now nest it:
`select: { dayOfWeek: true }` becomes
`select: { scheduleRule: { select: { dayOfWeek: true } } }`.

- [ ] **Step 3: Convert `startTime` at the Prisma boundary only**

`ScheduleRule.startTime` is `DateTime @db.Time`; Prisma returns a `Date` whose
date part is `1970-01-01`. **The wire format stays `"HH:MM"`** (design §6) — the
API surface, the Zod schemas and every component keep the string. Add to
`src/lib/time-of-day.ts` (new, import-free so client components may use it):

```typescript
/** `Date` from a `@db.Time` column → the `"HH:MM"` every wire format uses. */
export function timeToHHmm(t: Date): string {
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

/** `"HH:MM"` → the `Date` a `@db.Time` column accepts. Caller validates with `timeHHmm`. */
export function hhmmToTime(s: string): Date {
  return new Date(`1970-01-01T${s}:00Z`);
}
```

UTC accessors, not local ones: a `@db.Time` value has no zone, and `getHours()`
would shift it by the runtime's offset. This is the same trap
`client-components-ssr-in-utc` records from the other direction.

- [ ] **Step 4: Re-point ownership through the rule**

`teacherId` left both children in Task 2, so every ownership filter and every
`teacher` traversal changes shape. This is the largest single class of edit in
this task and the compiler finds all of it, but the transformation is uniform:

```typescript
// before — a filter on the child
await db.classTemplate.findMany({ where: { teacherId, isArchived: false } });

// after — the child has neither field; both are on the rule
await db.classTemplate.findMany({
  where: { scheduleRule: { teacherId, isArchived: false } },
});
```

Two consequences worth handling deliberately rather than discovering:

- **`ClassTemplate.teacherRoomId` stayed.** The check that a room belongs to the
  template's owner now compares the room's `teacherId` against
  `template.scheduleRule.teacherId`. Confirm every such comparison re-points;
  a comparison left against a now-absent field would not compile, but one
  rewritten to compare the room against *itself* would.
- **Test teardown can shrink.** `ClassTemplate` and `StudioClassTemplate` are
  `onDelete: Cascade` from `ScheduleRule`, so deleting a teacher's rules removes
  both families' templates. Existing `afterAll` blocks that call
  `classTemplate.deleteMany({ where: { teacherId } })` must change regardless —
  prefer deleting the rules and letting the cascade run, rather than nesting the
  filter.

- [ ] **Step 5: Run the typecheck to green**

```bash
npx tsc --noEmit
```

Expected: no output. Iterate until it is silent.

- [ ] **Step 6: Run the whole suite**

```bash
npm run verify
```

Expected: 146 files, 1875 tests, all passing — the same numbers as the baseline.
This task changes no behaviour, so **any** count change is a defect to diagnose,
not a number to update.

- [ ] **Step 7: Reconcile the diff against the enumeration**

```bash
git diff --name-only | sort -u > /tmp/repoint-changed.txt
comm -23 /tmp/repoint-files.txt /tmp/repoint-changed.txt
```

Expected: empty, or every remaining line explained. A file the compiler flagged
and the diff did not touch means an error was silenced rather than fixed.

- [ ] **Step 8: Commit**

```bash
git add $(cat /tmp/repoint-changed.txt | tr '\n' ' ')
git commit -m "refactor: every template read reaches its slot through the rule (issue 298)"
```

---

## Task 4: A slot conflict answers 409, not 500

**Files:**
- Modify: `src/lib/api-errors.ts`, and the four template routes
  (`src/app/api/class-templates/route.ts`,
  `src/app/api/class-templates/[id]/route.ts`,
  `src/app/api/studio-class-templates/route.ts`,
  `src/app/api/studio-class-templates/[id]/route.ts`)
- Test: `tests/integration/class-templates-api.test.ts`,
  `tests/integration/studio-api.test.ts`

**Interfaces:**
- Consumes: `isExclusionConflictOn` (Task 1) and Task 3's compiling tree.
- Produces: nothing new.

**Why this task exists.** `isUniqueConflictOn`
(`src/lib/unique-conflict.ts:34`) gates on `err.code === 'P2002'`, Prisma's
mapping of SQLSTATE 23505. The exclusion constraint raises **23P01**, which
Prisma surfaces with `code` and `meta` both `undefined` — so the existing 409
branches stop matching and every template slot conflict falls through to a 500.
That is the shape of #301, and Task 1's matcher exists to close it.

- [ ] **Step 1: Write the failing integration cases**

In `tests/integration/class-templates-api.test.ts`, following the file's
existing auth and fixture helpers:

```typescript
it('answers 409 when a new template OVERLAPS a studio template', async () => {
  // 19:00 +90 studio, then 19:30 +60 regular. Legal today — this is the
  // behaviour change the extraction introduces (design §2.2f).
  await createStudioTemplate({ dayOfWeek: 2, startTime: '19:00', durationMinutes: 90 });
  const res = await post('/api/class-templates', {
    ...templateBody, dayOfWeek: 2, startTime: '19:30', durationMinutes: 60,
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toMatch(/studio/i);
});

it('still answers 409 on an exact-start collision', async () => {
  await createStudioTemplate({ dayOfWeek: 3, startTime: '19:00', durationMinutes: 60 });
  const res = await post('/api/class-templates', {
    ...templateBody, dayOfWeek: 3, startTime: '19:00', durationMinutes: 60,
  });
  expect(res.status).toBe(409);
});
```

Add the mirror pair to `tests/integration/studio-api.test.ts` (studio template
overlapping a regular one).

- [ ] **Step 2: Run them and watch them fail with 500**

```bash
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```

Expected: FAIL — `expected 500 to be 409`. **A 409 here means the branch is
already matching and this task is unnecessary; stop and re-derive.** Warm the
route first with one `curl`: `next dev` compiles lazily and a first-request
timeout reads exactly like an assertion failure.

- [ ] **Step 3: Add the branch to each of the four routes**

Beside the existing slot-conflict branch. Worked example, from the class
template POST:

```typescript
} catch (err) {
  if (
    isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime']) ||
    isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')
  ) {
    return NextResponse.json(
      { error: 'You already have a class or studio class at an overlapping time on that day.' },
      { status: 409 },
    );
  }
  throw err;
}
```

The `isUniqueConflictOn` arm stays for now: it still covers
`ClassTemplate_rule_unique` and any other declared key on the write. Only the
slot key changed mechanism.

- [ ] **Step 4: Add the classifier arm**

In `src/lib/api-errors.ts`, in `classifyApiError`, beside the `P2002` branch at
`:391`, add an arm mapping a `ScheduleRule_teacher_slot_excl` violation to 409.
This is the backstop for the four routes plus anything that reaches
`withErrorHandler` without its own branch — the gap #301 names.

- [ ] **Step 5: Run to green**

```bash
npx vitest run --project integration tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts
```

Expected: all pass, including the two pre-existing exact-start cases.

- [ ] **Step 6: Prove each route's branch is load-bearing**

Comment out the `isExclusionConflictOn` arm in the class-template POST only.
Expected: that route's overlap case returns 500 and goes red, while the other
three routes stay green. Restore.

Repeat per route. A single mutation that reddens all four would mean the
classifier is doing the work and the route branches are dead code — which is
worth knowing either way, and is the finding if it happens.

- [ ] **Step 7: Commit**

```bash
npm run verify
git add src/lib/api-errors.ts \
        "src/app/api/class-templates/route.ts" "src/app/api/class-templates/[id]/route.ts" \
        "src/app/api/studio-class-templates/route.ts" "src/app/api/studio-class-templates/[id]/route.ts" \
        tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts
git commit -m "fix: an overlapping rule answers 409, not the 500 an unmapped 23P01 gives (issue 298)"
```

---

## Task 5: Delete the guards the constraint replaces

**Files:**
- Create: `prisma/migrations/<timestamp>_drop_template_slot_guards/migration.sql`
- Modify: `src/services/slot-constraints.test.ts`

**Interfaces:** consumes Task 4; produces nothing new.

- [ ] **Step 1: Write the migration**

```sql
-- The four template-level triggers and two functions from
-- 20260821120000_cross_family_slot_guard, and the two partial unique indexes
-- from 20260811202634. All four are subsumed by
-- ScheduleRule_teacher_slot_excl, which is strictly stronger: range rather
-- than instant, and cross-family by construction rather than by trigger.
--
-- The four CLASS-level triggers in that migration are deliberately left
-- standing — they belong to the entry layer, which is a separate plan.

DROP TRIGGER IF EXISTS class_template_cross_family_slot_insert_guard ON "ClassTemplate";
DROP TRIGGER IF EXISTS class_template_cross_family_slot_update_guard ON "ClassTemplate";
DROP TRIGGER IF EXISTS studio_class_template_cross_family_slot_insert_guard ON "StudioClassTemplate";
DROP TRIGGER IF EXISTS studio_class_template_cross_family_slot_update_guard ON "StudioClassTemplate";
DROP FUNCTION IF EXISTS class_template_reject_cross_family_slot();
DROP FUNCTION IF EXISTS studio_class_template_reject_cross_family_slot();

DROP INDEX IF EXISTS "ClassTemplate_teacher_slot_unique";
DROP INDEX IF EXISTS "StudioClassTemplate_teacher_slot_unique";
```

- [ ] **Step 2: Apply and run the constraint tests**

```bash
npx prisma migrate dev
npx vitest run --project unit src/services/schedule-rule-constraints.test.ts
```

Expected: still 10 passed. If a case now passes only because a *trigger* was
enforcing it, this is where that shows.

- [ ] **Step 3: Prove the exclusion constraint is now the sole enforcement**

Drop it in the test database and confirm the constraint tests go red:

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
  -c 'ALTER TABLE "ScheduleRule" DROP CONSTRAINT "ScheduleRule_teacher_slot_excl";'
npx vitest run --project unit src/services/schedule-rule-constraints.test.ts
```

Expected: the five refusal cases fail. Restore by re-running
`npx prisma migrate reset` on the test database. Without this step the branch
could ship a constraint nothing depends on.

- [ ] **Step 4: Port the template half of `slot-constraints.test.ts`**

**Verify these line references before acting on them** — they were measured on
2026-08-24 and Tasks 1–4 do not touch this file, but a rebase might. Confirm each
`describe` opens where stated, and correct the reference if it has moved.

Delete `ClassTemplate_teacher_slot_unique` (`:148`–`:170`),
`StudioClassTemplate_teacher_slot_unique` (`:171`–`:201`) and
`cross-family template slot exclusivity (#296)` (`:495`–end of that describe).
Their coverage now lives in `schedule-rule-constraints.test.ts`, with the
cross-family and same-family cases merged, because the distinction no longer
exists.

**Delete without porting:** the template half of *"leaves a pre-existing
violating pair editable on unrelated columns"*. An exclusion constraint cannot
be added over a violating pair and `NOT VALID` is refused outright, so the state
that case constructs is unconstructible (design §7.2).

**Leave untouched:** `Room identity indexes` (`:202`–`:251`) and every
`Class`/`StudioClass` case. They share the file, not the subject.

- [ ] **Step 5: Run and commit**

```bash
npm run verify
git add "prisma/migrations/"*_drop_template_slot_guards src/services/slot-constraints.test.ts
git commit -m "refactor: four template triggers and two indexes give way to one constraint (issue 298)"
```

---

## Task 6: Documentation, and the claims this branch falsifies

**Files:**
- Modify: `docs/lock-order.md`, `CLAUDE.md`, `docs/data-model.md`,
  `prisma/schema.prisma` (docblocks)

- [ ] **Step 1: `docs/lock-order.md`**

The section *"The cross-family slot guard reads, and does not lock (#296)"*
describes eight triggers. Four are now gone. Rewrite it to describe the four
that remain (the class-level half), state that the template half became an
index-backed constraint, and keep the reopen condition for the remaining half.

Also update its `FOR UPDATE OF` census if this branch changed any lock site — it
should not have, but the file ships the command that re-derives it, so run it.

- [ ] **Step 2: `CLAUDE.md`**

The *Class Lifecycle* bullet beginning **"One teacher, one slot, across both
families (#296)"** says the rule is "enforced by eight triggers rather than an
index". Rewrite: the template half is now one exclusion constraint on
`ScheduleRule`, range-based rather than exact-start; the class half is still four
triggers. Name the two `Data Model` consequences: `ScheduleRule` exists, and the
two template tables hold only economics.

**Do not write a count of triggers in a source comment** — CLAUDE.md and
`docs/` own counts; comments do not.

- [ ] **Step 3: `docs/data-model.md`**

Add `ScheduleRule`; remove the nine moved fields from both template entries,
and note that a template now reaches its teacher through its rule.

- [ ] **Step 4: Verify no stale claim survives**

```bash
grep -rn "eight triggers\|ClassTemplate_teacher_slot_unique\|StudioClassTemplate_teacher_slot_unique" \
  CLAUDE.md docs/ src/ prisma/schema.prisma | grep -v "prisma/migrations/"
```

Every remaining hit must be either inside an applied migration (immutable, leave
it) or corrected. A claim fixed in one artifact and left standing in its twin is
this project's most-repeated defect (`.claude/skills/solve-issue` §4).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/lock-order.md docs/data-model.md prisma/schema.prisma
git commit -m "docs: the template slot is a range on one table now (issue 298)"
```

---

## Stop conditions

Stop and report rather than working around, if:

1. **Either overlap query returns a row** (Task 1 Step 1, Task 2 Step 3). The
   resolution is a decision about those rows, not a weaker constraint.
2. **The backfill parity check does not reconcile** (Task 2 Step 6). A lost
   template is unrecoverable once the source columns are dropped.
3. **A mutation comes back GREEN** where the plan predicts RED (Tasks 1, 4, 5).
   A guard that cannot fail certifies nothing. Warm the routes first — `next dev`
   compiles lazily and the first request can blow a 5s timeout, which reads
   exactly like an assertion failure.
4. **The test count changes during Task 3.** That task changes no behaviour.

## What the PR body must record

- The measured baseline and the after-figures, per project, with totals that
  reconcile.
- The six corrections in design §2.2 — which recorded claims were checked, which
  held, and which did not.
- The mutation results: what was broken, the exact error text, that it was
  restored and re-verified.
- What this PR does **not** do: the entry layer, the triad merge, the
  `SkipReason` rename. **#297 and #298 are unaffected by this PR's merge** —
  they are closed by the decision, not by this code. (Never write the
  auto-close keyword next to a bare `#N`; see the hazard list.)
- Which suites ran. `npm run verify` runs all three vitest projects, so a green
  verify **is** the whole integration suite — state it with the arithmetic that
  proves it.
