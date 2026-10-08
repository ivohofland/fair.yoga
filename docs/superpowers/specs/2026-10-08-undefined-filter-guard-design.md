# Undefined-filter guard for test-built Prisma clients (#783)

## Problem

A test declares `let classId: string;`, assigns it in `beforeAll`, and cleans
up in `afterAll` with `prisma.x.deleteMany({ where: { classId } })`. If
`beforeAll` throws before the assignment, `classId` is `undefined` at runtime.
Prisma drops an `undefined` filter value as "no condition", so the delete
matches every row of the table. This happened twice in #669: once in an e2e
`afterAll` and once in an integration `afterAll`.

## What the premise check measured (origin/main @ 136b4d0e)

- **Test code does not share the app's client.**
  `grep -rlE "new PrismaClient\(" src tests --include='*.ts' --include='*.tsx' | grep -E '\.test\.|^tests/' | wc -l`
  → 203 files construct their own client. `grep -rlE "from '@/lib/db'" src tests --include='*.test.ts' --include='*.test.tsx' | wc -l`
  → 6 test files also import the app singleton, which their spies
  (`vi.spyOn(prisma.session, …)`) target.
- **The app builds clients in three files outside tests:** `src/lib/db.ts`,
  `src/lib/db-provision.ts`, `src/lib/worktree/side-effects.ts`
  (`grep -rlE "new PrismaClient\(" src --include='*.ts' | grep -v '\.test\.'`,
  which also lists `src/services/gdpr.ts`, but that hit is a comment).
- **Playwright builds its own:** `grep -rlE "new PrismaClient\(" tests/e2e | wc -l`
  → 20 files, each `const prisma = new PrismaClient();`. `vi.mock` cannot reach
  them.
- No test calls `$on`/`$use`, which extended clients lack.
- #782's guarded blocks (`if (classId) …`, `if (ids.length) …`) never pass
  `undefined`, so a guard that throws only on an actual `undefined` leaves them
  working. Their `if` checks still decide whether a write runs, so they stay
  load-bearing.
- The issue's grep (40 lines within 12 lines of an `afterAll`) is not a census.
  The census below replaces it.

## Options considered

1. **ESLint rule over the hook's AST.** It reads syntax only. It cannot see an
   `undefined` that reaches a helper's `deleteMany` (`teardownTeacher(db, teacherId)`),
   an array built from unassigned ids, or a destructured binding. Rejected as
   the mechanism. Its analysis survives as the census, which is a report and
   not a gate.
2. **Prisma's `strictUndefinedChecks` preview feature.** It applies to the
   whole client, so the app's deliberate `undefined` filters would all need
   rewriting to `Prisma.skip`. That changes production code, which the issue
   rules out. Rejected.
3. **A query extension on clients built by test code.** Chosen. It sees the
   runtime value whatever path it took, and it needs no per-file edits in
   vitest.

## Design

### The guard (`tests/undefined-filter-guard.ts`)

- `findUndefinedFilterPaths(where: unknown): string[]` walks plain objects and
  arrays. That covers `AND`/`OR`/`NOT`, relation filters and `in: [...]`. It
  returns the path of every `undefined` it meets, e.g. `where.classId` or
  `where.id.in[0]`. A `where` key whose value is `undefined` counts too.
  Non-plain objects such as `Date`, `Decimal`, `Buffer` and `Prisma.DbNull`
  are leaves. `Prisma.skip` does not exist in this client, because the schema
  does not enable `strictUndefinedChecks`. Calling the method with no argument, or with no `where` key, is a
  deliberate "all rows" and passes.
- `undefinedFilterGuard` is a plain extension object, typed only through
  `import type` from `@prisma/client`. A runtime import would be circular
  inside the vitest mock factory. It intercepts
  `deleteMany`, `updateMany` and `updateManyAndReturn` on `$allModels`. If any
  path is found, it throws **before** the query runs. The message names the
  model, the operation and the paths, and says why: Prisma drops the
  `undefined` and the write would match every row.
- Only the three bulk writes are guarded. A unique-`where` method (`delete`,
  `update`, `upsert`) already rejects an `undefined` key, and reads destroy
  nothing.

### Installers: which client gets it

- **Vitest** (`tests/setup/undefined-filter-guard.ts`, added to `setupFiles`
  of `unit`, `unit-sweeps` and `integration`). It calls
  `vi.mock('@prisma/client')` and re-exports the real module with a
  `PrismaClient` that inspects its construction stack. A client constructed by
  test code is returned extended with the guard. A client constructed by app
  code is returned plain. Test code means the first non-`node_modules` frame
  outside the setup module is a `*.test.ts(x)`/`*.spec.ts` file or lies under
  `tests/`. App code that writes through its own client (the `@/lib/db`
  singleton) therefore keeps its deliberate `undefined` filters as in
  production. An app module that takes a `PrismaClient` parameter and is
  handed a test's client is guarded under test. That module's `undefined`
  filter then throws in the suite, and the fix is an explicit filter in that
  call, not a weaker guard. The plan review found no inline `?:` or `??` in
  the app's bulk writes, so little of this is expected. `components` has no
  database and is left alone.
- **The blind spot this leaves:** test cleanup written against the app
  singleton (`import { prisma } from '@/lib/db'`) is not guarded, because
  `src/lib/db.ts` built that client. `src/app/api/auth/session/route.test.ts`
  had exactly the issue's hazard there: an unguarded `afterAll` deleting by a
  hook-assigned `accountId`. It gets #782-style guards in this branch, and
  the census reports any such write in a column of its own (`client: 'app'`),
  so the class stays visible.
- **Playwright** has no module mocking. The 20 e2e files switch to a
  `createGuardedPrismaClient()` factory exported by `tests/e2e/prisma.ts`. (The
  guard module, `tests/undefined-filter-guard.ts`, imports only types from
  `@prisma/client`, so the vitest installer can call it inside a
  `vi.mock('@prisma/client')` factory.) An
  ESLint `no-restricted-syntax` rule on `tests/e2e/**` bans `new PrismaClient`
  there, so a new spec cannot silently skip the guard.

### What this does not do

- It does not rewrite the hooks the census lists. With the guard on, each one
  fails loudly instead of wiping a table, which is the acceptance bar. Whether
  a given block also wants #782-style `if` guards is a per-file choice.
- It does not touch rows leaking into the database (#177, #580) or teardown
  order against foreign keys (#617). Both are unaffected.

## The census (acceptance 1)

`src/lib/hook-filter-census.ts` is the analyzer, with a unit test.
`scripts/census-hook-filters.ts` is the CLI, run as
`pnpm run census:hook-filters`. It builds a TypeScript `Program` over every
vitest and Playwright test file. For each `afterAll`/`afterEach` (and
`test.afterAll`/`test.afterEach`) callback it:

- finds each direct `.deleteMany`/`.updateMany`/`.updateManyAndReturn` call,
  and resolves every identifier in its `where` through the type checker to
  its declaration;
- flags a binding as possibly-`undefined` when it is a `let` or `var` with no
  initializer;
- reports whether the write sits under an `if`/`&&`/`?:` whose condition
  mentions that binding, or after an earlier `if (…) return;`/`throw` that
  mentions it (**guarded**), or not (**unguarded**);
- separately lists calls in the hook that pass a possibly-`undefined` binding
  as an argument to a function. That is the indirect shape. It skips the
  non-bulk methods of a Prisma model delegate (reads, `create`, unique-`where`
  methods), recognising a delegate by its type. A function declaration, or a
  `const`-bound arrow or function expression, in the same file is followed one
  level deep; a helper in another file is listed as an indirect call and not
  followed. The owning description, with what the census does not see, is
  `docs/test-database.md`, section "Undefined filters in test cleanup (#783)".

The command, its output count and the date go in `docs/test-database.md`,
where a count has an owner.

## Proof (acceptance 2–4)

- **Committed pin** (`tests/undefined-filter-guard.test.ts`, in `unit`):
  - The pure walker's cases.
  - A client built in the test file rejects
    `deleteMany({ where: { id: { in: sentinelIds }, <field>: unassigned } })`
    with the guard's message, and the two sentinel rows still exist. The
    sentinel fence means a future regression deletes only the test's own rows,
    never a shared table.
  - The `@/lib/db` singleton does not throw for an `undefined` filter fenced by
    an impossible id (count 0), which proves app code is not guarded.
- **Recorded mutations** (in the task reports and the PR body, not
  committed):
  1. A scratch file whose `beforeAll` throws before assigning an id, with
     `afterAll` running `deleteMany({ where: { id } })` on a leaf table seeded
     with rows. With the guard on, `afterAll` fails with the guard's text and
     the row count is unchanged. With the guard off, the count goes to zero.
     This runs alone, on the worktree's isolated test database.
  2. Each committed pin turns RED under its own mutation: walker skips arrays,
     installer guards nothing, installer guards everything.
  3. The ESLint ban turns RED on a reintroduced `new PrismaClient()` in an e2e
     file.
- **Acceptance 4:** the whole suite is green with the guard installed.
