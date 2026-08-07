---
name: solve-issue
description: End-to-end process for taking a fair.yoga GitHub issue from cold start to merged PR — verify premise, brainstorm, spec, plan, subagent build, multi-agent PR review, rebase-merge, roadmap. Invoke as /solve-issue <issue-number>. Designed to run from an empty context.
---

# Solving a fair.yoga issue

**Assume no prior context.** This skill is invoked cold, one issue per session, to keep
token cost bounded. Everything you need is below or reachable from it — do not assume you
remember earlier work, and do not ask the user to re-explain the process.

## Start here

```bash
gh issue view <N>                                  # the issue, and its comments
gh issue view <N> --json body -q .body | grep -oE '#[0-9]+'   # issues it references
grep -n "#<N>" docs/backlog-roadmap.md             # its bundle, and why it is sequenced where it is
git log --oneline -10                              # what landed recently
```

`docs/backlog-roadmap.md` is untracked and local. It is the map: it records which bundle the
issue belongs to, what it is blocked on, what spun it out, and — in the entries for closed
issues — what went wrong last time in that area. Read the surrounding bundle, not just the
one line.

CLAUDE.md loads automatically and carries the stack, the data model, and the design system.
Trust it over your own recall.

Then check for prior art on the same surface: `ls docs/superpowers/specs/` and
`docs/superpowers/plans/` — a closed neighbour's spec often states the rule you are about to
rediscover.

## The arc, and the gates

```
verify the issue's premise
  → superpowers:brainstorming → [GATE] direction agreed
  → spec to docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
  → [GATE] user reviews the written spec
  → superpowers:writing-plans → docs/superpowers/plans/YYYY-MM-DD-<topic>.md
  → [GATE] user reviews the plan
  → superpowers:subagent-driven-development (task → review → fix loop)
  → whole-branch review → one fix wave → one scoped re-review
  → push + PR → [GATE] /pr-review-toolkit:review-pr <N>
  → aggregate → fold, file, or let go (§7) → [GATE] rebase-merge
  → update docs/backlog-roadmap.md (never commit it)
```

**Never skip a gate.** The user's answers have changed the design at every one of them —
on #39 the decision to enforce the range in PostgreSQL, not only TypeScript, came from a gate
question and reshaped the whole branch.

Present real options at a gate, with a recommendation and the trade-off. "Does this look
right?" wastes a turn; "A or B, I'd take A because X" gets a decision.

## Protecting the context this skill exists to save

- **Hand artifacts to subagents as file paths, never pasted text.** Anything you paste into a
  dispatch stays resident for the rest of the session and is re-read every turn. The SDD
  scripts (`task-brief`, `review-package`) write files precisely for this.
- **Never read a subagent's raw transcript file.** Read its report file instead.
- **Delegate reading-heavy sweeps.** A census across many files is a subagent's job; you want
  its conclusion, not the file dumps.
- **Read the section, not the file.** Use `grep -n` to find the line, then `Read` with
  `offset`/`limit`.
- **The SDD ledger is what survives compaction.** Trust it and `git log` over recollection.

## 1. Verify the issue's premise before designing on it

**Every issue worked so far has had a premise that was wrong or incomplete.** This is the
highest-value step in the process, and it belongs before the brainstorm, not after.

- #136 named "eight instances"; a census found twelve, including four the issue missed.
- #39 said an out-of-range tier was "caught only by a runtime throw" — the Zod schema already
  bounded the one route that accepts one.
- #39 also claimed a restructure makes the `arr[i]!` pattern "disappear". It doesn't —
  indexing is still `T | undefined` under `noUncheckedIndexedAccess`. *Iterating* removes it.
- #96 inherited a "byte-identical" claim from an earlier PR that was false.
- #140's "the fix is one line" **did** hold. Check anyway, and say so when it holds.

Sweep and classify the whole surface first. Write what you measured, not what the issue said.
Where the issue is wrong, say so in the spec — that correction is often the most useful thing
in it.

## 2. Counts are where this project's errors live

Every wrong number so far came from a method that structurally could not produce it:

- `grep … | head -24` reported as a census. **A grep with a head/tail limit is not a count.**
- A grep for key names cannot see `const { date, ...rest }` — that is how #148 stayed hidden.
- `\.studentPrices\[` requires a leading dot, so it cannot see a local `studentPrices[i]!`.
- Counting one test per *file* and reporting it as a test count.
- Conflating "9 call sites" with "9 display sites plus 1 billing site".

Rules: show the arithmetic so a reader can re-derive it (`48 DateTime − 3 @db.Date = 45,
minus the one being fixed = 44`). Prefer naming call sites over counting them. Prose that
counts goes stale; prose that explains why does not.

## 3. Prove every guard bites

A pin that compiles but cannot fail certifies nothing. A test that passes against the bug
proves nothing. **Break it, record the exact error text, restore, re-verify.** Put this in
the plan as an explicit step, per guard.

#39 shipped three guards that existed and could not fail, all caught only at PR review: a
`satisfies` clause that pinned membership but not completeness (`[1,2,3,4]` compiled clean);
nine pinned prices that could not detect a tie-break flip (every tie was a complete pair, so
reversing it moved nothing); and a throwing helper whose call site could be reverted to the
degrading one without breaking a single test.

Separately, **ask whether a verification could have failed at all.** On #138 a manual check
ran at a UTC hour when both code paths rendered identically — a pass that proved nothing.
`prisma/seed.ts` carries a comment warning about exactly that window.

## 4. Correct a claim in every artifact, not just the one in front of you

Repeatedly a fix landed in one place while its twin stood: spec but not plan, source but not
test, code but not the PR body, chat but not the docblock. Once a claim is wrong, `grep` the
phrase across **spec, plan, source, tests, PR body, and the GitHub issue** before calling it
fixed. Live reference docs count — `docs/technical-architecture.md` is listed in CLAUDE.md
and went stale on #39 because a field it documented was deleted.

## 5. Build with subagents; review at both levels

Use `superpowers:subagent-driven-development`. Per task: brief → implementer → review (spec
compliance **and** quality) → fix loop. Then one whole-branch review on the most capable
model, then one fix wave, then one scoped re-review.

**The whole-branch review is not a formality.** Task reviewers see only their own diff, so an
entire class of defect is invisible to them:

- #136: four forms whose pins certified a type nothing connected to the sent body — the very
  defect the issue existed to remove, one level up.
- #39: an assertion count that was right per-task and wrong for the branch.
- #39: a policy chosen for one call site that a later task silently applied to a second one
  with opposite stakes.

**Task order can be load-bearing.** On #39 an integration test had to be re-pointed *before*
a CHECK constraint landed, because the constraint made its failure injection unwritable. When
order matters, say so in the plan and in the dispatch.

Let subagents surface plan defects rather than bending code to match a wrong instruction —
they caught four wrong predicted outputs that way. When one does, adjudicate it in the ledger
with reasoning; never quietly accept or quietly drop it.

## 6. PR review: specialised agents in parallel

`/pr-review-toolkit:review-pr <N>` — code, tests, comments, silent-failure, and type-design
*when the PR's subject is actually a type*. Skip type-design for a props interface; run it
when a type and its invariants are the point.

Give each reviewer the specific risk to chase, not a generic ask. State already-verified facts
so they don't re-derive them — but **never** tell a reviewer what to conclude or what not to
flag. Adjudicate false positives yourself, with evidence, in the aggregate.

Aggregate into one Critical / Important / Suggestions list. Say plainly which findings are
your own errors.

## 7. Fold, file, or let it go — and the default is let it go

**First, the floor: a defect a user will actually hit is fixed or filed, every time.**
No test below applies to it. Not "is it a leaf", not "did this change make it worse", not
"does it attach to something existing" — if a teacher or a student will encounter it, it
gets recorded. A wrong price, a broken booking, a 500 on a real page, data a user can lose,
an accessible name a screen-reader user cannot act on. Discovering a pre-existing bug in
passing does not make it someone else's problem; the person hitting it does not care which
PR was open when it was found.

The roadmap already draws this line — it tracks "live bugs, not just cleanup" and
"someone is currently worse off" separately from everything else. Everything below governs
that *everything else*: debt, taste, coverage gaps, design questions, and observations that
are true but may cost nobody anything.

**Then, for review findings: three outcomes, not two.** "Fold or file" quietly makes filing
the default for anything not trivially foldable, and that is how a backlog compounds. #86
closed one issue and spun out eight. This process finds far more than it fixes, which is a
property of reviewing well — but a tracker that grows faster than it drains stops being a
plan and becomes a graveyard.

Before filing a non-defect finding, all four must hold:

1. **Would a future maintainer be materially worse off if this were never written down?**
   Not "is it true" — most review findings are true. Would its absence cost someone real time
   or a real mistake.
2. **Is it a leaf?** If the issue needs a design decision before anyone can start, it will
   spin out its own three. Either resolve the decision now with the user, or file it *as* a
   decision with the options laid out — not as work.
3. **Did this change make it worse, or merely make it visible?** Pre-existing *debt* you
   noticed while passing through is usually not this issue's spin-out. `prisma/seed.ts`
   hard-coding the tier ratios was visible from #39 and is not #39's problem. Filing it
   because you happened to see it inflates the ratio for no gain. **This test never applies
   to a live bug** — a pre-existing defect is still a defect someone will hit.
4. **Can it attach to something that already exists?** Prefer extending — #143 absorbed an
   e2e coverage finding rather than spawning a fourth coverage issue. Adding an "Update" to a
   live issue keeps it in one place with its history.

**A reviewer mentioning something is not a reason to file it.** Five specialised agents will
produce dozens of observations; most are taste, several are wrong, and triage is your job,
not theirs. Reject false positives with evidence and say so.

**Sometimes the right home is a comment, not the tracker.** A gap that a future reader needs
to know about *at the moment they touch that code* belongs beside the code — #128's
accessible-name gap is pointed at from beside the button it describes. An issue nobody
opens is worse than a comment everybody reads.

**Watch the ratio.** Note in the roadmap how many issues a round closed and how many it
opened. One in, one leaf out is healthy. One in, three out needs a reason stated out loud.
One in, eight out means the review found a genuinely under-explored area — say that, rather
than letting the count pass as normal.

When you do file, do it with the same rigour as a spec: what was measured, what was ruled
out, what acceptance looks like. Issues filed that way still make sense months later.

## 8. Finish

Rebase-merge, **never squash** — the commit-per-task history is the record. Then update
`docs/backlog-roadmap.md`: mark the issue done with what was actually learned (not a
restatement of the issue), add anything spun out, re-check the open count against
`gh issue list`, and leave the file untracked.

## Project hazards that have actually bitten

- **Run `npm run verify` before pushing** — typecheck, lint, and the whole suite including
  every file in `tests/integration/`. Per-diff review cannot see a defect that exists only
  in the union of several diffs, which is how #170 shipped both a dark test file and a red
  lint to a pushed branch past nine reviews. This is the same whole-tree check CI runs, one
  round-trip earlier. Single files by explicit path
  (`npx vitest run --project integration <path>`) remain the fast inner loop.
- **Do not hand-list integration files in a plan.** That habit is what left 20 of 26
  unobserved on #170. The sweep covers them; name a file only when its *order* matters.
  The suite is re-runnable — every rate-limited request carries its own `x-forwarded-for`
  via `freshIp()` in `tests/helpers.ts` — so running it costs nothing you need back.
- **Never start or restart the dev server on :3000.** The user runs it; it serves this
  checkout, and integration tests need it live.
- **`@/lib/log` is pino and server-only.** Before importing into a module that a `'use client'`
  component value-imports, check the whole transitive chain. `src/lib/tiers.ts` and
  `src/lib/class-fields.ts` are import-free modules for exactly this reason; `import type` is
  safe because it erases completely.
- **Quote paths containing parentheses when staging** — `(public)`, `(teacher)`, `(student)`.
  An unquoted variable over one of these silently matches nothing.
- **Migrations:** Prisma cannot express CHECK constraints, so hand-author them following
  `prisma/migrations/20260721061528_student_claim_link_check/`. Never edit an applied
  migration. `prisma db execute` swallows `RAISE NOTICE` but does surface `RAISE EXCEPTION`;
  use `psql` inside the `fairyoga-db-1` container when you need to see a success notice.
- **Never `git add -A` or `git add .`** — stage exact paths.
- Recipes for driving the running app (auth without email, Playwright, seed data) live in the
  `verify` skill.

## The PR body

Record what was measured and where the errors were, including your own. State which inherited
claims were checked and which held; show the arithmetic behind every number; name what the PR
does *not* do; and say which suites ran — `integration` is never run in full, so name the
files that ran by path.

That honesty is load-bearing rather than decorative: on #39 a wrong assertion count would have
shipped in the PR body if the whole-branch review had not measured it independently.
