# `prisma-client` Generator Implementation Plan (#888)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the Prisma client with the `prisma-client` generator into `src/generated/prisma`, with no behaviour change.

**Architecture:** The schema's generator block switches; `src/lib/prisma-client.ts` re-exports the generated `client`, and a new enums-only funnel `src/lib/prisma-enums.ts` serves the one client-reachable module (`src/lib/schemas.ts`). Docker, the CI runner-image probe and the docs follow.

**Tech Stack:** Prisma 6.19.3, Next 16 (Turbopack, standalone output), tsx, vitest, Docker (node:24-alpine).

**Spec:** `docs/superpowers/specs/2026-10-17-prisma-client-generator-design.md` — read it first; it carries every measurement this plan relies on.

## Global Constraints

- Node 24: prefix shell commands with `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`.
- Worktree `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/issue-888`; its dev server is on `:3160` (`INTEGRATION_BASE_URL` is read from `.env` automatically). Never touch `:3000`.
- Generator values exactly: `provider = "prisma-client"`, `output = "../src/generated/prisma"`, `moduleFormat = "cjs"`, `runtime = "nodejs"`.
- `src/lib/prisma-client.ts` imports the output by the **relative** specifier `'../generated/prisma/client'` (the migrate image has no `tsconfig.json`). `src/lib/prisma-enums.ts` imports only `'../generated/prisma/enums'`.
- Comment discipline (CLAUDE.md): comments annotate their own file; no counts or rosters in comments; no "previously" history.
- Stage exact paths; never `git add -A`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A client-reachable module that value-imports `@/lib/prisma-client` in future → `next build` must fail loudly (it does: Turbopack panic); the docs must quote that panic text so it is recognisable (Task 3).
2. A test-built client must still carry the undefined-filter guard → the existing installer tests in `tests/undefined-filter-guard.test.ts` pin it (Task 1).
3. Enum identity across the two funnels → pinned in `prisma-client.test.ts` (Task 1).
4. The runner image without its engine must fail the probe, not pass it → mutation step (Task 2).
5. The migrate image's `tsx` scripts must still resolve the client → existing CI steps, re-run locally (Task 2).

---

### Task 1: Switch the generator and repoint every seam

**Files:**
- Modify: `prisma/schema.prisma:1-3` (generator block)
- Modify: `src/lib/prisma-client.ts` (three `'@prisma/client'` specifiers → `'../generated/prisma/client'`; docblock says it re-exports the generated client)
- Create: `src/lib/prisma-enums.ts` (one-line docblock + `export * from '../generated/prisma/enums';`)
- Modify: `src/lib/schemas.ts:2` (import from `@/lib/prisma-enums`)
- Modify: `tests/setup/undefined-filter-guard.ts` (mock target + its docblock), `src/lib/e2e-prisma-factory.test.ts` (`vi.doUnmock` target + docblock), `tests/undefined-filter-guard.ts:10-11` (docblock mention of the mock)
- Modify: `eslint.config.mjs:105-125` (restricted imports) and its `globalIgnores([...])` (add `'src/generated/**'`)
- Modify: `.gitignore` (add `/src/generated/`), `.dockerignore` (add `src/generated`)
- Test: `src/lib/prisma-client.test.ts`

**Interfaces:**
- Produces: `@/lib/prisma-client` (unchanged public surface: `createPrismaClient`, `PrismaClientFactoryOptions`, type `PrismaClient`, `Prisma`, enums, model types); `@/lib/prisma-enums` (enum objects and their types only). Mock target string for vitest: the generated client module, named so that it resolves to the same file `prisma-client.ts` imports (e.g. `'../../src/generated/prisma/client'` from `tests/setup/`, `'../generated/prisma/client'` from `src/lib/`).

- [ ] **Step 1: Rewrite the import pin in `prisma-client.test.ts` (failing).** Replace the `imports only @prisma/client…` test with one per funnel, sharing the existing specifier regex:
  - `'prisma-client.ts imports only the generated client'`: every specifier `=== '../generated/prisma/client'`, length > 0.
  - `'prisma-enums.ts imports only the generated enums, which import nothing'`: every specifier in `prisma-enums.ts` `=== '../generated/prisma/enums'`, length > 0.
  - Add `'both funnels hand back the same enum objects'`: `import * as enums from './prisma-enums'`; `expect(enums.Currency).toBe(Currency)` where `Currency` comes from `./prisma-client`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/lib/prisma-client.test.ts` — expect FAIL (specifier mismatch; `./prisma-enums` missing).
- [ ] **Step 3: Implement** the schema block, both funnels, `schemas.ts`, the two ignore files. Run `pnpm exec prisma generate` (expect `Generated Prisma Client (6.19.3) to ./src/generated/prisma`).
- [ ] **Step 4: Run** `pnpm exec vitest run src/lib/prisma-client.test.ts tests/undefined-filter-guard.test.ts src/lib/e2e-prisma-factory.test.ts`. Expected: the pin passes; three installer cases in `undefined-filter-guard.test.ts` FAIL (the mock still names `@prisma/client`). Record the failing names — this is the seam's own RED.
- [ ] **Step 5: Move the seams** (`vi.mock` target and `importOriginal<typeof import(...)>` type in the setup file; `vi.doUnmock` in the e2e factory test; their docblocks). Re-run Step 4's command: all PASS.
- [ ] **Step 6: Lint rule.** In the existing `no-restricted-imports` block keep `ignores` as the two funnels, keep the `@prisma/client` pattern, and add a second pattern group refusing the generated output (`'@/generated/*'`, `'**/generated/prisma'`, `'**/generated/prisma/*'`) with message `Import Prisma from @/lib/prisma-client, or enums in client-reachable code from @/lib/prisma-enums (#888).` Add `'src/generated/**'` to `globalIgnores`. Update the block's comment to say what it refuses now.
- [ ] **Step 7: Prove the lint guard bites.** Temporarily add `import { Currency } from '@/generated/prisma/enums';` to `src/lib/money.ts` (or any non-funnel `src/` file); run `pnpm exec eslint <file>`; record the exact error text; remove; re-run clean. Repeat with `import { Prisma } from '@prisma/client';` in the same file. Also prove a funnel is exempt: `pnpm exec eslint src/lib/prisma-client.ts src/lib/prisma-enums.ts` clean.
- [ ] **Step 8: Verify** `pnpm run typecheck && pnpm run lint` clean, then `pnpm run build` exit 0 with no Turbopack warning mentioning `@prisma/client` (`grep -i prisma` over its output), and `find .next-build/standalone/src/generated -name '*.node'` prints one engine file.
- [ ] **Step 9: Run the whole suite:** `pnpm test` (dev server on :3160 must be up: `pnpm run worktree:up` if not). Expected green; report per-project counts from the vitest summary.
- [ ] **Step 10: Commit** the files above with `refactor: generate the Prisma client with prisma-client into src/generated (#888)`.

### Task 2: Docker migrate stage and a runner probe that boots the bundle

**Files:**
- Modify: `Dockerfile` (migrate stage: `RUN pnpm exec prisma generate` after `COPY prisma ./prisma`; fix the comment beside `COPY src/lib/prisma-client.ts` — it imports only the generated client, which this stage generates)
- Modify: `scripts/prisma-engine-probe.cjs` (rewrite)
- Modify: `.github/workflows/ci.yml` (the `docker-build` job's comment block and the runner probe step's comment; the step command and its `grep` line stay)

**Interfaces:**
- Consumes: Task 1's generated output and build.
- Produces: probe success line, exactly `engine loaded; connect failed with P1001 as expected` (CI greps it).

- [ ] **Step 1: Rewrite the probe.** CommonJS, still piped over stdin (`docker run --rm --network none -i --entrypoint node <image> -`). It spawns `process.execPath server.js` with `cwd: '/app'` and env `DATABASE_URL=postgresql://u:p@203.0.113.1:5432/none?connect_timeout=3`, `PORT=3999`, `HOSTNAME=127.0.0.1`, collecting stdout+stderr; polls `fetch('http://127.0.0.1:3999/api/health')` until it answers; then waits for a server log line containing `health check: database probe failed`. Verdict: success line iff that line contains ``Can't reach database server at `203.0.113.1:5432` ``; otherwise fail and print the collected output (a line containing `could not locate the Query Engine` gets its own named failure message). Keep a referenced 60 s timeout that fails, and always kill the child before exiting. A working prototype is in the controller's scratchpad, `/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/b0dcc355-3104-4b9f-9e75-ec28e69fdeea/scratchpad/probe-server.cjs`; the header comment must say why the probe boots the server (the generated client exists in the runner only inside the bundle) and why it matches the message, not a code (spec item 6).
- [ ] **Step 2: Build both images:** `docker build -t fairyoga-888 .` and `docker build --target migrate -t fairyoga-888-migrate .` — both exit 0.
- [ ] **Step 3: Run every `docker-build` CI step locally** against these tags (copy the commands from `ci.yml`, substituting the tags): runner probe prints the success line; migrate status prints `P1001` and `Loaded Prisma config from prisma.config.ts`; reserved-slug check reaches P1001 and exits 1.
- [ ] **Step 4: Prove the probe bites.** Scratch Dockerfile (in the scratchpad, not the repo): `FROM fairyoga-888`, `USER root`, `RUN rm /app/src/generated/prisma/*.node`, `USER app`. Run the probe against it: must exit non-zero and not print the success line; record the exact failure text. Also run the **old** probe (`git show origin/main:scripts/prisma-engine-probe.cjs`) against `fairyoga-888` and record that it fails (`Cannot find module '@prisma/client'`) — the reason the rewrite exists.
- [ ] **Step 5: Commit** with `ci: generate in the migrate stage; the runner probe boots the bundle to find its engine (#888)`.

### Task 3: Docs

**Files:**
- Modify: `docs/technical-architecture.md` — the project-tree line for `prisma-client.ts` (~line 103; add `prisma-enums.ts` beside it), and "Where Prisma comes from (#884, #886)" (~1363-1393): retitle with #888; two funnels and why the second exists (the package's `browser` field no longer does the split; quote the Turbopack panic `the chunking context (unknown) does not support external modules (request: node:module)` as what a client-reachable value import of `@/lib/prisma-client` produces); the generator choices (`cjs`, why); the lint rule's two patterns; the vitest seam now names the generated client; replace the `export *` warning paragraph with what is true now (no warning; the client is bundled, only `@prisma/client/runtime/library` is external). Keep `git grep -n "@prisma/client" -- ':!docs'` as the re-derivation for remaining mentions.
- Modify: `docs/supply-chain.md` "Prisma's engine in the images" (~828-843): what the runner probe now does and the re-derivation for it (Task 2 Step 4's scratch image), next to the existing migrate re-derivation.
- Modify: `.claude/skills/verify/SKILL.md:60` — scratch scripts reach the database by importing `<worktree>/src/lib/prisma-client` under `pnpm exec tsx`; `@prisma/client` itself no longer carries a client. Keep the `@playwright/test` guidance unchanged.

- [ ] **Step 1: Sweep** `git grep -n "@prisma/client\|\.prisma/client\|prisma-client-js\|export \*" -- docs .claude/skills DEPLOYMENT.md README.md AGENTS.md ':!docs/superpowers'` and give every hit a verdict (edit or legitimate survivor — e.g. supply-chain's dated `require.resolve` measurement and the build-permission lists stay).
- [ ] **Step 2: Edit** the three files above.
- [ ] **Step 3: Verify** the scratch-script recipe you wrote actually runs: a scratch `.ts` importing the worktree's `src/lib/prisma-client` by absolute path, run with `pnpm exec tsx`, prints a `teacher.count()`.
- [ ] **Step 4: Commit** with `docs: where the generated Prisma client comes from and what the images prove (#888)`.
