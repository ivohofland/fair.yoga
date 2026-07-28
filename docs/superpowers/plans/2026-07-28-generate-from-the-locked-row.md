# Generate From The Locked Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both generator sweeps write the template values that are true *now*, not the ones their outer `findMany` read minutes earlier (#102).

**Architecture:** Each claim already takes `SELECT "id" … FOR UPDATE` on the template row and discards it. It now returns the locked row instead of a boolean — the raw statement still does the locking and the eligibility re-check, then a typed Prisma `findUniqueOrThrow` reads the row under that held lock. The sweeps generate from what the claim returns, so they can no longer hold a stale object at all.

**Tech Stack:** TypeScript strict, Prisma, PostgreSQL, Vitest (`unit` project against `DATABASE_URL_TEST`).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence errors, no eslint suppressions.
- **The raw `SELECT … FOR UPDATE` keeps its `WHERE` clause.** The eligibility predicate must stay *inside the locking statement* so Postgres re-evaluates it against the new row version when the lock wait ends. That is #95's whole mechanism — do not move the check into the Prisma read.
- **Two statements, not one `SELECT *`.** `roomCost`, `minRate` and `targetRate` are `DECIMAL(10,2)`; a raw row returns something that is not Prisma's `Decimal`. Raw SQL locks, Prisma reads.
- **`findUniqueOrThrow`, not `findUnique`.** Under the held lock the row provably exists — the `FOR UPDATE` just matched it. A `| null` would be an impossible branch every caller has to pretend to handle.
- **Do not weaken `FOR UPDATE`** to `FOR NO KEY UPDATE`, and **do not call the claim with a bare `PrismaClient`** — both hazards are documented at length in `claimTemplateForGeneration`'s existing docstring. Leave those paragraphs intact.
- **`generateInstancesForTemplate`'s signature does not change.** Its three other callers already pass rows they read or wrote inside their own transaction.
- **The outer `findMany` stays.** It decides *which* templates to consider; it just stops being the source of the values written.
- **Mutation-verify each guard**, and per the #66 lesson confirm the mutation actually applied inside the function under test before trusting its result. Note the phrase `FOR UPDATE` appears in docstring prose as well as SQL, so read the matching lines rather than counting them.

---

## File Structure

| File | Change |
|---|---|
| `src/services/class-generator.ts` | `claimTemplateForGeneration` returns `TemplateWithTimezone \| null`; sweep generates from it |
| `src/services/class-generator.test.ts` | Predicate tests move to null-checks; add the race test |
| `src/services/studio-class-generator.ts` | `claimStudioTemplateForGeneration` returns `StudioClassTemplate \| null`; loop body reads from it |
| `src/services/studio-class-generator.test.ts` | Same two changes |

---

### Task 1: The class family

**Files:**
- Modify: `src/services/class-generator.ts` (`claimTemplateForGeneration` and the loop body of `generateClassInstances`)
- Test: `src/services/class-generator.test.ts`

**Interfaces:**
- Produces: `claimTemplateForGeneration(tx: Prisma.TransactionClient, templateId: string): Promise<TemplateWithTimezone | null>` — Task 2 mirrors this shape as `claimStudioTemplateForGeneration` returning `StudioClassTemplate | null`.

- [ ] **Step 1: Write the failing race test**

Add to `src/services/class-generator.test.ts`, as a sibling describe of the existing `'generateClassInstances — archive mid-sweep'` block. It uses that file's existing `templateId`/`teacherId` fixtures:

```ts
describe('generateClassInstances — edit mid-sweep', () => {
  // Captured, not hardcoded: other tests in this file assert the fixture's own
  // startTime, so restoring a guessed value would corrupt them.
  let original: { dayOfWeek: number; startTime: string };

  beforeAll(async () => {
    const t = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    original = { dayOfWeek: t.dayOfWeek, startTime: t.startTime };
  });

  afterEach(async () => {
    await prisma.class.deleteMany({ where: { templateId } });
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { ...original, isActive: true, isArchived: false },
    });
  });

  /**
   * #102. The claim locks the row, so a concurrent edit cannot commit while we
   * generate — but before this fix the sweep still generated from the object
   * its outer `findMany` read, so it wrote the pre-edit values anyway.
   *
   * Deterministic by the same lever as the archive race: an uncommitted write
   * is invisible under READ COMMITTED, so the sweep's list read genuinely sees
   * the old values and the template genuinely enters the loop.
   */
  it('writes the values committed while the sweep was waiting, not the ones it read', async () => {
    await prisma.class.deleteMany({ where: { templateId } });

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });

    // 1. Edit, uncommitted. Holds the row lock; invisible to the sweep.
    const editing = prisma.$transaction(
      async (tx) => {
        await tx.classTemplate.update({
          where: { id: templateId },
          data: { dayOfWeek: 5, startTime: '18:45' },
        });
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    // 2. Sweep. Its findMany reads the pre-edit row; its claim then blocks.
    let sweepSettled = false;
    const sweeping = generateClassInstances(prisma).then((n) => {
      sweepSettled = true;
      return n;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(sweepSettled).toBe(false);

    // 3. Commit. The claim unblocks and re-reads under its own lock.
    commit();
    await editing;
    await sweeping;

    // 4. Everything it created carries the post-edit values.
    const created = await prisma.class.findMany({
      where: { templateId },
      select: { date: true, startTime: true },
    });
    expect(created.length).toBeGreaterThan(0);
    for (const c of created) {
      expect(c.startTime).toBe('18:45');
      // dayOfWeek 5 in this schema's convention (0=Mon) is Saturday,
      // which is getUTCDay() === 6.
      expect(c.date.getUTCDay()).toBe(6);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: FAIL on `expect(c.startTime).toBe('18:45')` — the sweep created the window from its
stale snapshot, so the rows carry the fixture's original time and day (`'09:00'` on Tuesdays,
since that fixture is `dayOfWeek: 1` and this schema counts 0=Monday) rather than the edit's.

- [ ] **Step 3: Return the locked row from the claim**

In `src/services/class-generator.ts`, change only the signature and body of `claimTemplateForGeneration`. **Leave its entire existing docstring in place** — the `FOR UPDATE`-vs-`FOR NO KEY UPDATE` and bare-`PrismaClient` paragraphs are load-bearing — and add this paragraph to the end of it:

```
 * Returns the locked row rather than a boolean, so a caller cannot generate
 * from the snapshot its outer `findMany` read minutes earlier (#102). The raw
 * statement above still does the locking and the eligibility re-check; the
 * Prisma read below is what makes the values authoritative, and it is safe
 * precisely because the lock is still held when it runs. Two statements rather
 * than one `SELECT *` because `roomCost`, `minRate` and `targetRate` are
 * `DECIMAL(10,2)` and a raw row does not hand back Prisma's `Decimal`.
```

```ts
export async function claimTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<TemplateWithTimezone | null> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  if (rows.length !== 1) return null;

  // Under the lock taken above, so nothing can change this row before we
  // commit. `OrThrow` because the row provably exists — the FOR UPDATE just
  // matched it — and an impossible `| null` would force every caller to
  // pretend to handle it.
  return tx.classTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
}
```

- [ ] **Step 4: Generate from it in the sweep**

Replace the transaction callback inside `generateClassInstances`' loop:

```ts
      totalCreated += await db.$transaction(
        async (tx) => {
          const fresh = await claimTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;
          // `fresh`, not `template`: the loop variable is the pre-filter's
          // snapshot and may be minutes old. #102.
          return generateInstancesForTemplate(tx, fresh, startDate);
        },
        // Comfortably above the claim's own 2s lock_timeout, so Postgres
        // gives up on the lock before Prisma gives up on the transaction.
        { timeout: 10_000 },
      );
```

- [ ] **Step 5: Update the claim's existing predicate tests**

In `src/services/class-generator.test.ts`, the four cases in `describe('claimTemplateForGeneration')` currently assert `toBe(true)` / `toBe(false)`. Change the live case to `expect(await claim(templateId)).not.toBeNull()` and the three ineligible cases (archived, paused, nonexistent) to `toBeNull()`. The two concurrency tests in that block assert `expect(await claimTemplateForGeneration(tx, templateId)).toBe(true)` inside their transactions — change those to `.not.toBeNull()`.

Then add one case that the boolean could never have expressed:

```ts
  it('returns values committed after the caller read the row', async () => {
    const before = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { startTime: '21:15' },
    });

    const claimed = await prisma.$transaction((tx) => claimTemplateForGeneration(tx, templateId));

    expect(before.startTime).not.toBe('21:15');
    expect(claimed?.startTime).toBe('21:15');

    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { startTime: before.startTime },
    });
  });
```

- [ ] **Step 6: Run the file to verify everything passes**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS — the pre-existing generator tests, the claim block, and the new race test.

- [ ] **Step 7: Mutation-verify**

```bash
git add -A   # `git checkout --` restores from the index
```

Change the sweep's call back to the stale object — `generateInstancesForTemplate(tx, template, startDate)` — then confirm by reading the line that the mutation landed in `generateClassInstances` and not elsewhere:

```bash
grep -n "generateInstancesForTemplate(tx," src/services/class-generator.ts
npx vitest run --project unit src/services/class-generator.test.ts
```

Expected: the claim's predicate tests and the new "returns values committed after" case still PASS; `'writes the values committed while the sweep was waiting, not the ones it read'` FAILS. If the claim tests fail too, the mutation hit the wrong thing — restore and redo.

Restore: `git checkout -- src/services/class-generator.ts`

- [ ] **Step 8: Commit**

```bash
git add src/services/class-generator.ts src/services/class-generator.test.ts
git commit -m "fix: generate the class window from the row the claim locked (#102)"
```

---

### Task 2: The studio family

**Files:**
- Modify: `src/services/studio-class-generator.ts` (`claimStudioTemplateForGeneration` and the loop body of `generateStudioClassInstances`)
- Test: `src/services/studio-class-generator.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 — the two families keep separate helpers by long-standing decision.
- Produces: `claimStudioTemplateForGeneration(tx: Prisma.TransactionClient, templateId: string): Promise<StudioClassTemplate | null>`.

**Read the finished class family first** (`src/services/class-generator.ts`) — this task mirrors it. One difference: `StudioClassTemplate` needs **no `include`**, because the studio generator never reads a timezone (`getNextOccurrences` takes `dayOfWeek` alone, and there is no `classStartInstant` filter on this side). So the return type is the plain Prisma model.

- [ ] **Step 1: Write the failing race test**

Add to `src/services/studio-class-generator.test.ts` as a sibling of its existing mid-sweep block, mirroring Task 1's Step 1 against `generateStudioClassInstances`: edit `dayOfWeek` and `startTime` in an uncommitted transaction, start the sweep, assert it has not settled, commit, await, then assert every created `studioClass` carries the new `startTime` and the new day. Capture the template's original `dayOfWeek`/`startTime` in a `beforeAll` and restore from that in `afterEach` — do **not** hardcode them; other tests in that file assert the fixture's own values, so a guessed restore corrupts them. Reset `isActive`/`isArchived` in the same `afterEach`, and clear `studioClass` rows for the template both there and at the top of the test.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: FAIL on the `startTime` assertion — the rows carry the pre-edit value.

- [ ] **Step 3: Return the locked row from the studio claim**

Change only the signature and body of `claimStudioTemplateForGeneration`, leaving its existing docstring paragraphs intact and adding the same closing paragraph as Task 1's (adjusted: this one has no `include`, and the `DECIMAL` column here is `hourlyRate`):

```ts
export async function claimStudioTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<StudioClassTemplate | null> {
  await tx.$executeRawUnsafe(LOCK_TIMEOUT_SQL);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "StudioClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  if (rows.length !== 1) return null;

  // Under the lock taken above; `OrThrow` because the row provably exists.
  return tx.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
}
```

Add `StudioClassTemplate` to the type import from `@prisma/client`.

- [ ] **Step 4: Read every value from the locked row**

Replace the transaction callback in `generateStudioClassInstances`' loop. This is the whole body — every `template.` becomes `fresh.`:

```ts
      totalCreated += await db.$transaction(
        async (tx) => {
          const fresh = await claimStudioTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;

          // `fresh`, not `template`: the loop variable is the pre-filter's
          // snapshot and may be minutes old. #102.
          let created = 0;
          const dates = getNextOccurrences(fresh.dayOfWeek, startDate, DEFAULT_WEEKS);

          for (const date of dates) {
            const existing = await tx.studioClass.findFirst({
              where: { templateId: fresh.id, date },
            });
            if (existing) continue;

            // Unreachable while the claim above holds the row lock: no other
            // insert for this templateId can land inside this transaction, so
            // nothing is left to collide with `@@unique([templateId, date])`.
            // Kept as a defensive backstop only — pre-lock, this branch was
            // the one doing real work; see `claimStudioTemplateForGeneration`
            // for why that is no longer true.
            try {
              await tx.studioClass.create({
                data: {
                  teacherId: fresh.teacherId,
                  templateId: fresh.id,
                  classType: fresh.classType,
                  date,
                  startTime: fresh.startTime,
                  durationMinutes: fresh.durationMinutes,
                  location: fresh.location,
                  hourlyRate: fresh.hourlyRate,
                },
              });
            } catch (err) {
              if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
                continue; // dead under the claim's lock; see the comment above
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
```

- [ ] **Step 5: Update the studio claim's predicate tests**

The four cases in `describe('claimStudioTemplateForGeneration')` move from `toBe(true)`/`toBe(false)` to `not.toBeNull()`/`toBeNull()`, and the two concurrency tests' in-transaction assertions likewise. Add the studio equivalent of Task 1's "returns values committed after the caller read the row", using `startTime`.

- [ ] **Step 6: Run the file to verify everything passes**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation-verify**

Stage, then change one `fresh.` back to `template.` in the `create` data — `startTime: template.startTime` — confirm by reading the line that it landed in the studio loop and not the class one, and run the file.

Expected: the claim predicate tests still PASS; the new race test FAILS on the `startTime` assertion. Restore.

- [ ] **Step 8: Full verification and commit**

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit
```

Expected: clean; every unit test passes. Baseline before this plan is 384 unit tests; this plan adds 4.

```bash
git add src/services/studio-class-generator.ts src/services/studio-class-generator.test.ts
git commit -m "fix: generate the studio window from the row the claim locked (#102)"
```

---

## Verification before opening the PR

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 388 passing
- [ ] `npx vitest run --project integration` — 211 passing (needs the app on `:3000`; do not restart it. If `signup-api` returns 429 that is the local rate limiter saturating, not this change)
- [ ] `npx playwright test` — 118 passing
- [ ] `grep -rn "generateInstancesForTemplate(tx, template" src/` — no matches; the sweep must pass `fresh`
