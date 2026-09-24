# Class Economic Invariants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop partial class/template edits from storing economics that break the three cross-field rules, and back six economic invariants with Postgres `CHECK` constraints.

**Architecture:** One pure predicate (`src/lib/class-economics.ts`) states the three cross-field rules once. The create schemas, both forms, and both update services call it. The services run it on the stored row with the edit applied, under the row lock they already hold, before the write. A hand-written migration adds `CHECK`s to `Class` and `ClassTemplate` as a backstop for writers that skip the service.

**Tech Stack:** Next.js 16 route handlers, Prisma 6, PostgreSQL, Zod 4, Vitest (`unit`, `components`, `integration` projects).

**Spec:** `docs/superpowers/specs/2026-09-24-class-economic-invariants-design.md`. Read §1.4 (the `minStudents: 0` fixtures), §2 (decisions), and §3.2 (ordering) before any task.

## Global Constraints

- TypeScript `strict`; no `any`, no casts to widen a type past a guard.
- A merged-row violation answers **400** with the message `violations.map((v) => \`${v.path}: ${v.message}\`).join(', ')`. No new `api-error-codes.ts` entry.
- Server messages are exactly: `minStudents cannot exceed maxStudents` / `minRate cannot exceed targetRate` / `minRate cannot subsidize more than the room cost — prices would go negative`.
- Form copy stays: `Min students cannot exceed max students` / `Min rate cannot exceed target rate` / `Min rate cannot subsidize more than the room cost — prices would go negative`.
- The database floor for `minStudents` is **0**, and Zod keeps `>= 1`. Never write a constraint `minRate >= 0`.
- Comment discipline (CLAUDE.md): no counts or rosters in comments, no "this used to say". Anything about the migration's reasoning goes in `docs/data-model.md`, never in the migration file.
- Stage exact paths; never `git add -A`. Commit messages end with the `Co-Authored-By` line from the session's attribution rule.
- Test runs: `pnpm exec vitest run --project unit <path>`, `--project components <path>`, and for integration `pnpm exec vitest run --project integration <path>` against the worktree app (`pnpm run worktree:up` first; the worktree already has `worktree:setup` done). Never touch a dev server on :3000.

**Task order is load-bearing.** Tasks 2 and 3 must land before Task 5. Task 5's constraints turn an unchecked invalid write into a 500, so Tasks 2 and 3's "refused with 400, row unchanged" tests are what prove the service check runs *before* the write. Task 5 re-runs them with the constraints in place.

---

### Task 1: The shared predicate, and the schemas that use it

**Files:**
- Create: `src/lib/class-economics.ts`
- Create: `src/lib/class-economics.test.ts`
- Modify: `src/lib/schemas.ts` (`createClassSchema`, `updateClassSchema`, `createClassTemplateSchema`, `updateClassTemplateSchema`)
- Modify: `src/lib/schemas.test.ts` (the `updateClassSchema` describe block)

**Interfaces:**
- Produces:
  ```ts
  export type ClassEconomics = {
    roomCost: number; minRate: number; targetRate: number;
    minStudents: number; maxStudents: number;
  };
  export type EconomicsRule = 'students_order' | 'rate_order' | 'room_subsidy';
  export type EconomicsViolation = {
    rule: EconomicsRule;
    path: keyof ClassEconomics;
    message: string;
  };
  export function economicsViolations(e: ClassEconomics): readonly EconomicsViolation[];
  export function formatEconomicsViolations(vs: readonly EconomicsViolation[]): string;
  ```
  `formatEconomicsViolations` returns `vs.map((v) => \`${v.path}: ${v.message}\`).join(', ')`, which both routes use (Tasks 2 and 3). The module imports nothing, because client components import it (Task 4).

- [ ] **Step 1: Write the failing unit tests** in `src/lib/class-economics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { economicsViolations, formatEconomicsViolations, type ClassEconomics } from './class-economics';

const valid: ClassEconomics = { roomCost: 35, minRate: 15, targetRate: 25, minStudents: 4, maxStudents: 12 };

describe('economicsViolations', () => {
  it('returns nothing for a valid row', () => {
    expect(economicsViolations(valid)).toEqual([]);
  });

  it('allows each boundary with equality', () => {
    expect(economicsViolations({ ...valid, minStudents: 12, maxStudents: 12 })).toEqual([]);
    expect(economicsViolations({ ...valid, minRate: 25, targetRate: 25 })).toEqual([]);
    expect(economicsViolations({ ...valid, minRate: -35 })).toEqual([]); // subsidises exactly the room
  });

  it('refuses one past each boundary, naming the rule, path and message', () => {
    expect(economicsViolations({ ...valid, minStudents: 13 })).toEqual([
      { rule: 'students_order', path: 'minStudents', message: 'minStudents cannot exceed maxStudents' },
    ]);
    expect(economicsViolations({ ...valid, minRate: 26 })).toEqual([
      { rule: 'rate_order', path: 'minRate', message: 'minRate cannot exceed targetRate' },
    ]);
    expect(economicsViolations({ ...valid, minRate: -35.01 })).toEqual([
      {
        rule: 'room_subsidy',
        path: 'minRate',
        message: 'minRate cannot subsidize more than the room cost — prices would go negative',
      },
    ]);
  });

  it('reports every broken rule, in rule order', () => {
    const vs = economicsViolations({ roomCost: 10, minRate: -20, targetRate: -30, minStudents: 5, maxStudents: 2 });
    expect(vs.map((v) => v.rule)).toEqual(['students_order', 'rate_order', 'room_subsidy']);
  });

  it('formats like parseBody formats Zod issues', () => {
    const vs = economicsViolations({ ...valid, minStudents: 13, minRate: 26 });
    expect(formatEconomicsViolations(vs)).toBe(
      'minStudents: minStudents cannot exceed maxStudents, minRate: minRate cannot exceed targetRate',
    );
  });
});
```

Also add to `src/lib/schemas.test.ts`: create schemas still report all broken rules (both issues present when min>max and minRate>targetRate), and update schemas **accept** a partial inversion now (`updateClassSchema.safeParse({ minRate: 30, targetRate: 20 }).success === true`, same for `updateClassTemplateSchema`), because the check moved to the service. Replace the existing `'rejects economic inversions when both sides are present'` test with that new expectation, and rename it to say why: the rule is checked on the merged row in the service (#221). Keep the `'accepts partial payloads'` test, but drop its comment's reference to "undefined guards on refinements", which no longer exist; state instead that economic fields are optional.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run --project unit src/lib/class-economics.test.ts src/lib/schemas.test.ts`
Expected: FAIL. The module doesn't exist yet, and the update-schema test fails because the partial refines still reject.

- [ ] **Step 3: Implement `src/lib/class-economics.ts`**

```ts
/**
 * The three rules a class's economics must satisfy together. Stated once:
 * the create schemas, the edit forms, and both update services call this,
 * the services on the stored row with the edit applied (#221). The same rules
 * are `CHECK` constraints on `Class` and `ClassTemplate`; see
 * `docs/data-model.md`.
 *
 * Imports nothing: client components import it.
 */
export type ClassEconomics = {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
};

export type EconomicsRule = 'students_order' | 'rate_order' | 'room_subsidy';

export type EconomicsViolation = {
  rule: EconomicsRule;
  path: keyof ClassEconomics;
  message: string;
};

/** Every rule `e` breaks, in rule order; empty when it breaks none. */
export function economicsViolations(e: ClassEconomics): readonly EconomicsViolation[] {
  const out: EconomicsViolation[] = [];
  if (e.minStudents > e.maxStudents) {
    out.push({ rule: 'students_order', path: 'minStudents', message: 'minStudents cannot exceed maxStudents' });
  }
  if (e.minRate > e.targetRate) {
    out.push({ rule: 'rate_order', path: 'minRate', message: 'minRate cannot exceed targetRate' });
  }
  // Negative minRate is supported (the teacher subsidises the room); this
  // bounds the subsidy at the room cost, never at zero.
  if (e.minRate < -e.roomCost) {
    out.push({
      rule: 'room_subsidy',
      path: 'minRate',
      message: 'minRate cannot subsidize more than the room cost — prices would go negative',
    });
  }
  return out;
}

/** The `path: message` list `parseBody` builds from Zod issues. */
export function formatEconomicsViolations(vs: readonly EconomicsViolation[]): string {
  return vs.map((v) => `${v.path}: ${v.message}`).join(', ');
}
```

- [ ] **Step 4: Rewire the schemas** in `src/lib/schemas.ts`

In both create schemas, replace the three `.refine(...)` calls with:

```ts
  .superRefine((d, ctx) => {
    for (const v of economicsViolations(d)) {
      ctx.addIssue({ code: 'custom', message: v.message, path: [v.path] });
    }
  });
```

In both update schemas, delete the two `.refine(...)` calls after `.strict()`, and put one line in their place stating where the rule is checked:
`// Cross-field economics are checked on the merged row by the update service (economicsViolations).`
Import `economicsViolations` from `@/lib/class-economics`.

Check with `pnpm exec tsc --noEmit` that `createClassSchema.shape` (used by `schemas.test.ts`) still type-checks after `.superRefine`. In Zod 4 it should. If it doesn't, report it rather than restructuring.

- [ ] **Step 5: Run and see them pass**

Run: `pnpm exec vitest run --project unit src/lib/class-economics.test.ts src/lib/schemas.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutation proof** (record exact failure text in the task report)
  - Change `>` to `>=` in the `students_order` check: the equality-boundary test goes red. Restore.
  - Delete the `room_subsidy` block: the refusal test goes red. Restore.
  - Remove the `.superRefine` from `createClassSchema`: the create-schema test goes red. Restore.
  - `git status --short` shows only this task's intended files.

- [ ] **Step 7: Commit**

```bash
git add src/lib/class-economics.ts src/lib/class-economics.test.ts src/lib/schemas.ts src/lib/schemas.test.ts
git commit -m "feat(economics): state the three cross-field class rules once; update schemas defer to the service (#221)"
```

---

### Task 2: `updateClass` checks the merged row; the route answers 400

**Files:**
- Modify: `src/services/class-lifecycle.ts` (`UpdateClassResult`, `updateClass`'s transaction)
- Modify: `src/app/api/classes/[id]/route.ts` (PUT's result mapping)
- Test: `src/services/class-lifecycle.test.ts` (new `it`s inside `describe('updateClass (DB)')`)
- Test: `tests/integration/classes-api.test.ts` (inside `describe('PUT /api/classes/[id]')`)

**Interfaces:**
- Consumes: `economicsViolations`, `formatEconomicsViolations`, `EconomicsViolation` (Task 1).
- Produces: a new `UpdateClassResult` arm, `{ ok: false; reason: 'invalid_economics'; violations: readonly [EconomicsViolation, ...EconomicsViolation[]] }`. The tuple is non-empty for the same reason `locked`'s is: a refusal naming no violation must not be constructible.

- [ ] **Step 1: Write the failing service tests.** The block's `makeClass(false)` fixture is `roomCost 35, minRate 15, targetRate 25, minStudents 4, maxStudents 12`.

```ts
  describe('merged-row economics (#221)', () => {
    const economics = (id: string) =>
      prisma.class.findUniqueOrThrow({
        where: { id },
        select: { roomCost: true, minRate: true, targetRate: true, minStudents: true, maxStudents: true },
      });

    it.each([
      ['maxStudents below the stored minStudents', { maxStudents: 2 }, 'students_order'],
      ['minStudents above the stored maxStudents', { minStudents: 13 }, 'students_order'],
      ['minRate above the stored targetRate', { minRate: 30 }, 'rate_order'],
      ['minRate subsidising past the stored roomCost', { minRate: -500 }, 'room_subsidy'],
    ] as const)('refuses %s and leaves the row unchanged', async (_label, edit, rule) => {
      const cls = await makeClass(false);
      const before = await economics(cls.id);

      const result = await updateClass(prisma, cls.id, edit);

      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'invalid_economics') throw new Error(`expected invalid_economics, got ${JSON.stringify(result)}`);
      expect(result.violations.map((v) => v.rule)).toEqual([rule]);
      expect(await economics(cls.id)).toEqual(before);
    });

    it('refuses a roomCost edit that leaves a stored negative minRate subsidising past it', async () => {
      const cls = await makeClass(false);
      await prisma.class.update({ where: { id: cls.id }, data: { minRate: -20 } });

      const result = await updateClass(prisma, cls.id, { roomCost: 10 });

      expect(result).toMatchObject({ ok: false, reason: 'invalid_economics' });
      expect(Number((await economics(cls.id)).roomCost)).toBe(35);
    });

    it('rolls back a non-economic field sent alongside the invalid economics', async () => {
      const cls = await makeClass(false);
      const result = await updateClass(prisma, cls.id, { description: 'should not land', maxStudents: 2 });
      expect(result).toMatchObject({ ok: false, reason: 'invalid_economics' });
      const stored = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(stored.description).not.toBe('should not land');
    });

    it('applies a partial economic edit that stays valid against the stored row', async () => {
      const cls = await makeClass(false);
      const result = await updateClass(prisma, cls.id, { maxStudents: 4 });
      expect(result.ok).toBe(true);
      expect((await economics(cls.id)).maxStudents).toBe(4);
    });

    it('answers locked, not invalid_economics, for a settings-locked class', async () => {
      const cls = await makeClass(true);
      const result = await updateClass(prisma, cls.id, { maxStudents: 2 });
      expect(result).toMatchObject({ ok: false, reason: 'locked' });
    });
  });
```

The last test passes today through the pre-transaction `locked` check (`class-lifecycle.ts`, `if (cls.settingsLocked && sentEconomic !== null)`). It is a regression pin for the ordering, not a red-first test, so say so in the task report. The in-transaction ordering (a row locked *between* the first read and the lock) is covered by Step 6's mutation, not by a race harness.

- [ ] **Step 2: Write the failing integration test** in `tests/integration/classes-api.test.ts`, in the `PUT /api/classes/[id]` block, using that block's `put` helper and owner token. Create a fresh unlocked class for it rather than reusing `economicsClassId`, whose values other tests assert. Copy the block's existing fixture setup for an unlocked class.

```ts
  it('partial economic edit that breaks a stored invariant -> 400 with the schema-shaped message (#221)', async () => {
    // fixture: an unlocked class with minStudents 4, maxStudents 12
    const res = await put(ownerToken, invalidEconomicsClassId, { maxStudents: 2 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.message).toBe('minStudents: minStudents cannot exceed maxStudents');
    expect(body.error.code).toBeUndefined();
  });
```

- [ ] **Step 3: Run and see them fail**

Run: `pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t "merged-row economics"`
Expected: the four `it.each` cases, the roomCost case and the rollback case FAIL (`ok: true` today). The valid-edit and locked cases pass.
Run (after `pnpm run worktree:up`): `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "#221"`
Expected: FAIL, status 200.

- [ ] **Step 4: Implement in `updateClass`.** Add the arm to `UpdateClassResult`. Add one sentence to its docblock for the new arm: the economics the write would leave behind break a cross-field rule, and `violations` is non-empty. Then, inside the transaction, **immediately after `await lockClassRow(tx, classId);` and before `if (hasClassEdit)`**:

```ts
      // The cross-field economics are checked on the row the write would
      // leave, read under the lock just taken, and BEFORE the write: the
      // `CHECK`s on `Class` raise at the write itself, as a 500. Skipped when
      // the fresh row would fail the CAS below, so a class that locked or
      // froze since the first read keeps answering `locked`/`terminal`.
      if (sentEconomic !== null) {
        const fresh = await tx.class.findUnique({
          where: { id: classId },
          select: {
            roomCost: true, minRate: true, targetRate: true, minStudents: true, maxStudents: true,
            settingsLocked: true, status: true,
            calendarEntry: { select: { cancelledAt: true } },
          },
        });
        const passesCas =
          fresh !== null &&
          !fresh.settingsLocked &&
          !TERMINAL_CLASS_STATUSES.includes(fresh.status) &&
          fresh.calendarEntry.cancelledAt === null;
        if (passesCas) {
          const [first, ...rest] = economicsViolations({
            roomCost: data.roomCost ?? Number(fresh.roomCost),
            minRate: data.minRate ?? Number(fresh.minRate),
            targetRate: data.targetRate ?? Number(fresh.targetRate),
            minStudents: data.minStudents ?? fresh.minStudents,
            maxStudents: data.maxStudents ?? fresh.maxStudents,
          });
          if (first !== undefined) {
            throw new UpdateClassRefusal({ ok: false, reason: 'invalid_economics', violations: [first, ...rest] });
          }
        }
      }
```

`TERMINAL_CLASS_STATUSES` is `readonly ClassStatus[]` (`class-lifecycle.ts`), so `.includes(fresh.status)` type-checks as written. The `passesCas` predicate must mirror the class CAS's `where` exactly. Read that `where` and confirm the three conjuncts match; if they don't, report it.

- [ ] **Step 5: Map it in the route.** In `src/app/api/classes/[id]/route.ts`, before the exhaustiveness `never`:

```ts
  // A partial economic edit that, merged with the stored row, breaks a
  // cross-field rule (#221). Same status and message shape as the create
  // schema's refusal of the same rule.
  if (result.reason === 'invalid_economics') {
    return respondError(formatEconomicsViolations(result.violations), 400);
  }
```

Check `src/app/api/classes/[id]/route.test.ts` for any test that enumerates every `UpdateClassResult` reason. If one exists, extend it.

- [ ] **Step 6: Run and see them pass; mutation proof**

Run both commands from Step 3; expected PASS. Then, recording each failure's text:
  - Delete the `throw new UpdateClassRefusal(...invalid_economics...)` line: the `it.each` cases go red. Restore.
  - Replace `data.maxStudents ?? fresh.maxStudents` with `fresh.maxStudents`: the `maxStudents: 2` case goes red. Restore.
  - Change `passesCas` to `true` (always check). Then write a test-local case: a class whose `settingsLocked` is flipped to `true` **after** the service's first read. Use the `$extends` query hook the file's lock-order tests already use (`update-class-lock-order.test.ts` shows the pattern) to set it between the pre-transaction read and `lockClassRow`. Assert `reason: 'locked'`. With the mutation it answers `invalid_economics`. If building that hook costs more than it proves, stop and report instead of improvising.
  - `git status --short` clean apart from intended files.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts "src/app/api/classes/[id]/route.ts" tests/integration/classes-api.test.ts
git commit -m "fix(classes): refuse a partial economic edit that breaks a rule against the stored row (#221)"
```

(Add `"src/app/api/classes/[id]/route.test.ts"` only if Step 5 changed it.)

---

### Task 3: `updateClassTemplate` checks the merged row; the route answers 400

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` (`UpdateClassTemplateResult`, `updateClassTemplate`, `CLASS_FAMILY.updateChild`)
- Modify: `src/app/api/class-templates/[id]/route.ts` (PUT's result mapping)
- Test: `src/services/class-template-lifecycle.test.ts` (a **new** describe block)
- Test: `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Consumes: Task 1's exports.
- Produces: `UpdateClassTemplateResult = UpdateRuleResult<ClassTemplate> | { ok: false; reason: 'invalid_economics'; violations: readonly [EconomicsViolation, ...EconomicsViolation[]] }`. **Do not** add the arm to `UpdateRuleResult`: the studio family shares it and has no economics.

- [ ] **Step 1: Write the failing service tests in a new describe block**, `describe('updateClassTemplate economics (DB) (#221)')`. **Do not add to the existing `updateClassTemplate (DB)` block's `makeTemplate`.** Its slot counter (`slotTime(30 + n * 75)`, capped at 900 minutes past 09:00) is already used by exactly as many calls as it has slots, and one more makes `slotTime` throw. The new block seeds its own teacher with the file's `seedTeacher('economics')` and its own counter on `dayOfWeek: 4`. Its `afterAll` copies the existing block's cleanup, guarded against an undefined `teacherId`: if `beforeAll` fails early, an unguarded `deleteMany({ where: { teacherId: undefined } })` deletes every row in the table. Fixture economics: `roomCost 15, minRate 10, targetRate 20, minStudents 2, maxStudents 8`.

```ts
  it.each([
    ['maxStudents below the stored minStudents', { maxStudents: 1 }, 'students_order'],
    ['minRate above the stored targetRate', { minRate: 25 }, 'rate_order'],
    ['minRate subsidising past the stored roomCost', { minRate: -500 }, 'room_subsidy'],
  ] as const)('refuses %s and leaves the template unchanged', async (_label, edit, rule) => {
    const tpl = await makeTemplate('Econ');
    const result = await updateClassTemplate(prisma, tpl.id, teacherId, edit);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'invalid_economics') throw new Error(`expected invalid_economics, got ${JSON.stringify(result)}`);
    expect(result.violations.map((v) => v.rule)).toEqual([rule]);
    const stored = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    expect([Number(stored.minRate), stored.maxStudents]).toEqual([10, 8]);
  });

  it('rolls back a rule-level field sent alongside the invalid economics', async () => {
    const tpl = await makeTemplate('Econ Rollback');
    const result = await updateClassTemplate(prisma, tpl.id, teacherId, { classType: 'Renamed', maxStudents: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_economics' });
    const rule = await prisma.scheduleRule.findUniqueOrThrow({ where: { id: tpl.scheduleRuleId } });
    expect(rule.classType).toBe('Econ Rollback');
  });

  it('applies a partial economic edit that stays valid against the stored row', async () => {
    const tpl = await makeTemplate('Econ Valid');
    const result = await updateClassTemplate(prisma, tpl.id, teacherId, { maxStudents: 2 });
    expect(result.ok).toBe(true);
  });
```

Integration, in `tests/integration/class-templates-api.test.ts`, using its `createTemplate` helper (it creates a template with the file's default economics; read them and pick an edit that breaks `minRate >= -roomCost`):

```ts
  it('partial economic edit that breaks a stored invariant -> 400 with the schema-shaped message (#221)', async () => {
    const id = await createTemplate('Econ Refusal', /* a free slot per the file's convention */);
    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ minRate: -10_000 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('minRate: minRate cannot subsidize more than the room cost — prices would go negative');
  });
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts -t "#221"`. Expected: the refusal and rollback cases FAIL.
Run: `pnpm exec vitest run --project integration tests/integration/class-templates-api.test.ts -t "#221"`. Expected: FAIL, 200.

- [ ] **Step 3: Implement.** In `class-template-lifecycle.ts`:

1. A module-private refusal carrier:
   ```ts
   /** Thrown from inside `updateRule`'s transaction to roll it back; `updateClassTemplate` turns it into its result. */
   class InvalidTemplateEconomics extends Error {
     constructor(readonly violations: readonly [EconomicsViolation, ...EconomicsViolation[]]) {
       super('updateClassTemplate: economics refused, rolling back');
     }
   }
   ```
2. In `CLASS_FAMILY.updateChild`, before `tx.classTemplate.update(...)`, and only when `childData` carries at least one `ECONOMIC_FIELDS` key with a defined value. Import `ECONOMIC_FIELDS` from `@/lib/class-fields`; its members are these five columns.
   ```ts
      // Checked on the row the write would leave, under the row lock
      // `updateRule` took, and before the write: the `CHECK`s raise at the
      // write itself, as a 500.
      if (ECONOMIC_FIELDS.some((f) => childData[f] !== undefined)) {
        const stored = await tx.classTemplate.findUniqueOrThrow({
          where: { id: templateId },
          select: { roomCost: true, minRate: true, targetRate: true, minStudents: true, maxStudents: true },
        });
        const [first, ...rest] = economicsViolations({
          roomCost: typeof childData.roomCost === 'number' ? childData.roomCost : Number(stored.roomCost),
          minRate: typeof childData.minRate === 'number' ? childData.minRate : Number(stored.minRate),
          targetRate: typeof childData.targetRate === 'number' ? childData.targetRate : Number(stored.targetRate),
          minStudents: typeof childData.minStudents === 'number' ? childData.minStudents : stored.minStudents,
          maxStudents: typeof childData.maxStudents === 'number' ? childData.maxStudents : stored.maxStudents,
        });
        if (first !== undefined) throw new InvalidTemplateEconomics([first, ...rest]);
      }
   ```
   (`childData` is `Record<string, unknown>` at this boundary, hence the `typeof` narrowing rather than a cast.)
3. `updateClassTemplate` becomes `async`, wraps `updateRule(...)` in `try`, and in `catch` returns `{ ok: false, reason: 'invalid_economics', violations: err.violations }` when `err instanceof InvalidTemplateEconomics`, rethrowing anything else. Update `UpdateClassTemplateResult` per Interfaces, and give its docblock one sentence for the arm.
4. **Check** that `updateRule`'s `catch` does not swallow the throw: it tests transient, record-not-found, slot-exclusion and room-FK errors, then `throw err`. A plain `Error` subclass with no `cause` matches none of them. Confirm by reading `transientDbFailure` (`src/lib/api-errors.ts`) and reporting what it checks, not by assuming.

In `src/app/api/class-templates/[id]/route.ts`, before the PUT's exhaustiveness `never`:

```ts
  // A partial economic edit that, merged with the stored template, breaks a
  // cross-field rule (#221). Same status and message shape as the create
  // schema's refusal of the same rule.
  if (result.reason === 'invalid_economics') {
    return respondError(formatEconomicsViolations(result.violations), 400);
  }
```

- [ ] **Step 4: Run and see them pass**, both commands from Step 2. Also run the whole template service file and the studio template tests to prove the shared `updateRule` is unaffected:
`pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts src/services/studio-class-template-lifecycle.test.ts`. If the second path doesn't exist, find the studio family's `updateRule` tests with `grep -rl "updateStudioClassTemplate" src` and run those.

- [ ] **Step 5: Mutation proof**
  - Delete the `throw new InvalidTemplateEconomics(...)`: the refusal cases go red. Restore.
  - Remove the `instanceof InvalidTemplateEconomics` branch in `updateClassTemplate`: the refusal cases go red with the thrown error. Restore.
  - `git status --short` clean apart from intended files.

- [ ] **Step 6: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts "src/app/api/class-templates/[id]/route.ts" tests/integration/class-templates-api.test.ts
git commit -m "fix(templates): refuse a partial economic edit that breaks a rule against the stored template (#221)"
```

---

### Task 4: Both edit forms enforce all three rules

**Files:**
- Modify: `src/components/class/class-edit-form.tsx` (`handleSave`'s unlocked-only block)
- Modify: `src/components/settings/template-form.tsx` (`handleSubmit`'s economic checks)
- Test: `src/components/class/class-edit-form.test.tsx`
- Test: `src/components/settings/template-form.test.tsx`

**Interfaces:**
- Consumes: `economicsViolations`, `EconomicsRule` (Task 1).

- [ ] **Step 1: Write the failing tests.**
  - `template-form.test.tsx`: **flip** `'permits min rate subsidizing more than room cost on edit'` into `'rejects min rate subsidizing more than room cost on edit before any request is sent'`. Same render (`mode="edit"`, `roomCost: 20, minRate: -25, targetRate: 25`), but assert the call count is unchanged and the alert matches `/^Min rate cannot subsidize more than the room cost — prices would go negative$/`. Rewrite its docblock to state the rule now (the server refuses this on edit too, #221); drop the sentence explaining the old leniency, which belongs in the PR body.
  - `class-edit-form.test.tsx`: add `'rejects min rate subsidizing more than room cost before any request is sent'`, modelled on the file's existing min-rate/target-rate test, with `initial={{ ...initial, roomCost: 20, minRate: -25, targetRate: 25 }}` and the same exact-copy alert assertion.

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run --project components src/components/class/class-edit-form.test.tsx src/components/settings/template-form.test.tsx`
Expected: the two new or flipped tests FAIL (the request is sent).

- [ ] **Step 3: Implement.** In each form, replace the hand-written predicates with the shared function and a form-owned copy map:

```ts
const ECONOMICS_COPY = {
  students_order: 'Min students cannot exceed max students',
  rate_order: 'Min rate cannot exceed target rate',
  room_subsidy: 'Min rate cannot subsidize more than the room cost — prices would go negative',
} as const satisfies Record<EconomicsRule, string>;
```

and in the handler (the class form keeps its `if (!settingsLocked)` wrapper; the template form drops `mode === 'create' &&`):

```ts
    const [violation] = economicsViolations(form);
    if (violation !== undefined) {
      setError(ECONOMICS_COPY[violation.rule]);
      return;
    }
```

If `form` carries more keys than `ClassEconomics`, pass it as is: structural typing accepts the wider object. If its economic fields are not `number` (for example strings from inputs), stop and report rather than coercing silently.

Rewrite each form's comment above the check to state what is true now: the form checks the same rules the server enforces, through the same function, and the copy is the form's own. Drop the paragraphs about restating rules by hand and about the create-only room check. The two forms both define `ECONOMICS_COPY`. That duplication is deliberate: each form owns its wording. If a reviewer disagrees, a shared copy module is a follow-up, not this task.

- [ ] **Step 4: Run and see them pass.** Same command as Step 2, and the whole of both files must be green. The existing students-order and rate-order tests pin that the copy didn't change.

- [ ] **Step 5: Mutation proof**
  - In `template-form.tsx`, reintroduce `mode === 'create' &&` around the check: the flipped test goes red. Restore.
  - Change `ECONOMICS_COPY.room_subsidy` by one word in `class-edit-form.tsx`: its new test goes red. Restore.
  - Remove the `room_subsidy` key from one map: `pnpm exec tsc --noEmit` fails (the `satisfies` tether). Record the error. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/components/class/class-edit-form.tsx src/components/class/class-edit-form.test.tsx src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "fix(forms): both edit forms enforce all three economic rules through the shared predicate (#221)"
```

---

### Task 5: `CHECK` constraints on `Class` and `ClassTemplate`

**Files:**
- Create: `prisma/migrations/<timestamp>_class_economics_checks/migration.sql`
- Create: `src/services/class-economics-constraints.test.ts`
- Modify: `docs/data-model.md` (the `ClassTemplate` and `Class` sections, and "Design Notes")
- Modify: `src/lib/schemas.ts` (the `MAX_CLASS_SIZE` docblock: one line pointing at `docs/data-model.md`)

- [ ] **Step 1: Write the failing bite tests** in `src/services/class-economics-constraints.test.ts` (`unit` project, real DB). Seed one teacher, room and teacher-room (copy `class-lifecycle.test.ts`'s `updateClass (DB)` `beforeAll`/`afterAll`, guarded). For `Class`, write through `createClassFixture` with one field overridden; for `ClassTemplate`, through `prisma.classTemplate.create` with a nested `scheduleRule` (the shape in `class-generator.test.ts`), each on its own `dayOfWeek`/`startTime` via `slotTime`.

```ts
const validEconomics = { roomCost: 20, minRate: 10, targetRate: 30, minStudents: 2, maxStudents: 10 };

const cases = [
  ['room_cost_check', { roomCost: -1 }],
  ['min_students_range_check', { minStudents: -1 }],
  ['min_students_range_check', { minStudents: 201, maxStudents: 200 }],
  ['max_students_range_check', { maxStudents: 0, minStudents: 0 }],
  ['max_students_range_check', { maxStudents: 201 }],
  ['students_order_check', { minStudents: 11 }],
  ['rate_order_check', { minRate: 31 }],
  ['room_subsidy_check', { minRate: -21 }],
] as const;

describe.each(['Class', 'ClassTemplate'] as const)('%s economic CHECKs (#221)', (table) => {
  it.each(cases)(`${table}_%s refuses %o`, async (suffix, override) => {
    await expect(insert(table, { ...validEconomics, ...override })).rejects.toThrow(`${table}_${suffix}`);
  });

  it('accepts minStudents 0 — the database floor is 0, Zod keeps 1', async () => {
    await expect(insert(table, { ...validEconomics, minStudents: 0 })).resolves.toBeDefined();
  });

  it('accepts a minRate subsidising exactly the room cost', async () => {
    await expect(insert(table, { ...validEconomics, minRate: -20 })).resolves.toBeDefined();
  });
});
```

`insert(table, economics)` is a local helper that creates one row of that table with a fresh slot (increment a counter per call; `Class` rows on distinct `slotDate`s, templates on distinct `slotTime`s). Each case overrides only what it tests, and every other constraint is satisfied, so the thrown name identifies the one constraint that fired. Check this for each row of `cases` when writing the table (for example, `maxStudents: 0` needs `minStudents: 0` so `students_order_check` doesn't fire first).

- [ ] **Step 2: Run and see them fail**

Run: `pnpm exec vitest run --project unit src/services/class-economics-constraints.test.ts`
Expected: every refusal case FAILS (the insert resolves). The two acceptance cases pass.

- [ ] **Step 3: Write the migration.** Create the directory with a timestamp later than every existing one (`ls prisma/migrations | tail -2`). Model it on `prisma/migrations/20260802150845_income_tier_range_check/migration.sql`: a short header saying what the SQL enforces, nothing about why the floor is 0 or where 200 comes from (those go to `docs/`).

```sql
-- Economic invariants, DB-enforced, on both tables that carry a class's
-- economics. The update services check the cross-field three on the merged
-- row before writing; these refuse any writer that does not.
ALTER TABLE "Class" ADD CONSTRAINT "Class_room_cost_check"            CHECK ("roomCost" >= 0);
ALTER TABLE "Class" ADD CONSTRAINT "Class_min_students_range_check"   CHECK ("minStudents" BETWEEN 0 AND 200);
ALTER TABLE "Class" ADD CONSTRAINT "Class_max_students_range_check"   CHECK ("maxStudents" BETWEEN 1 AND 200);
ALTER TABLE "Class" ADD CONSTRAINT "Class_students_order_check"       CHECK ("minStudents" <= "maxStudents");
ALTER TABLE "Class" ADD CONSTRAINT "Class_rate_order_check"           CHECK ("minRate" <= "targetRate");
ALTER TABLE "Class" ADD CONSTRAINT "Class_room_subsidy_check"         CHECK ("minRate" >= -"roomCost");

ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_room_cost_check"          CHECK ("roomCost" >= 0);
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_min_students_range_check" CHECK ("minStudents" BETWEEN 0 AND 200);
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_max_students_range_check" CHECK ("maxStudents" BETWEEN 1 AND 200);
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_students_order_check"     CHECK ("minStudents" <= "maxStudents");
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_rate_order_check"         CHECK ("minRate" <= "targetRate");
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_room_subsidy_check"       CHECK ("minRate" >= -"roomCost");
```

Before applying, re-run the audit (spec §1.3) against the worktree dev and test databases. Save the query as a scratchpad `.sql` file and pipe it: `docker exec -i fairyoga-db-1 psql -U yoga -d <db> < <file>`. Expect zero violations. Then apply with `pnpm exec prisma migrate deploy` against dev and against test (`DATABASE_URL` set to the test URL from `.env`). `migrate dev` refuses to run in a non-interactive shell, so a hand-written migration is applied with `deploy`. Run `pnpm exec prisma migrate status`, and `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadow>` if CI's drift check uses it (read `.github/workflows/ci.yml` for the exact command). The schema file doesn't change: Prisma can't express `CHECK`.

**Once applied, the migration file is immutable, comments included.**

- [ ] **Step 4: Run and see them pass.** Step 2's command: PASS. Then re-run Tasks 2 and 3's service and integration tests **with the constraints in place**. They must still answer `invalid_economics`/400, not a 500 or a raw `23514`, which is what proves the check runs before the write:
`pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts src/services/class-template-lifecycle.test.ts -t "#221|merged-row"`
`pnpm exec vitest run --project integration tests/integration/classes-api.test.ts tests/integration/class-templates-api.test.ts -t "#221"`

- [ ] **Step 5: Mutation proof.** Mutate a **copy** of the constraint in a live database, not the migration file. In the worktree test DB, `ALTER TABLE "Class" DROP CONSTRAINT "Class_room_subsidy_check";`, run Step 2's command, and record which case goes red. Then re-add the constraint with the exact statement from the migration and re-run to green. Do the same once for a `ClassTemplate` constraint. Confirm with `\d "Class"` that all six constraints are present afterwards.

- [ ] **Step 6: Docs.** In `docs/data-model.md`:
  - `ClassTemplate` and `Class` sections: one row or note per section saying the economic columns carry the six `CHECK`s (name the migration).
  - "Design Notes": a short entry giving (a) why the `minStudents` floor is 0 in SQL while Zod says 1: zero breaks no arithmetic, and test fixtures use it to stay clear of the live auto-cancel sweep (spec §1.4); (b) that `200` duplicates `MAX_CLASS_SIZE` in `src/lib/schemas.ts`, and the two must move together; (c) that `economicsViolations` (`src/lib/class-economics.ts`) and the three cross-field constraints state the same rules. Include the re-derivation command `grep -n "CHECK" prisma/migrations/*_class_economics_checks/migration.sql`.
  - In `src/lib/schemas.ts`, add one line to the `MAX_CLASS_SIZE` docblock: `Duplicated in the class economics CHECKs; see docs/data-model.md (Design Notes).`

- [ ] **Step 7: Commit**

```bash
git add prisma/migrations/<timestamp>_class_economics_checks/migration.sql src/services/class-economics-constraints.test.ts docs/data-model.md src/lib/schemas.ts
git commit -m "feat(db): CHECK the class economic invariants on Class and ClassTemplate (#221)"
```

---

### Final: whole-branch verification

- [ ] `pnpm run verify` (needs the app live; in this worktree, `pnpm run worktree:up`). Record the per-project test counts for the PR body.
- [ ] `git log --oneline origin/main..HEAD` shows the spec, the plan and five task commits.
- [ ] Sweep for what this branch invalidated: `grep -rn "no minRate/roomCost refine\|create-only\|undefined guards on refinements" src docs`. Every hit gets a verdict.
- [ ] Whole-branch review (the solve-issue skill, §5), then push and open the PR.
