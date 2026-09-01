# Lessons from solving fair.yoga issues

Status: **living** · Owner: `.claude/skills/solve-issue/SKILL.md`, which links here instead of
carrying this narrative inline.

This is the evidence behind the rules in the `solve-issue` skill — the specific issues where a
rule earned its place, kept here so the skill itself can stay a lean procedure. If a rule in the
skill seems arbitrary, its story is probably below. New incidents get appended under the section
they support; if a rule stops being live (the code path it guards against is deleted, the hazard
no longer applies), delete its entry rather than annotating it as historical.

## Gates

The user's answers at a gate have changed the design, not just rubber-stamped it. On #39 the
decision to enforce a tier-range check in PostgreSQL, not only TypeScript, came from a gate
question and reshaped the whole branch.

## 1. Verify the premise

Every issue worked so far has had a premise that was wrong or incomplete:

- #136 named "eight instances"; a census found twelve, including four the issue missed.
- #39 said an out-of-range tier was "caught only by a runtime throw" — the Zod schema already
  bounded the one route that accepts one.
- #39 also claimed a restructure makes the `arr[i]!` pattern "disappear". It doesn't — indexing
  is still `T | undefined` under `noUncheckedIndexedAccess`. *Iterating* removes it.
- #96 inherited a "byte-identical" claim from an earlier PR that was false.
- #185 asked for a pre-merge gate. CI already ran every part of it, on the merge commit, as a
  required check — two of the issue's three headline claims were false. Building a second copy
  of an existing gate is the expensive failure here, and it looks like progress.
- #140's "the fix is one line" **did** hold — the counter-example that keeps the rule honest:
  check anyway, and say so when it holds.

## 2. Counts

Every wrong number so far came from a method that structurally could not produce it:

- `grep … | head -24` reported as a census. A grep with a head/tail limit is not a count.
- A grep for key names cannot see `const { date, ...rest }` — that is how #148 stayed hidden.
- `\.studentPrices\[` requires a leading dot, so it cannot see a local `studentPrices[i]!`.
- Counting one test per *file* and reporting it as a test count.
- Conflating "9 call sites" with "9 display sites plus 1 billing site".

`docs/lock-order.md`'s cross-family paragraph named an incomplete set of members while doing the
"right instinct" of naming rather than counting — a roster is still a prose claim about a set.
See *Comment Discipline* in CLAUDE.md for the compiler-tether alternative.

PR #300 spent five review rounds on a claim that reached past its own file: `generation.ts`'s
header docblock kept an import census of its own importers, and #296 falsified it twice from the
other end — once per importer added in another file.

## 3. Prove every guard bites

#39 shipped three guards that existed and could not fail, all caught only at PR review: a
`satisfies` clause that pinned membership but not completeness (`[1,2,3,4]` compiled clean); nine
pinned prices that could not detect a tie-break flip (every tie was a complete pair, so reversing
it moved nothing); and a throwing helper whose call site could be reverted to the degrading one
without breaking a single test.

On #138 a manual check ran at a UTC hour when both code paths rendered identically — a pass that
proved nothing. `prisma/seed.ts` carries a comment warning about exactly that window.

#185 added a test drawing 100 addresses to pin a helper's uniqueness, proved it by mutating the
helper to a *constant*, and caught that — but the regression that had actually occurred was a
*narrow address space*, and at 100 draws the test passed against that too. It took 100,000 draws
to fail against it.

#185's mutation constant was `10.0.0.1`, which sat inside the range the helper itself generates.
It poisoned a live rate-limit bucket for an hour and resurfaced later as a 429 in an unrelated
test, on a run nobody connected to the mutation. The first explanation offered for that 429 was a
1-in-256 collision — it pointed the right way and the numbers did not work, since the limit
needed four coincident hits, not two. Deriving the real cause took measuring 8 runs.

A test can be correct and falsifiable and still structurally unable to see the bug it exists to
catch. A component test asserting a date-picker's bound rendered once, in one process, in jsdom's
zone; the actual defect only appeared across the server/client boundary (SSR renders a UTC date,
React 19 keeps it through hydration), which a single-process test has no way to reach. Ask what
the test environment cannot express, not just what the test asserts (#249's round, PR #256).

A verification claim can be run somewhere the fault structurally cannot appear, and still read as
diligence. "Nothing flaky under `failOnFlakyTests: true`" was measured with `retries: 0`, which
the config's own comment says makes "flaky" an unreachable verdict; a 25x flake-repro loop was
scoped to a browser project neither observed flake occurred in. Mutation-test the verification
claim itself, not only the code (#283, PR #303).

## 4. Correct a claim everywhere

**#41** proved that "grep the phrase everywhere" is not enough on its own without a way to check
you reached it. A finding named spec `:243`, plan `:498`, and a commit message. The fix wave
corrected the spec and the test and silently skipped the plan; the re-review verdicted the whole
finding ADDRESSED on the strength of the locations it happened to open. The re-review was also
told to `grep` for one finding's phrase ("three mutations"); it passed, and a *different*
finding's twin sat untouched three hundred lines away. The fix wave's own report claimed it had
corrected "the spec, the plan, and the commit message." It had not — only reconciling against the
diff caught it.

`hasIntegerCounts` (`template-action-messages.ts`) came out of PR #300 carrying a correction of a
correction — "this previously read X" turned one stale sentence into two, and the second went
stale too.

**#315** hit the invalidation-vs-edit gap ten times in one branch. Every early sweep was keyed on
the code that changed — the functions rewritten, the reasons renamed — and every stale claim was
about the objects that *went*: two dropped index names, four dropped triggers, `P2002` as an
error that no longer arrives. A sweep derived from the changed call sites found seven stale
references; re-derived from the removed objects, the same sweep found an eighth nobody had named.
Expect legitimate survivors: on #315 the entry layer genuinely still raised `YG001` and
`unique-conflict.ts` genuinely still gated on `P2002`, so a blanket rewrite would have been the
mirror-image defect.

#315's one Critical review finding was a docblock whose third sentence had been correctly
rewritten to "a `23P01`" and whose seventh still called the same thing "the template's own slot
index" — in a paragraph that branch had itself edited. It survived nine keyword sweeps because it
names no object; it only describes one wrongly. The identical shape then turned up in a **runtime
log string** ("lost a lock race … or the slot index"), a category nobody had swept and the only
one that reaches an operator's `grep`.

A keyword census cannot find a claim that changed verb or surface form rather than staying put. A
stale claim drifted "sized" → "sizes" → "a `Math.min` ceiling" → "is exactly this caller" across
four artifacts; each was found by a different reader checking for meaning, not by grep. The check
is "does any surviving sentence make a false claim about current state," not "does the keyword
still appear" (#332's round).

## 5. Build

Whole-branch review catches what task-level review structurally cannot, because task reviewers
see only their own diff:

- #136: four forms whose pins certified a type nothing connected to the sent body — the very
  defect the issue existed to remove, one level up.
- #39: an assertion count that was right per-task and wrong for the branch.
- #39: a policy chosen for one call site that a later task silently applied to a second one with
  opposite stakes.
- #39: an integration test had to be re-pointed *before* a CHECK constraint landed, because the
  constraint made its failure injection unwritable — task order was load-bearing and had to be
  stated in the plan and the dispatch.

Letting subagents surface plan defects rather than bending code to match a wrong instruction
caught four wrong predicted outputs this way.

A fix round needs its own review, and self-review of a self-authored fix doesn't supply it. Two
separate rounds found this the same way: one needed a third review pass specifically of what a
second, self-reviewed pass had written (a fix that inverted itself, a claim false in four places);
another found nothing the original five-agent wave had missed, but found several defects in the
fix that wave's findings produced. Mutation testing doesn't substitute — it proves a test *can*
fail, never that it asserts the right thing (#216/#182's PR #235; #283's PR #303).

## 7. Fold, file, or let go

#86 closed one issue and spun out eight — recorded as "the review found a genuinely
under-explored area," not let pass as a normal ratio.

`prisma/seed.ts` hard-coding the tier ratios was visible from #39 and was not #39's problem —
filing it because it was seen in passing would have inflated the tracker for no gain. (This test
never applies to a *live bug*: a pre-existing defect is still a defect someone will hit.)

#143 absorbed an e2e coverage finding as an "Update" on a live issue rather than spawning a
fourth coverage issue.

#128's accessible-name gap is pointed at from beside the button it describes, not filed as an
issue nobody opens. `room-archive.ts` does the same for the archive-versus-publish race it
accepts, and `template-sync` carried a `known-open` note in CLAUDE.md until #194 deleted the
function — recorded there specifically because someone would reach it: it admitted an
already-started class only east of UTC, a narrow route that was still a route.

## 8. Finish

#199's closing round caught an issue closed by an accidental keyword match — a status that a
written summary of "what's still open" had already absorbed as correct, and that only checking
the issue's actual state with `gh issue view` revealed. A merge's own success says nothing about
which issues it silently touched.

## Project hazards

**`npm run verify` before pushing.** Per-diff review cannot see a defect that exists only in the
union of several diffs, which is how #170 shipped both a dark test file and a red lint to a
pushed branch past nine reviews — 20 of 26 integration files were left unobserved because the
plan hand-listed files instead of relying on the sweep.

**Never write "does not close #N".** PR #191's scope section said *"Does not \[keyword] #113 or
#122"* — with the real word and the real number adjacent — and the merge closed issue 113 anyway,
because GitHub's auto-close parser matches the keyword and does not understand the negation in
front of it. (Issue 122 survived only because the keyword must sit immediately before each
reference, so the bare `or #122` did not match.)

That rule governs the claim, not the citation, and the gap already fired once: five minutes after
issue 113 was reopened with an explanation, commit `ee2ecff` — written specifically to document
this trap — closed it again, because its body quoted the offending line verbatim and the parser
matched the keyword inside the quotation. It sat closed with `stateReason: COMPLETED` for two
days, looking deliberate. Breaking the token instead of quoting it (`\[keyword] #113`, or the
number as prose) is what the skill's own hazard-list entry does, deliberately, as its own worked
example.

**Warm routes before scoring mutations.** On #285's sweep, `next dev`'s lazy recompilation after a
source edit would have mis-scored three mutations as RED, reading exactly like an assertion
failure. Warming the routes first — apply mutation → curl the touched route(s) → then judge —
prevented it, and #290 wrote the habit down.

**A `run:` step's own script text can appear in a run's log even when it never fired.** GitHub
Actions echoes the command before executing it, so a string like `App did not become healthy
within 30s` reads as a failure symptom — and appeared verbatim in a run that passed. Grep the
string against a passing run's log before treating it as evidence (`gh run view <id> --log | grep
…`), on the CI-flake investigation around PR #341.

**A failure that recurs at a fixed interval across a repeated run is usually self-inflicted, not a
flake.** `--repeat-each=30` against a suite containing a test that posts to the same rate-limited
endpoint failed exactly every 71st execution — the per-pass test count — because the harness was
tripping its own rate limit, not reproducing the bug under test. A real flake scatters; a
self-inflicted one arrives in a block (same PR #341 investigation).

**When a fix is rejected because it would falsify a comment or docblock, the comment is the
suspect, not the fix.** A spec justified its own design with "only a browser sees the refresh
change which control is drawn"; the correct fix (`reload()` after the write) falsified that
sentence, so the first attempt avoided the reload and kept a wrong test passing instead of
correcting the sentence (#283, PR #303).

## The PR body

On #39 a wrong assertion count would have shipped in the PR body if the whole-branch review had
not measured it independently — the reason "record what was measured, including your own errors"
is load-bearing rather than decorative.

On #191, "every integration file ran" turned from a reassurance into a checkable claim once shown
as arithmetic: `105 = 46 unit + 32 components + 27 integration`.

On #315, the `&&` trap masked 519 integration tests for most of a branch — 16 red unit tests kept
`npm test`'s second invocation from ever running, so `integration` reported nothing, not zero
failures. The 63 real integration failures hiding behind them only appeared once the unit tier
went green.
