# Cross-family slot exclusivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for one teacher to hold two live classes at the same date and start time, across both the `Class` and `StudioClass` families, at both the instance and template level.

**Architecture:** Four PostgreSQL trigger functions, each reading the *sibling* table with an unlocked `SELECT` and raising `YG001` on a live collision, installed as eight trigger declarations (INSERT and UPDATE per table, because `WHEN` cannot reference `OLD` on INSERT). Services and routes keep pre-checks that name the reason and produce the copy; the triggers are what enforce. No lock is taken — see spec §1.5 and §4.

**Tech Stack:** PostgreSQL 16.12, Prisma 6, Next.js App Router, TypeScript strict, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-cross-family-slot-exclusivity-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
- **The SQLSTATE is `YG001`.** Not `23505` (Prisma maps it to P2002 with no `meta.target`, so `isUniqueConflictOn` returns false and the request 500s). Not `23514` (owned by `class_reject_terminal_date_change`).
- **Existing tests in `src/services/slot-constraints.test.ts` must pass unedited.** An edit to one signals the within-family rules moved, which this work forbids.
- **`src/services/slot-constraints.test.ts` is in the `unit` vitest project**, not `integration` — its glob is `src/**/*.test.ts`. Run it with `npx vitest run --project unit src/services/slot-constraints.test.ts`.
- **Never edit an applied migration.** Never `git add -A` or `git add .` — stage exact paths.
- **Never start or restart the dev server on :3000.** The user runs it.
- **Commit per task.** The PR is rebase-merged; the commit-per-task history is the record.
- **Never write an auto-close keyword immediately before an issue reference** in a commit message or PR body — write "#N is unaffected", or break the token.
- User-facing copy names the other family in plain prose, never a developer string (#197).

## File Structure

| File | Responsibility |
|---|---|
| `prisma/migrations/20260821120000_cross_family_slot_guard/migration.sql` | **Create.** Pre-flight violation check, `StudioClass` `(teacherId, date)` index (#205), four trigger functions, eight trigger declarations. |
| `prisma/schema.prisma` | **Modify.** `@@index([teacherId, date])` on `StudioClass`; docblocks on all four models naming the triggers. |
| `src/services/slot-constraints.test.ts` | **Modify.** Cross-family cases at both levels, both directions, plus the liveness and editability guards. |
| `src/lib/cross-family-conflict.ts` | **Create.** `isCrossFamilySlotConflict(err)` — recognises `YG001` in a Prisma error. |
| `src/lib/cross-family-conflict.test.ts` | **Create.** Unit tests, including a negative case for `23514`. |
| `src/lib/generation.ts` | **Modify.** Sixth `SkipReason`, fourth `SkipCounts` field, `countSkipReasons` arm. |
| `src/services/class-generator.ts` | **Modify.** Cross-family pre-check, new skip reason, `YG001` batch fallback. |
| `src/services/studio-class-generator.ts` | **Modify.** Same. |
| `src/services/studio-class-template-lifecycle.ts` | **Modify.** Replace the hand-listed `SkipCounts` fields with `SkipCounts` (#291). |
| `src/components/settings/template-action-messages.ts` | **Modify.** `resumeMessage`/`resumeStudioMessage` take a `SkipCounts` object; new cross-family clause. |
| `src/app/api/classes/route.ts`, `.../classes/[id]/route.ts`, `.../studio-classes/route.ts`, `.../studio-classes/[id]/route.ts`, `.../class-templates/**`, `.../studio-class-templates/**` | **Modify.** Catch `YG001`, answer 409 with copy. |
| `docs/lock-order.md` | **Modify.** New wait-edge section. |
| `CLAUDE.md` | **Modify.** Class Lifecycle bullet. |

---

## Task 1: The migration — index, pre-flight guard, four functions, eight triggers

**Files:**
- Create: `prisma/migrations/20260821120000_cross_family_slot_guard/migration.sql`
- Modify: `prisma/schema.prisma`
- Test: `src/services/slot-constraints.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the SQLSTATE `YG001` raised on a cross-family live collision; trigger names `class_cross_family_slot_insert_guard`, `class_cross_family_slot_update_guard`, `studio_class_cross_family_slot_insert_guard`, `studio_class_cross_family_slot_update_guard`, `class_template_cross_family_slot_insert_guard`, `class_template_cross_family_slot_update_guard`, `studio_class_template_cross_family_slot_insert_guard`, `studio_class_template_cross_family_slot_update_guard`.

- [ ] **Step 1: Write the failing tests**

Append to `src/services/slot-constraints.test.ts`. The file already defines `studio(teacher, day)`, `cls(teacher, day)`, `tpl(teacher, day)` and `studioTpl(teacher, day)` factories, and `teacherId` / `otherTeacherId` fixtures — reuse them. Note `cls` dates in month 1 and `studio` in month 0, so give both the same explicit date when a collision is the point.

```ts
describe('cross-family slot exclusivity (#296)', () => {
  const D = new Date(Date.UTC(2027, 5, 1));

  it('rejects a live studio class on a live class slot', async () => {
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D } });
    await expect(
      prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D } }),
    ).rejects.toThrow(/YG001/);
  });

  it('rejects a live class on a live studio class slot', async () => {
    const D2 = new Date(Date.UTC(2027, 5, 2));
    await prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D2 } });
    await expect(
      prisma.class.create({ data: { ...cls(teacherId, 1), date: D2 } }),
    ).rejects.toThrow(/YG001/);
  });

  it('a cancelled class does not block a studio class on that slot', async () => {
    const D3 = new Date(Date.UTC(2027, 5, 3));
    await prisma.class.create({
      data: { ...cls(teacherId, 1), date: D3, status: 'cancelled' },
    });
    const s = await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D3 },
    });
    expect(s.id).toBeTruthy();
  });

  it('a cancelled studio class does not block a class on that slot', async () => {
    const D4 = new Date(Date.UTC(2027, 5, 4));
    await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D4, cancelledAt: new Date() },
    });
    const c = await prisma.class.create({ data: { ...cls(teacherId, 1), date: D4 } });
    expect(c.id).toBeTruthy();
  });

  it('un-cancelling a studio class into an occupied slot is rejected', async () => {
    const D5 = new Date(Date.UTC(2027, 5, 5));
    const s = await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D5, cancelledAt: new Date() },
    });
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D5 } });
    await expect(
      prisma.studioClass.update({ where: { id: s.id }, data: { cancelledAt: null } }),
    ).rejects.toThrow(/YG001/);
  });

  it('does not block another teacher at the same date and time', async () => {
    const D6 = new Date(Date.UTC(2027, 5, 6));
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D6 } });
    const s = await prisma.studioClass.create({
      data: { ...studio(otherTeacherId, 1), date: D6 },
    });
    expect(s.id).toBeTruthy();
  });

  it('leaves a pre-existing violating pair editable on unrelated columns', async () => {
    const D7 = new Date(Date.UTC(2027, 5, 7));
    const c = await prisma.class.create({ data: { ...cls(teacherId, 1), date: D7 } });
    await prisma.$executeRaw`
      INSERT INTO "StudioClass"
        ("id","teacherId","classType","date","startTime","durationMinutes","location","hourlyRate","createdAt","updatedAt")
      VALUES
        (gen_random_uuid()::text, ${teacherId}, 'Yoga', ${D7}::date, '09:00', 60, 'Studio', 40, now(), now())`;
    const updated = await prisma.class.update({
      where: { id: c.id },
      data: { description: 'edited while a violating pair stands' },
    });
    expect(updated.description).toBe('edited while a violating pair stands');
  });
});

describe('cross-family template slot exclusivity (#296)', () => {
  it('rejects a live studio template on a live class template slot', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 3) });
    await expect(
      prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 3) }),
    ).rejects.toThrow(/YG001/);
  });

  it('rejects a live class template on a live studio template slot', async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 4) });
    await expect(
      prisma.classTemplate.create({ data: tpl(teacherId, 4) }),
    ).rejects.toThrow(/YG001/);
  });

  it('an archived template does not block the sibling family', async () => {
    await prisma.classTemplate.create({ data: { ...tpl(teacherId, 5), isArchived: true } });
    const st = await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 5) });
    expect(st.id).toBeTruthy();
  });

  it('unarchiving into an occupied cross-family slot is rejected', async () => {
    const t = await prisma.classTemplate.create({
      data: { ...tpl(teacherId, 6), isArchived: true },
    });
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 6) });
    await expect(
      prisma.classTemplate.update({ where: { id: t.id }, data: { isArchived: false } }),
    ).rejects.toThrow(/YG001/);
  });

  it('does not block another teacher on the same dayOfWeek and startTime', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 2) });
    const st = await prisma.studioClassTemplate.create({ data: studioTpl(otherTeacherId, 2) });
    expect(st.id).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/slot-constraints.test.ts`

Expected: the eight rejection/unarchive cases FAIL — the creates succeed instead of throwing. The "does not block" cases PASS already (nothing enforces anything yet), which is correct: they are regression guards, not new behaviour.

Record the failure text for the first case. It should be an assertion failure ("promise resolved instead of rejecting"), NOT an error mentioning `YG001`.

- [ ] **Step 3: Add the index to the Prisma schema**

In `prisma/schema.prisma`, in the `StudioClass` model beside the existing `@@unique([templateId, date])`:

```prisma
  @@index([teacherId, date])
  @@unique([templateId, date])
```

This is #205, folded in because the `Class` → `StudioClass` trigger lookup would otherwise scan. `Class` already carries the equivalent.

- [ ] **Step 4: Write the migration**

Create `prisma/migrations/20260821120000_cross_family_slot_guard/migration.sql`. The timestamp is hand-picked and sorts after `20260818135425`, matching how `20260805120000_class_terminal_status_trigger` and `20260817120000_class_terminal_date_trigger` were named.

```sql
-- Invariant, DB-enforced: one teacher cannot hold two LIVE classes at the same
-- date and start time, counted ACROSS the Class and StudioClass families (#296).
-- The same at the template level, across ClassTemplate and StudioClassTemplate.
--
-- Why a trigger and not an index: PostgreSQL has no cross-table unique index.
-- The four partial indexes in 20260811202634 each enforce this within one
-- table, and nothing spanned them, so neither create route, neither edit route
-- and neither hourly sweep could see the other family.
--
-- Why NO LOCK is taken here, which is deliberate and was the design's first
-- mistake. An earlier version had each function take pg_advisory_xact_lock on
-- the slot key. docs/lock-order.md rules that out: a lock inside a trigger is a
-- wait edge no source line issues (see "The RESTRICT trigger is a wait edge",
-- #103, whose fix was a route guard rather than a lock), and the existing
-- advisory lock's own docblock warns that a second call site inside a
-- Class-holding transaction inverts silently — a trigger is not a second call
-- site but every one, and pg_advisory_xact_lock is held to commit. The residual
-- race an unlocked read leaves is documented beside the pre-checks and was
-- measured, not argued.
--
-- Hand-authored because Prisma cannot express triggers. Like the partial
-- indexes, a trigger is invisible to `prisma migrate diff`, so this does not
-- read as drift in CI and will not be dropped.

-- ---------------------------------------------------------------------------
-- Pre-flight. Refuse to install the guard over data that already violates it,
-- so no environment silently gets triggers on top of a broken invariant.
-- `prisma db execute` surfaces RAISE EXCEPTION and swallows RAISE NOTICE.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  instance_violations  int;
  template_violations  int;
BEGIN
  SELECT count(*) INTO instance_violations
  FROM "Class" c
  JOIN "StudioClass" s
    ON  s."teacherId" = c."teacherId"
    AND s."date"      = c."date"
    AND s."startTime" = c."startTime"
  WHERE c."status" <> 'cancelled'
    AND s."cancelledAt" IS NULL;

  SELECT count(*) INTO template_violations
  FROM "ClassTemplate" t
  JOIN "StudioClassTemplate" st
    ON  st."teacherId" = t."teacherId"
    AND st."dayOfWeek" = t."dayOfWeek"
    AND st."startTime" = t."startTime"
  WHERE t."isArchived"  = false
    AND st."isArchived" = false;

  IF instance_violations > 0 OR template_violations > 0 THEN
    RAISE EXCEPTION
      'Cross-family slot violations must be resolved before this guard installs: % instance, % template',
      instance_violations, template_violations;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- #205: the Class -> StudioClass lookup below would otherwise scan. Class
-- already carries the equivalent index.
-- ---------------------------------------------------------------------------
CREATE INDEX "StudioClass_teacherId_date_idx" ON "StudioClass" ("teacherId", "date");

-- ---------------------------------------------------------------------------
-- Class -> StudioClass
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION class_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "StudioClass"
  WHERE "teacherId"   = NEW."teacherId"
    AND "date"        = NEW."date"
    AND "startTime"   = NEW."startTime"
    AND "cancelledAt" IS NULL
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has a live studio class (%) at % %',
      NEW."teacherId", conflicting, NEW."date", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_cross_family_slot_insert_guard
  BEFORE INSERT ON "Class"
  FOR EACH ROW
  WHEN (NEW."status" <> 'cancelled')
  EXECUTE FUNCTION class_reject_cross_family_slot();

-- Narrow on purpose. Fires only when the row is live AND the slot moved or the
-- row became live, so an unrelated update (spotBroadcastAt, the completion
-- totals, settingsLocked) pays for no sibling lookup — and a pre-existing
-- violating pair stays editable on every other column instead of freezing both
-- rows, which is the failure mode #76 was filed about.
CREATE TRIGGER class_cross_family_slot_update_guard
  BEFORE UPDATE ON "Class"
  FOR EACH ROW
  WHEN (
    NEW."status" <> 'cancelled'
    AND (
         OLD."status"    =  'cancelled'
      OR OLD."date"      IS DISTINCT FROM NEW."date"
      OR OLD."startTime" IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId" IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION class_reject_cross_family_slot();

-- ---------------------------------------------------------------------------
-- StudioClass -> Class
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studio_class_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "Class"
  WHERE "teacherId" = NEW."teacherId"
    AND "date"      = NEW."date"
    AND "startTime" = NEW."startTime"
    AND "status"   <> 'cancelled'
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has a live class (%) at % %',
      NEW."teacherId", conflicting, NEW."date", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER studio_class_cross_family_slot_insert_guard
  BEFORE INSERT ON "StudioClass"
  FOR EACH ROW
  WHEN (NEW."cancelledAt" IS NULL)
  EXECUTE FUNCTION studio_class_reject_cross_family_slot();

CREATE TRIGGER studio_class_cross_family_slot_update_guard
  BEFORE UPDATE ON "StudioClass"
  FOR EACH ROW
  WHEN (
    NEW."cancelledAt" IS NULL
    AND (
         OLD."cancelledAt" IS NOT NULL
      OR OLD."date"        IS DISTINCT FROM NEW."date"
      OR OLD."startTime"   IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId"   IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION studio_class_reject_cross_family_slot();

-- ---------------------------------------------------------------------------
-- ClassTemplate -> StudioClassTemplate. Templates key on dayOfWeek: a recurring
-- class recurs on a weekday. Archived templates are excluded so archiving frees
-- the slot, matching 20260811202634. `isActive` (paused) is NOT consulted — a
-- paused template goes on holding its slot, as it already does within families.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION class_template_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "StudioClassTemplate"
  WHERE "teacherId"  = NEW."teacherId"
    AND "dayOfWeek"  = NEW."dayOfWeek"
    AND "startTime"  = NEW."startTime"
    AND "isArchived" = false
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has an active studio template (%) on day % at %',
      NEW."teacherId", conflicting, NEW."dayOfWeek", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_template_cross_family_slot_insert_guard
  BEFORE INSERT ON "ClassTemplate"
  FOR EACH ROW
  WHEN (NEW."isArchived" = false)
  EXECUTE FUNCTION class_template_reject_cross_family_slot();

CREATE TRIGGER class_template_cross_family_slot_update_guard
  BEFORE UPDATE ON "ClassTemplate"
  FOR EACH ROW
  WHEN (
    NEW."isArchived" = false
    AND (
         OLD."isArchived" = true
      OR OLD."dayOfWeek"  IS DISTINCT FROM NEW."dayOfWeek"
      OR OLD."startTime"  IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId"  IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION class_template_reject_cross_family_slot();

-- ---------------------------------------------------------------------------
-- StudioClassTemplate -> ClassTemplate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION studio_class_template_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "ClassTemplate"
  WHERE "teacherId"  = NEW."teacherId"
    AND "dayOfWeek"  = NEW."dayOfWeek"
    AND "startTime"  = NEW."startTime"
    AND "isArchived" = false
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has an active class template (%) on day % at %',
      NEW."teacherId", conflicting, NEW."dayOfWeek", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER studio_class_template_cross_family_slot_insert_guard
  BEFORE INSERT ON "StudioClassTemplate"
  FOR EACH ROW
  WHEN (NEW."isArchived" = false)
  EXECUTE FUNCTION studio_class_template_reject_cross_family_slot();

CREATE TRIGGER studio_class_template_cross_family_slot_update_guard
  BEFORE UPDATE ON "StudioClassTemplate"
  FOR EACH ROW
  WHEN (
    NEW."isArchived" = false
    AND (
         OLD."isArchived" = true
      OR OLD."dayOfWeek"  IS DISTINCT FROM NEW."dayOfWeek"
      OR OLD."startTime"  IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId"  IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION studio_class_template_reject_cross_family_slot();
```

- [ ] **Step 5: Apply the migration and regenerate the client**

Run:
```bash
npx prisma migrate dev --name cross_family_slot_guard
```

Prisma will see the pending directory and apply it, then regenerate. If it instead offers to create a *new* migration for the schema drift, the `@@index` in Step 3 and the `CREATE INDEX` in Step 4 disagree on name — Prisma's default for `@@index([teacherId, date])` on `StudioClass` is `StudioClass_teacherId_date_idx`. Fix the SQL, never the applied migration.

Expected: `Your database is now in sync with your schema.`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services/slot-constraints.test.ts`

Expected: PASS, all cases including every pre-existing one **unedited**.

- [ ] **Step 7: Mutation — trigger queries its own table instead of the sibling**

In `class_reject_cross_family_slot`, change `FROM "StudioClass"` to `FROM "Class"` and re-apply the function with `psql` inside `fairyoga-db-1`. Re-run the file.

Expected: the cross-family rejection cases go RED. Record the exact failure text. Restore, re-apply, re-verify green.

- [ ] **Step 8: Mutation — drop the liveness predicate**

Remove `AND "cancelledAt" IS NULL` from `class_reject_cross_family_slot`. Re-apply, re-run.

Expected: "a cancelled studio class does not block a class on that slot" goes RED. Record the text. Restore, re-verify.

- [ ] **Step 9: Mutation — widen the UPDATE `WHEN`**

Replace the `class_cross_family_slot_update_guard` `WHEN` clause with `WHEN (NEW."status" <> 'cancelled')`. Re-apply, re-run.

Expected: "leaves a pre-existing violating pair editable on unrelated columns" goes RED. Record the text. Restore, re-verify.

- [ ] **Step 10: Mutation — drop one declaration at a time**

Drop `class_cross_family_slot_insert_guard`, re-run: the create-path cases go RED, the un-cancel case stays green. Restore. Then drop `class_cross_family_slot_update_guard`, re-run: the un-cancel and unarchive cases go RED, the create cases stay green. Restore, re-verify.

This is what proves the two declarations are both load-bearing rather than one being redundant.

- [ ] **Step 11: Commit**

```bash
git add prisma/migrations/20260821120000_cross_family_slot_guard/migration.sql prisma/schema.prisma src/services/slot-constraints.test.ts
git commit -m "feat: one teacher, one slot, across both class families (issue 296)"
```

---

## Task 2: Measure the residual race — this is a GATE

**Files:**
- Create: a throwaway harness in the session scratchpad. **Not committed** — `docs/lock-order.md` records its methods in prose rather than shipping scripts, and a one-off harness in the repo would bit-rot.
- Modify: `docs/superpowers/specs/2026-08-21-cross-family-slot-exclusivity-design.md` (§4.2, record the number)

**Interfaces:**
- Consumes: the triggers from Task 1.
- Produces: a measured double-booking rate that either confirms or overturns spec §4.2.

**Why this is a gate.** Spec §4.2 accepts a residual race on the strength of a measurement that has not been taken. `docs/lock-order.md` contains two worked examples of a concurrency claim that was argued instead of measured and was wrong — one quoting evidence that disproved it. If the rate is high, stop and reopen §4.2 rather than proceeding.

- [ ] **Step 1: Write the harness**

In the scratchpad. Two interactive transactions, each inserting into the opposite table at one slot, both issuing their INSERT before either commits.

```ts
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const RUNS = 200;

async function race(day: number): Promise<'both' | 'one'> {
  const date = new Date(Date.UTC(2028, 0, day));
  const results = await Promise.allSettled([
    prisma.$transaction(async (tx) => {
      await tx.class.create({ data: { /* cls fixture, date */ } });
      await new Promise((r) => setTimeout(r, 40));
    }),
    prisma.$transaction(async (tx) => {
      await tx.studioClass.create({ data: { /* studio fixture, date */ } });
      await new Promise((r) => setTimeout(r, 40));
    }),
  ]);
  return results.every((r) => r.status === 'fulfilled') ? 'both' : 'one';
}
```

Each run uses a distinct date so runs cannot interfere. Clean up the fixtures afterwards.

- [ ] **Step 2: Run it and record the number**

Run over 200 iterations. Record `both / 200` — the double-booking rate — in the format `docs/lock-order.md` uses (`32 of 100 runs`).

- [ ] **Step 3: Decide the gate**

- **Rare** (single digits per 200 or lower): §4.2 stands. Continue to Task 3, and carry the number into the `known-open` comment (Task 7) and the PR body.
- **Common:** STOP. Report to the maintainer. §4.2 is reopened and the advisory lock returns with a proper `docs/lock-order.md` ordering section — which is a different plan, not a patch to this one.

- [ ] **Step 4: Record the measurement in the spec**

Replace §4.2's "measured before it is documented (§6.3)" sentence with the measured figure and the method in one paragraph. Show the arithmetic so it can be re-derived.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-21-cross-family-slot-exclusivity-design.md
git commit -m "docs: the cross-family residual, measured rather than argued (issue 296)"
```

---

## Task 3: `isCrossFamilySlotConflict`, so the race answers 409 and not 500

**Files:**
- Create: `src/lib/cross-family-conflict.ts`
- Create: `src/lib/cross-family-conflict.test.ts`

**Interfaces:**
- Consumes: the `YG001` SQLSTATE from Task 1.
- Produces: `export function isCrossFamilySlotConflict(err: unknown): boolean`.

- [ ] **Step 1: Measure what Prisma actually reports**

Before writing the matcher, provoke the error and print the real shape. In the scratchpad:

```ts
try {
  await prisma.studioClass.create({ data: { /* colliding with a live Class */ } });
} catch (err) {
  console.log(err.constructor.name, JSON.stringify({ code: (err as any).code, meta: (err as any).meta }));
  console.log((err as Error).message);
}
```

Record the class name, `code`, `meta`, and whether the message contains `YG001` and in what form. **This output is pasted into the docblock in Step 3** — `unique-conflict.ts` pinned its own `meta.target` measurement the same way, and the plan must not assert a shape it did not observe.

- [ ] **Step 2: Write the failing test**

`src/lib/cross-family-conflict.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isCrossFamilySlotConflict } from './cross-family-conflict';

describe('isCrossFamilySlotConflict', () => {
  it('matches a YG001 raised by the cross-family trigger', () => {
    const err = new Error('... code: "YG001" ... Teacher x already has a live class');
    expect(isCrossFamilySlotConflict(err)).toBe(true);
  });

  it('does NOT match 23514, which the terminal-date trigger owns', () => {
    const err = new Error('... code: "23514" ... cannot change its date');
    expect(isCrossFamilySlotConflict(err)).toBe(false);
  });

  it('does not match an ordinary P2002', () => {
    const err = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target: ['teacherId', 'date', 'startTime'] },
    });
    expect(isCrossFamilySlotConflict(err)).toBe(false);
  });

  it('does not match a non-error', () => {
    expect(isCrossFamilySlotConflict('YG001')).toBe(false);
  });
});
```

Adjust the two message strings in the first two cases to the **exact** text recorded in Step 1.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run --project unit src/lib/cross-family-conflict.test.ts`
Expected: FAIL — `Cannot find module './cross-family-conflict'`.

- [ ] **Step 4: Write the implementation**

```ts
/**
 * True when `err` is the cross-family slot guard firing (#296).
 *
 * Matched by SQLSTATE inside the message rather than by a Prisma error code,
 * which is the technique `isTransientError` (`src/lib/api-errors.ts`) already
 * uses and for the same reason: a `RAISE EXCEPTION` with a user-defined
 * SQLSTATE has no Prisma code of its own.
 *
 * `YG001` is user-defined on purpose. `23505` was rejected because Prisma maps
 * it to P2002 with NO `meta.target`, so `isUniqueConflictOn` — which requires
 * `target` to be an array — returns false and the request falls through to a
 * 500 that looks like a 409 in review. `23514` was rejected because
 * `class_reject_terminal_date_change` already raises it, and two triggers
 * sharing a SQLSTATE cannot be told apart by the code mapping them.
 *
 * Measured shape, from this project's own database:
 *   <PASTE THE STEP 1 OUTPUT HERE — class name, code, meta, message excerpt>
 */
export function isCrossFamilySlotConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('code: "YG001"') || err.message.includes('Code: `YG001`');
}
```

Both message forms are matched for the same reason `isTransientError` matches both — two different Prisma error shapes carry the SQLSTATE differently.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit src/lib/cross-family-conflict.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation — change the trigger's ERRCODE to 23505**

Re-apply `class_reject_cross_family_slot` with `USING ERRCODE = '23505'`, then run a route-level create that collides and observe the HTTP status.

Expected: **500, not 409** — proving the spec's reasoning about `23505` rather than asserting it. Restore `YG001`, re-verify 409.

- [ ] **Step 7: Commit**

```bash
git add src/lib/cross-family-conflict.ts src/lib/cross-family-conflict.test.ts
git commit -m "feat: recognise the cross-family slot guard, with its shape measured (issue 296)"
```

---

## Task 4: The sixth `SkipReason`, and the two hazards adding it creates

**Files:**
- Modify: `src/lib/generation.ts`
- Modify: `src/components/settings/template-action-messages.ts`
- Modify: `src/services/studio-class-template-lifecycle.ts`
- Test: `src/lib/generation.test.ts`, `src/components/settings/template-action-messages.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SkipReason` member `'blocked_by_other_family'`; `SkipCounts` field `blockedByOtherFamily: number`; `resumeMessage(added: number, scheduled: number, counts: SkipCounts): string` and `resumeStudioMessage(added: number, scheduled: number, counts: SkipCounts): string`.

**Why the signature changes.** `resumeMessage` currently takes five adjacent positional `number` parameters. A sixth makes six mutually swappable arguments with no compile error — the hazard #286 is open about. This change *creates* that hazard, so it fixes it: the counts travel as one `SkipCounts` object. The same reasoning covers `studio-class-template-lifecycle.ts`, whose result type hand-lists the three `SkipCounts` fields (#291) and would otherwise be silently one field short.

- [ ] **Step 1: Write the failing tests**

In `src/lib/generation.test.ts`:

```ts
it('counts blocked_by_other_family', () => {
  const counts = countSkipReasons([
    { date: new Date(), reason: 'blocked_by_other_family' },
    { date: new Date(), reason: 'blocked_by_other_family' },
    { date: new Date(), reason: 'slot_taken' },
  ]);
  expect(counts.blockedByOtherFamily).toBe(2);
  expect(counts.slotTaken).toBe(1);
});
```

In `src/components/settings/template-action-messages.test.ts`:

```ts
it('names the other family when it holds the slot', () => {
  const msg = resumeMessage(0, 0, {
    blockedByCancelled: 0, slotTaken: 0, alreadyThisWeek: 0, blockedByOtherFamily: 2,
  });
  expect(msg).toContain('2');
  expect(msg.toLowerCase()).toContain('studio');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit src/lib/generation.test.ts` and `npx vitest run --project components src/components/settings/template-action-messages.test.ts`

Expected: FAIL — `blockedByOtherFamily` is not a property of `SkipCounts`, and `resumeMessage` takes five numbers.

- [ ] **Step 3: Add the member and the field**

In `src/lib/generation.ts`:

```ts
export type SkipReason =
  | 'already_generated'
  | 'blocked_by_cancelled'
  | 'slot_taken'
  | 'already_this_week'
  /**
   * A LIVE class from the OTHER family holds this teacher's slot (#296).
   *
   * Distinct from `slot_taken`, which means one of this teacher's own
   * same-family classes holds it. Kept separate because the remedy differs:
   * `slot_taken` is answered inside this family, and this one sends the
   * teacher to the other half of their schedule. Folding the two would make
   * one member carry two situations with two remedies — the conflation #288
   * is open about.
   */
  | 'blocked_by_other_family'
  | 'raced';
```

```ts
export interface SkipCounts {
  /** Candidate dates a cancelled instance of this template holds (#192). */
  blockedByCancelled: number;
  /** Candidate dates another of this teacher's classes holds (#196). */
  slotTaken: number;
  /** Candidate dates whose week this template already occupies (#194). */
  alreadyThisWeek: number;
  /** Candidate dates a live class from the OTHER family holds (#296). */
  blockedByOtherFamily: number;
}
```

- [ ] **Step 4: Let the compiler find the call sites**

Run: `npm run typecheck`

Expected: an error at `countSkipReasons`'s `default:` arm — `const unhandled: never = reason` cannot accept `'blocked_by_other_family'`. That exhaustiveness guard is why this member cannot vanish silently, and it is the intended way to find every site.

Add the arm:

```ts
      case 'blocked_by_other_family':
        blockedByOtherFamily += 1;
        break;
```

with `let blockedByOtherFamily = 0;` beside the other three and the field added to the returned object.

- [ ] **Step 5: Change the message signatures**

`resumeMessage(added: number, scheduled: number, counts: SkipCounts): string` and the same for `resumeStudioMessage`, which goes on delegating. Destructure `counts` inside. Add a cause clause for `blockedByOtherFamily` beside the existing ones, worded so each family names the *other*:

- class family: `"N of those dates are held by a studio class."`
- studio family: `"N of those dates are held by one of your own classes."`

These sentences genuinely differ, so — unlike `resumeStudioMessage`'s delegation for the identical sentences — they are written separately, and that difference is the point.

- [ ] **Step 6: Replace the hand-listed SkipCounts fields (#291)**

In `src/services/studio-class-template-lifecycle.ts`, the resume result arm inlines `blockedByCancelled`, `slotTaken` and `alreadyThisWeek` as three separate properties. Replace them with `counts: SkipCounts`, importing the type. Update the call sites the typechecker flags.

Keep the existing prose about `alreadyThisWeek` always being 0 on the studio side today — it is still true and still explains a real thing. Move it to the `SkipCounts` import site or leave it as a comment on the arm.

- [ ] **Step 7: Run typecheck and the tests**

Run: `npm run typecheck && npx vitest run --project unit src/lib/generation.test.ts && npx vitest run --project components src/components/settings/template-action-messages.test.ts`

Expected: PASS.

- [ ] **Step 8: Mutation — remove the `countSkipReasons` arm**

Delete the `case 'blocked_by_other_family':` arm.

Expected: `npm run typecheck` FAILS at the `never` assignment. Record the text. This proves the exhaustiveness guard bites rather than merely existing. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/lib/generation.ts src/lib/generation.test.ts src/components/settings/template-action-messages.ts src/components/settings/template-action-messages.test.ts src/services/studio-class-template-lifecycle.ts
git commit -m "feat: a skip reason for the other family, and the two hazards it would have added (issue 296)"
```

---

## Task 5: Both generators skip cross-family, and the batch insert survives it

**Files:**
- Modify: `src/services/studio-class-generator.ts`
- Modify: `src/services/class-generator.ts`
- Test: `src/services/studio-class-generator.test.ts`, `src/services/class-generator.test.ts`

**Interfaces:**
- Consumes: `'blocked_by_other_family'` (Task 4), `isCrossFamilySlotConflict` (Task 3).
- Produces: both generators emit `SkippedSlot { reason: 'blocked_by_other_family' }`.

- [ ] **Step 1: Write the failing tests**

In `src/services/studio-class-generator.test.ts`:

This file builds its fixtures inline rather than through named helpers, and
derives candidate dates with `getNextOccurrences` (imported from
`./class-generator`) and `classStartInstant`. Build the blocking row the same
way the file's existing cases build theirs, using the first date
`getNextOccurrences(template.dayOfWeek, from, 5)` yields for the template under
test, and the template's own `startTime`.

```ts
it('skips a date held by a live class from the other family', async () => {
  const blocked = getNextOccurrences(template.dayOfWeek, from, 5)[0]!;
  await prisma.class.create({
    data: { /* the file's usual Class fixture */ date: blocked, startTime: template.startTime },
  });

  const result = await generateStudioInstancesForTemplate(prisma, template);

  const blockedSkips = result.skipped.filter((s) => s.reason === 'blocked_by_other_family');
  expect(blockedSkips).toHaveLength(1);
  expect(blockedSkips[0]!.date.getTime()).toBe(blocked.getTime());
  expect(result.created).toBe(3);
});

it('does not skip a date held by a CANCELLED class from the other family', async () => {
  const notBlocked = getNextOccurrences(template.dayOfWeek, from, 5)[0]!;
  await prisma.class.create({
    data: {
      /* the file's usual Class fixture */
      date: notBlocked, startTime: template.startTime, status: 'cancelled',
    },
  });

  const result = await generateStudioInstancesForTemplate(prisma, template);

  expect(result.skipped.map((s) => s.reason)).not.toContain('blocked_by_other_family');
  expect(result.created).toBe(4);
});
```

Assert the skipped **date** as well as the reason. A count alone passes if the
generator blocks the wrong date, which the next mutation would not catch.

Mirror both in `class-generator.test.ts` with the families swapped —
`prisma.studioClass.create` with `cancelledAt: new Date()` for the second.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: FAIL — `created` is 4 and no such reason appears, because the generator never reads the other table.

- [ ] **Step 3: Add the cross-family occupancy read**

In `generateStudioInstancesForTemplate`, beside the existing `occupants` query (`src/services/studio-class-generator.ts:147`), add a second scoped to the same dates:

```ts
  // The OTHER family (#296). Mirrors the predicate
  // `studio_class_reject_cross_family_slot` carries (`status <> 'cancelled'`);
  // the trigger is what enforces it, this is what names the reason.
  // Widen or narrow one without the other and this pre-check starts
  // disagreeing with the guard that backs it.
  const foreign = await db.class.findMany({
    where: { teacherId: template.teacherId, date: { in: dates }, status: { not: 'cancelled' } },
    select: { date: true, startTime: true },
  });
```

Then, in the per-date loop, **after** the `own` branch and **before** `free.push(date)`, and ordered after the existing `slot_taken` check so a same-family cause is reported in preference to a cross-family one:

```ts
    if (foreign.some((c) => c.date.getTime() === date.getTime() && c.startTime === template.startTime)) {
      skipped.push({ date, reason: 'blocked_by_other_family' });
      continue;
    }
```

Mirror in `class-generator.ts` reading `db.studioClass` with `cancelledAt: null`.

- [ ] **Step 4: Add the batch-insert fallback**

`createManyAndReturn({ skipDuplicates: true })` absorbs a unique violation but **not** a raised exception, which aborts the whole statement — one raced date would cost all four. Wrap it:

```ts
  let inserted: { date: Date }[] = [];
  if (free.length > 0) {
    try {
      inserted = await db.studioClass.createManyAndReturn({ /* unchanged */ });
    } catch (err) {
      if (!isCrossFamilySlotConflict(err)) throw err;
      // A cross-family row landed between the pre-check and here. The batch
      // aborted as a unit, so re-issue per date and let the losers fall to
      // `raced` via the `landed` reconciliation below.
      inserted = [];
      for (const date of free) {
        try {
          const row = await db.studioClass.create({ data: { /* same row shape */ }, select: { date: true } });
          inserted.push(row);
        } catch (perDate) {
          if (!isCrossFamilySlotConflict(perDate)) throw perDate;
        }
      }
    }
  }
```

The existing `landed` reconciliation immediately below already turns every un-inserted date into `'raced'`, so nothing further is needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts src/services/class-generator.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation — widen the pre-check to ignore liveness**

Remove `status: { not: 'cancelled' }` from the `foreign` query.

Expected: "does not skip a date held by a CANCELLED class" goes RED. Record the text. Restore.

- [ ] **Step 7: Mutation — remove the cross-family pre-check (the masked guard)**

Delete the `blocked_by_other_family` branch from the per-date loop, leaving the
`foreign` query unused. Re-run.

Expected: `created` is **still 3** and the test fails **only** on the reason —
`'raced'` where `'blocked_by_other_family'` was expected. The trigger still
fires, the batch still aborts, and Step 4's fallback silently reclassifies the
date.

This is the most important mutation in the plan. It is the #103 shape — a guard
whose removal is hidden by the fallback beneath it — and a test asserting only
`result.created` would stay green through it. Record the failure text and note
explicitly in the task report that the count assertion did **not** move.
Restore, re-verify.

- [ ] **Step 8: Mutation — remove the batch fallback**

Delete the `catch` and let the batch throw. Add a test fixture that inserts a colliding foreign row between the pre-check and the insert (simplest: a transaction hook, or call the generator with a pre-seeded conflict the pre-check cannot see).

Expected: all four dates lost rather than three created. Record. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/services/studio-class-generator.ts src/services/studio-class-generator.test.ts src/services/class-generator.ts src/services/class-generator.test.ts
git commit -m "feat: neither sweep builds on top of the other family (issue 296)"
```

---

## Task 6: Every write path answers 409 with copy a teacher can act on

**Files:**
- Modify: `src/app/api/classes/route.ts`, `src/app/api/classes/[id]/route.ts`
- Modify: `src/app/api/studio-classes/route.ts`, `src/app/api/studio-classes/[id]/route.ts`
- Modify: `src/app/api/class-templates/route.ts`, `src/app/api/class-templates/[id]/route.ts`
- Modify: `src/app/api/studio-class-templates/route.ts`, `src/app/api/studio-class-templates/[id]/route.ts`
- Test: the matching files under `tests/integration/`

**Interfaces:**
- Consumes: `isCrossFamilySlotConflict` (Task 3).
- Produces: HTTP 409 with codes `CROSS_FAMILY_CLASS_SLOT`, `CROSS_FAMILY_STUDIO_SLOT`, `CROSS_FAMILY_CLASS_TEMPLATE_SLOT`, `CROSS_FAMILY_STUDIO_TEMPLATE_SLOT`.

- [ ] **Step 1: Write the failing tests**

For each route, a case creating the sibling-family occupant first, then asserting **both** the status and the message text:

```ts
it('refuses a class where a live studio class holds the slot', async () => {
  await createStudioClass({ date, startTime: '09:00' });
  const res = await post('/api/classes', { date, startTime: '09:00', /* ... */ });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.code).toBe('CROSS_FAMILY_STUDIO_SLOT');
  expect(body.error).toMatch(/studio class/i);
});
```

**Assert the message, not only the status.** A pre-check and a trigger both answer 409, so a status assertion cannot tell them apart — that is the exact defect #103 shipped past review, where `if (false && …)` in two routes left every test green because the catch answered a byte-identical 409.

Also add the un-cancel case on `PUT /api/studio-classes/[id]` (the #275 link) and the unarchive case on both template routes.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project integration tests/integration/`
Expected: FAIL with 500, because `isCrossFamilySlotConflict` is not consulted anywhere yet.

- [ ] **Step 3: Add the catch to each route** (a catch, not a pre-check — see spec §5.4)

Beside each existing `isUniqueConflictOn` branch:

```ts
    if (isCrossFamilySlotConflict(err)) {
      return respondError(
        'You already have a studio class at that date and time.',
        409,
        'CROSS_FAMILY_STUDIO_SLOT',
      );
    }
```

Wording per route, always naming the family that holds the slot:

| Route | Message |
|---|---|
| `POST`/`PUT` `/api/classes` | `You already have a studio class at that date and time.` |
| `POST`/`PUT` `/api/studio-classes` | `You already have a class at that date and time.` |
| `POST`/`PUT` `/api/class-templates` | `You already have a recurring studio class on that day at that time.` |
| `POST`/`PUT` `/api/studio-class-templates` | `You already have a recurring class on that day at that time.` |

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/`
Expected: PASS.

- [ ] **Step 5: Mutation — remove one route's catch**

Delete the `isCrossFamilySlotConflict` branch from `POST /api/classes`.

Expected: that route's case goes RED, with the status becoming 500 and the code absent. Record the text.

Note honestly in the task report that **this mutation is visible to a status-only assertion**, because a route has no pre-check for the catch to mask — the contrast that makes the message assertion load-bearing lives in Task 5 Step 7, where a generator's pre-check removal moves the reason and nothing else. Assert the message here anyway: it is what pins the copy to the right family, and swapping the two families' sentences is a real mistake a status check cannot see. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/classes src/app/api/studio-classes src/app/api/class-templates src/app/api/studio-class-templates tests/integration
git commit -m "feat: the eight doors name which family holds the slot (issue 296)"
```

---

## Task 7: The documentation that makes this safe to build on

**Files:**
- Modify: `docs/lock-order.md`
- Modify: `CLAUDE.md`
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: the measured residual from Task 2.
- Produces: no code.

- [ ] **Step 1: Add the wait-edge section to `docs/lock-order.md`**

After "The RESTRICT trigger is a wait edge, and a route guard is what closes it (#103)", add a section in the same register:

- what the eight triggers read, and that no source line issues that `SELECT`
- that they take **no** lock, and why the advisory lock was rejected — quoting that document's own warning about a second call site
- the measured residual from Task 2, with its method
- that the pre-checks are what keep the realistic path away from the guard, exactly as `countRoomDeleteBlockers` does for #103

- [ ] **Step 2: Add the `known-open` comment**

Beside the `foreign` query in `studio-class-generator.ts`, a short `known-open` marker naming the residual and its measured rate, following the pattern `room-archive.ts` uses for the archive-versus-publish race it accepts.

- [ ] **Step 3: Update `CLAUDE.md`**

Add a Class Lifecycle bullet: one teacher holds at most one live class per `(date, startTime)` across both families, and the same across both template families per `(dayOfWeek, startTime)` while unarchived; cancelled and archived rows do not participate; enforced by eight triggers because PostgreSQL has no cross-table unique index.

- [ ] **Step 4: Extend the four schema docblocks**

`prisma/schema.prisma:314`, `:379`, `:442` and `:510` already carry a docblock naming the partial index Prisma cannot show. Extend each to name its two cross-family triggers, for the same reason: `migrate diff` cannot see them.

- [ ] **Step 5: Run the full gate**

Run: `npm run verify`

Expected: typecheck, lint and all three vitest projects green. Requires the app running on :3000 for the integration project — the user runs it; do not start or restart it.

Record the per-project file and test counts, with totals that reconcile, for the PR body.

- [ ] **Step 6: Commit**

```bash
git add docs/lock-order.md CLAUDE.md prisma/schema.prisma src/services/studio-class-generator.ts
git commit -m "docs: the cross-family guard as a wait edge, and the residual it accepts (issue 296)"
```

---

## Not in this plan

- **#297** (overlap by duration) and **#298** (the structural question) — both filed, both untouched here.
- **#275**'s Restore door — the follow-up, which lands on this.
- **#288** is unaffected: its overlapping-predicate problem is not resolved, only not worsened.
- The 32-of-100 vacate-and-claim deadlock — pre-existing, documented in `docs/lock-order.md` as having no order to take.
