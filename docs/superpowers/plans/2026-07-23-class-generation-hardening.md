# Class-generation Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make class-template creation atomic (generate the window inside the create transaction, template-scoped) and give the cron sweep per-template + per-generator failure isolation (issues #55, #56).

**Architecture:** Extract a template-scoped `generateInstancesForTemplate` from `generateClassInstances`; the routes call it inside a `$transaction` (rollback on failure); the cron's teacher-wide `generateClassInstances` wraps each template in try/catch; the scheduler isolates class-gen from studio-gen.

**Tech Stack:** Next.js route handlers, Prisma (`$transaction`, `Prisma.TransactionClient`), TypeScript strict, Vitest.

## Global Constraints

- TypeScript `strict`: no `any` in shipped `src/` (test stubs may cast via `as unknown as PrismaClient`); `tsc --noEmit` clean.
- Decision (recorded in spec): **consistency over availability** — a generation failure blocks template creation with a propagated 500, nothing persisted. No swallow, no `instancesCreated` field, no new `ClassTemplate` unique constraint.
- Idempotency preserved: `@@unique([templateId, date])` + P2002-skip is the real guard; keep it.
- `generateClassInstances(db, from?, teacherId?)` keeps its signature (cron caller unchanged) — only its `db` type widens and its loop body changes.
- Existing tests must stay green: 6 `generateClassInstances (DB)` tests, and both `class-templates-api` happy-path tests (success still 201s with the window present).
- Integration/DB tests run against the app+DB on `localhost:3000` (health `curl` → 200). If `signup-api.test.ts` 429s, that's the known local rate limiter, not this change.

---

### Task 1: Template-scoped generator + per-template isolation (`class-generator.ts`)

**Files:**
- Modify: `src/services/class-generator.ts`
- Test: `src/services/class-generator.test.ts`

**Interfaces:**
- Produces: `generateInstancesForTemplate(db: PrismaClient | Prisma.TransactionClient, template: TemplateWithTimezone, from?: Date): Promise<number>` and unchanged-signature `generateClassInstances(db: PrismaClient | Prisma.TransactionClient, from?: Date, teacherId?: string): Promise<number>` (now isolates per template). `TemplateWithTimezone = Prisma.ClassTemplateGetPayload<{ include: { teacher: { select: { defaultTimezone: true } } } }>`.

- [ ] **Step 1: Add the `log` import** to `src/services/class-generator.ts` (after the existing imports): `import { log } from '@/lib/log';`

- [ ] **Step 2: Write the failing isolation unit test** in `src/services/class-generator.test.ts` (new `describe`, after the existing DB describe). It dependency-injects a stub db — no real DB:

```ts
describe('generateClassInstances (per-template isolation)', () => {
  function tmpl(id: string, teacherId: string) {
    return {
      id, teacherId, teacherRoomId: 'tr', dayOfWeek: 0, startTime: '09:00',
      classType: 'Flow', description: null, durationMinutes: 60,
      roomCost: 10, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 8,
      cancelDeadline: 120, autoCancelCheck: 120,
      teacher: { defaultTimezone: 'UTC' },
    };
  }

  it('a failing template does not abort the others, and the error is rethrown', async () => {
    const created: string[] = [];
    const from = new Date('2099-01-05T00:00:00Z'); // deterministic future window
    const stub = {
      classTemplate: { findMany: async () => [tmpl('A', 't1'), tmpl('B', 't1')] },
      class: {
        findFirst: async () => null,
        create: async ({ data }: { data: { templateId: string } }) => {
          if (data.templateId === 'A') throw new Error('boom-A');
          created.push(data.templateId);
          return {};
        },
      },
    } as unknown as import('@prisma/client').PrismaClient;

    await expect(generateClassInstances(stub, from)).rejects.toThrow('boom-A');
    expect(created).toContain('B'); // B generated despite A failing first
  });
});
```

- [ ] **Step 3: Run it — expect FAIL** (`generateInstancesForTemplate`/isolation not present yet):

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t "isolation"`
Expected: FAIL — the current loop rethrows `boom-A` before reaching template B, so `created` is empty (`expect(created).toContain('B')` fails), or the shape differs.

- [ ] **Step 4: Extract `generateInstancesForTemplate` and rewrite `generateClassInstances`.** Replace the whole current `generateClassInstances` (lines ~68–155) with:

```ts
type TemplateWithTimezone = Prisma.ClassTemplateGetPayload<{
  include: { teacher: { select: { defaultTimezone: true } } };
}>;

/**
 * Generates the rolling 4-week window for ONE template, idempotently
 * (`@@unique([templateId, date])` + P2002-skip). Accepts a transaction
 * client so a route can create the template and its window atomically.
 */
export async function generateInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: TemplateWithTimezone,
  from?: Date,
): Promise<number> {
  const startDate = from ?? new Date();
  let created = 0;

  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) >
        startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  for (const date of dates) {
    const existing = await db.class.findFirst({ where: { templateId: template.id, date } });
    if (existing) continue;

    try {
      await db.class.create({
        data: {
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
          status: 'open',
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
}

/**
 * Cron entry point: tops up the rolling window for all active templates
 * (or one teacher's). Each template is isolated — one template whose
 * generation throws is logged and skipped, the rest still generate, and
 * the first error is rethrown at the end for job-health visibility.
 */
export async function generateClassInstances(
  db: PrismaClient | Prisma.TransactionClient,
  from?: Date,
  teacherId?: string,
): Promise<number> {
  const startDate = from ?? new Date();

  const templates = await db.classTemplate.findMany({
    where: { isActive: true, isArchived: false, ...(teacherId ? { teacherId } : {}) },
    include: { teacher: { select: { defaultTimezone: true } } },
  });

  let totalCreated = 0;
  const errors: unknown[] = [];

  for (const template of templates) {
    try {
      totalCreated += await generateInstancesForTemplate(db, template, startDate);
    } catch (err) {
      log.error(
        { err, templateId: template.id, teacherId: template.teacherId },
        'class generation failed for template',
      );
      errors.push(err);
    }
  }

  if (errors.length > 0) throw errors[0];
  return totalCreated;
}
```

- [ ] **Step 5: Run the isolation test + the existing DB tests — expect PASS**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: all pass — the new isolation test plus the 6 existing `generateClassInstances (DB)` tests (signature unchanged, behavior identical for the success path).

- [ ] **Step 6: tsc + eslint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0. (`Prisma.TransactionClient` and `Prisma.ClassTemplateGetPayload` resolve; `log` is used.)

- [ ] **Step 7: Commit**

```bash
git commit -am "refactor: template-scoped generator + per-template isolation (#55, #56)

Extract generateInstancesForTemplate (accepts a TransactionClient) and make
generateClassInstances isolate each template — one failing template no longer
aborts the sweep; the first error still rethrows for job health. New stubbed-db
isolation unit test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Transactional routes + rollback test (`class-templates`)

**Files:**
- Modify: `src/app/api/class-templates/route.ts` (POST)
- Modify: `src/app/api/class-templates/[id]/route.ts` (PATCH pause→active)
- Test: `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Consumes: `generateInstancesForTemplate` from Task 1.

- [ ] **Step 1: Write the failing rollback integration test** in `tests/integration/class-templates-api.test.ts`. Add an import `import { generateInstancesForTemplate } from '@/services/class-generator';` and, inside the `POST` describe (reusing its `teacherId`/`teacherRoomId` fixtures), add:

```ts
it('a generation failure rolls the whole create back — no template, no instances', async () => {
  const before = await prisma.classTemplate.count({ where: { teacherId } });

  await expect(
    prisma.$transaction(async (tx) => {
      const created = await tx.classTemplate.create({
        data: {
          teacherId, teacherRoomId, classType: 'Rollback', dayOfWeek: 2,
          startTime: '09:00', durationMinutes: 60, roomCost: 10, minRate: 10,
          targetRate: 20, minStudents: 1, maxStudents: 8, cancelDeadline: 120,
          autoCancelCheck: 120,
        },
        include: { teacher: { select: { defaultTimezone: true } } },
      });
      // Deterministic FK failure (P2003, not the swallowed P2002): bogus room.
      await generateInstancesForTemplate(tx, {
        ...created,
        teacherRoomId: '00000000-0000-4000-8000-000000000000',
      });
      return created;
    }),
  ).rejects.toThrow();

  const after = await prisma.classTemplate.count({ where: { teacherId } });
  expect(after).toBe(before);
});
```

- [ ] **Step 2: Run it — expect PASS already** (this test asserts the transaction+service contract Task 1 delivered; it does not depend on the route changes):

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts -t "rolls the whole create back"`
Expected: PASS — the bogus `teacherRoomId` makes `class.create` throw P2003 inside the real `$transaction`, which rolls the template create back, so `after === before`. (If it unexpectedly fails, STOP and report — the transaction/rollback assumption is wrong.)

- [ ] **Step 3: Make POST transactional** in `src/app/api/class-templates/route.ts`. Replace the `create` + swallow block (from `const template = await prisma.classTemplate.create({…})` through the `try/catch` and its comments) with:

```ts
const template = await prisma.$transaction(async (tx) => {
  const created = await tx.classTemplate.create({
    data: {
      teacherId: session.teacherId,
      teacherRoomId: body.teacherRoomId,
      classType: body.classType,
      description: body.description,
      dayOfWeek: body.dayOfWeek,
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      roomCost: body.roomCost,
      minRate: body.minRate,
      targetRate: body.targetRate,
      minStudents: body.minStudents,
      maxStudents: body.maxStudents,
      cancelDeadline: body.cancelDeadline,
      autoCancelCheck: body.autoCancelCheck,
    },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  await generateInstancesForTemplate(tx, created);
  return created;
});

return respondOk(template, 201);
```
Update the import: replace `generateClassInstances` with `generateInstancesForTemplate` from `@/services/class-generator`. Remove the now-unused `log` import if nothing else uses it in this file (check).

- [ ] **Step 4: Make PATCH pause→active transactional** in `src/app/api/class-templates/[id]/route.ts`. Replace the `const updated = await prisma.classTemplate.update({…})` + the `if (updated.isActive) { try {…} catch {…} }` block with:

```ts
const updated = await prisma.$transaction(async (tx) => {
  const t = await tx.classTemplate.update({
    where: { id },
    data: { isActive: !template.isActive },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (t.isActive) await generateInstancesForTemplate(tx, t);
  return t;
});
```
Then continue to whatever the route returns (`respondOk(updated)` — strip the `teacher` include only if the pre-change response shape must match; the existing test asserts `updated.isActive`, which is present either way — keep it simple and return `updated`). Swap the import `generateClassInstances` → `generateInstancesForTemplate`; remove the now-unused `log` import if unused elsewhere in the file.

- [ ] **Step 5: Run the class-templates integration tests — expect PASS**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: all pass — the two happy-path tests (create materializes the window; re-activation tops it up) plus the archived-toggle refusal plus the new rollback test. Success still 201s with instances present.

- [ ] **Step 6: tsc + eslint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0 — no unused imports left behind (`generateClassInstances`, `log` removed from the routes if unused).

- [ ] **Step 7: Commit**

```bash
git commit -am "refactor: atomic template creation — generate in the create txn (#56)

POST and PATCH pause→active now create/toggle the template and generate its
window in one transaction; a generation failure rolls the whole thing back and
propagates (500) instead of the log-and-201 swallow. Deletes both 'do not
simplify' catches. New real-transaction rollback integration test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Scheduler isolation (`scheduler.ts`)

**Files:**
- Modify: `src/lib/scheduler.ts` (the `class-generation` job)

- [ ] **Step 1: Isolate the two generators.** In the `class-generation` job, replace:

```ts
run: async (db) => {
  await generateClassInstances(db);
  await generateStudioClassInstances(db);
},
```
with the same per-sweep isolation the `class-transitions` job uses:

```ts
run: async (db) => {
  const sweeps = [generateClassInstances, generateStudioClassInstances];
  const errors: unknown[] = [];
  for (const sweep of sweeps) {
    try {
      await sweep(db);
    } catch (err) {
      log.error({ err, sweep: sweep.name }, 'class-generation sweep failed');
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
},
```
(`log` is already imported in `scheduler.ts`.) This ensures a class-template generation failure (which now rethrows at the end of `generateClassInstances`) no longer starves studio-class generation.

- [ ] **Step 2: tsc + eslint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git commit -am "fix: isolate class-gen from studio-gen in the scheduler (#55)

A class-template generation failure rethrows at the end of the sweep; without
isolation that skipped studio-class generation. Mirror the class-transitions
job's per-sweep try/catch so one generator's failure can't starve the other.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification + PR

**Files:** none (git/gh only).

- [ ] **Step 1: Full suite** (dev server on :3000):

Run: `npx tsc --noEmit && npx eslint src tests && npx vitest run && npx playwright test class`
Expected: `tsc`/`eslint` clean; full vitest green incl. the two new tests; class-related e2e green. (Known: `signup-api.test.ts` 429s are the local rate limiter — CI runs fresh.)

- [ ] **Step 2: Push + open PR** (closes #55 and #56)

```bash
git push -u origin refactor/class-generation-hardening
gh pr create --title "refactor: class-generation hardening — atomic template creation + per-template isolation (#55, #56)" --body "$(cat <<'BODY'
Closes #55. Closes #56. Spec: docs/superpowers/specs/2026-07-23-class-generation-hardening-design.md

## Summary
- **#56 atomic creation:** POST /api/class-templates and PATCH pause→active now create/toggle the template and generate its 4-week window in ONE transaction (new template-scoped generateInstancesForTemplate). A generation failure rolls the whole thing back and propagates a 500 — no more log-and-201 swallow, no template-without-instances state. Deletes both "do not simplify" catches.
- **#55 per-template isolation:** generateClassInstances isolates each template (log templateId+teacherId, continue, rethrow first at end), and the scheduler isolates class-gen from studio-gen — one failing template can no longer abort every teacher's window or starve studio generation.

## Decision
Consistency over availability for template creation (recorded in the spec): a generator failure blocks creation with a visible, retryable error rather than silently saving a template that produces no classes.

## Tests
New stubbed-db isolation unit test + real-transaction rollback integration test (the failure-injection pattern #55 called for). Existing generator + class-template suites carry over unchanged. Full vitest + class e2e green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 3: Report the PR URL. Do NOT merge — leave open for review.**

---

## Self-Review

**Spec coverage:** template-scoped generator + isolation (Task 1); transactional POST/PATCH + swallow removal + rollback test (Task 2); scheduler isolation (Task 3); verification + PR (Task 4). The consistency-over-availability decision is realized by Task 2's propagate-not-swallow. Both new tests (isolation unit, rollback integration) are present.

**Placeholder scan:** none — every code step shows complete code; every test step shows the assertion.

**Type consistency:** `generateInstancesForTemplate(db: PrismaClient | Prisma.TransactionClient, template: TemplateWithTimezone, from?)` and `generateClassInstances(db: PrismaClient | Prisma.TransactionClient, from?, teacherId?)` are used identically in Task 1's definition and Tasks 2/3's call sites; `TemplateWithTimezone` is the `include` shape both the routes' `create`/`update` and the cron's `findMany` produce.
