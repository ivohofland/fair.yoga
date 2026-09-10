# .dockerignore Source-Only Exclusion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker build --target deps` from the repo root no longer sends `.superpowers/` (24 MB),
`coverage/` (4.8 MB), or `tsconfig.tsbuildinfo` (324 KB) into the build context, and `.env*`
exclusion no longer depends incidentally on the `.claude` bare-directory prune.

**Architecture:** Issue #567 is a follow-up from #559/PR #566's whole-branch review. Premise
verified empirically before writing this plan:

- `.superpowers`, `coverage`, `tsconfig.tsbuildinfo` are all git-untracked (`git ls-files` on
  each returns nothing; `.gitignore` covers `/coverage` and `*.tsbuildinfo`; `.superpowers/sdd/*`
  self-ignores) and referenced by no `Dockerfile` `COPY` — confirmed via `grep -n COPY Dockerfile`
  (only `package.json`/`pnpm-lock.yaml`/`pnpm-workspace.yaml`, `prisma`, and a blanket
  `COPY . .` in the `build` stage). `tsconfig.json`'s `include` is `**/*.ts`/`**/*.tsx`
  (unscoped), so `tsconfig.tsbuildinfo` sitting in the context is inert either way for the
  type-check — it's pure bloat, not a correctness risk the way #543's unscoped `.ts` reach was.
- Baseline measured from the main checkout (real worktrees present, same methodology as #559):
  `docker build --target deps` reports **37.56 MB** (issue quotes 37.55 MB; 0.01 MB drift is
  worktree churn since the issue was filed, not a discrepancy).
- **Premise correction:** the issue states ".superpowers/coverage are... both main-checkout-local
  ... neither has a nested-copy source the way #559's five patterns did, so no `**/` needed."
  That's imprecise — a `find` sweep from the main checkout
  (`find . \( -name node_modules -o -name .git \) -prune -o -type d -name .superpowers -print`,
  same shape query for `coverage` and `tsconfig.tsbuildinfo`) shows nested copies of all three
  **do** exist, one per worktree under `.claude/worktrees/*/`. The issue's practical conclusion
  (bare patterns suffice, no `**/` needed) is still correct, but for a different reason: those
  nested copies all live under `.claude/`, which #559's fix already excludes as a *bare* pattern
  — Docker excludes a matched directory outright and never descends into it, so the nested
  copies are pruned regardless of whether `.superpowers`/`coverage`/`tsconfig.tsbuildinfo` are
  bare or `**/`-prefixed. Outside `.claude/`, the sweep found zero nested copies of any of the
  three, so a bare pattern is sufficient today. This plan carries the corrected reasoning; the
  PR body will note the correction per this repo's "correct a claim" convention.
- **Premise gap found by direct test, not assumption:** the issue's acceptance criteria ask to
  widen `.env*` to `**/.env*` while "keeping the existing `!.env.example` exception working the
  same way it does today" and to "verify a nested `.env.example` still survives if one is ever
  added, matching the root one's treatment." An isolated scratch repro (root `.env`/`.env.example`
  plus `nested/.env`/`nested/.env.example`) shows these two clauses are in tension as literally
  written: widening `.env*` to `**/.env*` while leaving the negation as the bare `!.env.example`
  excludes a nested `.env.example` (it does **not** survive — contradicts the second clause).
  Widening the negation too, to `!**/.env.example`, is what actually makes a nested
  `.env.example` survive while nested `.env`/`.env.local`/etc. stay excluded. This plan widens
  both lines. (Full repro output in Task 1, Step 1.)

**Tech Stack:** Docker (multi-stage build, legacy builder — `docker buildx version` still reports
`unknown command`, confirmed unchanged since #559), no other component touched.

**Spec:** None — single-file fix, direction fixed by the issue's acceptance criteria (as
corrected above), no design choice left open.

## Global Constraints

- This repo has no test harness for `.dockerignore` — the RED/GREEN evidence is a live `docker
  build`, same convention as `docs/superpowers/plans/2026-09-10-dockerignore-nested-worktrees.md`
  (#559).
- Do not run a full `docker build` against the *unfixed* `.dockerignore` from the main checkout
  with `.superpowers`/`coverage` included at scale — they're only tens of MB, not the ~19 GB #559
  guarded against, so this constraint is lighter than #559's, but still: reproduce each pattern's
  defect mechanism in an isolated scratch directory first, and only measure the real before/after
  size from the main checkout once (cheap: `.superpowers`+`coverage`+`tsconfig.tsbuildinfo` total
  ~29 MB, not GB).
- This is a 1-task plan — no separate whole-branch review step is structurally required by the
  skill's own rule, but the user asked for the full arc including a whole-branch review; run one
  anyway.
- `grep -rln dockerignore docs/` before finishing, to catch any live doc referencing the current
  line-by-line contents of `.dockerignore` as a present-tense claim (expected: only past plan
  files, which are historical records per "Plans are records, not specs" — confirm nothing else
  hits).

---

### Task 1: Widen `.dockerignore` to exclude `.superpowers`, `coverage`, `tsconfig.tsbuildinfo`, and nested `.env*`

**Files:**
- Modify: `.dockerignore`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: a Docker build context that no longer contains `.superpowers/`, `coverage/`, or
  `tsconfig.tsbuildinfo`, and where `.env*` exclusion holds at every nesting depth (not just
  incidentally via the `.claude` bare prune), while `.env.example` — root or nested — still
  survives.

- [ ] **Step 1: Confirm RED in isolated scratch repros (do not point at the main checkout)**

Repro A (`.superpowers`/`coverage`/`tsconfig.tsbuildinfo` currently unexcluded at root): in a
scratch dir, create `.superpowers/`, `coverage/`, `tsconfig.tsbuildinfo` at the top level plus a
`.dockerignore` matching today's file (without this task's new lines) and a trivial Dockerfile
that `COPY`s the context and lists files. Expect: all three present in the built image.

Repro B (`.env*`/`.env.example` nesting tension): in a scratch dir, create root `.env`,
`.env.example` and `nested/.env`, `nested/.env.example`. Build three times, swapping only the
`.dockerignore`:

1. `.env*` / `!.env.example` (today's lines) — expect nested `.env` **and** nested
   `.env.example` both survive (today's bug: nesting isn't excluded at all).
2. `**/.env*` / `!.env.example` (widen only the exclude) — expect nested `.env.example` is now
   **excluded** (fails the issue's own acceptance criterion that a nested example should
   survive).
3. `**/.env*` / `!**/.env.example` (widen both) — expect root and nested `.env.example` both
   survive, root and nested `.env` both excluded.

(This exact three-way repro was already run once during premise verification with these
results; re-run only if Docker state has changed since.)

- [ ] **Step 2: Rewrite `.dockerignore`**

Current:

```
**/node_modules
**/.next
**/.next-build
.claude
.git
docs
**/test-results
**/playwright-report
*.md
.env*
!.env.example
```

New:

```
**/node_modules
**/.next
**/.next-build
.claude
.git
docs
**/test-results
**/playwright-report
*.md
.superpowers
coverage
tsconfig.tsbuildinfo
**/.env*
!**/.env.example
```

`.superpowers`, `coverage` stay bare (root-anchored) — per the corrected premise above, their
only nested occurrences are under `.claude/`, already pruned by the pre-existing bare `.claude`
line; a bare pattern here also naturally matches only the root copy, which is exactly what's
missing today. `tsconfig.tsbuildinfo` is a bare filename pattern for the same reason. `.env*` and
its negation both gain `**/` so nested `.env` is excluded — and nested `.env.example` survives —
everywhere, not only incidentally under `.claude/`.

- [ ] **Step 3: Confirm GREEN in the same isolated repros**

Re-run Repro A with the new `.dockerignore` lines added: none of `.superpowers/`, `coverage/`,
`tsconfig.tsbuildinfo` should appear in the built image. Re-run Repro B variant 3 (the new
`**/.env*` / `!**/.env.example` pair): root and nested `.env.example` present, root and nested
`.env` absent.

- [ ] **Step 4: Confirm the real fix against the main checkout**

From the **main checkout** (`/Users/ivohofland/Projects/fair.yoga`, not this worktree — the only
tree with real sibling worktrees on disk):

1. `docker build --target deps` with the *pre-fix* `.dockerignore` (already measured during
   premise verification: 37.56 MB — do not re-measure by checking out the old file, just cite
   this run).
2. Apply this task's `.dockerignore` change (already committed on this branch by the time this
   step runs), run `docker build --target deps` again, record the new size.
3. Arithmetic check: 37.56 MB − 24 MB (`.superpowers`) − 4.8 MB (`coverage`) − 0.32 MB
   (`tsconfig.tsbuildinfo`) ≈ 8.4 MB expected; confirm the measured number is in that
   neighborhood (exact figure will differ slightly — rounding, and any other files that changed
   since the 37.56 MB baseline was taken).
4. `docker build --target runner .` and `docker build --target migrate .` both still succeed;
   confirm `server.js` present in the runner image (same check PR #566 ran).
5. Confirm `.env.example` at the repo root is present in the `deps`-stage image (the `!**/.env*`
   exception still works for the one example file that actually exists in this repo today).

- [ ] **Step 5: `grep -rln dockerignore docs/`**

Confirm no live (non-plan) doc references `.dockerignore`'s line-by-line contents as a present
fact. Expected: only past plan files under `docs/superpowers/plans/`, which are historical
records, not live specs.

---

## Verification (after Task 1)

- `pnpm run verify` (typecheck, lint, full test suite) — no application code changed, so this is
  a smoke check, not the primary evidence; primary evidence is the Docker builds in Step 4.
- PR body records: the corrected premise (nested copies of the three untracked dirs/files DO
  exist but are already pruned by `.claude`), the `.env.example` negation-widening finding with
  its three-way repro, the before/after context size with arithmetic, and the runner/migrate
  build confirmations.
