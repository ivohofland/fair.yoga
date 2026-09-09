# Plan: stop the integration tier from hardcoding `http://localhost:3000`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the one remaining `tests/integration/` file that hardcodes `http://localhost:3000` instead of resolving `BASE_URL`, and widen the ESLint guard #541 added (currently `tests/e2e/**/*.ts`-scoped) to cover the integration tier too, so this defect class can't recur silently in either tier.

**Architecture:** Same fix shape as #541: import `BASE_URL` from `../helpers` and interpolate it in place of the literal. The ESLint rule's `files` glob widens from `tests/e2e/**/*.ts` to `tests/**/*.ts` with `tests/helpers.ts` excluded (it legitimately defines the fallback literal).

**Tech Stack:** TypeScript, Vitest (integration project), ESLint flat config (`eslint.config.mjs`, `no-restricted-syntax`).

**Spec:** none — single subsystem (test infrastructure), one reasonable design already established by #541's precedent, no data model or runtime behavior change.

## Premise verification

2026-09-09, against `origin/main` at `d1e8e706` (this worktree's base):

```
$ grep -rn "localhost:3000" tests/integration/
tests/integration/magic-link-origin-binding.test.ts:14:      const res = await fetch(`http://localhost:3000${door.path}`, {
```

Exactly the one site the issue names. `tests/helpers.ts:32` defines
`BASE_URL = process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000'` and
36 of the other 37 files under `tests/integration/` already import it —
confirmed by the issue and unchanged since.

Swept the whole `tests/` tree (not just `tests/integration/`) for the same
pattern, to know in advance whether widening the ESLint guard would surface
any other violation:

```
$ grep -rn "localhost:3000\|localhost:[0-9]\+\|127\.0\.0\.1:[0-9]\+" tests/ | grep -v "tests/helpers.ts"
tests/integration/magic-link-origin-binding.test.ts:14:      const res = await fetch(`http://localhost:3000${door.path}`, {
```

One hit — the same one. Widening the guard to `tests/**/*.ts` is safe: no
other file in `tests/e2e/`, `tests/integration/`, or `tests/setup/` would
newly fail lint. Unit and component tests live under `src/**/*.test.ts` and
`src/components/**/*.test.tsx` (per `vitest.config.ts`'s project
definitions), outside `tests/**`, so they're unaffected either way.

## Task 1 — fix the literal, widen the guard to the whole `tests/` tree

**Files:**
- Modify: `tests/integration/magic-link-origin-binding.test.ts`
- Modify: `eslint.config.mjs`

**Change:**

1. In `tests/integration/magic-link-origin-binding.test.ts`, add `BASE_URL`
   to the existing `../helpers` import and interpolate it in place of the
   literal:

   ```ts
   import { describe, it, expect } from 'vitest';
   import { freshIp, BASE_URL } from '../helpers';
   ```

   ```ts
   const res = await fetch(`${BASE_URL}${door.path}`, {
   ```

   (Only line 2's import and line 14's `fetch` call change. Everything else
   in the file — the `DOORS` array, the `describe`/`it` structure, the
   assertions — stays exactly as it is.)

2. In `eslint.config.mjs`, widen the existing localhost-guard block's
   `files` glob from `['tests/e2e/**/*.ts']` to `['tests/**/*.ts']`, and add
   `ignores: ['tests/helpers.ts']` (it legitimately defines the fallback
   literal the rule exists to keep everything else off of). Update the
   block's leading comment and the rule's `message` string so they no longer
   say "e2e spec" specifically — the guard now applies to the whole `tests/`
   tree:

   ```js
   // A hardcoded dev-server origin in a test file breaks against any server
   // not on that exact host and port (a worktree's isolated server, for
   // one). Scoped to the whole tests/ tree, not just e2e — #547 found the
   // same defect one tier over. tests/helpers.ts is excluded: it's where
   // the fallback literal legitimately lives.
   {
     files: ['tests/**/*.ts'],
     ignores: ['tests/helpers.ts'],
     rules: {
       'no-restricted-syntax': [
         'error',
         {
           selector:
             'Literal[value=/(localhost|127\\.0\\.0\\.1):[0-9]+/], TemplateElement[value.raw=/(localhost|127\\.0\\.0\\.1):[0-9]+/]',
           message:
             "Don't hardcode a localhost/127.0.0.1 origin — import BASE_URL from '../helpers' and interpolate it instead, so tests work against any origin (e.g. a worktree's dev server on another port).",
         },
       ],
     },
   },
   ```

**Tests / verification:**

- [ ] **Step 1: Confirm the fixed test passes against the worktree's own
      app.** Requires the worktree's isolated dev server running
      (`npm run worktree:up`, already configured for this worktree —
      `INTEGRATION_BASE_URL` is written into `.env` by `worktree:setup`).
      Run: `npx vitest run --project integration tests/integration/magic-link-origin-binding.test.ts`
      Expected: PASS (3 tests, one per door).

- [ ] **Step 2: Prove the ESLint guard bites, in its new wider scope.**
      Temporarily revert the import and the `fetch` call in
      `tests/integration/magic-link-origin-binding.test.ts` back to the
      hardcoded literal (`git stash` the real fix, or edit it back by hand),
      then run:
      `npx eslint tests/integration/magic-link-origin-binding.test.ts`
      Expected: FAILS with the rule's message
      ("Don't hardcode a localhost/127.0.0.1 origin — import BASE_URL
      from '../helpers'..."), pointing at the `localhost:3000` template
      literal. Record the exact error text in the PR body. Restore the real
      fix afterward and re-run to confirm clean:
      `npx eslint tests/integration/magic-link-origin-binding.test.ts`
      Expected: PASS, no errors.

- [ ] **Step 3: Confirm the wider guard doesn't newly flag anything else.**
      Run: `npx eslint tests/`
      Expected: PASS, no errors — matches the premise-verification sweep
      above (the fixed file was the only hit in the whole tree).

- [ ] **Step 4: Confirm no other tier regressed.**
      Run: `npx eslint .` (whole-repo lint, in case the widened glob
      interacts with anything unexpected outside `tests/`) and
      `npx tsc --noEmit` (or `npm run verify`'s typecheck step) to confirm
      the changed import doesn't break typechecking.
      Expected: both clean.

- [ ] **Step 5: `grep -rn "localhost:3000" tests/` returns nothing.**
      Matches the issue's acceptance criterion exactly.

- [ ] **Step 6: Commit.**

  ```bash
  git add tests/integration/magic-link-origin-binding.test.ts eslint.config.mjs
  git commit -m "fix(integration): resolve BASE_URL instead of hardcoding localhost:3000 (#547)"
  ```

## Not doing

- Not touching any other file under `tests/integration/` — the
  premise-verification sweep found exactly one hardcoded-origin site in the
  whole tree, and it's the one this plan fixes.
- Not adding a second, integration-specific ESLint block. Reusing and
  widening #541's existing block (same selector, same message shape) is the
  one-mechanism-for-both-tiers outcome the issue's acceptance section asks
  about — a second near-duplicate block would just be the same rule typed
  twice.
