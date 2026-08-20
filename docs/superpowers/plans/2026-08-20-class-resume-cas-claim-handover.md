# Handover: the class resume CAS and claim (issues 116, 117, 126)

You are picking up a branch that is designed, specified, planned and measured, but not
built. Everything below is what the plan cannot tell you: what will mislead you on the
way, and what to check before trusting anything.

**Branch:** `fix/116-resume-cas-claim`, off `main` at `eb8a76c`. Three commits on it,
all documentation. **Do not rebase or squash** — the PR is rebase-merged and the
commit-per-task history is the record.

---

## 1. Read these, in this order

| # | Document | What actually matters in it |
|---|---|---|
| 1 | `CLAUDE.md` (repo root) | "Development Principles" and "Class Lifecycle". Skim the rest. If your harness auto-loads `AGENTS.md`, note that it only *links* to `CLAUDE.md` — it is not a substitute, and reading only `AGENTS.md` leaves you without the stack, the data model and the design system. |
| 2 | `docs/superpowers/specs/2026-08-20-class-resume-cas-claim-design.md` | **§1 first, and do not skip it.** It is the record of which of the issue's claims are false. §2 is the design. §3.4 is the thing you are deliberately *not* fixing. |
| 3 | `docs/superpowers/plans/2026-08-20-class-resume-cas-claim.md` | All seven tasks, with the code. This is your working document. |
| 4 | `.claude/skills/solve-issue/SKILL.md` | §2 (counts), §3 (prove every guard bites), §4 (correct a claim in every artifact). The hazard list at the end. |

---

## 2. The derailers — read before touching anything

These are wrong turns the **correct** documents invite. Each is unrecoverable
mid-implementation, which is why they come before the first instruction.

### 2.1 The GitHub issue is wrong, and it reads convincingly

`gh issue view 116` describes a `P2002` hedge broken by a `25P02` that surfaces as a
500. **That mechanism does not exist.** #164/#192 removed the hedge; the generator now
ends in `createManyAndReturn({ skipDuplicates: true })` — a bare `ON CONFLICT DO
NOTHING` — and has no `catch` at all. If you go looking for the hedge you will not find
it, and if you "restore" one you will reintroduce the exact bug #164 was filed for.

The issue also carries a comment claiming four call sites drop the generator's count.
All four consume it. Build from the spec, not from the issue.

**The issue's remedy is still right.** A wrong diagnosis and a wrong remedy are
independent failures; this issue has one, not two.

### 2.2 The issue says "throw when the claim is null" — true only *after* the CAS

This is the single most dangerous sentence in the material, because it is correct in the
final state and catastrophic in the intermediate one.

With the CAS in place, a null claim is genuinely impossible and throwing is right. With
the plain `update` still there — i.e. if you do Task 3 before Task 2, or skip the CAS —
a raced archive makes null **legitimately reachable**, and the throw converts a correct
`archived` answer into a 500. **Task 2 before Task 3 is load-bearing, not preference.**

### 2.3 `t` is rebound between Task 2 and Task 3, and a comment names it

Task 2 introduces `const t = await tx.classTemplate.findUniqueOrThrow(…)` as a
placeholder. Task 3 deletes it and uses `claimed` instead. If you implement both in one
pass you will likely leave either a stale `t` or a redundant second read.

Worse: the ~30-line comment about `defaultTimezone` (currently at lines 881-909) says
*"`t.teacher.defaultTimezone`, not the `template.teacher` read at the top of this
function"*. After Task 3 its referent is `claimed.teacher`. A comment left naming `t`
is precisely the "header disagreeing with the declaration beneath it" failure that
`PauseTemplateResult`'s own docblock says caused #164 — in this same file. Do not leave
it.

Keep the paragraph beginning **"No test pins this, deliberately"** verbatim. It is still
true and it is the honest record of why there is no test.

### 2.4 Deleting the `P2025` branch will look like a regression. It is not.

Task 2 deletes `if (err.code === 'P2025') return null`. An existing test — "maps a
delete landing between the read and the write to not_found" — must still pass, but it
now reaches `not_found` through the CAS's miss classification instead. If you see that
test still green and assume nothing changed, you have not verified the path; if you see
it red, the miss branch's `!current` arm is wrong, not the test.

`pauseOrResumeStudioTemplate`'s catch already has no P2025 branch. You are converging on
it, not inventing something.

### 2.5 Line numbers drift after the first commit

Every line number in the plan was measured against `main`. Task 1 edits comments in the
same file Task 2 rewrites, so from Task 2 onward **re-`grep` for the anchor text rather
than trusting the number**. If a reference has drifted, fix it in the plan and say so in
your report — that correction is useful, not noise.

### 2.6 The un-archive fix needs no type change

An earlier draft of the spec called for splitting `unarchived` from `unchanged` on
`TemplateToggleResponse`. That was wrong and is corrected in §3.1. The studio type
carries the same collapsed `{ action: 'unarchived' | 'unchanged' }` arm and its resolver
still gives the two their own `case`s — TypeScript narrows a literal-union property
inside a single arm. If you find yourself editing that type, stop and re-read §3.1.

### 2.7 You are deliberately not fixing door 3

The room-archive race (spec §3.4, issue #272) is **measured, reachable, and out of
scope**. Task 6 marks it known-open and corrects a note that wrongly calls it latent.
Do not "while I'm here" it: closing it properly needs a lock on `TeacherRoom`, which
contradicts a decision `room-archive.ts:138-147` records explicitly.

---

## 3. Verify, don't assume

Run this block **before** you start. Every line was run on 2026-08-20 and produced the
output shown. If any disagrees, the repo has moved: fix the reference in the plan, and
report it.

```bash
git branch --show-current                        # → fix/116-resume-cas-claim
git log --oneline -1 origin/main                 # → eb8a76c docs: roadmap after #114 …

sed -n '871p' src/services/class-template-lifecycle.ts
#   → const t = await tx.classTemplate.update({          (Task 2 rewrites this)
sed -n '1199p' src/services/class-template-lifecycle.ts
#   → // This read takes a fresh READ COMMITTED snapshot and holds n…   (Task 1)
sed -n '850p' src/services/class-template-lifecycle.ts
#   → if (desiredActive && template.teacherRoom.isArchived) {           (Task 6)
sed -n '1239p' src/services/gdpr.ts
#   → // The `classTemplate.updateMany`/`studioClassTemplate.updateMany` b…  (Task 5)
sed -n '811p' src/services/studio-class-template-lifecycle.ts
#   → // of this comment asserts flatly that a missed CAS "holds no …    (Task 1)
sed -n '227p' src/components/settings/template-action-messages.ts
#   → export const UNARCHIVE_STUDIO_MESSAGE =                           (Task 4)
grep -n "LATENT, not live" src/services/class-generator.ts
#   → 365:  // LATENT, not live, and the distinction is the whole of why…  (Task 6)
grep -n "from './class-generator'" src/services/class-template-lifecycle.ts
#   → 43:import { generateInstancesForTemplate } from './class-generator';
#     Task 3 adds claimTemplateForGeneration to THIS import. Not a second one.

docker ps --format '{{.Names}}' | grep fairyoga-db-1     # → fairyoga-db-1
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/   # → 307
```

**The dev server on :3000 is not yours.** It serves this checkout and the integration
project talks to it over HTTP. Never start, restart or kill it. If it is down, say so
and stop — do not work around it.

---

## 4. Harness differences

You are not running under the skills system this plan was written in. Concretely:

- **No enforced TDD ordering.** The plan's step order *is* the enforcement. Write the
  test, run it, watch it fail, then implement. A test you never saw fail is not evidence.
- **Mutations are deliverables, not a private check.** Each one goes into
  `docs/superpowers/plans/2026-08-20-class-resume-cas-claim-mutations.md` — created at
  Task 2 Step 12 — with the diff applied, the command run, and the **verbatim** failure
  output. A mutation you did not record did not happen.
- **Commit per task**, with the message given in the task's final step. The PR is
  rebase-merged; do not squash, do not amend across tasks.
- **No subagent review between tasks.** You are both implementer and first reviewer, so
  the mutation records are the only external evidence anyone gets. Weight them
  accordingly.
- **Surface plan defects rather than bending code to match them.** The plan has been
  wrong once already on this branch — its lock probe could not fail (see §6). If an
  instruction looks wrong, say so with your reasoning; do not quietly comply and do not
  quietly skip.

---

## 5. Task order, and which constraints are load-bearing

| Task | Order is… | Why |
|---|---|---|
| 1 — #117 comment | **load-bearing, first** | Task 2 adds a *second* zero-count CAS branch to this file. It must be born carrying the corrected reasoning, not copy the wrong sentence next door. |
| 2 — the CAS | **load-bearing, before 3** | See §2.2. The CAS is what makes Task 3's throw correct instead of a 500. |
| 3 — the claim | **load-bearing, after 2** | Same. |
| 4 — un-archive copy | free | Touches only `template-action-messages.*`. Do it whenever. |
| 5 — #126 gdpr | **load-bearing, after 3** | The sentence it corrects also names *which* resumes take the claim, and Task 3 changes that answer. Doing it early means writing it twice. |
| 6 — door 3 note | free, but after 2 | Sits beside code Task 2 does not touch, but its wording says the template's own race *is* closed — which is only true once Task 2 lands. |
| 7 — verification | last | — |

---

## 6. Stop conditions

Stop and report rather than pressing on if any of these happen.

**The three mutations that matter most.** These are the ones where a wrong
implementation still looks right:

1. **Drop `isArchived: false` from the CAS `where`** (Task 2 Step 12). The archive-race
   test must fail. If it passes, your test is asserting the refusal but not the
   *state* — check that it also asserts `isActive === false` and zero classes. This is
   the branch's whole reason for existing; a green test here proves nothing on its own.

2. **Swap the two checks in the miss branch** (Task 2 Step 14). The order test must
   fail with a plain pause answered `archived`. Only the pause direction can tell the
   orderings apart — a resume falls through either way — so if you wrote the test with
   `'active'` it cannot fail and must be rewritten.

3. **Remove the `claimTemplateForGeneration` call** (Task 3 Step 5). The lock test must
   fail. **The plan already got this wrong once**: it originally specified a
   `FOR UPDATE NOWAIT` probe, which is refused whether or not the claim is held, because
   the CAS alone holds `FOR NO KEY UPDATE` and that already conflicts with `FOR UPDATE`.
   The probe is now `FOR KEY SHARE NOWAIT`. **Superseded — no probe survives.**
   The conflict table below is correct and was re-verified in PR review, but a
   `NOWAIT` probe interposed on the generator's own queries turned out not to
   be a usable harness for it; the guard is a race test instead
   (`blocks a concurrent Class insert while generating, and answers busy`).
   See the mutation ledger's Task 3 section for what was and was not
   established about why. Measured, all four cells, against
   `ethical_yoga_test` on 2026-08-20:

   | holder | probe | result |
   |---|---|---|
   | `FOR NO KEY UPDATE` | `FOR KEY SHARE NOWAIT` | **GRANTED** |
   | `FOR UPDATE` | `FOR KEY SHARE NOWAIT` | **REFUSED** (`55P03`) |
   | `FOR NO KEY UPDATE` | `FOR UPDATE NOWAIT` | REFUSED |
   | `FOR UPDATE` | `FOR UPDATE NOWAIT` | REFUSED |

   If the mutation does not make the test fail, **delete the test and report it**. Do
   not weaken the assertion to make it pass. A guard that cannot fail certifies nothing.

**Other stop conditions:**

- `npm run verify` cannot run because :3000 is down → stop, say so.
- The archive-race test (Task 2 Step 2) **passes before the fix** → stop. It is not
  driving the window and nothing after it is worth building.
- A task's expected output disagrees with reality in a way you cannot explain → stop and
  report, with what you actually saw. Four wrong predicted outputs have been caught this
  way on previous branches; that is the system working.

---

## 7. Hazards this branch can actually hit

Trimmed from the project's list to what is reachable here.

- **`npm run verify` before pushing** — typecheck, lint, and all three vitest projects.
  It needs :3000. Green `verify` is strong but **not** a substitute for CI: CI also runs
  `prisma validate`, a migration-drift check, `npm run build` and Playwright, so a
  build-only defect passes `verify` and fails CI.
- **Single files are the fast inner loop**: `npx vitest run <path> -t '<name>'`.
- **Never `git add -A` or `git add .`** — stage the exact paths in each task's commit
  step. Quote paths containing parentheses; none in this branch, but the habit matters.
- **Never write `close`/`fixes`/`resolves` immediately before `#N`** in a commit message
  or PR body. GitHub's parser matches it and does not understand a negation in front —
  a PR body saying it did *not* [keyword] issue 113 closed issue 113. Write
  "**#N is unaffected**". And when *explaining* the trap, break the token rather than
  quoting it; a commit written to document this fired it again five minutes later.
- **`@/lib/log` is pino and server-only.** Task 4 touches
  `template-action-messages.ts`, which SIX client components value-import
  (`template-form`, `studio-template-form`, `toggle-template-button`,
  `toggle-studio-template-button`, `archive-template-button`,
  `archive-studio-template-button`) — this line said four until PR review
  re-counted it, six lines above this file's own "a grep with a `head` limit
  is not a count". Measured
  2026-08-20, it has exactly two imports: `formatDayHeader` from `@/lib/format` (a pure,
  import-free module chosen for this reason) and an `import type` from
  `@/services/class-template-lifecycle` — which is safe *because* it erases completely.
  Task 4 needs neither a new module nor a logger; if you reach for one, check the whole
  transitive chain first.
- **A grep with a `head` limit is not a count.** If you report a number, show the
  arithmetic so a reader can re-derive it.
- **The suite is re-runnable.** Every rate-limited request carries its own
  `x-forwarded-for` via `freshIp()` in `tests/helpers.ts`, so re-running costs nothing.
- **No migration in this branch.** If you find yourself writing one, you have gone out
  of scope — that is issue #272's business.

---

## 8. Baseline, done, and what to report

### Measured baseline

Run on `main` at `eb8a76c`, 2026-08-20, via `npm test` (227s):

| Project | Files | Tests |
|---|---|---|
| `unit` | 63 | 947 |
| `components` | 41 | 242 |
| `integration` | 31 | 445 |
| **Total** | **135** | **1634** |

Arithmetic: `63 + 41 + 31 = 135` files, `947 + 242 + 445 = 1634` tests. Both reconcile
against the single-run totals, so you can re-derive them rather than take them.

**Predicted after: 1640** — Task 2 adds 3, Task 3 adds 1, Task 4 adds 2. **Measure it
anyway and report the real figure.** A previous branch predicted 1294 and measured
1296, because that branch's own review added tests the prediction could not have known
about. If Task 3's lock test has to be deleted (§6), the figure is 1639 — say which.

### Runs vs changes

This branch **changes** no file under `tests/integration/`. It **runs** all 31 of them,
because `npm run verify` runs all three vitest projects. State it that way in the PR
body; do not claim the integration suite was untouched *and* unrun, and do not
hand-list integration files.

### Done looks like

- All seven tasks committed, one commit each, messages as given.
- `npm run verify` green, with the after-figure measured and reconciled.
- The mutations file exists and has a section per mutation with verbatim output.
- Every claim in the plan's Task 7 Step 3 table has moved at **every** listed location —
  a finding that names N locations gets N verdicts, not one.
- The sweep in Task 7 Step 3 derived from `git diff --stat main...HEAD`, reconciling
  files-changed against files-the-plan-said-to-change. A keyword sweep scoped to one
  claim cannot see another claim's twin.

### The PR body must record

- Which of issue 116's inherited claims were checked, which held, and which did not —
  the `P2002`/`25P02` premise and the count census both failed (spec §1.1, §1.2).
- The arithmetic behind every number, including `135 = 63 + 41 + 31`.
- Which suites ran. `npm run verify` runs all three projects, so a green run **is** the
  whole integration suite — say so with the arithmetic that proves it, rather than
  repeating the older and now-false line that integration is never run in full.
- What the branch does **not** do: door 3 stays open (#272); **#229 is unaffected**; no
  migration.
- Your own errors, if any. They are the most useful part.

### Report back

The commit range, the measured after-figure with its arithmetic, the mutation records,
any plan defect you found and how you adjudicated it, and anything you had to leave
undone with the reason. If a stop condition fired, that report *is* the deliverable —
do not press past one to have something to show.

---

## 9. Final checklist — one line per irreversible mistake

- [ ] I did **not** start, restart or kill the dev server on :3000.
- [ ] I did **not** rebase, squash or amend across tasks.
- [ ] I did **not** `git add -A` or `git add .`.
- [ ] I did **not** write `close`/`fixes`/`resolves` immediately before a `#N`.
- [ ] I did **not** edit an applied migration, or add one.
- [ ] I did Task 2 **before** Task 3, so the claim's throw is guarded by the CAS.
- [ ] I saw every new test **fail** before I made it pass.
- [ ] Every mutation is recorded with its verbatim output, or reported as unable to fail.
- [ ] The `defaultTimezone` comment names `claimed.teacher`, not `t.teacher`.
- [ ] I measured the after-figure rather than copying the prediction.
