# Scoped Sweep Assertions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every test that asserts on a database-wide sweep's result does so through a client scoped to its own fixtures, so rows that earlier runs leave in the shared test database can neither fail it when it should pass nor pass it when it should fail.

**Architecture:** One test-only helper, `scopeSweep`, returns a Prisma client built with `$extends`. Per named model it `AND`s a filter into bulk operations and counts the rows those reads returned. Each census hit is rewritten to call its sweep through that client, with exact counts and a presence check. Production code does not change.

**Tech Stack:** Prisma 6.19 client extensions (`$allModels` / `$allOperations`), vitest 4.1 (`unit` and `unit-sweeps` projects), TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-22-scoped-sweep-assertions-design.md`. Its census table names every hit, and its "Per hit" table is the requirement each task below implements.

## Global Constraints

- **No production change.** Nothing under `src/` outside `*.test.ts` files changes. A task that finds it needs one stops and reports it.
- **No `any`.** `strict: true`. The single `as unknown as PrismaClient` cast lives in `tests/scoped-sweep.ts` only.
- **Never assert `toBe(0)` on a scoped sweep without a presence check** (`rowsRead(model) > 0` or an equivalent per-id check proving the fixture was a candidate).
- **Comment discipline (CLAUDE.md):** no counts or file rosters in comments; a comment annotates the code it sits on; nothing like "this used to assert X".
- **Stage exact paths.** Never `git add -A` / `git add .`.
- **Run tests in the right project.** Files in `SWEEP_TESTS` (`vitest.tiers.ts`) run under `--project unit-sweeps`. Running them under `--project unit` reports "no test files found", which looks like a pass. `timezone-audit.test.ts` and `tests/scoped-sweep.test.ts` run under `--project unit`.
- **The stray-row proof protocol below applies to every task from Task 2 on.** Its three results, with exact assertion text, go in the task's report and then into this plan's "Results" section.

### Stray-row proof protocol

The point is to show each rewritten assertion (1) was coupled to stray rows before, (2) is not after, and (3) can still fail.

A scratch script plants the stray row. It is **never committed**: write it at the repo root as `.scratch-251-<task>.ts`, run it with `pnpm exec tsx`, and delete it before the task's commit. It must refuse to run unless connected to a `_test` database:

```ts
// Scratch for #251 — never committed.
import { PrismaClient } from '@prisma/client';
import { isTestDatabaseName } from './src/lib/worktree/identity';

const p = new PrismaClient();

async function main(): Promise<void> {
  const [row] = await p.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const name = row?.current_database ?? '';
  if (!isTestDatabaseName(name)) throw new Error(`refusing to plant into ${name}`);
  if (process.argv[2] === 'plant') {
    // Create ONE row that qualifies for the sweep under test, owned by a
    // teacher/account/email with the prefix `debris251-`, and print its id.
  } else {
    // Delete every row created by `plant` (find by the `debris251-` prefix),
    // children first. Print how many were removed.
  }
}

main().finally(() => p.$disconnect());
```

Run it with the worktree's test database URL, taken from `DATABASE_URL_TEST` in `.env`:

```sh
DATABASE_URL="<value of DATABASE_URL_TEST>" pnpm exec tsx .scratch-251-<task>.ts plant
DATABASE_URL="<value of DATABASE_URL_TEST>" pnpm exec tsx .scratch-251-<task>.ts remove
```

A worked example, used for #251's own premise check, planted a teacher (`bio: ''`, `pageSlug` required), a `Room` (`venueName`, `address`, `city`, `postcode`, `maxCapacity`, `createdById`), a `TeacherRoom` (`capacityOverride`, `rentalRate`), and a class through `createClassFixture` from `tests/class-fixtures.ts` with `status: 'in_progress'`, `date: new Date('2026-06-01')`.

For each hit:

1. **Coupled (old code).** Before editing, plant a qualifying stray row and run the file. Record the red for ways 1–3, with the exact `AssertionError` text. For way-4 (`>= 1`) hits, instead delete the service's counter increment, e.g. `transitioned++`. Record that the old assertion stays green with the stray row present and goes red without it. Restore the service and remove the stray row.
2. **Decoupled (new code).** After the rewrite, plant the same stray row and show the file is green. Remove it.
3. **Bites (new code).** With no stray row, apply the mutation named in the task: drop the counter, or drop the scope. Record the red and its exact text. Restore.

**End every task with `git status --short` showing only the task's intended files.** No mutation or scratch file may survive: an orphaned mutation looks like a fix. Commit before mutating a file you have already edited, because `git checkout -- <file>` also discards your own uncommitted work in that file.

A hit that does **not** reproduce in step 1 is not rewritten. Report it with the attempted stray row and the reason it did not bite; the controller adjudicates.

---

### Task 1: `scopeSweep` helper

**Files:**
- Create: `tests/scoped-sweep.ts`
- Create: `tests/scoped-sweep.test.ts`
- Modify: `vitest.config.ts`: add `'tests/scoped-sweep.test.ts'` to the `unit` project's `include` array, beside `'tests/api-assertions.test.ts'`

**Interfaces:**
- Produces:
  ```ts
  export type SweepScope = {
    [M in Prisma.ModelName]?: Prisma.TypeMap['model'][M]['operations']['findMany']['args']['where'];
  };
  export interface ScopedSweep {
    /** The client to hand the sweep. */
    db: PrismaClient;
    /** Rows returned by the scoped findMany/findFirst/groupBy reads on `model` so far. */
    rowsRead(model: Prisma.ModelName): number;
  }
  export function scopeSweep(base: PrismaClient, scope: SweepScope): ScopedSweep;
  ```
  Keys are Prisma model names in PascalCase (`Class`, `Notification`, `MagicLinkToken`), because `$allModels` hands the hook `model` in that form.

- [ ] **Step 1: Write the failing test** (`tests/scoped-sweep.test.ts`)

  The test builds its own rows through the base client, all named with a per-run `uniqueSuffix`, and cleans them up in `afterAll`. Use `Teacher` as the model, since its only required fields are `firstName`, `lastName`, `email`, `bio`, `pageSlug` and a nested `account: { create: { email } }`. Cases:

  ```ts
  import { PrismaClient } from '@prisma/client';
  import { afterAll, beforeAll, describe, expect, it } from 'vitest';
  import { scopeSweep } from './scoped-sweep';

  const prisma = new PrismaClient();
  const suffix = Date.now();
  let inId = '';
  let outId = '';

  function teacherData(tag: string) {
    const email = `scoped-sweep-${tag}-${suffix}@test.local`;
    return { firstName: 'Scoped', lastName: tag, email, bio: '', pageSlug: `scoped-sweep-${tag}-${suffix}`, account: { create: { email } } };
  }

  beforeAll(async () => {
    inId = (await prisma.teacher.create({ data: teacherData('in') })).id;
    outId = (await prisma.teacher.create({ data: teacherData('out') })).id;
  });

  afterAll(async () => {
    const teachers = await prisma.teacher.findMany({ where: { id: { in: [inId, outId] } } });
    await prisma.teacher.deleteMany({ where: { id: { in: [inId, outId] } } });
    await prisma.account.deleteMany({ where: { email: { in: teachers.map((t) => t.email) } } });
    await prisma.$disconnect();
  });

  describe('scopeSweep', () => {
    it('ANDs the scope into findMany and counts what it returned', async () => {
      const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
      const rows = await s.db.teacher.findMany({ where: { id: { in: [inId, outId] } } });
      expect(rows.map((r) => r.id)).toEqual([inId]);
      expect(s.rowsRead('Teacher')).toBe(1);
    });

    it('scopes a findMany with no where of its own', async () => {
      const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
      expect((await s.db.teacher.findMany()).map((r) => r.id)).toEqual([inId]);
    });

    it('scopes count, groupBy, updateMany and deleteMany', async () => {
      const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
      const both = { id: { in: [inId, outId] } };
      expect(await s.db.teacher.count({ where: both })).toBe(1);
      const groups = await s.db.teacher.groupBy({ by: ['id'], where: both });
      expect(groups.map((g) => g.id)).toEqual([inId]);
      expect(s.rowsRead('Teacher')).toBe(1); // groupBy counted; count() is not a row read
      expect((await s.db.teacher.updateMany({ where: both, data: { bio: 'x' } })).count).toBe(1);
      const out = await prisma.teacher.findUniqueOrThrow({ where: { id: outId } });
      expect(out.bio).toBe('');
    });

    it('applies inside interactive transactions', async () => {
      const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
      const rows = await s.db.$transaction((tx) => tx.teacher.findMany({ where: { id: { in: [inId, outId] } } }));
      expect(rows.map((r) => r.id)).toEqual([inId]);
    });

    it('leaves unnamed models and single-row operations alone', async () => {
      const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
      expect(await s.db.teacher.findUnique({ where: { id: outId } })).not.toBeNull();
      expect(await s.db.account.count({ where: { email: { contains: `-${suffix}@` } } })).toBe(2);
      expect(s.rowsRead('Account')).toBe(0);
    });

    it('lets a hook on the client handed in see the args before the scope', async () => {
      let seen: unknown;
      let hookRows: string[] = [];
      const hooked = prisma.$extends({
        query: { teacher: { async findMany({ args, query }) { seen = args.where; const r = await query(args); hookRows = r.map((t) => t.id); return r; } } },
      }) as unknown as PrismaClient;
      const s = scopeSweep(hooked, { Teacher: { id: { in: [inId] } } });
      await s.db.teacher.findMany({ where: { id: { in: [inId, outId] } } });
      expect(seen).toEqual({ id: { in: [inId, outId] } });
      expect(hookRows).toEqual([inId]); // the hook's own query() is scoped
    });
  });
  ```

  The last case pins the composition rule the class-transitions and email-fallback race hooks depend on. They test `args.where`'s *shape*, so they must see the sweep's own `where`, not the scope's `AND` wrapper. Prisma 6.19 runs query extensions in attachment order, which was measured in Task 1: the earliest-attached hook sees the caller's args. So a race hook is attached to the client passed **into** `scopeSweep`, never through `scoped.db.$extends(...)`, which would place it after the scope.

- [ ] **Step 2: Run it and see it fail**

  Run: `pnpm exec vitest run --project unit tests/scoped-sweep.test.ts`
  Expected: FAIL. The import of `./scoped-sweep` cannot resolve.

- [ ] **Step 3: Implement** (`tests/scoped-sweep.ts`)

  ```ts
  import type { Prisma, PrismaClient } from '@prisma/client';

  /**
   * A client for handing a DATABASE-WIDE sweep in a test, narrowed to the
   * test's own rows.
   *
   * The shared test database keeps rows earlier runs left behind, and a sweep
   * with no scope parameter reads them. An assertion on such a sweep's return
   * value then depends on that leftover: it can go red when it should pass, or
   * green when it should fail. This client ANDs a per-model filter into the
   * sweep's bulk statements so the sweep only ever sees what the test built.
   * `docs/test-database.md` states the convention.
   *
   * Single-row operations pass through untouched: they are keyed by an id the
   * sweep took from a scoped read. `rowsRead` exists because a scoped
   * `toBe(0)` passes vacuously when the fixture has fallen out of the sweep's
   * own predicate; pair every zero assertion with it.
   */
  export type SweepScope = {
    [M in Prisma.ModelName]?: Prisma.TypeMap['model'][M]['operations']['findMany']['args']['where'];
  };

  export interface ScopedSweep {
    db: PrismaClient;
    rowsRead(model: Prisma.ModelName): number;
  }

  const SCOPED = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'count', 'groupBy', 'aggregate', 'updateMany', 'updateManyAndReturn', 'deleteMany']);
  const READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'groupBy']);

  export function scopeSweep(base: PrismaClient, scope: SweepScope): ScopedSweep {
    const read = new Map<string, number>();
    const db = base.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            const filter = (scope as Record<string, object | undefined>)[model];
            if (filter === undefined || !SCOPED.has(operation)) return query(args);
            const a = args as { where?: object };
            const result: unknown = await query({ ...a, where: a.where === undefined ? filter : { AND: [a.where, filter] } });
            if (READS.has(operation)) {
              const n = Array.isArray(result) ? result.length : result === null ? 0 : 1;
              read.set(model, (read.get(model) ?? 0) + n);
            }
            return result;
          },
        },
      },
    }) as unknown as PrismaClient;
    return { db, rowsRead: (model) => read.get(model) ?? 0 };
  }
  ```

  If typecheck rejects the `query({...})` call or the `SweepScope` mapped type, adjust the typing only, never the behaviour. Keep the cast count at one. Report what changed.

- [ ] **Step 4: Run it and see it pass**

  Run: `pnpm exec vitest run --project unit tests/scoped-sweep.test.ts` → all pass.
  Run: `pnpm run typecheck` → clean.

- [ ] **Step 5: Prove the cases bite**

  Record the red and its exact text for each mutation, then restore:
  - Replace `{ AND: [a.where, filter] }` with `a.where`. Expected: the first, third and fourth cases go red.
  - Remove `'groupBy'` from `SCOPED`. Expected: the groupBy assertion goes red.
  - Change `READS.has(operation)` to `false`. Expected: the `rowsRead` assertions go red.
  - Replace `$allOperations`'s pass-through for unnamed models (`filter === undefined`) by applying the first scope in the object to every model. Expected: the unnamed-model case goes red.

  End with `git status --short` showing only the three intended files, and the tests green.

- [ ] **Step 6: Commit**

  ```sh
  git add tests/scoped-sweep.ts tests/scoped-sweep.test.ts vitest.config.ts
  git commit -m "test: add scopeSweep, a fixture-scoped client for sweep tests (#251)"
  ```

---

### Task 2: `class-transitions.test.ts`

**Files:**
- Modify: `src/services/class-transitions.test.ts`

**Interfaces:**
- Consumes: `scopeSweep(base, scope): { db, rowsRead }` from `tests/scoped-sweep.ts` (Task 1). Import it as `'../../tests/scoped-sweep'`, the same relative form the file already uses for `'../../tests/class-fixtures'`.

The spec's hits 1–5, plus the counter gap. Tests are named by title; the line numbers from the census (231, 315, 359, 890, 1044) are as of `dc4f5bb1`.

- [ ] **Step 1: Prove the coupling on the old code** (protocol step 1)
  - Hits 1, 2, 4, 5 (way 1): plant a stray class qualifying for each sweep. `autoCompleteClasses`: `in_progress`, dated `2026-06-01`. `autoTransitionToInProgress` and `autoCancelClasses`: `open`, dated before `2026-07-20`, below `minStudents` for cancel. Record which of the `toBe(0)` assertions go red. If the file's first test consumes the stray row before a later test reaches it (the census notes 'auto-transitions once the LOCAL start time has passed' sweeps earlier-dated open classes first), record that as the observed result. The rewrite still applies, because a stray row created during the run reaches it.
  - Hit 3 (way 4): delete `transitioned++`'s increment in `autoTransitionToInProgress`. Record the old `>= 1` going red with no stray row and staying green with one.

- [ ] **Step 2: Rewrite hits 1, 4, 5** ('does not transition … rescheduled', the `autoCancelClasses` race, 'does not complete a class rescheduled after the sweep read it')

  Each already builds `racing = prisma.$extends({ query: { class: { findMany … } } })`. Keep that exactly as it is, hand it to `scopeSweep`, and call the sweep through the scoped client. Then assert presence:

  ```ts
  const racing = prisma.$extends({ /* the existing hook, unchanged */ }) as unknown as PrismaClient;
  const scoped = scopeSweep(racing, { Class: { id: { in: [cls.id] } } });
  const completed = await autoCompleteClasses(scoped.db, new Date('2026-07-20T17:30:00Z'));
  expect(hookCalls).toBe(1);
  expect(scoped.rowsRead('Class')).toBeGreaterThan(0);
  expect(completed).toBe(0);
  ```

  The race hook is attached first, so it still sees the sweep's own `where` shape (see Task 1's composition case). Never write `scoped.db.$extends(racing)`: that puts the hook after the scope, where its shape test no longer matches.

- [ ] **Step 3: Rewrite hit 2** (the lock-race test asserting `expect(await sweeping).toBe(0)`)

  Pass `scoped.db` (scope `Class` to the fixture) to `autoTransitionToInProgress` in place of `prisma`, and add `expect(scoped.rowsRead('Class')).toBeGreaterThan(0)` after the sweep settles. The lock holder keeps using `prisma`. Verify the race still behaves: the `settled === false` and `holderCommitted === false` assertions must still pass.

- [ ] **Step 4: Rewrite hit 3** ('closes the waitlist when it starts a class')

  Sweep through `scopeSweep(prisma, { Class: { id: { in: [cls.id] } } }).db` and change `toBeGreaterThanOrEqual(1)` to `toBe(1)`. Also assert the class's own status is `in_progress`; the census found the test never checks it.

- [ ] **Step 5: Close the counter gap**

  `autoCancelClasses`'s and `autoCompleteClasses`'s return values have no positive assertion anywhere in the file. Find the existing tests where each sweep actually processes the fixture: 'auto-completes an in-progress class after its local end time', and the auto-cancel test that cancels a below-minimum class. Run their sweep through a scoped client and assert the return `toBe(1)`. If one of them calls the sweep without capturing its return, capture it. Mind the ordering comment above 'does not complete … rescheduled': it frees a slot the next test reuses, so do not reorder tests.

- [ ] **Step 6: Run** `pnpm exec vitest run --project unit-sweeps src/services/class-transitions.test.ts` → all green. Then commit, since the protocol requires a commit before mutating an edited file:

  ```sh
  git add src/services/class-transitions.test.ts
  git commit -m "test(class-transitions): assert sweep results through a scoped client (#251)"
  ```

- [ ] **Step 7: Protocol steps 2 and 3.** Plant the step-1 stray rows again: green. Then, with no stray row:
  - Delete `completed++`, `cancelled++` and `transitioned++` in turn. Each of the three new `toBe(1)` assertions goes red.
  - Replace the scope filter with `{ id: { in: ['00000000-0000-0000-0000-000000000000'] } }`, an id nothing can hold. The hit-1/4/5 presence checks go red. Without them, `toBe(0)` would have stayed green.

  Restore and confirm `git status --short` is clean.

---

### Task 3: `magic-link.test.ts` and `auth-cleanup.test.ts`

**Files:**
- Modify: `src/lib/auth/magic-link.test.ts`
- Modify: `src/services/auth-cleanup.test.ts`

**Interfaces:**
- Consumes: `scopeSweep` from `tests/scoped-sweep.ts`. The import path is relative to each file: `'../../../tests/scoped-sweep'` from `src/lib/auth/`, `'../../tests/scoped-sweep'` from `src/services/`.

Both sweeps (`cleanupExpiredTokens`, `cleanupExpiredAuth`) are single `deleteMany` statements, so they have no row reads. `rowsRead` is not used. The exact counts plus the existing per-id survival checks carry presence.

- [ ] **Step 1: Prove the coupling.** Plant one expired `MagicLinkToken` for `debris251-…@test.local` (and one expired `Session` for auth-cleanup). Record: magic-link 'returns 0 when no tokens are expired' red (`expected 1 to be +0`); the magic-link cleanup `deleted` `toBe(1)` red. For auth-cleanup's `>= 1` (way 4), delete `.count` from one of the two returned fields in `cleanupExpiredAuth`, or swap the two fields. Show the old assertions stay green with a stray row.
- [ ] **Step 2: Rewrite magic-link.** Every `cleanupExpiredTokens(db)` call whose result is asserted passes `scopeSweep(db, { MagicLinkToken: { email: { endsWith: '@example.com' } } }).db`. That is the same predicate the file's `afterEach` cleanup and its `remaining` count already use. Counts stay exact.
- [ ] **Step 3: Rewrite auth-cleanup.** Scope `Session` to the fixture's session ids and `MagicLinkToken` to the fixture's token hashes (whatever the file's `beforeEach` builds; read it). `sessions` and `magicLinkTokens` become `toBe(<number of expired fixtures of that kind>)`. State the number's derivation in the test (e.g. "one dead, one live session built above").
- [ ] **Step 4:** Run `pnpm exec vitest run --project unit-sweeps src/lib/auth/magic-link.test.ts src/services/auth-cleanup.test.ts` → green. Commit:

  ```sh
  git add src/lib/auth/magic-link.test.ts src/services/auth-cleanup.test.ts
  git commit -m "test(auth): assert cleanup counts through a scoped client (#251)"
  ```

- [ ] **Step 5: Protocol steps 2 and 3.** Stray row present: green. No stray row: swap `sessions`/`magicLinkTokens` in `cleanupExpiredAuth`'s return → red. Make `cleanupExpiredTokens` delete nothing (`where: { expiresAt: { lt: new Date(0) } }`) → red. Restore; `git status --short` clean.

---

### Task 4: `email-fallback.test.ts`

**Files:**
- Modify: `src/services/email-fallback.test.ts`

**Interfaces:**
- Consumes: `scopeSweep` from `'../../tests/scoped-sweep'`.

Hits 10–14. `processEmailFallback` reads candidates through `getUnreadForEmailFallback`'s `notification.findMany` (`notifications.ts`) and claims with `notification.updateMany`. Scoping `Notification` to the fixture's id covers both.

- [ ] **Step 1: Prove the coupling.** Plant stray notifications, older than the fixture (`createdAt` earlier than now − 45 min), unread, un-emailed:
  - one whose recipient is a `debris251-` teacher with a live account (way 2): record the send-failure tests going red on `emailSent`;
  - one whose recipient does not resolve (way 1): record the overlapping test's `outerSent` going red, and the "1 of 1" error-text tests going red with the "1 of N" text.
- [ ] **Step 2: Rewrite.** In each census test, build `const scoped = scopeSweep(base, { Notification: { id: { in: [notification.id] } } })`. `base` is the test's existing `overlapping`, `unreleasable` or `unclaimable` client, whose extensions stay on `prisma` exactly as they are, or plain `prisma` where the test has none. Never write `scoped.db.$extends(...)`, which puts the hook after the scope (Task 1's composition case). Where a test calls `processEmailFallback(prisma)` directly, pass `scoped.db`. Add `expect(scoped.rowsRead('Notification')).toBeGreaterThan(0)` where the test asserts `toBe(0)` (`outerSent`). The `Once` mocks stay: with the read scoped, the fixture is the only row a send can reach.
- [ ] **Step 3:** Run `pnpm exec vitest run --project unit-sweeps src/services/email-fallback.test.ts` → green. Commit:

  ```sh
  git add src/services/email-fallback.test.ts
  git commit -m "test(email-fallback): scope the sweep so one-shot failures reach the fixture (#251)"
  ```

- [ ] **Step 4: Protocol steps 2 and 3.** Both stray rows present: green. No stray row: point the scope at an id nothing holds, and record the `rowsRead` presence check going red. Invert `markOne`'s `already-claimed` branch to count as failed, and record the overlapping test going red. Restore; clean.

---

### Task 5: `payment-reminders.test.ts` and `timezone-audit.test.ts`

**Files:**
- Modify: `src/services/payment-reminders.test.ts`
- Modify: `src/services/timezone-audit.test.ts`

**Interfaces:**
- Consumes: `scopeSweep` from `'../../tests/scoped-sweep'`.

- [ ] **Step 1: Prove the coupling.**
  - payment-reminders (way 4): delete the increment behind `markedOverdue`, then the one behind `reminded`, in `payment-reminders.ts`. With a stray overdue-eligible `pending` payment (a `debris251-` teacher's completed class, a registration and a payment past its due window), the old `>= 1` stays green. Without it, it goes red.
  - timezone-audit (ways 1 and 4): plant a `debris251-` teacher whose `defaultTimezone` is an unresolvable zone other than the file's `SENTINEL`, and is not soft-deleted. Record 'does not throw when every live zone resolves' going red. Record `checked >= 1` staying green when the fixture's own teacher is excluded.
- [ ] **Step 2: Rewrite payment-reminders.** Scope `Payment` to the fixture's payment ids for every asserted call of `sendPaymentReminders` / `processPaymentReminders`. `first`, `markedOverdue` and `reminded` become exact. The deliberate `void repeats` / `void reminded` non-assertions stay: they now could assert, so change each to an exact `toBe(...)` if the value is determined by the fixture, and say why in the test.
- [ ] **Step 3: Rewrite timezone-audit.** Scope `Teacher` to the ids of the teachers the file creates. That means keeping ids the census found the file does not keep (the 'good' teacher, dup-a, dup-b). `auditTeacherTimezones` reads through `teacher.groupBy`, which the helper scopes and counts. `checked` and `teachers` become exact. The two "resolves" tests pass the scoped client.
- [ ] **Step 4:** Run `pnpm exec vitest run --project unit-sweeps src/services/payment-reminders.test.ts` and `pnpm exec vitest run --project unit src/services/timezone-audit.test.ts` → green. Commit:

  ```sh
  git add src/services/payment-reminders.test.ts src/services/timezone-audit.test.ts
  git commit -m "test(payments, timezone-audit): exact sweep counts through a scoped client (#251)"
  ```

- [ ] **Step 5: Protocol steps 2 and 3.** Stray rows present: green. No stray row: the increment deletions from step 1 turn the new exact assertions red. Drop the `Teacher` scope's fixture from the id list and record the timezone count going red. Restore; clean.

---

### Task 6: `waitlist-reconciliation.test.ts` and `waitlist-retention.test.ts`

**Files:**
- Modify: `src/services/waitlist-reconciliation.test.ts`
- Modify: `src/services/waitlist-retention.test.ts`

**Interfaces:**
- Consumes: `scopeSweep` from `'../../tests/scoped-sweep'` (retention only; reconciliation uses id membership).

**Reconciliation, hits 18–22: id membership, not scoping.** The summary carries id lists (`reconciledClassIds`, `failedClassIds`, `failuresByClass`), so assert on the fixture's own id.

- [ ] **Step 1: Prove the coupling (reconciliation).** Hit 19 is way 4. Make the `faulty` hook skip the fixture (throw only for other ids) with a stray candidate class present, and show `failuresByClass.size > 0` stays green. Hit 18: a stray class that reconciles on the second tick resets the streak whether or not the fixture did. Show `allTransientTicks === 0` holds even when the fixture is excluded from the second tick's candidates.
- [ ] **Step 2: Rewrite reconciliation.**
  - Hit 19 (and its twin 20): replace `failuresByClass.size > 0` with `expect(streaks.failuresByClass.has(contended.id)).toBe(true)`. `allTransientTicks > 0` stays, since it is the streak under test, and gains the membership line as its premise. At hit 20 the membership is already pinned by `failedClassIds` containing `contended.id`, so delete the redundant `size > 0`.
  - Hit 18 ('resets on a tick that reconciled a class'): assert the second tick's summary `reconciledClassIds` contains `contended.id` before asserting the reset.
  - Hit 21: assert `healthy.id` is in the resetting tick's `reconciledClassIds`.
  - Hit 22 (`candidates >= 0`): replace it with an assertion the fixture determines, if the test builds one (e.g. `candidates` counted through a scoped client). Otherwise delete the line and say why in the report.
- [ ] **Step 3: Prove the coupling (retention).** Hits 24–27 (ways 1 and 3): plant a stray terminal class more than 365 days past, with one unfulfilled `waitlistEntry`, and an id sorting below the fixtures (`00000000-0000-4000-8000-000000000000`, which the fixture helper never produces with a `uniqueSuffix`). Record the `maxClasses: 1` ordering tests going red (the stray row takes the slot). Record the double-run test's second-run `classes 0` going red if more stray classes exist than the cap drains. If one stray row does not reproduce it, record what did.
- [ ] **Step 4: Rewrite retention.** In hits 24–27 build `scopeSweep(prisma, { WaitlistEntry: { classId: { in: [<fixture class ids>] } }, Class: { id: { in: [<fixture class ids>] } } })` and pass `.db` to `reapClosedWaitlistEntries`. `Class` is scoped too because the reap's `class.count` feeds `eligible`. Hit 26's `classes >= 2` becomes exact. Hit 23 is **unchanged**: its bracket `before - after === summary.deleted` is the right shape. Do not scope it, or the bracket stops measuring the whole table.

  **Order dependency, flagged:** retention's destructive-sweep guard (`beforeAll`, `isTestDatabaseName`) stays first and unchanged.
- [ ] **Step 5:** Run `pnpm exec vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts src/services/waitlist-retention.test.ts` → green. Commit:

  ```sh
  git add src/services/waitlist-reconciliation.test.ts src/services/waitlist-retention.test.ts
  git commit -m "test(waitlist): pin sweep results to the fixture's own classes (#251)"
  ```

- [ ] **Step 6: Protocol steps 2 and 3.** Stray rows present: green. No stray row: make the `faulty` hook skip `contended.id`, and record the membership line going red. Reverse retention's ordering (`orderBy` desc) in `waitlist-retention.ts`, and record the ordering tests going red with the scope in place. Restore; clean.

---

### Task 7: `studio-class-generator.test.ts`, docs

**Files:**
- Modify: `src/services/studio-class-generator.test.ts`
- Modify: `docs/test-database.md`: new subsection after §2's `SWEEP_TESTS` paragraph
- Modify: `AGENTS.md`: the existing `SWEEP_TESTS` bullet

**Interfaces:**
- Consumes: `scopeSweep` from `'../../tests/scoped-sweep'`.

- [ ] **Step 1: Prove the coupling.** Plant a `debris251-` teacher with an active `StudioClassTemplate` whose generation fails non-transiently. Find how: read `generateStudioClassInstances`'s per-template error handling for what rethrows. An invalid timezone on the teacher is the first candidate to try. Record which of the census's `await generateStudioClassInstances(...)` calls reject.
- [ ] **Step 2: Rewrite.** Those calls pass `scopeSweep(prisma, { StudioClassTemplate: { id: { in: [<the test's template ids>] } } }).db`. `generateStudioClassInstances` reads through `studioClassTemplate.findMany`. The 300 ms `sweepSettled === false` timing premise is out of scope (spec); leave it.
- [ ] **Step 3: Docs.** In `docs/test-database.md`, after the paragraph that introduces `SWEEP_TESTS`, add a short subsection. Its content: serialising a file protects it from files running at the same time, not from rows earlier runs left behind, and nothing clears the test database between runs. So a test asserting a sweep's return value, a one-shot mock inside a sweep, or a sweep's cap or ordering passes the sweep `scopeSweep(...).db` from `tests/scoped-sweep.ts`, pairs a `toBe(0)` with `rowsRead`, and leaves whole-table brackets (`before - after === deleted`) unscoped. Link #251. No counts or file rosters. In `AGENTS.md`, extend the `SWEEP_TESTS` bullet with one clause: "…and asserts the sweep's results through `scopeSweep` (`docs/test-database.md` §2)".
- [ ] **Step 4:** Run `pnpm exec vitest run --project unit-sweeps src/services/studio-class-generator.test.ts` → green. Commit:

  ```sh
  git add src/services/studio-class-generator.test.ts docs/test-database.md AGENTS.md
  git commit -m "test(studio-generator): scope the sweep; document the scoped-sweep rule (#251)"
  ```

- [ ] **Step 5: Protocol steps 2 and 3.** Stray row present: green. No stray row: scope to an id nothing holds, and record the fixture's own assertions going red, which proves the scoped call still reaches the fixture. Restore; clean.

---

### Task order

Task 1 first: every other task imports it. Tasks 2–7 are independent of one another but share one worktree and one test database. **Run them one at a time.** Two tasks planting stray rows at once would falsify each other's step 1.

## Results

(Filled in per task by the controller from each task's report: the step-1 red text, step-2 green, step-3 mutations and red text, and any hit that did not reproduce.)
