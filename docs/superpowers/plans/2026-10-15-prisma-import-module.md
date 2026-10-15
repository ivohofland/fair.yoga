# Prisma Import Module Implementation Plan (#886)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every TypeScript import of Prisma's client package goes through `src/lib/prisma-client.ts`, so the Prisma 7 generator's `output` path (#888) changes one file instead of ~335.

**Architecture:** `src/lib/prisma-client.ts` (already the `createPrismaClient` factory from #884) also re-exports the whole package with `export * from '@prisma/client'`, and shadows `PrismaClient` with `export type { PrismaClient }` so that outside the factory `new PrismaClient` is a compile error (TS1362). Every importer is rewritten onto it. An ESLint `no-restricted-imports` pattern refuses `@prisma/client` and `@prisma/client/*` everywhere else.

**Tech Stack:** TypeScript strict, Prisma 6.19, ESLint flat config (`@typescript-eslint/no-restricted-imports`), vitest.

**Spec:** none — single subsystem, one approach after the decisions below (recorded here because the user asked for an uninterrupted run).

## Premise check (measured 2026-10-15, origin/main `acfe009c`)

- Issue says **445** files import `@prisma/client`. Measured: `git grep -lE "from ['\"]@prisma/client" -- ':!docs' | wc -l` → **335** files (332 on `@prisma/client`, 3 on `@prisma/client/runtime/library`). 445 does not reproduce.
- The 3 `runtime/library` `Decimal` importers: holds exactly as listed.
- `class-list-fixtures.ts`'s docblock says the runtime `Decimal` avoids `@prisma/client` because jsdom would choke on it. **Refuted:** four jsdom tests already value-import `Prisma`/enums from `@prisma/client` (`pricing-breakdown.test.tsx`, `pricing-preview.test.tsx`, `profile-form.test.tsx`, `settings/profile/page.test.tsx`), three of them calling `new Prisma.Decimal`. `Prisma.Decimal` is the same class the runtime path exports. So the three move to `Prisma.Decimal` and no runtime subpath is re-exported at all.
- Not import statements, and they stay on the package name on purpose: `tests/setup/undefined-filter-guard.ts` (`vi.mock('@prisma/client')` — it must replace the package's own `PrismaClient`, which the factory constructs) and `src/lib/e2e-prisma-factory.test.ts`'s `vi.doUnmock('@prisma/client')`. Also out of scope: `scripts/prisma-engine-probe.cjs` (#885), `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `src/lib/lockfile-policy.test.ts` (lockfile fixture strings).

## Decisions

1. **One module, not two.** The re-export lives in `src/lib/prisma-client.ts` beside the factory: the file name already maps to the package, the migrate image already copies it, and the undefined-filter guard already names it. A second `src/lib/prisma.ts` would sit next to `@/lib/db`'s `prisma` singleton and invite `Prisma`/`prisma` confusion.
2. **`export *`, not an enumerated list.** Enumerating ~40 models, their enums and `$Enums` is a census that drifts with every schema change; `export *` cannot.
3. **`PrismaClient` is type-only from the module** — a compiler tether that replaces #884's `importNames: ['PrismaClient']` lint rule (stronger: it also catches `import * as P` then `new P.PrismaClient`). Probe before writing this plan: `new PrismaClient()` from a module shaped this way → `TS1362: 'PrismaClient' cannot be used as a value because it was exported using 'export type'`; `typeof PrismaClient` in a type position, `new Prisma.Decimal`, and enum values all still compile.
4. **Import specifier per file:** `@/lib/prisma-client`, except where tsconfig paths are absent or the file already uses relative paths for the factory: `src/services/admin-grants.ts`, `src/services/reserved-slug-holders.ts` → `'../lib/prisma-client'` (migrate image has no tsconfig paths); `scripts/*.ts` → `'../src/lib/prisma-client'`.

## Global Constraints

- No behaviour change. `import type` stays `import type`; an inline `type X` specifier stays inline.
- A file that already imports `createPrismaClient` from the module may keep two statements (one value, one `import type`) — merge only if trivial.
- Comments state what is true now (CLAUDE.md *Comment Discipline*); no "previously imported from…".
- Use Node 24: `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.
- Stage exact paths; quote paths with parentheses.

## Review Focus

1. A `'use client'` module that ends up value-importing the module would bundle the factory into the client — check `git grep -l "^'use client'"` files only ever `import type` from it (today: none value-import `@prisma/client`).
2. Migrate-image files resolving `@/` would break `docker compose run migrate` silently in CI-less local runs — the specifier tests (Task 1) pin it.
3. The `vi.mock('@prisma/client')` guard must still intercept: a test-built client must still carry the undefined-filter guard after the rewrite (`tests/undefined-filter-guard.test.ts` and `src/lib/e2e-prisma-factory.test.ts` cover it).
4. A rewritten multi-line import (`} from '@prisma/client';` on its own line) must be caught by the codemod — 350 `from` lines across 335 files.
5. Inline type queries `import('@prisma/client').PrismaClient` (4, in the two generator tests) are invisible to `no-restricted-imports`; rewrite them by hand.

---

### Task 1: The module re-exports the package

**Files:**
- Modify: `src/lib/prisma-client.ts`
- Modify: `src/lib/prisma-client.test.ts` (imports test)
- Modify: `src/services/admin-grants.ts`, `src/services/admin-grants.test.ts` (imports test)
- Modify: `src/services/reserved-slug-holders.ts` (+ its docblock if it names `@prisma/client`)
- Modify: `Dockerfile` (the comment above `COPY src/lib/prisma-client.ts`)

**Interfaces — Produces:** `@/lib/prisma-client` exports everything `@prisma/client` does (`Prisma`, every model type, every enum value+type, `$Enums`), with `PrismaClient` type-only, plus `createPrismaClient` and `PrismaClientFactoryOptions` unchanged.

- [ ] **Step 1: failing test.** In `prisma-client.test.ts`, add to the imports `describe` a test that the module re-exports runtime values: `import { Prisma, ClassStatus } from './prisma-client'` and assert `new Prisma.Decimal('1.50').toFixed(2) === '1.50'` and `ClassStatus.open === 'open'`. Change `admin-grants.test.ts`'s specifier test to expect every specifier to be `'../lib/prisma-client'` (title: "imports only the Prisma module, which the migrate image carries"). Run `pnpm exec vitest run src/lib/prisma-client.test.ts src/services/admin-grants.test.ts` — expect FAIL (no export / wrong specifier). Note: `admin-grants.test.ts` is an integration-style file; if it needs the DB, run it under `pnpm run worktree:up` first, or run only the specifier test with `-t imports`.
- [ ] **Step 2: implement.** `prisma-client.ts`:
  ```ts
  import { PrismaClient, type Prisma } from '@prisma/client';

  export * from '@prisma/client';
  export type { PrismaClient } from '@prisma/client';
  ```
  Add a docblock sentence on the re-export: this module is the codebase's one importer of the package; `PrismaClient` is type-only here so `createPrismaClient` stays the only constructor; why → `docs/technical-architecture.md`, "Where Prisma comes from". `admin-grants.ts` and `reserved-slug-holders.ts` import from `'../lib/prisma-client'`. Dockerfile comment: the module those scripts and services import; it imports only `@prisma/client`.
- [ ] **Step 3:** run the same tests → PASS. `pnpm exec tsc --noEmit` → clean.
- [ ] **Step 4: prove the tether bites.** Temporarily add to some non-factory file `import { PrismaClient } from '@/lib/prisma-client'; export const x = new PrismaClient();` → record the exact TS1362 text; remove; re-run tsc clean. Temporarily change `admin-grants.ts` back to `'@/lib/prisma-client'` → specifier test fails; record; restore.
- [ ] **Step 5: commit** `refactor: prisma-client.ts re-exports the Prisma package, PrismaClient type-only (#886)`.

### Task 2: Move every importer onto the module

**Files:** every file from `git grep -lE "from ['\"]@prisma/client" -- ':!docs' ':!src/lib/prisma-client.ts'` (334 after Task 1, minus the two Task 1 already moved), plus the 4 inline `import('@prisma/client')` type queries in `src/services/class-generator.test.ts` and `src/services/studio-class-generator.test.ts`, plus comments naming the package as what a file imports: `src/lib/payment-status.ts`, `src/lib/registration-status.ts`, `src/lib/contacts.ts`, `src/lib/api-errors.ts`, `tests/undefined-filter-guard.ts`, `src/components/schedule/class-list-fixtures.ts`. **Not** `tests/setup/undefined-filter-guard.ts` or the `vi.doUnmock` line — see Premise check.

**Interfaces — Consumes:** Task 1's module.

- [ ] **Step 1:** codemod with a script in the scratchpad (not committed): for each file, replace the specifier `'@prisma/client'` / `"@prisma/client"` in `from` clauses with the per-file specifier of Decision 4. Then hand-edit the 4 inline type queries.
- [ ] **Step 2: the three `runtime/library` files** (`class-card.test.tsx`, `class-list-fixtures.ts`, `studio-template-list.test.tsx`): drop the runtime import, import `Prisma` from `@/lib/prisma-client`, write `new Prisma.Decimal(…)` (and `Prisma.Decimal` where used as a type). In the fixture docblock replace the jsdom sentence with nothing, or one line that `Decimal` is `Prisma.Decimal` — no history.
- [ ] **Step 3: comments.** Reword each listed comment so it names the module (`@/lib/prisma-client`) where it means "what this file imports"; read each whole docblock, not just the line.
- [ ] **Step 4: verify.** `git grep -n "@prisma/client" -- ':!docs'` and give every hit a verdict; expected survivors only: `src/lib/prisma-client.ts`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `Dockerfile` comment, `eslint.config.mjs` (until Task 3 rewrites it, then its new rule), `scripts/prisma-engine-probe.cjs`, `.claude/skills/verify/SKILL.md`, `src/lib/lockfile-policy.test.ts`, `tests/setup/undefined-filter-guard.ts`, `src/lib/e2e-prisma-factory.test.ts` (doUnmock line + its docblock), `src/lib/prisma-client.test.ts` / `admin-grants.test.ts` test titles if they still name the package. `pnpm exec tsc --noEmit`, `pnpm run lint`, `pnpm exec vitest run --project unit --project components` green. Check no `'use client'` file value-imports the module (Review Focus 1).
- [ ] **Step 5: commit** `refactor: every Prisma import goes through @/lib/prisma-client (#886)`.

### Task 3: Lint guard and docs

**Files:** `eslint.config.mjs`, `docs/technical-architecture.md` ("Where a Prisma client comes from (#884)" section), `docs/test-database.md` only if it says tests import `@prisma/client`.

- [ ] **Step 1:** replace the #884 block's `paths` entry with
  ```js
  patterns: [
    {
      group: ['@prisma/client', '@prisma/client/*'],
      message: 'Import Prisma from @/lib/prisma-client (#886); it is the one module that names the package.',
    },
  ],
  ```
  keep `ignores: ['src/lib/prisma-client.ts']`, and rewrite the block comment (the `PrismaClient` value restriction is now the module's `export type`).
- [ ] **Step 2: prove it bites.** Add `import type { Prisma } from '@prisma/client';` to a file under each of `src/`, `tests/e2e/`, `scripts/` and `prisma/seed.ts` in turn; `pnpm exec eslint <file>` → record the error; same for `'@prisma/client/runtime/library'`; restore; lint clean.
- [ ] **Step 3: docs.** Retitle the section "Where Prisma comes from (#884, #886)": the module is the one importer; state the `vi.mock` seam (`tests/setup/undefined-filter-guard.ts`, `vi.doUnmock` in `e2e-prisma-factory.test.ts`) and why it must name the package, then give the re-derivation command `git grep -n "@prisma/client" -- ':!docs'` with no roster of the mentions. Note that lint does not see inline `import('…')` type queries or dynamic `import()` expressions.
- [ ] **Step 4:** `pnpm run lint`, `pnpm exec tsc --noEmit` green. Commit `chore: lint refuses a direct @prisma/client import (#886)`.

### After the tasks

Whole-branch review → fix wave → `pnpm run worktree:up` and `pnpm run verify` → PR.
