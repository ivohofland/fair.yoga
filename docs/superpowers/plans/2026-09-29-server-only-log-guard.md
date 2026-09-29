# Server-only logger guard Implementation Plan (#337)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-verified "no client component reaches the logger" argument with a build-time guard, and remove the importer censuses that argued it.

**Architecture:** `src/lib/log.ts` imports the `server-only` marker package. Next resolves it to an empty module in every server layer and fails `next build` when any `'use client'` chain value-imports it. Vitest resolves the package's throwing default, so the test config aliases it to the empty module. The comments that justified individual `@/lib/log` imports by counting importers become one-line pointers to `log.ts`'s header, which owns the rule.

**Tech Stack:** Next.js 16 (Turbopack build), `server-only@0.0.1`, Vitest 4.

**Spec:** none. This is a bounded change and the design was approved in chat. The issue is #337; the premise measurements are recorded under "Measured before planning" below.

## Global Constraints

- Stage exact paths. Never `git add -A` or `git add .`.
- Comments state what is true now: no counts, no importer rosters, no "this previously read X" (CLAUDE.md, Comment Discipline).
- Every mutation in this plan is restored by exact text, and each task ends with `git status --short` showing only that task's intended files.
- Restoring a mutation must not use `git checkout` on a file that also holds uncommitted task work. Commit the task's real change first.

## Measured before planning

- The clean build with the guard passes, and the built standalone server boots with `scheduler started` logged (the instrumentation-hook path is outside the RSC layer).
- A leak with the guard (`'use client'` `archive-template-button.tsx` value-importing `withSlot` from `@/services/class-template-lifecycle`) fails the build. The error is `'server-only' cannot be imported from a Client Component module`, and the trace names `archive-template-button.tsx` → `class-template-lifecycle.ts` → `log.ts`.
- The same leak without the guard gives a build that exits 0, and pino lands in `.next-build/static/chunks/`. Nothing caught this before this change.
- Vitest importing `log.ts` unaliased fails with `This module cannot be imported from a Client Component module`.
- `prisma/seed.ts`, which runs under `tsx` outside Next, imports only `@/lib/time-of-day` and never reaches the logger.

## Census-style sites (the scope the user chose)

These are the comments that justify an `@/lib/log` import by asserting who imports the module:

- `src/services/class-template-lifecycle.ts` (the "sole importer" block above `import { log }`)
- `src/services/studio-class-template-lifecycle.ts` (the same block)
- `src/services/waitlist.ts` (the "CHECKED rather than assumed" block with the two grep commands)

Out of scope, by the user's decision: the comments explaining why a module is kept import-free (`waitlist-status.ts`, `class-fields.ts`, `tiers.server.ts` and others). `entry-generation.ts`'s grep census is about import cycles, not server-only.

---

### Task 1: The guard, the test alias, and proof both bite

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (the `server-only` dependency; already added during the premise spike)
- Modify: `src/lib/log.ts` (the import, plus a header paragraph that owns the rule)
- Modify: `vitest.config.ts` (the alias, plus a one-line reason)

- [ ] **Step 1:** `server-only` is in `dependencies` (not devDependencies, because the production build resolves it), and `import 'server-only';` is the first import in `log.ts`.
- [ ] **Step 2:** In `log.ts`'s header, replace "Client components keep using console.* (this module is server-only)." with a short paragraph that says:
  - This module imports `server-only`, so `next build` fails when any `'use client'` module value-imports it, directly or through any chain of imports.
  - Client code logs with `console.*`.
  - A client component that needs a type from a module that reaches this one uses `import type`, which erases.
- [ ] **Step 3:** In `vitest.config.ts`, the alias `'server-only': path.resolve(__dirname, './node_modules/server-only/empty.js')` sits beside `'@'`. Give it a comment of at most two lines: vitest resolves the package's default export, which throws, whereas Next resolves `react-server` → `empty.js` for server code.
- [ ] **Step 4: Prove the alias is needed.** Remove the alias line (keep the exact text). Run `pnpm exec vitest run --project unit src/services/waitlist.test.ts`. Expected: FAIL, with `This module cannot be imported from a Client Component module` in the output. Record the exact error line. Restore the alias by exact text and rerun: PASS.
- [ ] **Step 5: Commit** `package.json`, `pnpm-lock.yaml`, `src/lib/log.ts`, `vitest.config.ts`.
- [ ] **Step 6: Prove the guard bites (build).** Add these two lines after the `next/navigation` import in `src/components/settings/archive-template-button.tsx`:
  ```ts
  import { withSlot } from '@/services/class-template-lifecycle'; // MUTATION337
  console.log(withSlot); // MUTATION337
  ```
  Then run `pnpm run build`. Expected: exit 1, with `'server-only' cannot be imported from a Client Component module` and an import trace listing `archive-template-button.tsx`. Record the exact lines. Remove both lines by exact text. Confirm that `grep -rn MUTATION337 src` prints nothing and that `git status --short` is clean.
  - The unguarded half (guard removed plus leak, giving exit 0 with pino in `static/chunks`) was run with the user's permission during planning. Do not rerun it: the auto-mode classifier blocks it, and its result is recorded above.
- [ ] **Step 7:** `pnpm run build` on the restored tree exits 0.

### Task 2: Rewrite the census-style comments and the hazard line

**Files:**
- Modify: `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts`, `src/services/waitlist.ts` (the blocks listed under "Census-style sites")
- Modify: `.claude/skills/solve-issue/SKILL.md` (the "`@/lib/log` is pino and server-only" hazard bullet)

**Interfaces:**
- Consumes: Task 1's `log.ts` header paragraph, which is what each site points at. Read it before writing the pointers so each pointer matches what the header says.

- [ ] **Step 1:** Replace each of the three blocks with one comment line directly above `import { log } from '@/lib/log';`:
  ```ts
  // Server-only: the build rejects a client import of this chain (see `@/lib/log`'s header).
  ```
  Each line names no importer and no count. In `waitlist.ts`, the two grep commands and the needle explanation go too, because they re-derived the claim the build now enforces.
- [ ] **Step 2:** In `SKILL.md`, replace the bullet with one saying that `@/lib/log` imports `server-only`, so `next build` fails on any `'use client'` chain that value-imports it; `import type` is the way to share a type across that line; and `pnpm run verify` does not run the build, so the check runs in CI or locally with `pnpm run build`.
- [ ] **Step 3: Sweep what was invalidated.** Run `grep -rn -E "sole importer|CHECKED rather than assumed|transitive import chain" src .claude docs CLAUDE.md`. The only hits allowed are in `docs/superpowers/` (plans and specs are records). Read the whole new `log.ts` header once more against Task 1's Step 2.
- [ ] **Step 4:** Run `pnpm run typecheck && pnpm run lint`: PASS.
- [ ] **Step 5: Commit** the four files.

## Finish (controller)

- Run `pnpm run worktree:up`, then `pnpm run verify` (all vitest projects), then `pnpm run build`.
- The PR body records the measured table above, the before and after of the three comments, the two recorded build errors, and that production logging is unaffected.
