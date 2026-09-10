# .dockerignore Nested-Copy Exclusion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker build` run from the repo root no longer sends every worktree's `node_modules` (and the rest of each worktree's tree) into the build context.

**Architecture:** Confirmed empirically (isolated scratch repro, not taken on faith from the issue) that this Docker install's legacy builder — `docker buildx` isn't even installed, so `docker build` always uses the classic builder — anchors an unqualified `.dockerignore` pattern like `node_modules` to the context root: a top-level `node_modules/` is excluded, a nested `nested/node_modules/` is not. `**/node_modules` fixes that. `.claude/` (where every worktree lives, per `docs/superpowers/…`'s own workflow) is not excluded by `.dockerignore` at all today — only by `.gitignore`, which has zero effect on a Docker build context since Docker reads from disk, not from git. The same root-only anchoring bug affects every other bare directory name in the file that a worktree also carries a copy of: `.next`, `.next-build`, `test-results`, `playwright-report`. There is no other source of nested copies in this repo — no monorepo packages (`pnpm-workspace.yaml` here is single-package settings, not a `packages:` list) and no nesting outside `.claude/worktrees` (swept with `find`, single hit: none outside `.claude`).

**Tech Stack:** Docker (multi-stage build, legacy builder), no other component touched.

**Spec:** None — single-file fix, one obvious approach, direction fixed by the issue's own acceptance criteria and confirmed by direct measurement during premise verification (no design choice remains open).

## Global Constraints

- This repo has no test harness for `.dockerignore` — the RED/GREEN evidence is a live `docker build`, same convention as `docs/superpowers/plans/2026-09-09-docker-build-public-copy.md`.
- Do not run a full `docker build` against the *unfixed* `.dockerignore` from the main checkout (`/Users/ivohofland/Projects/fair.yoga`, which has ~17 GB of real worktrees under `.claude/worktrees/`) — that is the exact operation the issue reports already failed once from a race with a concurrent install. The defect mechanism is instead reproduced in an isolated scratch directory (cheap, deterministic, already done during premise verification). The "before" magnitude is quoted via `du -sh .claude/worktrees` (the same methodology the issue itself used), and the "after" number comes from a real `docker build --target deps` run from the main checkout **after** the fix is in place — cheap and safe once `.claude/` is actually excluded.
- This is a 1-task plan — no separate whole-branch review step is structurally required by the skill's own rule (whole-branch review exists to catch cross-task blindness), but the user asked for the full arc including a whole-branch review before the PR is opened; run one anyway.
- No other doc references the current line-by-line contents of `.dockerignore` as a live claim (`grep -rn dockerignore docs/*.md` hits only past plan files, which are historical records, not live specs — nothing to correct there per "Plans are records, not specs").

---

### Task 1: Fix the unanchored `.dockerignore` patterns

**Files:**
- Modify: `.dockerignore`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: a Docker build context, from any checkout with worktrees under `.claude/worktrees/`, that excludes those worktrees' `node_modules`, `.next`, `.next-build`, `test-results`, `playwright-report`, and everything else under `.claude/`.

- [ ] **Step 1: Confirm the RED state in an isolated repro (do not point this at the main checkout)**

In a scratch directory, create a `node_modules/` at the top level and a `nested/node_modules/` one level down, a `.dockerignore` containing just `node_modules`, and a trivial Dockerfile that `COPY`s the context and lists files. Run `docker build`.

Expected: the top-level `node_modules` file is excluded, the nested one is **not** — confirms the anchoring bug this task fixes. (Already confirmed once during premise verification; re-run here only if the working tree's Docker state has changed since.)

- [ ] **Step 2: Rewrite `.dockerignore`**

Current:

```
node_modules
.next
.next-build
.git
docs
test-results
playwright-report
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
.env*
!.env.example
```

`.claude` stays a bare (root-anchored) pattern — deliberately, not `**/.claude` — because Docker excludes a matching directory outright and never descends into it, so matching it once at the repo root prunes everything nested inside, including the `.claude/skills/` subdirectory that IS git-tracked (`.gitignore`'s `!.claude/skills/` exception) and so genuinely exists inside every worktree's own `.claude/` too. `.git` and `docs` stay bare for the simpler reason that they only exist at the repo root at all. `**/` is added only to the five patterns that name something a worktree's own root-level checkout also carries a copy of.

- [ ] **Step 3: Confirm the isolated repro is now GREEN**

Re-run the Step 1 scratch repro with the new pattern (`**/node_modules`) in place of the old one. Expected: neither the top-level nor the nested `node_modules` file survives.

- [ ] **Step 4: Confirm the real fix against the main checkout's actual worktrees**

From the **main checkout** (`/Users/ivohofland/Projects/fair.yoga`, not this worktree — this is the only tree with real sibling worktrees on disk):

1. Record the current (buggy) state's scale: `du -sh .claude/worktrees` (expect roughly the issue's reported ~17-19 GB; exact figure drifts as worktrees come and go, note whatever is actually measured).
2. Temporarily copy this task's new `.dockerignore` over the main checkout's tracked one (`git status` must show clean before doing this, so the revert in step 4 is exact): `cp <this-worktree>/.dockerignore /Users/ivohofland/Projects/fair.yoga/.dockerignore`.
3. Run `docker build --target deps -t fairyoga-ctxcheck /Users/ivohofland/Projects/fair.yoga` and capture the `Sending build context to Docker daemon <size>` line.
4. Expected: a size in the tens-of-MB range (the real source tree, `node_modules` here is pnpm's own — check it isn't pulled in — everything else genuinely small), nowhere near the 17-19 GB `.claude/worktrees` alone measures.
5. `docker rmi fairyoga-ctxcheck`.
6. Revert the main checkout: `cd /Users/ivohofland/Projects/fair.yoga && git checkout -- .dockerignore` (safe — the file was clean and tracked before step 2), then confirm `git status` is clean again.

If step 4's size is still large, stop and re-diagnose before continuing — do not assume the fix worked without seeing the number.

- [ ] **Step 5: Confirm `--target runner` and `--target migrate` still succeed unchanged, from this worktree**

From this worktree (small, no bloat problem to reproduce here — this step is about content correctness, not size):

```
docker build --target runner -t fairyoga-runner-check .
docker build --target migrate -t fairyoga-migrate-check .
```

Expected: both complete successfully (same as before this change — the fix only removes files that were never referenced by any `COPY` instruction; nothing the Dockerfile actually uses lived under `.claude/`, a nested `node_modules`, etc.). Then:

```
docker run --rm fairyoga-runner-check sh -c "test -f server.js && echo server.js present"
docker rmi fairyoga-runner-check fairyoga-migrate-check
```

- [ ] **Step 6: Commit**

```bash
git add .dockerignore
git commit -m "fix(docker): exclude nested worktree copies from the build context

.dockerignore's unqualified patterns (node_modules, .next, .next-build,
test-results, playwright-report) anchor to the context root in this
repo's legacy builder — a nested copy under .claude/worktrees/*/ (a
full checkout per worktree) survives untouched. .claude/ itself was
never excluded at all, only gitignored, which has no effect on what
Docker reads from disk. Measured on the main checkout: du -sh
.claude/worktrees is ~<N> GB before, docker build --target deps
reports a build context in the tens-of-MB range after.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Verification

- `pnpm run verify` is unaffected by this change (no application code touched) — run it once from this worktree before pushing as the standard pre-push gate, not because this fix could plausibly break it.
- The whole-branch review (single task, run anyway per the user's explicit ask) reads the final diff to `.dockerignore` plus this plan, checking: every unanchored pattern that has a real nested-copy source got `**/`; no pattern that should stay bare (`.git`, `docs`, `.claude`) was needlessly widened; the PR body states the measured before/after numbers with the commands that produced them.
