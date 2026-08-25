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
16, vitest (**four** projects: `unit`, `unit-sweeps`, `components`,
`integration` — #321 split `unit` on 2026-08-24), `btree_gist`.

**Spec:** `docs/superpowers/specs/2026-08-24-calendar-entry-extraction-design.md`
(§4.6 was added with this amendment).

**Amended 2026-08-25, before execution**, after re-verifying the premise against
`fairyoga-db-1`. The issue's four measured claims all held exactly — the
rule-layer and entry-layer overlap pre-flights, `withdrawnCount` NULL on 11/11
and 1/1, and `pg_depend`'s 10 column dependencies. Four things in *this
document* did not:

1. The baseline table described three vitest projects; #321 made it four.
2. `btree_gist` is installed in `ethical_yoga_test` and **not** in
   `ethical_yoga` — a manual artifact of the design's own measurement session,
   which makes Task 1's `CREATE EXTENSION` load-bearing rather than defensive.
3. `ClassTemplate_rule_unique`, cited to justify keeping the `isUniqueConflictOn`
   arm, does not exist — in the repo or the database.
4. Task 4 was scoped to two route catch blocks. The conflict-detection layer is
   **31 sites across four non-test files**, and changes mechanism without
   changing a single type, so Task 3's compiler-driven enumeration is blind to
   all of it. Task 4 is rewritten around that; Task 3's exit criteria and stop
   condition 4 change with it.

The rule-layer pre-flight's zero is also **confirmed vacuous**: of six live
rules only teacher `f4f7d978` holds two, on different weekdays, so the overlap
predicate has never had a candidate pair. Seed a deliberate overlap before
trusting a clean run.

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

## Measured baseline (re-measured 2026-08-25, on `main` at `3565eee`)

| Project | Files | Tests |
|---|---|---|
| `unit` | 58 | 946 |
| `unit-sweeps` | 10 | 122 |
| `components` | 45 | 296 |
| `integration` | 33 | 513 |
| **Total** | **146** | **1877** |

`58 + 10 + 45 + 33 = 146`. `946 + 122 + 296 + 513 = 1877`. All passing.

The same run reports `103 + 43 = 146` files and `1242 + 635 = 1877` tests,
because `npm test` is now **two** `vitest run` invocations
(`unit`+`components`, then `unit-sweeps`+`integration`) — the totals reconcile
across both partitions.

**This table replaces the one written 2026-08-24, which was stale in structure
and not only in count.** #321 landed between the two measurements and split
`unit` into `unit` + `unit-sweeps` (`vitest.config.ts`'s `SWEEP_TESTS`), so the
project set went from three to four. The split moved no tests —
`58 + 10 = 68` and `946 + 122 = 1068` reconcile exactly against the old single
`unit` row. The real drift is `components`, 294 → 296.

**Re-measure again at execution time rather than trusting even this.** On #212 a
predicted after-figure was wrong by two because that branch's own review added
tests the prediction could not have known about — and the correction above is
the same lesson from the other direction, one day later.

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
| `prisma/migrations/<ts>_schedule_rule_backfill/migration.sql` | One rule per live template; add + populate `scheduleRuleId`/`kind` on both children; composite FK; drop the four template triggers and two functions; drop the nine moved columns from each child |
| `src/services/schedule-rule-constraints.test.ts` | The exclusion constraint's mutation table (§4.4), driven through Prisma |
| `src/lib/exclusion-conflict.ts` | Detect a 23P01 for a named constraint; `isUniqueConflictOn`'s sibling |
| `src/lib/exclusion-conflict.test.ts` | Its tests, including one that proves the matcher can fail |
| `src/lib/rule-slot-holder.ts` | Probe `ScheduleRule` for which family holds a refused slot — the discriminator the single constraint no longer carries (Task 4) |
| `src/lib/rule-slot-holder.test.ts` | Its eight cases and three mutations |
| `src/lib/time-of-day.ts` | `@db.Time` ↔ `"HH:MM"` at the Prisma boundary (Task 3 Step 3); import-free so client components may use it |

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
  `withdrawnCount: number | null`. The generated `slot` column is **not** in the
  Prisma **client** — nothing in TypeScript can read or write it — but it IS
  declared on the model as `slot Unsupported("int4range")? @default(dbgenerated())`.
  Both halves are load-bearing. `Unsupported` fields are omitted from the
  generated client, which is the "never written" guarantee. Declaring it at all
  is what stops `prisma migrate dev` reading the column as drift and offering
  `ALTER TABLE "ScheduleRule" DROP COLUMN "slot"` — which cascade-drops the
  exclusion constraint. Measured 2026-08-25: only the optional +
  `dbgenerated()` form diffs clean; a bare `Unsupported("int4range")?` still
  wants `DROP DEFAULT` and the non-null form still wants `SET NOT NULL`.

**`withdrawnCount` is nullable, and that is not a nullability oversight.** Both
children declare it `Int?` (`schema.prisma:379`, `:529`) and **every live row is
NULL** — 11 of 11 `ClassTemplate` and 1 of 1 `StudioClassTemplate` — because only
an archive ever writes it. A `NOT NULL` column here would abort the backfill on
the first row. `COALESCE(…, 0)` is the wrong fix: `archivedAt`'s docblock
(`schema.prisma:348`–`:358`) establishes that `isArchived: true` with both
columns null is reachable today — `gdpr.ts`'s bulk archive writes neither — and
must stay distinguishable from a recorded zero. Read it as "the archive that
recorded itself", never as "is it archived".

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
  withdrawnCount  Int?
  /// The generated occupancy range. Declared so `prisma migrate dev` does not
  /// read it as drift; `Unsupported` keeps it out of the generated client, so
  /// it can be neither read nor written from TypeScript.
  slot            Unsupported("int4range")? @default(dbgenerated())
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  teacher             Teacher              @relation(fields: [teacherId], references: [id], onDelete: Cascade)
  classTemplate       ClassTemplate?
  studioClassTemplate StudioClassTemplate?

  @@unique([id, kind])
  @@index([teacherId, dayOfWeek])
}
```

**`@@unique([id, kind])` is required, not decorative.** Prisma will not validate
`references: [id, kind]` on the children's composite relation (Task 2) unless the
referenced pair is a unique constraint it knows about. Declaring it here also
means Prisma emits `ScheduleRule_id_kind_key` itself, so the hand-authored
section below must **not** create it a second time.

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

**That copied teardown has a shelf life of one task.** Its two lines
`prisma.classTemplate.deleteMany({ where: { teacherId … } })` and its studio
twin stop type-checking the moment Task 2 moves `teacherId` off both children.
Task 2 Step 5 rewrites them; copy it verbatim now anyway, so this task's
failures are about the constraint rather than about a fixture you improvised.

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

Cases are isolated by holding a distinct `(dayOfWeek, slot)` pair, not by
holding a distinct `dayOfWeek` — with eight cases and seven weekdays, one
weekday each is arithmetically impossible, so a case that shares a weekday
must separate on the range instead. Two do share `dayOfWeek: 2` and sit at
~19:00 and ~07:00. There is one teacher fixture for the whole file, as in
`slot-constraints.test.ts`.

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
"ScheduleRule"`, and append the parts Prisma cannot express.

**The `CREATE EXTENSION` line below is load-bearing — do not drop it as
redundant.** Measured 2026-08-25: `btree_gist` is installed in
`ethical_yoga_test` and **not** in `ethical_yoga`, and no migration creates it
anywhere —

```
grep -rln "btree_gist\|CREATE EXTENSION" prisma/migrations/     # no matches
```

— so the one in the test database is a manual artifact left by the design
document's own measurement session. Anyone reasoning "the constraint built
cleanly when §4.4 measured it, so the extension must be present" would be
reading the wrong database. `yoga` is superuser on this server (`usesuper = t`),
so the statement succeeds; on a host where it is not, this is the line that
fails, and it should fail loudly.

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

-- `ScheduleRule_id_kind_key` — the parent key for each child's composite
-- foreign key, without which one rule could carry a template of each family —
-- is emitted by Prisma from `@@unique([id, kind])`. Do not add it here.

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
restore with the scoped INVERSE of the exact SQL that made the mutation.
**`npx prisma migrate reset` is not available here** — Prisma's own agent
safety guard refuses a whole-database wipe without freshly-given human
consent, which a subagent has no channel to obtain. That is a feature, not
an obstacle: an inverse touches only what the mutation touched, where a
reset would destroy the dev fixtures too. Verify each restore by reading the
constraint definition back out of `pg_constraint`, then re-running the suite.

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
-- Explicit, rather than relying on the runner. Prisma wraps migration.sql in a
-- transaction, but `psql` in autocommit and `prisma db execute` do not — and
-- under those, a failure between blocks 1 and 4 leaves the schema half-moved.
-- The file's own guarantee should not depend on who executes it.
BEGIN;

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

-- Names and ON UPDATE follow Prisma's own conventions, so `prisma migrate dev`
-- does not read this as drift and offer a corrective migration: every one of
-- the generated foreign keys in prisma/migrations/ is `<Table>_<field…>_fkey`
-- with ON UPDATE CASCADE, and every generated unique is `<Table>_<field>_key`.
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_scheduleRuleId_kind_fkey"
  FOREIGN KEY ("scheduleRuleId","kind") REFERENCES "ScheduleRule"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_scheduleRuleId_kind_fkey"
  FOREIGN KEY ("scheduleRuleId","kind") REFERENCES "ScheduleRule"("id","kind")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClassTemplate"       ADD CONSTRAINT "ClassTemplate_scheduleRuleId_key" UNIQUE ("scheduleRuleId");
ALTER TABLE "StudioClassTemplate" ADD CONSTRAINT "StudioClassTemplate_scheduleRuleId_key" UNIQUE ("scheduleRuleId");

-- 4. The four #296 template triggers HOLD four of the columns block 5 drops.
--    PostgreSQL records a column dependency for every column a trigger's WHEN
--    clause names, so the drops below fail without this:
--
--      ERROR: cannot drop column teacherId of table "ClassTemplate" because
--             other objects depend on it
--
--    Measured: 10 dependencies across the four triggers, on teacherId,
--    dayOfWeek, startTime and isArchived. Not `DROP … CASCADE`, which removes
--    the triggers and leaves the two functions behind as broken orphans.
--
--    The exclusion constraint on ScheduleRule has enforced this invariant
--    since the previous migration, so nothing is unguarded in between.
DROP TRIGGER IF EXISTS class_template_cross_family_slot_insert_guard ON "ClassTemplate";
DROP TRIGGER IF EXISTS class_template_cross_family_slot_update_guard ON "ClassTemplate";
DROP TRIGGER IF EXISTS studio_class_template_cross_family_slot_insert_guard ON "StudioClassTemplate";
DROP TRIGGER IF EXISTS studio_class_template_cross_family_slot_update_guard ON "StudioClassTemplate";
DROP FUNCTION IF EXISTS class_template_reject_cross_family_slot();
DROP FUNCTION IF EXISTS studio_class_template_reject_cross_family_slot();

-- 5. Only now drop the moved columns. Nine per table. The two partial unique
--    indexes from 20260811202634 are over columns dropped here, so PostgreSQL
--    removes them silently as a consequence — there is no DROP INDEX to write.
ALTER TABLE "ClassTemplate"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "dayOfWeek",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "isActive",
  DROP COLUMN "isArchived", DROP COLUMN "archivedAt", DROP COLUMN "withdrawnCount";
ALTER TABLE "StudioClassTemplate"
  DROP COLUMN "teacherId", DROP COLUMN "classType", DROP COLUMN "dayOfWeek",
  DROP COLUMN "startTime", DROP COLUMN "durationMinutes", DROP COLUMN "isActive",
  DROP COLUMN "isArchived", DROP COLUMN "archivedAt", DROP COLUMN "withdrawnCount";

COMMIT;
```

**Order is load-bearing, in two places and not a third.**

- **Block 5 must follow block 1**, or the data is gone before it is copied.
  Reversing them fails loudly rather than quietly — PostgreSQL refuses to
  resolve the `SELECT` list against the `INSERT` target with
  `42703 … there is a column named "teacherId" in table "ScheduleRule", but it
  cannot be referenced from this part of the query` — so the reversal cannot
  backfill garbage. Inside the transaction it rolls back with no loss.
- **Block 4 must precede block 5**, for the column-dependency reason stated
  above. This is the ordering that actually bites: without it the migration
  cannot run at all.
- **Block 3's `CHECK`-before-FK ordering does *not* protect a window.** An
  earlier draft claimed a child could attach to a rule of the other kind
  between the two statements. Measured: in autocommit the window is real but
  self-correcting — the hostile row inserts and the migration then aborts on
  `check constraint … is violated by some row`, losing nothing. Inside the
  transaction this file now declares, the window does not exist at all: a
  concurrent writer blocks on the FK's `ShareRowExclusiveLock` and meets the
  `CHECK` on release. Keep the order — it is the right one to write, and it is
  what makes a statement-by-statement replay safe — but do not defend it with a
  hazard the execution model precludes.

**A regression this migration was predicted to cause, and does not.**
`ClassTemplate` loses its direct `teacherId → Teacher ON DELETE CASCADE` along
with the column, so a `Teacher` hard-delete reaches it one hop further out, via
`Teacher → ScheduleRule → ClassTemplate`. An earlier draft of this plan
predicted that `TeacherRoom`'s `ON DELETE RESTRICT` would therefore fire first:

```
PREDICTED:  DELETE FROM "Teacher" WHERE id='…';
ERROR:  update or delete on table "TeacherRoom" violates foreign key constraint
        "ClassTemplate_teacherRoomId_fkey" on table "ClassTemplate"
```

**Measured post-migration, in a rolled-back transaction against a from-scratch
fixture: the delete succeeds cleanly, no error, all four rows gone.**
PostgreSQL defers a `NOT DEFERRABLE` foreign-key check to the end of the
enclosing *statement*, not to the moment each cascading row action runs. One
`DELETE FROM "Teacher"` fires both cascades in that statement, and by the time
`ClassTemplate_teacherRoomId_fkey`'s RESTRICT check runs, the `ClassTemplate`
row it would have blocked on is already gone via the sibling path.

**And the same timing rule applies before the migration**, where the sibling
path is the direct `teacherId` cascade rather than the one through
`ScheduleRule` — so this is very likely not a behaviour change at all, merely
a longer path to the same end-of-statement state. That half is *reasoned, not
measured*: measuring it needs a checkout of `main`. Anyone who needs certainty
should measure it rather than inherit this sentence.

Production is unaffected either way — `gdpr.ts` anonymises rather than
hard-deletes.

**The teardown ordering is still required, and for a different reason than the
one above.** A test teardown deletes as *separate statements*, and
end-of-statement timing gives no help across statement boundaries: a
`teacherRoom.deleteMany` issued while a `ClassTemplate` row still stands is
refused by RESTRICT. So `scheduleRule.deleteMany` must precede it. Task 6
records the measured behaviour, not the prediction.

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

**`prisma migrate dev` is only safe here because `ScheduleRule.slot` is declared
`Unsupported("int4range")? @default(dbgenerated())` on the model.** Without that
line Prisma reads the generated column as drift and offers a corrective
migration whose body is `ALTER TABLE "ScheduleRule" DROP COLUMN "slot"` —
measured, read-only, on 2026-08-25. `slot` carries
`ScheduleRule_teacher_slot_excl`, so accepting that prompt cascade-drops this
branch's entire invariant. If `migrate dev` ever offers to name a corrective
migration on this branch, **decline it** and re-derive the drift first:

```bash
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
  --to-schema-datamodel prisma/schema.prisma --script
# expected: "This is an empty migration."
```

Expected: the two new cases pass — **after** you rewrite this file's own
teardown, which Task 1 copied verbatim from `slot-constraints.test.ts` and which
this task has just broken. `teacherId` no longer exists on either child, so:

```typescript
// before — copied from slot-constraints.test.ts:70-71
await prisma.classTemplate.deleteMany({ where: { teacherId: { in: teachers } } });
await prisma.studioClassTemplate.deleteMany({ where: { teacherId: { in: teachers } } });

// after — delete the rules and let ON DELETE CASCADE take both children.
// This MUST precede teacherRoom.deleteMany: ClassTemplate_teacherRoomId_fkey
// is ON DELETE RESTRICT and a surviving template blocks the room.
await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: teachers } } });
```

Everything **else** in the repo now fails to compile. That is Task 3, and it is
the intended state — but this file is the exception the previous sentence used
to swallow, and it is the one file this task claims still passes.

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

**Files: 33, measured against Task 2's actual end state** (`f06913e`,
2026-08-25) — 662 errors over 16 non-test and 17 test files:

```bash
npx tsc --noEmit 2>&1 | grep -oE "^[^(]+\.tsx?" | sort -u
```

That replaces this plan's earlier estimate of ~29 non-test and ~24 test files,
which was written before the schema change existed. Two entries the plan's own
"Modified" list never named are in it: `prisma/seed.ts` and
`tests/room-fixtures.ts`, plus three `tests/e2e/*.spec.ts`. Three entries it
predicted are not: only `template-list.tsx`, `studio-template-list.tsx` and
`studio-template-list.test.tsx` appear from the settings surface, not "six
settings pages and four settings components".

Re-derive it anyway rather than trusting the number — it moves as the task
progresses, and it is the enumeration Step 7 reconciles against.

**Interfaces:**
- Consumes: Task 2's schema.
- Produces: a green `npx tsc --noEmit`, and a suite red **only** in the
  conflict-vocabulary files Task 4 then fixes.

It is one task because no intermediate state is independently reviewable: the
branch does not build until it is finished.

**Most of it is mechanical and compiler-driven. Two parts are not, and both
were added mid-execution because the original text said otherwise.** Step 4b
rebuilds the write-authorization pins across the table split — a design change
where the compiler flags the breakage and every obvious repair is wrong, one of
them by silently removing a security check. And the conflict-detection layer
below is invisible to the compiler entirely. Neither is a re-point.

**The compiler does not enumerate all of this task's blast radius, and the gap
is Task 4's whole subject.** Task 2 drops two partial unique indexes and four
triggers. Every error-matcher that names one of those objects keeps compiling
and starts always returning `false`:

- `isUniqueConflictOn(err, ['teacherId','dayOfWeek','startTime'])` names the two
  dropped indexes. Its signature is `(err: unknown, columns: readonly string[])`
  — string literals, so no type error.
- `isCrossFamilySlotConflict(err)` matches SQLSTATE `YG001`, which only triggers
  raise. It stays live for the **entry** layer (those four triggers survive) and
  goes dead for the template layer.

Measured 2026-08-25: **31 occurrences of the two `slot_conflict` /
`cross_family_slot_conflict` reason strings across 4 non-test files** —
`class-template-lifecycle.ts` (12), `studio-class-template-lifecycle.ts` (11),
`class-templates/[id]/route.ts` (4), `studio-class-templates/[id]/route.ts` (4)
— plus 8 across 3 test files. **`npx tsc --noEmit` flags none of them.**

```
grep -rn "slot_conflict" src/ tests/ | awk -F: '{print $1}' | sort | uniq -c
```

So **do not chase the resulting red tests in this task.** Re-point reads and
ownership here; leave every conflict-detection branch exactly as it is. Task 4
owns them, and it owns them as a design change rather than a re-point.

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

- [ ] **Step 4b: Rebuild the write-authorization pins across the table split**

**This step is not mechanical, and the compiler's guidance here is actively
misleading.** Both lifecycle services carry a compile-time apparatus that
partitions every writable column into an allowlist (`TeacherEditable*Field` —
what a teacher may change through a plain `PUT`) and a forbidden list
(`PlainUpdateForbidden*Field` — what only a guarded path may write). Six pins
per family hold that partition, and the write itself is typed
`… & Partial<Record<PlainUpdateForbidden*Field, never>>`.

Task 2 splits the model those lists partition. Measured on `main` @ `3565eee`:

| Pin | What it asserts | After Task 2 |
|---|---|---|
| `_templateUpdateColumnsExist` | wire-schema keys ⊆ child's update input | **breaks** — `classType`, `dayOfWeek`, `startTime`, `durationMinutes` left the child |
| `_templateForbiddenColumnsExist` | forbidden names ⊆ child's update input | **breaks** — `teacherId`, `isActive`, `isArchived`, `archivedAt`, `withdrawnCount` left the child |
| `_studioTemplateListsPartitionTheModel` | child's update input ⊆ allowlist ∪ forbidden | **breaks** — the new `scheduleRuleId` and `kind` are in neither list |
| `_templateFieldsArePermitted`, `_templateAllowlistHasNoStaleFields`, `_templateAllowlistHasNoForbiddenFields`, `_templateForbiddenListIsComplete` | literal-vs-literal | unaffected, and therefore **no help** |

Five of the eight forbidden names move to `ScheduleRule`, `isActive` among
them — the one its own docblock calls the entry that matters most, because it
is what stops a `PUT` flipping a template active and bypassing the
transaction-and-generate path `PATCH` owns.

**Three reflexive repairs make the compiler green and are all wrong:**

1. *Delete the moved names from the allowlist.* Compiles. A teacher can then
   no longer edit their own schedule at all — the feature dies silently, and
   only an integration test would notice.
2. *Delete the moved names from the forbidden list.* Compiles, and **removes
   the protection outright.** Those five columns become writable through
   whatever rule-update the plain `PUT` now issues, with nothing pinning them.
   This is the #79 reflexive-grant failure the forbidden list's own docblock
   warns about, arriving from a direction that docblock did not anticipate:
   not "paste the name into the allowlist" but "delete it from the deny list
   because it is no longer a column *here*."
3. *Add `scheduleRuleId` and `kind` to the allowlist* to satisfy the partition
   pin. Compiles. A teacher can then re-parent their template onto another
   rule by id — including, via the composite foreign key, a rule they do not
   own. That is an ownership hole, not a formatting fix.

**The correct repair: the partition now spans two models, so it needs two sets
of lists and two sets of pins.**

- Keep the child's lists, reduced to the columns that stayed. `scheduleRuleId`
  and `kind` join the **forbidden** side — they are identity, exactly like `id`.
- Add rule-level `TeacherEditableScheduleRuleField` /
  `PlainUpdateForbiddenScheduleRuleField`, and mirror all six pins against
  `keyof Prisma.ScheduleRuleUncheckedUpdateManyInput`. `classType`,
  `dayOfWeek`, `startTime`, `durationMinutes` go on the allowlist;
  `id`, `teacherId`, `kind`, `isActive`, `isArchived`, `archivedAt`,
  `withdrawnCount`, `createdAt`, `updatedAt` on the forbidden side.
- Type the rule-update the same way the child-update is typed:
  `… & Partial<Record<PlainUpdateForbiddenScheduleRuleField, never>>`.

**Prove each new pin can fail, one mutation each** (the plan's Global
Constraints require it, and these pins are the reason):

- add `'publishedAt'` to the rule's forbidden list → only
  `_scheduleRuleForbiddenColumnsExist` reddens (the measurement the studio
  file's own docblock records for its twin)
- add `'isActive'` to the rule's **allowlist** → the no-forbidden-on-allowlist
  pin reddens
- remove `'dayOfWeek'` from the rule's allowlist → the partition pin reddens
- write `{ isActive: true }` into the rule-update data at the call site → the
  `Partial<Record<…, never>>` intersection reddens

Record the exact error text for each. A pin that compiles but cannot fail
certifies nothing, and this apparatus is six-sevenths of the write
authorization on these two routes.

**If this step turns out to need design judgment beyond the above — report it
rather than guessing.** Re-establishing an invariant across a table split is
the one part of Task 3 that is not a re-point, and it was added to this plan
mid-execution precisely because the original text called the whole task
mechanical.

- [ ] **Step 4c: Re-point the two generator claims' SQL — the read the compiler cannot see**

`claimTemplateForGeneration` (`class-generator.ts`) and
`claimStudioTemplateForGeneration` (`studio-class-generator.ts`) each hold a raw
statement whose predicate reads two columns that left the child in Task 2:

```sql
SELECT "id" FROM "ClassTemplate"
 WHERE "id" = $1 AND "isActive" = true AND "isArchived" = false
 FOR UPDATE
```

It is a template literal, so `tsc` says nothing and it fails at runtime with
`42703 column "isActive" does not exist`. **Eleven files call these two
functions**, so leaving them broken floods this task's exit criterion with
failures that have nothing to do with re-pointing:

```bash
grep -rn "claimTemplateForGeneration\|claimStudioTemplateForGeneration" src/ \
  | awk -F: '{print $1}' | sort -u
```

Re-point the predicate through the rule, and lock the child only:

```sql
SELECT ct."id" FROM "ClassTemplate" ct
  JOIN "ScheduleRule" sr ON sr."id" = ct."scheduleRuleId"
 WHERE ct."id" = $1
   AND sr."isActive" = true
   AND sr."isArchived" = false
 FOR UPDATE OF ct
```

**`FOR UPDATE OF ct`, never a bare `FOR UPDATE`** on a joined query — a bare one
locks both relations and silently introduces the cross-table ordering question
Task 3c exists to avoid. `docs/lock-order.md:249` states the same rule for the
`Class` join.

**This is the read half only. The lock CONVENTION is Task 3c** — the six write
paths that must take the child's lock before writing the rule, the NOWAIT probe
tests, the mutations and `docs/lock-order.md`. Between this step and that task
the claim locks the child while the archive does not, so the two do not
serialize. That gap is deliberate and measured: Task 3c Step 2 writes the test
that observes it failing, which is the only chance to see it.

- [ ] **Step 5: Run the typecheck to green**

```bash
npx tsc --noEmit
```

Expected: no output. Iterate until it is silent.

- [ ] **Step 6: Run the whole suite, and expect a bounded red**

```bash
npm run verify 2>&1 | tee /tmp/task3-verify.log
grep -E "^ *(FAIL|×)" /tmp/task3-verify.log | sort -u > /tmp/task3-red.txt
```

Expected: `npx tsc --noEmit` silent, and **failures confined to the
conflict-vocabulary set** — the 8 assertions in
`src/services/studio-class-template-lifecycle.test.ts` (4),
`src/services/template-lock-order.test.ts` (1) and
`tests/integration/class-templates-api.test.ts` (3), plus anything reaching a
500 where a 409 was asserted.

An earlier draft of this plan expected **green** here, on the grounds that this
task changes no behaviour. That was wrong for one reason and right in spirit:
re-pointing reads changes nothing, but Task 2 already removed the objects the
conflict branches matched on, so those branches are dead before this task
starts. The failures are Task 4's input, not this task's defect.

**Every red line must be in that set.** A failure outside it *is* a defect in
this task's re-pointing — diagnose it here rather than carrying it forward. Keep
`/tmp/task3-red.txt`; Task 4 Step 7 reconciles against it.

File and test *counts* must still be `146` / `1877`. This task adds and removes
no tests, so a count change is a defect either way.

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

## Task 3c: The child row stops being locked for free

**Files:**
- Modify: `src/services/class-generator.ts`, `src/services/studio-class-generator.ts`,
  `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts`
- Test: `src/services/template-lock-order.test.ts` (extend), and the claim-vs-archive
  interleavings already in `class-generator.test.ts` / `studio-class-generator.test.ts`
- Doc: `docs/lock-order.md` (its plain-`FOR UPDATE` census section)

**Interfaces:** consumes Task 3's compiling tree; produces no new exports.

### Why this task exists — it was not in the original plan

`claimTemplateForGeneration`'s `FOR UPDATE` does **three** jobs, and Task 2
lands them on two different tables. Measured from its own docblock
(`class-generator.ts:549-613`):

| # | Job | Needs locked, after the split |
|---|---|---|
| A | serialize against `archiveOrUnarchiveTemplate`'s CAS — that `updateMany` takes `FOR NO KEY UPDATE`, which conflicts (`:551-556`) | the **rule** — every column that CAS writes moves |
| B | block a concurrent `Class` insert, whose FK check takes `FOR KEY SHARE` on the template row — measured on #164, both directions (`:592-596`) | the **child** — `Class.templateId` still references `ClassTemplate.id` |
| C | hold the economics authoritative for generation (#102, `:598-613`) | the **child** — the economics stay there |

Postgres row locks are per-table. A child-only lock does not conflict with a
rule-only `updateMany`, and the composite FK does not bridge them: archiving
touches neither `id` nor `kind`, so no re-check fires on the child. Left alone,
the claim becomes — in the analysis's words — *structurally equivalent to the
plain re-read its own docblock forbids, just spelled as a `FOR UPDATE` on the
wrong table.*

**And it is not only the archive.** Measured: `pauseOrResumeTemplate`'s CAS
writes only `isActive`; `archiveOrUnarchiveTemplate` writes `isArchived`,
`isActive`, `archivedAt`, `withdrawnCount` across two statements. Every one of
those columns moves. `updateClassTemplate` becomes a two-table write
(`classType`/`dayOfWeek`/`startTime`/`durationMinutes` on the rule, the
economics on the child) — and it takes **no explicit lock at all today**,
relying on its own plain `UPDATE` to lock the row implicitly. That implicit lock
now covers the wrong table for four of its columns, and the generator reads
exactly those four to compute candidate dates.

### The decision: the child stays the only lock node

Taken with the maintainer, 2026-08-25. **Every writer of a rule's lifecycle or
calendar columns takes the child row's `FOR UPDATE` as its first statement.**
The claim joins the rule for the predicate and locks the child only:

```sql
-- the claim: predicate from the rule, lock on the child
SELECT ct."id" FROM "ClassTemplate" ct
  JOIN "ScheduleRule" sr ON sr."id" = ct."scheduleRuleId"
 WHERE ct."id" = $1
   AND sr."isActive" = true
   AND sr."isArchived" = false
 FOR UPDATE OF ct;
```

```sql
-- every rule writer, first statement, before touching ScheduleRule
SELECT "id" FROM "ClassTemplate" WHERE "id" = $1 FOR UPDATE;
```

Read of the rule under that lock is then safe, because every writer of those
columns must hold the same child lock to reach them.

**Rejected: lock both rows.** It adds `ScheduleRule` as a node to an ordering
`docs/lock-order.md` twice declines to extend for lesser reasons (`:752-755`),
with a named AB-BA against `updateClassTemplate`, in a codebase already carrying
one open unfixed `ClassTemplate`-vs-`Class` ordering violation (#229,
`docs/lock-order.md:1221-1254`).

**Rejected: narrow the extraction.** The constraint's `WHERE isArchived = false`
needs that column on the rule, so the rule would need its own copy of the
lifecycle flags — the two-sources-of-truth drift this extraction exists to
remove.

**`FOR UPDATE OF ct` is required, never a bare `FOR UPDATE`** on the joined
query — a bare one locks both relations and silently reintroduces the ordering
question this decision exists to avoid. `docs/lock-order.md:249` states the same
rule for the `Class` join.

- [ ] **Step 1: Re-derive the census before editing**

```bash
grep -rn "FOR UPDATE" src/ --include='*.ts' | grep -v "\.test\.ts:" | grep -vE ":[0-9]+: *(\*|//)"
```

`docs/lock-order.md:191-198` says this returns four hits today: the two claim
sites, plus `lockClassRow`/`lockClassRowsOrdered` in `db-locks.ts`. Confirm
that, and record what it returns after this task — the count is the doc's
enforcement mechanism, so it must be re-stated there rather than left stale.

- [ ] **Step 2: Write the failing test FIRST — prove the claim serializes**

Extend `src/services/template-lock-order.test.ts`. The invariant under test is
not a deadlock; it is **mutual exclusion**: an archive in flight must block the
claim, and vice versa. Use the `FOR UPDATE NOWAIT` probe pattern from
`db-locks.test.ts:477-499`, which proves *which rows are actually locked*
rather than asserting that a string was sent.

Two cases per family:

1. With `archiveOrUnarchiveTemplate`'s transaction open past its first
   statement, a third connection's `SELECT … FROM "ClassTemplate" WHERE id=$1
   FOR UPDATE NOWAIT` must fail with `55P03` / `could not obtain lock`. That is
   the proof the archive holds the child row.
2. With `claimTemplateForGeneration`'s transaction open, the same probe must
   fail the same way.

Run them before the implementation. Case 1 must FAIL initially — after Task 2
the archive writes only `ScheduleRule` and holds no child lock at all. Record
that failure: it is the direct evidence that the gap this task closes was real,
and it is the only chance to observe it.

- [ ] **Step 3: Add the child lock to the six write paths**

`pauseOrResumeTemplate`, `archiveOrUnarchiveTemplate`, `updateClassTemplate`
and their three studio twins. First statement in each transaction, after
`setLockTimeout`, before any `ScheduleRule` write.

`updateClassTemplate` is the one with no lock today — its docblock must say
plainly that the lock became explicit because the columns it guards moved, not
that a lock was added for a new reason. State what is true now; the
before-and-after goes in the PR body (CLAUDE.md, *Comment Discipline*).

- [ ] **Step 4: Verify Task 3 re-pointed both claims, and that it locked only the child**

Task 3 Step 4c already re-pointed the two claim statements, because eleven
files call them and leaving them broken would have swamped that task's exit
criterion. Confirm here rather than redo:

- each claim joins `ScheduleRule` for the `isActive`/`isArchived` predicate
- each ends `FOR UPDATE OF ct` — **a bare `FOR UPDATE` is a defect**, because on
  a joined query it locks both relations and reintroduces the cross-table
  ordering this task's decision exists to avoid
- the `SELECT` list still returns only the child's `id`, so the caller's
  `findUniqueOrThrow` still runs under the lock rather than beside it

If any of those is wrong, fix it here and say so — a bare `FOR UPDATE` would
make Step 2's tests pass for the wrong reason, and no test in this file can
tell the difference.

- [ ] **Step 5: Prove each lock is load-bearing — one mutation per path**

Remove the child lock from `archiveOrUnarchiveTemplate` only. Expected: Step 2's
case 1 reddens for the class family while the studio family stays green. Restore.
Repeat per path. A mutation that reddens nothing means the probe is not
observing what it claims to.

Then mutate the claim's `FOR UPDATE OF ct` to a bare `FOR UPDATE` and record
what changes — it should still pass Step 2 (both rows are locked, which is a
superset) and that is exactly why a passing test is not sufficient here. Note
the result; the reason for `OF ct` is ordering, not exclusion, and no test in
this file can see it.

- [ ] **Step 6: `deleteTeacherAccount`'s bulk archive — decide and report**

`gdpr.ts` bulk-archives every template of an erased teacher with an
`updateMany` that writes `isArchived` and nothing else. After the split that
`updateMany` targets `ScheduleRule`, so the same gap applies to it.

Two defensible answers: take the child locks ordered by `id` first, mirroring
`lockClassRowsOrdered`'s discipline; or document why the erasure path does not
need to serialize against the generator (it runs after the account is gone, so
there may be no live sweep to race). **Do not guess — measure whether a sweep
can be in flight during erasure, and report which answer the evidence supports.**
This step may legitimately end in a `known-open` comment beside the code rather
than a lock.

- [ ] **Step 7: `docs/lock-order.md`**

Re-state the plain-`FOR UPDATE` census with what Step 1 measured, and add the
convention as a named rule: the child row is the lock node for the template
families; a rule's lifecycle and calendar columns are only ever written under
it. Say plainly that this is a convention enforced by a grep and a test, not by
the database — the same standing `lockClassRowsOrdered` has — and ship the grep
that re-derives it, as that file already does for `FOR UPDATE OF`.

Also correct Task 6 Step 1's prediction: this branch **did** change a lock site,
two of them, and added a convention.

- [ ] **Step 8: Commit**

```bash
npm run verify
git add src/services/class-generator.ts src/services/studio-class-generator.ts \
        src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts \
        src/services/template-lock-order.test.ts docs/lock-order.md
git commit -m "fix: the child row stops being locked for free (issue 298)"
```

---

## Task 4: One constraint, one refusal — and a probe that still names the family

**Files:**
- Create: `src/lib/rule-slot-holder.ts`, `src/lib/rule-slot-holder.test.ts`
- Modify: `src/lib/api-errors.ts`; both template lifecycle services; the four
  template routes
- Test: `tests/integration/class-templates-api.test.ts`,
  `tests/integration/studio-api.test.ts`,
  `src/services/studio-class-template-lifecycle.test.ts`,
  `src/services/template-lock-order.test.ts`

**Interfaces:**
- Consumes: `isExclusionConflictOn` (Task 1), Task 3's compiling tree.
- Produces: `RuleSlotHolder = 'regular' | 'studio' | 'unknown'` and
  `ruleSlotHolder(db, probe): Promise<RuleSlotHolder>`; a `heldBy` field on the
  four template services' `slot_conflict` failure.

### Why this task is a design change and not a re-point

`isUniqueConflictOn(err, ['teacherId','dayOfWeek','startTime'])` gates on
`P2002`, Prisma's mapping of `23505`, raised by the two partial unique indexes
Task 2 drops. `isCrossFamilySlotConflict(err)` matches `YG001`, raised by the
four template triggers Task 2 drops. **Both die with the objects they name, and
neither stops compiling.** One `ScheduleRule_teacher_slot_excl` now raises
`23P01` for what were two distinct refusals, and a `23P01` cannot say which
family holds the slot: PostgreSQL's `DETAIL` names the conflicting key values,
never the conflicting row's `kind`.

Left alone, every template slot conflict falls through to `throw err` and a 500.
That is #301's shape, one layer deeper than Task 1's matcher reaches.

### The measured collapse: four codes, two sentences, one discriminator

The four template-layer refusals as they stand today (2026-08-25):

| Route | Code | Sentence | Holder |
|---|---|---|---|
| class POST + PUT + archive | `DUPLICATE_TEMPLATE_SLOT` | "You already have a recurring class on that day at that time." | `regular` |
| class POST + PUT + archive | `CROSS_FAMILY_STUDIO_TEMPLATE_SLOT` | "You already have a recurring studio class on that day at that time." | `studio` |
| studio POST + PUT + archive | `DUPLICATE_STUDIO_TEMPLATE_SLOT` | "You already have a recurring studio class on that day at that time." | `studio` |
| studio POST + PUT + archive | `CROSS_FAMILY_CLASS_TEMPLATE_SLOT` | "You already have a recurring class on that day at that time." | `regular` |

**The sentence is a pure function of the holder's kind, not of the writer's.**
Rows 1 and 4 are the same sentence; so are rows 2 and 3. What today's code
derives from *which database object raised*, this task derives from *one probe
of `ScheduleRule`* — so all four codes and both sentences survive unchanged in
meaning, and only the mechanism moves.

**Two codes are NOT in scope and must keep their branch.**
`CROSS_FAMILY_STUDIO_SLOT` ("You already have a studio class on one of those
dates at that time.") and `CROSS_FAMILY_CLASS_SLOT` are the `conflict.level ===
'instance'` arms of the two POST routes: a *generated `Class`* colliding with a
`StudioClass`, caught by the four **entry-level** triggers, which this branch
does not touch. `isCrossFamilySlotConflict` stays imported and stays live in
both POST routes for exactly this arm. Deleting it is a regression, not a
cleanup.

**Only the POST routes generate.** `updateTemplate` writes no `Class` row at all
(#194 deleted the sync) and `archiveOrUnarchiveTemplate` only withdraws them, so
neither can raise an entry-level `YG001` — which is why their
`cross_family_slot_conflict` branches are wholly template-level and wholly
replaced here.

### The probe, and the one fact that makes it legal

```typescript
// src/lib/rule-slot-holder.ts
import type { PrismaClient } from '@prisma/client';

/**
 * Which family's rule occupies a slot, asked after `ScheduleRule_teacher_slot_excl`
 * has already refused a write.
 *
 * `'unknown'` is not an error path: the refusing rule can be archived between the
 * failed write and this probe, and a refusal that names the wrong half of a
 * teacher's schedule is worse than one that names neither.
 */
export type RuleSlotHolder = 'regular' | 'studio' | 'unknown';

export async function ruleSlotHolder(
  db: PrismaClient,
  probe: {
    teacherId: string;
    dayOfWeek: number;
    startMinutes: number;
    durationMinutes: number;
    /** The row being updated, which conflicts with itself otherwise. */
    excludeRuleId?: string;
  },
): Promise<RuleSlotHolder> { /* … */ }
```

The query reads the **generated `slot` column itself**, not a re-derivation of
it, so it cannot disagree with the constraint about what a slot *is*:

```sql
SELECT "kind"::text AS kind FROM "ScheduleRule"
 WHERE "teacherId" = $1 AND "dayOfWeek" = $2 AND "isArchived" = false
   AND "slot" && int4range($3, $3 + $4, '[)')
   AND ($5::text IS NULL OR "id" <> $5::text)
 LIMIT 1;
```

`$queryRaw` is required rather than preferred: `slot` is a generated column and
is deliberately absent from the Prisma model (Task 1), so no Prisma `where` can
reach it.

**The `'[)'` is duplicated from the constraint, and that duplication is the one
thing here that can silently drift.** Step 5's boundary mutation is what holds
it; do not skip it on the grounds that the constraint is already tested.

**Why a fresh query in a `catch` is safe.** A statement that fails inside a
PostgreSQL transaction aborts it — every later command gets `25P02`, so a probe
issued on `tx` would fail rather than answer. It is safe here because **every
one of the six catch blocks sits outside its own `$transaction` call**, so
Prisma has already rolled back and `db` is a clean connection. Verified
2026-08-25 at all six:

```
grep -n 'await db.\$transaction\|^\s*} catch (err' \
  src/services/class-template-lifecycle.ts \
  src/services/studio-class-template-lifecycle.ts \
  src/app/api/class-templates/route.ts \
  src/app/api/studio-class-templates/route.ts
```

Each `catch` line follows its transaction's closing `)`. **Pass `db`, never
`tx`.** If a future refactor moves a catch inside a transaction, this probe is
the thing that breaks, and it breaks as `25P02`, not as a wrong answer.

- [ ] **Step 1: The probe's failing test**

`src/lib/rule-slot-holder.test.ts`, in the `unit` project, against the test
database — same fixture shape as `schedule-rule-constraints.test.ts`. Cases:

1. a live `regular` rule overlapping the probe → `'regular'`
2. a live `studio` rule overlapping the probe → `'studio'`
3. an **archived** rule overlapping the probe → `'unknown'` (archiving frees it)
4. a **paused** (`isActive: false`) rule overlapping → its kind, not `'unknown'`
5. a rule ending exactly at the probe's start → `'unknown'` (half-open)
6. a rule on a different `dayOfWeek` → `'unknown'`
7. another teacher's overlapping rule → `'unknown'`
8. `excludeRuleId` naming the only overlapping rule → `'unknown'`

Run; expect `Cannot find module './rule-slot-holder'`.

- [ ] **Step 2: Implement, run to green, then mutate**

Three mutations, each with an expected single-case verdict:

- *Drop `AND "isArchived" = false`* → case 3 goes red. Without it the probe
  disagrees with the constraint about which rules occupy a slot.
- *`'[)'` → `'[]'`* → case 5 goes red. This is the duplication guard.
- *Drop the `excludeRuleId` clause* → case 8 goes red. Without it every PUT that
  moves a rule reports the rule as its own blocker.

Record the exact failure text for each, restore, re-verify.

- [ ] **Step 3: Add `heldBy` to the four services' failure**

In `class-template-lifecycle.ts` (`:344`/`:352` and `:1049`/`:1057`) and
`studio-class-template-lifecycle.ts` (`:302`/`:309` and `:659`/`:666`) —
**verify these line references before editing; Task 3 has already moved this
file** — change the two union members to one:

```typescript
// before
| { ok: false; reason: 'slot_conflict' }
| { ok: false; reason: 'cross_family_slot_conflict' }

// after — one constraint, one reason, and the discriminator the DB no longer carries
| { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
```

and in each of the four `catch` blocks replace **both** the `isUniqueConflictOn`
and the `isCrossFamilySlotConflict` branch with one:

```typescript
if (isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')) {
  const heldBy = await ruleSlotHolder(db, { … , excludeRuleId: ruleId });
  log.warn({ err, templateId, teacherId, heldBy }, 'recurring class edit refused: that slot is taken');
  return { ok: false, reason: 'slot_conflict', heldBy };
}
```

Keep the `log.warn`. Its existing docblock gives the reason — a returned failure
never reaches `withErrorHandler`, so catching here is what would otherwise
remove the server-side record — and `heldBy` is now the field that makes the two
cases greppable, replacing the two distinct reasons that did it before.

- [ ] **Step 4: Re-point the routes, with a compiler tether on the copy**

In each of the four routes, replace the paired `slot_conflict` /
`cross_family_slot_conflict` branches with one branch keyed on `heldBy`. Each
route knows its own family, so each carries its own map — and the map is
`satisfies`-tethered, the house pattern (`COUNT_KEYS`,
`ROOM_SEARCH_SELECT`; CLAUDE.md, *Comment Discipline*):

```typescript
// src/app/api/class-templates/[id]/route.ts
const SLOT_TAKEN = {
  regular: ['You already have a recurring class at an overlapping time on that day.', 'DUPLICATE_TEMPLATE_SLOT'],
  studio:  ['You already have a recurring studio class at an overlapping time on that day.', 'CROSS_FAMILY_STUDIO_TEMPLATE_SLOT'],
  unknown: ['You already have a recurring class or studio class at an overlapping time on that day.', 'TEMPLATE_SLOT_CONFLICT'],
} as const satisfies Record<RuleSlotHolder, readonly [string, string]>;

if (result.reason === 'slot_conflict') {
  const [message, code] = SLOT_TAKEN[result.heldBy];
  return respondError(message, 409, code);
}
```

The studio routes mirror it with `DUPLICATE_STUDIO_TEMPLATE_SLOT` /
`CROSS_FAMILY_CLASS_TEMPLATE_SLOT` / `STUDIO_TEMPLATE_SLOT_CONFLICT`.

**All four existing codes are preserved deliberately**, so integration
assertions that name them keep their meaning. **The sentences change**, and that
is the copy half of this issue's scope: "at that time" described an exact-start
index and is now false — the constraint refuses `19:00 +90` against
`19:30 +60`, where no two times are equal. Every sentence must say *overlapping*.

`satisfies Record<RuleSlotHolder, …>` is not decoration: a fourth holder state
must not be addable without every route being forced to word it. Prove it —
add `'deleted'` to `RuleSlotHolder`, confirm all four routes fail to compile,
remove it.

- [ ] **Step 5: The POST routes keep their instance arm**

In both POST routes the `isCrossFamilySlotConflict` branch stays, reduced to its
`conflict.level === 'instance'` arm only — `CROSS_FAMILY_STUDIO_SLOT` /
`CROSS_FAMILY_CLASS_SLOT`. Its `'untagged'` (template) arm is what the new
`isExclusionConflictOn` branch replaces.

**`conflict.level`'s union may now be a one-member type.** If `'untagged'` is no
longer reachable, say so by deleting it rather than leaving a comparison that
cannot be false — the exact defect its own comment records from PR #300's fourth
pass, where `'template'` survived in prose after leaving the union. Check
whether anything still assigns it before deciding.

- [ ] **Step 6: Add the classifier backstop**

In `src/lib/api-errors.ts`, in `classifyApiError`, beside the `P2002` branch at
`:391`, map a `ScheduleRule_teacher_slot_excl` violation to 409. This covers
anything reaching `withErrorHandler` without its own branch — the gap #301
names. It cannot name a family (it has no probe and no teacher context), so it
carries the `unknown` sentence.

- [ ] **Step 7: Reconcile against Task 3's red list, then run everything**

```bash
npm run verify
comm -23 /tmp/task3-red.txt <(grep -E "^ *(FAIL|×)" /tmp/task4-verify.log | sort -u)
```

Every line Task 3 recorded as red must now be green, and nothing new may be red.
**Reconcile against that file, not against a grep for one phrase** — a
keyword sweep scoped to one finding cannot see another finding's twin
(`.claude/skills/solve-issue` §4).

Test counts will change here, unlike Task 3: this task adds
`rule-slot-holder.test.ts` (8 cases) and the overlap cases below, and removes
none. Record the delta and its arithmetic.

- [ ] **Step 8: The behaviour change, proved reachable from the API**

The overlap refusal is new — `19:00 +90` against `19:30 +60` is legal today.
In `tests/integration/class-templates-api.test.ts`:

```typescript
it('answers 409 naming the studio family when a new template OVERLAPS a studio template', async () => {
  await createStudioTemplate({ dayOfWeek: 2, startTime: '19:00', durationMinutes: 90 });
  const res = await post('/api/class-templates', {
    ...templateBody, dayOfWeek: 2, startTime: '19:30', durationMinutes: 60,
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('CROSS_FAMILY_STUDIO_TEMPLATE_SLOT');
});

it('still answers 409 on an exact-start collision', async () => { /* unchanged behaviour */ });
```

Plus the mirror pair in `tests/integration/studio-api.test.ts`, and one PUT case
per family so the `[id]` routes are covered rather than only the POSTs.

**Warm each route file with one `curl` first.** `next dev` compiles lazily and a
first-request timeout reads exactly like an assertion failure; `PUT
/api/class-templates/[id]` and `POST /api/class-templates` are different files
and compile separately.

- [ ] **Step 9: Prove each route's branch is load-bearing**

Comment out the `slot_conflict` branch in the class-template PUT only. Expected:
that route's overlap case 500s and goes red while the other three stay green.
Restore. Repeat per route.

A single mutation reddening all four would mean the Step 6 classifier is doing
the work and the route branches are dead — worth knowing either way, and it is
the finding if it happens.

- [ ] **Step 10: Commit**

```bash
npm run verify
git add src/lib/rule-slot-holder.ts src/lib/rule-slot-holder.test.ts \
        src/lib/api-errors.ts \
        src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts \
        src/services/studio-class-template-lifecycle.test.ts src/services/template-lock-order.test.ts \
        "src/app/api/class-templates/route.ts" "src/app/api/class-templates/[id]/route.ts" \
        "src/app/api/studio-class-templates/route.ts" "src/app/api/studio-class-templates/[id]/route.ts" \
        tests/integration/class-templates-api.test.ts tests/integration/studio-api.test.ts
git commit -m "fix: one constraint refuses the slot, and a probe still names the family (issue 298)"
```

---

## Task 5: Prove the constraint is the sole enforcement, and port the tests

**Files:**
- Modify: `src/services/slot-constraints.test.ts`

**Interfaces:** consumes Task 4; produces nothing new.

**This task has no migration.** An earlier draft gave it one — dropping the four
template triggers, two functions and two partial unique indexes. All of that now
happens inside Task 2, and not by preference: PostgreSQL records a column
dependency for every column a trigger's `WHEN` clause names, so Task 2's column
drops **cannot run** while the triggers stand. The two indexes then disappear on
their own, because they are indexes over dropped columns. There is nothing left
here to drop, and a `DROP INDEX IF EXISTS` at this point would match nothing
while reading like it did something.

- [ ] **Step 1: Prove the exclusion constraint is now the sole enforcement**

The triggers are gone. If any constraint test still passes because something
*else* was enforcing it, this is where that shows. Drop the constraint in the
test database and confirm the refusals go red:

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
  -c 'ALTER TABLE "ScheduleRule" DROP CONSTRAINT "ScheduleRule_teacher_slot_excl";'
npx vitest run --project unit src/services/schedule-rule-constraints.test.ts
```

Expected: **the three exclusion-refusal cases fail** — `refuses an overlapping
rule in the other family`, `refuses a same-start rule in the other family`, and
`does NOT free the slot when a rule is merely PAUSED` — while the **five
acceptance cases still pass**, and so do Task 2's **two composite-FK refusals**,
which are a different constraint and must not move.

Task 1 Step 7 writes eight cases, of which three are refusals, not five; Task 2
appends two more refusals that this mutation cannot reach. If more than three
go red, something other than the exclusion constraint was holding a case that
was supposed to be its own — which is exactly what this step exists to find.
Restore by re-adding the constraint with the exact DDL from the migration
file — `npx prisma migrate reset` is refused by Prisma's agent consent gate
(measured on Task 1), and an inverse is less destructive anyway. Confirm the
restore by reading `pg_constraint` back, not by assuming the `ALTER` worked.

Without this step the branch could ship a constraint nothing depends on — which
is exactly what the four now-deleted triggers were doing for the same invariant
in the window between Task 2 and Task 4.

- [ ] **Step 2: Port the template half of `slot-constraints.test.ts`**

**Verify these line references before acting on them** — they were measured on
2026-08-24 and Tasks 1–4 do not touch this file, but a rebase might. Confirm each
`describe` opens where stated, and correct the reference if it has moved.

Delete `ClassTemplate_teacher_slot_unique` (`:148`–`:170`),
`StudioClassTemplate_teacher_slot_unique` (`:171`–`:201`) and the template half
of `cross-family template slot exclusivity (#296)` (`:495` onward). Their
coverage now lives in `schedule-rule-constraints.test.ts`, with the cross-family
and same-family cases merged, because the distinction no longer exists.

**Delete without porting: the two template-level "leaves a pre-existing
violating pair editable on unrelated columns" cases** (`:684`, `:708`). An
exclusion constraint cannot be added over a violating pair and `NOT VALID` is
refused outright, so the state they construct is unconstructible (design §7.2).
Their two instance-level siblings (`:310`, `:461`) stay — the `Class` family is
still trigger-guarded until the entry-layer plan lands.

**Leave untouched:** `Room identity indexes` (`:202`–`:251`) and every
`Class`/`StudioClass` case. They share the file, not the subject.

- [ ] **Step 3: Fix the teardown this file shares with the fixture**

`slot-constraints.test.ts:70`–`:71` delete templates by `teacherId`, which no
longer exists on either child. Same fix as `schedule-rule-constraints.test.ts`
took in Task 2 Step 5: delete the `ScheduleRule` rows and let the cascade take
both children, **before** `teacherRoom.deleteMany`.

If Task 3 already fixed this to keep the build green, confirm it took the
cascade form rather than a nested `where: { scheduleRule: { teacherId } }` — both
compile, but only the cascade form survives
`ClassTemplate_teacherRoomId_fkey`'s `ON DELETE RESTRICT`.

- [ ] **Step 4: Run and commit**

```bash
npm run verify
git add src/services/slot-constraints.test.ts
git commit -m "test: the template slot cases move to the constraint that now holds them (issue 298)"
```

---

## Task 6: Documentation, and the claims this branch falsifies

**Files:**
- Modify: `docs/lock-order.md`, `CLAUDE.md`, `docs/data-model.md`,
  `prisma/schema.prisma` (docblocks), `src/lib/cross-family-conflict.ts`
  (docblock — see Step 3b)

- [ ] **Step 1: `docs/lock-order.md`**

The section *"The cross-family slot guard reads, and does not lock (#296)"*
describes eight triggers. Four are now gone. Rewrite it to describe the four
that remain (the class-level half), state that the template half became an
index-backed constraint, and keep the reopen condition for the remaining half.

Also update its `FOR UPDATE OF` census. **This branch DID change lock sites** —
Task 3c re-points both generator claims and adds an explicit child lock to six
write paths — so the prediction this bullet used to carry ("it should not have")
is falsified. Run the command the file ships and record what it returns now.

**And hoist one census out of an applied migration, because it cannot be fixed
where it sits.** `20260825065109_schedule_rule_backfill/migration.sql`'s block-4
comment reads:

> Measured: 10 dependencies across the four triggers, on teacherId, dayOfWeek,
> startTime and isArchived.

That is a prose count *and* a member roster, plus a claim reaching into the
previous migration ("since the previous migration") — both forbidden by
CLAUDE.md's Comment Discipline. The migration is applied, so the comment is
immutable: a comment-only edit changes the checksum while `prisma migrate
status` compares names, and nothing catches it until the next `prisma migrate
dev` demands a reset.

So the comment stays wrong where it is, and `docs/lock-order.md` becomes the
owner — exactly what this file already did for
`20260821120000_cross_family_slot_guard`, whose own prose was hoisted here for
the same reason (see the note at *"The cross-family slot guard reads, and does
not lock (#296)"*). Record the dependency census here **with the query that
re-derives it**, so it has an owner and a check:

```sql
SELECT count(*) FROM pg_depend d
JOIN pg_trigger t ON t.oid = d.objid AND d.classid = 'pg_trigger'::regclass
JOIN pg_class c ON c.oid = d.refobjid
WHERE d.refclassid = 'pg_class'::regclass AND d.refobjsubid > 0
  AND c.relname IN ('ClassTemplate','StudioClassTemplate');
```

It returned 10 before this branch and returns 0 after. State plainly that the
migration comment is the stale copy and this is the live one — a reader who
finds the migration first must be able to tell which to believe.

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

Record the delete-path change, and record it as **measured**, not as Task 2's
plan text originally predicted it. A `Teacher` hard-delete no longer cascades
directly to `ClassTemplate`; it reaches it via `ScheduleRule`, one hop further
out than `TeacherRoom`, whose `ClassTemplate_teacherRoomId_fkey` is
`ON DELETE RESTRICT`. The plan predicted that RESTRICT would now fire and refuse
the delete. **It does not** — measured in a rolled-back transaction, the delete
succeeds cleanly and every row goes, because PostgreSQL defers the FK check to
the end of the enclosing statement and the sibling cascade has already removed
the blocking row.

Write the measured behaviour and the mechanism. Do **not** write the predicted
error, and do not write "this was previously thought to be X" — the
before-and-after belongs in the PR body.

What must still be recorded is the *teardown* consequence, which survives the
correction because it does not depend on the prediction: separate `deleteMany`
statements get no end-of-statement help across statement boundaries, so
`scheduleRule.deleteMany` must precede `teacherRoom.deleteMany`.

- [ ] **Step 3a: two `schema.prisma` model docblocks this branch falsifies — and three that look identical and must NOT be touched**

Five model docblocks in `prisma/schema.prisma` describe constraints Prisma
cannot show. Four of them say, word for word, *"Since #296 it also carries TWO
TRIGGERS, invisible for the same reason."* Measured 2026-08-25:

| Docblock | Model | Names | This branch |
|---|---|---|---|
| `:263` | `Room` | two partial unique indexes (#196) | untouched |
| `:316` | `ClassTemplate` | `ClassTemplate_teacher_slot_unique` + two triggers | **falsified — both go** |
| `:390` | `Class` | `Class_teacher_slot_unique` + two triggers | untouched |
| `:462` | `StudioClassTemplate` | `StudioClassTemplate_teacher_slot_unique` + two triggers | **falsified — both go** |
| `:576` | `StudioClass` | `StudioClass_teacher_slot_unique` + two triggers | untouched |

Only the two template models change. The three survivors are the entry layer,
whose four triggers this branch keeps — **editing them would be the mirror-image
error**, correcting a claim that is still true.

For the two that change: after Task 2 those models carry no slot index and no
trigger at all. What they *do* carry that Prisma cannot express is the new
`CHECK ("kind" = 'regular')` / `CHECK ("kind" = 'studio')`, which is what makes
the composite foreign key mean "regular children hang off regular rules". Say
that, and **do not replace one prose count with a smaller one** — name the
constraint, as `ScheduleRule`'s own docblock now does after Task 1's review.

Verify line numbers before editing; Task 1 already moved this file.

- [ ] **Step 3b: `src/lib/cross-family-conflict.ts` — a prose count this branch falsifies**

Its docblock states:

> `YG001` is emitted by these eight triggers and by nothing else in the schema,
> so the SQLSTATE alone is the whole predicate.

Four of those eight go in Task 2. The claim reaches past its own file — the
triggers live in migrations — which is why it went stale from an edit made
elsewhere, exactly as CLAUDE.md's *Comment Discipline* predicts.

**Do not replace the count with a smaller count.** The load-bearing half is the
*uniqueness*, not the arithmetic: "a second user-defined `YG001` would make this
function silently wrong, and no test would notice." Keep that sentence, drop the
number, and point at `docs/lock-order.md` — which owns the trigger roster and
ships the command that re-derives it. Add the roster there if it is not already
carried in the rewrite from Step 1.

And correct it **by replacement, not annotation**: no "this previously said
eight". That belongs in the PR body, which already asks for it.

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
4. **The test COUNT changes during Task 3, or a test fails outside the
   conflict-vocabulary set.** That task adds and removes no tests, so the count
   must hold at 146/1877. Its *failures* are expected and bounded — Task 2
   already removed the objects the conflict branches match on — and Task 3
   Step 6 records the set. A red outside that set is a re-pointing defect;
   diagnose it there rather than carrying it into Task 4.

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
- Which suites ran. `npm run verify` runs all **four** vitest projects — `unit`,
  `unit-sweeps`, `components`, `integration` — across two `vitest run`
  invocations, so a green verify **is** the whole integration suite. State it
  with the arithmetic that proves it, per project. (It was three projects until
  #321 split `unit`; a PR body claiming three would be describing a repo that
  stopped existing on 2026-08-24.)
- The four premise corrections this branch measured before starting: the stale
  baseline structure, `btree_gist` present in the test database and absent from
  dev, `ClassTemplate_rule_unique` naming a constraint that never existed, and
  the 31 conflict-detection sites the compiler cannot see. Say which inherited
  claims were checked and **which held** — the four measured facts in the issue
  body all did, exactly.
