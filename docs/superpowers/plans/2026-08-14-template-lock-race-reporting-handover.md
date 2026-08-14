# Handover — template lock-race reporting (issue 113)

You are implementing a branch that is already specified and planned. This
document carries what the spec and plan cannot: the things that will mislead you
on the way.

Branch: `fix/113-template-lock-race-reporting`, already created, two commits on it
(the spec and the plan). Base: `main` at `e3addf1`.

## Read these, in this order

| # | File | What actually matters in it |
|---|---|---|
| 1 | `CLAUDE.md` | Loads automatically. "Development Principles" (test-first, strict TS, services framework-agnostic) and "Class Lifecycle". Trust it over your own recall of this stack. |
| 2 | `docs/superpowers/specs/2026-08-14-template-lock-race-reporting-design.md` | Read **"What the issue claims, and what is actually true"** first. It is the reason this branch is not what the issue describes. |
| 3 | `docs/superpowers/plans/2026-08-14-template-lock-race-reporting.md` | The six tasks, with real code. Read "Task Order Is Load-Bearing" before Task 1. |
| 4 | `.claude/skills/solve-issue/SKILL.md` | Sections 2 (counts), 3 (prove every guard bites) and 4 (correct a claim in every artifact). Skip the rest — it describes a process you are not running. |

If your harness auto-loads `AGENTS.md`: it is a short pointer file. It carries the
verify commands and quick start, and it **links** to `CLAUDE.md` rather than
containing it. Read `CLAUDE.md` yourself.

---

## Derailers — read before you touch anything

These are not hazards. They are wrong turns that the **correct** documents invite,
and each is unrecoverable or expensive once you are mid-implementation.

### 1. The issue's headline symptom is already fixed. Do not rebuild it.

Issue 113 says a lost lock race reaches the teacher as a red *"Internal server
error"* 500, because `withErrorHandler` special-cases only P2002. **That has not
been true since the API error-classification work landed.** `src/lib/api-errors.ts`
puts `P2028`/`P2024`/`P2034` in `TRANSIENT_PRISMA_CODES`, tests it *before* the
P2002 branch, and answers 503 with *"The system was busy and could not finish
that. Please try again."* at `level: 'warn'`. The archive button surfaces that
text verbatim through `readErrorMessage`.

If you read the issue and start building a status mapping, you will be building a
second copy of something that already works. This branch is about the **wait**
(ten seconds of spinner), the **attribution** (which of four operations lost), and
the **forcing function** (a compile error at the route). Not the status code.

### 2. `SET LOCAL lock_timeout` bounds every remaining statement, not just the next one

It is tempting to read `setLockTimeout(tx)` as "the CAS's timeout". It is not. It
governs every statement left in the transaction and resets on `COMMIT`/`ROLLBACK`.
That is why the arithmetic in the plan counts *lock-waiting statements per
transaction* (at most three: the CAS, the `deleteMany`, the notification inserts)
against the 10 s budget, rather than counting one.

Get this wrong and you will either add a second redundant bound, or conclude the
budget is unsafe when it isn't.

### 3. Widening a union does NOT light up every `never` guard — and two of them must stay dark

`src/app/api/class-templates/[id]/route.ts` contains **four**
`const unhandled: never = result;` guards. Only two belong to this branch:

| Guard closes | Yours? |
|---|---|
| `UpdateTemplateResult` (from `updateClassTemplate`) | no |
| `ArchiveTemplateResult` | Task 1 |
| `switch (result.action)` over the **`ok: true`** arm | **no** — `busy` is `ok: false` and cannot reach it |
| `PauseTemplateResult` reasons | Task 3 |

The studio route has **three**, same pattern, of which the archive's and the
pause/resume reason chain are yours.

If you add a `busy` case to the success-action switch you are adding a branch the
type system says is unreachable, and you will have to fight the compiler to do it.
That fight is the signal you are in the wrong guard. Identify guards by what they
close, never by counting down the file.

### 4. The 5.5-second test does not "start failing". It becomes unwritable.

`src/services/class-generator.test.ts` holds a generation claim for 5 500 ms and
asserts the contending archive still resolves `ok: true`. Its purpose was to prove
`{ timeout: 10_000 }` beats Prisma's 5 s default.

Under a 2 s `lock_timeout` an archive **cannot** wait 5.5 s for a row under any
budget. So the assertion is not flaky, not merely red — its premise is gone.

Two ways to get this wrong, both natural:

- **Deleting it.** Its own docblock says *"do not delete it under the assumption
  the studio side still covers it"*, and that warning stands: the studio sibling
  only pins that the option is still *passed*, via a `$transaction` proxy. Task 1
  re-points this test to assert the new contract.
- **Landing the bound first and repairing the test after.** The plan puts the test
  change and the bound in one commit deliberately. Either half alone leaves the
  suite red, and a red suite between commits is indistinguishable from a mistake
  when someone bisects later.

### 5. This branch touches a live deadlock cycle. It does not fix it, and must not claim to.

`docs/lock-order.md`, "The two that do not — live, unfixed, and partly
branch-caused", records that `archiveOrUnarchiveTemplate` takes `Class` row locks
in **heap order** and cycles against account erasure, producing a real reproduced
`40P01`. It is unfixed on purpose, for three stated reasons.

Giving the archive a `lock_timeout` gives a caught race a second way to end — it
does not break the cycle. In practice `40P01` still usually wins, because
Postgres's deadlock detector runs on a 1 s `deadlock_timeout` and fires before the
2 s bound. Both SQLSTATEs are already in `TRANSIENT_SQLSTATES`, so both now answer
`busy` and the teacher sees the same thing either way.

Task 6 Step 2 **appends** to that section rather than rewriting it, precisely so it
keeps saying the cycle is open. Do not let the doc read as though this closed it.
The two `it.todo` markers in `src/services/gdpr.test.ts` that keep the cycle
visible must survive this branch untouched — they are the `2 todo` in the baseline
below.

### 6. Never write an auto-close keyword immediately before an issue number

GitHub's parser matches any of its keywords sitting immediately before a `#`-ref
— `\[keyword] #113` — and does not understand a negation in front of it. This
issue has been closed by accident **twice**: once by a PR body saying it would
not close it, and once, five minutes after the reopen, by the commit written to
document that trap, because that commit quoted the offending line verbatim.

Note what the sentence above just did, and copy it. It had to name the pattern,
so it broke the token — `\[keyword]` rather than the word itself. Quoting the
phrase intact is what fired the trap the second time.

So: in commit messages, the PR body, and any comment — write **"issue 113 is
unaffected"** or **"leaves 113 open"**. If you have to reproduce the phrase to
explain it, break the token: separate the keyword from the number, or drop the
`#`. The spec and plan for this branch contain no `#N` references at all for this
reason, so you may quote them freely.

The same applies to `fixes`, `fixed`, `resolves`, `resolved`, `closed`.

---

## Verify, don't assume

Every reference below was run against the tree at the time of writing. Run them
again before you start. **If any drifts, fix the reference and report it** — do not
work around it silently.

```bash
# The app must already be running on :3000. DO NOT START OR RESTART IT.
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
# → 200

docker ps --format '{{.Names}}' | grep fairyoga
# → fairyoga-db-1

grep -c "export async function setLockTimeout\|export const LOCK_TIMEOUT_SQL" src/lib/db-locks.ts
# → 2

grep -c "export function isTransientDbError" src/lib/api-errors.ts
# → 1

grep -h "^export async function \(archiveOrUnarchive\|pauseOrResume\)" \
  src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts
# → exactly these four, in this order:
#   export async function pauseOrResumeTemplate(
#   export async function archiveOrUnarchiveTemplate(
#   export async function pauseOrResumeStudioTemplate(
#   export async function archiveOrUnarchiveStudioTemplate(

grep -c "lets a concurrent archive outlive its own transaction default" src/services/class-generator.test.ts
# → 1   (the test Task 1 re-points)

grep -c "const unhandled: never = result;" "src/app/api/class-templates/[id]/route.ts"
# → 4   (only two are yours — see derailer 3)

grep -c "const unhandled: never = result;" "src/app/api/studio-class-templates/[id]/route.ts"
# → 3   (only two are yours)

grep -cE "^  it\.todo\(" src/services/gdpr.test.ts
# → 2   (the deadlock markers; they must survive)
```

**A worked example of this block doing its job.** Writing this handover, two of
its own claims were wrong before they were checked: the `never`-guard counts were
predicted as 2 per file and measured as 4 and 3, and an `it.todo` count came back
as 3 because a docblock mentions the phrase. Both were corrected in the plan
before it reached you. Expect the same of yourself.

---

## Harness differences

You are not running the process that produced these documents. Concretely:

- **No skills system.** Where the plan says "per the spec", the spec is a file you
  read, not a tool you invoke.
- **TDD ordering is not enforced by anything but you.** Every task is written
  test-first — failing test, watch it fail, implement, watch it pass. The
  "watch it fail" step is not ceremony here: for Tasks 1–4 the failure *shape*
  differs from what you would guess, and the plan states the expected shape each
  time. If it fails differently, stop and work out why.
- **Mutations are deliverables, not a private check.** Each mutation's exact error
  text goes into
  `docs/superpowers/plans/2026-08-14-template-lock-race-reporting-mutations.md`,
  under a per-task heading. Create that file in Task 1.
- **Commit per task.** The PR is **rebase-merged, never squashed** — the
  commit-per-task history is the record. Do not amend earlier tasks' commits.
- **Stage exact paths. Never `git add -A` or `git add .`.** Paths containing
  parentheses (`(teacher)`, `(public)`) must be quoted; an unquoted glob over one
  silently matches nothing.

---

## Task order, and which constraints are load-bearing

```
Task 1  class archive          ← test change and bound MUST be one commit
Task 2  studio archive           independent
Task 3  class pause/resume       independent
Task 4  studio pause/resume      independent
Task 5  both create routes       independent
Task 6  correct the claims     ← MUST be last
```

**Load-bearing (a reason, not a preference):**

- **Task 1's test and bound in one commit.** Derailer 4. Either half alone leaves
  the suite red.
- **Task 6 last.** It corrects comments that Tasks 1–5 make false. Run earlier and
  it corrects claims that are still true, then goes stale itself.
- **Within every task: the `isTransientDbError` branch goes first in the catch**,
  ahead of `isUniqueConflictOn` and the P2025 check. `P2028`/`P2024` are
  `PrismaClientKnownRequestError`s — the same class those branches inspect — so
  the other order lets a transient code fall past a branch that cannot match it
  into the rethrow. That is the exact failure this branch exists to remove, and
  `classifyApiError` documents the same ordering requirement for the same reason.

**Preference, reorder freely:** Tasks 2, 3, 4 and 5 among themselves. They touch
disjoint functions. Task 2 and Task 4 both add imports to
`studio-class-template-lifecycle.ts`; whichever runs first adds them.

---

## Stop conditions

Stop and report rather than pressing on if:

- **A mutation does not fail.** A guard that cannot fail certifies nothing. This
  project has shipped three such guards before, all caught only at PR review.
- **A mutation fails for the wrong reason.** "The test went red" is not the bar —
  it must go red *because of the thing you broke*.
- **`npm run verify` is red in a way you did not cause.** Report the output; do
  not repair unrelated tests.
- **A plan step's predicted output does not match.** The plan has been wrong
  before — four wrong predicted outputs on an earlier branch were found exactly
  this way. Surface it and adjudicate; never bend the code to match a wrong
  instruction, and never silently accept or silently drop it.

### The three mutations that matter most

Of the nine in the plan, these three carry the design. If you do only three, do
these — and if any of them passes against the mutation, the branch is not done.

1. **Task 1, remove `setLockTimeout(tx)`.** Proves the *bound* produced the
   outcome rather than the transaction budget. Without it the test would go green
   against a 10 s budget expiry too, and the whole point of this branch is that
   those are different things. The upper timing bound (`< 5_000`) is the assertion
   that catches it.
2. **Task 3, change `return 'busy' as const` to `return null`.** That function's
   promise `.catch()` already uses `null` to mean P2025 → `not_found`. This
   mutation proves the two sentinels are actually distinguished rather than
   collapsing into one answer — the failure mode being that a busy template gets
   reported as "not found", which is both wrong and reads as permanent.
3. **Task 4, remove the `isTransientDbError` branch.** This restores that
   function's pre-branch behaviour *exactly*, because it had no `catch` at all.
   If the test still passes, the catch you added is not on the path the error
   takes.

**A mutation must use a value the code under test cannot produce.** An earlier
branch mutated a helper to a constant `10.0.0.1`, which sat inside the range the
helper itself generates; it poisoned a live rate-limit bucket and resurfaced an
hour later as a 429 in an unrelated test. Nothing in this branch needs a fabricated
value — every mutation here is a deletion — but hold the instinct.

---

## Hazards that have actually bitten this project

Trimmed to what this branch can hit.

- **`npm run verify` before pushing.** Typecheck, lint, and all three vitest
  projects. It needs the app on :3000; without it you get a wall of
  `ECONNREFUSED`. Green verify is a strong signal but **not** a substitute for CI,
  which also runs `prisma validate`, a migration-drift check, `npm run build` and
  Playwright.
- **Never start or restart the dev server on :3000.** The user runs it, it serves
  this checkout, and the integration project talks to it over HTTP.
- **`@/lib/log` is pino and server-only.** Both lifecycle modules already import
  it and both carry a comment explaining why that is safe (no `'use client'`
  component value-imports anything in their chains). You are adding log calls to
  modules that already log — you are not extending that chain. Do not add the
  import anywhere else.
- **`@/lib/api-errors` and `@/lib/db-locks` are safe to import into services.**
  `api-errors` imports only `@prisma/client`; its own docblock says it lives where
  it does so services using it stay framework-agnostic.
- **Do not hand-list integration files.** This branch touches none. The sweep
  covers them; `npm run verify` runs all 28.
- **No migrations here.** This branch changes no schema. If you find yourself
  reaching for `prisma migrate`, you have gone off-plan.

---

## Baseline — measured, not inherited

Run against `fix/113-template-lock-race-reporting` at commit `2ab3ed0`, with
`npm run verify` green.

| Project | Files | Tests |
|---|---|---|
| unit | 51 | 728 passed + 2 todo = 730 |
| components | 37 | 202 passed |
| integration | 28 | 392 passed |

Both totals reconcile, and you should be able to re-derive them:

- Files: `51 + 37 + 28 = 116` — matches the full run's `Test Files 116 passed`.
- Tests: `728 + 202 + 392 = 1322` passed; `+ 2 todo = 1324` — matches
  `Tests 1322 passed | 2 todo (1324)`.

The 2 todo are the deadlock markers in `src/services/gdpr.test.ts`. They must
still be 2 when you finish.

**Predicted after this branch:** unit gains 3 tests (Task 1 re-points one, so it
is net zero; Tasks 2, 3 and 4 add one each). No new test files.

- unit `731 passed + 2 todo = 733`
- total `731 + 202 + 392 = 1325` passed, `1327` with todos
- files unchanged at `116`

**Measure it anyway and report the real figure.** An earlier handover predicted
1294 and the true number was 1296, because that branch's own review added tests
the prediction could not have known about. If your number differs, say why — a
difference you can explain is fine, a difference you cannot is a finding.

---

## What "done" looks like

1. Six commits on `fix/113-template-lock-race-reporting`, one per task, on top of
   the two that are already there.
2. `npm run verify` green, with the after-counts recorded.
3. `docs/superpowers/plans/2026-08-14-template-lock-race-reporting-mutations.md`
   exists and has a section per task, each with the **exact** error text each
   mutation produced — not a paraphrase.
4. The 2 `it.todo` markers still present.
5. Nothing staged that you did not name explicitly.

---

## What the PR body must record

Not a summary of the diff — the reviewer can read the diff. Record:

- **That the issue's headline premise was checked and found false**, with the
  evidence. This is the most useful thing in the PR, because a reviewer reading
  issue 113 will otherwise expect a status mapping and not find one.
- **Which inherited claims held.** Comment 1's widening to pause/resume held and
  was understated — one of those two functions has no error handling at all.
  Comment 2's create-route measurement held exactly.
- **The arithmetic, so a reader can re-derive it.** Baseline `51 + 37 + 28 = 116`
  files and `728 + 202 + 392 = 1322` passed, and the same sums after.
- **That `npm run verify` runs all three projects**, so a green verify *is* the
  whole integration suite — with the arithmetic that proves it. Do not write
  "integration is never run in full"; it is no longer true.
- **Which integration files this branch touched: none.** Say that plainly rather
  than listing files.
- **What it does not do:** it does not change `classifyApiError`, does not widen
  request logging to carry query parameters, does not close the `docs/lock-order.md`
  deadlock cycle, and ships Task 5 without a test (with the reason).
- **Your own errors**, if the plan was wrong anywhere.

**And in that "what it does not do" section, do not write the auto-close keyword
before an issue number.** That section is exactly where this trap fired before.
Write "issue 122 is unaffected".

---

## Report back

- The measured after-counts, per project, with the sums.
- Every mutation that did not behave as the plan predicted.
- Every plan step whose predicted output was wrong, and how you adjudicated it.
- Anything you found that is a real defect but out of scope — do not fix it, do
  not file it, just name it. Triage is not yours on this branch.

---

## Final checklist — one line per irreversible mistake

- [ ] No auto-close keyword immediately before an issue number, in any commit
      message or the PR body.
- [ ] The 5.5 s test was **re-pointed**, not deleted, and in the same commit as
      Task 1's bound.
- [ ] The two `it.todo` deadlock markers in `gdpr.test.ts` are untouched.
- [ ] `docs/lock-order.md` still says the deadlock cycle is open.
- [ ] No `git add -A` / `git add .`; every path staged explicitly and quoted where
      it contains parentheses.
- [ ] The dev server on :3000 was never started or restarted.
- [ ] No applied migration was edited (this branch should add none at all).
- [ ] Every mutation was restored, and the suite re-verified green after each.
- [ ] `npm run verify` green before pushing.
