---
name: solve-issue
description: End-to-end process for taking a fair.yoga GitHub issue from cold start to merged PR — verify premise, brainstorm, spec (for difficult issues), plan, subagent build, multi-agent PR review, rebase-merge. Invoke as /solve-issue <issue-number>. Designed to run from an empty context.
---

# Solving a fair.yoga issue

**Assume no prior context.** Invoked cold, one issue per session, to keep token cost bounded.

`docs/solve-issue-lessons.md` carries the issue-by-issue evidence behind every rule below —
this file states the rule, that one names the past issue that proves it.

## Start here

```bash
gh issue view <N>                                  # the issue, and its comments
gh issue view <N> --json body -q .body | grep -oE '#[0-9]+'   # issues it references
git log --oneline -10                              # what landed recently
```

CLAUDE.md loads automatically and carries the stack, the data model, the design system —
trust it over your own recall. Then check for prior art: `ls docs/superpowers/specs/` and
`docs/superpowers/plans/` — a closed neighbour's spec often states the rule you're about to
rediscover.

## The arc, and the gates

```
verify the issue's premise
  → superpowers:brainstorming → [GATE] direction agreed
  → [GATE] spec needed? — difficult issues only, see below
      → spec to docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md → [GATE] spec reviewed
  → superpowers:writing-plans → docs/superpowers/plans/YYYY-MM-DD-<topic>.md
  → [GATE] plan reviewed
  → superpowers:subagent-driven-development (§5: task → review → fix loop)
  → [2+ tasks only] whole-branch review → one fix wave → one scoped re-review
  → push + PR → [GATE] /pr-review-toolkit:review-pr <N>
  → aggregate → fold, file, or let go (§7) → [GATE] rebase-merge
```

**The spec step is gated, not automatic** — write one only for a genuinely difficult issue:
more than one subsystem, more than one reasonable design, a changed invariant or data model,
or anything touching money, auth, or shared/concurrent state. A single-file fix with one
obvious approach can go straight from the brainstorming gate to the plan; default to writing
the spec when genuinely unsure.

**Write the plan's content tool-agnostic.** `superpowers:writing-plans` is fine to invoke —
but describe each task in terms of files, behavior, and tests, never a specific tool call
("use the Edit tool to…", "dispatch via Task"). A plan that only speaks in this harness's
tool names is unreadable by a human skimming it later, or by whatever actually builds it.

**Never skip a gate** — the user's answers change the design at every one of them, not just
confirm it (`docs/solve-issue-lessons.md#gates`). Present real options, with a recommendation
and the trade-off: "Does this look right?" wastes a turn, "A or B, I'd take A because X"
gets a decision.

## Protecting the context this skill exists to save

- **Hand artifacts to subagents as file paths, never pasted text** — anything pasted into a
  dispatch stays resident and is re-read every turn. The SDD scripts (`task-brief`,
  `review-package`) write files precisely for this.
- **Never read a subagent's raw transcript** — read its report file instead, and delegate
  reading-heavy sweeps entirely; you want the conclusion, not the file dumps.
- **Read the section, not the file** — `grep -n` for the line, then `Read` with
  `offset`/`limit`.
- **The SDD ledger is what survives compaction** — trust it and `git log` over recollection.

## 1. Verify the issue's premise before designing on it

**Every issue worked so far has had a premise that was wrong or incomplete.** This is the
highest-value step, and belongs before the brainstorm, not after.

Sweep and classify the whole surface first — write what you measured, not what the issue
said. Where an issue proposes a check, read `.github/workflows/ci.yml` first: building a
second copy of an existing gate is the expensive failure here, and it looks like progress.
Where the issue is wrong, say so in the spec — that correction is often the most useful
thing in it. Sometimes the premise holds; check anyway, and say so.

→ `docs/solve-issue-lessons.md#1-verify-the-premise`

## 2. Counts are where this project's errors live

Every wrong number so far came from a method that structurally could not produce it — a
`grep | head` reported as a census, a key-name grep blind to a rest-spread. **A grep with a
head/tail limit is not a count.**

Show the arithmetic so a reader can re-derive it (`48 DateTime − 3 @db.Date = 45, minus the
one being fixed = 44`). Prose that counts goes stale; prose that explains why does not.
Naming members instead of counting them is the right instinct and still isn't durable — only
a compiler tether is (*Comment Discipline*, CLAUDE.md).

**Decide where a number lives before you write it** — the spec, the PR body, `docs/`, where
it has an owner and ships with its re-derivation command, never a docblock, where the edit
that invalidates it happens in another file.

→ `docs/solve-issue-lessons.md#2-counts`

## 3. Prove every guard bites

A pin that compiles but cannot fail certifies nothing. **Break it, record the exact error
text, restore, re-verify** — put this in the plan as an explicit step, per guard.

- **Ask whether a verification could have failed at all** — a check run at the wrong moment
  can pass while proving nothing.
- **Break it the way it actually broke**, not the way that's convenient — a guard proven
  against one mutation can still be blind to the realistic regression.
- **A mutation must use a value the code under test cannot produce** — a constant inside the
  code's own generated range can poison live state instead of just failing a test; reach for
  a reserved value (`203.0.113.0/24`, RFC 5737, for addresses).
- **A diagnosis has to survive arithmetic, not just sound right** — a mechanism explaining
  the *shape* of a symptom is a hypothesis; one whose numbers close is a diagnosis.

→ `docs/solve-issue-lessons.md#3-prove-every-guard-bites`

## 4. Correct a claim in every artifact, not just the one in front of you

A fix repeatedly lands in one place while its twin stands: spec but not plan, code but not
the PR body. Once a claim is wrong, `grep` the phrase across **spec, plan, source, tests, PR
body, and the GitHub issue** — live reference docs included — before calling it fixed.

Knowing the goal isn't enough; two mechanical checks make it verifiable:

- **A finding naming N locations gets N verdicts, not one** — enumerate them in the dispatch
  and require the verdict to name each. **A fix wave's own report is not evidence**;
  reconcile against the diff.
- **Derive the post-fix sweep from the wave's diff, not a keyword** — list what changed, list
  what was *supposed* to change, reconcile the two. A keyword sweep scoped to one finding
  cannot see another finding's twin.

**Correct a claim by replacing it, not annotating it** — "this previously read X" turns one
stale sentence into two. The before-and-after belongs in the PR body; the comment carries
only what is true now.

**Sweep for what you invalidated, not what you edited.** After deleting a database object, a
type, an error code, or a function, grep for the names you removed — a sweep keyed on
changed call sites misses stale references to what went. Give every hit a verdict; expect
legitimate survivors.

**A grep finds a stale NAME, never a stale DESCRIPTION** — where a change alters what
something *is* rather than what it's *called*, the sweep means reading whole docblocks in
the touched functions.

→ `docs/solve-issue-lessons.md#4-correct-a-claim-everywhere`

## 5. Build with subagents, then review at both levels

Use `superpowers:subagent-driven-development`. Per task: brief → implementer → review (spec
compliance **and** quality) → fix loop.

**Then, only if the plan has 2+ tasks: one whole-branch review on the most capable model, one
fix wave, one scoped re-review.** Its whole reason to exist is cross-task blindness — task
reviewers see only their own diff, so a pin certifying a type nothing connects to, or a
policy applied consistently within a task but wrong across two, is invisible to them. For a
single-task plan the "whole branch" is that one task's diff, already reviewed — a second pass
over identical content can't catch what this review exists to catch, so skip it.

**Task order can be load-bearing** — say so in the plan and dispatch when it matters.

Let subagents surface plan defects rather than bend code to a wrong instruction; adjudicate
what they surface in the ledger with reasoning, never quietly accept or drop it.

→ `docs/solve-issue-lessons.md#5-build`

## 6. PR review: specialised agents in parallel

`/pr-review-toolkit:review-pr <N>` — code, tests, comments, silent-failure, and type-design
*when the PR's subject is actually a type* (skip it for a props interface).

Give each reviewer the specific risk to chase, not a generic ask — state already-verified
facts so they don't re-derive them, but **never** tell a reviewer what to conclude or not
flag. For the comments reviewer: claims reaching past the file they sit in, prose counts and
rosters, correction history that belonged in the PR body.

Aggregate into one Critical / Important / Suggestions list, adjudicating false positives
yourself with evidence. Say plainly which findings are your own errors.

## 7. Fold, file, or let it go — and the default is let it go

**The floor: a defect a user will actually hit is fixed or filed, every time**, regardless of
the tests below — a wrong price, a broken booking, a 500 on a real page, data a user can
lose, an inaccessible control. A pre-existing bug found in passing is still not someone
else's problem.

**"Will hit", not "could hit" — name what blocks it.** Write the concrete path before
judging it; a path needing a state this system cannot produce is not a live defect, and gets
declined like a false positive, path and blocking condition named. A narrow route is still a
route — reachability is the test, not rarity.

A live bug or something someone is currently worse off for is always in that first bucket —
everything below governs everything else: debt, taste, coverage gaps, design questions,
true-but-costs-nobody observations.

**For everything else: three outcomes, not two.** "Fold or file" quietly makes filing the
default for anything not trivially foldable — a tracker that grows faster than it drains
stops being a plan. Before filing a non-defect finding, all four must hold:

1. **Would a future maintainer be materially worse off if this were never written down?**
   Most findings are true; would the absence cost real time or a mistake.
2. **Is it a leaf?** A finding needing a design decision first will spin out its own three —
   resolve it now, or file it *as* a decision with options laid out, not as work.
3. **Did this change make it worse, or merely visible?** Debt noticed in passing usually
   isn't this issue's spin-out — **except a live bug**, still a defect someone will hit.
4. **Can it attach to something that already exists?** Prefer extending a live issue.

**A reviewer mentioning something is not a reason to file it** — five specialised agents
produce dozens of observations, most taste, some wrong. Triage is your job.

**Sometimes the right home is a comment, not the tracker** — a gap the next reader needs at
the moment they touch that code, or an unfixed-but-reachable defect marked `known-open`
beside it. The gap must be about the code it sits beside; one about another module goes in
`docs/` instead, with a link.

**Watch the ratio** — one issue in, one leaf filed out is healthy; more needs a stated reason.

File with the rigour of a spec — measured, ruled out, acceptance criteria — so it still
makes sense months later.

→ `docs/solve-issue-lessons.md#7-fold-file-or-let-go`

## 8. Finish

Rebase-merge, **never squash** — the commit-per-task history is the record.

**Then verify the closure, don't trust the merge.** Run `gh issue view <n> --json state` for
the issue this PR was meant to close, and for any other issue number named in the PR body or
commit messages. Don't read a status back from anywhere else — a wrong or accidental closure
(see the hazard list) only shows up by checking the issue itself. Reopen with an explanation
rather than leaving it silently wrong.

→ `docs/solve-issue-lessons.md#8-finish`

## Project hazards that have actually bitten

- **Run `npm run verify` before pushing** — typecheck, lint, and the whole suite, needing the
  app live on :3000. Green `verify` is strong but **not** a CI substitute: CI also runs
  `prisma validate`, a migration-drift check, `npm run build`, and Playwright, so a
  build-only defect can pass `verify` and fail CI. Fast inner loop:
  `npx vitest run --project integration <path>`.
- **Do not hand-list integration files in a plan** — the sweep covers them, and the suite is
  cheap to re-run (`freshIp()` in `tests/helpers.ts` gives every request its own
  `x-forwarded-for`). Name a file only when its order matters.
- **Never kill or restart the dev server on :3000, for any reason — check first** (the
  `verify` skill's launch recipe). If it's already running, it's the user's, hot-reloading
  their uncommitted edits, and integration tests need it live. An env var it lacks or a
  stale build is not a reason to touch it — work around it (`verify` skill) or ask the
  user. Start one yourself only if it's genuinely absent.
- **In a worktree, integration and e2e run against the worktree's own isolated
  app, not `:3000`.** Run `npm run worktree:setup` once, then `npm run
  worktree:up` before `--project integration` or `playwright test` — both
  read `INTEGRATION_BASE_URL` automatically. `npm run worktree:down` stops
  the dev server when done; forgetting it is not a resource leak, an
  opportunistic reap on the next `npm test` anywhere cleans it up.
  `docs/superpowers/specs/2026-09-08-worktree-db-isolation-design.md` has
  the mechanism.
- **`@/lib/log` is pino and server-only** — check the whole transitive import chain before it
  reaches a `'use client'` component; `import type` is safe, it erases completely.
- **Quote paths with parentheses when staging** — `(public)`, `(teacher)`, `(student)`; an
  unquoted variable over one silently matches nothing.
- **Migrations:** hand-author CHECK constraints (Prisma can't express them) following
  `prisma/migrations/20260721061528_student_claim_link_check/`. Never edit an applied
  migration, **comment-only edits included** — the checksum changes while
  `prisma migrate status` compares only names, so nothing catches it until the next
  `prisma migrate dev` demands a reset. `prisma db execute` swallows `RAISE NOTICE` but
  surfaces `RAISE EXCEPTION`; use `psql` in the `fairyoga-db-1` container to see a notice.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Never write "does not close #N"**, and never quote that phrase either — GitHub's
  auto-close parser matches `close`/`fixes`/`fixed`/`resolves`/`resolved`/`closed` `#N`
  regardless of a leading negation or surrounding quotes. Write "**#N is unaffected**"; to
  reference the trap, break the token (`\[keyword] #113`) rather than quote it.
- **Post `gh issue`/`gh pr` prose from a `--body-file`, never `--body "…"`** — backticks in a
  double-quoted shell string reach zsh as command substitution even escaped, and fail
  *silently*. Write markdown to a scratchpad file and pass the path.
- **Warm routes before scoring mutations** — `next dev` recompiles lazily, and the first
  request's compilation time can blow a timeout that reads exactly like an assertion
  failure. Curl the touched route(s) after applying a mutation, before judging RED/GREEN.
- Recipes for driving the running app (auth without email, Playwright, seed data) live in the
  `verify` skill.

→ `docs/solve-issue-lessons.md#project-hazards`

## The PR body

Record what was measured and where the errors were, including your own, and what a comment
used to say where you corrected one — that record lives here, not beside the code. State
which inherited claims held; show the arithmetic behind every number; name what the PR does
*not* do (as "**#N is unaffected**", never "does not close #N" — see the hazard list); name
by path which `integration` files this branch touched — a worktree can run that tier locally
now (see the hazard list); cite whichever run you actually have, local or CI's.

**A green `npm run verify` is the whole integration suite**, since it runs every vitest
project — say so with the arithmetic that proves it (`105 = 46 unit + 32 components + 27
integration`).

**The word "green" is load-bearing.** `npm test` chains two invocations with `&&`; one red
unit test means the second (`unit-sweeps`+`integration`) never runs, and `integration`
reports *nothing*, not zero failures. While anything earlier is failing, run
`npx vitest run --project integration` directly rather than reading a red `verify` as
evidence about that tier.

→ `docs/solve-issue-lessons.md#the-pr-body`
