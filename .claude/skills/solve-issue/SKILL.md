---
name: solve-issue
description: End-to-end process for taking a fair.yoga GitHub issue from cold start to merged PR — verify premise, brainstorm, spec, plan, handover-or-subagent build, multi-agent PR review, rebase-merge, roadmap. Invoke as /solve-issue <issue-number>. Designed to run from an empty context.
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

`docs/backlog-roadmap.md` is tracked, and committed once per round. It is the map: it records which bundle the
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
  → [GATE] handover document, or build here? (§5)
  → superpowers:subagent-driven-development (task → review → fix loop)
  → whole-branch review → one fix wave → one scoped re-review
  → push + PR → [GATE] /pr-review-toolkit:review-pr <N>
  → aggregate → fold, file, or let go (§7) → [GATE] rebase-merge
  → update docs/backlog-roadmap.md → commit it, on its own
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
- #185 asked for a pre-merge gate. CI already ran every part of it, on the merge commit, as a
  required check — two of the issue's three headline claims were false. **When an issue proposes
  a check, read `.github/workflows/ci.yml` first and ask what already runs.** Building a second
  copy of an existing gate is the expensive failure here, and it looks like progress.
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
minus the one being fixed = 44`). Prose that counts goes stale; prose that explains why does
not.

**Naming the members rather than counting them is the right instinct and does not make the
claim durable.** `docs/lock-order.md`'s cross-family paragraph did exactly that and named an
incomplete set. A roster and a count are both prose claims about a set; only a compiler
tether is not — see *Comment Discipline* in CLAUDE.md for the house patterns.

**Decide where a number lives before you write it.** A measurement belongs in the spec, the
PR body and `docs/`, where it has an owner and can ship with the command that re-derives it —
not in a docblock, where the edit that invalidates it happens in another file. PR #300 spent
five review rounds on that class of claim; `generation.ts`'s header docblock keeps an import
census of its own importers, and #296 falsified it twice from the other end.

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

**Break it the way it actually broke.** A guard proved against a convenient mutation can still
be blind to the realistic one. #185 added a test drawing 100 addresses to pin a helper's
uniqueness, proved it by mutating the helper to a *constant*, and caught that — but the
regression that had actually occurred was a *narrow address space*, and at 100 draws the test
passed against that too. It took 100,000 draws to fail against it. Ask what the plausible
regression is, not what mutation is easy to write.

**A mutation must use a value the code under test cannot produce.** #185's mutation constant
was `10.0.0.1`, which sat inside the range the helper itself generates. It poisoned a live
rate-limit bucket for an hour and resurfaced later as a 429 in an unrelated test, on a run
nobody connected to the mutation. Reach for a reserved or impossible value —
`203.0.113.0/24` (RFC 5737) for addresses, and the same instinct elsewhere.

**A diagnosis has to survive arithmetic, not just sound right.** The first explanation offered
for that 429 was a 1-in-256 collision. It pointed the right way and the numbers did not work —
the limit needed four coincident hits, not two. Deriving the real cause took measuring 8 runs.
A mechanism that explains the *shape* of a symptom is a hypothesis; one whose numbers close is
a diagnosis.

## 4. Correct a claim in every artifact, not just the one in front of you

Repeatedly a fix landed in one place while its twin stood: spec but not plan, source but not
test, code but not the PR body, chat but not the docblock. Once a claim is wrong, `grep` the
phrase across **spec, plan, source, tests, PR body, and the GitHub issue** before calling it
fixed. Live reference docs count — `docs/technical-architecture.md` is listed in CLAUDE.md
and went stale on #39 because a field it documented was deleted.

**That instruction is not enough on its own, and #41 proved it.** The rule was followed and
the defect still shipped through two gates, because knowing the goal is not the same as
having a way to check you reached it. Two procedures, both mechanical:

- **A finding that names N locations gets N verdicts, not one.** On #41 a finding named spec
  `:243`, plan `:498`, and a commit message. The fix wave corrected the spec and the test and
  silently skipped the plan; the re-review verdicted the whole finding ADDRESSED on the
  strength of the locations it happened to open. "Is F1 fixed?" is unanswerable when F1 lives
  in three files. Enumerate the locations in the dispatch, and require the verdict to name
  each one.
- **Derive the post-fix sweep from the wave's diff, not from a keyword.** The re-review was
  told to `grep` for one finding's phrase ("three mutations"). It did, it passed, and a
  *different* finding's twin sat untouched three hundred lines away. Instead: list the files
  the wave changed, list the files it was *supposed* to change, and reconcile the two. A
  keyword sweep scoped to one finding cannot see another finding's twin — and a wave that
  fixes four of five things will report success either way.

The corollary is worth stating because it is counter-intuitive: **a fix wave's own report is
not evidence.** It said it had corrected "the spec, the plan, and the commit message." It had
not. Reconcile against the diff.

**Correct a claim by replacing it, not by annotating it.** "This previously read X" turns one
stale sentence into two, and the second goes stale too — `hasIntegerCounts`
(`template-action-messages.ts`) came out of PR #300 carrying a correction of a correction. The
before-and-after belongs in the PR body, which already asks for it; the comment carries only
what is true now. If the worry is that someone reinstates the error, a test or a compiler
tether holds it and a paragraph does not.

## 5. Build — handover or subagents; review at both levels

### Ask before you build

Once the plan is approved, **ask which way the build goes** — do not assume subagents:

> "Plan approved. Do you want a handover document so another agent (opencode) can
> execute this, or shall I build it here with subagents?"

Both are normal. The handover route exists because the plan alone is not enough for an
agent arriving cold in a different harness: the plan says *what to do*, and a handover says
*what will mislead you on the way*. #212 and #220 both went that route.

If the answer is "build here", carry on to the rest of this section. If it is "handover",
write `docs/superpowers/plans/YYYY-MM-DD-<topic>-handover.md`, commit it, and stop there.

### What a handover has to contain

Not a summary of the plan — the reader has the plan. It carries what the plan cannot:

1. **Read-in-this-order list**, four items: `CLAUDE.md`, the spec, the plan, this file. Say
   which section of each actually matters. If their harness auto-loads `AGENTS.md`, note that
   it only *links* to `CLAUDE.md`.
2. **The derailers, before anything actionable.** This is the section that justifies the
   document. A derailer is something the reader will get wrong *from reading the correct
   documents* — not a hazard, a wrong turn the material invites. They are unrecoverable
   mid-implementation, so they go ahead of the first instruction.
3. **A verify-don't-assume block** of runnable commands with expected output — every line
   number the plan leans on, the DB container, the dev server on :3000. Tell them to fix a
   drifted reference and report it.
4. **Harness differences.** No skills system, no enforced TDD ordering, mutations are
   deliverables, commit per task because the PR is rebase-merged.
5. **Task order, and which constraints are load-bearing** versus preference — with the
   reason, not just the order.
6. **The stop conditions**, naming the two or three mutations that matter most and why.
7. **The hazard list** from this skill, trimmed to what this branch can actually hit.
8. **A measured test baseline** (below), what "done" looks like, what the PR body must
   record, and what to report back.
9. **A final checklist**, one line per irreversible mistake.

### The three things that make a handover true rather than plausible

- **Measure the baseline; never inherit it.** Run the suite and record files and tests per
  project, with totals that reconcile — `50 + 37 + 28 = 115`, `710 + 202 + 392 = 1304`.
  Arithmetic a reader can re-derive is checkable; a bare number is decoration. Predict the
  after-figure, then **tell them to measure it anyway**: #212's handover predicted 1294 and
  the real figure was 1296, because that branch's own review added tests the prediction could
  not have known about.
- **Run your own verify-don't-assume block before committing.** You are telling a stranger
  those references are correct. #212's handover caught an inherited reference drifting by one
  (`schema.prisma:378-382 → 379-383`) exactly this way, and left the correction visible as the
  worked example.
- **Distinguish "runs" from "changes".** A branch that touches no integration file still
  *runs* all of them under `npm run verify`. Say which, because the PR body must not claim
  otherwise — and do not hand-list integration files (see the hazard list).

### Then: build with subagents

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
flag. For the comments reviewer that risk is already named: claims reaching past the file they
sit in, prose counts and rosters, and correction history that belonged in the PR body.
Adjudicate false positives yourself, with evidence, in the aggregate.

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

**"Will hit", not "could hit" — and name what blocks it.** Reachability is part of the
defect, so write the concrete path before judging it. When that path needs a state this
system cannot produce — a stored `ClassStatus` of `full`, when the enum has five members and
that is not one of them — it is not a live defect, and the four tests below govern it like
any other finding. Decline it the way you reject a false positive: path written out, blocking
condition named. Rarity is not that. A narrow route is still a route — `template-sync`
admitted an already-started class only east of UTC, and that was recorded as known-open
precisely because someone would reach it. (#194 deleted the function; the lesson is why
the route was recorded rather than declined, not that it is still there.) Reachability
is the test, not frequency.

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
opens is worse than a comment everybody reads. A reachable defect you are not fixing
now is the same shape: mark it `known-open` beside the code — as `room-archive.ts` does
for the archive-versus-publish race it accepts, and as `CLAUDE.md` did for
`template-sync` until #194 deleted that function. **The gap has to be about the code it sits
beside** — one about another module has no owner there, so it goes in `docs/` and the comment
links to it.

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
`gh issue list --state open --limit 200` (it silently pages at 30).

**Commit it on its own**, `docs: roadmap after #<N> (PR #<M>) — <in> in, <out> out`, staging
that one path. On its own because it is the round's last act and belongs to no task; the file
was tracked in the first place by being swept into `07d53b8`, a bug-fix commit about the
check-in list, which is what "stage exact paths" is for.

**Then re-derive the triage lists, don't read them.** Run `gh issue view <n> --json state`
over every issue number the roadmap's "Live bugs", "Someone is currently worse off" and
"Blocked on a decision" lists name — one call each, and the lists are short. Two kinds of rot
show up only this way: an issue closed by an accidental keyword (see the hazard list — it has
happened twice to the same issue, the second time via the commit documenting the first), and
an issue legitimately closed that the list still carries as open work. The open *count* will
not reveal either, because a wrong closure gets absorbed into the next snapshot's baseline and
the arithmetic then reconciles against the corruption. #199's round recovered one of each.

## Project hazards that have actually bitten

- **Run `npm run verify` before pushing** — typecheck, lint, and the whole suite including
  every file in `tests/integration/`. Per-diff review cannot see a defect that exists only
  in the union of several diffs, which is how #170 shipped both a dark test file and a red
  lint to a pushed branch past nine reviews. It needs the app running on :3000 (the
  integration project talks to it over HTTP); without it you get a wall of `ECONNREFUSED`.
  Green `verify` is a strong signal, **not** a substitute for CI: it runs the same static
  gates and the same vitest suite, but CI also runs `prisma validate`, a migration-drift
  check, `npm run build`, and Playwright — so a build-only defect (see the `@/lib/log`
  hazard below) passes `verify` and fails CI. Single files by explicit path
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
  migration — **a comment-only edit counts**, because it changes the file's checksum while
  `prisma migrate status` compares only names, so nothing catches it until the next
  `prisma migrate dev` demands a reset. Prose about a migration goes in `docs/`.
  `prisma db execute` swallows `RAISE NOTICE` but does surface `RAISE EXCEPTION`; use `psql`
  inside the `fairyoga-db-1` container when you need to see a success notice.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Never write "does not close #N" in a PR body or commit message.** GitHub's auto-close
  parser matches `close #N` and does not understand the negation in front of it. PR #191's
  scope section said *"Does not \[keyword] #113 or #122"* — with the real word and the real
  number adjacent — and the merge closed issue 113. A line that existed to be honest about
  scope did the exact opposite. (Issue 122 survived only because the keyword must sit
  immediately before each reference, so the bare `or #122` did not match.) The same trap
  applies to `fixes`, `fixed`, `resolves`, `resolved`, `closed`. Write
  "**#N is unaffected**" or "**leaves #N open**".

  **This rule governs the claim; it does not govern the citation, and that gap has already
  fired.** Five minutes after issue 113 was reopened with an explanation, commit `ee2ecff` —
  *"docs: two hazards that fired silently, and the instruction that caused one"*, written to
  record this very trap — **closed it again**, because its body quoted the offending line
  verbatim to explain it and the parser matched the keyword inside the quotation. It then sat
  closed with `stateReason: COMPLETED` for two days, looking deliberate.

  So: **anything that reproduces the phrase must break the token, not quote it.** Separate
  the keyword from the number (`\[keyword] #113`), or drop the `#` and write the number as
  prose ("closed issue 113"). This bullet does both, deliberately — read its own wording as
  the worked example.

  Symptom to watch for: the open count after a merge is one lower than `closed − filed`
  predicts. **That signal is necessary but not sufficient, and it failed here** — 113's
  wrong closure was already baked into the next snapshot's baseline, so the arithmetic
  reconciled perfectly while being quietly wrong. Arithmetic on a corrupted baseline
  validates the corruption. What actually recovered it was re-deriving the state of every
  issue named in the roadmap's triage lists with `gh issue view` — one call per number, one
  round in arrears at worst. Do that every closing round (§8). Reopen with an explanation
  rather than silently; a closed issue nobody decided to close is worse than an open one.
- **Post `gh issue`/`gh pr` prose from a `--body-file`, never `--body "…"`.** Backticks
  inside a double-quoted shell string still reach zsh as command substitution even escaped,
  and it fails *silently*: on this round a `gh issue comment` succeeded, returned a URL, and
  published a sentence reading "**Measured:** (added by #191) and both wrap…" with two file
  paths eaten. Write the markdown to a file in the scratchpad and pass the path.
- **Warm routes before scoring mutations.** `next dev` recompiles lazily after a source
  edit; the first requests pay compilation and can blow a 5s timeout, which reads exactly
  like an assertion failure. On #285's sweep this would have mis-scored three mutations as
  RED; warming the routes first is what prevented it, and #290 wrote the habit down.
  Apply mutation → curl the touched route(s) → then judge RED/GREEN.
- Recipes for driving the running app (auth without email, Playwright, seed data) live in the
  `verify` skill.

## The PR body

Record what was measured and where the errors were, including your own — and including what a
comment used to say, where you corrected one. That record lives here, not beside the code.
State which inherited claims were checked and which held; show the arithmetic behind every
number; name what the PR does *not* do; and say which suites ran, naming by path the
`integration` files this branch touched.

Two mechanical traps in that paragraph, both of which have fired:

- **The "does not do" section is where `does not close #N` gets written, and that phrasing
  closes the issue** — see the hazard list above. Write "#N is unaffected". This is the one
  place the skill's own instruction leads straight into the trap, which is why the warning is
  repeated here rather than only above. **And when you explain the trap — in a commit
  message, a review comment, an update to this file — break the token instead of quoting it,
  or the explanation fires the trap.** That has happened once already, five minutes after a
  reopen, in the commit written to document it.
- **"`integration` is never run in full" is no longer true, and repeating it understates the
  evidence.** `npm run verify` runs every vitest project (`vitest.config.ts`), so a green `verify` *is* the
  whole integration suite. Say so, with the arithmetic that proves it — on #191 that was
  `105 = 46 unit + 32 components + 27 integration`, which turns "every integration file ran"
  from a reassurance into a checkable claim. Still name the touched files by path, so a
  reviewer knows where to look.

That honesty is load-bearing rather than decorative: on #39 a wrong assertion count would have
shipped in the PR body if the whole-branch review had not measured it independently.
