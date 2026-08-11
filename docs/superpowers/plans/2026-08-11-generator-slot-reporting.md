# Generator Slot Reporting Implementation Plan (#164 + #192)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both instance generators stop relying on a `catch (P2002) { continue }` that cannot work inside a transaction, and start reporting which candidate dates they skipped and why.

**Architecture:** Replace each generator's per-date `findFirst` + `create` loop with one occupancy `findMany` (which classifies every candidate date) plus one `createManyAndReturn({ skipDuplicates: true })` (whose bare `ON CONFLICT DO NOTHING` guarantees a clash costs only its own date and never aborts the transaction). Both generators return `GenerationResult = { created, skipped }`. The skip reasons then travel through both template-toggle routes into teacher-facing copy.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma 6.19.3 / PostgreSQL, Vitest (`unit` project → `ethical_yoga_test`; `integration` → HTTP app on :3000; `components` → jsdom), pino via `@/lib/log`.

**Spec:** `docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md`

## Global Constraints

- TypeScript `strict: true`. No `any`, no implicit types. `noUncheckedIndexedAccess` is on — indexing yields `T | undefined`; prefer iterating over indexing.
- Never start or restart the dev server on :3000. The user runs it; integration tests need it live.
- Never `git add -A` or `git add .` — stage exact paths. Quote paths containing parentheses (`(teacher)`, `(public)`, `(student)`).
- Never write `does not close #N`, `fixes`, `resolves`, `closed` before a `#N` you want left open — GitHub's parser ignores the negation. Write "**#N is unaffected**".
- `@/lib/log` is pino and **server-only**. `src/lib/generation.ts` (Task 1) must stay import-free so `template-action-messages.ts`, reached from `'use client'` components, can `import type` from it.
- The occupancy predicate must mirror #196's index predicate exactly: `status: { not: 'cancelled' }` for `Class`, `cancelledAt: null` for `StudioClass`. **No index is created on this branch.**
- `npm run verify` before pushing (typecheck + lint + all three vitest projects). Needs the app live on :3000.
- Commit per task. Never squash at merge — rebase-merge only.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/generation.ts` | **New.** `SkipReason`, `SkippedSlot`, `GenerationResult`. Import-free. | 1 |
| `src/services/class-generator.ts` | Class generator: pre-check, `ON CONFLICT`, result, log, docblock corrections | 1 |
| `src/services/class-generator.test.ts` | Class generator tests + T1/T2 race tests through Resume | 1, 2 |
| `src/services/studio-class-generator.ts` | Studio twin of Task 1 | 3 |
| `src/services/studio-class-generator.test.ts` | Studio generator tests + studio race test | 3 |
| `src/services/class-template-lifecycle.ts` | Resume returns `scheduled`/`added`/skip counts | 4 |
| `src/app/api/class-templates/[id]/route.ts` | Ternary → switch; emit the new `active` fields | 4 |
| `src/services/studio-class-template-lifecycle.ts` | Resume carries skip counts through | 5 |
| `src/app/api/studio-class-templates/[id]/route.ts` | Emit the new `active` fields | 5 |
| `src/components/settings/template-action-messages.ts` | `templateKind` discriminator, `resumeMessage`, `resumeStudioMessage` | 6 |
| `src/components/settings/template-action-messages.test.ts` | Copy + type pins | 6 |
| `docs/lock-order.md`, `docs/technical-architecture.md` | Verified against the change | 7 |
| `docs/superpowers/plans/2026-08-11-generator-slot-reporting-mutations.md` | **New.** Mutation ledger | 8 |

## Task order is load-bearing

**Task 1 must contain both the class-generator rewrite and its tests**, because the two race tests (Task 2) can only be observed failing against the *pre-fix* loop, and TDD requires seeing them fail before the fix lands. Task 2 therefore runs its "observe the failure" step against `git stash`ed work, exactly as written. Do not reorder 1 and 2.

**Tasks 4 and 5 must precede Task 6.** The copy cannot compile before the response types carry the counts.

---

### Task 1: Class generator — pre-check, ON CONFLICT, result shape

**Files:**
- Create: `src/lib/generation.ts`
- Modify: `src/services/class-generator.ts:74-133` (docblock + function body), `:180-189` (claim docblock), `:265` (sweep call site)
- Test: `src/services/class-generator.test.ts`

**Interfaces:**
- Produces: `SkipReason`, `SkippedSlot`, `GenerationResult` from `@/lib/generation`; `generateInstancesForTemplate(db, template, from?): Promise<GenerationResult>`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Create the shared result module**

```ts
// src/lib/generation.ts
/**
 * The result shape both instance generators return.
 *
 * Import-free on purpose. `template-action-messages.ts` is reached from
 * `'use client'` components, and this module's names travel that far; keeping it
 * free of imports means no future edit here can drag `@/lib/log` (pino,
 * server-only) into a client bundle. `src/lib/tiers.ts` and
 * `src/lib/class-fields.ts` exist for the same reason.
 */

/**
 * Why a candidate date produced no row. Four reasons, four distinct origins —
 * they are not interchangeable and the copy layer treats them differently.
 */
export type SkipReason =
  /** This template's own live instance is already on that date. Correct idempotency; never logged. */
  | 'already_generated'
  /** This template's own CANCELLED instance holds the date. `@@unique([templateId, date])` makes it permanently unfillable (#192). */
  | 'blocked_by_cancelled'
  /** Another of this teacher's classes holds that date + startTime (#196). */
  | 'slot_taken'
  /** The pre-check said free and `ON CONFLICT DO NOTHING` skipped it anyway — a concurrent insert landed in between (#164). */
  | 'raced';

export interface SkippedSlot {
  date: Date;
  reason: SkipReason;
}

/** `created + skipped.length` always equals the number of candidate dates. */
export interface GenerationResult {
  created: number;
  skipped: SkippedSlot[];
}
```

- [ ] **Step 2: Write the failing tests**

Add to `src/services/class-generator.test.ts`, inside `describe('generateClassInstances (DB)')` so the existing `teacherId` / `teacherRoomId` / `templateId` fixture is in scope. Add `classStartInstant` to the `@/lib/timezone` import and `log` is already imported.

```ts
  describe('generateInstancesForTemplate — slot reporting', () => {
    /** The same four dates the generator will choose, computed the same way. */
    function candidates(now: Date): Date[] {
      return getNextOccurrences(1, now, 5)
        .filter((d) => classStartInstant(d, '09:00', 'Europe/Amsterdam') > now)
        .slice(0, 4);
    }

    afterEach(async () => {
      await prisma.class.deleteMany({ where: { teacherId } });
    });

    it('reports an already-generated date rather than counting it', async () => {
      const now = new Date();
      const first = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(first.created).toBe(4);
      expect(first.skipped).toEqual([]);

      const second = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(second.created).toBe(0);
      expect(second.skipped.map((s) => s.reason)).toEqual([
        'already_generated',
        'already_generated',
        'already_generated',
        'already_generated',
      ]);
    });

    it('names a cancelled own instance as blocked_by_cancelled, not as idempotency', async () => {
      const now = new Date();
      const dates = candidates(now);
      const blocked = dates[1]!;
      await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      await prisma.class.updateMany({
        where: { templateId, date: blocked },
        data: { status: 'cancelled' },
      });

      const again = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(again.created).toBe(0);
      expect(again.skipped).toContainEqual({ date: blocked, reason: 'blocked_by_cancelled' });
    });

    it('skips only the slot a manually created class occupies, and still fills the rest', async () => {
      const now = new Date();
      const dates = candidates(now);
      const taken = dates[1]!;
      // templateId: null — a class the teacher created by hand. The old probe
      // checked {templateId, date} and so could not see this at all.
      await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          templateId: null,
          classType: 'Manual',
          date: taken,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 40,
          minRate: 15,
          targetRate: 30,
          minStudents: 4,
          maxStudents: 12,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'open',
        },
      });

      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);

      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: taken, reason: 'slot_taken' }]);
      expect(await prisma.class.count({ where: { templateId } })).toBe(3);
    });

    it('does not treat a cancelled neighbour as occupying the slot', async () => {
      const now = new Date();
      const dates = candidates(now);
      const free = dates[1]!;
      await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          templateId: null,
          classType: 'Manual',
          date: free,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 40,
          minRate: 15,
          targetRate: 30,
          minStudents: 4,
          maxStudents: 12,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'cancelled',
        },
      });

      // #196's index carries `WHERE "status" <> 'cancelled'`, so a cancelled
      // neighbour does not occupy the slot and must not block generation.
      const result = await generateInstancesForTemplate(prisma, await freshTemplate(), now);
      expect(result.created).toBe(4);
      expect(result.skipped).toEqual([]);
    });

    it('logs blocked dates once per call, and stays silent for plain idempotency', async () => {
      const now = new Date();
      const spy = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        await generateInstancesForTemplate(prisma, await freshTemplate(), now);
        expect(spy).not.toHaveBeenCalled(); // 4 fresh creates — nothing to say

        await generateInstancesForTemplate(prisma, await freshTemplate(), now);
        expect(spy).not.toHaveBeenCalled(); // 4 already_generated — the noise rule

        await prisma.class.updateMany({
          where: { templateId, date: candidates(now)[1]! },
          data: { status: 'cancelled' },
        });
        await generateInstancesForTemplate(prisma, await freshTemplate(), now);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0]![0]).toMatchObject({
          templateId,
          skipped: [{ reason: 'blocked_by_cancelled' }],
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
```

Add this helper beside the new describe (the generator needs the joined timezone):

```ts
  /** The template with the `teacher.defaultTimezone` join the generator requires. */
  async function freshTemplate() {
    return prisma.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
  }
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t "slot reporting"`

Expected: FAIL. `first.created` is `4` today but `first.skipped` is `undefined` (the function returns a bare `number`), so `expect(first.created).toBe(4)` fails with `expected undefined to be 4`. The `slot_taken` test fails with `expected 4 to be 3` once the shape lands — today it creates a fourth class into an occupied slot.

- [ ] **Step 4: Rewrite the generator**

Replace `src/services/class-generator.ts:74-133` (docblock through the closing brace of `generateInstancesForTemplate`) with:

```ts
/**
 * Generates the rolling 4-week window for ONE template, reporting each
 * candidate date it could not fill and why (`GenerationResult`).
 *
 * Two mechanisms, each with a job the other cannot do:
 *
 *   - the occupancy `findMany` below names the *reason* a date is skipped, which
 *     is what lets the teacher be told something true and an operator grep for
 *     it. It is a read-then-write and so is not race-safe on its own;
 *   - `createManyAndReturn({ skipDuplicates: true })` compiles to a BARE
 *     `ON CONFLICT DO NOTHING` — no conflict target, so it covers every unique
 *     constraint on the table, including the partial index #196 adds. That is
 *     what makes a clash cost only its own date.
 *
 * This function used to claim it was idempotent via "`@@unique([templateId,
 * date])` + P2002-skip". It was not, and the correction is the reason this
 * shape exists: Prisma does not savepoint individual queries inside an
 * interactive transaction, so a caught `P2002` leaves Postgres with an aborted
 * transaction. The next statement fails with `25P02`, and if the clash landed
 * on the *last* date there is no next statement — `COMMIT` on an aborted
 * transaction returns the `ROLLBACK` tag with no error, so `$transaction`
 * resolved successfully while every row it reported was discarded (#164).
 * Four of the five call sites pass a transaction client. Do not reintroduce a
 * `catch` here; there is nothing it can do that the constraint does not.
 *
 * Accepts a transaction client so a route can create the template and its
 * window atomically.
 */
export async function generateInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> {
  const startDate = from ?? new Date();

  // The next 4 occurrences whose start is still ahead of startDate. A run
  // after today's start time must not create a class that already happened;
  // the window slides one week further instead.
  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) >
        startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  // One query for the whole window, replacing the per-date `findFirst`. Scoped
  // to this teacher because the slot key #196 enforces is
  // `(teacherId, date, startTime)` — another teacher's class can never block
  // this one and must not be read.
  const occupants = await db.class.findMany({
    where: { teacherId: template.teacherId, date: { in: dates } },
    select: { templateId: true, date: true, startTime: true, status: true },
  });

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  for (const date of dates) {
    const onDate = occupants.filter((c) => c.date.getTime() === date.getTime());

    // At most one, by `@@unique([templateId, date])`.
    const own = onDate.find((c) => c.templateId === template.id);
    if (own) {
      // A cancelled own row still holds the date: that unique key does not
      // care about status, so the date is unfillable for good, not merely
      // already filled. Telling those two apart is #192.
      skipped.push({
        date,
        reason: own.status === 'cancelled' ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // Mirrors #196's index predicate exactly (`WHERE "status" <> 'cancelled'`).
    // Widen or narrow one without the other and this pre-check starts
    // disagreeing with the constraint that backs it — see the spec's §4.1.
    if (onDate.some((c) => c.startTime === template.startTime && c.status !== 'cancelled')) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    free.push(date);
  }

  const inserted =
    free.length === 0
      ? []
      : await db.class.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.teacherId,
            teacherRoomId: template.teacherRoomId,
            templateId: template.id,
            classType: template.classType,
            description: template.description,
            date,
            startTime: template.startTime,
            durationMinutes: template.durationMinutes,
            roomCost: template.roomCost,
            minRate: template.minRate,
            targetRate: template.targetRate,
            minStudents: template.minStudents,
            maxStudents: template.maxStudents,
            cancelDeadline: template.cancelDeadline,
            autoCancelCheck: template.autoCancelCheck,
            status: 'open' as const,
          })),
          skipDuplicates: true,
          select: { date: true },
        });

  // A free date that did not come back lost a race with a concurrent insert.
  // Before #164 this was the P2002 that poisoned the transaction; it is now an
  // ordinary skipped date, and the only one whose cause is not in `occupants`.
  const landed = new Set(inserted.map((r) => r.date.getTime()));
  for (const date of free) {
    if (!landed.has(date.getTime())) skipped.push({ date, reason: 'raced' });
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedSlots(template.id, template.teacherId, skipped);

  return { created: inserted.length, skipped };
}

/**
 * One line per generator call, never one per date — that ratio is the answer to
 * the noise question #192 raised, where per-date logging on an hourly sweep put
 * ~48 lines/day on a 2GB VPS for a teacher with two blocked dates. Per call it
 * is 24, and each is complete rather than a fragment.
 *
 * `already_generated` is excluded deliberately: it is the correct, expected
 * outcome of every steady-state run, and logging it *is* the noise.
 */
function logSkippedSlots(templateId: string, teacherId: string, skipped: SkippedSlot[]): void {
  const blocking = skipped.filter((s) => s.reason !== 'already_generated');
  if (blocking.length === 0) return;

  log.warn(
    {
      templateId,
      teacherId,
      skipped: blocking.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        reason: s.reason,
      })),
    },
    'class generation could not fill every date in the window',
  );
}
```

Add the import at the top of the file:

```ts
import type { GenerationResult, SkippedSlot } from '@/lib/generation';
```

- [ ] **Step 5: Fix the sweep's call site and the claim docblock**

`src/services/class-generator.ts:265`, inside `generateClassInstances`'s `$transaction`:

```ts
          const fresh = await claimTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;
          // `fresh`, not `template`: the loop variable is the pre-filter's
          // stale snapshot.
          const result = await generateInstancesForTemplate(tx, fresh, startDate);
          return result.created;
```

In `claimTemplateForGeneration`'s docblock (`:180-189`), replace the paragraph beginning "Do not weaken `FOR UPDATE`" with:

```
 * Do not weaken `FOR UPDATE` to `FOR NO KEY UPDATE` to stop blocking `Class`
 * inserts — it looks like a free optimisation but isn't. `FOR UPDATE` is what
 * makes a concurrent insert for this template impossible, because an insert's
 * FK check takes `FOR KEY SHARE` on this row, which `FOR UPDATE` conflicts with
 * and `FOR NO KEY UPDATE` does not. Measured on #164, both directions.
 *
 * That is a claim about races, not about correctness under one:
 * `generateInstancesForTemplate` no longer has a P2002 branch to be broken.
 * Its `ON CONFLICT DO NOTHING` makes a lost race cost one date and abort
 * nothing, with or without this lock. The lock still earns its place by
 * keeping the values this claim returns authoritative (#102).
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS, including every pre-existing test in the file.

Then `npm run typecheck` — expected clean. If `tests/integration/class-templates-api.test.ts:194` or `src/services/class-generator.test.ts:643` fail to compile, append `.created` at those call sites; both consume the return value.

- [ ] **Step 7: Correct the spec's §5 call-site claim**

§5 says all 16 call sites "read a number today and read `.created` after". Measured while implementing: most **discard** the return (`api/class-templates/route.ts:63`, `class-template-lifecycle.ts:456`, `template-sync.ts:119`), so only the sites that consume it need editing. Edit §5 of `docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md` to say so, naming which sites consume and which discard.

- [ ] **Step 8: Commit**

```bash
git add src/lib/generation.ts src/services/class-generator.ts src/services/class-generator.test.ts docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md
git commit -m "fix: the class generator names the dates it could not fill"
```

---

### Task 2: The two race tests — the silent variant, reproduced

**Files:**
- Test: `src/services/class-generator.test.ts` (new nested describe)

**Interfaces:**
- Consumes: `generateInstancesForTemplate` from Task 1; `pauseOrResumeTemplate` from `./class-template-lifecycle`.
- Produces: nothing.

These are #164's stated acceptance. They assert **database state only** — rows present, `isActive` committed — never `added`, so Task 4 cannot break them.

The lever, measured on #164: a Postgres FK check takes `FOR KEY SHARE` on the referenced row. A second transaction holding `FOR UPDATE` on the `TeacherRoom` row parks the generator's insert; it then writes the colliding row itself (compatible within its own transaction) and commits; the parked insert unblocks into the clash. Resume is the right vehicle because its `update` takes only `FOR NO KEY UPDATE`, which does **not** conflict with the holder — measured.

- [ ] **Step 1: Write the two tests**

Add `import { pauseOrResumeTemplate } from './class-template-lifecycle';` and:

```ts
  describe('pauseOrResumeTemplate — a clash during generation (#164)', () => {
    beforeEach(async () => {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.classTemplate.update({ where: { id: templateId }, data: { isActive: false } });
    });

    afterEach(async () => {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.classTemplate.update({ where: { id: templateId }, data: { isActive: true } });
    });

    function candidates(now: Date): Date[] {
      return getNextOccurrences(1, now, 5)
        .filter((d) => classStartInstant(d, '09:00', 'Europe/Amsterdam') > now)
        .slice(0, 4);
    }

    const classRow = (date: Date) => ({
      teacherId,
      teacherRoomId,
      templateId,
      classType: 'Vinyasa',
      date,
      startTime: '09:00',
      durationMinutes: 75,
      roomCost: 40,
      minRate: 15,
      targetRate: 30,
      minStudents: 4,
      maxStudents: 12,
      cancelDeadline: 'HOURS_24' as const,
      autoCancelCheck: 'HOURS_2' as const,
      status: 'open' as const,
    });

    /**
     * Holds `FOR UPDATE` on the TeacherRoom row, so the resume's `Class` insert
     * parks on the `FOR KEY SHARE` its FK needs; inserts `collide` itself;
     * commits, releasing the parked insert into the clash.
     */
    async function raceResumeAgainst(collide: Date): Promise<void> {
      const holder = new PrismaClient();
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });

      const holding = holder.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            'SELECT "id" FROM "TeacherRoom" WHERE "id" = $1 FOR UPDATE',
            teacherRoomId,
          );
          await held;
          await tx.class.create({ data: classRow(collide) });
        },
        { timeout: 20_000 },
      );

      await new Promise((r) => setTimeout(r, 150));
      const resuming = pauseOrResumeTemplate(prisma, templateId, teacherId, 'active');

      // Let the resume reach its insert and park on the lock.
      await new Promise((r) => setTimeout(r, 400));
      release();
      await holding;
      await resuming;
      await holder.$disconnect();
    }

    it('leaves isActive committed when the clash lands on the last free date', async () => {
      const now = new Date();
      const dates = candidates(now);
      // Only the last date is free, so the resume issues exactly one insert.
      for (const d of dates.slice(0, 3)) await prisma.class.create({ data: classRow(d) });

      await raceResumeAgainst(dates[3]!);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      expect(after.isActive).toBe(true);
      expect(await prisma.class.count({ where: { templateId } })).toBe(4);
    });

    it('still fills the other free date when the clash lands on the first', async () => {
      const now = new Date();
      const dates = candidates(now);
      for (const d of dates.slice(0, 2)) await prisma.class.create({ data: classRow(d) });

      await raceResumeAgainst(dates[2]!);

      const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
      expect(after.isActive).toBe(true);
      // dates[3] is the one nothing collided with — it must exist.
      expect(await prisma.class.count({ where: { templateId, date: dates[3]! } })).toBe(1);
      expect(await prisma.class.count({ where: { templateId } })).toBe(4);
    });
  });
```

- [ ] **Step 2: Observe both tests fail against the pre-fix generator**

This is the step the whole task exists for. Stash Task 1's production change, keep the tests:

```bash
git stash push -- src/services/class-generator.ts src/lib/generation.ts
```

`git stash` will break compilation of the Task 1 tests. Run only this describe:

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t "a clash during generation"`

Expected, and both must be recorded verbatim in Task 8's ledger:
- test 1 FAILS with `expected false to be true` on `after.isActive` — the silent variant. `$transaction` resolved, `{ ok: true, action: 'active' }` was returned, and the `isActive: true` was rolled back with the aborted transaction.
- test 2 FAILS by **throwing** — the loud variant. `create(dates[2])` raises P2002, `continue` runs, the next candidate's read raises `25P02`, which is not P2002 so it is rethrown past Resume's P2025-only `.catch`.

If either **passes**, stop and report. A pass means the lever did not park the insert (most likely the 400ms window was too short, or the fixture template has a null `teacherRoomId`), and a test that cannot fail against the bug proves nothing.

Restore: `git stash pop`

- [ ] **Step 3: Run the tests against the fixed generator**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS, whole file.

- [ ] **Step 4: Commit**

```bash
git add src/services/class-generator.test.ts
git commit -m "test: the resume that reported success while rolling itself back"
```

---

### Task 3: Studio generator — the same shape

**Files:**
- Modify: `src/services/studio-class-generator.ts:116-214` (docblock, comment, function body), `:266` (sweep call site)
- Test: `src/services/studio-class-generator.test.ts`

**Interfaces:**
- Consumes: `GenerationResult`, `SkippedSlot` from `@/lib/generation` (Task 1).
- Produces: `generateStudioInstancesForTemplate(db, template, from?): Promise<GenerationResult>`.

`StudioClass` has no room FK, and the studio resume **does** take the claim (`claimStudioTemplateForGeneration`, `studio-class-template-lifecycle.ts:352`), so a concurrent insert cannot race it. That asymmetry belongs to #116 and is not fixed here; the studio race test therefore drives the transactional test caller directly and locks the `Teacher` row.

- [ ] **Step 1: Write the failing tests**

Add to `src/services/studio-class-generator.test.ts`, inside the `describe('generateStudioInstancesForTemplate (DB)')` block at `:445` so its fixture is in scope. Adapt the four Task 1 tests to `studioClass`, substituting `cancelledAt` for `status`:

```ts
    it('names a cancelled own instance as blocked_by_cancelled', async () => {
      const now = new Date();
      const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
      expect(first.created).toBe(4);

      const blocked = first.skipped;
      expect(blocked).toEqual([]);

      const rows = await prisma.studioClass.findMany({
        where: { templateId: tpl.id },
        orderBy: { date: 'asc' },
        select: { id: true, date: true },
      });
      await prisma.studioClass.update({
        where: { id: rows[1]!.id },
        data: { cancelledAt: new Date() },
      });

      const again = await generateStudioInstancesForTemplate(prisma, tpl, now);
      expect(again.created).toBe(0);
      expect(again.skipped).toContainEqual({
        date: rows[1]!.date,
        reason: 'blocked_by_cancelled',
      });
    });

    it('skips only the slot another studio class occupies', async () => {
      const now = new Date();
      const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
      const dates = (
        await prisma.studioClass.findMany({
          where: { templateId: tpl.id },
          orderBy: { date: 'asc' },
          select: { date: true },
        })
      ).map((r) => r.date);
      expect(first.created).toBe(4);
      await prisma.studioClass.deleteMany({ where: { templateId: tpl.id } });

      await prisma.studioClass.create({
        data: {
          teacherId: tpl.teacherId,
          templateId: null,
          classType: 'Manual',
          date: dates[1]!,
          startTime: tpl.startTime,
          durationMinutes: 60,
          location: 'Elsewhere',
          hourlyRate: 50,
        },
      });

      const result = await generateStudioInstancesForTemplate(prisma, tpl, now);
      expect(result.created).toBe(3);
      expect(result.skipped).toEqual([{ date: dates[1]!, reason: 'slot_taken' }]);
    });

    it('does not treat a cancelled neighbour as occupying the slot', async () => {
      const now = new Date();
      const first = await generateStudioInstancesForTemplate(prisma, tpl, now);
      const dates = (
        await prisma.studioClass.findMany({
          where: { templateId: tpl.id },
          orderBy: { date: 'asc' },
          select: { date: true },
        })
      ).map((r) => r.date);
      expect(first.created).toBe(4);
      await prisma.studioClass.deleteMany({ where: { templateId: tpl.id } });

      await prisma.studioClass.create({
        data: {
          teacherId: tpl.teacherId,
          templateId: null,
          classType: 'Manual',
          date: dates[1]!,
          startTime: tpl.startTime,
          durationMinutes: 60,
          location: 'Elsewhere',
          hourlyRate: 50,
          cancelledAt: new Date(),
        },
      });

      // #196's studio index carries `WHERE "cancelledAt" IS NULL`.
      const result = await generateStudioInstancesForTemplate(prisma, tpl, now);
      expect(result.created).toBe(4);
      expect(result.skipped).toEqual([]);
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts -t "blocked_by_cancelled"`
Expected: FAIL with `expected undefined to be 4` — the function returns a bare `number`.

- [ ] **Step 3: Rewrite `generateStudioInstancesForTemplate`**

Replace the body of `src/services/studio-class-generator.ts:126-214`, deleting the long `try`/`catch` comment at `:153-208` in full — it documents a hedge that no longer exists:

```ts
export async function generateStudioInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: StudioTemplateWithTimezone,
  from?: Date,
): Promise<GenerationResult> {
  const startDate = from ?? new Date();

  // The next 4 occurrences whose start is still ahead of startDate. Ported from
  // the class family in #94 — the studio side had no such filter, so the hourly
  // sweep could materialise a class that had already started.
  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) > startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  // One query for the whole window. Scoped to this teacher: #196's studio index
  // is `(teacherId, date, startTime) WHERE "cancelledAt" IS NULL`.
  const occupants = await db.studioClass.findMany({
    where: { teacherId: template.teacherId, date: { in: dates } },
    select: { templateId: true, date: true, startTime: true, cancelledAt: true },
  });

  const skipped: SkippedSlot[] = [];
  const free: Date[] = [];

  for (const date of dates) {
    const onDate = occupants.filter((c) => c.date.getTime() === date.getTime());

    const own = onDate.find((c) => c.templateId === template.id);
    if (own) {
      // `@@unique([templateId, date])` ignores cancellation, so a cancelled own
      // row makes the date permanently unfillable rather than already filled.
      // This is the live path #192 was filed about: it runs on every sweep and,
      // before this change, said nothing.
      skipped.push({
        date,
        reason: own.cancelledAt !== null ? 'blocked_by_cancelled' : 'already_generated',
      });
      continue;
    }

    // Mirrors #196's studio index predicate exactly (`WHERE "cancelledAt" IS NULL`).
    if (onDate.some((c) => c.startTime === template.startTime && c.cancelledAt === null)) {
      skipped.push({ date, reason: 'slot_taken' });
      continue;
    }

    free.push(date);
  }

  const inserted =
    free.length === 0
      ? []
      : await db.studioClass.createManyAndReturn({
          data: free.map((date) => ({
            teacherId: template.teacherId,
            templateId: template.id,
            classType: template.classType,
            date,
            startTime: template.startTime,
            durationMinutes: template.durationMinutes,
            location: template.location,
            hourlyRate: template.hourlyRate,
          })),
          skipDuplicates: true,
          select: { date: true },
        });

  const landed = new Set(inserted.map((r) => r.date.getTime()));
  for (const date of free) {
    if (!landed.has(date.getTime())) skipped.push({ date, reason: 'raced' });
  }

  skipped.sort((a, b) => a.date.getTime() - b.date.getTime());
  logSkippedStudioSlots(template.id, template.teacherId, skipped);

  return { created: inserted.length, skipped };
}

/** Studio twin of `logSkippedSlots` (`class-generator.ts`) — see it for the noise rule. */
function logSkippedStudioSlots(
  templateId: string,
  teacherId: string,
  skipped: SkippedSlot[],
): void {
  const blocking = skipped.filter((s) => s.reason !== 'already_generated');
  if (blocking.length === 0) return;

  log.warn(
    {
      templateId,
      teacherId,
      skipped: blocking.map((s) => ({
        date: s.date.toISOString().slice(0, 10),
        reason: s.reason,
      })),
    },
    'studio class generation could not fill every date in the window',
  );
}
```

Replace the docblock at `:116-125` so it describes the new parity — same client union, same optional `from`, **same `GenerationResult`** — and drop any sentence claiming a P2002 hedge. Add `import type { GenerationResult, SkippedSlot } from '@/lib/generation';`.

- [ ] **Step 4: Fix the sweep call site**

`src/services/studio-class-generator.ts:266`:

```ts
          const result = await generateStudioInstancesForTemplate(tx, fresh, startDate);
          return result.created;
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: PASS. Then `npm run typecheck`. Fix the consuming test call sites at `studio-class-generator.test.ts:538,539,562` and `tests/integration/studio-api.test.ts:196` by reading `.created`; `studio-class-template-lifecycle.ts:385` is Task 5's and may read `.created` here to keep the tree compiling.

- [ ] **Step 6: Commit**

```bash
git add src/services/studio-class-generator.ts src/services/studio-class-generator.test.ts tests/integration/studio-api.test.ts src/services/studio-class-template-lifecycle.ts
git commit -m "fix: the studio generator says which dates a cancelled class is holding"
```

---

### Task 4: Class resume reports occupancy

**Files:**
- Modify: `src/services/class-template-lifecycle.ts:355-365` (`PauseTemplateResult`), `:448-518` (resume branch)
- Modify: `src/app/api/class-templates/[id]/route.ts:127-133`
- Test: `src/services/class-template-lifecycle.test.ts`

**Interfaces:**
- Consumes: `GenerationResult` (Task 1).
- Produces: `PauseTemplateResult`'s `active` arm gains `scheduled: number; added: number; blockedByCancelled: number; slotTaken: number`.

- [ ] **Step 1: Write the failing test**

```ts
  it('reports what the window holds when a slot is already taken', async () => {
    // fixture: template paused, one manually created class occupying a candidate slot
    const result = await pauseOrResumeTemplate(prisma, templateId, teacherId, 'active');
    expect(result).toMatchObject({ ok: true, action: 'active', added: 3, slotTaken: 1 });
    if (result.ok && result.action === 'active') {
      expect(result.scheduled).toBe(4); // 3 generated + the manual one
      expect(result.blockedByCancelled).toBe(0);
    }
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t "what the window holds"`
Expected: FAIL — `added` does not exist on the result.

- [ ] **Step 3: Widen the result type**

```ts
  | {
      ok: true;
      action: 'active';
      template: ClassTemplate;
      /**
       * Scheduled classes for this template from the start of the teacher's
       * today onward — the same predicate and boundary `remaining` uses, so
       * archiving and resuming report on one basis. Mirrors the studio
       * family's `scheduled` (#119) exactly.
       */
      scheduled: number;
      /** Rows this resume created. */
      added: number;
      /** Candidate dates a cancelled instance of this template holds (#192). */
      blockedByCancelled: number;
      /** Candidate dates another of this teacher's classes holds (#196). */
      slotTaken: number;
    }
```

- [ ] **Step 4: Compute them in the resume branch**

In the `$transaction` at `:449-462`:

```ts
        const t = await tx.classTemplate.update({
          where: { id: templateId },
          data: { isActive: desiredActive },
          include: { teacher: { select: { defaultTimezone: true } } },
        });
        const generation = t.isActive
          ? await generateInstancesForTemplate(tx, t)
          : { created: 0, skipped: [] };
        return { template: t, generation };
```

After the transaction, on the `desiredActive` path, count with the existing helper and boundary:

```ts
  const today = startOfLocalDay(new Date(), template.teacher.defaultTimezone);
  const scheduled = await prisma.class.count({
    where: scheduledWhere(templateId, { gte: today }),
  });
  return {
    ok: true,
    action: 'active',
    template: template_,
    scheduled,
    added: generation.created,
    blockedByCancelled: generation.skipped.filter((s) => s.reason === 'blocked_by_cancelled').length,
    slotTaken: generation.skipped.filter((s) => s.reason === 'slot_taken').length,
  };
```

Keep the `.catch` P2025 mapping. **Add a line to its docblock at `:470-481`**: it enumerates what the `catch` now covers, and `generateInstancesForTemplate`'s statements have changed from "a `class.findFirst` and an unchecked `class.create`" to a `class.findMany` and a `class.createManyAndReturn` — still P2003 or P2002, never P2025, so the guard's conclusion stands but its enumeration must be updated to match.

- [ ] **Step 5: Convert the route's ternary to a switch**

`src/app/api/class-templates/[id]/route.ts:129-133`. The studio route's own comment records why: a ternary's `else` limb "would have dropped them silently while staying correct for `unchanged`".

```ts
  if (result.ok) {
    switch (result.action) {
      case 'paused':
        return respondOk({
          ...result.template,
          action: result.action,
          lastScheduled: result.lastScheduled,
        });
      case 'active':
        return respondOk({
          ...result.template,
          action: result.action,
          templateKind: 'class' as const,
          scheduled: result.scheduled,
          added: result.added,
          blockedByCancelled: result.blockedByCancelled,
          slotTaken: result.slotTaken,
        });
      case 'unarchived':
      case 'unchanged':
        return respondOk({ ...result.template, action: result.action });
      default: {
        const unhandled: never = result;
        return unhandled;
      }
    }
  }
```

- [ ] **Step 6: Run tests, then commit**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts` → PASS. `npm run typecheck` → clean.

```bash
git add src/services/class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts "src/app/api/class-templates/[id]/route.ts"
git commit -m "feat: resuming a class template reports what the window holds"
```

---

### Task 5: Studio resume carries the skip counts

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts:60-105` (`PauseStudioTemplateResult`), `:385`, `:407-430`
- Modify: `src/app/api/studio-class-templates/[id]/route.ts:117-123`
- Test: `src/services/studio-class-template-lifecycle.test.ts`

**Interfaces:**
- Produces: `PauseStudioTemplateResult`'s `active` arm gains `blockedByCancelled: number; slotTaken: number` beside its existing `scheduled`/`added`.

- [ ] **Step 1: Write the failing test**

```ts
    it('reports the cancelled classes holding the window', async () => {
      // fixture: every candidate date holds a cancelled instance of this template
      const result = await pauseOrResumeStudioTemplate(prisma, templateId, teacherId, 'active');
      expect(result).toMatchObject({
        ok: true,
        action: 'active',
        added: 0,
        scheduled: 0,
        blockedByCancelled: 4,
      });
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts -t "cancelled classes holding"`
Expected: FAIL — `blockedByCancelled` does not exist.

- [ ] **Step 3: Widen the type and thread the counts**

Add to the `active` arm of `PauseStudioTemplateResult`:

```ts
      /** Candidate dates a cancelled instance of this template holds (#192). */
      blockedByCancelled: number;
      /** Candidate dates another of this teacher's studio classes holds (#196). */
      slotTaken: number;
```

At `:385`:

```ts
      const generation = await generateStudioInstancesForTemplate(tx, claimed);
      const added = generation.created;
```

Extend the existing `scheduled === 0` `log.warn` at `:419-424` to carry the reason it can now measure, replacing "every candidate date is blocked" with the counted breakdown — the docblock above it says nobody on the operator side is ever told otherwise, and that is now fixable rather than merely true.

Return the two counts alongside `scheduled` and `added` in the `outcome: 'active'` object at `:429`, and thread them through the mapping to `PauseStudioTemplateResult`.

- [ ] **Step 4: Emit them from the route**

`src/app/api/studio-class-templates/[id]/route.ts`, the `case 'active'` arm:

```ts
      case 'active':
        return respondOk({
          ...result.template,
          action: result.action,
          templateKind: 'studio' as const,
          scheduled: result.scheduled,
          added: result.added,
          blockedByCancelled: result.blockedByCancelled,
          slotTaken: result.slotTaken,
        });
```

- [ ] **Step 5: Run tests, then commit**

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts` → PASS.

```bash
git add src/services/studio-class-template-lifecycle.ts src/services/studio-class-template-lifecycle.test.ts "src/app/api/studio-class-templates/[id]/route.ts"
git commit -m "feat: studio resume measures the cause its copy could only infer"
```

---

### Task 6: The copy, and the brand it replaces

**Files:**
- Modify: `src/components/settings/template-action-messages.ts:160-300`
- Test: `src/components/settings/template-action-messages.test.ts`

**Interfaces:**
- Consumes: the route payloads from Tasks 4 and 5.
- Produces: `resumeMessage(added, scheduled, blockedByCancelled, slotTaken): string`; `resumeStudioMessage` gains the same two trailing parameters.

`TemplateToggleResponse`'s `active` arm currently carries `scheduled?: never; added?: never`, and that brand is the only thing making the two response types non-interchangeable — PR review measured two live slips it catches (#119 and #93). Giving the class arm real counts makes both arms structurally identical, so the brand must be **replaced, not deleted**.

- [ ] **Step 1: Write the failing tests**

```ts
describe('resumeMessage (class)', () => {
  it('says nothing extra when the window filled', () => {
    expect(resumeMessage(4, 4, 0, 0)).toBe('4 classes on your schedule.');
  });

  it('names a taken slot rather than leaving a smaller number unexplained', () => {
    expect(resumeMessage(3, 4, 0, 1)).toBe(
      '4 classes on your schedule. 1 date already had a class.',
    );
  });

  it('names the cancelled classes still holding an empty window', () => {
    expect(resumeMessage(0, 0, 4, 0)).toBe(
      'Nothing is scheduled from this template. 4 cancelled classes still hold those dates.',
    );
  });

  it('stays silent about cause when there is none to name', () => {
    expect(resumeMessage(0, 0, 0, 0)).toBe('Nothing is scheduled from this template.');
  });
});

describe('the two toggle payloads are not interchangeable', () => {
  it('rejects a studio payload at the class resolver', () => {
    const studio: StudioTemplateToggleResponse = {
      action: 'active',
      templateKind: 'studio',
      scheduled: 4,
      added: 0,
      blockedByCancelled: 0,
      slotTaken: 0,
    };
    // @ts-expect-error studio payloads must never satisfy the class resolver
    resolveTemplateConfirmation(studio);
    // and the reverse
    const cls: TemplateToggleResponse = {
      action: 'active',
      templateKind: 'class',
      scheduled: 4,
      added: 0,
      blockedByCancelled: 0,
      slotTaken: 0,
    };
    // @ts-expect-error class payloads must never satisfy the studio resolver
    resolveStudioConfirmation(cls);
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project components src/components/settings/template-action-messages.test.ts`
Expected: FAIL — `resumeMessage` is not exported.

- [ ] **Step 3: Replace the brand with a discriminator**

```ts
export type TemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | {
      action: 'active';
      templateKind: 'class';
      scheduled: number;
      added: number;
      blockedByCancelled: number;
      slotTaken: number;
    }
  | { action: 'unarchived' | 'unchanged' };
```

with the studio type identical except `templateKind: 'studio'`. Replace the brand paragraph in the docblock: the `scheduled?: never; added?: never` phantom did this job until the class family's resume gained counts of its own — the case its own text predicted — and no phantom can separate two structurally identical arms. A union is assignable only if every arm is, so one non-assignable arm still protects the whole type in both directions. `templateKind` is checkable at runtime too, which the phantom was not, and both resolvers already distrust the wire.

- [ ] **Step 4: Write the messages**

```ts
/**
 * The class family's resume sentence. Parallel to `resumeStudioMessage` and
 * separate from it for the reason `resolveTemplateConfirmation` records: the
 * two families are kept parallel-but-separate rather than parameterised.
 *
 * The cause clauses are measurements, not inferences. Until #164/#192 the
 * generator returned a bare count, so naming a cause here would have encoded a
 * guess about generator internals — which is exactly why the studio sibling
 * declined to. `blockedByCancelled` and `slotTaken` are now counted by the
 * generator and carried over the wire, so the sentence can say what happened.
 */
export function resumeMessage(
  added: number,
  scheduled: number,
  blockedByCancelled: number,
  slotTaken: number,
): string {
  if (scheduled === 0) {
    if (blockedByCancelled === 0) return 'Nothing is scheduled from this template.';
    const cancelledWord = blockedByCancelled === 1 ? 'class' : 'classes';
    return `Nothing is scheduled from this template. ${blockedByCancelled} cancelled ${cancelledWord} still hold those dates.`;
  }

  const classWord = scheduled === 1 ? 'class' : 'classes';
  const head = `${scheduled} ${classWord} on your schedule.`;

  if (slotTaken > 0) {
    const dateWord = slotTaken === 1 ? 'date' : 'dates';
    return `${head} ${slotTaken} ${dateWord} already had a class.`;
  }
  return added === 0 ? `${head} Nothing needed adding.` : head;
}
```

Give `resumeStudioMessage` the same two trailing parameters and the same three new branches, keeping its existing delta-first argument order and its "no verb after the count" rule.

- [ ] **Step 5: Wire both resolvers**

In `resolveTemplateConfirmation`, add an `active` case guarded the way the studio one already is — the `Number.isInteger` check exists because "the type constrains the server and nothing constrains the wire". Update `resolveStudioConfirmation`'s `active` case to pass the two new counts, extending its existing integer check to cover them.

- [ ] **Step 6: Run all three projects, then commit**

Run: `npx vitest run --project components` → PASS. `npm run typecheck` → clean; if either `@ts-expect-error` reports "unused", the discriminator is not doing its job — stop and report.

```bash
git add src/components/settings/template-action-messages.ts src/components/settings/template-action-messages.test.ts
git commit -m "feat: the resume sentence names a cause it can now measure"
```

---

### Task 7: The claims this change makes false

**Files:**
- Verify/modify: `docs/lock-order.md`, `docs/technical-architecture.md`
- Modify: `docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md` if any §8 item turns out different from predicted

- [ ] **Step 1: Check `docs/lock-order.md` against the change, do not assume**

`:94` states `create`/`createMany` are deliberately outside the candidate set because "a freshly inserted row's lock conflicts with nothing". Confirm that N `create`s → one `createManyAndReturn` therefore changes nothing there, and that the new `findMany` (a read, no locks under READ COMMITTED) adds no edge. Re-read `:511-512`, which names the generator in a known-violation entry, and confirm it still reads true. Record the verdict in the file only if something changed; a doc that needed no change is a finding for the PR body, not an edit.

- [ ] **Step 2: Grep the repo for the claims this branch falsified**

```bash
grep -rn "P2002" src docs --include='*.ts' --include='*.tsx' --include='*.md'
grep -rn "P2002-skip\|idempotently" src docs
```

Every surviving mention must either describe a path that still exists or be corrected. The spec's §8 lists the ones predicted; treat anything else the grep finds as a miss in the spec and fix both.

- [ ] **Step 3: Post the §5.1 correction to #196**

#196's spec §5.1 says the pre-check's race "still aborts, as it does today" and that the route maps the resulting P2002 to a 409. With a bare `ON CONFLICT DO NOTHING` behind it there is no P2002 from the generator. Write the correction to a file and post it — **never** `--body "…"`, because backticks in a double-quoted zsh string are command substitution and fail silently:

```bash
gh issue comment 196 --body-file /tmp/196-correction.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: the claims a bare ON CONFLICT makes false"
```

---

### Task 8: Prove every guard bites

**Files:**
- Create: `docs/superpowers/plans/2026-08-11-generator-slot-reporting-mutations.md`

Follow the ledger format of `docs/superpowers/plans/2026-08-11-cancellation-notice-names-class-mutations.md`: a table of `| # | Guard | Mutation | Test that failed | Observed |`, with the **verbatim** assertion text in `Observed`. A guard that compiles but cannot fail certifies nothing.

For each row: apply the mutation, run the named test, record the exact error, `git checkout` the file, re-run to confirm green.

- [ ] **Step 1: Run all eight mutations**

| # | Guard | Mutation |
|---|---|---|
| 1 | `ON CONFLICT` backstop | restore the per-date `create` + `catch (P2002) { continue }` loop → Task 2's two tests must fail, the second by **throwing 25P02** specifically, not merely by counting wrong |
| 2 | `slot_taken` clause | delete the `onDate.some(...)` branch → the manual-class test must fail with `expected 4 to be 3` |
| 3 | predicate mirror (class) | drop `&& c.status !== 'cancelled'` → the cancelled-neighbour test must fail |
| 4 | predicate mirror (studio) | drop `&& c.cancelledAt === null` → the studio cancelled-neighbour test must fail |
| 5 | `blocked_by_cancelled` | return `'already_generated'` for a cancelled own row → #192's tests must fail in both families |
| 6 | `raced` | delete the `landed` diff loop → Task 2's `skipped` reason assertion must fail |
| 7 | noise rule | drop the `s.reason !== 'already_generated'` filter → the "stays silent" assertion must fail |
| 8 | `templateKind` | delete it from `StudioTemplateToggleResponse` → `tsc` must fail with "Unused '@ts-expect-error' directive" |

- [ ] **Step 2: Record what mutation 1 proved, in both directions**

Mutation 1 is the whole issue. Its two observations belong in the ledger verbatim, because they are the difference between the loud and the silent variant — and the silent one is what made this issue user-visible rather than a debuggability nit.

- [ ] **Step 3: Ask what a plausible regression looks like, not what is easy to mutate**

For each guard, before moving on, state in the ledger whether the mutation used is the *realistic* regression. #185 shipped a test proved against a constant that stayed blind to the narrow-range regression that had actually occurred. If a guard's only mutation is a wholesale revert, add a single-clause one.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-generator-slot-reporting-mutations.md
git commit -m "docs: eight mutations, each watched to fail"
```

---

### Task 9: Verify and open the PR

- [ ] **Step 1: Run the full gate**

Run: `npm run verify`
Expected: typecheck clean, lint clean, all three vitest projects green. Needs the app live on :3000 — a wall of `ECONNREFUSED` means it is not, which is the user's to restart, not yours.

Record the project totals (e.g. `N = a unit + b components + c integration`); the PR body states them as arithmetic, which is what turns "every integration file ran" into a checkable claim.

- [ ] **Step 2: Push and open the PR**

Body must state: what was measured and where the errors were, **including the spec's own** (§5's call-site claim, corrected in Task 1 step 7); which inherited claims were checked and which held (#164's reachability table row 3 — **wrong**; #164's silent-commit claim — **right**, and newly measured); the arithmetic behind every number; what this PR does *not* do (write "**#116 is unaffected**", "**#196 is unaffected**" — never `does not close #N`); and the integration files touched, by path.

```bash
git push -u origin fix/164-192-generator-slot-reporting
gh pr create --title "Both generators report the dates they could not fill (#164, #192)" --body-file /tmp/pr-body.md
```

- [ ] **Step 3: Multi-agent review**

`/pr-review-toolkit:review-pr <N>` — code, tests, comments, silent-failure, and **type-design** (the payload discriminator and the four-member `SkipReason` union are genuinely the subject here, so it earns its place). Give each reviewer the specific risk: for silent-failure, that a skipped date is a silent short window by construction; for type-design, whether `templateKind` actually restores what the phantom brand did.

## Self-Review

**Spec coverage:** §3 result shape → Task 1 step 1. §4 algorithm → Tasks 1, 3. §4.1 predicate mirror → Tasks 1, 3 + mutations 3, 4. §5 call sites → Tasks 1, 3 (and its own correction, Task 1 step 7). §6 logging + noise → Tasks 1, 3 + mutation 7. §7 copy → Task 6. §7.3 brand → Task 6 + mutation 8. §8 corrections → Task 7. §9.1 T1/T2 → Task 2. §9.2 → Tasks 1, 3, 6. §9.3 → Task 8. §11 acceptance → Task 9.

**Type consistency:** `GenerationResult { created, skipped }` is used identically in Tasks 1, 3, 4, 5. `SkipReason`'s four members are spelled the same in the type, both generators, both filters, and the mutation table. `blockedByCancelled` / `slotTaken` are camelCase on the wire and in both result types; the generator's reasons stay snake_case literals — deliberate, and the mapping happens once per family in Tasks 4 and 5.

**Known gap:** Task 4 and Task 5's step-1 tests describe their fixtures in prose rather than code, because both files' existing fixtures are set up in `beforeAll` blocks whose variable names the implementer will have in front of them. Every other test in this plan is written out in full.
