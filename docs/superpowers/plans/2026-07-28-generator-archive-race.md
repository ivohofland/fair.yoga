# Generator Archive Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a cron sweep from creating classes for a template that was archived after the sweep read its template list (#95).

**Architecture:** Each template's generation moves inside its own transaction that first takes a row lock on the template with `SELECT ... FOR UPDATE`, re-checking `isActive`/`isArchived` at lock time. `archiveOrUnarchiveTemplate` already `UPDATE`s that row inside its own transaction, so the two serialise: whichever gets the lock first, the other observes its committed result and does the right thing. A plain re-read would not close the race — under `READ COMMITTED` an archive committing between the read and the `create` is still invisible to the read.

**Tech Stack:** TypeScript strict, Prisma, PostgreSQL, Vitest (`unit` project, runs against `DATABASE_URL_TEST`).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence errors, no eslint suppressions.
- **Raw SQL is confined to exactly two places**, one per template family: a single `SELECT ... FOR UPDATE` on a primary key. Identifiers are quoted PascalCase (Prisma's default mapping — verified against `prisma/migrations/20260403092044_init/migration.sql`). The id is always bound as a parameter, never interpolated into the string.
- **`ClassTemplate.id` and `StudioClassTemplate.id` are `TEXT`**, not `uuid`. No cast in the SQL.
- **Lock ordering is load-bearing:** `SET LOCAL lock_timeout = '2s'` inside each claim transaction, and `{ timeout: 10_000 }` on the enclosing `db.$transaction`. Postgres's timeout must fire before Prisma's, or a slow archive surfaces as a confusing Prisma abort instead of a clean skip.
- **Per-template error isolation must survive.** A template whose generation throws — including on lock timeout — is logged and skipped; the rest of the sweep still runs; the first error is rethrown at the end.
- **The two families keep separate helpers.** No generic over a Prisma delegate. This matches the decision recorded in `studio-class-template-lifecycle.ts` and re-endorsed in #93's review.
- **Do not convert the claim to a typed `updateMany`.** It has identical lock semantics and would avoid raw SQL, and it was considered and rejected: Prisma's `@updatedAt` fires on every update, so the sweep would rewrite every active template row hourly — making `ClassTemplate.updatedAt` mean "last cron sweep" rather than "last edited", and adding row churn and autovacuum load on a 2 GB VPS for a lock that needs to write nothing. Prisma has no native row-lock API, so `FOR UPDATE` is the only way to lock without writing.
- **Do not touch `generateInstancesForTemplate`'s signature or body.** Its three other callers (`POST /api/class-templates`, `pauseOrResumeTemplate`, `syncTemplateInstances`) already hold a consistent view; adding a lock there would be redundant at best.
- **Mutation-verify every guard**, and per the #66 lesson, confirm each mutation actually applied inside the function under test before trusting its result.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/services/class-generator.ts` | Class-family generation | Add exported `claimTemplateForGeneration`; wrap the sweep's per-template call in a claiming transaction |
| `src/services/class-generator.test.ts` | Its tests | Add claim-predicate, mutual-exclusion and mid-sweep-race cases |
| `src/services/studio-class-generator.ts` | Studio-family generation | Add exported `claimStudioTemplateForGeneration`; wrap the loop body; **add the per-template error isolation it currently lacks** |
| `src/services/studio-class-generator.test.ts` | Its tests | Same three shapes |

The claim helpers are exported rather than module-private. They are the unit whose contract this change exists to establish ("takes the lock, reports eligibility"), and the predicate cases cannot be reached through the sweep — the sweep's own top-level `findMany` already filters archived templates, so a test through that door passes with or without the fix.

---

### Task 1: Class-family claim and sweep

**Files:**
- Modify: `src/services/class-generator.ts:141-173` (`generateClassInstances`), plus a new exported helper above it
- Test: `src/services/class-generator.test.ts`

**Interfaces:**
- Consumes: `generateInstancesForTemplate(db, template, from?)` — already exists, unchanged.
- Produces: `claimTemplateForGeneration(tx: Prisma.TransactionClient, templateId: string): Promise<boolean>` — Task 2 mirrors this shape for the studio family under the name `claimStudioTemplateForGeneration`.

- [ ] **Step 1: Write the failing predicate tests**

Add to `src/services/class-generator.test.ts`, inside the existing `describe('generateClassInstances (DB)')` block so it reuses that block's fixtures (`templateId`, `teacherId`, and its `beforeAll` which deactivates pre-existing active templates):

```ts
describe('claimTemplateForGeneration', () => {
  const claim = (id: string) =>
    prisma.$transaction((tx) => claimTemplateForGeneration(tx, id));

  afterEach(async () => {
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: false },
    });
  });

  it('claims a live template', async () => {
    expect(await claim(templateId)).toBe(true);
  });

  it('refuses an archived template', async () => {
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isArchived: true },
    });
    expect(await claim(templateId)).toBe(false);
  });

  it('refuses a paused template', async () => {
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });
    expect(await claim(templateId)).toBe(false);
  });

  it('refuses a template that no longer exists', async () => {
    expect(await claim('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});
```

Add `afterEach` to the vitest import at the top of the file if it is not already there, and `claimTemplateForGeneration` to the `./class-generator` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: FAIL — `claimTemplateForGeneration is not exported` / TypeScript cannot resolve the import.

- [ ] **Step 3: Implement the claim helper**

Insert into `src/services/class-generator.ts` immediately above `generateClassInstances`:

```ts
/**
 * How long a claim waits for the template's row lock before giving up.
 * A literal, not a bound parameter: Postgres does not accept bind parameters
 * in `SET`. It is interpolated from this constant only — never from input —
 * which is why `$executeRawUnsafe` is safe here.
 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";

/**
 * Claims a template for generation, or reports it is no longer eligible.
 *
 * `FOR UPDATE` is the point, not the `SELECT`. It takes the same row lock
 * `archiveOrUnarchiveTemplate`'s `update` takes, so the sweep and an archive
 * serialise instead of interleaving:
 *
 *   - claim first  → the archive's UPDATE waits; we generate and commit; the
 *                    archive's own deleteMany then withdraws what we made.
 *   - archive first → we wait, then read `isArchived: true` and skip.
 *
 * A plain re-read would not do this. Under READ COMMITTED each statement takes
 * a fresh snapshot, so an archive committing between the re-read and the
 * `create` is invisible to the re-read and still lost. Do not "simplify" this
 * into a `findUnique`.
 */
export async function claimTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<boolean> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  return rows.length === 1;
}
```

- [ ] **Step 4: Run the predicate tests to verify they pass**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS — all four claim cases green.

- [ ] **Step 5: Write the failing mutual-exclusion test**

Append inside the same `describe('claimTemplateForGeneration')` block. It needs the archive service:

```ts
import { archiveOrUnarchiveTemplate } from './class-template-lifecycle';
```

```ts
  /**
   * The predicate cases above pass with or without `FOR UPDATE` — they never
   * run concurrently with anything. This is the one that pins the lock.
   */
  it('makes a concurrent archive wait until the claim transaction commits', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const claiming = prisma.$transaction(
      async (tx) => {
        expect(await claimTemplateForGeneration(tx, templateId)).toBe(true);
        await held;
      },
      { timeout: 15_000 },
    );

    // Let the claim acquire the lock before the archive contends for it.
    await new Promise((r) => setTimeout(r, 100));

    let archiveSettled = false;
    const archiving = archiveOrUnarchiveTemplate(prisma, templateId, teacherId).then((r) => {
      archiveSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    // Without FOR UPDATE the archive's UPDATE is unobstructed and this is true.
    expect(archiveSettled).toBe(false);

    release();
    await claiming;
    const result = await archiving;
    expect(result.ok).toBe(true);
  });
```

- [ ] **Step 6: Run it and confirm it passes, then mutation-verify the lock**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS.

Now prove the test has teeth. Stage first — `git checkout --` restores from the index, so unstaged work would be destroyed:

```bash
git add -A
```

Delete ` FOR UPDATE` from the query in `claimTemplateForGeneration`, then confirm the mutation actually landed in the function under test before drawing any conclusion:

```bash
grep -n "FOR UPDATE" src/services/class-generator.ts   # expect: no match
npx vitest run --project unit src/services/class-generator.test.ts
```

Expected: the four predicate cases still PASS; `makes a concurrent archive wait until the claim transaction commits` FAILS on `expected true to be false`. If the predicate cases fail too, the mutation hit the wrong thing — restore and redo.

Restore:

```bash
git checkout -- src/services/class-generator.ts
grep -c "FOR UPDATE" src/services/class-generator.ts   # expect: 1
```

- [ ] **Step 7: Write the failing mid-sweep race test**

Add as a sibling `describe` in the same file:

```ts
describe('generateClassInstances — archive mid-sweep', () => {
  afterEach(async () => {
    await prisma.class.deleteMany({ where: { templateId } });
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: false },
    });
  });

  /**
   * The actual #95 race, reproduced deterministically and with no test-only
   * hook in production code. Uncommitted writes are invisible to other
   * transactions under READ COMMITTED, which is the lever: the sweep's own
   * `findMany` still sees the template as live, so it enters the loop with
   * exactly the stale list the bug is about.
   */
  it('does not generate for a template archived after the list was read', async () => {
    expect(await prisma.class.count({ where: { templateId } })).toBe(0);

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });

    // 1. Archive, but do not commit. Holds the row lock; invisible to others.
    const archiving = prisma.$transaction(
      async (tx) => {
        await tx.classTemplate.update({
          where: { id: templateId },
          data: { isArchived: true, isActive: false },
        });
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    // 2. Sweep. Its findMany reads the pre-archive row and includes the
    //    template; its claim then blocks on the lock.
    let sweepSettled = false;
    const sweeping = generateClassInstances(prisma).then((n) => {
      sweepSettled = true;
      return n;
    });

    await new Promise((r) => setTimeout(r, 300));
    // Without FOR UPDATE the sweep sails past the claim and has already
    // created the window by now.
    expect(sweepSettled).toBe(false);

    // 3. Commit the archive; the claim unblocks and sees isArchived: true.
    commit();
    await archiving;
    await sweeping;

    // 4. Nothing was materialised for a template the teacher shelved.
    expect(await prisma.class.count({ where: { templateId } })).toBe(0);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: FAIL with `expected true to be false` on `sweepSettled` — the sweep does not yet claim anything, so it runs straight through and creates four classes.

- [ ] **Step 9: Wire the claim into the sweep**

Replace the loop body in `generateClassInstances` (`src/services/class-generator.ts`). The `findMany` above it stays exactly as it is — it is a cheap pre-filter, not the guard:

```ts
  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created, or the archive it is protecting
      // against can commit in between. The `findMany` above is only a
      // pre-filter — by the time the loop reaches this template its row may
      // be minutes stale, which is #95.
      totalCreated += await db.$transaction(
        async (tx) => {
          if (!(await claimTemplateForGeneration(tx, template.id))) return 0;
          return generateInstancesForTemplate(tx, template, startDate);
        },
        // Comfortably above the claim's own 2s lock_timeout, so Postgres
        // gives up on the lock before Prisma gives up on the transaction.
        { timeout: 10_000 },
      );
    } catch (err) {
      log.error(
        { err, templateId: template.id, teacherId: template.teacherId },
        'class generation failed for template',
      );
      errors.push(err);
    }
  }
```

- [ ] **Step 10: Run the full file to verify everything passes**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS — pre-existing generator tests, the four claim cases, mutual exclusion, and the mid-sweep race.

- [ ] **Step 11: Commit**

```bash
git add src/services/class-generator.ts src/services/class-generator.test.ts
git commit -m "fix: lock the template row before generating its window (#95)"
```

---

### Task 2: Studio-family claim, sweep, and error isolation

**Files:**
- Modify: `src/services/studio-class-generator.ts:13-70` (`generateStudioClassInstances`), plus a new exported helper above it
- Test: `src/services/studio-class-generator.test.ts`

**Interfaces:**
- Consumes: `getNextOccurrences(dayOfWeek, from, weeks)` from `./class-generator` — already imported there.
- Produces: `claimStudioTemplateForGeneration(tx: Prisma.TransactionClient, templateId: string): Promise<boolean>` — the studio mirror of Task 1's helper.

**Note for the implementer:** unlike the class sweep, `generateStudioClassInstances` has **no per-template error isolation** today — a throw anywhere in the loop aborts the whole sweep. Task 1's change introduces a new way to throw (lock timeout), so this task adds that isolation, matching the class family's shape. That is a deliberate part of this task, not scope creep: without it, one contended template would stop every other teacher's studio classes from generating.

- [ ] **Step 1: Write the failing predicate tests**

Add to `src/services/studio-class-generator.test.ts`, inside the existing DB describe block so it reuses its `templateId` fixture:

```ts
describe('claimStudioTemplateForGeneration', () => {
  const claim = (id: string) =>
    prisma.$transaction((tx) => claimStudioTemplateForGeneration(tx, id));

  afterEach(async () => {
    await prisma.studioClassTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: false },
    });
  });

  it('claims a live template', async () => {
    expect(await claim(templateId)).toBe(true);
  });

  it('refuses an archived template', async () => {
    await prisma.studioClassTemplate.update({
      where: { id: templateId },
      data: { isArchived: true },
    });
    expect(await claim(templateId)).toBe(false);
  });

  it('refuses a paused template', async () => {
    await prisma.studioClassTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });
    expect(await claim(templateId)).toBe(false);
  });

  it('refuses a template that no longer exists', async () => {
    expect(await claim('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  /**
   * The other interleaving. The mid-sweep test below covers "archive holds the
   * lock, generator waits"; this covers "generator holds it, archive waits".
   * The predicate cases above pass with or without `FOR UPDATE` — these two do
   * not.
   */
  it('makes a concurrent archive wait until the claim transaction commits', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const claiming = prisma.$transaction(
      async (tx) => {
        expect(await claimStudioTemplateForGeneration(tx, templateId)).toBe(true);
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let archiveSettled = false;
    const archiving = archiveOrUnarchiveStudioTemplate(prisma, templateId, teacherId).then((r) => {
      archiveSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(archiveSettled).toBe(false);

    release();
    await claiming;
    const result = await archiving;
    expect(result.ok).toBe(true);
  });
});
```

Add `afterEach` to the vitest import if absent, `claimStudioTemplateForGeneration` to the `./studio-class-generator` import, and:

```ts
import { archiveOrUnarchiveStudioTemplate } from './studio-class-template-lifecycle';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: FAIL — `claimStudioTemplateForGeneration` is not exported.

- [ ] **Step 3: Implement the studio claim helper**

Insert into `src/services/studio-class-generator.ts` immediately above `generateStudioClassInstances`:

```ts
/**
 * How long a claim waits for the template's row lock before giving up.
 * A literal, not a bound parameter: Postgres does not accept bind parameters
 * in `SET`. It is interpolated from this constant only — never from input —
 * which is why `$executeRawUnsafe` is safe here.
 */
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";

/**
 * Claims a studio template for generation, or reports it is no longer
 * eligible. The studio mirror of `claimTemplateForGeneration` in
 * `class-generator.ts` — see that function for why the lock, and not a
 * re-read, is what closes the race (#95).
 *
 * Deliberately a second copy rather than one helper generic over a Prisma
 * delegate: the two families are kept parallel-but-separate throughout, and a
 * generic version would have to interpolate the table name into raw SQL.
 */
export async function claimStudioTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<boolean> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StudioClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  return rows.length === 1;
}
```

`Prisma` is already imported in this file (`import { Prisma } from '@prisma/client'`); confirm `PrismaClient` and `Prisma` are both available and add `log` from `@/lib/log` — Step 7 needs it.

- [ ] **Step 4: Run the predicate tests to verify they pass**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: PASS — the four claim cases and the mutual-exclusion case are green.

- [ ] **Step 5: Write the failing mid-sweep race test**

Add as a sibling `describe`:

```ts
describe('generateStudioClassInstances — archive mid-sweep', () => {
  afterEach(async () => {
    await prisma.studioClass.deleteMany({ where: { templateId } });
    await prisma.studioClassTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: false },
    });
  });

  /**
   * The studio half of the #95 race. Same lever as the class family's test:
   * an uncommitted archive is invisible to the sweep's own `findMany`, so the
   * template enters the loop and the claim is what has to stop it.
   */
  it('does not generate for a template archived after the list was read', async () => {
    expect(await prisma.studioClass.count({ where: { templateId } })).toBe(0);

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });

    const archiving = prisma.$transaction(
      async (tx) => {
        await tx.studioClassTemplate.update({
          where: { id: templateId },
          data: { isArchived: true, isActive: false },
        });
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let sweepSettled = false;
    const sweeping = generateStudioClassInstances(prisma).then((n) => {
      sweepSettled = true;
      return n;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(sweepSettled).toBe(false);

    commit();
    await archiving;
    await sweeping;

    expect(await prisma.studioClass.count({ where: { templateId } })).toBe(0);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: FAIL with `expected true to be false` on `sweepSettled`.

- [ ] **Step 7: Wire the claim into the studio sweep, with per-template isolation**

Replace the whole `for (const template of templates) { ... }` loop in `generateStudioClassInstances`. The `findMany` above it is unchanged. Note the two structural changes: the body moves inside a claiming transaction and uses `tx`, and the loop gains the per-template `try`/`catch` and `errors` array the class family already has.

```ts
  let totalCreated = 0;
  const errors: unknown[] = [];

  for (const template of templates) {
    try {
      // One transaction per template: the claim's row lock has to still be
      // held when the instances are created (#95). The `findMany` above is
      // only a pre-filter — this template's row may be minutes stale by now.
      totalCreated += await db.$transaction(
        async (tx) => {
          if (!(await claimStudioTemplateForGeneration(tx, template.id))) return 0;

          let created = 0;
          const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS);

          for (const date of dates) {
            const existing = await tx.studioClass.findFirst({
              where: { templateId: template.id, date },
            });
            if (existing) continue;

            // @@unique([templateId, date]) makes concurrent runs collide on
            // P2002 instead of creating duplicate instances.
            try {
              await tx.studioClass.create({
                data: {
                  teacherId: template.teacherId,
                  templateId: template.id,
                  classType: template.classType,
                  date,
                  startTime: template.startTime,
                  durationMinutes: template.durationMinutes,
                  location: template.location,
                  hourlyRate: template.hourlyRate,
                },
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                continue; // a concurrent run created this instance first
              }
              throw err;
            }

            created++;
          }

          return created;
        },
        // Comfortably above the claim's own 2s lock_timeout, so Postgres
        // gives up on the lock before Prisma gives up on the transaction.
        { timeout: 10_000 },
      );
    } catch (err) {
      // Per-template isolation, matching `generateClassInstances`. The class
      // family already had this; the studio sweep did not, and the claim's
      // lock timeout above is a new way for one template to throw — without
      // this, one contended template would stop every other teacher's studio
      // classes from generating.
      log.error(
        { err, templateId: template.id, teacherId: template.teacherId },
        'studio class generation failed for template',
      );
      errors.push(err);
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
```

- [ ] **Step 8: Run the file to verify everything passes**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: PASS — pre-existing studio generator tests, the four claim cases, and the mid-sweep race.

- [ ] **Step 9: Mutation-verify the studio lock**

```bash
git add -A
```

Delete ` FOR UPDATE` from `claimStudioTemplateForGeneration`, confirm it landed in the right function, then run:

```bash
grep -n "FOR UPDATE" src/services/studio-class-generator.ts   # expect: no match
npx vitest run --project unit src/services/studio-class-generator.test.ts
```

Expected: the four predicate cases still PASS; **both** `makes a concurrent archive wait until the claim transaction commits` and `does not generate for a template archived after the list was read` FAIL on `expected true to be false`.

Restore:

```bash
git checkout -- src/services/studio-class-generator.ts
grep -c "FOR UPDATE" src/services/studio-class-generator.ts   # expect: 1
```

- [ ] **Step 10: Run the whole suite and the type check**

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit
```

Expected: `tsc` and `lint` silent; every unit test passes. Baseline before this plan is 352 unit tests; this plan adds 12 (six per family).

- [ ] **Step 11: Commit**

```bash
git add src/services/studio-class-generator.ts src/services/studio-class-generator.test.ts
git commit -m "fix: lock the studio template row before generating its window (#95)"
```

---

## Verification before opening the PR

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 364 passing
- [ ] `npx vitest run --project integration` — 192 passing (needs the app on `:3000`; do not restart it)
- [ ] `npx playwright test` — 118 passing
- [ ] `grep -rn '\$queryRaw\|\$executeRaw' src/` returns exactly the four lines this plan adds — two claims and their two `SET LOCAL` calls, and nothing else
