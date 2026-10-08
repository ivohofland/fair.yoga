# Undefined-filter guard Implementation Plan (#783)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an `undefined` filter value in a bulk write (`deleteMany`, `updateMany`, `updateManyAndReturn`) through a Prisma client that test code built throw before the query runs, instead of silently matching every row. Ship a syntax-level census of the `afterAll`/`afterEach` writes that can hit it.

**Architecture:** One Prisma query extension, defined in `tests/undefined-filter-guard.ts`, with two installers. Vitest mocks `@prisma/client` in a setup file so that a client constructed by test code comes back extended, while a client constructed by app code (`src/lib/db.ts` and the others) comes back plain. Playwright e2e files build their client through a factory, and an ESLint rule bans `new PrismaClient` there. A separate TypeScript-compiler-API census reports the hook writes whose `where` reads a possibly-unassigned binding.

**Tech Stack:** Prisma 6.19 client extensions (`$extends`, `query.$allModels`), Vitest 4 `vi.mock` in `setupFiles`, ESLint flat config `no-restricted-syntax`, the `typescript` compiler API.

**Spec:** `docs/superpowers/specs/2026-10-08-undefined-filter-guard-design.md`. Read it first. It records the measurements and the rejected options.

## Global Constraints

- TypeScript `strict`, no `any`. A cast is acceptable only where the extended-client type genuinely differs from `PrismaClient`, and gets a one-line comment saying that the extended client lacks `$on`/`$use`, which no test calls. It is not a superset: `const x: PrismaClient = client.$extends(ext)` fails with `TS2741: Property '$on' is missing`.
- Comment Discipline (CLAUDE.md): no counts or member rosters in comments. Counts live in `docs/test-database.md` next to the command that re-derives them.
- Never `git add -A` or `git add .`. Stage exact paths. Commit messages end with `(#783)` and the attribution trailer.
- App code's behaviour is unchanged. Nothing under `src/` that is not a test or the census module changes.
- Mutation proofs: break the guard, record the **exact** failure text in the task report, restore, then confirm `git status` is clean apart from intended edits.
- Run DB-touching vitest files from the worktree (`pnpm exec vitest run --project unit <file>`). The unit tier uses the worktree's own test database (`ethical_yoga_test_issue_783`).

## Review Focus

1. **Interactive transactions.** `guarded.$transaction(async (tx) => tx.x.deleteMany({ where: { id: undefined } }))` must reject, because the tx client inherits the extension. Pinned in Task 1.
2. **Batch transactions.** `guarded.$transaction([guarded.x.deleteMany({ where: { id: undefined } })])` must reject without deleting. Pinned in Task 1.
3. **Non-plain values.** `Prisma.DbNull`, `Date` and `Decimal` in a `where` must pass, not be walked into or mistaken for `undefined`. Pinned in Task 1 (walker cases).
4. **A client constructed inside a hook or helper function in a test file**, not at module top level, is still guarded. Pinned in Task 2.
5. **ESLint flat-config override.** The new `tests/e2e` block must keep the existing localhost-origin selector biting in e2e files. Pinned in Task 3 (mutation).

---

### Task 1: The guard: walker, extension, call-site classifier

**Files:**
- Create: `tests/undefined-filter-guard.ts`
- Create: `tests/undefined-filter-guard.test.ts`
- Modify: `vitest.config.ts`. Add `'tests/undefined-filter-guard.test.ts'` to the `unit` project's `include` array, beside `tests/scoped-sweep.test.ts`.

**Interfaces:**
- Produces:
  - `findUndefinedFilterPaths(where: unknown, path?: string): string[]`, with `path` defaulting to `'where'`.
  - `undefinedFilterGuard`, an extension object accepted by `PrismaClient.$extends`. It has `name: 'undefined-filter-guard'` and `query.$allModels.{deleteMany, updateMany, updateManyAndReturn}`.
  - `isTestCallSite(stack: string, ignoreFiles: readonly string[]): boolean`.
  - `UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX = '[undefined-filter-guard]'`.
- **This module must import only types from `@prisma/client`** (`import type`). Task 2 calls it from inside a `vi.mock('@prisma/client')` factory, so a runtime import would be circular.

- [ ] **Step 1: Write the failing walker and classifier tests** in `tests/undefined-filter-guard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { findUndefinedFilterPaths, isTestCallSite } from './undefined-filter-guard';

describe('findUndefinedFilterPaths', () => {
  it('names a top-level undefined value', () => {
    expect(findUndefinedFilterPaths({ classId: undefined, teacherId: 't1' })).toEqual(['where.classId']);
  });
  it('names an undefined inside an operator object (`{ in: ids }` with ids unassigned)', () => {
    expect(findUndefinedFilterPaths({ id: { in: undefined } })).toEqual(['where.id.in']);
  });
  it('names an undefined array element', () => {
    expect(findUndefinedFilterPaths({ id: { in: ['a', undefined] } })).toEqual(['where.id.in[1]']);
  });
  it('walks AND/OR/NOT and relation filters', () => {
    expect(
      findUndefinedFilterPaths({ AND: [{ x: 1 }, { class: { teacherId: undefined } }] }),
    ).toEqual(['where.AND[1].class.teacherId']);
  });
  it('treats an explicitly undefined where as a hazard', () => {
    expect(findUndefinedFilterPaths(undefined)).toEqual(['where']);
  });
  it('passes a fully defined filter, Prisma.DbNull, Dates and Decimals', () => {
    expect(
      findUndefinedFilterPaths({
        a: 'x',
        b: Prisma.DbNull,
        c: { gte: new Date(0) },
        d: new Prisma.Decimal(1),
        e: null,
      }),
    ).toEqual([]);
  });
});

describe('isTestCallSite', () => {
  const setup = '/repo/tests/setup/undefined-filter-guard.ts';
  const frame = (file: string): string => `    at something (${file}:10:5)`;
  const stack = (...files: string[]): string => ['Error', ...files.map(frame)].join('\n');

  it('is true when the first non-library frame is a test file', () => {
    expect(isTestCallSite(stack('/repo/node_modules/x/y.js', setup, '/repo/src/app/api/a/route.test.ts'), [setup], '/repo')).toBe(true);
  });
  it('is true for a module under tests/', () => {
    expect(isTestCallSite(stack(setup, '/repo/tests/class-fixtures.ts'), [setup], '/repo')).toBe(true);
  });
  it('is false for app code', () => {
    expect(isTestCallSite(stack(setup, '/repo/src/lib/db.ts', '/repo/src/app/api/a/route.test.ts'), [setup], '/repo')).toBe(false);
  });
  it('is false for a tests/ directory outside the repo root', () => {
    expect(isTestCallSite(stack(setup, '/elsewhere/tests/x.ts'), [setup], '/repo')).toBe(false);
  });
});
```

Match the stack frame format that V8 actually produces under vitest. Before finalizing, log `new Error().stack` once from a test file, and adjust the regex (not the test's intent) if the frames carry `file://` URLs or a query suffix such as `?v=…`. Add a case for whichever form you see.

- [ ] **Step 2: Run it and see it fail.** Run `pnpm exec vitest run --project unit tests/undefined-filter-guard.test.ts`. Expected: FAIL, because the module does not exist.

- [ ] **Step 3: Implement `tests/undefined-filter-guard.ts`.**
  - The walker recurses into arrays and **plain** objects only (`Object.getPrototypeOf(v) === Object.prototype || === null`). Everything else is a leaf. `undefined` at any position, including `where` itself, yields its path. Keys use `.key` and array elements use `[i]`.
  - The extension handler: `async deleteMany({ model, operation, args, query })`. If `'where' in args` and the walker finds paths, throw `new Error(\`${PREFIX} ${model}.${operation}: ${paths.join(', ')} is undefined. Prisma drops an undefined filter value and this write would match every row. Assign the binding, guard the write (if (id) …), or omit the key.\`)`. Otherwise `return query(args)`. Use the same body for `updateMany` and `updateManyAndReturn`. An `args` with no `where` key passes, because that is a deliberate all-rows call.
  - `isTestCallSite`: parse each `at …(path:line:col)` or `at path:line:col` frame and strip `file://` and any `?query`. Skip `node:` frames, paths containing `/node_modules/`, and paths in `ignoreFiles`. The first remaining frame decides. Make it relative to the repo root first (a `repoRoot` parameter, so a checkout under any directory named `tests` is not misread). It is true iff the relative path matches `/\.(test|spec)\.tsx?$/` or starts with `tests/`. With no remaining frame, or a frame outside the repo root, return false. The signature becomes `isTestCallSite(stack: string, ignoreFiles: readonly string[], repoRoot: string): boolean`. Update the Step 1 cases to pass `'/repo'`, and add a case where `/elsewhere/tests/x.ts` with repo root `/repo` is false. The stack frames under vitest are plain absolute paths. The plan review measured this.
  - The extension is a plain object typed with `import type` only, for example `satisfies Parameters<PrismaClient['$extends']>[0]` or whatever type-only form compiles. Never use `Prisma.defineExtension`, because a runtime import would be circular inside Task 2's mock factory.
  - Header docblock: why (`undefined` is dropped by Prisma), and that the installers are `tests/setup/undefined-filter-guard.ts` and `tests/e2e/prisma.ts`. Do not count them.

- [ ] **Step 4: Run the tests and see them pass** (same command).

- [ ] **Step 5: Add the DB-backed extension tests.** These use an explicitly extended client, because the installer arrives in Task 2. Seed sentinel rows in `DegradationEvent`, a leaf table with `code String @id` and `sample Json` (first check `grep -rn "degradationEvent.deleteMany" src tests` for a file that clears the whole table in the parallel `unit` tier, and report any). Fence every write with `code: { in: sentinels }`, so a broken guard can only ever delete this test's own rows:

```ts
const raw = new PrismaClient();
const guarded = raw.$extends(undefinedFilterGuard);
const sentinels = [`ufg-783-${uniqueSuffix()}-a`, `ufg-783-${uniqueSuffix()}-b`];
let unassigned: Date | undefined; // stands in for a beforeAll-assigned binding that never got its value

beforeAll(async () => {
  await raw.degradationEvent.createMany({ data: sentinels.map((code) => ({ code, sample: {} })) });
});
afterAll(async () => {
  await raw.degradationEvent.deleteMany({ where: { code: { in: sentinels } } });
  await raw.$disconnect();
});
const remaining = (): Promise<number> => raw.degradationEvent.count({ where: { code: { in: sentinels } } });
```

Write tests that each assert both the rejection, matched on `UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX` and the path `where.lastNotifiedAt`, and `remaining()` still equal to `2`:
- `guarded.degradationEvent.deleteMany({ where: { code: { in: sentinels }, lastNotifiedAt: unassigned } })`
- the same via `updateMany` with `data: { occurrences: 99 }`, and also assert no sentinel has `occurrences: 99`;
- the same inside `guarded.$transaction(async (tx) => tx.degradationEvent.deleteMany(...))` (Review Focus 1);
- the same as `guarded.$transaction([guarded.degradationEvent.deleteMany(...)])` (Review Focus 2);
- a positive control: `guarded.degradationEvent.updateMany({ where: { code: { in: sentinels } }, data: { occurrences: 2 } })` resolves with `count: 2`.

Import `uniqueSuffix` from `./helpers`. The `undefined` must come from a binding the compiler cannot prove undefined, so do not write a literal `undefined`.

- [ ] **Step 6: Run the file and see it pass.**

- [ ] **Step 7: Mutation proofs.** Record the exact failure text for each, then restore:
  1. The walker skips arrays (`Array.isArray` branch returns `[]`). Expected RED: the `in[1]`, `AND`, and batch/positional cases.
  2. The handler calls `query(args)` without checking. Expected RED: every rejection test fails, and the deleteMany cases show `remaining()` at 0. That shows the fence held and only sentinels went.
  3. `isTestCallSite` always returns true. Expected RED: the app-code case.

- [ ] **Step 8: Run `pnpm run typecheck && pnpm run lint`, then commit.**

```bash
git add tests/undefined-filter-guard.ts tests/undefined-filter-guard.test.ts vitest.config.ts
git commit -m "test: a Prisma extension refuses a bulk write whose filter holds undefined (#783)"
```

---

### Task 2: Install the guard on every client vitest test code builds

**Files:**
- Create: `tests/setup/undefined-filter-guard.ts`
- Modify: `vitest.config.ts`. Add the setup file to `setupFiles` of `unit`, `unit-sweeps` and `integration`. `integration` has no `setupFiles` today, so add the key. Leave `components` alone.
- Modify: `tests/undefined-filter-guard.test.ts` (installer pins)

**Interfaces:**
- Consumes: `undefinedFilterGuard`, `isTestCallSite`, `UNDEFINED_FILTER_GUARD_MESSAGE_PREFIX` (Task 1).
- Produces: in vitest, `new PrismaClient()` from test code returns a guarded client, and from app code a plain one.

- [ ] **Step 1: Write the failing installer pins** in `tests/undefined-filter-guard.test.ts`, in a new `describe`:
  - A `new PrismaClient()` constructed **at module level of this test file** rejects the fenced `deleteMany` with the prefix, and the sentinels remain.
  - A client constructed **inside a function called from a hook** (`function build(): PrismaClient { return new PrismaClient(); }`, called in `beforeAll`) rejects the same way (Review Focus 4).
  - `import { prisma as appPrisma } from '@/lib/db'`: `appPrisma.degradationEvent.deleteMany({ where: { code: \`ufg-783-absent-${uniqueSuffix()}\`, lastNotifiedAt: unassigned } })` **resolves** with `count: 0`. The app's client is unguarded, and the impossible code fences it.
- [ ] **Step 2: Run the file and see the first two pins fail** (no installer yet).
- [ ] **Step 3: Implement the setup file.**

```ts
import { vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isTestCallSite, undefinedFilterGuard } from '../undefined-filter-guard';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '../..');

vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  class GuardedPrismaClient extends actual.PrismaClient {
    constructor(...args: ConstructorParameters<typeof actual.PrismaClient>) {
      super(...args);
      if (isTestCallSite(new Error().stack ?? '', [SELF], REPO_ROOT)) {
        // (one-line comment on the cast, if one is needed)
        return this.$extends(undefinedFilterGuard) as unknown as GuardedPrismaClient;
      }
    }
  }
  return { ...actual, PrismaClient: GuardedPrismaClient };
});
```

  Add a header comment stating what this file does: a client built by test code is guarded, a client built by app code is not, and why app code is exempt (its `undefined` filters are deliberate and must behave as in production). Link the spec. Verify that `SELF` matches the path form `isTestCallSite` sees. If V8 reports the setup file with a different path (a `?` suffix, for example), normalize both sides the same way.
- [ ] **Step 4: Run the guard file. All pins pass.**
- [ ] **Step 5: Run the whole suite under the guard.** Run `pnpm run worktree:up`, then `pnpm test`. Every rejection whose message carries the prefix is a test genuinely writing with an `undefined` filter. Fix the test, not the guard. Report each one with its file, line and fix. This includes an app module that takes a `PrismaClient` parameter and receives the test's client: fix that call with an explicit filter, never by weakening the guard, and report it as a production-code change. Then give `src/app/api/auth/session/route.test.ts`'s `afterAll` #782-style guards (`if (accountId) …` around each write keyed on it). It cleans up through the `@/lib/db` singleton, which the guard deliberately leaves plain, so its `{ where: { accountId } }` is the issue's hazard unguarded. Any **other** new failure (a spy on an extended delegate, `instanceof`, etc.) is an installer defect. Stop and report it with the error text rather than working around it in the test.
- [ ] **Step 6: Mutation proofs** (record exact text, restore):
  1. The setup file never extends (delete the `return`). Expected RED: the module-level and in-hook pins.
  2. The setup file always extends (drop the `isTestCallSite` check). Expected RED: the `@/lib/db` pin, with the guard's message.
  3. Remove the setup file from `unit`'s `setupFiles`. Expected RED: the module-level pin.
- [ ] **Step 7: Run the recorded acceptance-3 demonstration. Do not commit it.** Create a scratch file `tests/ufg-scratch.test.ts`, temporarily added to `unit`'s include list. It seeds three `DegradationEvent` rows with a `ufg-scratch-` prefix, has a `describe` whose `beforeAll` throws before `let code: string;` is assigned, and whose `afterAll` runs `prisma.degradationEvent.deleteMany({ where: { code } })`. Count the table's rows before and after from a second client in a separate step: run the file, then `count` from a tsx one-liner or a second test. Run it with the guard installed, and record the vitest output and the row counts (unchanged). Remove `unit`'s setup entry and run it again, and record that the count fell to zero (the whole table, on this worktree's isolated database). Restore the config, delete the scratch file, and confirm `git status` shows only intended edits. **Run this file alone**, never alongside other files.
- [ ] **Step 8: Run `pnpm run typecheck && pnpm run lint`, then commit.**

```bash
git add tests/setup/undefined-filter-guard.ts tests/undefined-filter-guard.test.ts vitest.config.ts
git commit -m "test: every Prisma client vitest test code builds carries the undefined-filter guard (#783)"
```

(Add any test files fixed in Step 5, each by exact path, in a separate preceding commit `test: <file> no longer writes through an undefined filter (#783)`.)

---

### Task 3: Playwright builds its client through a guarded factory

**Files:**
- Create: `tests/e2e/prisma.ts`, exporting `createGuardedPrismaClient(): PrismaClient`, i.e. `new PrismaClient().$extends(undefinedFilterGuard)`, with the cast comment if the type needs it.
- Modify: each file listed by `grep -rlE "new PrismaClient\(" tests/e2e`. Replace the construction with `createGuardedPrismaClient()`. Drop the `PrismaClient` import where it is no longer used, and keep it as `import type` where it is still a type.
- Modify: `eslint.config.mjs`. Add a block `{ files: ['tests/e2e/**/*.ts'], ignores: ['tests/e2e/prisma.ts'], rules: { 'no-restricted-syntax': ['error', <the existing localhost selector object, hoisted into a shared const the way `teacherStudentWriteSelector` already is, and referenced from both blocks>, { selector: "NewExpression[callee.name='PrismaClient']", message: 'Build e2e Prisma clients with createGuardedPrismaClient() from tests/e2e/prisma.ts; it refuses bulk writes whose filter holds undefined (#783).' }] } }` **after** the existing `tests/**` block. Flat config replaces a rule's options per matching block, so the localhost selector must be repeated here. Add a comment saying so.

- [ ] **Step 1: Make the failing lint check.** Add the ESLint block first and run `pnpm run lint`. Expected: one error per e2e file. Record the count against the grep above.
- [ ] **Step 2: Create `tests/e2e/prisma.ts` and convert the files.**
- [ ] **Step 3: Run `pnpm run lint && pnpm run typecheck`. Both are green.**
- [ ] **Step 4: Mutation proofs** (record the exact lint text, restore):
  1. Reintroduce `new PrismaClient()` in one e2e spec. Expected: the new rule's message.
  2. Put `'http://localhost:3000'` in one e2e spec. Expected: the localhost message, which proves the override kept it (Review Focus 5).
- [ ] **Step 5: Run two converted specs end to end.** With `pnpm run worktree:up`, run `pnpm exec playwright test tests/e2e/booking.spec.ts tests/e2e/auth.spec.ts` to show the factory client works under Playwright's loader. If the worktree cannot run Playwright, say so and rely on CI.
- [ ] **Step 6: Commit.**

```bash
git add eslint.config.mjs tests/e2e/prisma.ts <each converted spec by path>
git commit -m "test: e2e specs build their Prisma client through the undefined-filter guard (#783)"
```

---

### Task 4: The census of hook writes that can filter on undefined

**Files:**
- Create: `src/lib/hook-filter-census.ts` (analyzer)
- Create: `src/lib/hook-filter-census.test.ts`
- Create: `scripts/census-hook-filters.ts` (CLI)
- Modify: `package.json`. Add `"census:hook-filters": "tsx scripts/census-hook-filters.ts"`.
- Modify: `docs/test-database.md`. Add a new section on undefined filters in test cleanup.

**Interfaces:**
- Produces:

```ts
export type HookFilterFinding = {
  file: string;          // repo-relative
  line: number;          // 1-based line of the write or call
  hook: 'afterAll' | 'afterEach';
  kind: 'direct' | 'indirect';   // direct: the bulk write itself; indirect: a call passing the binding to a function
  call: string;          // e.g. 'prisma.class.deleteMany' or 'teardownTeacher'
  bindings: string[];    // possibly-undefined bindings it reads
  guarded: boolean;      // every binding is tested by an enclosing if / && / ?: inside the hook
  client: 'test' | 'app'; // 'app' when the write's receiver resolves to an import from '@/lib/db' — the guard does not cover it
};
export function censusHookFilters(program: ts.Program, files: readonly string[], repoRoot: string): HookFilterFinding[];
```

- Rules, from the spec's census section:
  - Hook calls are `afterAll(fn)`, `afterEach(fn)`, `test.afterAll(fn)` and `test.afterEach(fn)`.
  - A direct write is a call whose callee is a property access named `deleteMany`, `updateMany` or `updateManyAndReturn`, with an object-literal first argument that has a `where` property.
  - The bindings are the identifiers inside the `where` initializer that are not property names. Resolve each with `checker.getSymbolAtLocation`, taking the shorthand-property symbol via `getShorthandAssignmentValueSymbol`.
  - A binding is possibly-`undefined` when its declaration is a `VariableDeclaration` in a `let`/`var` list with no initializer.
  - An indirect call is any other call inside the hook that passes a possibly-`undefined` binding as a direct argument.
  - `guarded` means an ancestor between the call and the hook callback is an `IfStatement` or a `&&`/`?:` expression whose condition mentions the binding.

- [ ] **Step 1: Write the failing analyzer tests.** Build an in-memory `ts.Program` from a `Record<string, string>` of sources with a custom `CompilerHost`. Use a small helper in the test file that falls back to the real host for lib files. Cases:
  - unguarded direct (`let classId: string;` assigned in `beforeAll`, `afterAll` deletes `{ where: { classId } }`);
  - `{ id: { in: ids } }` with `let ids: string[];`;
  - guarded by `if (classId)`, so `guarded: true`;
  - an initialized `let ids: string[] = []`, which yields no finding;
  - a `const`, which yields no finding;
  - an indirect `teardownTeacher(prisma, teacherId)`;
  - `test.afterAll` (Playwright);
  - `afterEach`;
  - a `deleteMany` outside any hook, which yields no finding;
  - a receiver imported as `import { prisma } from '@/lib/db'`, which yields `client: 'app'`, while a locally constructed one yields `'test'`. Print the column in the CLI, and in the docs section say that `app` rows are outside the guard's reach.
- [ ] **Step 2: Run the file and see it fail.** Run `pnpm exec vitest run --project unit src/lib/hook-filter-census.test.ts`.
- [ ] **Step 3: Implement the analyzer. Run the tests and see them pass.**
- [ ] **Step 4: Write the CLI.** It collects files with `git ls-files` matching `*.test.ts`, `*.test.tsx`, `*.spec.ts` and `tests/**/*.ts`. It builds one program with the root `tsconfig.json` options, then prints each finding as `UNGUARDED|guarded  direct|indirect  file:line  call  [bindings]`, sorted by file and line. It ends with totals by `guarded × kind` and exits 0, because it is a report, not a gate. Run it and keep the output for the PR body.
- [ ] **Step 5: Mutation proofs** (record exact text, restore):
  1. Treat an initialized `let` as possibly-undefined. Expected RED: the initialized-`let` case.
  2. Ignore the guard ancestors. Expected RED: the `if (classId)` case.
  3. Drop `getShorthandAssignmentValueSymbol` and resolve the property-name symbol. Expected RED: the shorthand case. If that mutation is inert because the checker resolves both the same way, record that as the finding.
  4. **Cross-check the CLI against reality.** Pick three UNGUARDED rows from the real output and open each file. Confirm by reading that the binding is a no-initializer `let` assigned in a hook. Pick `src/app/api/registrations/route.test.ts:204`, which the issue names, if it appears.
- [ ] **Step 6: Document it** in `docs/test-database.md`, in a new section titled *Undefined filters in test cleanup (#783)*:
  - the hazard, in one paragraph;
  - the guard and its two installers, by path;
  - what is exempt and why (app-built clients);
  - the command `pnpm run census:hook-filters`, with the totals from Step 4 and the date `2026-10-08`;
  - one line saying the census reports and does not gate, because the guard is the gate.
- [ ] **Step 7: Run `pnpm run typecheck && pnpm run lint`, then commit.**

```bash
git add src/lib/hook-filter-census.ts src/lib/hook-filter-census.test.ts scripts/census-hook-filters.ts package.json docs/test-database.md
git commit -m "test: a syntax-level census of hook writes whose filter can be undefined (#783)"
```

---

## Order

1 → 2 → 3 → 4. Tasks 2 and 3 consume Task 1's exports. Task 4 is independent of 2 and 3, but its docs section names their installers, so it goes last.
