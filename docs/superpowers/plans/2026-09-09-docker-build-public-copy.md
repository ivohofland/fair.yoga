# Docker Build Public Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker build -t fairyoga .` completes on a clean checkout, and a CI job builds the production image on every push/PR so the next Dockerfile/tree divergence fails a pull request instead of a deploy.

**Architecture:** Two independent, unrelated defects both block the same command today, and premise verification found the second one — the issue (#543) only names the first. `tsconfig.json` includes every `.ts` file with no exclusion, so `next build`'s type-check reaches `src/**/*.test.ts` files that import shared fixtures from `tests/` — but `.dockerignore` excludes `tests` from the Docker build context, so those imports fail to resolve and the build never reaches the step #543 actually describes. Fix that first (Task 1), then guard the `public/` copy the issue names (Task 2) — this repo has never tracked a `public/` of its own (Next's file-based `app/icon.svg` convention replaces it), so the `build` stage creates one empty before the runner copies it, rather than depending on one never being added. Task 3 adds the CI job neither defect had, wired into the existing `test` aggregate gate the same way every other test job is.

**Tech Stack:** Docker (multi-stage build, legacy builder — `docker build -t fairyoga .` in this environment uses the classic `Step N/M` output, not BuildKit), GitHub Actions.

**Spec:** None — bounded fix, direction agreed in chat during brainstorming (issue #543); the only design choice (guard vs. commit a placeholder `public/` vs. delete the COPY line) was resolved there in favor of guarding, consistent with this repo's "trust internal invariants, don't add fallbacks for scenarios that can't happen" philosophy (CLAUDE.md) — `mkdir -p` makes the invariant (the directory exists) actually true rather than working around its absence.

## Global Constraints

- This repo has no existing pattern for testing a Dockerfile — the `docker build -t fairyoga .` run itself is each task's RED/GREEN test. Each task specifies the exact command and the expected outcome.
- The CI job added in Task 3 must be wired into the `test` job's `needs: [...]` array (`.github/workflows/ci.yml`), not left standalone — that is the established mechanism in this repo for making a job block merges (see the `test` job's own docblock, which cites PR #324: an `if: always()` aggregate without an explicit per-dependency result check lets a red job merge anyway). `checks` and `test` are the two required status checks on `main`; there is no third mechanism to add here.
- `docs/supply-chain.md`'s install census (`grep -rnE 'npm +(ci|install|...)' Dockerfile .github/workflows ...`) must still report the same counts after this plan — verified: the new CI job runs `docker build`, never `npm ci` directly (that happens inside the Dockerfile's own `deps` stage, already counted), so the census is unaffected. No task needs to touch it.
- This is a 3-task plan, so the whole-branch review step in the solve-issue arc runs after Task 3, before push.

---

### Task 1: Make the Docker build context include `tests/`

**Files:**
- Modify: `.dockerignore`

**Interfaces:**
- Consumes: nothing from an earlier task.
- Produces: a Docker build context that includes `tests/`, which Task 2's build run depends on to get past the type-check step.

- [ ] **Step 1: Confirm the current RED state**

Run: `docker build -t fairyoga-verify .`

Expected: FAILS during `RUN npx prisma generate && npm run build` in the `build` stage, with TypeScript errors naming files it cannot resolve, e.g.:

```
src/services/class-lifecycle.test.ts(19,46): error TS2307: Cannot find module '../../tests/class-fixtures' or its corresponding type declarations.
```

(Dozens of these, one per `*.test.ts` file under `src/lib/` and `src/services/` that imports a fixture from `tests/`.) The command ends with:

```
The command '/bin/sh -c npx prisma generate && npm run build' returned a non-zero code: 1
```

This is `tsconfig.json`'s `include: ["**/*.ts", ...]` reaching test files that are copied into the build context (`src/**` is not excluded), while the fixtures they import from `tests/` are not — `.dockerignore` excludes that whole directory.

- [ ] **Step 2: Remove `tests` from `.dockerignore`**

Current `.dockerignore`:

```
node_modules
.next
.next-build
.git
docs
tests
test-results
playwright-report
*.md
.env*
!.env.example
```

Remove the `tests` line (leave every other line untouched — `docs`, `test-results`, and `playwright-report` are not imported by anything under `src/`, verified with `grep -rn "playwright-report\|test-results" src` and `grep -rn "from ['\"].*docs/" src`, both empty):

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

`tests/` is 2.0 MB (`du -sh tests`) against an 844 MB `node_modules` already excluded — this does not meaningfully change build context size. It also never reaches the shipped image: only `.next-build/standalone`, `.next-build/static`, and `public` are copied into the `runner` stage, and none of those trace back to `tests/`.

- [ ] **Step 3: Confirm the fix — and that it hands off to the next known bug, not a new one**

Run: `docker build -t fairyoga-verify .`

Expected: the TypeScript errors from Step 1 are gone, and the build proceeds through the `build` and `migrate` stages successfully. It now FAILS later, in the `runner` stage, at:

```
Step 25/27 : COPY --from=build --chown=app:app /app/public ./public
COPY failed: stat app/public: file does not exist
```

This is the exact defect #543 describes — Task 2 fixes it. If the build fails anywhere else, or for a different reason, stop and re-diagnose before continuing; do not proceed to Task 2 assuming this is the only remaining defect without seeing this exact failure.

- [ ] **Step 4: Commit**

```bash
git add .dockerignore
git commit -m "fix(docker): include tests/ in the build context

next build's type-check reaches every .ts file (tsconfig.json's include
is unscoped), including src/**/*.test.ts files that import fixtures from
tests/ — but .dockerignore excluded that directory, so the Docker build
failed before ever reaching the public/ copy issue #543 describes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Guard the `public/` copy, and correct the doc that described it as broken

**Files:**
- Modify: `Dockerfile`
- Modify: `docs/supply-chain.md`

**Interfaces:**
- Consumes: Task 1's `.dockerignore` change (the build must already get past the type-check step for this task's RED state to be the `public/` COPY failure, not the Task 1 failure).
- Produces: a `docker build -t fairyoga .` that completes successfully — the deliverable Task 3's CI job depends on.

- [ ] **Step 1: Confirm the RED state (inherited from Task 1's Step 3)**

Run: `docker build -t fairyoga-verify .`

Expected: FAILS at `Step 25/27 : COPY --from=build --chown=app:app /app/public ./public` with `COPY failed: stat app/public: file does not exist`. (Same failure captured in Task 1 Step 3 — confirming the working tree is still in that state before this task's fix.)

- [ ] **Step 2: Add the guard to the Dockerfile's `build` stage**

In `Dockerfile`, the `build` stage currently reads:

```dockerfile
FROM deps AS build
WORKDIR /app
COPY . .
# Build-time page-data collection instantiates PrismaClient, which only
# needs the env var to EXIST (no connection is made). Runtime env from
# compose overrides this dummy completely.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build
```

Change it to:

```dockerfile
FROM deps AS build
WORKDIR /app
COPY . .
# Ensures the runner's COPY below always finds a directory, even though
# this repo does not track a public/ of its own — see docs/supply-chain.md.
RUN mkdir -p public
# Build-time page-data collection instantiates PrismaClient, which only
# needs the env var to EXIST (no connection is made). Runtime env from
# compose overrides this dummy completely.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build
```

(Only the `RUN mkdir -p public` line is new.)

- [ ] **Step 3: Correct the stale claim in `docs/supply-chain.md`**

Find this paragraph (in the "What is enforced, and what is not" → `--omit=dev` section, describing the `runner` stage):

```markdown
- The `runner` stage (`Dockerfile:32-46`) is **narrower**. The only
  `node_modules` it gets is the one inside `.next-build/standalone`, which Next
  populates by tracing actual imports — so it holds far less than the
  production dependency tree. (It copies two other trees, `.next-build/static`
  and `public`; neither carries dependencies. The `public` copy is why
  `docker build` currently fails — #543.)
```

Replace the parenthetical with the corrected, current fact:

```markdown
- The `runner` stage (`Dockerfile:32-46`) is **narrower**. The only
  `node_modules` it gets is the one inside `.next-build/standalone`, which Next
  populates by tracing actual imports — so it holds far less than the
  production dependency tree. (It copies two other trees, `.next-build/static`
  and `public`; neither carries dependencies. This repo has never tracked a
  `public/` of its own — icons are Next's file-based `app/icon.svg` convention
  instead — so the `build` stage creates one empty before the copy; #543 has
  the history.)
```

- [ ] **Step 4: Confirm GREEN — the full build now succeeds**

Run: `docker build -t fairyoga-verify .`

Expected: completes all 27 steps and ends with:

```
Successfully built <image-id>
Successfully tagged fairyoga-verify:latest
```

- [ ] **Step 5: Sanity-check the image, then clean up the local test image**

Run:

```bash
docker run --rm fairyoga-verify:latest sh -c "ls -la /app/public && test -f /app/server.js && echo server.js present"
```

Expected: `/app/public` exists and is empty (just `.` and `..`), and `server.js present` prints.

Then remove the local test image so it doesn't linger:

```bash
docker rmi fairyoga-verify
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docs/supply-chain.md
git commit -m "fix(docker): guard the public/ copy so the build always succeeds

This repo has never tracked a public/ — icons are Next's file-based
app/icon.svg convention, not a public/ directory — so the runner
stage's COPY --from=build /app/public always failed. mkdir -p in the
build stage makes the directory always exist (empty today, and it
picks up real content automatically the day one is added) rather than
depending on one never being added.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Add a CI job that builds the production image

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 2's working `docker build -t fairyoga .` (this task adds no Dockerfile changes of its own — it only runs the command CI-side).
- Produces: a `docker-build` job whose result feeds the existing `test` aggregate gate.

- [ ] **Step 1: Add the `docker-build` job**

In `.github/workflows/ci.yml`, add a new job after `test-e2e` and before the `test` aggregate job (find the aggregate job's docblock comment — the new job goes immediately above it):

```yaml
  # Builds the production image on every push/PR. Nothing else in this
  # workflow does: test-integration/test-e2e build and run the standalone
  # bundle directly, never through Docker, so a Dockerfile/.dockerignore
  # regression here is invisible to every other job (#543 — twice, in
  # fact: the tests/ context exclusion and the public/ copy were both
  # unreachable by any other job in this file). Build-and-discard —
  # nothing is pushed or run.
  docker-build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7

      - name: Build production image
        run: docker build -t fairyoga .
```

- [ ] **Step 2: Wire it into the `test` aggregate gate**

Find:

```yaml
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    needs: [test-components, test-unit, test-integration, test-e2e]
    if: always()
```

Change the `needs` line to:

```yaml
    needs: [test-components, test-unit, test-integration, test-e2e, docker-build]
```

(Nothing else in the `test` job changes — the `RESULTS` loop already iterates `needs.*.result` generically, so `docker-build` is covered by the existing check with no further edits.)

- [ ] **Step 3: Validate the YAML still parses**

Run:

```bash
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/ci.yml', 'utf8')); console.log('valid yaml')"
```

Expected: prints `valid yaml` with no error. (`js-yaml` is already present as a transitive dependency in `node_modules` — no install needed.)

- [ ] **Step 4: Re-confirm the build still succeeds (now cached, should be fast)**

Run: `docker build -t fairyoga-verify . && docker rmi fairyoga-verify`

Expected: `Successfully built ...` / `Successfully tagged fairyoga-verify:latest`, then the image is removed. This is a final regression check — nothing in this task touches the Dockerfile, but it confirms the working tree is still GREEN before pushing.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build the production Docker image on every push/PR

Wired into the existing test aggregate gate (needs: [...]) rather than
as a standalone check — checks and test are the only two required
status checks on main, and this is the established way to make a new
job block merges (see the test job's own docblock, PR #324).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
