# Local Gate Reliability Implementation Plan (#290)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local full run is either reliably green or reliably explains itself: serialize Playwright locally so its red means what it says, budget the one integration test that is inherently over vitest's default, and put the warm-before-scoring protocol beside the work that needs it.

**Architecture:** No production code changes. One config pin (`workers: 1`), one per-test timeout override following the suite's existing convention, and documentation in three sites. The branch's substance is measurements — every number below was re-derived on 2026-08-21, and Task 1 adds the two the spec deferred (local e2e duration, fanned out vs serialized).

**Tech Stack:** Playwright config, Vitest, Markdown. Nothing else.

**Spec:** `docs/superpowers/specs/2026-08-21-local-gate-reliability-design.md`. Read §Decisions (D1–D3) and §Rejected before arguing with a step below; the rejected list already contains the four tempting alternatives (separate server, higher default timeout, concurrent burst, `freshIp()` bypass) with reasons.

## Global Constraints

- **Never start or restart the dev server on :3000.** The user runs it; both suites need it live. Check `lsof -nP -iTCP:3000 -sTCP:LISTEN` if unsure.
- **Every guard gets a mutation.** This branch has two guards (the worker pin, the timeout budget). Break each, record the exact observed output, restore, re-verify. A guard that has never been seen to fail certifies nothing.
- **Measurements are deliverables.** The durations and error texts each task produces go into the commit message and later the PR body. A number without its derivation will be re-litigated in review.
- **No new tests.** The suite's shape is unchanged; if you find yourself adding a test file, stop and re-read the spec.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Commit per task.** The PR is rebase-merged, so the per-task history is the record.
- **Run `npm run verify` before pushing** — typecheck, lint, and all three vitest projects. Needs the app on :3000 (it is).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `playwright.config.ts` | `workers: 1`, unconditional, with the why-comment | 1 |
| `tests/integration/students-api.test.ts` | `30_000` budget on the burst test, with the measured-margin comment | 2 |
| `AGENTS.md` | Two lines under "Verify commands": serialized by config; warm after edits | 3 |
| `.claude/skills/verify/SKILL.md` | One gotcha: lazy compilation, warm routes before gates/mutation scores | 3 |
| `.claude/skills/solve-issue/SKILL.md` | One hazard bullet: warm before scoring mutations | 3 |

---

### Task 1: Serialize Playwright locally

**Files:**
- Modify: `playwright.config.ts` (line 8)

This task's steps are order-bearing: **measure before editing**, or the "before" number is gone.

- [ ] **Step 1: Measure the fanned-out baseline**

```bash
npx playwright test --reporter=list 2>&1 | tee /tmp/e2e-before.txt | grep -E "Running|passed|failed" | head -5
```

Expected: a header naming several workers (machine-dependent, roughly half the cores) and a duration. If the run is **red**, that is data, not a failed step — record the victim test and confirm it passes isolated (`npx playwright test <file> --project=chromium`), exactly the pattern the issue documents. Record: worker count, wall duration, any victim.

- [ ] **Step 2: Pin the worker count**

Replace line 8:

```ts
  workers: process.env.CI ? 1 : undefined,
```

with:

```ts
  // Serialized unconditionally (#290): every extra worker drives another
  // browser against the same single dev server on :3000 this checkout
  // serves, and four parallel full runs during #285's gates produced four
  // different victims, each green alone. CI already ran at 1, so this
  // changes only local behaviour: slower, but a red run means what it says.
  workers: 1,
```

Leave `fullyParallel: true` and the `retries` ternary untouched — the spec's D1 covers why both stay.

- [ ] **Step 3: Prove the pin bites**

```bash
npx playwright test --reporter=list 2>&1 | tee /tmp/e2e-after.txt | grep -E "Running|passed|failed" | head -5
```

Expected: `using 1 worker` and a green run. Then the mutation — restore `workers: process.env.CI ? 1 : undefined` long enough to re-run the header check and see the worker count climb above 1, record that output, and re-apply the pin. The pair of observations (1 worker pinned, >1 reverted) is the guard's proof; the flake itself is statistical and is not demoed on demand.

- [ ] **Step 4: Record the cost**

From the two teed files: before/after wall durations. Put both, with the worker counts, in the commit message. Predicted direction: serialized is slower; the spec accepts this in advance, but the PR body must state the real price, not assert it was acceptable.

- [ ] **Step 5: Commit**

```bash
git add playwright.config.ts
git commit -m "fix: local e2e runs one worker, like CI (#290)"
```

Commit body carries the Step 1/3/4 measurements.

---

### Task 2: Budget the invitation burst

**Files:**
- Modify: `tests/integration/students-api.test.ts` (the `it` closing around line 1220)

The red side of this guard is already proven — measured twice (issue comment, then spec verification day-of): solo, idle server, `Test timed out in 5000ms`; passes with `--testTimeout=20000` at ~9s of test time. Re-confirm rather than trust:

- [ ] **Step 1: Watch it fail at the default**

```bash
npx vitest run --project integration tests/integration/students-api.test.ts \
  -t "refuses a 51st invitation within the hour"
```

Expected: `Error: Test timed out in 5000ms.` — record the exact text.

- [ ] **Step 2: Add the budget**

Change the test's closing `});` to:

```ts
  }, 30_000);
```

and directly above it add:

```ts
    // 51 sequential round trips ≈ 9s through next dev (measured 2026-08-21,
    // idle server): over vitest's 5s default with nothing else running, so
    // the default budget failed this test for reasons unrelated to any
    // change (#290). 30s absorbs contention on a busy dev server, not just
    // solo latency. Sequential stays load-bearing — see the limiter note
    // above; the 429 must land on request 51, deterministically.
```

Number form (`}, 30_000);`), not the `{ timeout }` object form — matching the nearest neighbour at `teacher-rooms-api.test.ts:611`.

- [ ] **Step 3: Watch it pass**

Same command as Step 1. Expected: `1 passed`, tests time ~9s. Record it.

- [ ] **Step 4: Prove the budget is what stands between red and green**

Temporarily set the budget to `5_000`, re-run, confirm the failure text matches Step 1's byte for byte, restore `30_000`, re-run green. This is the break-check the skill demands: an override that cannot fail is decoration.

- [ ] **Step 5: Run the whole file**

```bash
npx vitest run --project integration tests/integration/students-api.test.ts
```

Expected: 33/33. The edit touches one test's deadline; this confirms it touched nothing else.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/students-api.test.ts
git commit -m "test: the invitation burst gets a 30s budget, measured (#290)"
```

Commit body carries the Step 1/3/4 texts and timings.

---

### Task 3: Document the warm-up protocol

**Files:**
- Modify: `AGENTS.md`, `.claude/skills/verify/SKILL.md`, `.claude/skills/solve-issue/SKILL.md`

Three sites, three audiences (gate-runners, app-drivers, mutation-sweep dispatchers). Draft text follows; adjust voice to each document, not the facts.

- [ ] **Step 1: AGENTS.md — "Verify commands" section**

After the code block, add:

```markdown
- Local e2e is serialized (`workers: 1` in `playwright.config.ts`) — every test shares the one dev server on :3000; fan-out once failed four different tests across four parallel runs (#290).
- After editing source, hit each touched route once (`curl` is enough) before trusting a gate run or scoring a mutation — `next dev` compiles lazily per route, so the first requests pay compilation and can blow a 5s timeout. A red right after an edit is a cold route until proven otherwise.
```

- [ ] **Step 2: verify skill — "Gotchas" list**

Append:

```markdown
- `next dev` compiles lazily per route: the first request after a source edit pays compilation and can blow a 5s test timeout or a Playwright visibility budget. Warm each touched route once (bare `curl`) before running gates or scoring mutations — a RED immediately after an edit is a cold route until proven otherwise (#290).
```

- [ ] **Step 3: solve-issue skill — "Project hazards that have actually bitten"**

Append:

```markdown
- **Warm routes before scoring mutations.** `next dev` recompiles lazily after a source edit; the first requests pay compilation and can blow a 5s timeout, which reads exactly like an assertion failure — three mutations on #285 were mis-scored RED this way before #290 named the protocol. Apply mutation → curl the touched route(s) → then judge RED/GREEN.
```

- [ ] **Step 4: Run every documented command as written**

Mechanical doc verification: `curl -sf http://localhost:3000/api/health` (the AGENTS.md warm-up example's shape) against a route the tasks actually touched — none did, so use `/api/health` plus one page route. Confirm the `--reporter=list` invocation from Task 1 still reads `1 worker`, since AGENTS.md now asserts serialization as fact. Fix any command whose output disagrees with its doc line.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md .claude/skills/verify/SKILL.md .claude/skills/solve-issue/SKILL.md
git commit -m "docs: warm routes before gates and mutation scores (#290)"
```

---

### Task 4: Verify, push, PR

- [ ] **Step 1: Full gate**

```bash
npm run verify
```

Needs :3000 live. Expected green across typecheck, lint, unit + integration + components. Record the per-project test counts for the PR body's arithmetic (totals should be unchanged from `main` — this branch adds no tests).

- [ ] **Step 2: Push and open the PR**

Base `main`. The body must record:

- The two e2e durations (fanned out vs serialized) with worker counts — the price of D1, stated not asserted.
- The burst test's three states: 5000ms-default failure text, 30s-budget pass (~9s), and the 5000-mutation reproducing the failure byte-for-byte.
- Suite arithmetic from Step 1, proving every integration file ran; name `tests/integration/students-api.test.ts` as the only touched integration file.
- What the branch deliberately does **not** do: no separate e2e server, no change to vitest's 5s default, no concurrent burst, no `freshIp()`-style bypass — each with its one-line reason from the spec's §Rejected.
- `Closes #290` — closure is intended here; write no negated-close phrasing anywhere in the body (see the hazard list: GitHub's parser cannot read negation).

Then the usual arc: `/pr-review-toolkit:review-pr` in parallel, aggregate, fold/file/let-go, rebase-merge (never squash), roadmap update committed on its own.

---

## Definition of Done

1. `npx playwright test --reporter=list` locally names **1 worker**, and the before/after durations appear in the PR body.
2. `npx vitest run --project integration tests/integration/students-api.test.ts` — no flags — is green, 33/33.
3. Both guards have recorded mutations: worker pin reverted → >1 workers observed; budget set to 5000 → original failure text reproduced.
4. All three doc sites state facts verified by running the commands they document.
5. `npm run verify` green; PR body carries every measurement with its derivation.
