# TypeScript 6 compiler defaults, pinned on 5.9 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tsconfig.json` sets the three compiler options whose defaults TypeScript 6.0 changes, so the 6.0 bump (#944) changes no effective setting.

**Architecture:** One config edit on TypeScript 5.9.3. No source changes. The design was agreed in conversation (small change, no spec). The issue is #945, tracked by #944.

**Tech Stack:** TypeScript 5.9.3 (`tsc --noEmit`), Next.js 16.4.1 (rewrites `tsconfig.json` through `comment-json` in `next/dist/lib/typescript/writeConfigurationDefaults.js`).

**Spec:** none (small change, agreed at the brainstorming gate). The issue text is #945.

## Global Constraints

- The values are exactly `"types": ["node"]`, `"noUncheckedSideEffectImports": true`, `"libReplacement": false`
- No new `@ts-expect-error`, and no change to `strict` or any other existing option
- The `typescript` version stays at `^5`, locked 5.9.3. The bump is #944's, not this branch's.
- `tests/e2e/tsconfig.json` is untouched. It `extends` the root config and inherits the change.
- Agreed at the gate: there is **no test pinning the config values**. Removing `types` passes the typecheck on 5.9 and 6.0 alike (measured), so such a test would restate the file. One present-tense comment line on `types` carries the reason instead.

## Measured before planning (2026-10-30, clean worktree at f97e7d43, no `next-env.d.ts`, no `.next-build/`, which is CI's state)

| Config | 5.9.3 | 6.0.3 |
|---|---|---|
| as on main | 0 errors | 0 errors |
| `types: []` | 0 | — |
| `types: ["node"]` | 0 | — |
| `noUncheckedSideEffectImports: true` | 0 | — |
| all three | 0 | 0 |

The test configs must live inside the repo directory. A `types` entry resolves from the directory of the config that sets it, and a config in the scratchpad fails with TS2688 for that reason alone.

Without `types`, `@types/node` still enters the program, through `/// <reference types="node" />` in many dependencies' typings (re-derive: `pnpm exec tsc --noEmit --explainFiles | grep -A20 '@types/node/index.d.ts$'`). `next-env.d.ts` is gitignored and absent in CI, so none of those routes depend on it. What `types: ["node"]` changes is the other direction: every other `@types/*` package (today `pg`, `qrcode`, `react`, `react-dom`) stops loading globally and takes effect only when imported.

## Review Focus

1. **`next build` rewriting `tsconfig.json`** and dropping the comment or the new options: checked by Task 1 Step 6.
2. **A developer with `next-env.d.ts` present but `.next-build/` deleted:** its side-effect imports point at missing files. Measured clean, because `skipLibCheck: true` suppresses diagnostics in `.d.ts` files. No test needed. Recorded in the PR body.
3. **Typed lint** (`typescript-eslint` reads the same tsconfig): checked by `pnpm run lint` in Step 5.
4. **A side-effect import that does not resolve** must now fail `tsc`: proven by Step 3's mutation.
5. **Vitest and Playwright** strip types with esbuild and are unaffected. The whole suite runs in `pnpm run verify` (Step 5).

---

### Task 1: Pin the three options in `tsconfig.json`

**Files:**
- Modify: `tsconfig.json` (`compilerOptions`)

**Interfaces:** none (no later task).

- [ ] **Step 1: Add the options.** In `compilerOptions`, add `"types": ["node"]`, `"noUncheckedSideEffectImports": true` and `"libReplacement": false`. Above `types`, add one `//` comment line, present tense, saying what the line does: only `@types/node` loads globally, and any other `@types` package takes effect only when imported. Name no other module. Do not mention TypeScript 6 or what the defaults "used to" be. That history belongs in the PR body (CLAUDE.md, *Comment Discipline*).

- [ ] **Step 2: Typecheck.** Run `pnpm run typecheck`. Expected: exit 0, no output.

- [ ] **Step 3: Prove `noUncheckedSideEffectImports` bites.** Temporarily add `import './does-not-exist-945'` to the top of any `src/**/*.ts` file. Run `pnpm run typecheck`. Expected: exit 2 with `error TS2307: Cannot find module './does-not-exist-945' or its corresponding type declarations.`. Record the exact error line for the PR body. Remove the import and re-run: exit 0. Then delete the option, re-run with the bogus import, and confirm exit 0. That proves the option, not something else, is what bites. Restore the option.

- [ ] **Step 4: Prove `types` is honoured.** Temporarily set `"types": ["node-945-missing"]` and run `pnpm run typecheck`. Expected: `error TS2688: Cannot find type definition file for 'node-945-missing'`. Restore `["node"]` and re-run: exit 0.

- [ ] **Step 5: Full verification.** In this worktree: `pnpm run worktree:setup` (once), `pnpm run worktree:up`, then `pnpm run verify`, then `pnpm run worktree:down`. Expected: green, with the vitest project totals recorded for the PR body.

- [ ] **Step 6: `next build` keeps the file.** Run `pnpm run build`, then `git diff --exit-code tsconfig.json`. Expected: exit 0 (no diff), meaning Next neither dropped the comment nor rewrote the new options. If the build fails for an unrelated reason (environment), record that, and still check `git diff tsconfig.json`, because Next's TypeScript setup runs before compilation.

- [ ] **Step 7: Commit.** Stage `tsconfig.json` and this plan by exact path. Message: `chore: pin the compiler options TypeScript 6 changes, on 5.9 (#945)`.

### After the task (lead, not the implementer)

- Correct #945's body: without `types`, `@types/node` arrives through many dependencies' typings (`--explainFiles`), not through `next-env.d.ts`, which is gitignored and absent in CI. Replace the wrong sentence; don't annotate it.
- PR body: the measurement table above, the mutation error lines from Steps 3–4, the Review Focus item 2 finding, and the verify totals. **#944 is unaffected** (it stays open for the bump).
