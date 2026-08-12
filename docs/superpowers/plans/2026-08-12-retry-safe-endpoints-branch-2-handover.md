# Handover: implement the retry-safe endpoints plan (#196, branch 2 of 2)

You are picking up branch 2 of #196. Branch 1 is merged (PR #208). This branch
closes the issue.

**Read in this order, before touching anything:**

1. `CLAUDE.md` — the stack, the data model, the design philosophy. opencode
   auto-loads `AGENTS.md`, which only *links* to `CLAUDE.md`. Read it anyway.
2. `docs/superpowers/specs/2026-08-12-retry-safe-endpoints-branch-2-design.md`
   — the design. §1 is why the previous design was wrong; §3 is what to build.
3. `docs/superpowers/plans/2026-08-12-retry-safe-endpoints-branch-2.md` — the
   plan you execute. Seven tasks, each a full TDD cycle.
4. This file.

---

## 1. Orientation

Nine API endpoints perform their side effect twice when the same request
arrives twice, or when two arrive at once. Branch 1 fixed five of them with
Postgres unique indexes. The remaining nine (a *different* nine — the sets
overlap in four; see §4.2's note in the branch-1 spec) need no schema change,
and are this branch.

Every fix is one of three shapes:

- a **compare-and-swap**: move the guard's condition into the `where` clause, so
  the database decides the race instead of a read-then-write that cannot;
- an **advisory lock**: serialise two identical requests so a comparison between
  them is meaningful (announcements only);
- a **catch**: let the loser of a race fall through to the path that already
  handles "it already exists" (student signup only).

No migration. `prisma/schema.prisma` is not modified by any task.

### The one thing most likely to derail you

**`§4.2` of the *branch-1* spec — `2026-08-11-retry-safe-endpoints-design.md` —
is wrong, and it is the document an agent naturally finds first**, because the
issue and the roadmap both point at it by name. It was written before branch 1
executed and before any of its nine rows was read against the code.

**Seven of its nine rows are wrong.** Two would ship a live regression if
followed literally:

- *"reuse the live unconsumed token"* for magic links — impossible; only
  `sha256(token)` is stored, and the raw value is persisted nowhere.
- *"move the mint+send inside the existing guard"* for student signup — this
  would **remove sign-in for every returning student**, and no test covers that
  path, so it would ship green.

That section now carries a supersession banner pointing here. If you find
yourself implementing from a table that lists nine endpoints and nine
mechanisms in one row each, **you are reading the wrong file.** The correct
design is §3 of the 2026-08-12 spec, and it is prose, not a table.

---

## 2. Before you start — verify, don't assume

```bash
cd /Users/ivohofland/Projects/fair.yoga
git branch --show-current   # must print: fix/196-retry-safe-endpoints
git status --short          # must print ONLY: ?? docs/backlog-roadmap.md
docker ps --format '{{.Names}}' | grep fairyoga-db     # must print: fairyoga-db-1
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:3000/   # 307
```

If `git status` shows anything else tracked, stop and report — the spec, the
plan and this file are the only things that should have changed.

- **`docs/backlog-roadmap.md` is untracked and must stay untracked.** It is the
  owner's local map. Never `git add` it. This is also why you must never run
  `git add -A` or `git add .` — stage exact paths, always.
- **The app on :3000 is `next dev` serving THIS checkout.** Your edits reach it
  by hot reload.
- **Never start, restart, or kill the dev server.** The owner runs it. The
  `integration` vitest project talks to it over HTTP; a wall of `ECONNREFUSED`
  is a signal to stop and say so, not to start one.

Which database each project uses:

| project | files | database |
|---|---|---|
| `unit` | `src/**/*.test.ts` | `ethical_yoga_test` |
| `integration` | `tests/integration/**/*.test.ts` | dev DB, via the app on :3000 |
| `components` | `src/components/**/*.test.tsx`, `src/app/**/*.test.tsx` | none (jsdom) |

`48 + 27 + 36 = 111` test files, which is what `npm test` reports.

---

## 3. You are not running under Claude Code

The plan's header says *"REQUIRED SUB-SKILL: Use
superpowers:subagent-driven-development"*. That is written for the harness the
plan was authored in. **Superpowers is not installed for opencode here**, so you
have no `superpowers:*` skills.

**What to do instead:** execute the plan yourself, task by task, in the order
given. Each task already carries the full TDD cycle as explicit steps — write
the failing test, run it and watch it fail, implement, run it and watch it pass,
run the mutations, commit. Follow those steps literally. That is all the missing
skill would have given you.

**No `/pr-review-toolkit:review-pr`.** The closing procedure ends with pushing
and opening the PR. Do that, then **stop and hand back** — the owner runs the
multi-agent review in the other harness.

---

## 4. Task order, and what is actually independent

The seven tasks share no symbols, so they *could* run in any order. The order
given is deliberate anyway:

| # | Task | Why here |
|---|---|---|
| 1 | Invitations DELETE + PUT | Establishes the CAS-plus-count idiom **and** the uncommitted-holder race lever that Tasks 2 and 3 reuse. Do it first even though it is not the most urgent. |
| 2 | Registration cancel | Same idiom, second application. |
| 3 | Account erasure | Shares Task 2's subject (`handleSpotFreed`); reads better straight after it. |
| 4 | Payment reminder cooldown | Independent. |
| 5 | Magic link + student signup | Independent. Two endpoints, both small. |
| 6 | Email fallback | Independent. Changes an exported signature. |
| 7 | Announcements | **Last.** The only new idiom in the branch (advisory locks, of which this repo has none), the only transaction restructure, and the only component change. |

If a task blocks, move to the next one and report the block — nothing downstream
depends on it.

---

## 5. The stop condition that matters most

Almost every test in this branch asserts something about **two requests racing**.
That kind of test has a specific way of being worthless: it can pass for the
wrong reason, because the two requests simply serialised and never interleaved.

**Every task's "run it and watch it fail" step is therefore load-bearing. If a
concurrency test passes BEFORE you implement the fix, stop and report it. Do not
proceed. Do not adjust the assertion until it goes red. Do not decide it is
close enough.**

A test that cannot fail against the bug it is named for proves nothing. This
project has shipped three such guards before and caught all three only at
review.

Likely causes, in order:

1. **The requests genuinely serialised.** `Promise.all([post(), post()])` fires
   both, but the second can still land after the first commits. The fix is the
   deterministic lever in Task 1 — a second `PrismaClient` holding an
   uncommitted row, so the second request provably parks on a row lock. Prefer
   that lever whenever the interleave must land in a specific gap.
2. **The window is too narrow.** The `student.create` race in Task 5 is a few
   milliseconds wide. More concurrent requests widen the odds.
3. **The fixture is wrong** — e.g. Task 2's class is not actually inside the
   final-hour waitlist window, so `handleSpotFreed` auto-promotes instead of
   broadcasting and there is no duplicate to observe.

Report which you think it is and hand back.

### The mutations are the deliverable, not busywork

Each task ends with a mutation step: break the guard, watch the named test fail,
**record the exact error text**, restore. Eighteen across the branch
(`3 + 1 + 2 + 2 + 3 + 2 + 5 = 18`). They go in your final report and then in the
PR body.

Three of them are unusual and easy to get backwards:

- **Task 1, mutation 3 proves an ABSENCE.** You *add* the status scope to
  `PATCH` and watch `invitations-api.test.ts` "archives a declined row" fail.
  That is the only way to show a missing guard is deliberate rather than
  forgotten.
- **Task 3, mutation 2 keeps the scope and removes the throw.** The test must
  *still* fail. This separates "the `deletedAt: null` scope works" from "the
  abort works" — and only the abort stops the post-commit broadcast, so a
  mutation that removed both would credit the wrong half.
- **Task 7, mutation 1 requires one test to fail and another to PASS.** Removing
  the advisory lock must break the concurrent test while leaving the sequential
  one green. If both fail, the two tests are measuring one thing and the
  sequential twin is not doing its job.

---

## 6. Hazards that have actually bitten this project

- **The in-process scheduler is RUNNING locally.** `CRON_SCHEDULER` is unset in
  `.env` (CI sets it `off`), so `src/lib/scheduler.ts` is sweeping the **dev**
  database: email-fallback every 5 minutes, class-transitions every minute,
  generation and payment-reminders hourly. This is not incidental — it is
  *the defect* in Task 6, where `processEmailFallback` has two triggers rather
  than the one §4.2 names. It is also a testing hazard: **do not write an
  integration test that creates fallback-eligible notifications**, because the
  scheduler will sweep them out from under you, intermittently. Task 6 is pinned
  to the `unit` tier for that reason.
- **zsh globs `[`, `]`, `(`, `)`.** Three route files in this branch live at
  paths like `src/app/api/invitations/[id]/route.ts`. An unquoted path in a
  `grep`/`git add` either errors (`no matches found`) or, worse, silently
  matches nothing. **Quote every path containing brackets or parentheses.** The
  same applies to `--include="*.ts"` on `grep -r`.
- **Never write a GitHub closing keyword immediately before a `#N` reference in
  a commit message**, in any grammatical role — including as a *noun*, and
  including with a colon between. A commit body beginning *"The studio twin of
  the class-template **fix: #196**'s partial unique index…"* closed #196 by
  accident on branch 1. `fix`, `fixes`, `fixed`, `close`, `closes`, `closed`,
  `resolve`, `resolves`, `resolved`. Write "for #196" or "#196 is unaffected".
  Only the PR body may deliberately close #196.
- **Migrations:** none in this branch. If you think you need one, that is a plan
  defect — stop and report it rather than writing one.
- **`@/lib/log` is pino and server-only.** Before importing anything into a
  module that a `'use client'` component value-imports, check the whole
  transitive chain. Relevant in Task 7, which touches
  `src/components/class/send-announcement.tsx`: `src/lib/db-locks.ts` must stay
  free of `@/lib/log` so the integration test can import
  `ANNOUNCEMENT_DEDUPE_WINDOW_MS` from it.
- **Never edit an applied migration.**
- **Do not fix things you notice in passing.** Two known defects are
  deliberately out of scope and filed separately: `handleSpotFreed`'s missing
  capacity check (it can announce a spot already refilled — spec §6), and
  device-bound magic links. Leave both. If you find a *third*, write it in your
  report; do not fix it.

---

## 7. Running the tests

```bash
npx vitest run --project unit src/services/payments.test.ts     # one file, fast loop
npx vitest run --project integration tests/integration/announcements-api.test.ts
npx vitest run --project components src/components/class/send-announcement.test.tsx
npm run verify                                                   # typecheck + lint + all three projects
```

`npm run verify` needs the app on :3000.

### Expected counts

**Baseline, measured immediately before this file was written:**

```
Test Files  111 passed (111)
Tests       1255 passed | 2 todo (1257)
```

Which splits, so the total is checkable rather than a number to trust:

```
files:  48 unit + 36 components + 27 integration = 111 ✓
tests: 686 unit + 197 components + 372 integration = 1255 ✓
```

`unit` and `components` were both re-measured directly for this handover
(`48 / 686 + 2 todo` and `36 / 197`); `integration` is the remainder and
reconciles exactly against the full-suite total. **Both todos live in `unit`** —
if `integration` or `components` ever reports one, something was skipped.

**State this arithmetic in the PR body after your run too.** It is what turns
"the whole integration project ran" from a reassurance into a claim a reviewer
can re-derive. `npm run verify` runs all three projects, so a green `verify`
*is* the whole integration suite; the older habit of writing "integration is
never run in full" is no longer true and understates the evidence.

Every task adds tests and none should remove any, so the final number must be
**strictly greater than 1255** with **zero failures** and the todo count
unchanged at 2. If a count goes *down*, you deleted or renamed a test — say so
explicitly rather than letting the total pass as normal.

Green `verify` is a strong signal but **not** a substitute for CI: CI also runs
`prisma validate`, a migration-drift check, `npm run build`, and Playwright. A
build-only defect passes `verify` and fails CI.

### Alarming output that is not a failure

- **`ECONNREFUSED` across the integration project** means the dev server is
  down. Stop and report; do not start one.
- **`error` level pino lines during unit runs** are expected — several tests
  deliberately drive failure paths (`email fallback send failed`, `waitlist
  spot-freed hook failed`). Judge by vitest's summary, not by log noise.
- **Postgres `40P01` deadlock output** is a documented, classified condition on
  this schema (`docs/lock-order.md`); branch 1 measured it at 32/100 runs on one
  slot-swap pairing. If it appears in a *new* place, that is worth reporting.

---

## 8. What done looks like

1. Seven tasks committed, one commit minimum each, exact paths staged.
2. All eighteen mutations run, each failure's exact text recorded.
3. `npm run verify` green, with the arithmetic stated
   (`N = unit + components + integration`), not just asserted.
4. `git diff main...HEAD --name-only` reconciled against the plan's File
   Structure table — a file in the table but not the diff is unfinished work; a
   file in the diff but not the table needs explaining.
5. The three false claims in spec §1.5 swept across source, tests, docblocks,
   both specs and the plan. A claim corrected in one artifact and left standing
   in its twin is this project's most repeated failure.
6. `git log main..HEAD --format=%B | grep -inE '(clos|fix|resolv)[a-z]*[[:space:]:]+#[0-9]+'`
   — **then read what it prints.** Branch 1 ran this exact grep, it printed the
   offending line, and the output was misread as clean.
7. PR pushed and opened. Then **stop** — the owner runs the review.

### What to report when you hand back

- Which tasks completed, which blocked, and why.
- The eighteen mutations with their recorded failure text.
- The `verify` arithmetic, before and after.
- **Anything in the plan that turned out to be wrong.** Four of branch 1's task
  briefs were wrong about the state of the code, and every one was caught by an
  implementer checking rather than complying. Surfacing a plan defect is worth
  more than working around it — say so plainly rather than quietly adapting.
- Anything you noticed and deliberately did not fix.

---

## 9. Final checklist

- [ ] On `fix/196-retry-safe-endpoints`; `git status` clean but for the untracked roadmap
- [ ] `CLAUDE.md` read; the **2026-08-12** spec read (not §4.2 of the 2026-08-11 one)
- [ ] Seven tasks done in order, each committed with exact paths
- [ ] No concurrency test was accepted that passed before its fix
- [ ] Eighteen mutations run, restored, and recorded
- [ ] No migration; `prisma/schema.prisma` untouched
- [ ] No commit message puts a closing keyword before a `#N`
- [ ] `docs/backlog-roadmap.md` still untracked
- [ ] `npm run verify` green, above 1255, 2 todo
- [ ] PR opened; handed back without running the review
