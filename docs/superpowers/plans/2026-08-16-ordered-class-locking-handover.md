# Handover — ordered multi-row `Class` locking (#237)

You are picking up a branch that is designed, planned and unbuilt. The spec and
the plan tell you *what to do*. This document tells you *what will mislead you
on the way* — things you will get wrong precisely because you read the correct
documents carefully.

**Branch:** `ordered-class-locking` (already exists, two commits: spec, plan).
**Base:** `main` at `2dcaa04`.

---

## Read these, in this order

1. **`CLAUDE.md`** — the whole file, it is short. If your harness auto-loads
   `AGENTS.md`, note that `AGENTS.md` only *links* to `CLAUDE.md`; it does not
   contain it. The sections that matter here: "Development Principles"
   (test-first, strict TypeScript, migrations) and "Key Constraints".
2. **`docs/superpowers/specs/2026-08-16-ordered-class-locking-design.md`** —
   read **§1 in full**. It is the measurement record, and three of its findings
   contradict the GitHub issue. Skim §2.1 (why fragments, not a typed union) so
   you do not re-open a settled decision. §7 and §8 are the risk and
   out-of-scope lists you must not quietly expand.
3. **`docs/superpowers/plans/2026-08-16-ordered-class-locking.md`** — the ten
   tasks. Work them in order.
4. **`docs/lock-order.md`** — **§"Ordering WITHIN `Class`"** and **§"How that
   enumeration was derived"** only. Do not read the whole 907-line file up
   front; you will lose more than you gain. The rest is reference for when a
   specific question arises.

Everything else in `docs/` is reachable when you need it and not before.

---

## The derailers

These come first because they are unrecoverable mid-implementation. Each is
something the *correct* documents will lead you into.

### D1. The issue is wrong about why this work exists, and the spec says so

GitHub issue #237's "Why now" section says the erasure's `ORDER BY` lost its
only reproduction and that this branch repays that debt. **It did not.** Measured
2026-08-16: deleting the clause leaves `template-lock-order.test.ts` green (the
issue's stated claim, which holds) *and* fails `gdpr.test.ts:1344` with a real
`40P01`, five runs out of five.

If you read the issue and conclude "there is no coverage here, so anything I add
is an improvement", you will accept a weaker guard than the branch needs. There
**is** a working reproduction, Task 8 will break it, and Task 8's job is to
rebuild it — not to replace it with something looser.

### D2. Two callers with the same predicate cannot pin `ORDER BY`

This is the one that will cost you a day if you get it wrong, because the wrong
version *passes*.

The obvious pin is "call the helper twice concurrently over the same rows and
assert no deadlock." That test passes with `ORDER BY c.id` **and without it**.
Two identical statements produce one query plan, visit rows in one physical
order, and serialise either way. It certifies nothing.

`ORDER BY c.id` is load-bearing only between two *different plans*. The
`WaitlistEntry` join is driven by that table and returns classes in its physical
order; a plain `Class` scan returns them in `Class`'s. Those can disagree — and
the fixture has to make them disagree, by seeding the two tables in **opposite**
orders.

Task 2 has the working construction. Do not simplify it.

### D3. The `gdpr.test.ts` fixture must be flipped, or Task 8 silently fails

Today `gdpr.test.ts`'s `beforeAll` inserts its classes HIGH-then-LOW and its
`WaitlistEntry` rows HIGH-then-LOW as well. That is fine right now, because the
two erasures get their lock order from two different mechanisms (a SQL
`ORDER BY` on one side, a Prisma `orderBy` on the other).

After Task 8, **one `ORDER BY` orders both sides.** Delete it and the teacher
side takes `Class`-scan order while the student side takes join order — and with
the current fixture those two *agree*, so no cycle forms and the re-pointed test
passes on broken code.

Task 8 Step 3 flips the waitlist inserts to LOW-first. If you skip it you will
reach Step 5, watch the mutation fail to reproduce, and correctly-but-wrongly
report "this test cannot be made to bite." The fixture is the reason, not the
design.

### D4. `setLockTimeout(tx)` at `gdpr.ts:340` is not redundant — do not delete it

Task 4 gives `deleteStudentAccount` a helper that issues `setLockTimeout`
itself. It will look like the standalone call higher up the same transaction is
now dead. It is not: a `tx.registration.findMany` runs **between** line 340 and
the lock statement, and that read is bounded only by the earlier call.

Deleting it re-introduces exactly the defect #216/#182's round-2 review
measured — an unbounded wait on a contended `registration` row, ~3s and
climbing — and no test will catch you, because the bound is only observable
under contention nothing exercises.

Calling `setLockTimeout` twice is safe and documented: a later
`SET LOCAL lock_timeout` overwrites the earlier one rather than stacking.

### D5. A mutation must use a value the code cannot produce

Task 7 asks you to mutate `CANCELLABLE_STATUSES`. Mutate it to a **subset**
(`['draft','open']`), never to an invented status string — `ClassStatus` is a
Postgres enum, and an invalid value fails at the driver rather than at the
assertion, which proves the driver works and nothing else.

The general rule, and this project has been bitten by it: a mutation constant
that sits inside the range the real code produces can poison shared state. A
previous round mutated an IP-address helper to `10.0.0.1`, poisoned a live
rate-limit bucket for an hour, and the 429 resurfaced in an unrelated test on a
run nobody connected to the mutation.

### D6. `Prisma.raw` for the status list is not a style choice

Task 7 renders `CANCELLABLE_STATUSES_SQL` with `Prisma.raw`. You will be tempted
to use `Prisma.join`, which is the safer-looking API. It was measured here to
cost the index: `Prisma.join` binds each status as a separate parameter, and a
bound text parameter compared against an enum column needs an explicit `::text`
cast to resolve. See `class-template-lifecycle.ts:653` for the full note.

`Prisma.raw` is defensible **only** because the array is frozen and hard-coded.
Keep the `Object.freeze` and the `readonly`. If you find yourself dropping
`readonly` to avoid a spread at the call site, you have removed the one
precondition that makes the concatenation safe.

---

## Verify don't assume

Run this before your first edit. Every line reference in the plan was checked
against this checkout on 2026-08-16, but a reference that drifts is a wrong
instruction, not a typo — if one is off, fix the plan and say so in your report.

```bash
docker ps --format '{{.Names}}' | grep fairyoga-db-1     # expect: fairyoga-db-1
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/   # expect: 307 (or 200)

sed -n '2p'         src/lib/db-locks.ts        # import type { Prisma } from '@prisma/client';
sed -n '193p'       src/lib/db-locks.ts        # export async function lockClassRow(
sed -n '48p'        src/lib/db-locks.test.ts   # async function _theBrandRejectsABareClient(
sed -n '340p'       src/services/gdpr.ts       # await setLockTimeout(tx);        <- D4
sed -n '402p'       src/services/gdpr.ts       # await tx.$queryRaw`
sed -n '860p'       src/services/gdpr.ts       # const upcoming = await tx.class.findMany({
sed -n '945p'       src/services/waitlist.ts   # const locked = await tx.$queryRaw<Array<{ id: string }>>`
sed -n '957p'       src/services/waitlist.ts   # const classIds = [...new Set(locked.map((row) => row.id))];
sed -n '113p'       src/services/template-sync.ts            # await setLockTimeout(tx);
sed -n '1251p'      src/services/class-template-lifecycle.ts # await tx.$queryRaw`
sed -n '631p'       src/services/class-template-lifecycle.ts # const SCHEDULED_STATUSES: readonly ClassStatus[] = ...
sed -n '1344p'      src/services/gdpr.test.ts  # it('does not deadlock when a teacher erasure and a student erasure...
```

**This block was run before this document was committed**, and it found two
drifted references, both now corrected in the plan: `_theBrandRejectsABareClient`
is at `db-locks.test.ts:48`, not `:47` (line 47 is the eslint-disable comment
above it), and `deleteTeacherAccount`'s `upcoming` read starts at `gdpr.ts:860`,
not `:861` (861 is its `where:` line). That is the worked example — do the same
and report what you find.

---

## Harness differences

You are not running the harness this plan was written in.

- **No skills system.** The plan references `superpowers:subagent-driven-development`
  in its header. Ignore it — execute the tasks yourself, in order.
- **Nothing enforces test-first.** The plan puts the failing test before the
  implementation in every task because that is this project's rule, not because
  a tool checks. Keep the order: write the test, **run it and see it fail with
  the expected message**, then implement. A test you never watched fail is a
  test you have not verified.
- **Mutations are deliverables, not exploration.** Six of them are specified
  with expected failure text. Each one's result goes in your report, including
  the ones that do not fail. A mutation that unexpectedly survives is a finding.
  Restore and re-verify after every single one — a left-behind mutation is the
  worst outcome on this branch, because several are in shared code.
- **Commit per task.** The PR is rebase-merged, never squashed; the per-task
  history is the record. Ten tasks, nine commits (Task 10 commits nothing
  unless it finds a defect). Commit messages are in the plan — use them, or
  better ones.
- **`git add` exact paths.** Never `git add -A` or `git add .`.

---

## Task order, and which parts of it are load-bearing

| Order | Load-bearing? | Why |
|---|---|---|
| 1 before everything | **Yes** | Nothing compiles without the helper. |
| 2 before 3-8 | **Yes** | The guard must exist before call sites depend on it. If you convert first and pin later, a conversion defect and a pin defect become indistinguishable. |
| 3 before 4-6 | Preference | `withdrawWaitingEntriesForTeacher` is already imported by `db-locks.test.ts`'s brand list, so a signature surprise surfaces against a test that already exists. Cheapest failure first. |
| 4, 5, 6 among themselves | Preference | Independent. |
| 7 before 8 | **Yes** | Task 8's pre-lock consumes `CANCELLABLE_STATUSES_SQL`. |
| 8 as ONE task | **Yes** | See below. |
| 9 after 3-8 | **Yes** | The documentation states what the code now does. Writing it first makes it a prediction. |
| 10 last | **Yes** | It re-runs every mutation against the *final* state. |

**Why Task 8 must not be split.** The fold removes the window
`gdpr.test.ts:1344`'s hook interleaves into. Between the fold and the re-point,
that test passes while guarding nothing. Splitting them across two commits
creates a commit in the permanent history where a deadlock guard is silently
dead — and this project's last round found exactly that shape ("one test went
vacuously green rather than flaking, which keeps CI quiet while the guard is
gone"). Task 8's Step 2 makes you *measure* the vacuity rather than assume it,
which is also the evidence your report needs.

---

## Stop conditions

Stop and report rather than pressing on, if any of these happen.

1. **Task 2 Step 3: deleting `ORDER BY c.id` does not fail the new pin.**
   This is the branch's central guarantee. The likely cause is a premise
   assertion that passed while the planner picked a different drive table.
   **Do not weaken the assertion to make it fail** — that produces a test that
   fails for the wrong reason, which is worse than no test. Report the actual
   plan (`EXPLAIN` the two premise queries) and stop.
2. **Task 8 Step 5: the re-pointed `gdpr.test.ts:1344` reaches fewer than 5/5
   failures under the mutation.** Do not tune the delay until one run goes red.
   A race reproduction that fails 3-in-5 is not a guard. Report the measured
   rate. Task 8 Step 6 tells you what to write in the docblock if it genuinely
   cannot be constructed — but check D3 first, because the fixture is the
   commonest cause.
3. **Task 10 Step 2: the `FOR UPDATE OF` grep returns more than one production
   statement.** That means a call site did not convert, and the branch's headline
   acceptance criterion is unmet. Find it before reporting done.
4. **Any mutation you cannot restore cleanly.** `git diff` must be empty of the
   mutation before you move on. If in doubt, `git stash` is not enough — check
   the diff.

---

## Hazards this branch can actually hit

Trimmed from `.claude/skills/solve-issue/SKILL.md` to what applies here.

- **Never start or restart the dev server on :3000.** The user runs it. It
  serves this checkout and the `integration` project talks to it over HTTP.
  Restarting it is the fastest way to break tests you did not touch.
- **`npm run verify` needs :3000 live.** Without it you get a wall of
  `ECONNREFUSED` from the integration project and will misread it as your bug.
- **Green `verify` is not CI.** CI also runs `prisma validate`, a migration-drift
  check, `npm run build` and Playwright. A build-only defect passes `verify` and
  fails CI. Relevant here because Task 1 changes `db-locks.ts` from a type-only
  to a **value** import of `@prisma/client`.
- **`@/lib/log` is pino and server-only, and the same reasoning now applies to
  `db-locks.ts`.** After Task 1 it pulls the generated Prisma client into
  anything that imports it. Verified 2026-08-16 that no `'use client'` component
  imports `@/lib/db-locks` — every importer is a service, an API route or a
  test. If you find yourself importing it from a client component, stop.
- **Quote paths containing parentheses when staging** — `(public)`,
  `(teacher)`, `(student)`. Not expected on this branch, but an unquoted glob
  over one of these silently matches nothing.
- **No migrations on this branch.** `prisma/schema.prisma` is untouched. If you
  think you need a schema change, you have misread something — stop and report.
- **Never write "does not close #N" in a commit message or the PR body.**
  GitHub's parser matches the keyword and ignores the negation in front of it;
  it has closed an issue here twice, the second time in the commit written to
  document the first. Write "**#N is unaffected**". And if you need to *explain*
  the trap, break the token rather than quoting it.
- **Post `gh` prose from a `--body-file`, never `--body "…"`.** Backticks inside
  a double-quoted shell string reach zsh as command substitution even escaped,
  and it fails *silently* — a previous round published a sentence with two file
  paths eaten and a `gh` call that returned a URL and looked successful.

---

## Measured baseline — 2026-08-16, this checkout, before any change

Run these yourself and reconcile against these figures. If they differ, `main`
has moved; say so rather than adjusting silently.

| Project | Files | Tests |
|---|---|---|
| `unit` | 53 | 769 |
| `components` | 38 | 207 |
| `integration` | 28 | 410 |
| **Total** | **119** | **1386** |

Arithmetic: `53 + 38 + 28 = 119` files, `769 + 207 + 410 = 1386` tests.
`npm run typecheck` and `npm run lint` both green.

**Predicted after: about 1391 unit tests** — this branch adds four behavioural
tests in `db-locks.test.ts` and one in the new `db-locks-lock-order.test.ts`,
with `components` and `integration` unchanged. **Measure it anyway and report
the real figure.** The last handover written in this project predicted 1294 and
the true number was 1296, because that branch's own review added tests the
prediction could not have known about. The prediction is a sanity check, not an
expected value.

### Runs vs changes — state both, they are different

This branch **changes** no file under `tests/integration/`. It **runs** all 28
of them, because `npm run verify` runs all three vitest projects. Say both in
the PR body. Do not write "the integration suite is never run in full" — that
was true here once and is not now, and repeating it understates your evidence.

---

## What "done" looks like

- `npm run verify` green, with per-project counts that reconcile.
- `grep -rn "FOR UPDATE OF" --include="*.ts" src/ | grep -v '\.test\.ts'` returns
  exactly one production statement, in `src/lib/db-locks.ts`.
- Five `lockClassRowsOrdered` call sites, **named** in your report rather than
  counted: `gdpr.ts` (twice), `waitlist.ts`, `template-sync.ts`,
  `class-template-lifecycle.ts`.
- All six mutations re-run against the final branch state, each restored.
- Nine commits on `ordered-class-locking`, on top of the two that are there.

## What your report back must contain

1. **The measured after-figures**, per project, with arithmetic.
2. **Every mutation, and what it produced** — including any that did not fail.
   Quote the actual error text for the ones that did.
3. **Whether `gdpr.test.ts:1344` reached 5/5** under the final mutation, and if
   not, what you measured and what the docblock now says.
4. **Every line reference that had drifted**, and what you corrected it to.
5. **Anything in the plan that was wrong.** The plan is a prediction written by
   someone who did not run it. Surface its defects rather than bending code to
   match a wrong instruction — adjudicate them in your report with reasoning,
   never quietly accept and never quietly drop.
6. **What you did not do**, and why.

---

## Final checklist — one line per irreversible mistake

- [ ] No mutation left in the tree. `git diff` clean before each commit.
- [ ] `setLockTimeout(tx)` at `gdpr.ts:340` still present (D4).
- [ ] `gdpr.test.ts`'s waitlist inserts are LOW-first (D3).
- [ ] Task 8 committed as one commit, not two.
- [ ] `CANCELLABLE_STATUSES` still `Object.freeze`d and `readonly` (D6).
- [ ] No `git add -A` / `git add .` anywhere in your history.
- [ ] No "does not close #N" phrasing in any commit message.
- [ ] The dev server on :3000 was never restarted.
- [ ] `prisma/schema.prisma` untouched, no new migration.
- [ ] Every mutation restored **and re-verified green**, not just restored.
