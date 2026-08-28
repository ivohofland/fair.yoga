# Open-issue roadmap & bundling

**Snapshot:** 2026-08-28 (after #272 merged, PR #340) · **106 open issues**,
re-counted with `gh issue list --state open --limit 300 --json number --jq
'length'` = 106.

**THE 89 → 106 DELTA IS RECONCILED (2026-08-28).**

> **89 − 8 + 25 = 106.** Eight of the 89 closed; twenty-five issues filed since
> are still open. **Twenty-five in, eight out.**
>
> **Out (8):** #194, #228, #272, #276, #279, #281, #282, #283.
> **In (25):** #286-#289, #291, #299, #301, #302, #307, #310-#313, #317-#320,
> #323, #325, #328, #329, #336-#339.

**The debt was worth paying, because the plausible sum was wrong on both
terms.** This entry previously read "#272 closed on this round (one out), so
seventeen of the eighteen are issues filed outside it". Neither number
survives: **eight** closed, not one, and **thirty-seven** were filed, not
eighteen. The window is far busier than a net of +17 suggests — **37 filed and
20 closed**, of which twelve (#290, #293, #296, #297, #298, #304, #309, #315,
#321, #327, #331, #332) were opened *and* closed inside it and net to nothing.
A net figure hides a 57-issue turnover; that is what §8 means by a count the
open number cannot reveal on its own.

**The boundary is an issue number, not a timestamp**, which is what makes this
re-derivable rather than re-argued. The 89 snapshot was taken after #284 was
filed (12:46:49Z) and after #116/#117/#126 closed (12:53:50Z), so
**everything ≥ #285 is new** and the eight above are the pre-#285 closes that
follow it. Re-derive with:

    gh issue list --state all --limit 400 --json number,state,closedAt \
      --jq '[.[]|select(.number>=285 and .state=="OPEN")]|length'   # the +25
    gh issue list --state all --limit 400 --json number,state,closedAt \
      --jq '[.[]|select(.number<=284 and .state=="CLOSED"
             and .closedAt>"2026-08-20T12:53:50Z")]|length'          # the -8

**AND THE PREVIOUS ROUND'S DEFERRAL WAS VINDICATED, which is worth more than
the arithmetic.** #274-#284 were left un-bundled on the ground that bundling
someone else's batch from its titles is triage that must be re-derived rather
than inherited. Eight days later **five of the eleven have closed on their
own** — #276, #279, #281, #282, #283 — so bundling them would have been work
spent on issues that resolved without it. Six remain: #274, #275, #277, #278,
#280, #284.

**What is NOT done: the 25 are counted, not bundled.** They cluster by filing
date — five on 08-20, three on 08-22, one on 08-23, **ten on 08-24**, two on
08-26, four on 08-27 — and the 08-24 group is visibly one review round over
form validation and copy pins (#310-#313, #317-#320). Bundling them is the
next round's job; counting them is done, and this entry no longer hands the
next round an unexplained baseline.

The previous snapshot's reconciliation, kept because its arithmetic is still
the worked example of how this is supposed to read:

> 2026-08-20 (after #116 + #117 + #126 merged, PR #273) · **89 open issues**.
> Reconciles: 80 − 3 (#116, #117, #126 — all three in PR #273) + 1 (#272,
> spun out of the branch's own measurement) + 11 (**#274-#284, filed by the
> maintainer at 12:14-12:46Z, outside this round**) = 89. **One in, three out.**

**The +11 was why that arithmetic was written out**, and it was the second
consecutive round where the count only reconciles because an outside-the-round
batch is named. Without #274-#284 itemised the sum reads 78 against a measured
89, and the next round inherits an eleven-issue error as its baseline — the
corruption §8 says the open count cannot reveal on its own, at ten times the
previous round's size.

**#274-#284 are deliberately left un-bundled.** They are a coherent batch — a
tracking epic (#274) and ten findings on the studio class family, end to end —
filed by the maintainer after this round's work was already merged. Bundling
someone else's batch from its titles is exactly the triage that §8 says must be
re-derived rather than inherited, so it is the next round's first job, not this
one's parting guess.

**What this round is actually about: a fix that made a guard untestable, and
nobody noticed for three review passes.** Both delete routes got a pre-check
*and* a foreign-key backstop. They answered with the same status, the same
body and the same error code — so `if (false && ...)` on the pre-check left
**every test in the integration project green**. The pre-check is the half
`docs/lock-order.md` credits with closing an AB-BA cycle against the generator
sweep; the backstop cannot close it, because it runs after the `DELETE` has
taken its locks. A guard that cannot fail is this project's signature defect,
and this is the first time the branch *introduced* one as a side effect of a
correct fix rather than shipping one it wrote.

**Two mechanisms fixed it, and the cheap one was invisible until the expensive
one existed.** The backstop now answers `ROOM_IN_USE_RACE` where the pre-check
answers `ROOM_IN_USE`, so every pre-check case asserts which guard replied —
deterministic, instant, and it took one constant. But a code assertion still
passes if someone moves the pre-check *below* the delete in the same handler,
so each suite also holds `FOR UPDATE` on the `ClassTemplate` row the RESTRICT
trigger needs `FOR KEY SHARE` on: with the pre-check the route refuses without
issuing the `DELETE`, without it the `DELETE` waits. Measured, both pre-checks
disabled: 6 failures — 4 instant code assertions at 16-33 ms and 2 lock cases
at ~3 015 ms. Before, the same mutation produced 2 failures, both at 5 s.

**The lock case is the only test in this repo whose passing depends on
wall-clock latency**, which is worth knowing before the next one is written.
Its first version used a 5 000 ms sentinel — colliding exactly with vitest's
default `testTimeout`, which won every time, so the diagnostic assertion was
dead and a real regression reported "Test timed out in 5000ms". That reads as
flake, the one meaning a lock test must never carry. The identical collision
had already been found and fixed one layer down (Prisma's interactive-
transaction default is also 5 000 ms, which is what `{ timeout: 20_000 }` is
for) and was still missed a layer up.

**Four separate false claims about the schema shipped inside the branch and
were caught by review, not by tests.** A comment asserting a CASCADE that a
RESTRICT forbids; a spec section justifying a transaction with a window only a
redundant statement opens; a `modelName` justification wrong at **seven**
sites; and a new `lock-order.md` paragraph claiming a second, unclosable
deadlock cycle that the shipped guard in fact closes. None was catchable by any
test — every one was a claim about *why* the code is right.

**The fix wave then repeated its own failure, in the same files, one commit
later.** The `modelName` finding named seven locations; the wave fixed five.
Caught by reconciling against the finding's location list. The very next
finding — the refusal-message change — named fifteen locations and the wave
fixed seven. §8's rule ("a finding that names N locations gets N verdicts") is
not a formality: it fired twice on one branch, after being read.

**Agents mutating a shared working tree corrupt each other's measurements,
reliably.** Round one produced a false CRITICAL (one agent reported both
backstops disarmed; it was another agent's in-flight mutation). Round two
produced a false flake report (one agent measured "2 of 6 full runs fail";
the other was mutating the pre-check at the time, which makes exactly those
two cases block for 5 s and nothing else). Both were resolved by measuring
directly rather than averaging the reports. The previous snapshot already
recommended `isolation: "worktree"` as the default for review fleets; this
round is the second consecutive one to pay for not doing it.

PR #264: 12 commits (5 `docs`, 4 `fix`, 2 `feat`, 1 `test`) over 12 files.
**Four `fix` commits on a branch whose feature was two**, and three of the four
came from review rounds rather than from building. Counted from `git log`.

**Previous snapshot:** 2026-08-19 (after #76 merged, PR #262) · **78 open issues**,
re-counted with `gh issue list --state open --limit 200` = 78. Reconciles:
79 − 1 (#76, PR #262) + 0 filed = 78. **One in, none out** — the first round
that closed an issue and opened nothing.

**Nothing was filed because nothing needed to be**: the five-agent review
produced **21 distinct findings after de-duplication** — the door-5 defect
alone was reported by four of the five agents, by four different methods — and
every one was either fixed on the branch (18) or declined with evidence (3:
`ArchiveRoomButton` discarding `action`, `slot_conflict`'s message, and a
"dirty working tree" that was the sibling agents' own in-flight probes).
De-duplicated by hand from the five reports, because the raw finding count
across them is about 34 and counting that would have overstated the round. The one candidate left standing is
the generator's blind spot — a template left active on a room archived *before*
this branch keeps generating into it — which is carried as `known-open` beside
the read site (`class-generator.ts:359-367`) and in spec §10 rather than on the
tracker. **It is latent rather than live**, and the round closed with that
settled rather than deferred: the state needs an *active* template on an
*archived* room, which this branch makes unreachable through the app, and the
only population that could already hold it — rows archived before the branch —
is empty, because the app has not shipped. No backfill is owed. Applying §7's
own test, the concrete path requires a state the system cannot produce, which
is the same ground on which a stored `ClassStatus` of `full` is declined. The
note stays beside the code because the query is safe by an invariant held
elsewhere, not by anything it checks — a future writer setting `isArchived`
outside `room-archive.ts` would make it reachable again.

**The round's most useful output is that a review round's own fix was wrong,
and the review that checked it agreed.** The whole-branch review found a fifth
door (`updateClassTemplate` could relocate a template onto an archived room)
and closed it with `if (teacherRoom.isArchived && template.isActive)`, arguing
symmetry with door 3. The scoped re-review verified the gate *fired* and passed
it. Both missed what it let through: pausing deletes nothing, so a paused
template still owns the `open` instances it generated, and `syncTemplateInstances`
carries all of them onto the archived room in the same transaction. One `PUT`
moved four bookable classes onto a shelved room — the exact state door 1 exists
to refuse, produced one step after door 1 refused it. Four of the five PR-review
agents found it independently, by four different methods.

**The generalisable form: door 3 gates on the DIRECTION of a verb, door 5 was
given a PROPERTY of the template, and "symmetrical with" hid the difference.**
A justification that transfers by analogy has to be re-derived at the second
site, because the *reason* is what transfers, not the shape.

**Seven guards on this branch existed and could not fail** — the count that
matters, and the same shape every time: argued for in prose more rigorously
than enforced by a test, so a reviewer reading them was persuaded and a
reviewer breaking them was not. Door 2's ordering and its status clause, door
5's ownership ordering, `GET /api/teacher-rooms`'s `isArchived` field (whose
removal left 235 component tests green while both pickers silently stopped
filtering, because `!undefined` is truthy), `class/new`'s filter and empty
state (deleted outright, 235 tests green — `TemplateForm` got three tests for
the identical change and this wizard got zero), `ArchiveRoomResult`'s `ok: true`
half, and a forbidden-field-list deletion. All seven are now pinned by the
mutation that catches them, spec §9 mutations 10-16.

**Eleven line citations were wrong, and the procedural fix is the durable
part.** Most drifted because *this branch's own insertions* moved the target:
a commit that inserts lines above a cited line invalidates every citation below
it in that file. Two were declared fixed and were not — one commit announced
section 4's door table re-derived while door 2's entry in that same table still
carried its pre-branch number. The cause both times was a check that PRINTED
citations for a human to eyeball. Rewritten as an assertion — resolve each
cited line, match it against the token the prose claims is there, fail on
mismatch — it caught the outstanding misses on its first run and then caught
two more the same session's edits had just created.

**Process note for the next multi-agent round:** five review agents shared one
working tree and interfered — one restored another's in-flight mutation
mid-run, and a third got a false "pin did not fire" from a stale
`tsconfig.tsbuildinfo` (this repo sets `incremental: true`). Two agents worked
around it by building isolated copies; that should be the default given to
them (`isolation: "worktree"`), not something each has to invent.

PR #262: 28 commits (15 `docs`, 5 `fix`, 5 `feat`, 2 `test`, 1 `refactor`) over
25 files, 23 of them in `src/`, `tests/` and `prisma/`. **Five `fix` commits on
a branch whose feature was five, and all five came from a review round rather
than from building** — two from task review, one from the whole-branch review,
and two from the PR review. Counted from `git log`.

**Previous snapshot:** 2026-08-18 (after #73 merged, PR #261) · **79 open issues**,
re-counted with `gh issue list --state open --limit 200` = 79. Reconciles:
78 − 1 (#73, PR #261) + 2 (#259, #260, both spun out of this round's spec
before any code was written) = 79.

**Both of this round's filings came from writing the spec, not from reviewing
the branch** — the inverse of the previous round, and stated as this round's
shape rather than as a turn. #259 and #260 were filed at 13:13Z, hours before
the first commit, because measuring the issue's premise surfaced two questions
the fix deliberately does not answer: switching a private room to an
already-shared one at the same address, and case-variant duplicates inherited
from #196's byte-exact key. The five-agent review that followed filed **none**
— it found 24 defects and every one was fixable in place.

**The issue's own load-bearing claim was false, and that is the round's most
useful output.** #73 argued the trap was *"API-only today. That makes it lower
urgency."* The *flip* was API-only; the *lock* was the default outcome of the
only room-creation flow in the app, at all three layers (pre-checked box,
`?? true` in the route, `@default(true)` on the column). A teacher who left the
box alone created a room they could never edit or delete. The correction is on
the issue at close.

**Three guarantees on this branch could be deleted with the suite still
green** — the count that matters from the review, and the reason the round ran
two review passes rather than one. `updateRoomSchema`'s `.strict()`, the
duplicate search's argument order, and the column-default test were each
removable at 0 cost to a green run. The generalisable one: **a single-key
request body cannot distinguish "refused" from "ignored"**, because a strict
schema stripping the only key leaves an empty update that answers the same 400.

PR #261: 19 commits (7 `fix`, 6 `feat`, 2 `refactor`, 1 each `test`, `spec`,
`plan`, `docs`) over 30 files, 27 of them in `src/`, `tests/` and `prisma/`.
**Seven `fix` commits on a branch whose feature was six**, and **five** of the
seven came from the branch's own two review rounds rather than from building
(the other two are `f18521f`, the Task 4 feature fix, and `1e7f0b5`, which
corrected drifted references in the spec and plan before any code was
written). Counted from `git log`, because a first draft of this line said six
and the count is the only reason the sentence is worth having. One more
instance of the ratio the previous round recorded — now with the review
finding a live TOCTOU race that the feature work itself had opened.

**Previous snapshot:** 2026-08-18 (after #249 merged, PR #256) · **78 open issues**,
re-counted with `gh issue list --state open --limit 200` = 78. Reconciles:
75 − 1 (#249, PR #256) + 2 (#257, #258, from this round's review)
+ 2 (#254, #255) = 78.

**Two of those four are not this round's, and separating them is the whole
point of re-deriving rather than carrying forward.** #254 and #255 were filed
at 08:06Z and 08:54Z on the 18th — after the previous snapshot's round closed
and before this one's review ran — and neither touches #249's area (they are
about the verify rail and about walk-ins). Folding them into "four filed by
the review wave" would have produced the correct total from a false story, which
is the compensating-error shape the 2026-08-15 line below was written to catch.
This round filed **two**, both from its own review.

**One out, two in, and both of the two are scope decisions rather than
defects.** #257 (`template-sync` is a third, unguarded writer of a class's
start instant) and #258 (`defaultTimezone` is hardcoded at signup and the
picker offers 26 zones) were each found by asking what the branch's own claims
did NOT cover. Neither was fixed here because both need a product call — the
same reason #249 itself was filed rather than folded into #247.

PR #256: 18 commits (6 `fix`, 4 `feat`, 4 `docs`, 2 `spec`, 1 `test`, 1
`plan`) over 18 files in `src/` and `tests/`. **Six `fix` commits on a branch
whose feature was four**, because the round ran review → fix → scoped
re-review, and the re-review found two defects the fix round had introduced
while repairing their twins. That ratio is the round's finding, and it is
recorded below rather than treated as overhead.

**Previous snapshot:** 2026-08-18 (after #247 merged, PR #250) · **75 open issues**,
re-counted with `gh issue list --state open --limit 200` = 75. Reconciles:
72 + 1 (#249, filed mid-round by this branch, deliberately not fixed by it)
− 1 (#247, PR #250) + 3 (#251, #252, #253, all from PR #250's review wave)
= 75. **Three of the four movements came from reviewing, not from building** —
the branch itself closed one (#247) and filed one (#249); its five-agent review
wave filed the other three. Stated as this round's ratio and not as a trend:
the immediately previous round (#238, PR #248) moved one each way, and the one
before that (#240, PR #246) closed two and filed none. A first draft of this
line called it "the fourth consecutive round" of review out-producing building,
which the three sections below refute — the exact defect the round's own review
was about, reproduced in the paragraph recording it.

**Previous snapshot:** 2026-08-17 (after #238 merged, PR #248) · **72 open issues**,
re-counted with `gh issue list --state open --limit 200` = 72. Reconciles:
72 + 1 (#247, filed mid-round by this branch's own review) − 1 (#238, PR #248)
= 72. **The number is unchanged and the set is not** — a round that closes one
and files one holds the count still while moving the work, which is exactly the
case a delta-only line would report as "nothing happened".

**Previous snapshot:** 2026-08-16 (revised after #240 merged, PR #246) · **72
open issues**, re-counted with `gh issue list --state open --limit 200` = 72.
Reconciles: 69 − 1 (#237, PR #239) + 6 (#240–#245, all from PR #239's review)
= 74, then − 2 (#240 by PR #246; #243 closed unbuilt, NOT_PLANNED) = 72.

**Two closed, none filed — and that is the point of the round, not a
by-product.** The previous round closed one issue and filed six, all in two
files, from a branch of 6 `refactor` + 4 `test` + 4 `docs` + 1 `feat` and zero
`fix`; across the forty commits before it, `docs:` was the largest single
category. That is a review loop sustaining itself: each pass finds true things
about the previous pass's comments and coverage, which become issues, which
justify another pass. #240 was worth doing on its merits; #243 was declined
after its premise was verified, and the verification is the deliverable. The
specialised PR-review gate was also skipped by decision — seven review passes
had already run on a three-source-file diff, and the last two produced four
cosmetic nits between them. Reviewing has a ratio too.

**Previous snapshot:** 2026-08-15 (after #216/#182, PR #235) · **69 open
issues**, re-counted with `gh issue list --state open --limit 200` = 69.
Reconciles: 67 − 2 (#216, #182, both by PR #235) + 4 (#234 filed mid-round,
then #236, #237, #238 from PR #235's two review waves) = 69. Measured, not
derived — and the previous line's arithmetic is kept below rather than
overwritten, for the reason the paragraph after it gives.

The 67 it starts from: 66 + 1 (#228, filed 13:25Z on the 14th) − 1 (#113,
closed 17:18Z by PR #227) + 1 (#229, filed 22:59Z on the 14th) − 3 (#83, #209,
#180, all by PR #230) + 3 (#231, #232, #233, from PR #230's review wave) = 67.

**Two rounds are folded into that line, and the first draft of this snapshot
lost one of them.** It read "66 − 3 + 4 = 67", which is arithmetically correct
and historically false: it silently merged PR #227's round into PR #230's,
counting #229 as one of "four filed by the review wave" and dropping both
#228's filing and #113's closure — which cancel, and so left the total right.
**A reconciliation that closes on a compensating pair of errors is the exact
failure this section exists to catch, and it only surfaced because the numbers
were re-derived against `gh issue view` instead of being carried forward.**
The previous snapshot said that check "is now worth doing every round"; this
is the round where it paid.

**PR #230 was three in, three out**, and every closure was intended and fired.
Its body carries exactly three closing keywords, all three issues went to
CLOSED on merge with no hand-closing afterwards, and everything it deliberately
did *not* close is written "**#229 remains open and is unaffected**", "**#104 …
and #103 … are both unaffected**" — the instruction applied throughout, for the
sixth consecutive round, with nothing reopened.

**#113 is finally closed for real** (PR #227, 17:18Z on the 14th — six minutes
after the merge, so by hand, not by a keyword). The issue this document
narrates at length as having been *accidentally* closed twice was, on the third
occasion, closed deliberately by the branch that actually fixed it. Recorded
because the hazard note below reads as though #113's story is only about
accidents; the ending is that the instruction held long enough for the real fix
to land.

**#229 was filed mid-round, and unlike #221 that was deliberate.** It went in
at 22:59Z on the 14th, nine hours before PR #230 merged, because the branch's
spec parked the `{Class, ClassTemplate}` order as a decision and pointed
`docs/lock-order.md` at the issue number — the number had to exist before the
docs commit could cite it. Worth distinguishing from #221 above: that one was
filed mid-round *and lost*, this one was filed mid-round *because a committed
artifact needed to reference it*. The reconciliation catches both the same way;
only one is a process failure.

**The +1 is the reconciliation earning its place.** 62 − 1 + 4 = 65, and the
count is 66. Chasing the missing one is what surfaced #221: filed mid-round
during #220's spec phase, after the snapshot that was supposed to bound the
round. A reconciliation that only ever confirms is not doing anything; this is
the second consecutive round where forcing the arithmetic to close found
something the narrative had lost.

**The closing-keyword hazard did not fire, and this time that was checked rather
than noticed.** PR #222's body says "**#216 is unaffected**", "**#157 is
unaffected**", "**#219 and #221 are unaffected**" — the existing instruction,
applied throughout. #220 stayed open through the merge and had to be closed by
hand afterwards, which is the instruction working, not a gap. Four rounds after
#113 was closed by accident twice, this is the first round where the absence of
an accidental close is attributable to the rule rather than to luck.

**Every number in all three triage lists was re-derived against `gh issue view`
after this merge** — 20 calls, all reconciling. #113 is still `OPEN REOPENED`,
which is this round's evidence that the check works rather than an assumption
that it did. #212 is the only new closure and it was intended (`Closes #212` in
the PR body, the single place any closing keyword appears in the whole branch).

**#113 was closed by accident for the SECOND time, and the second trigger was the
commit that documented the first.** `ee2ecff` — *"docs: two hazards that fired
silently, and the instruction that caused one"* — quotes the offending line
*"Does not \[keyword] #113 or #122"* verbatim in order to explain it, and
GitHub's parser matched the keyword inside that quotation exactly as it had in
PR #191's body five minutes earlier. Reopened at 07:06:29, closed again at
07:11:36, `stateReason: COMPLETED`, unnoticed for two days.

So the existing instruction ("write **#N is unaffected**") governs the claim but
not its later citation. **Anything that reproduces the offending phrase — a
commit message, a PR body, a skill's hazard list — must break the token rather
than quote it:** separate the word from the number, or drop the `#`. This entry
does that deliberately.

It also did not surface the way the hazard note predicts (an open count one lower
than `closed − filed`). It surfaced because this round re-derived the state of
every issue named in the triage lists below instead of trusting them. That check
is cheap — one `gh issue view` per number — and is now worth doing every round.

**#199's round was one in, one out**, and #216 is a leaf once #182 lands. #196's
branch 2 was one in, four out, three of them filed as decisions rather than work.
**#212's round was one in, two out** — #219 and #220, both leaves, both filed as
decisions with costed options. Worth saying out loud rather than letting pass:
neither is debt the branch noticed in passing. Both are things the branch **made
worse** — #219 because five callers now depend on one helper whose precondition
nothing checks, #220 because bounding the new lock converted "the broadcast
eventually fires" into "the broadcast is dropped for good".

**#220's round was one in, four out**, and unlike the last two rounds none of
the four is a regression this branch introduced. #223, #224 and #225 are debt it
*surfaced by looking*: two are growth costs the sweep converted from occasional
to per-minute, and one is a test seam that only became visible once the two
halves either side of it were extracted and covered. #226 is the honest residue
of the fix — the one case the sweep structurally cannot reach — filed as a
decision because closing it means deciding what the cancel deadline promises.

The previous snapshot's note stands: **#196 was auto-closed by an earlier
merge and reopened** — see the closing-keyword hazard below. That round's PR body
said "**#216 is unaffected**" for exactly that reason, and #216 stayed open,
which was the check working. It is closed now — by PR #235, which owned it.
An explicit high `--limit` is required because `gh issue list` silently pages at
30. The move was 40 → minus #146/#148 (PR #163) → plus #162/#164 → minus #162
(PR #165) → plus #166/#167/#168 → minus #166 (PR #169) → plus
#170/#171/#172/#173/#174 → minus #167 (PR #175) → plus #176/#177/#178 →
minus #174 (PR #179) → plus #180/#181/#182/#183 → minus #170 (PR #184) →
plus #185 → minus #185 (PR #186) → plus #187 (passkey-options) →
minus #41 (PR #188) → plus #189 (SSE slot-release coverage) →
plus #190–#194 (rounds not logged individually here) →
minus #119/#120 (PR, studio window reporting) →
minus #112 (PR #195) → plus #199, #200 →
minus #40 → plus #196, #197 (PR #198) →
minus #200 (PR #203) → plus #201, #202 →
minus #164/#192 (PR #204) → plus #205/#206/#207 →
**#196 branch 1 (PR #208) → plus #209, #210; #196 itself stays open for branch 2**
→ minus #196 (branch 2) → plus #212, #213, #214, #215 →
**minus #199 (PR #217) → plus #216** →
minus #212 (PR #218) → plus #219, #220 → plus #221 (filed mid-round, not in that
snapshot) →
**minus #220 (PR #222) → plus #223, #224, #225, #226** →
plus #228 → **minus #113 (PR #227, closed by hand six minutes after the
merge)** → plus #229 (filed mid-round, before PR #230, because
`docs/lock-order.md` had to cite it) →
**minus #83/#209/#180 (PR #230) → plus #231, #232, #233**. →
**minus #216/#182 (PR #235) → plus #234, #236, #237, #238** — two in,
four out, and the only round so far whose spin-outs came from reviewing its own
fixes rather than its own implementation.

(#227 and #230 are PRs, not issues, and do not appear on either side of this
line except as the agent of a closure. An earlier draft of this entry listed
"plus #227" — it is the lock-race branch, which closed #113 rather than adding
anything.)

**One issue in, two out, and #196 is not even closed by it.** The ratio is worth
saying out loud rather than letting pass: a migration that constrains every write
across five tables surfaces adjacent decisions, and both spin-outs are ones this
branch *made worse* rather than merely noticed — #209 exists because removing the
duplicate turned a silent wrong-data outcome into a half-applied one, and #210's
collision exists because we added four indexes sharing column-name sets. Both are
filed as decisions with costed options, not as work.

**#196's design round (2026-08-11) moved the count by zero** — nothing closed,
nothing filed, spec only. It found six defects beyond the issue's nine and filed
none, because all six sit inside #196's own scope (§3 of its spec) rather than
beside it. Two findings that looked new were **#164 and #192 already**; running
`gh issue list` against a finding *before* writing it up is the cheap habit that
would have caught that at the start instead of at the plan gate. The round's
real output is a sequencing change: #164/#192 now come first, because #196's
`Class` index turns #164's rare aborted-transaction path into a routine one.

**The previous snapshot's 54 was wrong, and the way it was wrong is worth
keeping.** It listed "#196–#198" among the additions. #196 and #197 did not exist
when it was written — they were filed by this round — and **#198 is a pull
request, which `gh issue list` does not count at all**. A range written across an
issue/PR boundary silently counts PRs as issues. Ranges are convenient and that is
exactly their hazard: enumerate what you actually filed, and re-count rather than
deriving. The measured figure is 53.

**One in, two out, and the reason is worth stating.** Both spin-outs came from
the PR review rather than from the work, and neither is debt noticed in
passing. **#199** is a live bug with a product decision attached, so it is filed
*as* a decision with three options and the production count as its first input.
**#200** is one line of copy that was written, tested, and then **deliberately
reverted**: that route is reachable only over HTTP, the app on :3000 serves a
different checkout, and the same review had just found four unpinned mutations
in this PR — adding a fifth on the way out would have been incoherent. Filing it
is the honest version of "I could not verify this from here."

**#200 then closed in one session (PR #203), one in two out again — and the
spin-outs came from verifying its premise, not from writing its code.**

- ~~**#200 — the manual cancellation notice does not name the class.**~~
  **CLOSED 2026-08-11.** Two lines of copy. What was learned is not in the issue:
  - **Its own census was wrong, and I wrote it.** It said "three of the four
    cancellation paths name the class". There are **five** `class_cancelled`
    sites, and **two** were unnamed — the second being auto-cancel's *teacher*
    notice. Auto-cancel is the one path notifying two audiences, so #195 widened
    the student list three times and never read the `notifications.push` eight
    lines below. Its own `formatDayHeader` import, added for the student body,
    sat twelve lines above the body it did not fix. **Counting paths was the
    wrong unit when the defect lives in notification sites.**
  - **Its stated blocker had expired.** #200 said the fix could not be pinned
    because :3000 served a different checkout than the PR's worktree. That
    worktree was removed when #112 merged. The environment a filed issue
    describes rots like any other claim — re-measure it before believing the
    reason something was deferred.
  - **Asserting the parts is not asserting the whole.** The review agent
    demonstrated two mutations that *passed*: dropping `...waiting` from the
    route's fan-out passed the entire integration project (27 files, 348
    tests), and swapping the student body for the teacher's sentence passed
    21/21. Three `toContain`s on the interpolated fields said nothing about the
    sentence carrying them. Both now fail; the ledger went 4 → 6 guards.
  - **A safety grep that could not fire.** Checking the PR body for accidental
    auto-close keywords, I grepped case-sensitively — it returned zero matches,
    which is exactly what "clean" looks like. Caught only because I knew a match
    *should* exist. Same principle as demanding a mutation fail.
  - Spun out **#201** (a teacher's inbox row can never link, for any type) and
    **#202** (payment notices name the class no better than cancellations did).
    An adjacent stale-snapshot residual was **not** filed — it went as an Update
    on **#182**, which owns that mechanism, with the distinction stated: #182 is
    about stale reads corrupting a *decision*, this one corrupts a *message*.

**The ratio is one-for-one, and for once that is not the interesting number.**
#185 closed by discovering that most of what it asked for already existed —
CI was already the gate. The one spin-out was found incidentally, while
censusing which routes are rate-limited, and is a live security defect rather
than debt. Two rounds running now, the most valuable output has not been the
fix but a **false sentence in a process document**: #170's was a comment
describing a `toLowerCase` that had been deleted, #185's was a hazard note
naming the wrong test file. Both cost more than the code did.

**One in, one leaf out — and the count is not the finding.** #170 closed the
email-case defect; #185 is the one spin-out, a leaf with no design decision
pending. But the thing to carry forward is *where* this round's two most serious
defects were found: **neither was inside any diff.** A test file that went dark
by reporting `3 skipped` instead of failing, and a lint error created by a
deletion two commits away from the import it orphaned. Nine reviews passed both.
Each reviewer correctly reviewed its own window; the defects lived in the gaps
between windows. **Per-diff review does not compose into whole-tree correctness**
— that is #185, and it is worth more than the ratio.

**One in, four out — and the number that matters is not the ratio, it is
six.** Six consecutive review rounds each shipped a *new* false claim of the
same shape as the one it was fixing, and the shape never varied: **a general
property asserted from one arm, one sample, or one reading.** "21 call sites"
from one grep. "Every production registration writer uses `lockClassRow`" from
reading one. "Prisma answers `P2002` in both orders" from one counterparty
shape. "3/3, both orders clean" from three runs. Every underlying measurement
was accurate; every sentence attached to one reached further than it.
**Resolving to be more careful failed four times running**, once immediately
after the agent had correctly written down its own mechanism. What worked was
structural, twice: rebuilding an artifact so it has nothing left to be wrong
about, and *deleting* a sentence instead of narrowing it. See the #174 entry.

**One in, three out — and the ratio is the least interesting thing about this
round.** #176 is a live disclosure filed as a decision with its UX cost costed;
#177 and #178 are low-priority research the owner asked for by name. #143 was
extended rather than duplicated. But the number to carry forward is a different
one: **twelve wrong claims came out of this branch, and every single one
survived a check that was structurally incapable of failing.** See the #167
entry — that is the finding, not the privacy work.

**One in, five out this round — the worst ratio yet, and the reason is real
but it is not a licence.** #166 was the first issue to open a genuinely new
domain (invitations, blocks, consent) rather than fix an existing surface, and
new tables meant new obligations nothing else covered: erasure and the
subject-access export had never heard of them (#171), and adding a fourth
participant to the class lock exposed three sites that never took it (#174).
Two of the five (#170, #172) are pre-existing defects the new surface made
reachable rather than created. Only #171 is decision-shaped, and it is filed as
a decision with its options costed, not as work.

**What was deliberately NOT filed, so the ratio is honest:** the waitlist
consent-disclosure gap (recorded in the #166 entry below, belongs to deferred
consent-copy work), and an untested `/bookings` href. Four `if (res.ok)`
silent-failure components found outside #166's subject were **fixed rather than
filed** — the family is now provably empty, which is cheaper than an issue that
would have sat. The next round should drain, not open: #170 and #174 are both
leaves with clear acceptance, and #167 is the natural pair to #166.

This is a point-in-time triage, not a
living index — re-derive from `gh issue list` when it goes stale. It groups the
backlog into shippable bundles, orders them, and flags the dependencies that
force some of that order.

## How to read this

- **Bundles** are units that share context and are cheaper to do together than
  apart. A bundle is not necessarily one PR — it's one sitting.
- **Umbrella issues** track work done in children — you *close* them, you don't
  *work* them. Both (#53, #67) are now closed; #60 is the one that remains.
- **Decision-gated** bundles need a product call before any code. Leading with
  them stalls; they're sequenced late on purpose.
- Ordering rationale in one line: finish what's in-flight and cheap → close the
  last template-route seam and the archive follow-ups → cheap correctness wins →
  the CI-reliability track → the room-lifecycle decision and its epic → the
  feature backlog.
- **A pattern worth noticing across #72 → #78 → #79 → #82 → #86 → #97:** every
  round of this line closed its stated hole and spun out new issues from the
  *review*, not from the code. #86 was the strongest case yet — one issue in,
  eight out (#94–#101) — and #97 added four more (#112–#115). The ratio is not a
  sign the reviews are too fussy, but it is worth being precise about what the
  spin-outs *are*: of #97's four, three are pre-existing problems the feature
  merely made visible, not debt it created. The tracker growing is the backlog
  becoming honest, not the work multiplying. Budget for it when scheduling #83:
  the fix is usually small and the decisions it exposes are not.

  **#119 + #120 held it at two-in-three-out** (PR #191): 2 closed, 3 filed
  (#192–#194), plus 2 Updates absorbed into #113 and #116 rather than becoming
  issues, and 1 finding homed in a code comment instead of the tracker. Open
  count **52**, re-checked against `gh issue list` on 2026-08-11 (51 − 2 + 3).
  Three PR reviewers produced ~20 findings on ~250 lines of code, which is not a
  normal ratio and is not being passed off as one — the studio reporting surface
  was genuinely under-explored, and the review paid for itself by finding two
  guards the spec *claimed* were guards and which could not fail.

  **A process hazard that bit on this round, and will bite again.** #191's body
  said "**Does not close #113 or #122**" in its scope section — and GitHub's
  auto-close parser matches `close #113` without understanding the negation in
  front of it, so the merge closed #113. (#122 survived only because the parser
  needs the keyword immediately before each reference, so the bare `or #122` did
  not match.) Reopened with an explanation, and the count above is post-fix.
  **Never write "does not close #N", "not fixing #N", or "won't fix #N" in a PR
  body or commit message** — write "#N is unaffected" or "leaves #N open". The
  phrasing existed to be honest about scope and did the exact opposite.

  **That rule is not enough, and PR #208 proved it by closing #196 while its
  body said "#196 remains open" twice.** The rule above assumes the keyword is a
  *verb* someone chose to write. It need not be. Commit `660a74c`'s body reads:

  > "The studio twin of the class-template **fix: #196**'s partial unique index…"

  "fix" there is a **noun** — *the class-template fix* — and the colon introduces
  the next clause. GitHub sees `fix` + optional colon + whitespace + `#196` and
  closes the issue. No one wrote a directive, so no amount of "don't write
  closing keywords" discipline catches it.

  **The rule has to describe what the parser implements, not what a writer
  intends:** never let a `#N` reference sit immediately after
  `close`/`closes`/`closed`/`fix`/`fixes`/`fixed`/`resolve`/`resolves`/`resolved`
  **in any grammatical role — verb, noun, hyphenated compound — with or without a
  colon between**, anywhere in a PR body *or any commit message on the branch*.

  Two second-order lessons, both of which cost this round:

  - **Check every commit message, not just the PR body.** #208's body and both
    issues filed alongside it were checked and were clean; the 67 commit messages
    were not, and that is where it was.
    `git log <base>..HEAD --format=%B | grep -inE '(clos|fix|resolv)[a-z]*[[:space:]:]+#N'`
    before merging.
  - **Then read what it prints.** That grep *was* run on #208's commits, *did*
    print the offending line, and was reported as "none in commit bodies". A
    `|| echo "none"` after a grep prints nothing when the grep succeeds, so a skim
    reads success as absence. Line 71 above records a different grep that missed
    for a different reason; the pattern is the instrument working and the reader
    not.

  **#96 held the ratio and the spin-outs are terminal.** One issue in, three out
  (~~#140~~ ✓, #142, #143) — but none is a fresh design question and none should
  spawn its own three. #140 is now closed (PR #155); #142 ships with a
  verified fix already in its body and needs only a call on which shape to take;
  #143 is bounded work with three costed options, and #136 has already advanced
  its cheapest one. The thing to watch is not the count but whether new issues
  are *leaf* issues.

  **#140 is the first round that spun out a genuine leaf and nothing else.**
  One issue in, one out (**#154**, a props-shape consistency fix), plus two
  *updates* to issues that already existed rather than new ones — #143 gained
  the e2e half of its coverage gap, #154 gained the second row. That is the
  shape to aim for: a review that deepens the existing tracker instead of
  widening it. It happened here because the change was small enough that the
  reviewers spent their attention on the prose and the fixtures rather than on
  the design.

  **#136 did the same, and its three are not leaves — two are security-shaped.**
  #147 is a leaf (render an input, or decide the field should not be creatable).
  But **#146 and #148 are the same missing ownership check on two routes**, in
  the mass-assignment family (#79, #82) this roadmap records as *finished*. They
  are leftovers from it, and they should be done together rather than one at a
  time. Neither is trivially exploitable — both need another teacher's template
  UUID — but the defect is a server-set field taken from a request body with no
  check, and #148's arrives through a `...rest` spread so its name appears
  nowhere in the handler. Worth scheduling deliberately, not draining as backlog.

  **A finding can be certain and still not worth filing — added 2026-08-18.**
  `solve-issue` §7's floor exempted any "defect a user will actually hit" from
  the four filing tests, and nothing defined *actually hit* — so a defect that
  is certainly real but needs a state the system cannot produce went straight
  to fixed-or-filed. The floor now asks for the concrete path and the state
  that blocks it; a finding that cannot supply one falls back to the four tests
  like any other, and one you are not fixing now is marked `known-open` beside
  the code, as `template-sync` is in `CLAUDE.md`. **Rarity is explicitly not
  the test** — `template-sync`'s own bug fires only east of UTC and is
  recorded, not declined. Reachability is.

---

## Recommended sequence

| # | Bundle | Issues | Gate |
|---|---|---|---|
| 1 | ~~Coverage campaign — the tail~~ **DONE** | ~~#71 #66 #69~~ → #67 ✓ closed | — |
| 1b | ~~`teacher-rooms` + #77's `hasClasses` test~~ **DONE** | ~~#53 residue, #77 half~~ | — |
| 1c | ~~`studio-*` coverage + the cron call~~ **DONE** | ~~#53~~ ✓ closed | — |
| 2 | ~~Template-route seams~~ **DONE** | ~~#86~~ ~~#83~~ (PR #230) ~~#114~~ (PR #271) — all three closed | — |
| 2b | ~~What #93 left behind~~ **DONE** | ~~#95 #98 #102 #99 #97 #94 #100~~ — all eight closed | — |
| 3 | Unpinned-list cleanup & types | ~~#59~~ ~~#58~~ ~~#81+#85~~ ~~#101+#115~~ ~~#96~~ ~~#138~~ ~~#136~~ ~~#140~~ ~~#39~~ ~~#121~~ done, then #132 + #133 + #134, **#270** | one design call left (#133) |
| 3b | Locking follow-ups | ~~#107~~ ✓, ~~#113~~ ✓ (PR #227), ~~#180~~ ✓ (PR #230), ~~#103~~ ✓ (PR #264), ~~#104~~ ✓ (PR #268), ~~#116 + #117 + #126~~ ✓ (PR #273), ~~#272~~ ✓ (PR #340) — decided Option A, enforced declaratively, and it spent five of its thirteen commits paying for lock edges the mechanism hides; then #122, #229, #232, #269, and **#339** (the class half, split out) | one decision (#229) |
| 4 | CI reliability & framework upkeep | ~~#185~~ ✓, ~~#41~~ ✓ (PR #188) — premise disproved; ~~#40~~ ✓ (PR #198) — nine components, not one, and its framework half closed unverified; then #127 (+#189) **and the three flake classes measured on PR #340's round — see the sequence below** | **no longer uncertain: three classes, measured, one already half-paid** |
| 5 | Room lifecycle & admin (epic #60) | ~~#73~~ ✓ (PR #261) — rooms born private, sharing behind its own door; ~~#76~~ ✓ (PR #262) — `isArchived` given downstream meaning by five doors; then #52 + **#259** + **#260** | **product decision** (the lock itself stands) |
| 6 | Feature backlog | ~~#119 + #120~~ ✓; ~~#112~~ ✓; #47, then #46 / #48 / #49 / #51 | product priority |
| 7 | **The studio class family, end to end** — un-triaged, see the header | #274 (tracking) + #275 ~~#276~~ ✓ (PR #306) #277 #278 ~~#279~~ ✓ (decision, closed) #280 ~~#281~~ ✓ ~~#283~~ ✓ (both PR #303) ~~#282~~ ✓ (PR #308) #284, ~~#304~~ ✓ (PR #305), #309 | **un-triaged**; one decision left on its face (#284) |
| 3c | **This week's spin-outs** — see below | ~~#146 + #148~~ ✓ done together (PR #163); #145 + #157 + **#258** (together — one column failing at three layers, see #249's round), #164, #162, #154, #142, #143, #147, #158, #161 | three are decisions (#147, #164, #258) |

- ~~**#170 — emails normalized only in the two tables #166 added.**~~ **DONE —
  PR #184, rebase-merged 2026-08-07.** 23 commits. What the work taught, beyond
  the issue:

  **The issue's own acceptance criterion 1 declared the right fix unavailable,
  and it was wrong.** It said normalising via `.transform()` in `schemas.ts` was
  "blocked" because a transform hides `.shape` from the server-owned-field walk.
  Measured against Zod 4.4.3: only an **object-level** transform does that; a
  **field-level** one leaves `.shape` fully readable. The source comment the
  claim came from did not distinguish the two, and the issue inherited the
  imprecision. **Four more corrections:** "8 email lines in `schemas.ts`" is 6;
  the five named ingress points are ten; the collision the migration was told to
  guard has zero instances *and* could not half-apply anyway (Prisma 6.19.3 wraps
  migrations in a transaction — verified against a scratch database), so the
  30-line `DO $$` guard was deleted rather than built; and every line number in
  the issue was stale by up to 116.

  **Five of my own errors, and none was caught by resolving to be careful.** A
  specified `export` broke the very guard the design was chosen to preserve — the
  implementer refused to extend the register, which is the whole point of that
  guard. The `toLowerCase` acceptance count moved **four times** (3→4→5→4). The
  spec claimed "the CHECK constraints cannot turn the suite red" and five files
  disagreed. The assertion rule was written as a **directory** (`src/services/`)
  rather than a **property**, which missed `resolveOrClaimAccount` — the sharpest
  site on the branch, because on a miss it *creates an `Account`*, which is
  #170's own defect reproduced inside the fix for it. And the comment-correction
  task's verification grep searched for the phrases wrong *before* the change, so
  it structurally could not match the five that became wrong *because* of it.

  **The rule that generalises: after deleting X, grep for X** — not for the
  claims X used to justify.

  **A table of reasons goes stale exactly like a total, if the reasons are
  decorative.** The census fix was to give each surviving line a reason. One row's
  reason was "the word inside a comment" — an incidental, not a reason — and it
  vanished on the next edit. What replaced it is stronger than any count: *the
  only email lowercasing left in `src/` is the single normalisation and the
  assertion that checks it.*

  **Three defects that reading could not have found.** A race test that had
  silently stopped racing (its Prisma hook targeted `findFirst`; a deletion three
  tasks upstream changed the call to `findUnique`, so the harness never fired and
  the test stayed green). A test file that went dark reporting `3 skipped` rather
  than failing, because the throw was in `beforeAll`. And a lint error created by
  a deletion two commits from the import it orphaned.

  **The finding worth more than the ratio:** the last two were invisible to every
  one of the nine reviews, and not through carelessness. Each reviewer correctly
  reviewed its own diff. `npm run lint`, `npm run typecheck` and the integration
  sweep are **whole-tree** operations; every review was a **per-diff** operation.
  A defect existing only in the union of several diffs is invisible to each
  individually. Only CI runs the whole tree, and only on a pushed branch.

  Spun out: **#185** (20 of 26 integration files unobserved on any branch, and a
  `beforeAll` throw reporting as "skipped"), extended with the whole-tree-check
  gap rather than filing a fourth issue for the same shape.

  **Correction, from #185's own premise verification: the paragraph above is
  half wrong.** "Only CI runs the whole tree, and only on a pushed branch" is
  right about *when* and wrong about *whether it was enough*. CI already ran all
  26 integration files, lint and typecheck against the merge result, and both
  jobs were already required checks. The gap was never a missing gate — it was
  that the gate fires after a push, and that nobody could run it locally. See
  #185 for the measurement.

- ~~**#185 — the integration suite was not re-runnable, which is why nobody ran
  all of it.**~~ **DONE — PR #186, rebase-merged 2026-08-08.** 14 commits, zero
  production code. What the work taught, beyond the issue:

  **Two of the issue's three headline claims were false, and I wrote both of
  them.** CI was already the backstop (`npm test` is bare `vitest run`; 46 + 32 +
  26 = 104, exactly what CI reported). A `beforeAll` throw already exits 1 —
  "skipped" is only the per-*test* tally, so what failed on #170 was a human
  skimming a summary line, not a gate. The reflex to build machinery for a
  symptom you have not measured is the expensive one; this issue would have
  produced a CI job that already existed.

  **The real cause was a rule that named the wrong file.** The hazard note said
  `students-api.test.ts` was the IP-rate-limited one. Its three 429s key on
  `students:${teacherId}` with a freshly created teacher — it can neither poison
  nor be poisoned. The files that actually shared a budget were `signup-api` and
  `auth-email-case`. That wrong rule told plan authors to hand-list integration
  files, and a list of 6 leaves 20 unobserved. **The blind spot was downstream of
  a false sentence in a process doc**, which is worth more than the fix.

  **Zero headroom, which the issue never named:** 5 `student-signup` call sites
  against a limit of 5/hour. One new signup test anywhere would have made the
  *first* sweep fail, in CI, with a 429 in an unrelated file.

  **Three failures of my own that the process caught, in ascending order of
  instructiveness:**
  1. I inferred from *reading* `clientIp()` that the per-IP limiters could not
     fire locally. The run disproved it. One reading is not a measurement — the
     same error shape this roadmap has now logged seven times.
  2. A guard-proving mutation used the constant `10.0.0.1`, which sits inside
     `freshIp()`'s own output range. It poisoned a live bucket for an hour and
     surfaced later as a 429 in an unrelated test. **A mutation must use a value
     the code under test cannot produce** — mutation constants now use
     `203.0.113.0/24`. The first hypothesis offered for that failure sounded
     right and did not survive arithmetic; 8 measured runs found the real cause.
  3. **The distinctness guard could not catch the regression the branch had just
     fixed.** It was proved against a *constant* and caught that; the mutation
     that actually happened was a *narrow lane space*, and at 100 draws it passes
     against both. Proving a guard can fail one way is not proving it can fail
     the way that matters. Raised to 100,000 draws; now fails with
     `expected 65536 to be 100000`.

  **The whole-branch review earned its keep again**, and on exactly the class it
  exists for: a docblock written in commit 3 was falsified by commit 7 of the
  same branch ("calls those routes 8 times" → 14; "no bucket ever reaches a count
  of 2" → a test drives one to 6). Both true when written. No per-task reviewer
  held both diffs. It also caught `npm run verify` being described as equivalent
  to CI when CI additionally builds, checks migration drift and runs Playwright —
  with `SKILL.md` documenting a `next build`-only hazard three bullets below.

  Spun out: **one** — #187, the `passkey/authenticate/options` enumeration oracle and
  its unbounded challenge store, found while censusing which routes are
  rate-limited. Filed as a decision, not as work: closing the oracle changes
  WebAuthn UX. A census of all 56 routes ruled out the other three
  unauthenticated-and-unlimited ones, and that census is in the issue so nobody
  redoes it.

**Bundle 3c exists because seven issues were filed this week and none of them
was in this table.** They lived only inside the bundle narratives that produced
them, which is how a spin-out gets quietly lost. Ordered by what they cost if
left:

- ~~**#146 + #148 — do together, deliberately.**~~ **DONE — PR #163,
  rebase-merged 2026-08-04.** Doing them together was right, and the reason was
  better than the one written here.

  **"Leftovers from the mass-assignment line" was the wrong frame.** That line
  (`#72 → #78 → #79 → #82`) is finished — for the **update** path, which is all
  it ever covered. #79 was `PUT /api/classes/[id]`; #82 was
  `PUT /api/class-templates/[id]`. Measured: `.strict()` is on 9 schemas and all
  9 are update schemas, 9 for 9; `schemas.test.ts` had key-set pins for two
  update schemas and none for any create schema. These were not instances a
  sweep missed — they were **the half the sweep never looked at**. That reframing
  is what justified a census instead of a targeted grep, and the census found a
  third instance (`teacherId` on `GET`+`PUT /api/students/[id]/privacy`, fixed on
  the same branch, no issue) plus #162.

  **Two remedies, not one.** `templateId` is server-set and no UI sends it, so it
  was dropped from both create schemas — there was nothing to validate *for*.
  `teacherId` on the privacy route is legitimately chosen by the student, so it
  stayed and gained a `TeacherStudent` link check. Both issues proposed "validate
  ownership" as an option; for the two `templateId` routes that would have been
  the worse fix, because dropping the field is what let the wizards'
  `_formCoversCreate` pins lose their exclusions and start enforcing.

  **#146's "this is not a data leak" was false.** `template-sync.ts` selected by
  `templateId` alone and wrote the victim's `teacherRoomId`, `roomCost`,
  `minRate` and `targetRate` onto a squatted row, which the attacker reads on
  their own class detail page. That query is now teacher-scoped too — defence in
  depth, added because declining it assumed the create-route fix never regresses.

  **The structural half is the part worth remembering.** Fixing three routes and
  tightening two per-form pins would have left the class of defect able to
  recur, because those pins are opt-in — they exist only because #136 happened to
  pin those two wizards. `SERVER_OWNED_FIELDS` in `schemas.test.ts` is the
  create-side counterpart to `PlainUpdateForbiddenClassField`: 21 server-owned
  names, an exceptions map with a reason per entry, exact equality in **both**
  directions over all 34 exported schemas, and a compile-time pin against the
  Prisma model key union. Some exceptions are labelled KNOWN GAP with issue
  numbers — latent defects sit beside the guard instead of in a spec nobody
  re-reads. **#73's entry is gone**: PR #261 removed `isPublic` from
  `updateRoomSchema` entirely, which turned this existing guard into the
  regression test for its own removal at zero cost, since it reads
  `Object.keys(shape)`. The count that used to sit in this sentence was
  removed with it — `type-pins.ts:56` argues against counts in prose for
  exactly the reason this one went stale.

  **Three guards on this branch could not fail, and the review caught all three.**
  The register was blind to any schema wrapped in `.transform()`/`z.union`/
  `z.array` — *measured*, 27/27 green with three server-owned fields declared.
  `SERVER_OWNED_FIELDS` could be shortened with the suite green, and `templateId`
  was one of ten names in that state. The class wizard's `description` exclusion
  was unpinned, so it would have silently become a permanent no-op the moment
  #147 landed. Two were found only because reviewers **mutated the code and
  measured** rather than reading it. This is the fifth time this repo has nearly
  shipped a guard-shaped comment; the pattern is now well enough established that
  "break it and record the verbatim error" belongs in every plan, per guard.

  **A guard the issue itself pointed at was unfalsifiable.** `POST /api/classes`'s
  `teacherRoomId` check — the one #146 held up as "the model of a correct check" —
  could be weakened to `if (!teacherRoom)` with all 18 tests passing. It now has
  both arms tested. `POST /api/classes` had *zero* integration coverage before
  this branch, which is why the whole thing survived.

  **Counts, again.** Five defects in the plan were caught by implementers
  refusing to bend code to a wrong instruction; six across the branch. My own
  errors that shipped into artifacts and had to be corrected everywhere: a P2002
  argument that described the rejected alternative rather than the shipped code;
  "#146 and #148 were found months apart" when they were filed **45 minutes**
  apart by the same sweep; "41 writes across 25 route files" when the non-Prisma
  hit was subtracted from the write count but not the file count (24 files, 28
  without); "six schemas" where `teacherRoomId` made it eight; and a "7 spreads
  reach a Prisma `data:`" count nobody could re-derive, which was deleted rather
  than corrected. **Where a count adds nothing to the argument, delete it.**

  Spun out: **#162** (`POST /api/students` returns an unfiltered student row —
  phone, birthday, address, income tier — to any teacher who knows the email,
  bypassing `StudentPrivacy`; reachable today with no UUID gate, and more severe
  than either issue this branch closed) and **#164** (the generator's `continue`
  cannot continue an aborted transaction: a teacher clicks Resume, is told it
  worked, and the template stays paused with an empty window).
- **#145 + #157 — do together; they are the same silence.** #145 is an invalid
  stored timezone degrading every teacher date to UTC. #157 is the discovery
  that **nothing watches the logs** any of these fallbacks rely on — no Sentry,
  no log shipping, and `docs/technical-architecture.md` explicitly defers
  observability. Every degrade-and-warn site in the codebase (`timezone.ts`,
  `tiers.server.ts`, `studio-class-generator.ts`) says a log line is what would
  tell you; none of them is true operationally. Fixing #145 without #157 leaves
  the next fallback just as silent, and #157 is cheap — a cron that greps the
  container log for `WARN` and emails clears most of it without the Grafana
  buildout the architecture doc is rightly deferring.
- **#161 — a raced duplicate answers with the wrong copy, and `auth/student-signup`
  leaks account existence.** Four routes, five windows, all check-then-create
  against a unique constraint with no `P2002` catch of their own, so the race
  loser gets the generic 409 instead of the route's `DUPLICATE`/`ALREADY_LINKED`/
  `EMAIL_TAKEN`/`SLUG_TAKEN`. The signup case is the sharp one and the reason
  this is filed rather than let go: `create` is reached **only** when the email
  did not exist, so a 409 is a positive oracle for "this address was free" — on
  a route whose own docstring promises "no account enumeration". Not caused by
  #121; #121's new `warn` is what makes it diagnosable at all. A leaf:
  `registrations/route.ts:246-251` already models the fix (catch `P2002` at the
  route), and for signup the right answer is the existing 200 no-op, not a 409.
- ~~**#167 — honour StudentPrivacy in the payment and registration routes.**~~
  **DONE — PR #175** (38 commits, 30 files). What the work actually taught:
  **the census that scopes the issue is the census that will be wrong.** The
  issue said the gating rule was "duplicated between the list route and the
  profile route" — two copies. It had five. A census scoped to
  `src/app/api/**/route.ts` structurally cannot see a teacher *server page*, so
  the helper the issue proposed would have become a sixth implementation. Six of
  the issue's own claims were wrong, each changing the work.
  **The real finding is not about privacy. Twelve wrong claims came out of this
  branch and every one survived a check that could not fail.** A `git grep`
  returning five hits and confirming the wrong number, because the sixth copy
  wrapped mid-phrase. A count of `StudentPrivacy` writers standing in for
  reading what they do — twice, the second time inside the fix for the first. A
  type pin (`Extract`) that only fired on the five names it already knew, so
  `surname: string` compiled clean. A component-test fixture (`'Anna b.'`) that
  was a *fixed point* of `formatStudentName`, so a recomposing component passed.
  An e2e fixture with `shareFullName: true`, so every name assertion was a fixed
  point too. And — the purest one — **my prescribed fix for a fixed-point trap
  was itself a fixed point**, in the same message where I diagnosed the pattern:
  an all-false privacy row and *no row* both project to `null`, so the assertion
  could not tell "read my row" from "read nobody's row". `shareEmail: true` and
  asserting the *released* value is what bites.
  **Mutation-test the tests, not just the code.** Every one of the above was
  found by breaking something and watching nothing go red. The reviews that
  mattered refused the mutation they were handed and ran a better one: a
  *semantic* mutation (keys right, gating off) where mine only proved shape; a
  branch *reorder* where mine deleted the branch and tripped a 403 before the
  projection was ever reached — which is how the dual-role hole surfaced, a
  teacher reading their own booking in their own class silently losing their
  tier and price with the suite fully green.
  **Centralisation moves the stakes, and the tests must move with it.** At
  merge-base the rule was five copies each governing one surface; after, one
  line governing thirteen. The `where: { teacherId }` scoping could be deleted
  with 803 tests green — three reviewers found it independently, because every
  assertion checked only the *withheld* direction. A projection returning `null`
  unconditionally passed all of them. The suite had no positive-direction test
  at all until round two.
  **The PR gate found what nine task reviews and a whole-branch review did
  not** — again. Round two turned up three untested access guards on
  `registrations/[id]`, two of them **writes**: any teacher marking attendance
  on another teacher's registration (which drives pricing and payment
  creation), any signed-in user cancelling anyone's booking. Nothing to do with
  privacy; found because a reviewer mutated a file the PR happened to touch.
  This PR had already added ownership tests for the roster route and both
  payment routes sitting beside it.
  **Decided, with the evidence:** no `shareIncomeTier` flag. `PricingBreakdown`
  prints "Tier 4 · €15.20" beside `PaymentChecklist`'s "Anna B. — €15.20" on one
  screen, and the five ratios are distinct, so the flag could not bite for any
  student who books. The tier fields were dropped instead.
  Spun out: **#176** (`GET /api/students?search=` is an oracle for the surname
  the projection withholds — filed as a decision, since gating search is a real
  UX loss), **#177** and **#178** (low-priority research the owner asked for:
  674 orphaned `Account` rows in dev and 9,064 in test, and a mutation-testing
  protocol that cannot report a false green). **#143 extended, not duplicated** —
  the e2e now guards `class/[id]` only; `students/[id]/page.tsx` is visited by
  no spec at all.
- ~~**#166 — linking requires the student's acceptance.**~~ **DONE — PR #169**
  (81 commits, 84 files, +11907/−779). What the work actually taught:
  **answering one design question first collapsed the feature.** The issue
  listed six open questions; Q3 ("does registering for a class already
  constitute acceptance?") was not open — `registrations/route.ts` already
  created the link only under `if (!isTeacher)`. Every path already treated
  student action as consent except one, so the invitation surface is one route,
  not a system. Ask the cheapest question first; it can delete the other five.
  **The owner's correction was the best change on the branch, and it deleted
  code.** The link was created at promotion, so a teacher could pick the moment
  it existed by cancelling any unrelated registration. Joining a waitlist is the
  consenting act — student-initiated, aimed at one named teacher. Moving it to
  `addToWaitlist` fixed that at the root and made `LinkConsent`, a type
  modelling "consent now" vs "consent earlier", referentless. Verified before
  deleting: `addToWaitlist` is the only writer producing a `waiting` row.
  **The bit escaped five times.** #165 could only meter the 200/201 oracle;
  closing it by construction still left a refusal code, list membership, a 500
  from a degraded email provider (untestable — `emailDryRun()` is true in CI, so
  the throwing branch never runs; found by reading), and a new 409 code added by
  the fix waves. Each was a different shape of the same bit.
  **Eleven guards were correct code no test could break** — three inside fixes
  for that same problem. Two only mutation testing could find: a whole-branch fix
  of mine retroactively vacated a test's evidence by widening a lookup to
  `mode: 'insensitive'`, and the flagship test for the `ALREADY_LINKED` fix used
  a fixture whose address differed from the invitation's, so its path never ran.
  **Break the guard, don't read it** is now the only method that works here.
  **A fix wave created a defect the review then caught.** `gdpr.ts` contained
  zero occurrences of either new table, so erasure left real addresses standing
  — and the revive path turned that residue into a live invitation email to an
  erased person's real address. Fixed for `Invitation`; `TeacherBlock` retention
  is a legal question and was filed as a decision, not guessed.
  **Deferred, deliberately, and recorded here rather than filed:** joining a
  waitlist now connects you to a teacher with no disclosure at the button, and
  leaving the queue does not disconnect you. Direct booking has had the identical
  shape all along, so this change made it visible rather than worse. It belongs
  to the deferred consent-copy work — pick it up there.
  Spun out: **#170** (emails normalized only in the two new tables; a case
  variant can create a second `Account` for the same human), **#171** (decision:
  what erasure does to `TeacherBlock`), **#172** (a teacher-only account invited
  by another teacher cannot accept by any route), **#173** (no resend, and
  editing an invitation's address notifies nobody), **#174** (three class-lock
  gaps: `removeFromWaitlist` unlocked, `completeClass` without `FOR UPDATE`, and
  an unlink/accept ordering inversion).
- ~~**#162 — the sharpest thing open, and it is not cleanup.**~~ **DONE — PR
  #165.** What the work actually taught, beyond the issue:
  **the issue's own two acceptance options contradicted each other.** It offered
  "return the same filtered shape as `GET /api/students/[id]`" *and* demanded a
  test proving the teacher gets no `incomeTier` — but that `GET` returns
  `incomeTier` unconditionally to any linked teacher, and `StudentPrivacy` has no
  `shareIncomeTier` flag. Only `{ id }` satisfied its own bar. The field count was
  9 in the issue and **16** in reality.
  **Narrowing the response does not close the hole it looks like it closes.**
  Measured, not assumed: unifying the 200/201 status would not hide row
  existence, because the already-exists branch ignores the submitted names, so one
  follow-up `GET` returns the real name either way. A unified status would have
  been another guard that could not fail. The limit (50/hour, keyed per teacher,
  shared across both write routes) meters it at 8.3 days per 10k addresses —
  a price, not a wall.
  **The PR gate is not a formality, and skipping it nearly shipped a blocker.**
  Three task reviews and a whole-branch review all passed. The four-specialist
  PR review then found the teacher `PUT` was an *unmetered twin* of the same
  oracle — `createStudentSchema` requires `email`, which lands in a `@unique`
  column, so P2002 → 409 means taken and 200 means free, probed indefinitely
  with one throwaway contact, creating no rows. 40 probes: 20×409, 20×200, zero
  429s. No task reviewer could see it; each saw one side of the pair. It also
  found that "200 = the address was registered" was false — the lookup reads a
  **Student** row, not an Account, so the bit also leaks *CRM membership in
  another teacher's contacts*, a disclosure nothing had named.
  **Four of my own numbers were wrong and caught in-branch:** an enumeration
  estimate off by 30× (14 months vs 13.9 days), the census arithmetic (46/93 vs
  49/90), "3 of 52" routes consulting `StudentPrivacy` (4, of which 3 filter),
  and a rate-limit comment asserting something untrue about the three sibling
  routes it cited — which had propagated into the spec and the plan. The
  whole-branch review found zero defects in the route logic and every one of
  these.
  Spun out: **#166** (linking requires the student's acceptance — decision made,
  six design questions open, wants its own brainstorm), **#167**
  (`StudentPrivacy` honoured in payments/registrations — decided: flags win even
  when payment is owed; reminders are in-app and blocking is the escalation), and
  **#168** (the rate limiter never reclaims dead buckets, and FIFO eviction over
  one shared 10k-key map lets an unauthenticated caller flush every limit in the
  process via `magic-link/send`'s unconditional per-email bucket insert —
  pre-existing, but it falsifies #165's own quantified claim).
  Original entry: Any teacher who
  knows a student's email gets that student's phone, birthday, home address and
  income tier in one `POST /api/students`, because the already-exists branch
  returns the raw Prisma row while both sibling read paths filter through
  `StudentPrivacy`. The same branch creates the `TeacherStudent` link with no
  consent step. Reachable today — teacher self-signup is open and rate-limited
  only 3/hour/IP, and no UUID needs guessing, unlike #146/#148. Two decisions
  before code: what the 200 branch should return, and whether a teacher may link
  a student unilaterally at all. Found by the same census that verified #146.
  **A handover comment on the issue splits it**: the response-filtering half is a
  leaf that ships on its own (the CRM form reads only `data.id`, verified), and
  the unilateral-linking question follows separately. Start there — do not let
  the product decision hold the leak fix.
- ~~**#164**~~ and ~~**#192**~~ **both closed** (PR #204, rebase-merged
  2026-08-11, 22 commits). Chose `skipDuplicates` + report, not log-only or
  rethrow: a bare `ON CONFLICT DO NOTHING` covers *any* unique key the table
  grows, which is what lets #196's index land without a clash costing a whole
  window. Four things worth carrying forward:

  **The issue's reachability table was wrong, and the codebase already knew.**
  #164 listed the class Resume as protected by the implicit `FOR NO KEY UPDATE`
  its `update` takes. An FK check takes `FOR KEY SHARE`, which conflicts with
  `FOR UPDATE` and *not* with `FOR NO KEY UPDATE` — measured both directions. So
  Resume was reachable before #196, not after it. #116's body and
  `claimStudioTemplateForGeneration`'s docstring both said so already; the issue
  contradicted them and the issue lost. **When an issue and a docstring
  disagree, measure before believing the issue.**

  **The silent half had never been probed.** #164's own comment probed `25P02`
  and reasoned about the rest. `$transaction` resolving with a positive count
  and nothing committed is what made this user-visible rather than a
  debuggability nit, and it took ten minutes to measure.

  **Auto-close did not fire.** The PR body read "Fixes the generator-family pair
  #164 + #192" — the keyword must sit immediately before each reference. Mirror
  image of #191, where `does not close #113` *did* close it. Symptom to watch:
  the open count after a merge is *higher* than `closed − filed` predicts. Both
  were closed by hand with the measurement record attached.
- **#158 — what a degraded income tier does downstream.** `PersonalPriceRange`
  says "depending on how many join", asserting the tier is settled exactly where
  it was substituted; and `TierForm` seeds its picker with the degraded value,
  so a student clicking Save overwrites the corrupt row and erases the only
  evidence. Reachable only if a CHECK constraint is bypassed — filed because a
  fallback whose downstream consequences nobody examined is half a decision.
- **#154 — both payment rows take a pre-formatted `classContext`** where every
  other component takes raw data plus a `timeZone`. Small (4 fixtures, 2 call
  sites) but it rebuilds accessible names #59 fixed for WCAG 2.5.3, so it wants
  a reviewer looking at conformance and nothing else. Pairs naturally with
  **#128**, which is on the same component.
- **#142** (the visual harness is blind in May), **#143** (three teacher pages
  with no coverage at any level, plus an e2e suite pinned to `TZ=UTC` so no e2e
  test can fail on a timezone bug), **#147** (no description input in the class
  wizard — a decision before code: render it, or drop the field from the create
  schema).

**The mass-assignment hardening line is finished — on the update path, which is
all it ever covered.** #80 closed #79 on `PUT /api/classes/[id]`; #84 closed #82
on `PUT /api/class-templates/[id]`. Between them: `#72 → #78 → #79 → #82`, four
rounds, both routes now carrying a derived update type, an allowlist, a
forbidden list and compile-time pins over a shared `NoneOf<T>`.

**The qualifier is new, and it cost something.** Written without it, this
paragraph read as "create routes are covered too", and #146/#148 were filed as
*leftovers* on that basis. They were not leftovers — every create schema was
outside the sweep, unstrict and unpinned, and a census found a third instance
plus #162. PR #163 added the create-side counterpart (`SERVER_OWNED_FIELDS`).
The lesson generalises past this line: **when recording a body of work as
finished, record what it covered, not what it was about.**

What it left behind is this table's Bundles 2 and 3. #84's review spun out three:
**#83** (the write/sync seam), ~~**#86**~~ (archiving does not freeze
already-generated classes), and ~~**#85**~~ (the template form's unpinned field
list — #81's twin). None was exploitable; two needed a product call before code.
**#86** closed via PR #93, **#85** via PR #135, and **#83** via PR #230 — all three of #84's spin-outs are now closed.

**#86 is now closed** (PR #93), and its own review spun out Bundle 2b — six
issues, plus two that landed in Bundle 3 because they are about dates rather than
templates. See that bundle for why the count is high and which two actually
matter.

---

## Bundle 1 — Coverage campaign, the tail · **DONE**

All three shipped: **#71** (PR #87), **#66** (PR #88), **#69** (PR #89). **#67 closed.**

Two things came out of it worth keeping:

- **#71's open question had a better answer than expected.** It asked whether the
  `PARTIAL_ERASURE` branch is HTTP-reachable, and said to report it unreachable
  rather than fake it. It *is* reachable: `deleteTeacherAccount` completes
  in-progress classes through an uncaught `completeClass`, and pricing throws on
  a tier outside 1–5, so both the branch and the retry its error message advises
  are covered.
- **#66's mutation testing nearly produced false confidence.** Three mutations
  "passed" and looked like weak tests. They had never applied: `'window_frozen',`
  and `if (activeCount >= cls.maxStudents) {` each appear twice in `waitlist.ts`,
  so a non-global substitution silently mutated `promoteNext`/`addToWaitlist`
  instead of `claimSpot`. **When a mutation passes, check it applied to the code
  under test before concluding anything about the test.**

---

## Bundle 1b — `teacher-rooms` + #77's `hasClasses` test · **DONE**

PR #90. `/api/teacher-rooms` went from zero HTTP coverage to nine cases, and
#77's first half is pinned — no code change was needed there, the guard was
already correct and merely untested.

The mutation worth remembering: applying #77's predicted narrowing "fix" makes
the new test fail with `expected 500 to be 400` — the exact production bug the
issue describes — while the other ten cases in `rooms-api.test.ts` still pass.
That is the concrete demonstration that a suite can be green and blind at once.

**#77 is now purely a product decision** (see Bundle 5): should a teacher be able
to attach to a private room they know the id of? Deliberately left untested — a
passing test for current behaviour would read as a settled call.

---

## Bundle 1c — the last of #53 · **DONE**

PR #92. `studio-class-templates` and `studio-classes` covered; **#53 closed.**
Every mutating route now has HTTP coverage except the five `/api/cron/*`, which
are covered at their shared helper — `requireCronAuth` had no tests at all,
which turned out to be the real gap rather than the five routes. The cron
question needed no product call: the repo's own "test shared guards once" rule
already answered it.

**It also found a live bug.** The studio family had neither of the two guards
the class family uses against re-activating an archived template — no 409 on the
route, and `generateStudioClassInstances` filtered on `isActive` alone. A
shelved studio template could be toggled active and the cron sweep would
materialise classes for it. Both layers now match; the generator test failed
with `expected 12 to be +0` before the fix.

**The pattern behind every gap in this campaign, worth carrying forward:** each
uncovered group sat adjacent to a covered sibling and shared its naming prefix
— `rooms`/`teacher-rooms`, `class-templates`/`studio-class-templates`. Reviewing
test files reads as done; enumerating routes is what surfaced them. Re-run that
enumeration rather than trusting a summary — including this document's.

---

## Bundle 2 — Template-route seams (what #82 left behind)

Both live on the path `PUT /api/class-templates/[id]` → `updateClassTemplate` →
`syncTemplateInstances`. Placed second for the same reason the hardening was:
that code was written this session and is still in working memory. Do them
together — they touch the same two files and the same mental model.

- ~~**#83 — the write and the instance sync are not atomic.**~~ **closed**
  (PR #230, together with #209 and #180). Three sequential steps — template
  write → the sync's own inner transaction → the window refill — are now one
  `$transaction` on a 15 s budget, with the `catch` outside it so a P2002 is
  mappable after rollback.

  **Two premises in this entry were wrong, and both are worth keeping.**

  First, "not implementable as written: both functions need widening to
  `PrismaClient | Prisma.TransactionClient`". Half right. `updateClassTemplate`
  needed **no** signature change at all — it *opens* the transaction, so it is
  not composed into one. And `syncTemplateInstances` needed a **narrowing**, to
  `TransactionClientOnly` (`db-locks.ts`), not the plain union: it issues
  `SET LOCAL` and `FOR UPDATE`, and `Prisma.TransactionClient` alone does not
  reject a bare `PrismaClient` — `Omit` drops members from the *type* only, so
  the full client stays structurally assignable and both statements would
  evaporate silently. One widening and one narrowing, not two widenings.

  Second, the issue's own stated blocker — that one transaction "collides with
  a documented design decision, load-bearing for #164" — **had expired.** PR
  #204 retired it three days after the issue was filed: the refill has no
  `catch` and inserts with a bare `ON CONFLICT DO NOTHING`, so it cannot abort a
  transaction it is composed into. The branch checked rather than inherited, and
  that check is what made the work startable. **A blocker recorded in an issue
  ages exactly as badly as a count does.**

  The atomicity change also concentrated lock waits that had been spread across
  three transactions, which widened a live `40P01` — hence #180 landing in the
  same PR rather than separately. See this round's spin-outs below.

- ~~**#86**~~ **closed** (PR #93). The call was neither of the two the issue
  expected. Pause and archive were made to *mean* different things: pausing stops
  generation and leaves the window alone; archiving deletes the future classes
  nobody booked and leaves the rest standing. "Nobody booked" is **no registration
  in a charged status** — not `settingsLocked` (which answers whether the price
  may change, and never resets) and not `ACTIVE_REGISTRATION_STATUSES` (which
  omits `late_cancel`, so deleting would cascade away a billable record).

  The issue's own framing — "a later edit silently reprices still-bookable
  classes" — turned out to be wrong, and the correction changed the fix. Edits
  already skip anything a student has touched, so propagation only ever reached
  unbooked classes. The disease was that archive did not touch the window at all;
  the edit-propagation was a symptom.

---

- ~~**#114 — the studio template family has no forbidden-field pin
  machinery.**~~ **DONE — PR #271, 2026-08-20.** What the work taught, beyond
  the issue:

  **The premise check changed what the fix was FOR, not just whether it was
  needed.** The issue said only `.strict()` stood between a contributor and a
  forged `archivedAt`, and that nothing was watching. False:
  `schemas.test.ts`'s `server-owned fields` register already walked every
  exported schema and refused **five of the eight** forbidden columns —
  including both columns the issue said #111 made worth forging. What the
  register cannot do is refuse its own repair: its failure message says *"add
  it to EXPECTED with a reason"*, which is precisely the reflexive grant a
  forbidden pin exists to make impossible. So the work was never "add missing
  protection"; it was "add the layer that can refuse the register's own
  quickest fix". The issue also said "four pins" — there are six.

  **A pin that consults Prisma instead of copying itself.** The class family's
  completeness pin duplicates its forbidden union and `Exclude`s it against
  itself, so it never reads the model and is blind to a column a migration
  adds — by construction, not by accident. Where the two lists partition the
  model exactly (`6 + 8 = 14`, measured), `Exclude<keyof PrismaInput, A | F>`
  states the same invariant against the generated type and goes red on the
  migration. It is the only pin in the repo a migration can turn red. When #111
  added `archivedAt` and `withdrawnCount` to both models, every pin then in
  place stayed green until a human classified them.

  **The measurement that scoped the spin-out.** The obvious follow-up —
  retrofit both class-family completeness pins — is impossible for one of its
  two targets. `Class` has **seven** columns classified by neither list
  (`teacherRoomId`, `templateId`, `cancelDeadline`, `autoCancelCheck`,
  `createdAt`, `updatedAt`, `spotBroadcastAt`), so `10 + 7 = 17` against 24
  columns. #270 is therefore scoped to `ClassTemplate` alone, with the `Class`
  measurement recorded inside it as the reason. Filing the obvious version
  would have handed someone a "mechanical" task that turns into a per-column
  design decision on contact.

  **Built via handover in a second harness (opencode), and it worked.** Six
  commits, no deviations from the plan, every predicted line reference intact.
  The handover's value was its derailer section — the two that mattered were
  "do not read the issue as your source of truth" and "the class family is your
  template AND contains one pin you must not copy".

## Bundle 2b — What #93 left behind

**All eight are now closed** — #95 (PR #105), #98 (PR #106), #102 (PR #108),
#99 (PR #110), #97 (PR #111), #94 (PR #118) and #100 (PR #125). This bundle is
finished. The original volume was a by-product of six review passes over a
destructive feature, not of the feature being shaky, and the ones worth doing
got done first — the last one out was pure consistency cleanup, and by the time
it was implemented two of its three items had been overtaken by the PRs that
closed its siblings.

**On the spin-out rate.** #97 filed four more (#112–#115), which looks like the
same treadmill — but three of them are *pre-existing* problems this feature
merely made visible, not new debt it created: waitlisted students have always
vanished silently, the studio family has never had pin machinery, and the
`toLocaleDateString` bug predates all of this. Only #113 is arguably adjacent to
the change. Filing them is how they stop being invisible; the count is not the
metric.

Two of them were found in the *fix*, not the original code — the archive
boundary compared a `@db.Date` calendar date to an instant, which both left
tomorrow's class bookable west of UTC and deleted today's class east of it.
That one was fixed inside #93; #101 was the same bug's remaining habitat, now closed by PR #137.

#95 and #102 are both done. What is left in this bundle is hardening — the
sharpest live item spun out of #102 and moved to Bundle 3b: **#107**, which is
the same defect on a student-facing path.

- ~~**#95**~~ **closed** (PR #105). Each template's generation now runs in a
  transaction that takes `SELECT ... FOR UPDATE` on the template with the
  eligibility predicate *inside the locking statement*, so Postgres re-evaluates
  it against the committed row when the lock wait ends. The issue's own proposal
  — re-read in the same transaction — would not have worked: under READ
  COMMITTED an archive committing between the re-read and the create is
  invisible to the re-read.

  **The lesson worth carrying:** holding a lock costs the other party, and the
  plan only budgeted the sweep's own timeouts. Four transactions could then
  block on it while running on Prisma's 5 s default. Three were caught in task
  reviews; the fourth — account erasure in `gdpr.ts`, and the worst, since
  `completeClass` commits pricing and payments before it opens — took the
  whole-branch pass. When adding a lock, enumerate every writer that can now
  wait on it, not just the obvious one.

  Spun out **#102**, **#103**, **#104**.
- ~~**#98**~~ **closed** (PR #106). It was **six** endpoints, not four — the
  issue was written from #93's diff, so it never saw `archive-room-button` and
  `archive-student-button` living outside `settings/` with the identical shape.
  Every endpoint now takes a required `?state=` naming the state to reach; a
  missing or unknown value is a 400, never a fallback to toggling. Already being
  in that state is a 200 `action: 'unchanged'` with no write, which is what both
  failure modes actually reach.

  The issue's second proposed fix — reworking the client's error handling —
  turned out to be **unnecessary**: once retries are idempotent, "please try
  again" stops being a trap and becomes correct advice.

  **The lesson worth carrying:** the fix introduced a success arm that returns a
  full row *without writing*, one line below the only ownership guard, and the
  route spreads that row onto the wire. Reordering the two left the whole suite
  green — every pre-existing non-owner test happened to request the state the
  row was *not* in, so the new guard never fired in any of them. Four tests,
  blind the same way for the same accidental reason. When a change adds an early
  success return, ask what guard it just moved *past*.
- ~~**#99**~~ **closed** (PR #110). A third Vitest project (`components`, jsdom)
  with 24 tests across the six toggle buttons. `docs/technical-architecture.md`
  gained a **"What earns a component test"** paragraph beside the existing
  "What earns an HTTP guard test" — the boundary is the deliverable as much as
  the tests are, or the next contributor finds an empty jsdom project and infers
  an obligation to fill it.

  **The lesson worth carrying is how it was verified.** The final review did not
  read the tests, it mutated the code: 7 of 10 mutations died with tight blast
  radius, including the literal #93 arity slip that motivated the issue. All
  three survivors became fixes — a button that fired the right PATCH then
  navigated to the wrong page, a comment claiming a discrimination it did not
  have, and a degenerate stub value. A mutation table is the honest answer to
  "is this test layer real"; a passing count is not.

  Two traps recorded for anyone extending it: a prefix regex on a confirmation
  matches a message built from the *wrong* arguments, because
  `archiveMessage`'s branches share their opening clause; and the pause message
  separates with U+00B7 MIDDLE DOT while the archive messages use U+2014 EM
  DASH, so compute expected strings from `template-action-messages.ts` rather
  than transcribing them.
- ~~**#97**~~ **closed** (PR #111). `archivedAt` and `withdrawnCount` on both
  template models, written inside the archive transaction from the
  `deleteMany`'s own count, cleared on un-archive, rendered as
  `Archived 12 Jun 2026 · 3 classes withdrawn`. The issue's proposed
  `Notification` was **rejected on inspection**: teachers have no email opt-out,
  so it would have emailed them about their own click 30 minutes later, and no
  existing notification type is a receipt for the recipient's own action. The
  cited precedents notify because *someone else* needs to know.

  **The lesson worth carrying: explanatory prose needs the same verification as
  code.** Five review agents found **four** separate false comments, and two of
  them were written *while fixing others* — a docblock claiming `remaining` "is
  a live query on the page", a test justifying itself as "reachable in
  production" via a GDPR path that writes neither column, a `formatDayHeader`
  scope note that missed two past-date callers, and a dangling `eraseTeacher`
  that has never existed. Every one read plausibly. When a review corrects a
  factual claim, grep for *every copy* of that claim — fixing only the flagged
  instance left two docblocks in one PR asserting opposite things about the
  same field.

  **The second lesson: a green suite proves nothing about the machine it did
  not run on.** `format.test.ts`'s "reads the date in UTC, not the local zone"
  was tautological in CI — nothing pinned `TZ`, and at UTC `getDate()` *is*
  `getUTCDate()`. Mutating to local accessors passed 16/16 on CI and failed
  8/10 only west of UTC. The test-run zone is now pinned to `America/New_York`,
  because no zone at or east of UTC can catch that class of bug.

  Also fixed in-PR after review: a **concurrent-archive race** — the idempotency
  guard read the row before the transaction opened, so two archives both passed
  it and the loser wrote `withdrawnCount: 0` over the winner's real count. This
  feature is what promoted that from a shrugged-at transient message to the
  durable record. Now a compare-and-swap, with the #95 lock behaviour verified
  intact by measurement rather than inference.

  Spun out **#112**, **#113**, **#114**, **#115**.
- ~~**#94**~~ **closed** (PR #118). `generateStudioInstancesForTemplate` extracted
  out of the platform-wide sweep, which now delegates to it, so there is one
  implementation. The resume writes via compare-and-swap, takes the `FOR UPDATE`
  claim, and generates — all in one transaction. It also ported the class
  family's "start is still ahead" filter, which the studio side never had: that
  was not tidiness, because generating *on resume* is what puts an
  already-started class in front of a teacher who is watching.

  **Two races the issue never mentioned, both found in review.** The resume
  could set `isActive: true` on a template archived microseconds earlier — the
  guards are read outside any lock — and the first fix for that then answered a
  racing *pause* with a 409 reading "Unarchive the template before activating
  it", because the disambiguation checked `isArchived` before "already in the
  desired state". Both are now pinned by deterministic three-transaction tests.

  **The lesson worth carrying: prose about locking needs an experiment, not
  confidence.** Five consecutive correction rounds each shipped a fresh false
  claim, four of them about row locks, and every one was introduced by the
  commit fixing the previous one. The chain broke only when a reviewer stopped
  reading the docs and ran a three-connection probe, which showed a zero-count
  `updateMany` *does* hold the row lock in exactly the interleaving the race
  tests construct — the opposite of what two rounds had just "corrected" it to.
  A second reviewer then caught the same claim surviving in the spec, five lines
  past the end of a hunk in the commit that fixed it. **When a factual claim is
  corrected, grep for every copy of it; fixing the flagged instance is the
  failure mode, not the fix.**

  Spun out **#119**, **#120**, **#121**, **#122**, and **#123** (closed with it —
  a daily clock-window flake, plus the class-family sibling it predicted, which
  turned CI red the next morning and blocked this very merge).
- ~~**#100**~~ **closed** (PR #125), and the most useful thing it did was
  establish that **the issue was wrong before implementing it**. Filed before
  #97, #98 and #118 landed, it asked for four P2025 guards, five deduplicated
  declarations and a logging fix. What the code needed was two guards, three
  deduplications, and nothing — the logging item was a duplicate of #121, which
  I had filed myself during #94's review without checking the backlog.

  Two gaps the issue never mentioned turned up in the mapping: `updateClassTemplate`
  — the function it held up as the *exemplar* — had an unguarded P2025 window of
  its own eleven lines below its guard, and the exhaustiveness guards cover only
  half the union (spun out as **#124**).

  **The lesson worth carrying: a stale issue is a spec you have not written
  yet.** The issue's three bullets read as a work list; two of them described a
  codebase that no longer existed. Mapping them against the code first cost one
  subagent pass and changed what got built — four guards became two guards plus
  three documented non-fixes, and "five inline declarations" became three plus a
  wire form that must *not* be unified, because it carries `date: string` and
  folding it in would type-check until someone passed a wire value where a
  `Date` was expected.

  **The second lesson is about counts, and it is mine.** One sentence — "all N
  template deletes are in test files" — was wrong three times: ten, then 14
  (the count on `main`, stale because the branch had added tests), then 16
  (stale again because the *fix commit* added two more). Each was measured. The
  fix, on the fourth pass, was to delete the number: it was never the claim (the
  claim is *none in production*), and a figure that moves whenever anyone writes
  a test buys nothing. Stating the counting convention was not the fix; carrying
  a count at all was the mistake.

  Also worth recording: a reviewer **disproved the branch's own justification
  with the compiler**. The split was sold as catching a future `ok: false`
  member that is not a reason — but the old union-typed form already caught
  that, as a hard `TS2339`. What it actually buys is a legible error and idiom
  consistency. Overclaiming a refactor's value in a PR whose sibling commit
  corrects six false comments is the kind of thing worth being caught on.

  Spun out **#124** and **#126**.

- ~~**#102**~~ **closed** (PR #108). Each claim now returns the row it locked:
  the raw statement still locks and re-checks eligibility, then a typed
  `findUniqueOrThrow` reads under that held lock as the last statement on the
  same transaction. The sweeps generate from what the claim returns, so neither
  *can* hold a stale object rather than being trusted not to.

  **Two lessons worth carrying.** First, a lock only protects what you read
  under it — #95 took the right lock and then discarded the row, which looked
  complete and closed two columns out of thirteen. Second, the spec asserted all
  three other callers of `generateInstancesForTemplate` were transaction-scoped;
  that was false for `syncTemplateInstances`, which holds no lock at any point,
  and the review built the interleaving where its *delete* runs off a stale
  snapshot and destroys a correct window. A safety claim in an approved design
  doc is load-bearing — check it against the code, not against intent. That
  residual belongs to **#83** — closed by PR #230, which made that seam one
  transaction and gave `syncTemplateInstances` an ordered pre-lock plus a
  re-read under it, so the stale-snapshot delete this paragraph describes is
  no longer reachable.

  Spun out **#107**.

---

## Bundle 3b — Locking follow-ups

**#107 is closed** (PR #109) — see below. The other two fell
out of #95's final review, are not urgent, and are cheap.

- ~~**#107**~~ **closed** (PR #109). The class is now read once, inside the
  transaction, immediately after the `FOR UPDATE`, and all twelve decisions
  derive from it. `waitlist.ts` was checked and needed nothing — it already read
  under the lock at all three of its sites, which made this a case of bringing
  one caller in line rather than choosing an approach.

  **The lesson worth carrying:** the reordering silently changed what an
  existing test proved. The cross-teacher test began dying at the roster check
  and never reached the ownership check it is named for — it asserted a bare
  `403`, still got one, and `NotYourClassError` ended up with no coverage at
  all. Before the plan was written the question asked was "would any test
  break?", and the answer was no. The question that mattered was "would any test
  quietly stop proving its own name?" — and status-only assertions are where
  that hides. Two messages the spec required byte-identical also turned out to
  have nothing asserting them anywhere in the repo.

  `autoCancelClasses` was the weaker, lock-free analogue and was deliberately
  left out of scope. **#174 closed it** — and found the count, not the status,
  was the stale input.

- ~~**#174 — three class-lock gaps.**~~ **DONE — PR #179** (39 commits, 31
  files, +7400/−217). What the work actually taught:

  **The issue was two fixes, not three, and it named three of seven sites.**
  Gaps 1 and 2 are one rule; gap 3 shares only the word "lock". Missing:
  `transitionClass` (identical to `completeClass` and worse — **no
  `$transaction` at all**), `deleteTeacherAccount` (the mirror: unlocked read,
  unconditional write to `cancelled`, force-cancelling a class that had just
  reached `completed` with `Payment` rows), and `deleteStudentAccount` (which
  renumbers **other students'** rows, so #174's own escape argument does not
  reach it).

  **Gap 3 does not reproduce, and the reason is worth keeping.**
  `upsert({ update: {} })` does not compile to `INSERT … ON CONFLICT DO
  UPDATE`; when the row exists Prisma emits three plain non-locking `SELECT`s.
  That is an accident, not a design — one non-empty payload restores the
  deadlock. The reorder shipped on corrected grounds. Then the PR gate found
  the cycle **is** reachable, just not from `unlinkTeacher`: reproduced 3/3
  against the booking route's real statement order. Three passes to reach the
  true version.

  **The trigger is the shape to reuse.** Terminality-only, not a mirror of
  `VALID_TRANSITIONS` — mirroring would put a second source of truth in SQL
  *and* would reject `open → completed`, which a fixture does deliberately and
  which `deleteTeacherAccount`'s CAS does in production. Sequencing it **last**
  was load-bearing and it held: every earlier guard still fails for its own
  site's reason, verified by re-running all seven mutations at the end.

  **The PR gate found six Criticals after nine task reviews, nine scoped
  re-reviews, a whole-branch review and two whole-branch fix rounds** — all of
  which had re-run the mutation table. Two were tests that could not fail:
  half the trigger could be deleted with 562 green, and one of the two
  lock-order fixes could be reverted with its whole describe green. Both found
  by breaking the thing, neither by reading it.

  **The branch introduced two defects while fixing defects** — a `{Class,
  Class}` inversion (reproduced `40P01`) with a comment denying it, and 610
  lines of DB-invariant lock tests placed in the `integration` project **two
  commits after moving a test out of that directory for exactly that reason**.

  **Measured, and worth not re-deriving:** sorting an id array is *inert*
  against a multi-row `UPDATE` — the write visits in plan order, so
  `[...ids].sort()` is a fix-shaped no-op that tests green. And a `Class` row
  lock has a fourth acquisition path — an FK `FOR KEY SHARE` from an
  uncommitted child insert — which no grep for `Class` will show.

  Spun out: ~~**#180**~~ (template family takes multiple `Class` locks in scan
  order — **closed by PR #230**, an ordered `FOR UPDATE OF c` pre-lock at both
  sites; the sort-is-inert measurement held exactly as the issue recorded it,
  and the residual at the archive is written up in `docs/lock-order.md` rather
  than closed), **#181** (`acceptInvitation` 409s a valid accept), **#182** (two
  sweeps and the attendance `PUT` still decide unlocked), **#183** (queue
  uniqueness + a write set exceeding its lock set). Updates on **#104** (posted
  saying its four-site enumeration was stale and the split was 5 bounded / 5
  not — true at that HEAD, and **both halves false by the time #104 was
  worked**: #237 moved `withdrawWaitingEntriesForTeacher` off both lists at
  once, restoring the enumeration to four and the split to 4/4. The comment is
  phrased in the present tense, so it read as a live claim about the count for
  three rounds) and
  ~~**#83**~~ (`syncTemplateInstances` is the read-then-delete its own sibling
  warns against — closed by PR #230, which put the read under the lock).

~~**Do #116, #117 and #126 as one sitting**~~ **DONE — PR #273,
rebase-merged 2026-08-20.** 23 commits. All three were the class family
measured against what #118 and #125 built for the studio side. What the round
taught, beyond the issues:

**The premise check disproved the primary issue's headline, for the third
consecutive round.** #116 is titled *"its P2002 hedge is broken"* and its body
predicts a `25P02` surfacing as a 500. That mechanism was removed by #164/#192
— `generateInstancesForTemplate` ends in a bare `ON CONFLICT DO NOTHING` and
has no `catch` at all — so the named defect **cannot occur**. PR #191's
comment on the same issue claimed a census of six call sites "four of which
drop the count"; re-measured with no `head` limit, four sites, all four
consuming. Two of three load-bearing claims stale, both corrected on the issue
at close.

**The defect that was live is the one nobody wrote down.** `pauseOrResumeTemplate`'s
write carried no `isArchived: false` and its archived guard ran in a
non-transactional read, so an archive committing in that window left an
**archived template marked active carrying four publicly bookable classes**
while the studio twin answered `archived` on the identical interleaving. The
issue asked for the claim; the CAS is what the measurement asked for, and it is
also the precondition that makes the claim's null-throw correct rather than a
500.

**A guard the branch reasoned into existence, that measurement then reversed.**
The spec specified a `throw` for the CAS-miss branch's fourth state — "a second
race stacked on the first", too exotic to answer. Review reached it three
independent ways: a resume commits between the read and the CAS, a pause
commits before the re-read, and two tabs get there. It surfaced as
`{ status: 500, level: 'error' }` — the paging level — for a case where the CAS
matched zero rows and the transaction rolled back clean, i.e. exactly what
`busy` means everywhere else in the file, and exactly what the sibling
`archiveOrUnarchiveTemplate` already answers without throwing. **"Residual, not
provably unreachable" written in a comment is an invitation to go reach it, not
a disclaimer** — and the cost of not trying was that the branch shipped a 500
where it had a 503 sitting unused in its own union.

**Two guards that could not fail, after the branch had already run eight
mutations of its own.** The `unchanged` arm's payload — whose freshness the
union's docblock advertises in as many words — was unasserted: swapping the
in-transaction re-read for the stale pre-transaction snapshot passed all 53
tests, while the route spreads that template onto the wire, so the settings
toggle would render `isActive: true` for a paused template. And the un-archive
test compared the resolver's output to the same constant it returns, so
rewording the copy to the studio's noun passed every file. This is the second
consecutive round where a reviewer applied the mutation the author had not.

**The sharpest version of that pattern, worth carrying: a half-applied mutation
confirms whatever you already believed.** `countSkipReasons`' docblock claims a
fifth `SkipReason` "fails the build here instead of vanishing". Add the reason
and it does error — so a reviewer stops there and confirms the claim. *Complete*
the change the way a contributor would — handle it, add the count to
`SkipCounts`, count it — and it compiles clean repo-wide with the new number
vanishing at every site that re-lists the fields by hand. The guarantee covered
the *reason* and not the *count*, and only the finished mutation could show it.
The test is never "does something break"; it is "does the specific thing this
claim promises to protect break".

**The same fabrication happened twice, in the correction to itself.** One
anomalous measurement (a lock probe returning after 9982ms) got a mechanism
that was false; the commit correcting it supplied a *second* mechanism that was
also false, disproved in review by two clients in one process measuring
`REFUSED 55P03 after 5ms`. It is now recorded as **cause not established**.
When the decision is already taken, the explanation is where the invention
lands — and a ledger's job is to make that visible, which here it eventually
did.

**Two sweeps the plan prescribed and nobody ran.** Both #117's
(`grep -rn "acquired none\|holds no lock" src/`) and #126's
(`grep -rn "same row lock" src/`) are written into the plan with *"Expected: no
hits"*. Run in review, both returned hits — a fourth #117 site in an API route,
and an eighth #126 site the branch itself had passed over two commits after
declaring seven. **A prescribed verification step that is never executed is
worse than none**: it manufactures the belief that it was.

**Agents mutating a shared working tree corrupted each other again — third
consecutive round, and the previous two snapshots both recommended the fix.**
One agent reported the claim-null throw firing in a test that passes 7/7 on a
clean database, from its own aborted run's leftovers, and said so honestly.
Another observed a third agent's in-flight mutants mid-review and flagged the
timestamps. Two agents left probe files in `src/services/` matching the unit
project's glob. `isolation: "worktree"` is now the third recommendation of the
same thing; the cost this round was measurement noise rather than a false
finding only because every agent re-checked `git diff` around its runs.

- ~~**#116 — `pauseOrResumeTemplate` generates without taking the claim**~~
  ✓ closed. Shipped: the CAS, the claim, the now-unreachable P2025 branch
  removed, the class family's un-archive message, and door 3 marked known-open
  with the structural decision filed as **#272**.
- ~~**#117 — the class family asserts a zero-count CAS holds no lock**~~
  ✓ closed. The spec said "two twins, both of which must move"; there were
  three — the third an API route, found only by running the sweep above.
- ~~**#126 — `gdpr.ts` is the last file saying the CAS takes "the same row
  lock"**~~ ✓ closed. Eight sites, not seven; the eighth was corrected on this
  branch two commits after the comment declaring itself last.

- ~~**#272 — decide how "an active template may not sit on an archived room" is
  enforced.**~~ **DONE — PR #340, rebase-merged 2026-08-28.** 17 commits.
  **Option A, in a declarative form the issue could not have described when it
  was filed**: #298 had moved `isActive` to `ScheduleRule`, so the predicate
  spans three tables and the trigger pair the issue proposed no longer fits.
  What shipped mirrors each parent's state onto `ClassTemplate` through
  composite foreign keys and checks the whole predicate on one row
  (`ClassTemplate_live_needs_open_room`). The five doors survive as pre-checks,
  for the sentence a teacher can act on, not for enforcement.

  **The cost is recorded where it will be read: `docs/lock-order.md`.**
  Declarative enforcement did not remove lock ordering — it moved it out of the
  diff. The design said so in its §4.4 (*"this design does not avoid
  lock-ordering work, and reading it as doing so is the error to guard
  against"*) and then drew the boundary one notch too optimistic: *"a cycle
  still requires two transactions touching two rooms in opposite orders."* A
  SINGLE-room cycle was measured (`40P01`, archive aborted) against the
  generator, and five of the branch's thirteen original commits are the payment
  — pre-lock the children, bound the pre-lock, pin both properties, then two
  rounds of CI fallout from the contention that pinning created.

  **The one item its own design left open is now closed.** §7.3 asked whether
  `ClassTemplate.teacherRoomId` warranted an index — *"measure rather than
  adding one on principle"*. It was never measured on the branch. Measured
  afterwards at 10k and 100k rows: three paths read the referencing side, two
  of them while holding the room row, and at 100k the archive cascade runs
  14.23 ms against 3.60 ms. Index added; numbers and the re-derivation query in
  `docs/lock-order.md`.

  The original entry follows, unchanged, because its reasoning is what the
  decision was made from:

- **#272 (as filed) — a decision, not a fix**, spun out of PR #273's own
  measurement rather than from reading. The invariant is currently held by
  **five application doors, every one a non-transactional read**, and door 3
  (`pauseOrResumeTemplate`'s room guard) was measured leaking:
  `{"outcome":"active","roomArchived":true,"generated":4}` — four classes
  generated into a just-archived room, which then top up indefinitely, because
  `ACTIVE_TEMPLATE_WHERE` reads only the template's own flags and never
  `teacherRoom.isArchived`.

  PR #273 closed the template's own archive race with a CAS but deliberately
  did **not** close this one: a CAS on `ClassTemplate` cannot carry a predicate
  on the related room's column, and a re-read after the CAS would close the
  measured interleaving while leaving its mirror open — a half-guard whose
  residue needs documenting forever. `room-archive.ts` already accepts this
  same race class from the other side rather than adding a `FOR UPDATE` node
  that `template-lock-order.test.ts` exists to defend. The structural answer is
  to enforce it once in Postgres, which is the call #39 made for tier ranges,
  and that is a product-and-schema decision.

  Three options on the issue, plus a fourth added after review: **instrument
  first**. The accepted race currently ships with zero observability — the
  teacher gets a success confirmation, students can book into an archived room,
  and the only record it ever happened is a JSON snippet inside a source
  comment. Accepting a race is a decision this repo has defended well;
  accepting it *undetectably* is a different one, and it does not look like it
  was taken deliberately.

- **#122 — a teacher's studio resume can turn the hourly job red on `/api/health`.**
  New surface from #118: the resume now holds the same template row the sweep
  claims, so a teacher winning that race makes the sweep's claim time out at its
  2 s `lock_timeout`, which the per-template isolation logs and then rethrows —
  reddening the `class-generation` job. Nothing is lost (the resume generated
  that window itself, and the next hourly run covers the rest), so this is a
  pure false-alarm channel that routine teacher activity can now open on a
  background job. Cheap fix: skip the `errors.push` for `55P03` specifically —
  a lock timeout against a concurrent writer means "someone else has this
  template", not "generation failed".
- **#113 — an archive that loses the lock race says "Internal server error".**
  The sharpest of the three, and the only one a teacher can see. The archive
  transaction's 10 s budget can be spent entirely *waiting* on the sweep's row
  lock — the sweep's own budget is also 10 s — and the archive sets no
  `lock_timeout` of its own, so Prisma's generic P2028 is the only thing that
  fires. `withErrorHandler` special-cases only P2002, so the teacher gets a red
  500 after ten seconds when **nothing happened** and retrying immediately would
  have worked. Fix is a `busy` variant on the result union (both routes narrow
  exhaustively, so it is a compile error until handled) → 503, plus the archive
  taking its own `lock_timeout`. Note the *other* direction is already well
  built: when the sweep loses, it gets a clean `55P03`, logged per template and
  surfaced on `/api/health`. This is about giving the teacher-facing side the
  same care.
- **#103 — room deletion vs. the sweep.** Two problems on one path. A
  `DELETE FROM "TeacherRoom"` takes `FOR KEY SHARE` on referencing templates via
  the RESTRICT trigger, which now conflicts with the sweep's `FOR UPDATE` while
  the sweep needs `FOR KEY SHARE` on the room — a genuine cycle. Narrow: both
  delete routes already refuse when any `Class` references the room, so it needs
  a template with a momentarily empty window. The second half is pre-existing and
  cheaper: neither route checks `ClassTemplate` references at all, so deleting a
  room referenced only by an archived template 500s on a raw P2003 instead of
  returning 409.
- ~~**#104 — no `lock_timeout` on the four pre-existing row-lock sites**~~
  **DONE** — PR #268, merged 2026-08-20. The four (`waitlist.ts` ×3,
  `registrations/route.ts`) now take `lockClassRow`, so **every production
  `Class` row lock goes through `db-locks.ts`** and `grep 'lockClassRow('` is
  the whole answer. #237's exception list was **deleted, not updated** — an
  empty list still rots.

  **This entry's own premise was the thing that was wrong, and it is left
  visible rather than struck through.** It said "No live bug — #95's review
  confirmed the lock sets are disjoint today", and set its own trigger: *keep it
  only if the booking path's unbounded wait starts to matter*. Both were true
  when written and false by the time it was worked. `autoCancelClasses` locks
  in-window open classes every 60 s, and GDPR erasures hold `Class` rows across
  transactions budgeted at 20 s / 10 s. The trigger had fired and nothing
  re-checked it — which is why the premise is corrected here rather than the
  line simply crossed out, so the same "disjoint, so no bug" reasoning is not
  available to inherit again.

  Sharper still: **the lesson that predicted this sits 300 lines above it in
  this same file** — "when adding a lock, enumerate every writer that can now
  wait on it, not just the obvious one" (the #95 entry). The spec re-derived it
  from scratch. The failure was not missing knowledge; it was a per-issue
  conclusion outliving the conditions it was drawn under.

  What the fix actually buys was also mis-stated: `P2028` already mapped to 503
  and all three routes already ran through `withErrorHandler`, so this is a
  **connection-occupancy** fix, not an error-quality one. Measured old
  behaviour: a contended `promoteNext` failed at **7014 ms** against a 7 s hold —
  it waited the hold out and failed afterwards, because Prisma cannot cancel a
  statement already blocked in Postgres.

  **The transferable finding is about sweeping, not locking.** The spec
  enumerated the documentation to correct two ways — `grep '#104'` (9
  locations) and reconciling the branch diff (5) — and called it complete. It
  missed **six**, all describing the old shape without naming the issue, in
  files the branch never touched. Three axes are needed: keyword, diff, and
  **concept** — the vocabulary of the thing being removed. *When a change makes
  a claim false, search for the claim, not for its citation.* Proximity is no
  protection: two of the six sat inside or beside text the fixing task had just
  edited, and one contradicted a sentence written 140 lines below it in the same
  file. Final count: **20 locations**, and the PR review then found five more in
  test files the sweep had excluded by construction.

  Five artifacts of this branch were caught wrong by the people executing them,
  not by their author: the spec's location count (twice), an unpredicted
  assertion *inversion*, a `200` that was a `201`, and three dispatch sentences
  transcribed faithfully into source — including one asserting "this branch
  changes no behaviour" in a permanent docblock, where "this branch" has no
  referent at all. Dispatch prose is source code.

  Spun out: **#269** (a benign lock race reddens the reconciliation sweep on
  `/api/health`; `reconcileOne` already computes the transience it needs and
  discards it — extended with the `promoteAfterCancel` log-message branch split
  rather than filing a second issue).

  Ratio: **one closed, one opened** — a leaf, with a named fix and the
  observation that the information it needs is already computed. Two further
  findings deliberately did **not** become issues, which is the part worth
  copying. The `.catch(() => -1)` that discards an error unlogged got a
  **comment beside the code at both sites** rather than a tracker entry: it
  matters only to someone standing at that line, and #268's own binding
  constraint (no executable changes in a documentation wave) is why it was not
  simply fixed. And the `promoteAfterCancel` log-message split was folded into
  #269 as an update rather than filed alongside it, because both are the same
  problem — `handleSpotFreed`'s failures not arriving anywhere a human can act
  on — and they touch the same call sites.

  Worth noting against the ratio: this round's PR review produced **23 findings
  across four specialised agents**, and one issue came out of them. Most were
  false or stale claims in prose, fixed in place. A review that finds a lot is
  not the same as a round that should file a lot.

---

## Bundle 3 — Unpinned-list cleanup & types

Small, independent follow-ups from earlier PR reviews. Cheap wins.


- ~~**#59 — reminder `aria-label` collides**~~ **DONE** — PR #130, merged
  2026-07-30. Grew well past "tiny": the issue named the *best* of three
  colliding buttons. Mark paid and Undo had no disambiguator at all and collided
  for any two outstanding payments. All three now carry
  `"{type} · {day} · {time}"`, which is also the visible caption (one string, so
  the two cannot drift), and Mark paid was reshaped to `Mark paid — {name},
  {context}` for **WCAG 2.5.3** — the old form split its visible text across the
  accessible name. First component test under `src/components/class/`.
  Spun out: **#129** re-scoped from a copy nit to the same 2.5.3 failure on
  `payment-checklist.tsx`. **#128** (`MarkUnpaidButton`) is the third instance.
- ~~**#58 — `usePaymentActions` generic over `PaymentStatus`**~~ **DONE** — PR
  #131, merged 2026-07-30. Not localized in the end. The issue's own fix
  (`<S extends string>`) was rejected: under a caller-chosen union the undo
  response has to be *asserted*, which is unverifiable by construction. A
  concrete `PaymentStatus` made it checkable, so the unchecked cast became a
  real guard in a new `src/lib/payment-status.ts`. **Five** widening points, not
  the three scoped — the fifth (`class-list.tsx`'s rollup, where a typo made a
  completed class read `· ✓ all paid` while payments were overdue) surfaced only
  in the final whole-branch review.
  The PR review then found a **pre-existing Critical** in the function the PR
  rewrote: `undo` reported a *committed* undo as "Network error", leaving a
  stuck "✓ Paid" row with the reminder button hidden for a real debt. Fixed
  here. Spun out: **#132** (`attendance-list.tsx`, same anti-pattern for
  `RegistrationStatus`), **#133** (payment-state literals bypassing
  `paymentStateText`), **#134** (`markPaid`'s milder version of the same catch).
- ~~**#81 + #85 — both edit forms restate their schema field lists**~~ **DONE** —
  PR #135, merged 2026-07-31. Done as one sitting, as this roadmap said to.
  Both issues recommended a fix that does not work, and the spec records why:
  the service-side update type carries `date?: Date` where the form sends a
  string, and every schema field is `.optional()` so typing the payload cannot
  see a *missing* key — which is the entire defect. Pins were the only option.
  Ten of them, each mutation-verified. `ECONOMIC_FIELDS` moved to
  `src/lib/class-fields.ts` (zero imports) so a client form can value-import it
  without dragging server-only pino into the browser bundle.
  **The honest limit, worth carrying forward:** the pins make schema↔field-list
  drift impossible but cannot pin field-list↔**rendered input** — no type sees
  JSX. A field can still ship unrendered; it just has to pass a compiler error
  naming it. The tests' key-set assertions are the last line of defence there.
  Found late and fixed: `TemplateForm` was forward-pinned against both schemas
  but reverse-pinned against one, *under a docblock arguing for both* — and
  since `createClassTemplateSchema` has no `.strict()`, an extra key there was
  **silently stripped**. The PR review then found the payload tests were
  value-blind (swapping `roomCost`/`targetRate` under their correct keys passed
  everything) and that both forms let schema `.refine()` violations reach the
  server. Both fixed.
  Spun out: **#136**, the remaining unpinned forms.
- ~~**#136 — the remaining edit forms restate their schema field lists**~~
  **DONE — PR #153, rebase-merged 2026-08-02.** The issue named eight instances;
  a census of every `body: JSON.stringify` under `src/app` and `src/components`
  found **twelve**, and **ten forms** were changed: eight own their schema and
  take both pins, two share `updateStudentSchema` and take the reverse pin only.
  24 pins, every one proved to bite by breaking it. Ten new component tests.
  Two duplicated enum arrays extracted to `src/lib/class-options.ts` and pinned
  once. `vitest.config.ts`'s components glob widened to `src/app/**/*.test.tsx`
  — **#143's own option 1**, so that issue is partly advanced.

  Spun out, all three from a pin failing where it should not have:
  **#146** (`POST /api/classes` writes a client-supplied `templateId` with no
  ownership check — squatting a `(templateId, date)` pair silently suppresses
  another teacher's generated class), **#147** (no description input in the
  class-creation wizard), **#148** (the same hole on `POST /api/studio-classes`,
  invisible because the key arrives through a `...rest` spread).

  **One of the two is now unblocked:** `edit-room-form.tsx` was waiting on
  **#73**'s `isPublic` decision, which PR #261 settled — the field left
  `updateRoomSchema` altogether, so the form has nothing left to pin. Still
  blocked: `profile-form.tsx` on **#46**'s `photoUrl`.

  **The lesson that generalises past forms.** The whole-branch review found what
  five task reviews could not, because each saw only its own diff: four forms'
  pins certified a *type* that nothing connected to the *sent body* — the body
  was an unannotated literal beside the pin, so a stray key compiled clean. The
  rule that came out of it is now the branch's dividing line and applies to any
  future pin: **a payload annotated with a form-owned, all-required type holds;
  an all-optional wire type, or no annotation, does not.**
- ~~**#101 + #115 — dates keyed on UTC rather than the teacher's day**~~ **DONE** —
  PR #137, merged 2026-07-31. Done as one change because they are the same
  mistake from opposite sides, and the spec states the rule once: a `@db.Date`
  column is a calendar date (UTC accessors); `new Date()` is an instant
  (`startOfLocalDay` first). #101 broke the second, #115 the first.
  **Both issues undercounted.** #101 named two sites; there were **six** — the
  four it missed include `dimPast` greying a 19:00 Los Angeles class from noon
  on the home screen, and `settings/reporting/page.tsx` counting a studio class
  dated *tomorrow* toward reported earnings, found only in the final
  whole-branch review. #115 named two; the third was the student's birthday,
  which needed `timeZone: 'UTC'` rather than `formatHistoricalDate` (that
  appends a year the UI omits). `itemDateTime` was deleted, not repaired —
  `classStartInstant` already did the job.
  **Worth carrying forward:** the two halves hide differently. #115's failure
  reads the host zone and is invisible at `TZ=UTC`; #101's is host-independent
  and wrong everywhere. Conflating them produced three false comments on that
  branch before it was measured instead of argued.
  Spun out: ~~**#138**~~ **DONE — PR #144, rebase-merged.** `validateSession`
  now carries `defaultTimezone` on the *teacher branch* of the `SessionUser`
  union, required rather than optional: reading it forces narrowing to a
  teacher (a review compiled the union in isolation to confirm `StudentSession`
  literally cannot reach it), and required placement made the compiler
  enumerate every construction site. Three page queries deleted, plus a fourth
  serialised round trip on the home page whose only reason to run first was the
  coupling this removed. Zero rendered output changed.

  Spun out: **#145** (an invalid stored timezone silently degrades every teacher
  date to UTC — unreachable through the app's own writes today, but an IANA
  rename needs no mistake by anyone, and this change put the value on every
  authenticated teacher request).

  **Worth carrying forward — the same miscount three times, all mine.** The code
  was right every time; the prose was not. "Byte-identical" was fixed in one of
  three places on #96's branch; the `firstName` census was fixed in `types.ts`
  and left standing in the spec; "exactly two break sites" was fixed in the code
  and left in the spec (×3) and the plan (×2). The plan's version was the worst:
  it told an implementer to *stop and report* if `tsc` errored outside the named
  file, turning its own undercount into a hunt for a phantom constructor.
  Root cause of the first count: a sweep run as
  `grep -n -A6 "sessionId:" … | head -24`, whose own flag truncated the output,
  recorded as a census. **A grep with a `head` limit is not a count**, and
  fixing one instance of a claim is not fixing the claim.
- ~~**#121 — `withErrorHandler` logs unhandled errors with no request context.**~~
  **DONE — PR #160, rebase-merged.** The issue proposed a two-line fix. The real
  defect was structural: the function had **two exits and only one logged**, so
  the `P2002` silence was a property of *position*, not decision. It now
  classifies via a pure `src/lib/api-errors.ts` and has exactly one log call and
  one return, both unconditional. 76 wrapped handlers across 50 route files, and
  **zero route files changed** — which is the evidence the new signature was
  genuinely source-compatible rather than made to fit.

  **The lesson: this branch's code was never wrong; its prose was, five times.**
  Two task reviews, a whole-branch review, five specialised PR reviewers and two
  scoped re-reviews found **no defect in shipped runtime behaviour at any point**.
  Everything fixed was a latent hazard, a test that under-specified its own
  claim, or a comment asserting what the code did not do. The worst was a claim
  about **#113** that I invented and propagated to **nine places** — four
  comments, three documents, two commit messages — and used as the *justification*
  for a test. #113 actually proposes a `busy` variant on the service result
  unions so exhaustive narrowing makes an unhandled case a compile error, which a
  catch-all classifier structurally cannot do. I inherited "same handler" from
  #121's own Related note and never checked it against #113 — **the one premise I
  verified everything except**. Also: a "two routes" census that was really four,
  a **disabled** lint rule (`no-unnecessary-condition`, NOT CONFIGURED) cited as
  evidence, and a spread-order fix that reached the code but never the spec or
  plan while the census correction reached the spec but never the code — the same
  corrected-in-one-copy defect running in **both directions on one branch**.

  **Two guard lessons worth keeping.** A 10-mutant matrix reported "no survivors"
  and was true only for whole-object mutations: hoisting `err` above the spread
  left every test green, because the clobber test pinned `method`/`path` but not
  `err`, and `expect.any(Error)` pinned only the class. And the recorded `tsc`
  proof for one step **was not proof** — the dev server on :3000 regenerates
  `.next/types/**`, which `tsconfig.json` includes, producing that exact error
  fingerprint on an unmodified tree. Every `tsc` proof now passes
  `--incremental false`. Ask not just "did it fail?" but "could it have?"

  Three latent hazards the reviews caught: `status: number` reaching
  `new Response` (a typo would throw `RangeError` **inside** the catch, leaking
  the stack trace the wrapper exists to contain — now `409 | 500`); `detail`
  clobbering pino's own `level`/`time`, emitting a duplicate JSON key that parses
  to a string no numeric filter matches (now a compile error); and `throw
  undefined` logging no error at all, since pino drops an undefined `err`.

  Spun out **#161** (raced duplicates answer with the wrong copy, and
  `auth/student-signup`'s raced 409 is a positive oracle for "this address was
  free", breaking that route's own documented no-enumeration contract). Extended
  **#157** with the `err`-serialization PII channel and **#113** with two things
  it needs: its "Applies to" scope excludes the pause/resume path that shares the
  same lock-race exposure, and `55P03` is a SQLSTATE that would never match
  `err.code` (Prisma surfaces it as `P2010` with `meta.code`).

  **Not fully closed by this:** #121's headline operator scenario is 2/3 done.
  `DELETE /api/account` is distinguishable; studio archive and resume are both
  `PATCH /api/studio-class-templates/<id>`, separated only by `?state=`, which
  the `pathname`-only privacy rule deliberately excludes (`?search=<name>` would
  log student names). That remainder is #113's, and is recorded there.
  Round ratio: **1 closed, 1 opened, 2 extended.**
- ~~**#96 — the same class date renders four ways via three mechanisms.**~~
  **DONE — PR #141, rebase-merged.** The issue reported four formats; a
  pre-spec sweep measured **eight across ten sites**, and the whole-branch
  review found a **ninth** on the create-class review step, which rendered the
  raw `<input type="date">` value (`2026-06-12`) — invisible to an audit that
  greps for formatter calls. Now three day-first formatters (`Friday, 12 Jun` /
  `12 Jun 2026` / `12 Jun`) plus two grouping labels, every local copy deleted,
  the last `toLocaleDateString` call gone, and the rule written into
  `docs/design-brief.md` — which mentioned dates **zero times** before, which is
  how eight formats grew without anyone doing anything wrong.

  Spun out: ~~**#140**~~ ✓ (below), **#142** (the visual harness's leak detector
  is blind in May) and **#143** (three teacher detail pages have no coverage at
  any level).

  **The lesson worth keeping.** The logic was never the hard part — the branch
  produced **six** comments asserting things the code did not do, each found by
  a different reviewer, and I authored all six. Counting words in prose ("both",
  "five files", "one caller") went stale every time the code moved under them; a
  sweep for count words beats fixing them one reviewer at a time, and naming
  call sites instead of counting them is what finally stopped it. Two other
  claims of mine were falsified by measurement: that `p.paidAt` would render
  "byte-identically" (the string flips day-first like everything else; only the
  *defect* is preserved), and that 6+ visual baselines would move (**zero** can
  — `freezeDates` replaces every date with a placeholder before screenshotting,
  so a baseline never contains a date format). Task 4's real deliverable turned
  out to be a harness fix without which `npx playwright test` could not run on
  the branch at all.
- ~~**#140 — the payments page renders `paidAt`, an instant, as a UTC calendar
  date.**~~ **DONE — PR #155, rebase-merged 2026-08-02.** The one-line claim
  held, and was verified rather than inherited: all **22** call sites of the
  three UTC-accessor formatters were classified (18 `@db.Date`, 2 already
  through `startOfLocalDay`, 1 a date-only ISO string, **1** raw instant), and
  the schema's 44 other instant columns reach none of them.
  **It was not a one-line PR, and the reason generalises.** The render sat
  inline in an **async server component**, which RTL cannot render — so the fix
  would have shipped with nothing able to catch its regression, on a bug that
  had already survived one PR (#96 preserved it deliberately). `ReceivedPaymentRow`
  was extracted beside the already-tested `OutstandingPaymentRow`; the Received
  rows were the half that never got extracted. **`paidAt` is passed raw with a
  `timeZone` beside it**, not pre-formatted — otherwise the conversion stays
  outside the tested unit and the extraction buys nothing.
  A design question from Ivo — *is a uniform approach not better long-term?* —
  reversed the spec's framing: the raw+`timeZone` shape is not a divergence from
  the sibling, it is the **codebase convention** (`ClassList`, `ArchivedRecord`),
  and the pre-formatted `classContext` is the lone exception. Spun out as
  **#154**, filed rather than folded in because it rebuilds three `aria-label`s
  #59 fixed for WCAG 2.5.3, where one character regresses conformance silently.
  **Worth carrying forward, and it is the same lesson a third time.** Four
  reviewers returned **zero** Critical and zero Important on the code. The one
  Important was in *prose*: "the 45 other instant columns" counted `paidAt`
  twice — 44 — in a spec written after PR #144's postmortem about exactly this.
  A reviewer also separated two true claims the spec ran together: the suite's
  `TZ` pin guards `formatDateShort` regressing to local accessors, while this
  PR's tests fail under *any* host zone. And the corrected wording had a twin in
  the plan's comment template, found only by grepping the phrase across every
  artifact. **The code has stopped being where the errors are.**
- ~~**#39 — shared `IncomeTier = 1|2|3|4|5` + restructured `PricingResult`.**~~
  **DONE — PR #156, rebase-merged 2026-08-03.** 20 commits, the largest item in
  this bundle.
  **The issue's premise was half right and the check mattered.** "Caught only by
  the engine's runtime throw" — `updateStudentSchema` already bounded the one
  route accepting a client tier. But the hole was real, and
  `account-api.test.ts` already exploited it, with a comment naming #39 and
  asking to be re-pointed when this landed.
  Ivo's call: **DB CHECK constraints alongside the type**, so the value is
  unrepresentable in Postgres too, not only in TypeScript. That turned the
  narrowing helper's fallback into genuinely dead code rather than a guess.
  Then, from the whole-branch review: **the billing path throws where the
  display paths degrade.** `toIncomeTier` substituting the median tier is right
  for a public booking page (a wrong estimate beats a 500) and wrong for
  `completeClass`, which writes a `Payment` and notifies the student — a tier-1
  student billed at tier 3 is a ~54% overcharge fixable only by hand. Throwing
  there is free: `completeClass` is one transaction, so it rolls back and stays
  retryable.
  **Worth carrying forward — the errors were all in prose, and the counts were
  mine again.** Six task reviews plus a whole-branch review plus a five-reviewer
  PR review returned **zero Critical in the code**. What they found: an
  assertion census I stated as "4 of 6 removed" when the branch had actually
  gone 9→8 (my verification grep required a leading dot and so structurally
  could not see the two local-variable assertions the same task added — now
  9→4); a `PricedStudent.price` docblock claiming "whole cents" on a field
  holding a decimal; and a docblock saying `tierAtBooking` is "stamped once"
  after I had correctly told Ivo in chat that reactivation re-stamps it — right
  in one artifact, wrong in its twin, yet again.
  **Three guards existed but could not fail**, all found by the PR review and
  all now proved to bite: `INCOME_TIERS`'s `satisfies` pinned membership but not
  completeness (`[1,2,3,4]` compiled); the nine pinned prices could not detect a
  tie-break regression (every tie was a complete pair, so flipping the sort
  moved nothing); and reverting the billing throw to the degrading helper broke
  zero tests. **A guard nobody has watched fail is not a guard** — that is the
  lesson this branch keeps re-teaching, now at three different levels.
  Spun out: **#157** (nothing watches the logs these degrade-and-warn fallbacks
  rely on — verified: no Sentry, no shipping, observability explicitly deferred)
  and **#158** (what a degraded tier does downstream — a price presented as
  tier-certain, and evidence a student can erase with a no-op save).

---

## Bundle 4 — CI reliability

#40 and #41 both surfaced from the same `teacher-journey.spec.ts` flake
investigation (CI run 29991472315). **Both are now closed, and between them they
say something worth keeping about issues written from a flake.** #41's half was a
misread instrument, not a flake at all. #40's half split cleanly in two: a real
product defect worth nine components of work, wrapped around a framework claim
that could never be re-measured and was closed unverified rather than held open.
The instruction to re-measure before designing was right — and what it found was
that the *design never needed the framework claim at all*.

Flaky CI still erodes the "green means green" signal every other PR depends on.
Sequenced here rather than first only because what remains is uncertain and none
of it blocks the cheaper work above.

---

### The flakes, measured (PR #340's round, 2026-08-28)

**"Uncertain" above is now out of date for the part below it.** `main`'s last
20 runs: **17 success, 3 failure — 15%**, not the 60% a five-run sample
suggested. Re-derive with:

    gh run list --branch main --limit 20 --json conclusion \
      --jq '[.[].conclusion] | group_by(.) | map({k:.[0], n:length})'

Three failures, and **no two share a cause**. That is the finding: this is not
one flake, it is three.

**Status after PR #341 (2026-08-28): A fixed, B established and already fixed
before it was triaged, C diagnosed and not yet fixed.** Only one of the three
turned out to need the round it was scheduled for — and the two that did not
were settled by re-deriving their evidence rather than by working the queue.
Neither the "three PRs" nor the order below survived contact; the sections
under each class say why, and the honest version of the finding is that **a
triage table built from CI log text needs its rows re-derived before they are
scheduled**, not after.

| # | Class | Observed | What it actually is |
|---|---|---|---|
| A | Heap-order assertion — **DONE, PR #341** | `db-locks.test.ts > lockClassRowsOrdered > returns the locked ids ascending…` (main, 2026-08-27); `db-locks-lock-order.test.ts > serialises two callers whose natural orders disagree` (local, PR #340); `gdpr.test.ts > does not deadlock when a teacher erasure and a student erasure overlap` (main, 2026-08-16) — **three sites, not the two this row first listed** | A **correct intent on an unguaranteed mechanism** |
| B | Concurrent-create retry safety — **ESTABLISHED, and already fixed** | `studio-api.test.ts > POST /api/studio-class-templates is retry-safe on the slot key` (main, 2026-08-27 **05:40Z**) | A real race — and the run predates its fix by four hours |
| C | e2e soft navigation — **DIAGNOSED, not a budget** | `class-edit.spec.ts:129 > a draft edits fully` — `page.waitForURL: Test timeout of 30000ms` (main, 2026-08-27). The `App did not become healthy within 30s` half of this row **was never a failure** — see below | A **client-side navigation that fetches and never commits** |

**Class A is not a bad test, and that distinction decides the fix.** It reads:

```ts
// The premise, asserted rather than assumed: unordered, this table hands
// back insertion order, which is the REVERSE of ascending.
expect(heapOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);
```

The intent is exactly right — it stops the real assertion below it from going
vacuous if the table's natural order ever agrees with sorted order. What flakes
is the instrument: **an unordered `SELECT` has no guaranteed row order in
PostgreSQL**, and page reuse, autovacuum or a different plan can flip it.

**PAID — PR #341, 2026-08-28.** Three commits, and the round revised three of
the claims above.

**The mechanism, measured.** The order is the heap's: both plans observed drive
from `Seq Scan on "Class"`, so the statement returns physical order. `Class` is
**one 8 KB page** shared with every file in the parallel tier, and a
neighbour's `DELETE` plus autovacuum frees a low line pointer that the
fixture's *second* insert takes. Reproduced deterministically — insert a filler
row, insert HIGH, delete the filler and `VACUUM`, insert LOW → `LOW@(0,1)`,
`HIGH@(0,22)`, and the read returns them ascending, which is CI's exact
signature from run `33060957297`.

**`synchronize_seqscans = off` was the wrong half of the suggestion above, and
measurement is what says so.** Synchronised seq scans engage only above
`shared_buffers / 4` — 4096 pages at the default 128 MB. `Class` is one page.
Re-derive with:

    docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -X \
      -c 'show shared_buffers' \
      -c $'select pg_relation_size(\'"Class"\')/8192 as pages'

**Constructing the order was the right half, but not at the probe.** Two
constructions were measured and rejected before the third worked: forcing the
plan moves the order onto `Class_calendarEntryId_key`, i.e. onto a *random*
entry uuid (20/20 tracked it, 12 of 20 the useful way); a function scan with
ordinality leaves `Class` as the outer relation and changes nothing (15/15
tracked the heap). What worked was assigning the sort key rather than the
probe — `calendarEntryId` set anti-correlated with the class id, so the forced
plan returns the order the fixture chose. 24/24, including 12 runs against a
deliberately inverted heap.

**There were three sites, not two.** `gdpr.test.ts:1634` carried the same
premise and its own comment already recorded it failing on 2026-08-16. The
table above listed two because it was built from CI failures rather than from
`grep`; the cheap habit that would have caught it is the one §3 already
states.

**Two of the three sites take the same fix; the third takes a different one.**
`db-locks-lock-order.test.ts` and `gdpr.test.ts` both force their callers'
plans and assign the sort keys those plans order by, so both premises are
constructions rather than observations. `db-locks.test.ts` carries
non-vacuity in a shuffled five-row seed instead, because it asserts a return
value rather than staging a race.

**A REVIEW ROUND CORRECTED THIS ENTRY, and the correction is the useful part.**
`gdpr.test.ts` first shipped with its teacher-side premise simply DELETED, on
the stated ground that both its callers are production functions whose plans a
test cannot force. **That was false, and the counter-evidence sat sixty lines
below the comment asserting it**: the file already forces
`deleteStudentAccount` — equally production code — through a Prisma `$extends`
hook on `$executeRawUnsafe`, and `deleteTeacherAccount` issues the same
`setLockTimeout` statement that hook keys on. Both are forcible. "Could not"
was "did not", and the difference was one grep.

**What the deletion cost, measured on the way to replacing it.** With the heap
inverted so the two natural orders agree, and `ORDER BY c.id` deleted from the
helper, the test passed **3/3** — a green run on broken code, not vacuity in
some weaker sense. Restored and forced, the same mutation fails **3/3** with a
real `40P01`, and the premise itself holds 3/3 against that inverted heap.

**So one site still trades, and only one.** `db-locks.test.ts` cannot go red
from row order — `ORDER BY c.id` sorts whatever it is handed — and what a
hostile heap costs it is a run that proves less than it appears to, at 1
arrangement in 120. Vacuity rather than flake, and the whole of the trade this
round makes. The other two sites make no trade at all.

**Mutation rates, measured with the clause deleted from the helper**, because
the three are not interchangeable: `gdpr.test.ts` fails 3/3 with a real
`40P01`; `db-locks.test.ts` fails 3/3 on its id assertion;
`db-locks-lock-order.test.ts` fails 3/3, of which the deadlock accounts for
1/3 and the id assertions the rest. The primitive test's docblock claimed the
deadlock was its mechanism — that claim is now corrected in place.

**Two of this class were already paid on PR #340's round** and are the worked
examples for the rest:

- `room-archive.test.ts`'s busy case started a holder transaction and called
  the contender without waiting for its `FOR UPDATE` to land. Whichever reached
  the row first won; locally always the holder, on CI often not. Fixed with an
  acquisition barrier — **an ordering guarantee, not a longer timeout**.
- `class-lifecycle.test.ts`'s tier guard runs `ALTER TABLE "Registration" DROP
  CONSTRAINT` inside the parallel tier. `ACCESS EXCLUSIVE` queues behind every
  concurrent reader of that table and blocks them in turn — victim and
  perpetrator. Moved to its own file on `LOCK_CONTENTION_TESTS` rather than
  given a bigger budget, because a bigger budget would have let it pass while
  still blocking its neighbours.

`LOCK_CONTENTION_TESTS` (`vitest.config.ts`) exists from that round and is the
mechanism the rest of this bundle should reach for. Its criterion is stated
there: a file that **creates** lock timing, or one whose assertion is
**destroyed** by it.

### Class C, diagnosed (2026-08-28) — and it is neither of the things this table first called it

**The health-check half of class C never happened.** `App did not become
healthy within 30s` is the `run:` script being echoed into the log by GitHub
Actions, not a message anything printed. It appears **verbatim in successful
runs** — check `33172726315`, which passed:

    gh run view <id> --log | sed 's/\x1b\[[0-9;]*m//g' | grep "become healthy"

In the failing run the health check passed on its first `curl`: the step was
entered at `16:45:10.694` and the next step began at `16:45:11.814`, 1.1s
later. **Raising that budget would have changed something that has never
fired** — precisely the blind raise this section warned against, and the
warning was aimed at the wrong half of its own evidence. The row was assembled
by grepping the log for error-shaped strings, which is how a script listing
became a symptom.

**The real failure passed on retry.** Playwright reported `1 flaky`, `14
skipped`, `127 passed`. The run went red because `playwright.config.ts` sets
`failOnFlakyTests: true` — a deliberate #293 decision whose comment says why
("a fail-then-pass exits 0 by default, which is the last place a red can
become green without anyone deciding to"). **That is working as designed and
is not part of this bundle.** What is left to fix is the intermittency itself.

**It is not a budget, and the app was not slow.** From the uploaded trace
(`playwright-report`, still downloadable with `gh run download <id> -n
playwright-report`):

| t | event |
|---|---|
| 0.17s | click on the `Edit class` `<Link>` returns **ok** |
| +0.4ms | Playwright logs `navigations have finished` — **no document navigation was scheduled**, so `Link` called `preventDefault` |
| 0.19s | `GET /class/{id}/edit?_rsc=…` → **200 in 10.9ms** |
| 0.20s | the route's JS chunk → **200 in 2.7ms** |
| 0.20s → 30s | **no network activity at all** |

Everything the browser asked for arrived in about 11ms. The client-side
transition fetched its data, its code, and then never committed — so the URL
never became `/edit` and `waitForURL` sat until the test timeout. A larger
timeout does not help a transition that is not going to commit.

**The server-side `redirect()` explanation is ruled out**, and the link's own
render gate is what rules it out: it renders only inside `{!cancelled &&
(status === 'draft' || status === 'open')}`, so at render time the class was
live, editable and owned. For `/edit` to redirect, that would have to stop
being true inside the 190ms between the detail render and the RSC fetch, and
nothing mutates it there — `CRON_SCHEDULER` is `off` in CI, the integration
suite had finished, and no sibling test touches that row.

**What is left is a hydration/router race, and it is a PATTERN, not one
test.** `class-edit.spec.ts:129` is the only test in its own file that reaches
the editor by clicking rather than by `page.goto`, which is why it is the one
that flakes there — but suite-wide, **13 of the 28 `waitForURL` calls follow a
`.click()`**, and every one is the same shape. Re-derive with:

    grep -rn -B2 'waitForURL' tests/e2e/*.spec.ts | grep -A2 '\.click()'

**Not reproduced locally: 10/10 green** (`--repeat-each=10`, Mobile Chrome)
— against a warm dev server, which is the wrong condition. CI runs a cold
production build, and hydration timing is the suspected variable, so a local
green is weak evidence and is recorded as such rather than as a result.

**So step 2 below is no longer "raise a budget".** What it IS remains open,
and one candidate is already eliminated on reasoning rather than measurement:

**Changing the assertion shape does not fix this.** "Assert on destination
*content*, which auto-retries, rather than on the URL" was the first candidate
written here, and it is wrong. If the transition never commits, the
destination content never renders either — `expect(…).toBeVisible()` would
time out exactly as `waitForURL` does. It changes the error message and not
the outcome. **No assertion shape fixes a navigation that is not going to
happen**, which is the difference between this and an ordinary
wait-too-short flake, and the reason the 13-site figure above is a count of
exposure rather than a count of edits.

That leaves two honest options, and they are not equivalent:

- **Replace the click with `page.goto`.** Removes the symptom at every site.
  It also deletes the only coverage that the `Edit class` link navigates at
  all — every other test in that spec already reaches the editor by `goto`,
  which is precisely why this is the one that flakes. Buying green by deleting
  the test's reason to exist.
- **Root-cause the non-commit first.** Needs a reproduction under the right
  conditions, which local is not. `.github/workflows/e2e-flake-repro.yml`
  (manual dispatch, added with this entry) runs the spec against a **cold
  production build** with `--retries=0` and `--trace=on`, so every repeat is
  an independent first-attempt sample and the passing repeats keep their
  traces too — the failing side is already in hand, and the comparison is what
  is missing. A red run there means it reproduced.

  **It cannot be dispatched until it is on `main`** — GitHub resolves
  `workflow_dispatch` against the default branch and only then honours a
  `--ref`, so dispatching from the branch that adds it answers `HTTP 404:
  workflow … not found on the default branch` (measured 2026-08-28). Merge
  first, dispatch second.

**RAN, 2026-08-28, and class C DID NOT REPRODUCE.** Four dispatches after PR
#341 merged, all against a cold production build with `--retries=0`:

| Shape | Executions of the target test | `waitForURL` failures |
|---|---|---|
| isolated, `--repeat-each=100` | 100 | 0 |
| isolated, 5 more | 5 | 0 |
| full suite × 5 | 5 | 0 |
| full suite × 30 | 30 | 0 |
| **total** | **140** | **0** |

**What that bounds, and what it does not.** Rule of three puts the 95% upper
bound at **≈2.1%**. The single CI observation implied ~5% for this project (one
failure in twenty `main` runs), and 140 clean executions make that rate
unlikely enough to reject — `P(0 | 5%) ≈ 0.07%`. So the rate is real but
**lower than one observation suggested**, which is what one observation is
worth. It is not zero, and nothing here says the cause is gone.

**THE 30-PASS RUN WENT RED, AND ITS FAILURES WERE THIS JOB'S OWN DOING.** Ten
of them, all `auth.spec.ts > submitting email shows confirmation message`,
none of them class C. That test posts the SAME address to
`/api/auth/magic-link/send`, which rate-limits per email and answers 429;
`--repeat-each=30` sends it thirty times. The tell is the shape: the failing
indices are exactly 71 apart — the per-pass test count — so they are passes
11–20 in a contiguous block, stopping when the window expires. **A real flake
scatters; a self-inflicted one arrives in a block**, and that check is now in
the workflow header, because a red repro run is designed to mean "reproduced"
and these ten did not.

**IT RECURRED ON 2026-08-28, HOURS AFTER BEING PARKED, and the instrument
earned its keep on the first try.** CI run `33203000735`, on a docs-only PR.
Three things changed the picture:

**1. A DIFFERENT TEST, in a different project.** `studio.spec.ts:360 > an
archived template leaves the live list for the archived one`, on **chromium** —
not `class-edit.spec.ts:129` on Mobile Chrome. Same signature exactly: the
click preventDefaults (`navigations have finished` in 0ms, no document
navigation scheduled), and `waitForURL` then sits until the test timeout.
**So class C is not a property of one test**, which is why 140 executions of
that one test found nothing: the rate is per-PATTERN, spread over the thirteen
`.click()` → `waitForURL` sites, not concentrated in the one that happened to
be observed first. The earlier sampling measured the wrong denominator.

**2. NO CONSOLE OUTPUT AND NO PAGE ERRORS** — the capture's own words, "the
page produced no console output or page errors". A negative result, and a
load-bearing one: it rules out a thrown render error, a failed chunk
evaluation, and any `console.error`. **The transition is not failing, it is
never resolving.**

**3. THE RSC REQUESTS TO THE DESTINATION WERE ABORTED — all three of them**,
followed by one JS chunk and then thirty seconds of nothing. In the first
occurrence one of three completed (200 in 10.9ms) and the transition still did
not commit. What both share is a **burst of superseded RSC prefetches around
the click**, and a router that afterwards waits on something that never
arrives. That shape — dedup against an in-flight or cancelled prefetch entry —
is the hypothesis the next round should test, and it is a PRODUCT hypothesis,
not a harness one.

**What this does not settle:** whether a real user can reach it. Playwright
clicks tens of milliseconds after a locator resolves, which is exactly when the
prefetch burst is in flight; a person is usually slower. That question decides
whether the fix belongs in the app or in a shared hydration-aware click helper,
and it is still open.

**Where this leaves C: instrumented, bounded, cause still open.** Brute force
is now poor value — at ~2% another expected hit costs ~150 full-suite
executions — and it is no longer the only route, because the console and
`pageerror` capture that shipped with PR #341 means **the next natural
occurrence names itself**. That is the trade being taken: stop paying for
reproduction, and let the instrumented suite report the next one. The
preventive sweep below is untouched work and worth more per hour.

**The second is the one to do first**, for the reason the health-budget half
of this row demonstrates: a fix aimed at an unmeasured cause changes something
nobody needed changed.

**DONE MEANWHILE, because it does not presuppose the cause: the e2e suite now
captures browser output.** `tests/e2e/fixtures.ts` extends `test` with an
`auto` fixture recording `console` and `pageerror`, attached to the report
only when a test did not get its expected result. The gap it closes is that a
trace records *where* a client-side failure stopped and nothing about *why*:
class C's trace carried the network timeline, the action log, and no browser
output at all. **That silence was production, not a hole in the trace
format** — Playwright does record console entries, and a local trace of the
same test carries two, both development-only (React's DevTools banner and
`[HMR] connected`). CI runs `npm run start`, so neither exists and nothing
else logs. `pageerror` is the channel that matters most there: in a production
build a thrown render error reaches no console first. Verified by probe, both
directions — a deliberately failed test attaches the marker it logged AND the
uncaught error it threw; a passing one attaches nothing.

It does NOT fail a test on a console error. That is a separate decision with a
much wider blast radius and wants its own measurement of what the app actually
logs.

**AND A LEAD FOR THE FIX, recorded rather than acted on.** `page-helpers.ts`
already exports `hydrationSignal(page)`, which waits for the
`/api/notifications/stream` request — its own docblock says effects run only
after hydration, so that request is a reliable "hydration finished" signal.
**Only 2 of the 13 specs arm it, and `class-edit.spec.ts` is not one of
them.** In the failing trace the stream opened at 0.13s and the click landed
at ~0.17s, about 40ms later. That is consistent with a click racing
hydration, and it means the primitive a harness-side fix would need already
exists rather than needing inventing. It is **consistent with**, not evidence
for: the repro run is what would turn it into a cause, and a fix aimed at it
now would be the same mistake this row already made once.

### Class B, established (2026-08-28) — a real race, fixed before it was triaged

**It was a real defect, it is now established rather than suspected, and it
needs no code.** The evidence that called it "not established either way" was
already four hours stale when it was written down.

**The mechanism, measured** — 40 concurrent races per shape, two transactions
inserting the same `(teacherId, dayOfWeek, slot)` against
`ScheduleRule_teacher_slot_excl`:

| Insert form | Outcome over 40 races |
|---|---|
| plain `INSERT` (the pre-fix shape) | **17 × `40P01` deadlock**, 23 × `23P01` |
| `INSERT … ON CONFLICT DO NOTHING` (today) | **40 × clean** — one INSERTED, one REFUSED |

`40P01` is in `TRANSIENT_SQLSTATES` (`api-errors.ts`), so it answers **503**.
That is `[201, 503]` exactly — the observed failure, reproduced from the
mechanism rather than inferred from it.

**Why catching the conflict could not have worked.** The old route refused by
catching `23P01` (`isExclusionConflictOn`). That is right for a conflict
against a **committed** row and useless against a concurrent one: a plain
`INSERT` writes its tuple and only *then* checks the exclusion constraint, so
each of two racing creates waits on the other's uncommitted tuple and Postgres
breaks the cycle with `40P01` — which is not an exclusion conflict, so it fell
past the 409 branch to the transient handler. A 43% deadlock rate under a true
race.

**It was fixed by issue 331, after the failing run.** `4d479ac6` (studio
template create, authored 2026-08-27 07:04Z) and `0374709b` (studio class
create, 08:50Z); the failing run started **05:40Z**. Both replace the plain
insert with `createManyAndReturn({ skipDuplicates: true })`, which compiles to
`ON CONFLICT DO NOTHING` and refuses by returning no row instead of waiting.

**The preventive sweep for this shape comes back clean.** All four create
endpoints and both generators carry it — re-derive with:

    grep -rn 'skipDuplicates' src/ | grep -v test

`api/classes/route.ts`, `api/studio-classes/route.ts`,
`class-template-lifecycle.ts`, `studio-class-template-lifecycle.ts`,
`class-generator.ts`, `studio-class-generator.ts`. The remaining
`isExclusionConflictOn` call sites are UPDATE paths, where the conflicting row
IS committed and catching `23P01` is the correct refusal.

**What is NOT established: that it is gone.** No recurrence in the four `main`
runs since the fix, plus this branch's, and 50 races green locally through the
endpoint — but a flake seen once in twenty runs is not disproved by that
sample. The mechanism-level 40/40 is the stronger evidence, and it is evidence
about the mechanism, not about CI.

**THE ORDERING RATIONALE WAS WRONG FOR B, and it is worth saying so.** B was
scheduled last on the argument that "you cannot tell a real race from noise
while the noise is there" — that judging it needed a quiet CI. It did not.
Reading the git log around the failing commit and racing the constraint
directly settled it in one pass, against a CI that is still noisy. **The
cheapest question was not "is it still failing?" but "what does this insert do
when it races?"** — and the second one has an answer that does not depend on
observation windows at all.

### The order, and why it is this order

**Fix the known-wrong instruments first, investigate the possibly-real races
second.** Not because A is more valuable than B — B may be an actual product
race and therefore worth more — but because **you cannot tell a real race from
noise while the noise is there.** Every hour spent on B against a 15% background
failure rate is an hour of ambiguous evidence.

1. ~~**Class A — the heap-order premise.**~~ **DONE — PR #341, 2026-08-28.**
   Three sites, not the two this line predicted, and three different fixes —
   see the section above for why the erasure pairing could not take the same
   one. Success was stated as measurable and is **not yet measured**: the
   background rate has to be re-derived on `main` after this merges, and until
   it is, step 3 is still being judged against an unquantified baseline. That
   re-derivation is the next round's job, with the `gh run list` command at the
   head of this section.
2. **Class C — the e2e soft navigation.** **Diagnosed and bounded 2026-08-28;
   cause still open, and deliberately parked** — 140 executions across four
   repro dispatches produced no reproduction, which caps the rate near 2% and
   makes further brute force worse value than the sweep at step 4. See the
   section above. The instruction to diagnose before raising
   paid, and in the sharpest possible way: there was **nothing to raise**. The
   health budget never fired, and the timeout that did is a client-side
   transition that fetched everything it needed in 11ms and never committed.
   What remains is not a number and not an assertion shape — see above for why
   the latter was eliminated — but a reproduction, and then a choice between
   root-causing the non-commit and deleting the only click-through coverage of
   that link.
3. ~~**Class B — `studio-api` retry safety.**~~ **ESTABLISHED 2026-08-28 — a
   real defect, and already fixed by issue 331 four hours after the failing
   run.** It leaves this bundle, as this line said it would if it reproduced.
   The premise of putting it last did not hold: it needed no quiet CI, only
   the git log and a direct race against the constraint. See the section
   above, including what that says about ordering by observability.
4. ~~**Preventive sweep.**~~ **DONE 2026-08-28.** Found three by looking, and
   a false claim underneath them.

   **The criterion turned out to be greppable**, which is what made this a
   sweep rather than a survey. The acute kind is a test asserting a staged race
   ends in NEITHER `40P01` NOR `55P03` — tier noise is then a false failure it
   cannot tell from the defect it watches for. Re-derive the census with:

       grep -rln 'not.toMatch(/[^/]*\(40P01\|55P03\)' src --include='*.test.ts'

   Four hits. **One was on the list; three were not** —
   `db-locks-lock-order.test.ts`, `invitations-lock-order.test.ts`, and one
   case inside `gdpr.test.ts`. All three are now serial, and the grep is in
   `vitest.config.ts` so the census can be re-derived rather than re-argued.

   **`gdpr.test.ts` was SPLIT, not moved, and the measurement decided it.** 26
   tests, ~26s, exactly one reading lock timing: moving the file cost the
   serial tier +92% (37.8s → 72.6s); extracting the case cost +2.5s. Same move
   `class-lifecycle-tier-guard.test.ts` made. Measured after: serial 37.8s →
   46.1s (+8.2s), parallel unchanged at ~25.7s, and the total test count is
   conserved at 1173 — which is the check that says a split lost nothing.

   **THE CONFIG'S OWN SAFETY ARGUMENT WAS FALSE, and that is the finding worth
   more than the three files.** Its note said `room-archive.test.ts` may hold a
   lock in the parallel tier "safe only because the assertion-side file left
   the tier" — while three assertion-side files were still in it. The claim was
   true of `template-lock-order.test.ts` alone and was read as true of the
   tier. A census stated as prose, about membership, in a comment: exactly what
   `CLAUDE.md` says to tether or move. It is now tethered to the grep above.
   Its `2.5s` was also wrong — the hold runs until the resume answers, under a
   6s ceiling.

   **Two files were considered and NOT moved:**
   `transition-class-lock-order.test.ts` and `update-class-lock-order.test.ts`
   stage real races but assert positive application outcomes (`reason:
   'CANCELLED'`, `reason: 'frozen'`) rather than the absence of a SQLSTATE. Tier
   noise would still fail them, but distinguishably — an unexpected throw, not a
   wrong reason — so they are the ordinary "any test can fail under enough
   noise" case rather than this list's. Recorded so the next sweep does not
   re-derive the same verdict.

**None of these were filed as issues, and class A shipped without being filed
either** — on PR #341, the roadmap PR that names it, because it was one step
of a bundle already written down rather than a new finding. B needed no filing
in the end: it was already fixed under issue 331. Worth stating plainly, since
the previous snapshot's lesson was that work done outside the tracker is work
the next round cannot see: **class C and the preventive sweep are now the
whole of this bundle's remainder**, and nothing in the tracker says so. Filing
them is the next round's first job, alongside the un-itemised 89 → 106 delta
at the head of this file.

- ~~**#41 — SSE stream dies instantly in CI.**~~ **DONE — PR #188,
  rebase-merged 2026-08-08.** 11 commits. **The issue was wrong, and the
  "concrete lead" was the wrongest part of it.** What the work taught:

  **A Playwright trace's `time` for an unfinished response is time-to-first-byte.**
  An SSE stream held provably open for 12 s (`readyState` 1 on all 12 samples,
  `requestfinished` never fired) reported `time: 18.739ms` — *inside the issue's
  own 5–21 ms band*. `time` is the sum of the non-negative timing phases, and an
  unfinished response has `receive: -1`, so it collapses to the header wait. The
  band was a TTFB distribution. The same trace's HMR **WebSocket** reported
  `time: 10001.5` with every phase `-1`, because WS duration is accounted
  connection-wide — which is exactly why the SSE rows looked anomalous beside it.
  **Two open connections, one trace, opposite conventions.**

  **The named fix had no mechanism.** `next start` and the generated
  `.next-build/standalone/server.js` both call the *same* `startServer()`; the
  standalone entry only sets `__NEXT_PRIVATE_STANDALONE_CONFIG` and skips reading
  `next.config.ts`. And `next/dist/server/next.js:227` is a bare `log.warn` for
  standalone — three lines down, `output: 'export'` *throws*. Next distinguishes
  "you did not need this" from "this will not work". The issue's command was also
  wrong for this repo (`distDir` is `.next-build`); it had copied Next's generic
  warning text verbatim. **Read a lead's mechanism before believing its urgency.**

  **The issue's second "symptom" was its own counter-evidence.** "No reconnect in
  the trace window" is what a healthy stream looks like. Filed as corroboration.

  **What was real:** the route had *zero* tests, so nothing could contradict the
  issue. Five added, six mutations, no production code changed.

  **Two of the five tests exist because review broke the first three.** The
  liveness test reported a *dirty* connection death as health — a socket reset
  left the helper's `ended` false, so it passed on precisely the failure mode the
  issue hypothesised. And the route's `mine` recipient check had no guard at all:
  `const mine = true` passed every test while broadcasting every notification's
  title and body to every open stream. **Gate 4 again** — ownership, hiding
  because gates 1–3 pass.

  **The `afterAll` in my own plan could have wiped the dev database.** Prisma
  **strips `undefined` from a `where`**, so a `beforeAll` that failed between two
  creates turned `deleteMany({ where: { recipientId: studentId } })` into
  `deleteMany({})` — measured, 4546 of 4546 rows. `announcements-api.test.ts`
  already had the guard convention; `notifications-api.test.ts` looks safe but is
  safe only by accident (`{ in: [] }` matches nothing where bare `undefined`
  matches everything).

  **The signature failure recurred twice, in this branch's own paperwork.** A fix
  commit said it corrected "the spec, the plan, and the commit message" and did
  not correct the plan — leaving it prescribing the exact bug the branch existed
  to remove. Caught only because a reviewer was told to grep every artifact.
  **A grep target scoped to one finding will not catch a second finding's twin.**

  **What CI proved, beyond the issue:** the delivery test crosses two routes, and
  CI runs it against the *production build* — which `npm run verify` never does.
  It passes, so `notificationBus` **is** shared across route bundles in production
  despite being a plain module singleton (the same file's `sseCounts` is on
  `globalThis` precisely because duplication has bitten here before). That was the
  branch's one genuinely unmeasured question. Now re-measured every run.
  Spun out: **#189** (nothing proves a closed stream frees its slot — the
  `MAX_STREAMS_PER_USER` decrement these tests rely on and none asserts).
  The standalone-parity gap went to **#127** as an Update, not a new issue.
- **#127 — migrate `src/middleware.ts` to the proxy convention.** Not a flake and
  not urgent: a Next 16 deprecation warning on every dev-server boot, alongside a
  "Custom Cache-Control headers detected" warning from the same file. Filed after
  the noise was mistaken for a symptom during #59's work. Parked here because it
  is framework upkeep with a deprecation clock, not product work — do it before
  the Next release that turns the warning into an error, not before then.
- ~~**#40 — Next router drops refresh/nav commits under CPU starvation.**~~
  **DONE — PR #198, rebase-merged 2026-08-11.** 24 commits. **The issue named one
  component; nine had the defect. Its proposed remedy did not work. And the
  framework claim in its title was closed unverified.** What the work taught:

  **`router.refresh()` returns `void`, so the bet every one of these components
  was making is unobservable from inside them.** They set a pending flag and
  relied on the refresh unmounting them. One invariant replaced that: *after a
  successful mutation a control never returns to idle; it goes to settled, and the
  only exits are unmount or an explicit retry.* One rule, three defects — the
  freeze, a red error over an action that succeeded, and a duplicate submission.

  **`useTransition` — the issue's own headline fix — is the same bug renamed.**
  `isPending` clears when the transition *commits*, which is precisely the commit
  the issue says is dropped. Read a proposed remedy's mechanism before adopting it.

  **The most valuable finding was a question the issue never asked: *what does a
  second request do?*** That census classified 49 endpoints (22 idempotent, 18
  conflict, 9 duplicate) and found that on two of them a dropped push meant a
  teacher's obvious second click created a **duplicate bookable class**. A data
  defect, surfaced by a UI-freeze investigation. Spun out: **#196** (the nine
  endpoints, led by the product decision that gates any fix — may a teacher send
  two identical announcements on purpose?) and **#197** (eighteen conflict
  responses showing developer strings to users). **#128** absorbed the accessibility
  half as an Update rather than becoming a third issue.

  **Three of my own censuses used a method that could not produce the right
  answer, and each was caught by a different reviewer.** A component sweep scoped
  to `src/components/` + `src/lib/`, so `src/app/` was excluded by construction —
  that is how the two create wizards were missed. The endpoint sweep inherited the
  same scope. And a live-region sweep grepped `role="status"` and `aria-live`,
  which cannot match `role="alert"` — so a *shipped code comment* asserted this was
  the only live region in `src/` when three had existed all along. **A search whose
  pattern excludes part of the answer returns a confident wrong number and reads
  exactly like a census.** This is the same lesson as `grep | head`, one level up.

  **Guards that could not fail, again — three of them, at three altitudes.** A
  fetch-count assertion two DOM checks above it always short-circuited (found by
  the whole-branch review; a third mutation was needed to reach it). Two rows in
  the spec section *whose job is proving guards bite* described mutations that were
  no-ops against the shipped code. And one guard's stated trigger was physically
  impossible — after settling the form has no submit button, and HTML implicit
  submission does not fire with more than one blocking field, which is *why* no
  test could pin it. "No test covers this" and "this cannot happen" need different
  fixes, and only reading the HTML spec told them apart.

  **A fix can under-deliver on its own comment.** Rule 3 un-disabled the `Cancel`
  control so a hung request had an escape — but never reset the pending flag, so
  the freeze simply moved to a *sibling* control. The comment claimed more than the
  code did. Caught at the PR-review gate, not before.

  Left knowingly: a request abandoned via the escape that fails *afterwards* still
  sets an error. Cosmetic, and pinned by a test rather than left latent.

  **Ratio: one in, two out** — both live defects, not cleanup.

Runs as its own track; can proceed in parallel with Bundle 1.

---

## Bundle 5 — Room lifecycle & admin (epic #60) · decision-gated

These are one question wearing four issue numbers: **who owns a room across its
lifetime, and how are changes to shared/public rooms mediated?** Deciding them
one at a time will produce inconsistent answers. **#60 is the epic they roll up
into.** Hold a product-decision pass across the cluster before any code.

- ~~**#77**~~ **closed.** Both halves landed: the cross-teacher `hasClasses`
  guard is pinned (PR #90, one test, no code change — it was already correct),
  and the create-side question got its product call (PR #91): **a teacher may
  link to a public room or their own, nothing else.** That turned out to be the
  rule `GET /api/rooms/[id]` and `GET /api/rooms` already applied — the create
  route was the only place that didn't — so it needed no UI change. It also
  removed a 500: an unknown `roomId` is now a 404 rather than a foreign-key
  violation.

- ~~**#73 — `PUT { isPublic: true }` is an irreversible one-way door**~~ **DONE
  (PR #261).** The lock stands, deliberately — #52/#60's decision is untouched.
  What changed is entry: rooms are born private, `updateRoomSchema` no longer
  accepts the field (so `PUT` answers 400, rejected rather than ignored), and
  sharing is `POST /api/rooms/[id]/publish`, guarded creator-first with a
  duplicate check in front of it. The issue's "API-only, lower urgency" premise
  was false — the lock was the default outcome of the only creation flow.
- ~~**#76 — room deletion blocked forever**~~ **✓ closed 2026-08-19 (PR #262).**
  Took the issue's option 3, *archive instead of delete*. **The issue's premise
  was substantially false and this list carried the false phrasing**: archiving
  had already shipped in `e57b8bd` on 2026-04-05, three and a half months before
  the issue was filed, with four consumers — so "the unused
  `TeacherRoom.isArchived`", copied verbatim into this file, was never true.
  Two of the issue's other three claims also failed: a teacher was NOT stuck
  with the room in their list (archiving already removed it), and the issue
  quoted one delete route when there are two, the sibling already answering 409
  "Archive it instead."

  **The real defect was that `isArchived` was a display flag with no downstream
  meaning** — it decided which of two list pages a row appeared on and nothing
  else read it. A room could be archived while an open class or a live template
  still pointed at it; a live template kept generating into it indefinitely.
  Five doors now give it meaning, and `DELETE /api/rooms/[id]`'s unfiltered 400
  became a 409 matching its sibling.
- **#52 — no channel to suggest changes to public-room base properties** (enhancement).

The decisions from #52's original discussion (public rooms are community
property; the creator may have left; an admin surface mediates changes) are the
premise #60 exists to build. Sequence: decide the cluster → build #60 → the
individual fixes fall out of it.

---

## Bundle 7 — Retry safety at the API contract · decision-gated

Both spin-outs from #40 (PR #198). They are the server-side half of what that
branch fixed at the client, and they share a premise worth stating: **the client
has thirteen distinct post-success control-flow shapes; the API has one contract.**
Every one of these defects is ultimately "what happens when the same request
arrives twice", so fixing it at the contract makes client variety stop mattering.
#40 could not do that — it needed a shipping fix and the contract change is a
schema-plus-middleware job — so it settled the controls instead.

- **#196 — nine endpoints duplicate their side effect on a retried request.**
  **Decision-gated, and filed as a decision rather than as work.** The gating
  question is *may a teacher deliberately send two identical announcements?* If
  yes, dedupe cannot key on content and needs an intent-keyed idempotency token;
  if no, a natural key or a time window is far cheaper. The same question decides
  `magic-link/send` and `payments/[id]/remind`. **Do not start building before it
  is answered** — the nine are heterogeneous and the answer changes the mechanism
  for most of them. Two are severe: on `POST /api/classes` and
  `POST /api/studio-classes` a dropped push meant a teacher's obvious second click
  created a **duplicate bookable class**. #198 removed the reachable client path to
  four of the nine; the endpoints are untouched and the other five have no
  mitigation. Carries an Update on `edit-room-form.tsx`'s two sequential PUTs
  (mid-chain failure leaves the server half-updated) — same "partial client
  sequence" family, worth deciding alongside. Closest precedent is **#98**'s
  absolute-target-state spec, which is why 22 endpoints are already idempotent.

  **Re-verify the census before designing on it.** Its numbers came from a sweep I
  wrote on #40's branch, and that sweep's scope excluded `src/app/` by
  construction — which is exactly how two of the nine were missed the first time.
  Expect 49/22/18/9 to move once `src/app/` is included from the start.

  **DECIDED AND SPEC'D 2026-08-11** —
  `docs/superpowers/specs/2026-08-11-retry-safe-endpoints-design.md`, branch
  `fix/196-duplicate-create-constraints`. No code yet; blocked, see below.

  - **The gate resolved AWAY from idempotency keys.** All four answers: identical
    announcements suppressed inside a 2-minute window; never two classes at one
    teacher-date-time; reminders legitimate after a cooldown; a second magic link
    resends and the first stays valid. Three are natural keys and one is a window,
    so there is **no `Idempotency` table, no `withErrorHandler` middleware and no
    client plumbing** anywhere in the design. The issue assumed the opposite. An
    intent token is only *required* where a deliberate identical repeat is
    legitimate, and no surface here turned out to be one.
  - **49 → 56, and the fix was to change the unit.** Re-derived from route
    handlers rather than `fetch` call sites, because #196's own "or any future
    caller" argues the denominator is the API surface. Six of the seven new pairs
    (five cron routes, `POST /api/teachers`) have **no client caller at all** —
    the same blind spot as before, one level deeper. **Watch the 47**: that is the
    number of route *files*, and it collides exactly with the pair count the issue
    published.
  - **DUPLICATE stayed at exactly 9 and all nine were confirmed**, 10 of 10
    inherited domain claims true. The issue's census was right about its members
    and wrong about its universe.
  - **The seventh delta cannot be reconciled, and that is the lesson.** The prior
    census published totals (22/18/9) and never its member list. **A count without
    its members cannot be diffed** — you see that numbers moved, never which rows.
    That is how #40's `+2` patched the totals without making the set inspectable.
    The new spec publishes all 56 rows for that reason.
  - **One inherited claim false, and it understated the defect.** `student-signup`
    sends no "second welcome email" — there is no welcome email in this codebase.
    It mints a **second live sign-in credential** through the same helper as
    `magic-link/send`, so one fix closes two of the nine.
  - **A second axis found six more: what if the retry arrives BEFORE the first
    commits.** Prisma defaults to Read Committed, so a `findFirst`-then-`create`
    is not saved by `$transaction`. Six endpoints filed CONFLICT/IDEMPOTENT fail a
    genuine double-click — **15 defects across 14 endpoints**, not nine. Sharpest:
    `DELETE /api/invitations/[id]` destroys the decline tombstone, in a file whose
    own comment says "the tombstone must outlive the teacher's wish to be rid of
    it". A guard that states the invariant it fails to enforce is invisible to
    anyone who reads it; only mutating it finds it.

  **UNBLOCKED 2026-08-11 — #164 and #192 landed (PR #204).** Both generators now
  pre-check `(teacherId, date, startTime)` against the exact predicates #196's
  indexes will carry (`status <> 'cancelled'` / `cancelledAt IS NULL`), and both
  insert with a bare `ON CONFLICT DO NOTHING`, so a blocked date costs that date
  and the transaction survives. #196's own bar — "a single blocked date must cost
  only that date" — is met by the constraint rather than by luck, and §4.1's
  predicate-mirror tests are in place in both families.

  Two things #196 branch 1 inherits rather than builds: the slot pre-check
  (already there, currently the *only* thing enforcing that key — both generator
  docblocks say so in as many words) and §5.1's skipped-slot reporting (already
  there). What remains for branch 1 is the migration itself, the five endpoints,
  and the 409 copy — **minus** §5.1's claim that the route must map the
  generator's `P2002` to a 409, which is now moot: the generator cannot raise
  `P2002` at all. That correction was posted to this issue.

  **Was blocked because:** the generator inserted at `(teacherId, date,
  startTime)` while its probe checked only `{templateId, date}`, so it could not
  see a manually created class there and every such date aborted the generation
  transaction. `Room`, `ClassTemplate` and
  `StudioClassTemplate` carry no such dependency. **#196 inverts #192's own cost
  estimate**: that issue discounted Option C partly for "dragging in the class
  family", and #196 indexes both families, so both generators need the pre-check
  regardless — the expensive option is now the cheap one.

  **Two things measured rather than argued, both worth reusing.** Prisma's CI
  drift check is blind to a hand-authored *partial* unique index — proven with a
  plain unique index as a control, because "no drift" says nothing unless the
  instrument can report drift (it could: `exit=2`). And the 25P02 transaction
  abort: **that one re-derived #164 rather than discovering it**, which is what
  `gh issue list` against a finding would have shown before writing it up. What it
  adds is a reproduction, and that the *class* generator's docblock still claims
  the idempotency the *studio* generator's comment already denies — a **correct**
  claim failing to reach its twin, the direction of that failure nobody watches.

  **Hard blocker before any migration:** `CREATE UNIQUE INDEX` fails outright
  against violating rows, and dev holds 16 classes, which proves nothing. The four
  counting queries must run against production first. — **Resolved: there is no
  production database yet.** Once one exists it will be built by running this
  migration history, so the index predates every row and no violating row can
  accumulate. Stronger than the pre-flight count would have been, but it holds
  only for a database built that way.

  **BRANCH 1 DONE — PR #208, rebase-merged 2026-08-12. 67 commits, 47 files,
  +5111/−740. #196 stays open; branch 2 (the nine needing no schema change)
  closes it.** Six partial unique indexes on `Class`, `StudioClass`,
  `ClassTemplate`, `StudioClassTemplate` and `Room`; **thirteen** write paths
  answering a slot clash with a tailored 409. `npm run verify` green at
  `1255 = 686 unit + 197 components + 372 integration`.

  Seven things this round actually taught, none a restatement of the issue:

  - **The scoped census was scoped wrong, twice, and the second time was worse.**
    The plan covered five POST routes; six indexes constrain **every verb**, so
    updates, `PATCH ?state=unarchived` and a two-source template PUT joined —
    eleven paths became thirteen. Found by the deadlock probe, not by review.
    Then Task 1 applied a global migration verified against its own unit file and
    passed **two clean reviews while 53 integration tests were red**. The
    corrective constraint I wrote said "run the whole integration project" —
    fixing the instance rather than the cause — so the `unit` project stayed
    unrun and was red too, at 90 more tests. **When a check misses something,
    widen it to what would have caught the cause, not the instance.**
  - **A row can enter a partial index's scope without any indexed column
    changing.** Un-archiving a template, un-cancelling a class, flipping
    `isPublic`. Grepping for writes to the *indexed* columns finds none of them —
    the **predicate** column is as load-bearing as the key. The mirror image is
    the useful half: **leaving scope is always safe** (cancel, archive), so those
    writes correctly need no catch at all.
  - **The spec's weakest claim was wrong, and only measurement found it.** §5.2
    argued the new keys add no deadlock edge. Two `updateClass` writes swapping
    slots produced `40P01` in **32 of 100** runs, `0/60` with the index dropped.
    Recorded in `docs/lock-order.md`, not fixed — a slot move vacates one key and
    claims another in one statement, so it is not orderable. Already classified
    503 by #174's transient branch. The probe also found the pairing the plan
    *named* was clean **only because another of the six indexes keeps its edge
    from being live**.
  - **Postgres checks unique indexes in OID order, so the older key wins.**
    `Class_templateId_date_key` predates `Class_teacher_slot_unique`, so the
    ordinary "move this week's class to next Monday" raised `["templateId","date"]`
    and fell through to a generic 409 — the tailored message was unreachable on
    the most likely reschedule. Found by a specialist querying `pg_index`; no
    amount of reading would have. Fixed with a third catch arm.
  - **`prisma migrate diff` is blind to partial indexes** (proven with a control:
    a plain index on the same columns exits 2). So there is **no drift detection
    on these six at all** — `src/services/slot-constraints.test.ts` is the only
    sentinel that a future migration didn't recreate one wrong, and its blind
    spots are the branch's blind spots. That is why its `teacherId` and predicate
    coverage was completed rather than left partial.
  - **Eight claim-corrections, and the same failure recurred at every level.**
    One wrong number ("five stale comments" → four) stood in four artifacts. Four
    of my briefs were wrong about the state of the code — including "no deadlock
    branch exists" when `classifyApiError` had handled `40P01` since #174, and my
    proposed 409 would have been *worse* than the existing 503, because a
    deadlock is no-fault and the remedy is to retry the identical request. Then
    the fix wave correcting twelve false comments **introduced a new false one**,
    in both twins, in one commit. Every single one was caught by an implementer
    or reviewer **checking rather than complying** — which is the argument for
    keeping "surfacing a plan defect beats coding around it" in every dispatch.
  - **The specialist round earned its place over the whole-branch round.** Three
    whole-branch reviewers I briefed found real defects but inherited my blind
    spots; the four `pr-review-toolkit` specialists, with rubrics I did not write,
    found 25 more — including four client-side comments stating the **opposite**
    of what shipped, and three `schema.prisma:NNN` citations falsified by this
    branch's own 37-line insertion. **Cite model and field names, not line
    numbers.**

- **#197 — eighteen conflict responses show developer strings to users.**
  Not decision-gated and independently shippable, in two separable pieces: the
  copy, and machine-readable codes. Only 4 of the 18 emit a code today, and
  `readErrorMessage` (`src/lib/client-errors.ts:10`) discards codes anyway — which
  is precisely why #40 could not tell "you already did this, and it worked" apart
  from "this failed" at the client, and reached for a settled state instead. The
  codes half unblocks retry-safe clients generally; the copy half stands alone.

  **BRANCH 2 DONE — PR #211, rebase-merged 2026-08-13. #196 CLOSED.** 14
  commits, 33 files. `npm run verify` green at **1292 = 700 unit + 201
  components + 391 integration**, from a 1255 baseline — 37 tests and one file
  added. Open count 57 → 60, which is exactly `−1 closed + 4 filed`; nothing
  auto-closed by accident this time.

  Seven things this round taught, none a restatement of the issue:

  - **The design document was wrong in seven of its nine rows, and two would
    have shipped a regression.** §4.2 was written before branch 1 executed and
    before any row was read against the code. "Reuse the live magic-link token"
    is *not expressible* — only the hash is persisted. "Move the mint inside
    the guard" would have **removed sign-in for every returning student**, and
    no test covers that path, so it would have shipped green. **A design
    section written ahead of the branch it describes is a hypothesis, and the
    verification step is the whole of its value.**
  - **`replace_all` with a whitespace anchor cost two Criticals from one
    edit.** Restoring a mutation, it missed the late-cancel branch (nested
    deeper) and silently *added* a scope to a `PUT` this branch had no business
    touching, turning a routine check-in tap into a permanent 500. Then my
    verification could not see it: `git diff | grep '^\+.*where: { id'` returns
    two lines for a correct restore **and** for that corruption. **A check that
    gives the same output for the right answer and the wrong one is not a
    check.**
  - **Six race tests passed for the wrong reason, and only measurement found
    it.** A plain `Promise.all` serialises, so the second request's *pre-check*
    returns the expected 409 and the guard under test never runs. Four passed
    whole with their lever released early. `$transaction` also returns before
    its callback runs, so a "lever" can be pure decoration while a fresh client
    is still connecting. Every race test now does a handshake and asserts
    `settled === false` before releasing. **Four different levers were needed,
    one per defect shape** — row lock, uncommitted holder, uncommitted holder
    that commits, and a `$extends` hook keyed on query shape.
  - **Two tests could not fail against the mutation their own titles named.**
    The late-cancel "money" test was a duplicate-cancel test in disguise:
    narrowing the guard to `notIn: ['late_cancel']` leaves the
    `cancelled → late_cancel` overwrite live and still yields `[200, 409]`,
    because both racers start from `registered`. The dual-role erasure asserted
    an outcome the *winner* produced. **"Prove every guard bites" has a second
    edge: prove the test can fail, not just that the guard exists.**
  - **The fix wave reproduced the failure it was correcting, twice.** It
    corrected "the `else` path below" in a route and wrote a fresh copy of the
    same phrase into a test file in the next commit. And a commit message
    *certified a correction that was never made* — worse than the uncorrected
    comment, because the next reviewer greps the log and skips the line.
  - **A correction can be worse than the error.** I "fixed" `lock-order.md` to
    say Prisma's 5000 ms timeout bounds a lock wait, pasting as evidence a probe
    reading **13516 ms**. The evidence disproved the claim it was quoted for;
    re-measurement said 12013 ms. Prisma's timeout cannot cancel a statement
    already blocked in Postgres — which `gdpr.ts` has said since #174. **When a
    correction rests on a measurement, check the measurement agrees with it.**
  - **Enumerating the untested guards honestly is what closed one.** The spec
    gained a §4.1 listing five guards that shipped after §4's table, each with
    real provenance. Writing "argument alone, and three reviewers agreeing"
    next to the invitation 404/409 split made it impossible to leave; it took
    one test, and the mutation reproduces the original harm — a teacher told a
    person had declined when the teacher had deleted the row themselves. Two
    remain listed as unheld, deliberately.

  Ratio: **one closed, four opened** — high, and stated rather than left to
  pass as normal. #212 is a live bug the review found (the final-hour waitlist
  broadcast announces spots already taken); #213 and #214 are decisions this
  branch surfaced and deliberately did not pre-empt; #215 is debt the branch
  made more visible. A fifth finding — `cleanupExpiredTokens` being dead code —
  got a **docblock instead of an issue**, because the failure mode is "someone
  greps `cleanup` and picks the wrong one of two", which a signpost beside the
  function fixes and a backlog entry does not.

## This round's spin-outs (#272, PR #340) — three deferred, three declined, and a review that found the branch's own design note

**Nothing was filed.** Recorded here so the next round files them rather than
re-deriving them; the flake classes are in Bundle 4 above, not repeated.

**Deferred, with the reason:**

- **`@default` on the two mirror columns.** `ruleLive Boolean @default(true)`
  and `roomArchived Boolean @default(false)` mean the generated create input
  makes both optional — and a mirror has no safe default, since its only correct
  value is its parent's. Both create sites are correct today (`createClassTemplate`
  deliberately *asserts* `roomArchived: false` so the foreign key refuses without
  a raceable read), so this is defence against a future writer, not a live bug.
  Needs its own migration; deliberately not folded into a branch that had
  already grown.
- **A constraint-name union.** Three of the four `isCheckViolationOn` call sites
  are unreached by any test, so a stale name there is an uncaught 500 with a
  green suite. This branch renamed a constraint and needed four independent
  literal edits to follow it. A named union collapses the next rename to one.
- **#339, already filed** — the class half of the same invariant, still two racy
  reads. Split out during the design when the issue's own door table was found
  to be conflating two invariants.

**Declined, and why the reason matters more than the item:**

Three refactors from the simplifier pass were turned down as *right, but not
here*: restructuring the PUT pre-check so it never returns its own 400; carrying
a `roomMove` object instead of `targetRoomIsArchived | undefined`; and
collapsing nine copies of an integration teardown. All three are real
improvements. All three touch the path this same review had just fixed a
cross-tenant leak in, at the tail of a long branch. **Being right about a
refactor is not the same as it being the right commit to make**, and the
distinction is the thing worth keeping from this round.

### The finding this round is actually about

**A design can name its own hazard and still get the boundary wrong, and the
boundary is where the cost lands.** §4.4 of the #272 design says, in terms:

> The foreign keys acquire locks that no application code asks for. This design
> avoids *hand-written* `FOR UPDATE` acquisition; it does **not** avoid
> lock-ordering work, and reading it as doing so is the error to guard against.

That is the insight, and it is correct. The next paragraph then says a cycle
"still requires two transactions touching two rooms in opposite orders, which is
a pre-existing shape rather than one this change introduces" — and a
**single-room** cycle was measured against the generator (`40P01`, archive
aborted). Five of thirteen commits paid for that one sentence.

The general form, worth carrying into #229 and the rest of 3b: **declarative
enforcement moves lock ordering out of the diff.** A trigger or a foreign key
takes locks that no reviewer sees in a changed line, so the edges have to be
enumerated deliberately — and an enumeration that concludes "this shape is
pre-existing" is exactly the claim to drive rather than reason about.

Two corollaries this round measured directly:

- **PostgreSQL never indexes a foreign key's referencing side.** The branch's
  own design asked whether one was warranted (§7.3) and the branch never
  measured it. Three paths read that side, two while holding locks; at 100k rows
  the archive cascade ran 14.23 ms against 3.60 ms indexed. **An open design
  sub-choice is an acceptance item, not a footnote.**
- **`prisma migrate status` compares names, never checksums.** It reported
  "Database schema is up to date!" across a whole session while two databases
  carried a drifted migration checksum each — invisible until the first
  `migrate dev`, which is CLAUDE.md's documented trap, hit in practice.

---

## This round's spin-outs (#283, PR #303) — one, and a fix that had to be wrong once before the fault was legible

**One filing.** #304 — the studio class detail page is titled by `location`
while the schedule card that opens it reads `classType · location`. Found by
reading during review, not by running; it is the same defect class as #281,
one door over, and pre-existing rather than introduced, so it was filed rather
than widened into the branch.

**The branch was red on CI and had never once been green — through
twenty-five commits, a build, and a review round.** Nobody had looked. The
first thing the review did was open the run.

**A ten-second timeout is what identified the fault, by failing.** The two
flakes both sat where an assertion crosses from client state into state only a
post-action `router.refresh()` produces, so the first fix read them as slow and
raised the budget. CI came back *worse* — 1 failed, 4 flaky, chromium now too —
and, decisively, still `element(s) not found` at the full ten seconds. That
number is the finding: a commit that has not arrived in ten seconds is not
slow, it is dropped, and no budget reaches it. The second fix waits for the
write and reloads, which is what `teacher-journey.spec.ts` has done since #40,
with the reason written down: *"the router can drop a post-action refresh
commit, so the state change lands and the client repaint does not."* **The
prior art was in the repo, in a sibling spec, and the branch reinvented the
wrong half of it.**

**The premise was defended over the evidence, and that is why the wrong fix was
chosen.** The spec's docblock justified its own existence as *"only a browser
sees the refresh actually change which control is drawn"*, and `reload()`
voids that claim. Avoiding the reload preserved the sentence at the cost of the
suite. The sentence was the thing that had to go: the file now says what the
arc actually proves, that each step's server-rendered props are the previous
step's writes. Worth generalising — **when a fix is rejected because it would
falsify a comment, the comment is the suspect.**

**Four assertions that had already passed a review round were green under
mutation.** The branch shipped a fourteen-entry mutation ledger, and none of
those fourteen touched these. Hard-coding the archive button's label gave an
un-archived template an "Unarchive" control and passed all nine e2e tests,
because Playwright matches an accessible name as a case-insensitive
**substring** and `"Unarchive studio class"` contains `"Archive studio class"`
— a rule the same file applies correctly two hundred lines further down.
Reversing `lastScheduled`'s ordering made the pause sentence name the first
class and passed, because `.*` swallowed the only field distinguishing four
classes that share a start time. Re-indexing `DAY_OPTIONS` put every teacher's
classes on the wrong weekday and passed, because the form is driven by label
and the stored day was never read back. **Writing your own mutation list tests
the failures you already imagined** — the same lesson #114's round paid for,
recurring one bundle later.

**Two verification claims were unfalsifiable as measured, and both looked like
diligence.** The PR body claimed "nothing flaky under `failOnFlakyTests: true`",
measured locally — where `retries: 0` makes "flaky" an unreachable verdict, as
`playwright.config.ts`'s own comment says. And the ledger's 25× flake loop was
scoped `--project=chromium`; both flakes were Mobile Chrome. Neither was
dishonest; both were run somewhere the fault could not appear. **Mutation-test
the verification, not only the code.**

**The comment-drift failure recurred a dozen times in twenty-five commits,
including inside the commit that was fixing it.** Four artifacts carried a
`page.tsx:55` that this branch's own header fix had moved to `:59` — an edit in
a different file, four lines above, which the author had no reason to connect.
Worse, a citation into the design spec rotted 28 lines *after being introduced
as the fix* for restating a cross-file fact: the review-round commit
`850ab96` swapped prose for a line-number pointer, which is the textbook move,
and two doc commits later the pointer was wrong. **The eight citations that
survived all pointed at stable names** (`DAY_OPTIONS`, `pauseMessage`, a
constraint name); the two that rotted were bare offsets. CLAUDE.md's rule is
"link to the owner" — this round is the argument that the link must be
greppable, because a `:NN` into a file you do not own is the most rot-prone
link available.

**A suggested fix was measured and withdrawn.** The review proposed closing
`bodyTextForSmellCheck`'s recorded gap — a `<select>` whose selected option is
a drifting date escaping `DATE_SMELL`. Implemented, it caught nothing:
`rewriteDates` walks `<option>` text like every other node, so a converged
freeze leaves no `DATE_PATTERN` match anywhere and the new check passes
unconditionally. It would have shipped as exactly the class of dead assertion
the same review had just found four of. Kept only for the case that is real —
the freeze loop giving up with a date still inside a hidden select — and the
comment narrowed to claim only that. **The recorded gap was overstated, and
only running the fix showed it.**

---

## This round's spin-outs (#114, PR #271) — one, and a review that found nineteen things, none of them behaviour

**One in, one out.** #270 is the only filing, and it is a leaf: the measurement
is done, the acceptance is exact, and its `Class` half was deliberately recorded
inside it rather than filed, because that half needs a per-column decision and
would have spun its own three.

**The five-agent review found nineteen things and not one was a behavioural
defect.** That is the number worth keeping. The shipped logic was correct; all
twelve original tests were confirmed sound under mutation. What the agents found
instead was one test-hygiene bug, one observability regression, two guards that
could not fail, and eleven false or imprecise claims in prose. **Five findings
were reported independently by two agents**, which is what separated them from
opinion.

**Two guards that could not fail, both found by a reviewer applying the mutation
before the author did.** `PUT → not_found → 404` had no HTTP test: flipping it
to 403 left all 36 studio integration tests green, and the route's `never` guard
cannot catch that because it fires on an *unhandled* reason, never a
*mishandled* one. And the P2025 test asserted a reason the function's early
return produces too, so moving the fixture's delete before the read left all
eight tests green. **The branch had already run twelve mutations.** Writing your
own mutation list tests the failures you already imagined; that is the argument
for adversarial review over self-review, and it cost two vacuous guards here.

**A claim the branch falsified itself, three commits later.** The pin docblock
said the runtime register "covers five of these". Task 5 of the same plan added
the missing three, making it eight, and nobody re-derived the count — not the
author, not the first review. §4's rule is "correct a claim in every artifact";
this is the harder case it does not cover, where a *later task in the same
branch* invalidates an *earlier task's* prose. Worth a habit: when a task
changes a set, grep for prose that counts that set.

**And one written while fixing a different false claim.** The new test's comment
said the studio port was simpler because `StudioClass.template` is
`onDelete: SetNull` and the class version has child rows to clear. `Class.template`
is `SetNull` too. One half of a comparison was checked and the other asserted —
inside a commit whose message was about correcting false claims.

**#231 is the pattern behind the observability finding.** Catching P2025
silently deleted an `error`-level log line, because `classifyApiError` has no
P2025 branch and falls to its default arm. The comment defended the silence on
reachability — an argument `api-errors.ts:112` had already tried and rejected
one file over: *"The argument was true, and it was the wrong thing to depend
on."* The reachability claim was even correct. It was still the wrong
instrument.

**A leaked test database, attached to #177 rather than filed.** The new describe
shipped without the `afterAll` both siblings carry: 52 teachers, 149 templates
and **1788 studio classes** in `ethical_yoga_test`, growing ~7 templates a run.
#177 already tracks "test suites leak rows", so the measurement went there as an
Update. It contributes a third leak category that issue's framing misses — not a
missing delete, not an ordering failure, but **no teardown written at all** — and
an answer to its question 3 it does not anticipate: leaked rows degrade
*runtime*, not just row counts, because `generateStudioClassInstances` sweeps
unscoped and this repo has timing-sensitive tests.

---

## This round's spin-outs (#103, PR #264) — two, and a guard the fix itself made untestable

Both are **pre-existing** and neither was created by this branch, which is the
test §7 puts third. They are here anyway because §7's floor overrides it: a
defect a user will actually hit is fixed or filed every time, and "I only saw it
because I was passing through" is not a reason to leave it unrecorded.

**#267 — `delete-room-button` reports every non-JSON server error as a network
error.** `res.json()` sits inside the outer `try`, so an Nginx 502, a Next.js
HTML error page or a truncated body all land in `catch { setError('Network
error. Please try again.') }`. The network was fine; the server failed
deterministically, and the teacher retries against something retrying cannot
fix. The bare `catch {}` binds nothing, so the underlying error is discarded
rather than merely unreported. A leaf: `readErrorMessage` exists, and
`unlink-room-button.tsx` — the sibling button on the same screen — already uses
it. Filed rather than folded because the component is not in the branch's diff
and this branch does not change how often the path is hit (the old 500 and the
new 409 are both JSON).

**#266 — the delete door names a remedy the archive door can refuse.** Filed
*as a decision*, not as work, per §7's second test. The delete door refuses with
"Archive it instead"; the archive door refuses a room holding an `open` class or
a live template. Two of the four blocker states are dead ends as far as the
message goes. **The common one predates #103 entirely** — any room with an
upcoming class — and this branch only extends it from classes to templates.

The ruled-out option is recorded in the issue because it is the obvious one:
reuse `describeRoomBlockers`. It cannot be reused, and the reason is exact —
it says "unfinished class", meaning `BLOCKING_CLASS_STATUSES`
(`open`/`in_progress`), while the delete door counts **every** class because a
foreign key does. Three completed classes would read "3 unfinished classes
still use this room", which is the same defect `room-archive.ts:74-79` already
documents itself fixing, in a different word.

### The finding this round is actually about

**A correct fix made an existing guard untestable, and three review passes read
past it.** The `Class` pre-check on both delete routes used to be pinned by its
own failure mode: drop it and the route 500s. Adding the foreign-key backstop
converted that signal into a byte-identical 409 — same status, same body, same
`ROOM_IN_USE` code. From that commit on, `if (false && ...)` on the pre-check
left the entire integration project green.

That matters more than a coverage gap, because the pre-check is not there for
the status. It is there so the `DELETE` is never issued, which is what keeps the
RESTRICT trigger from taking `FOR KEY SHARE` on a `ClassTemplate` row the
generator sweep holds `FOR UPDATE` — the AB-BA edge `docs/lock-order.md`
records. The backstop cannot substitute: it runs *after* those locks are taken.
Both handlers carried a comment saying exactly this, in capitals. The comment
was true and unenforced, which is the condition this project keeps rediscovering
— **a reviewer who reads a guard confirms it; one who breaks it finds it cannot
fail.**

The generalisable form: **when you add a second mechanism that produces the same
observable as the first, you delete the first one's test signal.** Nothing fails,
so nothing tells you. The fix is to make the two observably different at the
seam you already control — here, one constant (`ROOM_IN_USE_RACE`) — before
reaching for the expensive instrument. The lock-hold test is still needed,
because a code assertion cannot see a pre-check moved *below* the delete inside
the same handler; but it is the second line, not the first.

**Four false claims about the schema shipped inside the branch, and no test
could have caught any of them.** A comment asserting a CASCADE that a RESTRICT
forbids; a spec section justifying a transaction against a window that only a
redundant statement opens; a `modelName` justification wrong at seven sites and
disprovable by the branch's own recorded mutation output; and a `lock-order.md`
paragraph claiming a second unclosable deadlock cycle that the shipped guard
closes. Every one is a claim about *why* the code is right — the category tests
are structurally blind to, and the reason this repo's review rounds are worth
their cost.

**§8's "N locations, N verdicts" rule fired twice on one branch, after being
read.** The `modelName` finding named seven locations and the fix wave corrected
five. The next finding named fifteen and the wave corrected seven. Both misses
were in the plan and handover — the same two files, both times — and both were
found by reconciling against the finding's own location list rather than by
trusting the wave's report. The corollary is now demonstrated twice on one
branch: **a fix wave's own report is not evidence.**

**Second consecutive round to pay for sharing one working tree between review
agents.** Round one: an agent reported both backstops disarmed as CRITICAL — it
was another agent's in-flight mutation, and `git diff main...HEAD` was clean the
whole time. Round two: an agent reported the new lock tests failing "2 of 6 full
runs" while a sibling agent was mutating the pre-check, which makes exactly those
two cases block and nothing else. Both resolved by measuring directly (four full
`--project integration` runs, 437/437, 16-20 ms) rather than by weighing the two
reports against each other. The previous snapshot already recommended
`isolation: "worktree"` for review fleets. It should stop being a recommendation.

**One honest loose end.** A single unidentified test failed once in the full
suite, in the run that started seconds after a mutation was restored, and did
not reproduce across four consecutive full runs or two CI runs on clean
production builds. Most likely dev-server recompilation lag against a
just-restored file. It was never identified, and is recorded here rather than
written off.

## This round's spin-outs (#73, PR #261) — two, filed before any code was written

~~**#73**~~ **CLOSED 2026-08-18** (PR #261, rebase-merged, 19 commits over 30
files). One out, two in: **#259** and **#260**. Unlike the previous round's
pair, neither came from reviewing the branch — both were filed at 13:13Z while
measuring the issue's premise, hours before the first commit, and the spec
names them as out of scope rather than discovering them later.

**#259** — the sharing flow's exact-identity branch tells the teacher *"you can
add it from Settings › Rooms › Add room"* and stops there. Automating the
switch means repointing `Class.teacherRoomId` and `ClassTemplate.teacherRoomId`,
which needs a decision about terminal-class history and runs straight into
**#76**. Filed as a decision with options, not as work. **#260** — two rooms
differing only by case or trailing whitespace are distinct to both
`sameRoomIdentity` and `Room_public_identity_unique`, so the commons can hold
`Prinsengracht 42` and `prinsengracht 42` as separate shared rooms. Pre-existing
from #196's chosen key; PR #261 inherits it **deliberately**, because a
predicate stricter than the index would refuse a share Postgres would have
accepted and tell the teacher "already shared" about a room that is neither
theirs nor the same — invisible and unrecoverable, where the looser direction
merely reaches a 409 that already exists.

**Where the two belong.** Both go in bundle 5 with **#76** and **#52**, and
#259 in particular should not be attempted before #76 (**now closed**, PR
#262, so this dependency is discharged): they are the same
question asked from two directions — what happens to a room's history when the
room a class points at is no longer the right one. #260 is the odd one, in that
its mitigation already shipped: the neighbourhood search puts both variants in
front of a human, which is the only correct answer available while the index
stays byte-exact. Fixing it properly means changing `Room_public_identity_unique`
and `sameRoomIdentity` **in the same commit** — the module's docblock says so,
and that coupling is the whole reason the predicate is a named, unit-tested,
greppable module rather than three `===` inline in a component.

**What the review did NOT file, and why that is the notable part.** The
five-agent pass found 24 defects and filed nothing — every one was fixable in
place, and all 24 were fixed before merge. Three of them were guarantees that
could be deleted with the suite still green (`updateRoomSchema`'s `.strict()`,
the duplicate search's argument order, the column-default test), and one was a
live TOCTOU race the feature work had itself opened: `PUT` read a room, checked
`isPublic`, then wrote by `id` alone, while the new publish route could commit
`isPublic: true` in between — with both controls rendered on the same page, so
no second device was needed. That the round closed with zero new issues is a
statement about this branch, not a trend; the previous round filed three from
its review wave.

## This round's spin-outs (#249, PR #256) — two, and a fix that shipped broken twice in the same place

~~**#249**~~ **CLOSED 2026-08-18** (PR #256, rebase-merged, 18 commits over 18
files in `src/` and `tests/`). One out, two in: **#257** and **#258**, both
from the review wave, both scope decisions rather than defects.

**#257** — `template-sync.ts` rewrites `startTime` on a template's instances
through a bare `updateMany`, past no past-start guard, selecting them with
`date: { gt: now }` — a `@db.Date` calendar date compared against an instant.
That is not the same predicate as "this class has not started": measured, an
Auckland teacher's class dated tomorrow at 00:30 local started eight hours ago
and still satisfies the filter. So the branch's "two doors" framing was a
scope, not an inventory, and it had already been copied into four artifacts as
though it were closure. **#258** — `defaultTimezone` is hardcoded to
`Europe/Amsterdam` at signup with no inference, so both new guards decide in
the wrong zone for most of the world; and the Settings picker that could
correct it lists 26 zones with nothing in Asia, Africa, South America or NZ, so
an Auckland teacher cannot express the right answer at all. Both were left open
for the same reason #249 was: closing them decides a product question, and
#249's own history is the argument for not deciding those inside a fix.

**Where the two belong.** #258 goes with **#145** and **#157** in bundle 3c,
and the three make a sharper set together than any of them does alone — they
are the same column failing at three different layers. #258: the stored value
is wrong by default and, for most of the world, cannot be corrected through the
UI. #145: an *invalid* value degrades every teacher date to UTC without
throwing. #157: nothing watches the warnings either degradation writes. Fixing
#145 alone hardens a column whose common failure is a valid-but-wrong value it
cannot detect; fixing #258 alone leaves the silent fallback. **This round also
made #157 slightly worse on purpose** — both new refusals log at `info` with
the fields that separate their three causes, and by #157's argument nobody is
reading them. That was still the right call (a refusal that leaves no trace is
worse than one nobody has read yet), but it is a debt this file should hold
rather than a feature. #257 has no natural bundle: it is one function in
`template-sync.ts` and a semantics question about recurring classes.

**Two of the review's own findings did not survive measurement, and that is
worth recording in both directions.** The review reported the date-picker bug
as affecting both class forms; the create wizard's `if (loading)` early return
means its date field never exists in server HTML, so it was already correct —
by accident of an unrelated fetch gate, which is why it uses the hook anyway.
It also reported the `updateClass` field gate as inert, with the deletion
proven by a green suite; that was true when measured and stopped being true
three commits later, when failing closed made two `NaN` instants compare
unequal and the gate became the only thing stopping a description-only edit
from being refused. This file already records #238's lesson that a plausible
review finding is indistinguishable from a measured one until someone measures
it. **This round is its mirror: a measured finding expires too, and a fix
landing in the same file is enough to expire it.**

### The finding this round is actually about

**A fix verified only in the environment the test can see is not verified, and
this one shipped broken twice in the same three lines before that was noticed.**

`min={todayLocal()}` on the two class date pickers bounded them at UTC's
calendar day. The first repair replaced the UTC read with a local one and
asserted the attribute in jsdom — against `new Date().toISOString().slice(0,
10)`, the same expression the component used, so both sides moved together and
the test could not fail. That failure mode is already in this file, and the
commit fixing it said so in its own message.

The second repair fixed the expression and pinned a literal clock, so the test
could fail. It still shipped broken. Both consumers are `'use client'`
components under `(teacher)/layout.tsx`, which awaits `getSession()` and a
Prisma count — so Next.js server-renders them per request, in the container's
zone, and no `TZ` is set in the Dockerfile or either compose file. That zone is
UTC. React 19.2.7 then KEEPS the server's attribute through hydration rather
than replacing it with the client's: measured, server `2026-08-19`, client
`2026-08-18`, recoverable errors `0`, server value survives.

**jsdom has no server.** A component test renders once, in one process, in one
zone — so the production failure mode is not merely untested there, it is
*unreachable*. The test was correct, falsifiable, and blind. The second fix's
own commit message closed by recording the remaining gap as "the device's zone,
not `Teacher.defaultTimezone` — those agree unless the teacher is travelling",
which was precise about the wrong axis while the server/client axis went
unmentioned.

The repair was to stop the server having an opinion: `useTodayLocal`
(`useSyncExternalStore` with a `getServerSnapshot` returning `undefined`) emits
no bound server-side and lets the browser supply the day. The tests that now
hold it are three, deliberately, because no one of them sees the whole
sequence: `renderToStaticMarkup` asserts the server emits nothing,
`renderToString` + `hydrateRoot` asserts the client's value arrives on the same
DOM node, and a plain client mount asserts it is there immediately. **The
hydration one was added because neither of the others runs what a browser
runs** — and it first failed by breaking its neighbour, since Testing Library
only cleans up containers it created.

**The generalisable rule: ask what the test environment cannot express, not
just what the test asserts.** "Can this test fail?" was asked and answered
correctly here. The question that would have caught it is "can this test
environment produce the bug?" — and for anything whose behaviour differs
between server and client, host and browser, or one zone and another, a
single-process test says nothing about the axis that matters.

Two smaller notes, both from the scoped re-review:

**Fixing a defect class one instance at a time reproduces it.** Making
`startsInPast` fail closed made an Invalid Date reachable on the refusal path —
where the log line then called `toISOString()`, which throws on exactly that
input. A guard added to turn a silent wrong answer into a clean 409 turned it
into a 500 instead, and the commit shipped a comment claiming "the callers
NaN-check their own instants" when three of four did. Separately, moving the
timezone misattribution out of `classStartInstant` relocated it: `Date.UTC`
returns `NaN` for a bad YEAR as readily as a bad hour, so a broken date was
logged as an unparseable `startTime`. Before the guard a bad time was blamed on
the zone; after it a bad date was blamed on the time. **Both repairs were the
same shape — replace the repeated hand-check with one named function
(`isoOrNull`), and split the combined test into one per cause** — and both are
the "prefer handling the case to proving it cannot happen" rule from #247's
round, applied to a claim about sibling call sites rather than about the repo.

**Convergence again, and this time between a human pass and an agent pass.**
The `RangeError` above was found independently by both halves of the scoped
re-review, within minutes of each other, on a branch that had already been
through a five-agent wave. #247's round recorded that convergence between
independent reviewers is worth weighting; the addition here is that the
re-review found nothing the *original* wave had missed — every one of its
findings was about code the fix round had written. **A fix round needs its own
review, and it is not the same review.**

## This round's spin-outs (#247, PR #250) — three, and a correctness argument that depended on a census

~~**#247**~~ **CLOSED 2026-08-18** (PR #250, rebase-merged, 20 commits over
8 non-test files: 7 in `src/` plus one migration). One out, four in across the
round: **#249** filed by the branch itself, and
**#251**, **#252**, **#253** from a five-agent review wave (comments, tests,
error-handling, code, simplify; type-design skipped as not applicable).

**#249 stays open on purpose and that is the interesting half of the scope
decision.** #247's acceptance criteria describe two sequences and close only
one. The branch froze the class at terminality; the PRE-terminal path — edit a
live class's `date` into the past, let `autoTransitionToInProgress` then
`autoCompleteClasses` walk it to `completed` legitimately, on a date older than
the retention window — is untouched, and both guards are innocent there because
the class was not terminal when the date moved. Bounding that input needs a
product call about whether backfilling a past class is ever legal, so the
branch filed the decision with four options rather than picking one inside a
data-loss fix. `waitlist-retention.ts`'s header says this in the module that
does the deleting, which is where a reader will meet it.

The three review spin-outs are all hygiene rather than defects: **#251** a
globally-scoped sweep whose returned count a test asserts is zero, so any
suite's past-dated `in_progress` fixture reddens a file its author never
touched (reproduced, and it self-heals because the sweep consumes the
leftover); **#252** three defects sharing one cause — they live in an applied,
checksummed migration and cannot be edited out; **#253** `slotTime`
hand-copied into eight test files, each copy commenting that it mirrors the
others.

**The review found no correctness defect.** All five guard sites survived
mutation testing, the 13-write-site census reproduced exactly, and gate 4 was
clean — the ownership 403 runs before `parseBody`, so the new 409 is
unreachable by a non-owner and there is no 409-vs-404 enumeration oracle.
Everything it found was a claim that was wrong, or a gap *around* the guard.

### The finding this round is actually about

**A correctness argument that rests on a whole-repo census has made the census
its weakest link, and the census is the part nothing can keep true.**

`isTerminalStatusViolation` matched only the typed (`Unknown`) Prisma error
shape. A raw-query fire of the same trigger arrives as `P2010` and therefore
classified 500 rather than 409. That was recorded as a deliberate choice, and
defended — at length, in three places — on the grounds that it is unreachable:
the only raw statements in `src/` touching `Class` are `SELECT … FOR UPDATE`
and the lock-timeout `SET`, none of which can fire a `BEFORE UPDATE` trigger.

The reasoning was correct. It was also, by the time it shipped, **already false
as written** — `class-terminal-date.test.ts` is in `src/` and contains three
raw `UPDATE "Class" SET date` statements, so the sentence was refuted by the
test file the same branch added to prove the trigger. The intended scope was
"production code in `src/`"; that is not what it said, and a reader running the
implied grep meets the counterexample immediately. The census had drifted
between being written and being merged, inside one branch.

The repair was not to fix the sentence. It was to **delete the dependency**:
match both error shapes, the way `isTransientDbError` twenty lines below had
already settled the identical question for `55P03`, on the identical reasoning
(both shapes mean the same thing to a caller, so a matcher built for one
silently misses the other). **The widened matcher is two lines SHORTER than the
narrow one** — 5 against 7 — and it took with it the two paragraphs and the
test docblock that argued unreachability, the census inside them, and every
future obligation to re-verify it. The narrow version was not the cheap option
in any dimension; it only looked conservative.

**The generalisable rule: prefer handling the case to proving it cannot
happen.** "Unreachable because nothing else in the repo does X" is only as true
as the last grep, it decays silently, and it has to be re-established by every
reader who wants to trust the branch. This file already records the sibling
lesson from #238's round — that a plausible review finding is indistinguishable
from a measured one until someone measures it. This is its converse: a
*measured* claim about a moving target expires, and the fix is usually to stop
needing the measurement.

Two smaller notes from the same wave, both worth keeping:

**Three of five independent agents found the same defect**, and it was the one
the branch was best defended against. "The early return is an optimisation for
every case but one" was asserted in two source comments, the spec's §3.4
heading *and* body, and the plan's mirror — while the branch's own test
`'answers terminal, not no_fields, for a body that asks for nothing'` states
the second case in its docblock. The claim and its refutation shipped in the
same commit, after five review rounds aimed specifically at this defect class.
**Convergence between independent reviewers is worth weighting**; so is the
observation that the cheapest defect to find is a claim contradicted by a test
in the same diff, and it is the one the author is least able to see.

**The log level was carrying information the classification could not.** Both
terminality triggers map to one 409 with one message, correctly — they mean the
same thing to a teacher. They do not mean the same thing to an operator: a
status fire is a lost CAS race, while a date fire is *structurally impossible*
while `updateClass` is the only writer of `Class.date` and its CAS excludes
terminal rows. So a date fire can only mean an unguarded writer of the column
`reapClosedWaitlistEntries` reads before it DELETEs has appeared — and it was
logging at the level a lock timeout logs at. **A guard that cannot fire is more
alarming when it fires than one that races**, which is the opposite of the
intuition that "unreachable" implies "low severity".

## This round's spin-outs (#238, PR #248) — one, and a review finding that measurement withdrew

~~**#238**~~ **CLOSED 2026-08-17** (PR #248, rebase-merged, 20 commits). One in,
one out: **#247**, filed by this branch's own review, because the branch created
the exposure it describes.

**#247 is the shape worth naming: a change that makes an existing, inert defect
harmful.** `updateClass` has never had a class-status guard, and the terminality
trigger is `BEFORE UPDATE OF status` — its own SQL says other columns of a
completed class are unaffected. So a teacher could always `PUT` any `date` onto
their own finished class. Before this branch that was inert; nothing read
`Class.date` on a terminal class for a consequential decision. `reapClosedWaitlistEntries`
now does, and it **deletes**. The branch shipped the sweep and recorded the
residual rather than widening its own scope — `waitlist-retention.ts`'s header
and the spec's §2.4 both name #247 and say which half of the predicate is
DB-enforced — but the honest reading is that this round *converted* a latent
defect into a live data-loss path and filed the conversion.

### The finding this round is actually about

**A review finding that survives on plausibility is indistinguishable from one
that survives on evidence, until someone measures it.** The whole-branch diff
review raised five findings. Four were right. The fifth argued the capped-path
`groupBy` should become a scalar `count`, on the reasoning that `cappedOut` is
essentially only true on a first run against accumulated history — so the one
path where the eligible set is large by definition was also the one
materialising a row per class in the Node heap. That reasoning is correct and
the conclusion was wrong:

| capped-path shape | Time | Buffers |
|---|---|---|
| `groupBy` (kept) | **21.5 ms** | 926 |
| `db.class.count({ waitlistEntries: { some: reapable } })` | 46.0 ms | 35,137 |
| raw `COUNT(DISTINCT w."classId")` | 60.2 ms | 929 |

Prisma compiles a nested relation filter under `some` into a semi-join whose
inner side re-joins `Class` to itself, so it nested-loops every `Class` row —
2.1× the time and 38× the buffer traffic to avoid a list of 5,000 short
strings. The change was applied, measured, reverted, and the table now sits in
the comment so the next reader does not re-derive the same wrong intuition.
**The fix was cheaper to try than to argue about**, which is the generalisable
part: the branch had a seeded 50,000-row test database already standing from
Task 3, so the cost of checking was one `EXPLAIN` rather than a debate.

Its sibling, from the same measurement: **the candidate read never scans, and
the reason was not designed for it.** `orderBy: { classId: 'asc' }` exists so
the isolation test's held class sorts first — a testability decision. It is also
what lets Postgres walk `WaitlistEntry_classId_position_idx` in order and stop
at 501 groups, turning the query the issue predicted would need an index into a
2.5 ms early-terminating merge join. #238 asserted the work "carries a
migration"; it carries none, and the plan rather than the timing is what says
so. **#224 is unaffected** — its subject is the 60-second reconciliation sweep,
a different query.

## This round's spin-outs (#216/#182, PR #235) — four, and the round that reviewed its own fixes

~~**#216**~~ ~~**#182**~~ **both CLOSED 2026-08-15** (PR #235, rebase-merged, 28
commits). Two in, four out.

Three review rounds, and the shape is the point: round one reviewed the
implementation, round two fixed it, **round three reviewed round two** — because
round two was self-reviewed, and the same reasoning that proposes a fix is not
positioned to judge it. Round three found a fix that inverted itself, a claim
false in four places, and an Article 17 failure that had been *described in a
comment as retryable* when it provably was not.

**The lesson worth keeping is not "review twice".** It is that a fix wave earns
the same scrutiny as the code it fixes, and mutation testing does not supply it:
mutation proves a test *can* fail, never that it asserts the right thing. Three
guards this branch added passed 763, 1172 and 205 tests respectively when
deleted; one test went **vacuously green rather than flaking**, which keeps CI
quiet while the guard is gone.

**#234 — attendance cannot be edited after a class completes.** `showCheckin`
goes false within about a minute of the scheduled end, so a teacher's only window
to record attendance is while they are teaching. The write path already tolerates
a post-completion correction — that is what the PUT's deliberate `completed`
allowance protects — so this is UI work with one open question: whether the
editing window ever closes.

**#236 — a late cancel frees the seat to the open market, but the waitlist is
frozen out of it.** A late cancel is by definition after the cancel deadline, so
`handleSpotFreed` always short-circuits on `frozen`: the seat goes to the public
booking page and the people queuing for it are the only ones who cannot have it.
Freezing *auto-promotion* is right — it bills without consent. Freezing the
*opt-in broadcast* is not, and the two are frozen by one condition only because
they read the same window function. A boundary change, not new machinery.

**#237 — multi-row `Class` locking is a convention tracked in prose.** Five sites
hand-roll the same ordered `FOR UPDATE OF c`, and this document's sibling
(`docs/lock-order.md`) maintains a five-row table tracking them — a
hand-maintained census, which has already been corrected about *this exact list*
three times. Filed with a debt attached: replacing the erasure's lock loop with a
single statement made the AB-BA cycle unconstructible, so three deadlock tests no
longer detect a missing `ORDER BY`. Verified, written into the tests, and repaid
by testing the shared primitive once rather than per pairing.

**#240 — DONE (PR #246, 2026-08-16).** `deleteStudentAccount`'s transaction
budget is a flat `{ timeout: 20_000 }`; the count that sized it is gone. What
the issue did *not* contain was the useful part: `gdpr.ts` held both halves of a
contradiction three hundred lines apart. One paragraph argued the count must be
`waiting`-only because the lock statement's cost no longer scales with N; a
later one, added by #237's review, said it does. The argument against the fix
was also inverted — `min(5_000 + N·2_000, 20_000)` is monotone non-decreasing
and capped, so an all-status count could only ever grant *more* budget. Verified
at `7298311`'s parent `f1caede`, which carried the all-status count **and** the
loop simultaneously: the count revert strictly reduced the budget, so only the
loop removal can have fixed anything. `7298311` changed both and credited the
wrong one.

**Three lessons, none of them about erasure.**

1. **A keyword census cannot find a claim that changes verb.** The sweep was
   specified at six artifacts and finished at ten. "sized" → "sizes" →
   "`Math.min` ceiling" → "is exactly this caller", plus one where the phrase
   wrapped across a line break. Each of the four extras was found by a
   *different* agent reading for meaning. The count is not the lesson; the
   mutation of the surface form is.
2. **The ninth artifact was text this branch wrote.** The plan's own replacement
   corrected the sizing clause of a sentence and left its loop clause standing —
   inside the commit whose purpose was correcting stale claims about that
   function. Twin-fixing is not a rule you can follow by intending to.
3. **Three implementers independently flagged the same plan defect** wearing
   three disguises: keyword-*absence* checks (`grep` must return nothing)
   specified for a change whose deliverable is prose that quotes the removed
   keyword. The right check was always "no surviving hit makes a false
   *current-state* claim" — a reading task, not a grep.

Also: the new test could initially pass vacuously, and the whole-branch review
caught it. Its assertions are now causal *and* elapsed (`> 5_000ms`, the old
floor), mutation-proved twice by two agents at 2780ms and 2967ms. And
`docs/lock-order.md:910` lost half of an argument **#229** rests on — both
erasures now carry flat budgets, so "the tuned budget would absorb a re-ordering
and the flat one would not" no longer applies. Whoever takes #229 should read
that paragraph first.

**#243 — CLOSED UNBUILT (2026-08-16, NOT_PLANNED).** Verifying its premise is
what closed it. Its headline claim — that narrowing the pre-lock's fragment
would be silent, surfacing only as an intermittent `40P01` — is false:
`gdpr.test.ts`'s five-status `it.each` was written for exactly that mutation and
four of five cases fail deterministically. So the fix was
structural-vs-test-enforced, not detected-vs-silent. It also costs more than the
issue says: scoping the delete to the locked ids lets a waitlist join committing
mid-erasure *survive* the erasure, so making it safe needs a postcondition
guard, a new error class, a branch in `erasureFailure` (`isTransientDbError`
cannot see a service-level error, so the caller would be told "pressing Delete
again will not fix it" about the one failure it does fix), and two tests — one
racing HTTP against DB interleaving. All to close a race requiring a student to
join a waitlist during their own erasure, which cannot be closed anyway under
READ COMMITTED, only narrowed. Visible, not worsened. Full analysis in §1.4 of
`docs/superpowers/specs/2026-08-16-erasure-budget-design.md` and on the issue.

**#244 — updated, not duplicated.** Eight stale present-tense "lock loop"
references enumerated onto it (three in `template-lock-order.test.ts`, two in
`gdpr.test.ts`, one each in `db-locks.test.ts` and
`tests/integration/account-api.test.ts`, plus `docs/lock-order.md:701-708`,
which still carries the inverted argument with no pointer to its rebuttal).
They carry loop claims only, with no budget claim attached, so PR #246 had no
reason to open them. Enumerated so a fifth round does not rediscover them. The
count rose from five to eight *while the list was being written*, which is the
branch's own lesson happening again.

~~**#238 — nothing ever reaped a closed, unfulfilled `WaitlistEntry`**~~
**CLOSED 2026-08-17 (PR #248, rebase-merged, 20 commits)** — see its own
spin-out section below. The triage reasoning is kept as written, because two
of its four clauses turned out to be overstated and the correction is only
legible beside the original: classes are never deleted; `onDelete: Cascade`
from `Student` never fires because erasure anonymises rather than deletes. So
the population grows for the life of each account, which is what made the
erasure's lock set unbounded, `reconcileWaitlists`' join load-bearing rather
than belt-and-braces, and the Article 15 export a record of years of
non-events. Also a storage-limitation problem in its own right — the retention
period is a decision, and #248 decides it at 365 days.

**Two of those four clauses did not survive the branch that closed them.** The
lock set is **shrunk, not bounded** — the erasure's pre-lock joins
`WaitlistEntry` with no status predicate while the sweep reaps only UNFULFILLED
entries, so a student promoted week after week still grows it for the life of
the account. And `reconcileWaitlists`' join was already belt-and-braces before
#238 was filed: #216's `closeQueueOnStart` did that one round earlier, and the
comment quoted in support of the claim is explicitly past-tense. Left standing
above rather than rewritten, because a triage entry is a record of what was
believed at triage time.

### The finding this round is actually about

**A guard added in the same commit as the guard it accompanies inherits none of
its coverage.** Every mutation survivor in round two was a second clause, a
second status in a list, a log-level branch, or a lock — added alongside
something that *was* tested, and assumed to be covered by proximity. The branch
mutation-tested the guards it wrote tests *for*, and not the guards it wrote
*beside* them.

Its sibling: **a client-side pre-check of server state can only ever subtract.**
`AttendanceList` took a `classIsOpen` prop to avoid offering a tap the server
would refuse. The page is a server component with no `revalidate`, so the prop
froze at render and the control never unlocked once the class started — a
*silent* refusal replacing a visible one, on the only screen in the app designed
to be held in one hand at a venue.

## This round's spin-outs (#83/#209/#180, PR #230) — three, and a defect class this branch kept producing

~~**#83**~~ ~~**#209**~~ ~~**#180**~~ **all CLOSED 2026-08-15** (PR #230,
rebase-merged, 24 commits). Three in, three out — the first round in a while
where the spin-outs are neither regressions the branch introduced nor debt it
merely walked past, but **defects in its own prose**, found by a five-agent
review wave after the implementation was already green.

**#231 — returned failures no operator can see.** A service that `return`s
`{ ok: false }` never reaches `withErrorHandler`, and `respondError` does not
log. Two of `updateClassTemplate`'s four mapped branches log nothing — and one
of them is worse than a missing line: catching a P2002 there *deletes* the
`warn` `classifyApiError` would have emitted, so the catch is a net loss of
observability. The rule is already written down twenty lines away on the
archive's own branch ("catching it here must not be what removes that"),
applied to one branch out of three. Folded in: a P2003 escape (a room deleted
between the guard and the write 500s for a case the guard models as
`invalid_room`) — the *opposite direction* to #103, which is the room-deletion
side.

**#232 — a drained connection pool is logged as a lost lock race, at warn.**
`isTransientDbError` maps `P2024` (pool exhaustion) and `P2028` (transaction
budget) alongside the genuine contention codes, so on a 2 GB VPS a connection
leak makes every template write answer 503 and log "lost a lock race". Nothing
in the codebase produces an `error`-level line for pool exhaustion. Filed as a
decision because the fix is a choice about what the alerting contract is.

**#233 — `refilled: 0` means two different things.** "The refill ran and
created nothing" and "the refill never ran, because the template is paused" are
indistinguishable on the wire, so a paused day-edit tells the teacher N classes
were destroyed and offers no reason. Same shape as #194's finding for the
studio family: the number is truthful, which is what makes it useless.

### The finding this round is actually about

**Every defect the review found is a claim that was true before the change and
was not re-derived after it.** Not one was a logic error. The `busy` cause
enumeration named only the `ClassTemplate` row — correct until the sync's
pre-lock joined the transaction and made an ordinary booking able to time an
edit out. `gdpr.ts` said all five `Class`-lock sites "agree" while the archive's
own comment two files away says its ordering "is not total". `deleteMany` "can
no longer be the one that waits" — refuted by the branch's own spec table.
Seven `file:NNN` citations were stale, **one of them broken by the branch's own
preceding commit.**

That last one is the general lesson and it applies to this document too: a
reference by line number is a claim with an expiry date nobody sets. The fix
was to stop numbering — each citation now names the function or statement it
means. The same argument retires the "102 tests across four files" style of
count, which was stale on arrival and doing no work.

**The corollary for review process:** nine of twelve mutations bit, and the
three that survived were invisible to reading. Narrowing the archive pre-lock
left 86 tests green because the fixture held zero `Registration` rows; dropping
`'draft'` left the same 86 green because both fixture classes were `open`. The
second was closed by **one word** — making the lower-id class `draft`. Reading
a guard confirms it; breaking it finds it cannot fail.

---

## This round's spin-outs (#220, PR #222) — four, and a fix that was wrong twice

~~**#220 — a lock-timed-out waitlist broadcast is dropped for good.**~~
**CLOSED 2026-08-14** (PR #222, rebase-merged, 16 commits). What was learned is
not in the issue:

- **The first fix was wrong, and its own limitations list understated the
  defect.** The reconciliation sweep gated re-broadcasts on "does a
  `spot_available` notification exist inside the current claim window". A claim
  window is 60 minutes wide and holds more than one seat-freeing event, so the
  sequence it could not repair was the ordinary one: seat frees → broadcast
  succeeds → a waiter claims → the seat frees **again** → the live hook drops the
  second broadcast, and the first notification is still in the window. The PR
  body had documented "*two failures* in one claim window" as accepted. The real
  scope is one **success** then one failure — strictly likelier, and not what was
  written down. **An accepted limitation is only accepted if its stated scope is
  the true one.**
- **The obvious cheaper fix was broken, and only reading the callee showed it.**
  Deriving the gate's boundary from `max(cancelledAt)` fails because
  `activateRegistration` sets `cancelledAt: null` on reactivation — so the
  boundary moves *backwards* when a student rebooks. It would have shipped and
  misbehaved at unpredictable moments. The correct key was never a timestamp: a
  broadcast is invalidated by the seat it announced being **filled**, so the flag
  is cleared on the fill, at the one function every seat fill converges on.
- **The structural fix deleted more than it added.** `Class.spotBroadcastAt`
  turned the gate into a field read on a row the sweep had already loaded, which
  removed a query per gated class per tick and made
  `Notification_relatedClassId_type_createdAt_idx` — added *one commit earlier*,
  with a paragraph of justification — dead. The branch adds an index and drops it
  three commits later. **A cost argument for an index is only as good as the
  query it is arguing for.**
- **Two of the four earlier fix commits were verified by nothing, and only
  mutation showed it.** Two reviewers *read* the transient/non-transient
  classification and correctly called it well-reasoned. Inverting one operator —
  `const transient = !isTransientDbError(err)` — passed **11/11**. Restoring the
  pre-fix `try` boundary also passed. Reading a guard confirms it exists; only
  breaking it shows whether anything would notice it going wrong. All three
  mutations now fail exactly the one test written for each.
- **`/api/health` was not silent about a broken sweep — it asserted the sweep was
  fine.** Because `reconcileWaitlists` swallowed every per-class failure, the
  scheduler stamped `lastSuccessAt` and nulled `lastError` every tick, so a sweep
  repairing nothing answered `healthy: true` with a fresh timestamp. That is a
  worse failure than a missing signal and it was filed in the PR body as an
  accepted limitation. `isolatedSweeps` already had the answer in its own
  docblock ("the first is rethrown so job health still surfaces the failure") and
  two neighbouring jobs already used it.
- **The commit titled "stop citing line numbers" touched only `docs/`.** Its
  message says *"a reference that breaks whenever you edit the file it points at
  is not a reference"* — and left all 16 source citations in place, of which
  **8 of 20 checked were wrong**, pointing at a function parameter, a closing
  brace, a blank line, and in two cases a *different, plausible-looking* guard.
  The same commit range added a fresh one. A rule stated in a commit message
  governs nothing the commit did not touch.
- **A measured flake rate is not refuted by a green run.** Two reviewers measured
  the two headline tests at 5 failures in ~28 runs and 1 in 10; the driver then
  ran them 5× clean and learned nothing (at 10%, five clean runs has ~59%
  probability). What settled it was fixing the two mechanisms — `class.findMany`
  had no `orderBy`, and five assertions used class-wide notification counts —
  rather than re-running until convinced.
- **The fix wave wrote a false comment while fixing false comments**, which is
  § "The finding #212's round is actually about" re-earned — that section already
  records the pattern as "known but re-earned", so this is at least its third
  observation and the exact number is not derived here. The `try`'s widened scope
  was justified as catching `classStartInstant` throwing on an invalid timezone.
  It does not throw — it catches and degrades to UTC (#145). Caught by re-reading
  the callee before claiming it, not by any tool.

**Method note worth copying: three of five agents found the gate defect
independently**, from three unrelated starting points — one from the diff, one
from the escalation path, one from a comment the branch had *changed*. Single-
agent confidence is cheap; independent rediscovery from different entry points is
what moved this from "plausible" to "redesign it". The two findings that came
from only one agent were both overstated on inspection, and one sub-claim was
simply wrong (`addToWaitlist` refuses a join while a seat is free, so the "a
student who joins mid-window is excluded" case cannot arise).

Ratio: **one closed, four opened** — and unlike the previous two rounds, none of
the four is a regression this branch introduced:

- **#223 — `Notification` has no retention policy.** The highest-volume table,
  one row per recipient per booking/cancellation/payment/reminder/announcement,
  and the only deletes anywhere are GDPR erasure. Monotonic growth against a
  fixed 2 GB ceiling. Not a bug today, said so in the issue.
- **#224 — `WaitlistEntry.status` and `Class.status` are unindexed**, and the
  sweep's candidate query scans both every sixty seconds. Sibling of #205.
  Genuinely sub-threshold; filed because the sweep converted an occasional cost
  into a periodic one, and the issue says to measure before adding anything —
  this branch has just demonstrated the cost of indexing a query that then went
  away.
- **#225 — `setInterval(tick, job.intervalMs)` is unpinned.** `buildJobs` pins
  the table, `makeTick` pins the guard and the health bookkeeping, and nothing
  pins the seam: hard-coding the interval to 60 minutes passes the whole suite.
  Thinnest of the four, and the issue says so — the reason to file is that it is
  now the *only* unpinned link in a module where everything else was made
  assertable.
- **#226 — a broadcast dropped in the final minute before the cancel deadline is
  never repaired.** The class is `frozen` by the next tick. Filed as a decision
  because repairing it means letting something hand out a seat after a deadline
  the product treats as a promise to the teacher.

**Three findings deliberately did NOT become issues**: the suite's inability to
run concurrently with itself became **a comment on #177** rather than its twin,
since the cause is the same unpruned test database; the `Job`/`JobSpec` split
(`running?: boolean` on the type `buildJobs` returns) was **let go** as tidiness
in an already-large PR; and the unconditional `spotBroadcastAt` clear's
chattiness — two free seats in a claim window means each claim re-opens the gate
— was **documented in code as an accepted trade**, because the precise version
needs a seat count on every booking and can drift from the thing it counts.

**Cross-reference added rather than filed:** #216 now carries a note that the
sweep's `class: { status: 'open' }` join is a *workaround for it*, that the join
is a cost bound rather than a correctness guard (removing it fails no test, by
design), and that whoever fixes #216 should know both.

## This round's spin-outs (#212, PR #218) — two, and what actually cost time

~~**#212 — the final-hour waitlist broadcast has no capacity check.**~~
**CLOSED 2026-08-13** (PR #218, rebase-merged, 10 commits). What was learned is
not in the issue:

- **Both of the issue's load-bearing claims were wrong, and it was still a real
  bug.** Its scenario ("a second cancellation and re-registration, or a walk-in")
  cannot produce a false broadcast — a cancel frees the seat it announces, walk-ins
  need `start − 15 min` against a claim window ending at `start − 6 h`, and
  `maxStudents` is frozen at first registration. And its recommended fix (a bare
  `registration.count`) does not work: outside the lock it moves the race rather
  than closing it. **Verifying the premise changed the fix, not just the prose.**
  The only reachable path is a refill committing between the cancel and the hook,
  which is exactly why the count has to be under the lock.
- **A test written to close a review finding was itself wrong, and only under
  load.** Round one shipped no proof of the lock; round two added one and measured
  it at idle; round three (the multi-agent review) ran it under CPU load and got
  **4 false passes in 5** with `lockClassRow` deleted. The verdict was
  `Promise.race([hook, 400ms])` — "did not finish in 400 ms" is not the
  proposition "blocked on the lock", and instrumented, the hook had not reached
  its `FOR UPDATE` when the verdict fired. **An idle measurement of a timing test
  does not generalise to CI**, which has fewer cores. The replacement asserts
  `55P03` — a SQLSTATE slowness cannot invent.
- **The same paragraph in `docs/lock-order.md` undercounted three times, twice by
  me.** "The one site that took no `Class` lock" → my correction, "three" → the
  truth, **four**. Each time the method was: enumerate from memory, then apply the
  right grep only to what was enumerated. The paragraph it sits in exists to
  record an earlier undercount of seven against eleven. **The grep has to run over
  the whole table, not over the rows you thought of.**
- **Two mutations behaved differently from how they were predicted**, and both are
  now recorded as observed. M10 fails 15 tests rather than 2; M11's
  `@ts-expect-error` does not go unused as expected — four other sites break
  instead. A guard whose observed failure differs from its documented one is how
  the next reader concludes it does not work.
- **The fix wave's own list missed two locations; reconciling against the diff
  caught them.** A finding naming three artifacts got one fix. This is the §4
  procedure earning its place for the second round running.
- **Pinning a type at its definition is worth nothing if it disables checking at
  every use.** `as const satisfies` pinned membership and forced
  `as readonly string[]` at three `.includes()` sites — a cast that accepts any
  string, under which `.includes(waitlistStatus)` compiled clean and answered
  `false` forever. The plain annotated + frozen form (`CHARGED_STATUSES`' shape)
  deleted all three casts.

Ratio: **one closed, two opened**, both leaves, both decisions with costed
options — and both are regressions this branch introduced rather than debt it
noticed:

- **#219 — `readSeatCount`'s lock precondition is a comment.** The helper returns
  a normal-looking number when called without the `Class` row lock, which is the
  defect #212 existed to fix. The brand blocks a bare client and cannot check a
  lock was taken. Options costed: a `ClassLock` token (recommended — its
  `unsafeClassLockTaken` escape hatch makes the #104 debt greppable and empties
  when #104 lands), a `FOR UPDATE` in the helper's own read, or leave it.
- **#220 — a lock-timed-out broadcast is dropped for good.** Before #218 the
  unlocked write blocked *unboundedly* and always eventually fired; now it aborts
  at 2 s and nothing retries. Reachable via `deleteStudentAccount`, which holds
  each class row for its whole transaction (up to 20 s). Silent and financial: an
  unsold seat reprices the class upward for everyone left. Absorbs the
  never-filed audit line at `docs/audits/2026-07-18-review-round-2.md:75` ("no
  sweep re-checks waitlists vs free seats").

**Three findings deliberately did NOT become issues**, which is the part worth
copying: a new `RegistrationStatus` being silently absent from both subsets got a
**docblock signpost** in `lib/registration-status.ts` (it only matters at the
moment someone edits the enum, and that is where the reader already is); the
`attendance-list.tsx` widening became an **update on #132** rather than its twin;
and the pre-commit `emitToBus`, the `window_frozen` swallow and the P2025 change
were **let go** with evidence, the first two because the outcome is correct and
the third because it is benign and recorded in the PR body.

## This round's spin-outs (#211) — four, one of them live

- **#212 — the final-hour waitlist broadcast has no capacity check.** Its two
  siblings both gate on `activeCount >= maxStudents` (`promoteNext`,
  `claimSpot`); the broadcast branch has neither, so a refilled class still
  tells every waiting student a spot opened. The notification is wrong *when
  sent*, not stale by the time it is read. **A live bug, filed not folded** —
  wrong content, not duplication, and #196 was about duplication.
- **#213 — decision: result union vs thrown sentinel for an already-erased
  account.** `AlreadyErasedError` turns a rollback into a 200. A caller who
  forgets to catch gets a 500 at `level: 'error'` for an operation that
  *succeeded*, on a GDPR path, reachable only under a race — so it will never
  fire in dev or CI. Options costed, and honest that **none makes the omission
  a compile error**; they improve the default, not the enforcement.
- **#214 — decision: bind a magic link to the requesting device.** Reduced to
  the one question everything follows from: is request-on-one-device /
  click-on-another expected? Records that token *reuse* is unbuildable, so
  nobody re-derives it.
- **#215 — move the announcement send into a service.** The weakest, and said
  so in the issue. What earns it a place is that the advisory lock's two safety
  properties ("first statement", "exactly one call site") are comments a reader
  must remember; a service boundary makes them structural.

Sequence, revised 2026-08-11 now that #196's product question is answered and its
mechanism chosen (per-endpoint natural keys, no idempotency infrastructure):

~~**#164 + #192 (the generator family)**~~ ✓ done (PR #204) →
~~**#196 branch 1**~~ ✓ done (PR #208) — the migration: six partial unique
indexes, and **thirteen** write paths, not the five the plan scoped, because the
indexes constrain every verb → ~~**#196 branch 2**~~ ✓ done (PR #211) — **#196
CLOSED 2026-08-13.** #197's copy half can land any time; its
codes half is unblocked too, since the chosen mechanism does not depend on it.

**The paragraph below is what branch 2 disproved, and it is kept as written.**
It says branch 2's design was already done and nothing in it was blocked.
Seven of its nine rows were wrong, two would have shipped a regression, and the
governing spec is now
`docs/superpowers/specs/2026-08-12-retry-safe-endpoints-branch-2-design.md`.
Left standing because the useful lesson is not "§4.2 was wrong" but **how
confident this entry sounds while being wrong** — written from a design nobody
had yet read against the code, and read for two days as settled work.

Branch 2's design is already written — `docs/superpowers/specs/2026-08-11-retry-safe-endpoints-design.md`
§4.2, with the product decisions that chose each mechanism in §1. Nothing in it
is blocked: announcements takes a `pg_advisory_xact_lock` and a 2-minute window,
the reminder cooldown reads a `Payment.reminderSentAt` that is already written
and never read, magic-link and student-signup share one helper fix, and the four
race findings are `where`-clause scopes. No schema change anywhere in it.

**#196 branch 1 is the next thing, and none of #205/#206/#207 gate it.** All
three came out of #204's review and all three are independent of the migration:
#205 is a `StudioClass` index (a performance parity gap, and the one worth
*folding into* branch 1 since that branch is already writing migrations for both
tables — bundle it, don't sequence it), #206 is a repo-wide response-typing gap
that no #196 endpoint depends on, and #207 is a test-idiom sweep. Branch 1's real
prerequisites were the generators' pre-check and their skipped-slot reporting,
and both landed in #204.

Two notes on that order. #164 and #192 moved to the front because #196's `Class`
index makes #164's rare aborted-transaction path routine — a dependency, not a
preference. And **#196 branch 1 does not close #196**; branch 2 does. (Written
that way deliberately: GitHub's auto-close parser matches `close #N` and does not
read a negation in front of it — #191 closed #113 exactly that way. #204 proved
the same parser fails in the *other* direction: "Fixes the generator-family pair
#164 + #192" closed neither, because the keyword must sit immediately before each
reference. Check the open count after every merge.)

## This round's spin-outs (#204) — three, from an area the review found thin

- **#205 — `StudioClass` has no `(teacherId, date)` index.** The new occupancy
  query is index-backed on `Class` (`@@index([teacherId, date])`) and a sequential
  scan on `StudioClass`, hourly. #196 will *not* fix it: its studio index is
  partial on `cancelledAt IS NULL`, and this query deliberately reads cancelled
  rows to tell `blocked_by_cancelled` from a free date. Needs a migration → fold
  into #196 branch 1.
- **#206 — no route's response literal is checked against its response type.**
  `respondOk<T>(data: T)` is unconstrained and every client re-declares the shape
  by hand. Pre-existing and repo-wide; newly *visible* because #204 removed the
  phantom `never` brand that was catching it for the one pair. Verified live:
  dropping a field from the PATCH `active` arm makes the resolver return `null`
  and the teacher gets no confirmation, with the full suite green.
- **#207 — the toggle-payload pins use `@ts-expect-error`**, the idiom
  `src/lib/type-pins.ts:61` already rejected for accepting *any* error on the
  line. Both directions currently bite (mutation-proven); this is durability.

**Ratio: 2 closed, 3 filed.** Not one-in-one-out, and the reason is worth stating
rather than letting the count pass: all three came from the *type and response*
layer, which four previous rounds on this family never reviewed because no round
before this one changed a response shape. That is a genuinely under-explored area
surfacing at once, not scope creep — but it does mean #196 branch 1 will be
touching a layer with three known open issues under it.

## The finding #220's round is actually about

**A heavily-reasoned PR gets its prose audited and its evidence trusted.** Five
agents reviewed the last five commits of #222 and returned nine findings. Exactly
**one** was a wrong-output bug. The other eight were verification gaps: a
classification eleven lines of docblock argued for that no test observed; a
health endpoint reporting `healthy: true` for a sweep repairing nothing; eight of
twenty citations pointing at parameters and braces; a measured flake rate in the
two tests carrying the headline claims.

That distribution is the finding. The branch's reasoning was almost entirely
sound — the review changed very few conclusions and confirmed most of the
arguments. What it changed was whether any of it was *checked*. Two of the four
fix commits from the previous review round were, at the time of this one,
verified by nothing at all.

**So the procedural rule this round adds is about where review effort goes on
prose-dense work.** Reading long justifications is the least productive thing a
reviewer can do with them, because a well-written justification is convincing
whether or not the code does what it says and whether or not anything would
notice if it stopped. The cheap high-yield passes, in order:

1. **Mutate the thing the comment is proudest of.** The longer the defence, the
   more suspicious the absence of a test. `const transient =
   !isTransientDbError(err)` passing 11/11 took thirty seconds to discover and
   no reading at all.
2. **Open every `file:line` citation.** 8 of 20 were wrong three commits into the
   branch that wrote them. This is mechanical and nobody does it.
3. **Re-derive one cross-file claim per "only"/"both"/"exactly N".** "Only
   `autoCancelClasses` and the manual-cancel route mark entries `removed`" — one
   grep, six writers, one of them the write this branch's own test asserts on.

Corollary, and the reason the fix wave needs its own pass (see the next section,
which this round re-earns): this round's own fixes introduced a false comment
— `classStartInstant` was said to throw on an invalid timezone when it catches
and degrades to UTC. **A correction is a prose edit, and prose edits are where
false claims come from.**

---

## The finding #212's round is actually about

**Three review passes found 14 real problems. Five came from the implementing
agent; nine were introduced by the reviews themselves** — including two inside
the commit whose message was "four docblocks that asserted what the code does not
do", and two more in the pass after that.

The mechanism is not carelessness. On this project a correction *is* a prose
edit, and the prose is long — so every fix wave writes new claims at the same
rate it deletes false ones. The rate did converge (12 findings, then 2), but the
lesson is procedural: **a fix wave's own output needs the same pass its target
got, and the cheapest form of that pass is `git diff <wave-base>..HEAD | grep
'^+' | grep -E '(always|never|cannot|only|every|N of the M)'` over the added
comment lines.** That one-liner found both of the third pass's findings.

Corollary already known but re-earned: reconcile the wave's diff against what it
was *supposed* to change, never a keyword. #204's POST routes emitted three new
fields under a comment saying the create form would render them; the create form
calls `router.push` and reads nothing. A keyword sweep for "slot_taken" would
have passed.

---

## Bundle 6 — Feature backlog

Net-new surfaces from the API↔front-end gap audit. Larger, product-driven, most
optional. Ordered by how much each is a correctness gap vs. a pure feature.

- ~~**#119**~~ and ~~**#120**~~ **both closed** (PR #191, rebase-merged
  2026-08-11, 8 commits). Resume reports `scheduled` + `added` — occupancy, not a
  bare delta, because the effect lands on the Schedule tab where a delta is
  unreadable; `POST` generates inside its create transaction, matching the class
  family. Four things this round actually taught, none of them a restatement of
  the issues:
  - **A schema constraint can dissolve a product question.** #119 asked whether
    the probe *should* skip a date holding a cancelled row. With
    `@@unique([templateId, date])`, skipping is the only reachable behaviour —
    adding the filter turns a clean skip into a P2002 whose own hedge then logs
    "generated without the claim held", false at the one site that emits it. Half
    the issue evaporated before any code was written. **Read the schema before
    treating a behaviour question as a product call.**
  - **A guard can be true and still guard nothing, and the same two numbers can
    hide it.** The spec claimed a transposed `resumeStudioMessage` call site
    "cannot pass the copy tests". Two of three PR reviewers independently
    transposed it and got `tsc` clean with all 78 settings tests green: the
    asymmetric data pinned the *function's* parameter order, while every fixture
    reaching the *call site* passed `4`/`4`. Separately, the `cancelledAt`
    mutation was credited to the sharp test's `scheduled` assertion going 4 → 2 —
    it actually dies one line earlier on the *archive's* assertion, also 4 → 2.
    **When a mutation's expected and actual numbers coincide with a neighbouring
    assertion's, name the line, not the number.**
  - **Three guards were clean-compiling no-ops until review.** The type split
    only bit class→studio; studio→class was assignable, so swapping the resolver
    in one studio button reproduced #119 and in the other #93 — the failure the
    split's own docblock cites as its reason to exist. Fixed with a
    `scheduled?: never` brand on the class arm. The pattern, worth carrying
    forward: **this branch mutation-tested the guards it predicted and not the
    guards it assumed**, and all three defective ones were in the second group.
  - **A local model handled the build well, given the traps written down.** Five
    tasks, five commits, all mutations run and reported with verbatim output, and
    it correctly surfaced four plan defects rather than bending code to match
    them — including a checklist item that contradicted the plan's own mandated
    docblock. The handover's longest section was about a line of code that must
    *stay* looking broken; that is the section that earned its length.
  - Spun out **#192** (the probe cannot tell idempotent skip from a permanently
    unfillable date — filed as a decision with three costed options, because one
    breaks a documented cross-family parity), **#193** (a committed toggle can
    report "Network error" then answer the retry with silence — all four
    buttons, pre-existing), **#194** (editing a studio template's day leaves its
    old classes standing and the count says 8 — had been travelling in prose
    only). Updates on **#113** (both families' create routes run on Prisma's 5s
    default while every peer that locks those rows budgets 10s) and **#116**
    (which now also owns the class family's identical un-archive silence, and the
    note that giving its `active` arm a count means removing #191's brand).
    One finding was deliberately homed in a **comment** rather than the tracker:
    the hedge's `continue`-absorb suits no current studio caller, and the warning
    a maintainer needs is already beside the code.
- ~~**#199 — stranded waitlist entries render as live.**~~ **CLOSED 2026-08-13,
  PR #217** (rebase-merged, 13 commits). Spun out #216. One in, one out.

  **What was actually learned, none of it in the issue:**

  - **The issue's proposed fix was the wrong shape, and its own premise was why.**
    It asked for `class: { status: { not: 'cancelled' } }` because it believed
    #195 had bounded the stranded population. #195 closed the three exits to
    `cancelled`; the three exits to `in_progress` close nothing, so the larger
    half sits on classes that *started* and the negative predicate would have let
    it through. The shipped predicate is `status: 'open'`, which is not defensive
    invention — it is the predicate `addToWaitlist`, `promoteNext`, `claimSpot`
    and `handleSpotFreed` all already enforce, while `removeFromWaitlist`
    deliberately does not. **The reads were the only paths bypassing a rule the
    write layer states unanimously**, which is a better frame than "add a filter"
    and is what made the census complete.
  - **#112's spec had ruled `completeClass` out with a true sentence and the wrong
    question.** *"Which does not remove a class from the schedule"* — correct for
    #112, which asked whose *notice* is owed, and silent on #199, which asks what
    still *renders*. Worth naming as its own failure mode: an exclusion can be
    sound and still leave the gap, because scope boundaries do not carry over
    between questions.
  - **Two rounds of review found the same defect class at two altitudes, and the
    second was in the fix.** The teacher's count qualified the entry and not the
    class, so a completed class still read "3 on waitlist" — this issue's own
    sentence, on the other surface. Then the test written to pin it could not
    distinguish `waiting` from `not: 'removed'`, and after that fix could not
    distinguish it from `notIn: ['removed','promoted']`. **Three tests passed for
    reasons nobody had checked**, and only mutation runs found it: with the
    filter moved from the query into the render, three of four tests still passed.
  - **A spec argument can be true and insufficient.** §6.2 justified its fixture
    with *"no off-by-one predicate reproduces it"*. Both surviving wrong
    predicates were a different *shape*, not an off-by-one. The spec now records
    why its own reasoning was inadequate rather than quietly asserting a better
    one — correcting the fixture alone would have let the next reader regenerate
    the same gap.
  - **Seven of my own citations were wrong across the branch** (`promoteNext:480`,
    `class-transitions.ts:115`, `getSession` vs `validateSession`, two counts, a
    `draft` proof, and a `:44-48` range). Line numbers pointing at prose added in
    the same PR are the worst offenders and were replaced with grep-able
    descriptions. The claim that the Article 15 export was "the only remaining
    user-visible consequence" was **false when written** and was caught by a
    reviewer, not by me.
  - **The tracker sweep is the cheap habit that paid.** Re-deriving every issue
    number in the triage lists recovered #113, closed by accident twice and
    unnoticed for two days.
- ~~**#112 — archiving deletes classes with waiting students, and tells nobody.**~~
  **CLOSED 2026-08-11, PR #195** (rebase-merged, 15 commits). Both product calls
  were answered: notify, yes — on all three paths, not one; spare the class, no,
  because that reopens #86's booked/unbooked line.

  **What was actually learned, none of it in the issue:**

  - **The issue's own comparison point was broken.** It cited `autoCancelClasses`
    as the example of getting this right. That function built its recipient list
    from `registration.findMany` alone and the string `waitlistEntry` did not
    appear in the file. Measurement widened one path to three (archive,
    auto-cancel, teacher erasure) and ruled out a fourth with a proof.
  - **#86 was not careless, it was one sentence wrong.** It examined this exact
    cascade and accepted it, justifying the delete with *"nobody is affected and
    nothing is owed"* — the money test answering the who-is-affected question.
    Nothing is owed by a waiting student; they are still affected.
  - **The fix reintroduced the bug it was written to remove.** The archive's
    candidate read mirrored the delete's charged-registration predicate, so a
    class whose last charged registration was cancelled *between* the read and
    the delete became deletable without ever having been a candidate — waiters
    cascade-deleted, unnotified. Two review agents found it independently; one
    reproduced it. Fixed by making the read **wider** than the delete, so the
    survivor filter is exact in both directions. No lock needed.
  - **A false premise reached the spec because it was verified as written.** The
    spec rejected locking on the grounds that `registrations/route.ts` "never
    calls `lockClassRow`" — literally true, and checked. It takes
    `SELECT … FOR UPDATE` inline instead. Checking the sentence rather than the
    proposition is the mechanism; worth watching for by name.
  - **A boolean canary is defeatable.** The concurrency test asserted
    `expect(raced).toBe(true)`. With the guard deleted *and* one extra query
    added upstream, the whole file passed — the race landed on the wrong read.
    Pin the call count, as `gdpr.test.ts:1046` already did.
  - **Widening the read repaired a guard for free.** With the narrow read only an
    exotic concurrency test could catch `withdrawn = candidates`; after widening,
    an ordinary test catches it too. The mutation went from failing one test to
    failing three. When a guard needs an elaborate test to prove it, ask whether
    the *design* is what made it unprovable.
  - Mutation ledger went 8 → 14 guards, all observed to fail.
- **#47 — grace policy 'mark as not charged'.** Do first: it's the only one with
  a correctness angle. Today the sole way to waive a payment is marking it paid,
  which **lies in the earnings numbers**. Needs an enum value (migration), a
  route, reporting treatment (waived ≠ received), and a text-only row state.
- **#46 — teacher profile photo** (upload in settings; shown on schedule +
  public page).
- **#48 — announcements custom-selection audience** (schema + route + picker;
  the two wired audiences likely cover most use — low urgency).
- **#49 — teacher per-event email notification preferences** (screens 9.4,
  unbuilt).
- **#51 — bulk/CSV student import** (only single-add exists today).

Order #46/#48/#49/#51 by actual teacher demand rather than by issue number.

---

## Dependency & bundling map

```
#72 → #78 → #79 → #82             (mass-assignment hardening: CLOSED, both routes)
PR #80 ──closed──> #79            (class route)    └─ spun out ──> #81
PR #84 ──closed──> #82            (template route) └─ spun out ──> #83 , #85 , #86
PR #93 ──closed──> #86            (archive rule)   └─ spun out ──> #94 … #101

#81 ✓ ‖ #85 ✓ ── same defect, the two forms mirroring the two routes ── done together (PR #135)
#81+#85 ──spun out──> #136 ✓ (the forms neither reached)
#136 ──closed──> PR #153  └─ spun out ──> #146 , #147 , #148
#136 ──partly advances──> #143 (its option 1: the components glob now reaches src/app)
#101 ✓ → #96 ✓ ── same pages; the boundary bug fixed first, then the format redesigned (PR #141)
#101+#115 ──spun out──> #138 ✓ (defaultTimezone is already on the session)
#138 ──closed──> PR #144  └─ spun out ──> #145
#138 ✓ → #140 ✓ ── the payments page got the teacher's zone, then used it (PR #155)
#140 ──closed──> PR #155  └─ spun out ──> #154 ; deepened #143 (e2e pins TZ=UTC)
#96 ──closed──> PR #141  └─ spun out ──> #140 ✓ , #142 , #143
#98 ──closed──> PR #106 (six endpoints, not the four the issue named)
#99 ──closed──> PR #110 └─ spun out ──> nothing
#95 ──closed──> PR #105  └─ spun out ──> #102 , #103 , #104
#98 ──closed──> PR #106  └─ spun out ──> nothing
#102 ──closed──> PR #108 └─ spun out ──> #107
#107 ──closed──> PR #109 └─ spun out ──> nothing
#97 ──closed──> PR #111  └─ spun out ──> #112 , #113 , #114 , #115
#94 ──closed──> PR #118  └─ spun out ──> #119✓, #120✓, #121 , #122 , #123✓
#100 ──closed──> PR #125 └─ spun out ──> #124 , #126
#93 ──closed──> Bundle 2b: eight issues in, all eight now out ── DONE
#116 ‖ #117 ‖ #126 ── the class family measured against #118/#125's studio work
#116 ‖ #117 ── both fell out of reading the class family against #118's studio work
#118 ──closed──> #94      └─ made the STUDIO side safer than the class side (#116)
#119 ‖ #120 ──closed──> PR #191  └─ spun out ──> #192 , #193 , #194
#191 ── 3 PR reviewers, ~20 findings on ~250 lines; 2 guards the spec
           claimed were guards could not fail. Built by a local model.
#83 ── CLOSED (PR #230). The "widening two signatures" premise was wrong:
       updateClassTemplate needed none, syncTemplateInstances needed a
       NARROWING to TransactionClientOnly. Spun out #231, #232, #233.

#249 ──closed──> PR #256 └─ spun out ──> #257 , #258
#249 ── the picker fix shipped broken TWICE: once against a test that compared
       the attribute to the expression producing it, once against a test jsdom
       could not fail in principle (no server, one zone). Both guards' zone
       reads were also untested until this round. Two of the review's own
       findings did not survive measurement, one of them because a later commit
       on the same branch expired it.
#249 ── its scoped RE-review found two defects the fix round had introduced
       while repairing their twins, and nothing the original wave had missed.

#247 ──closed──> PR #250 └─ spun out ──> #249 (by the branch) , #251 , #252 , #253
#247 ── the branch closed the terminal half and filed the PRE-terminal half
       (#249) rather than deciding a product question inside a data-loss fix.
       Its review found no correctness defect and four false claims, each
       refuted locally — one sentence away, eight lines below, or by a test in
       the same commit.

#238 ──closed──> PR #248 └─ spun out ──> #247
#238 ── the issue asserted a migration; the plan measured instead and shipped
       none (2.5 ms, early-terminating merge join). #247 is not an adjacent
       defect but one this branch ARMED: Class.date was always editable on a
       terminal class, and inert until a sweep started deleting on it.

#101 ‖ #115 ── same date-boundary family, two different pages ── do together
#114 ──closed──> PR #271  └─ spun out ──> #270
#114 ── closed the #72 → #78 → #79 → #82 line for the studio family, and its
       new pin shape is what #270 proposes back-porting to ClassTemplate.
       Class itself cannot take it — 7 of its 24 columns are on neither list.

#67 (umbrella) ──closed──> settings_locked ✓ , public-room lock ✓ , #71 ✓
#53 (umbrella) ──closed──> every mutating route now has HTTP coverage

#60 (epic) ──subsumes──> #52 , and the admin-mediation of #76
#73 ──closed──> PR #261 (entry to the lock, not the lock) └─ spun out ──> #259 , #260
#77 ──closed──> PR #90 (hasClasses pinned) + PR #91 (public-or-own rule)

#40 & #41 ── same root investigation ── CI flake cluster
#41 ──closed──> PR #188 (premise disproved) └─ spun out ──> #189 ; note on #127
#39 ✓ & #58 ✓ ── both type-review follow-ups ── independent of each other
#39 ──closed──> PR #156  └─ spun out ──> #157 , #158
#157 ‖ #145 ── the same silence: a degrade-and-warn nobody watches ── do together
#59 ✓ & #58 ✓ ── both from the #57 re-review; PR #130 and PR #131
#58 ──spun out──> #132 , #133 , #134
#59 ──spun out──> #129 (re-scoped to WCAG 2.5.3) , alongside #128
```

**Close-only (no work):** none — #53 and #67 are both closed.
**Standalone quick wins, any time:** #189 (one test, no timers, and its fixtures
already exist in `notifications-stream.test.ts`). (#59, #58, #81+#85, #101, #115
all done.)
**Live bugs, not just cleanup:** #193 (a committed toggle reports "Network
error", then answers the retry with silence), ~~#194~~ **closed** (PR #285 —
editing a template now propagates nothing and generation is keyed per week),
**#267** (`delete-room-button` reports
every non-JSON server error as "Network error" — `res.json()` sits inside the
outer `try`, so an Nginx 502 or an HTML error page reads as a transport failure
and the teacher retries forever against a deterministic server fault; the
sibling button on the same screen already uses `readErrorMessage`), and
**#265** (archiving a student changes only which CRM list they appear in —
filed by the maintainer this round, not spun out of it).

**#103 came off this list and is closed** (PR #264). Note what it was on the
list *for*: "#103's second half (500 on room delete)" — the half the issue
itself called the cheaper of the two. It was, and the expensive half came free,
because the deadlock needs a `ClassTemplate` row to exist and the guard that
stops the 500 is the guard that stops the `DELETE` being issued. **#193 and
#267 are the same defect in two components** and should be read together; #267
is the more mechanical of the pair.

**Re-derived again on 2026-08-20**, after PR #271 merged — **18 numbers**
across all three triage lists plus the epic, one `gh issue view` each, checking
both rot directions. **No rot found** — three consecutive clean rounds. #194 was
checked with particular care because PR #271 touches its subject and pins its
current behaviour in a test: it is genuinely still OPEN, and that test is
expected to be rewritten by whichever way its two product decisions go.

**Open count: 80.** `80 before + 1 filed (#270) − 1 closed (#114) = 80`. Flat,
and flat for the right reason rather than by coincidence — the round closed one
and opened one leaf.

**Re-derived on 2026-08-20**, after PR #268 merged — **33 numbers**
across all three triage lists, one `gh issue view` each, checking both rot
directions. **No rot found.** The four live bugs (#193, #194, #265, #267) are
all genuinely open; "someone is currently worse off" is still empty; every
closed number appearing near these lists is struck through or marked DONE, so
none is being carried as live work. **#113 was checked specifically**, since
this file records it being auto-closed wrongly twice: it is
`CLOSED / COMPLETED` at 17:18Z on 2026-08-14 by PR #227, which is the
legitimate closure this file already calls "finally closed for real".

**Every number in this list re-derived against `gh issue view` on 2026-08-19**,
after PR #264 merged — 18 issues, one call each, across all three triage lists.
**No rot found this round.** #103 was on this list and is legitimately closed
(PR #264, merged 18:31Z, closed by the PR body's `Closes #103`); the other 17
were each confirmed still OPEN. That is two consecutive clean rounds after two
that each found rot. #101, #115, #119, #120, #112, #199, #212,
**#220** and **#113** were on this list and are legitimately closed; the three
that remain (#103, #193, #194) were each confirmed still OPEN.

**#113 came off this list, and the way it came off is the second rot type §8
warns about.** The re-derivation found it CLOSED/COMPLETED — for the third
time. The first two closures were accidents of GitHub's auto-close parser and
had to be undone. **This one is legitimate:** PR #227 ("Name the loser:
template lock-race outcomes answer 503 busy in 2s") merged 2026-08-14T17:12Z
and is exactly #113's fix; the issue was closed by hand at 17:18Z, six minutes
later, with no commit attached. The snapshot arithmetic above has counted it as
closed since then. **What was stale was this list**, which says it was
re-derived on 2026-08-14 — and was, several hours before the closure. So the
count was right and the triage was wrong, which is the failure the open-count
check structurally cannot see. Verify by `gh issue view`, every closing round,
even when the arithmetic reconciles.

**Someone is currently worse off:** *empty.* #113 held the last slot and closed
2026-08-14 (PR #227): an archive that lost its lock race showed the teacher a
developer string, and now names the loser with a 503 in 2s. **#220 held it
before that** and closed 2026-08-14 (PR #222): under contention every student
queued on a class was silently not told a seat opened, the seat went unsold,
and the pricing engine then billed everyone who did attend *more*. #199 and
#212 held it and closed 2026-08-13. #226 is the residue of #220 — the same
loss, confined to the final minute before the cancel deadline — and is **not**
on this list, because it needs a product decision before it is even agreed to
be a defect. An empty list is worth stating plainly rather than deleting the
heading: it is the first time it has been empty, and the next entry should have
to be argued onto it.

**Growth costs, nothing broken yet:** #223 (`Notification` has no retention
policy and only grows, against a fixed 2 GB ceiling), #224 (`WaitlistEntry.status`
and `Class.status` unindexed, scanned every sixty seconds by the reconciliation
sweep), #205 (`StudioClass` has no `(teacherId, date)` index). All three are the
same shape — a scan or a table that is fine until it is not — and all three
should be **measured before anything is added**, which #222 is the argument for:
it justified an index at length and dropped it three commits later when the query
it served went away.

**#224 is NOT part-answered by PR #248's measurement, and the temptation to read
it that way is why this says so.** That branch measured the *retention* sweep's
candidate read over the same two columns and found 2.5 ms at 5,000 classes /
50,000 entries — but only because its `orderBy` + `take` let the planner walk an
existing index and stop early. #224's subject is the **reconciliation** sweep,
which runs every sixty seconds and has no such limit. Different query, different
plan, still unmeasured. #223 is the one PR #248 genuinely moved closer: it built
the `daily-cleanup` job as the slot a second retention policy drops into, and
`scheduler.ts` names #223 there.
**Blocked on a decision:** ~~#216~~ **answered and shipped** — `expired`, not
`removed`, on the argument the entry predicted: `exportStudentData` publishes the
status verbatim without the class's, so `removed` would tell an Article 15
subject they withdrew from a queue they were closed out of. ~~#238~~ **closed**
(PR #248 reaped waitlist entries a year past a terminal class — the root of the
erasure, reconciliation and export costs it named). #213 and #214 (both filed as decisions by #196's branch 2); **#219**
(make `readSeatCount`'s lock precondition structural — a `ClassLock` token, a
`FOR UPDATE` in its own read, or leave it; the token's escape hatch was sized by
#104, which has since closed — so the hatch is already at whatever size that
left it, and re-measuring it is part of answering this); **#226** (a broadcast dropped in the final
minute before the cancel deadline is never repaired — accept it, allow a grace
period for the *sweep only*, tighten the cadence at the window's end, or make the
broadcast durable via an outbox; the last removes the whole class of defect and
is the only one that is not a patch); ~~#194~~ **closed** (PR #285 answered its
decision: leave standing — nothing already generated changes, generation is
week-keyed, a cancelled class holds its week); **#266** (the delete door names a remedy the archive door
can refuse — filed *as* a decision with three options laid out, per §7's second
test, because "make the message right" needs the two doors' contract settled
before anyone can start); #52 (→ #60) — **#76 was on this list and is closed**
(PR #262 took the issue's own option 3, *archive instead of delete*; the
`isPublic` lock and #52's admin-mediation question are untouched). **#73 was
on this list and is closed** (PR #261 changed how a room enters the locked state and left the lock
itself to #60). **#192 was on this list and is
closed** (PR #204 resolved the decision by reporting both families) — removed
2026-08-13 by the same sweep that recovered #113. **#220 was on this list and is
closed** (PR #222 took the reconciliation-sweep option, then replaced its own
first gate design when review showed it repaired only the first drop per claim
window) — removed 2026-08-14.
**Test-seam debt:** #225 (`setInterval` is the last unpinned link in the
scheduler), #178 (a checkout can report a false green — #225 is one of the ways),
#177 (test databases accumulate rows nothing prunes; also why the reconciliation
suite cannot run concurrently with itself), #143 (three teacher detail pages with
no coverage at any level).
**Blocked on a refactor:** none. #83's entry here ("two signature widenings") was the last, and PR #230 closed it — the widening turned out to be one widening and one *narrowing*, to `TransactionClientOnly`.

**Re-derived on 2026-08-24**, after PR #308 merged — **19 numbers** across all
triage lists, one `gh issue view` each, both rot directions. **Two rots found,
both in Blocked-on-a-decision:** #238 (closed 2026-08-17 by PR #248 — a merge
this very file discusses two paragraphs up, which is what made the miss
embarrassing rather than obscure) and #194 (closed 2026-08-20 by PR #285;
struck from Live bugs that same day but left standing here). Both corrected.
The other 17 confirmed open. This is also the first sweep since 2026-08-20:
the rounds that closed #293, #296 (both 08-21), #304 (PR #305) and #276
(PR #306) merged without writing round sections or sweeping, so their closures
enter the ledger below.

---

## Round: #194 — a template is a stamp, not a live link (PR #285)

**Closed #194.** `syncTemplateInstances` is deleted — 250 lines of service and
581 of tests. Editing a class template now changes nothing already generated,
and generation is keyed per **week**: no class into a week that already holds
one from the same template. A cancelled class **holds** its week, which is the
one place this codebase does not read cancelled as free. A read-only probe in
the edit endpoint predicts which week the change first takes effect and says so.

**What was actually learned, as distinct from what the issue said.**

The issue's own remedy was wrong in a way worth recording: it instructed
implementers to reuse `startOfLocalWeek`, which resolves an *instant* through
`Intl`. A `Class.date` is already a UTC-midnight calendar date, so west of UTC
that returns the previous day — for a Monday, the previous **week**. The right
primitive was `mondayOf`, which was sitting private in `class-list.tsx`. Week
arithmetic here needs no timezone at all, because both operands are calendar
dates. `class-list.tsx` was already the worked example of the distinction,
calling `mondayOf` on the date and `startOfLocalWeek` on `now` in one function.

The two questions #194 could not settle answered themselves once the rule was
stated: *withdraw or leave standing* became **leave standing**, and *reuse or
mirror `syncTemplateInstances`* became **neither — delete it**. The fix was
subtractive. Four issues collapsed into one rule and ~250 fewer lines.

**Every fix round on this branch was triggered by a comment, not by broken
logic.** Seven tasks, seven rounds: evidence stored in a directory the tooling
deletes; counts patched instead of re-derived; a parity claim exhaustive over
the wrong axis; wiring asserted before it existed. In a repo whose review
culture rests on comments being true, the prose is the artifact under review,
and it decays where the compiler cannot see.

**Three sweep methods failed on this branch, each blind in its own way**, and
this is the most transferable thing in the round. A keyword grep cannot see a
claim that omits the keyword (two live docs described the deleted propagation
without naming it). A grep with an unquoted variable silently returns
"(nothing)" for every term — a negative result from a broken command is
indistinguishable from a real one. And a **line-oriented** grep cannot see a
sentence that wraps: two sites saying "a fifth `SkipReason`" split across a line
break, which is why one re-derive pass fixed one of three citing sites, and why
the controller's own verification grep came back empty and nearly dismissed the
finding. What worked was searching the *citing relationship* — "who cites this
docblock?" — not the sentence.

**The plan's Definition of Done was wrong twice.** It said a grep for the
deleted symbol should return nothing; the real figure was 173 hits across 37
files, which forced a three-bucket rule — correct live source, correct live
reference docs, **never rewrite dated artifacts** (`docs/superpowers/specs/*`,
`plans/*`, closed-issue entries). A design doc from July describing a function
that existed in July is an accurate record, not a stale claim. It also leaned on
`npm run verify` as the gate, and `verify` is `typecheck && lint && vitest` —
**Playwright is not in it**. A guaranteed-red e2e spec survived a green verify
*and* a full task review before that gap was found.

**A five-specialist PR review then ran a ten-mutation sweep: eight guards
reddened, two did not.** Both were on the probe, and together they meant its
status-filter asymmetry — the branch's central promise — was untested in both
directions. Two reviewers reached it independently from opposite ends. Fixed.

**Open count: 94.** `78 before + 17 filed − 1 closed (#194) = 94`. The 80 in
the previous snapshot reconciles: PR #273's round was `1 in, 3 out`, so
`80 + 1 − 3 = 78`.

**17 in, 1 out, and that needs saying out loud rather than passing as normal.**
It is three distinct things, not one spin-out:

- **10** are a deliberate *survey*, not spin-outs: an end-to-end audit of the
  studio-class family (#274 tracker plus #275–#283), which was requested before
  #194 was started and found the family under-explored rather than broken.
- **1** is #284, the studio half of this rule, split out because #194 grew to
  cover both families and a studio tracker is the wrong home for class work.
- **6** are the PR review's findings (#286–#291). These are the ones that are
  genuinely this round's, and they cluster: four are **type-expressiveness**
  gaps — a bare `number` week key, an overloaded `null`, a union documented as a
  partition that is really a first-match classification, a `SkipCounts`
  intersection one family has and its twin does not. All four were pre-existing
  and invisible until `SkipCounts` grew a third field and forced every consumer
  into daylight. That is an under-explored area surfacing, and it is worth
  saying so rather than letting `1 in, 6 out` read as sprawl.

One finding was **not** filed: the route-boundary gap is already #206, which
gained an update instead — the service side has now acquired a real invariant
(`& SkipCounts` refused to compile until the third count was carried) that the
route still discards.

**Triage re-derived on 2026-08-20** after PR #285 merged — **32 numbers** across
all three lists, one `gh issue view` each, both rot directions. **One rot found
and corrected:** the "Live bugs" list carried #194, closed by this very round;
it is now three, not four. Six of the numbers checked are PR references
(`MERGED`), not issues, which is expected — the lists cite both.

---

## Round: #282 — an empty class type shows a raw Zod string in both studio forms (PR #308)

**Closed #282** (rebase-merged 2026-08-24). Both studio forms now refuse a blank
class type client-side with the product's own copy, before any request: four
source lines each above the location guard, one component test per form, and
each test pins both blanks — empty *and* whitespace-only — with spy-not-called
plus exact banner. The issue's premise held completely against measurement,
which is rare enough to record: every claim checked pre-build survived.

**What was learned beyond the issue.**

The issue's "asymmetry" observation (why does one field show raw Zod when its
neighbours get product copy?) resolved into a rule rather than a patch:
*client checks precisely the wire-required fields that have no valid default;
everything else arrives valid.* `classType` was the only violator. A rule is
what let the fix stay four lines instead of becoming a validation-framework
discussion.

**The base moved mid-flight and only the prose rotted.** Issue #276 landed on
main while this branch sat in review: same family, same schemas file, and it
opened a third writing form. The rebase itself was clean — zero conflicts —
but the spec's "the write surface is closed: two forms plus the shared edit
path" claim silently became false. Clean rebases rot claims, not code; a
rebase checklist that only looks for conflicts will miss exactly this.

**A claim about what a test cannot catch went wrong twice, in two different
ways.** My spec asserted "the banner alone would pass against a continuing
guard" — backwards, caught by branch review. The corrected sentence said "the
banner cannot catch a continuing guard" — also wrong, caught by the comments
review. Both versions reasoned about a hypothetical mutant nobody had ever
constructed; when the reviewer finally did construct it (drop the `return`),
both assertions went red, because the pre-request `setError('')` empties the
banner before `getByText` runs. What separates the halves is not detectability
but diagnosability: both reds catch the mutant, but the spy's red names the
outgoing request while the banner's red reads as a missing guard. Lesson,
stated as process: **any "X alone cannot catch Y" sentence is a
mutation-analysis claim and earns its place only after the mutant has been
run**, not argued about.

Two smaller failures of the same species: test baselines counted with
`grep -c "it(\|test("` (a substring line-count that matches `submit(` too;
10 and 4 measured by an implementer against my claimed 15 and 5), and a
"nine client lines" roster that was never true at any point in the branch's
life (eleven at base, thirteen after).

**The tests review found the one mutant both new tests missed**, and the
precedent for the fix was already in-repo: dropping `.trim()` from the guard
lets `'   '` reach the wire schema's `min(1)` — raw Zod again — while `''`
still refuses and everything stays green. Each test now resubmits with
whitespace and re-asserts; both mutants proven dead by hand (trim dropped →
only the whitespace act reddens). #276's edit-form test had pinned this
boundary all along; the family knew something the spec didn't think to read.

One flake consumed a gate run: first post-rebase verify went red once on a
generator lock-race test; all three projects green in isolation with counts
reconciling exactly (146/1875 = 1068 + 294 + 513), full rerun green. Recorded
rather than chased — the CI flake work (#290, #293) already covers the class.

**Open count: 95.** `94 (2026-08-20 snapshot) + 6 filed (#299 #301 #302 #304
#307 #309) − 5 closed (#293 #296 #276 #304 #282) = 95`. Reconciles exactly.
This round itself: **1 in, 1 out** — #309 filed (unify the family's
classType copy: #276's edit form says "Class type is required." per-field
where the other two banner without the period; found by the code review,
filed rather than folded because unifying needs the family's style question
answered first).

**Triage re-derived 2026-08-24** (see the note above the lists): two rots,
both decisions-list entries for issues closed elsewhere in this very file.

---

## Round: #315 — ScheduleRule, and the slot becomes a range (PR #326)

**Closed #315** (rebase-merged 2026-08-25). Stage A of the #297/#298 decision:
`ScheduleRule` owns the calendar identity both template families share, the two
children keep their economics and hang off a composite FK, and two exact-start
partial unique indexes plus four cross-family triggers become one
`EXCLUDE USING gist` range constraint. The four entry-level triggers survive.

**The issue's premises held. The plan's did not.** All four measured claims in
#315's body were re-derived and held exactly — both overlap pre-flights at zero,
`withdrawnCount` NULL on 11/11 and 1/1, `pg_depend` at 10. That is worth saying
because it is the first issue this process has verified where nothing in the
premise was wrong. **Twenty-six claims in the plan, the task briefs and the
dispatch instructions were falsified instead.** Three were mine, all the same
shape: I stated the current contents of a file I had not re-read at the moment
of writing.

**The methodological result, and the most transferable thing here: sweep for
what you invalidated, not for what you edited.** Ten times a sweep found more
than its enumeration named — 3 prose counts became 8, 1 stale `known-open`
became 3, 7 stale references became 8, 18 accounted deletions became 22. Every
early sweep was keyed on the code that changed; the stale claims were about the
objects that went. The one correctly-derived sweep found *more* than the review
that prompted it, not less.

**A keyword sweep finds stale names. It cannot find a stale description.** The
review's one Critical was a docblock whose sentence three said `23P01` and whose
sentence seven still called the same thing "the template's own slot index" — in
a paragraph this branch itself had edited. It survived nine keyword sweeps
because it names no object; it only describes one wrongly. The same shape then
turned up in a **runtime log string** ("lost a lock race … or the slot index"),
a category nobody had swept and the only one that reaches an operator.

**The fix for one defect created the conditions to see a second.** Splitting the
table split a lock that had been doing three jobs while one row held all the
state — the sentence that made it click is that `updateClassTemplate` *takes no
explicit lock at all*, because its plain `UPDATE` locked the row for free, and
after the split that free lock covered the wrong table. Adding six explicit
child locks made the sweep correctly block — and then generate anyway, because
`FOR UPDATE OF ct` locks only `ct`, so a waiting statement's joined predicate
had already been evaluated against the pre-wait snapshot and `EvalPlanQual`
never re-fetches a non-locked join member. Measured in isolation from Prisma,
6/6 runs.

**Two predictions that did not reproduce.** The plan predicted a `Teacher`
hard-delete would now be refused by `TeacherRoom`'s RESTRICT; measured, it
succeeds cleanly, because PostgreSQL defers a NOT DEFERRABLE FK check to the end
of the enclosing statement and the sibling cascade clears the blocking row
first. And Task 5's brief asserted the ported coverage "now lives" in the
rule-layer file; for 6 of 14 cases it did not, because every case there used
`CREATE` and all six being ported were `UPDATE`-path. Trusting that sentence
would have shipped the constraint's update path unpinned under a task titled
"prove the constraint is the sole enforcement."

**A generated column is the first thing this repo has put in the database that
`schema.prisma` cannot describe.** Partial indexes, CHECKs and extensions are
all invisible to `migrate diff` because none of them is a column. `slot` is one,
so bare `prisma migrate dev` offers `DROP COLUMN "slot"` — which cascade-drops
the exclusion constraint. `Unsupported("int4range")? @default(dbgenerated())`
diffs clean while staying out of the generated client.

**An environment fault invalidated 97 test results for most of the branch's
life.** The dev server on :3000 was 1d16h old, predating the schema change;
`next dev` hot-reloads route files but never reloads
`node_modules/@prisma/client`, and the client is a `globalThis` singleton. The
tell was `account-api` failing — a suite with no connection to templates. Also
worth knowing: `npm test` joins its two invocations with `&&`, so the
integration project is unreachable while any unit test fails.

**Reviews found eleven things after the branch was "done"** — one Critical, four
Important, five Suggestions, plus one the fix wave found itself. None was a
functional defect. The ownership gate, the six write paths, the raw SQL, the
migrations and the entry/rule boundary all came back clean under independent
verification, and no invariant that had coverage at `main` lacks it now (mapped
independently, twice).

**Open count: 103.** `98 (2026-08-24 snapshot) + 7 filed outside a round
(#317 #318 #319 #320 #321 #323 #325) − 3 closed (#315 this round, #321, and
#309 whose closure the snapshot predated) + 1 filed by this round (#327) = 103`.
Reconciles exactly. This round: **1 in, 1 out.**

**The out was a correction, and the reason is worth keeping.** This entry first
recorded 1 in, 0 out — everything found had been fixable in-branch. Then the
maintainer asked whether #315 should have stayed open for stages B and C.
Checked: nothing open tracked the entry layer, and **#284 — which stage C2 is
blocked on — had zero mentions of #298, `ScheduleRule` or the triad**, so
whoever picked it up would not have learned a merge was waiting on their
decision.

Closing #315 was right; its title, scope and acceptance were stage A, and stage
A shipped. What was wrong was closing it *without replacing the pointer*. #315's
own text said these were "stages of this decision, not separate work items —
split them out if and when someone starts them", and that quietly assumes
someone will find them, which after closure means opening a closed issue they
have no reason to open. The precedent was already there and was missed: when
#297 and #298 closed as decisions, that round **filed** #315 rather than leaving
stage A in the spec.

So stage B is now **#327**, carrying the hazards already measured rather than
leaving them to be re-derived — the 14-predicate liveness audit and which two of
them change meaning silently, `class-lifecycle.ts:550` as a lock-order question,
the midnight-spill capability the range constraint gets free, and the four
things stage A learned that stage B will hit again. **#301 and #284 were
*extended* rather than filed beside**: #301 with the half it lacked (both hourly
sweeps carry the same `YG001` gap, at operator-signal severity rather than a
user-facing 500), #284 with the fact that the `update` triad merge waits on its
rule 4.

**A ratio of 1-in-0-out should have prompted the question the maintainer
asked.** A round that closes a staged issue and files nothing has either
genuinely finished the arc or dropped the rest of it, and this file's own
discipline is to say which out loud.

**Triage re-derived 2026-08-25** — 33 numbers, one `gh issue view` each, both rot
directions. **No rot found.** The open-count arithmetic was initially off by one,
which is the signal §8 exists for; hunting it found #309, a legitimate closure
the previous snapshot predated, not a corruption.

**~~Stages B and C remain~~ — stage B shipped as #327** (PR #330, the round
below): the entry layer, `ClassStatus` down to four members, the entry-level
exclusion and the last four triggers all landed 2026-08-27. **Stage C
remains** — the triad merge whose `update` half is still blocked on #284.

## Round: #327 — the entry layer takes the calendar identity, and cancellation stops being a status (PR #330)

**Closed #327** (rebase-merged 2026-08-27 as 32 commits, head `a6eaed54`).
Stage B of the #297/#298 decision: `CalendarEntry` holds the calendar identity
both entry families share, `Class` and `StudioClass` hang off it by the
composite `(calendarEntryId, kind)` and keep only their own economics, and
liveness gets one spelling — `CalendarEntry.cancelledAt` — for both families.
**Cancellation is no longer a status**; a cancelled class keeps whatever
`ClassStatus` it held. The four entry-level cross-family triggers became one
`EXCLUDE USING gist`, `CalendarEntry_teacher_slot_excl`, the way the four
template-level ones did in #315.

171 files, +14,170/−5,672, 6 migrations, 165 → 171 test files in the tree. The
round's own runs reported 158 suite files / 1,973 tests against a 152 / 1,898
baseline — the same +6 files by a different denominator. Re-derive the first
two with `git diff --shortstat 9e7fae0c a6eaed54` and
`git ls-tree -r --name-only a6eaed54 | grep -cE '\.(test|spec)\.(ts|tsx)$'`.

**The finding this round is actually about: a claim that ships its own
re-derivation command survives, and one that does not, rots.** Sixteen claims
on this branch shipped the command that re-derives them, and all sixteen were
still true when a reviewer ran it. Seven counts shipped wrong — four of them
mine — and **not one of the seven had a command attached**. That is a measured
result on one branch rather than a style preference, and it is why CLAUDE.md's
Comment Discipline now says counts "ship with the command that re-derives
them" (`CLAUDE.md:62`).

**The refinement, found the same round: check the command against itself.** A
shipped `grep` can be falsified by the comment containing it — the needle
matches its own docblock and the count comes back one too high. A command that
cannot tell its own text from its subject is not a re-derivation.

**Neither figure above is re-derivable from the tree, and saying so is the
point.** 16 and 7 are counts over this round's review passes, not over any
file; nothing in the repo will falsify them if they drift. They are recorded
here — with an owner and a date — rather than in a comment, which is the whole
distinction Comment Discipline draws.

**Two out, not one, and §8's sweep is what found the second.** #328 —
`CalendarEntry -> ScheduleRule` is the one non-composite edge among the five
into the shared-identity tables, so a `kind: 'regular'` entry can point at a
`kind: 'studio'` rule and nothing objects. #329 — the CI schema/migration
drift check enforces a wider invariant than its comment states (*everything
Prisma can model must be declarable in `schema.prisma`*), a consequence of
`migrate diff` being the comparison rather than a decision anybody made.
**#329 reads as a standalone maintainer note and is not one:** its subject is
`CalendarEntry.span` and the `Unsupported("tsrange")` declaration this branch
added, and its body names #328. The round summary written before the sweep
recorded 1 in, 1 out; re-deriving the ledger corrected it to **1 in, 2 out**.

**Open count: 104.** `103 (2026-08-25 snapshot) + 2 filed (#328 #329) − 1
closed (#327) = 104`. Reconciles exactly, measured with
`gh issue list --state open --limit 200`.

**Triage re-derived 2026-08-27** — **42 numbers**, one `gh issue view` each,
both rot directions: 18 carried as open work, all `OPEN`; 24 carried as closed,
all `CLOSED / COMPLETED`. **No rot found** — two consecutive clean rounds since
the pair of decision-list rots on 08-24.

**Resolved: `isCrossFamilySlotConflict`'s dead arm is gone from both
routes, and the function went with it (issues 331/228).** All four
`YG001` raisers were already gone — the template-level two dropped in
`20260825065109_schedule_rule_backfill`, the entry-level two
in `20260826080100_calendar_entry_rewire` — so nothing in the schema raises
the SQLSTATE the predicate matched. `api/class-templates/route.ts` and
`api/studio-class-templates/route.ts` both dropped their `DEAD ARM` catch
branches as part of giving each route's `POST` a service, which left the
predicate with zero callers; `src/lib/cross-family-conflict.ts` and its test
were deleted with it rather than kept unreferenced. Re-derive with
`grep -rn 'isCrossFamilySlotConflict' src` — no import or call site, only
comment prose in other files narrating what the deleted predicate used to
do — and `grep -rn 'YG001' prisma src` (the schema census, unchanged).

**One thing left open deliberately, and it is not a loose end.**

**The seed step is a gate that should have existed while the code was being
written.** `20260826080000_calendar_entry`'s own comment rests the placement of
`CalendarEntry_teacher_slot_excl` on the seed being the first thing that can
violate a new constraint — while nothing in CI had ever run it. #327 widened
what "violate" means: under the exact-start key it replaced, a seed collision
needed two of one teacher's classes at the identical minute; under a RANGE
constraint any two within a duration of each other collide, and the seed writes
eleven classes across three teachers. The step landed in `9e94bab3`, the 30th
of the branch's 32 commits — after the schema it checks. It passed. **It was
never a gate during development.** Those +22 lines are this branch's entire CI
change: `test-integration-e2e` and `npx playwright test` already gated at the
base (`9e7fae0c`) and gated every push on this branch. Re-derive with
`git diff --shortstat 9e7fae0c a6eaed54 -- .github/workflows/ci.yml`.

## Round: #331 + #228 — a plain INSERT against an exclusion constraint can deadlock (PR #334)

**Closed #331 and #228** (rebase-merged 2026-08-27 as 15 commits, head
`8d876079`). Four create paths stop deadlocking; the two template creates gain a
service, a bounded wait and a named outcome. 25 files, +1689/−950.

**This round exists because the previous one shipped a `40P01` labelled "known
flake".** `cdb3714a` recorded it in its own commit message — *"studio-api
answered 503 instead of 409 on a retry-safe create under full-suite lock
contention — twice, on two different cases, each clean 3/3 in isolation and clean
on the next full run"* — and that claim, which carried no command, was falsified
within a day: it went red twice consecutively on `main`, on a docs-only commit
that changed one markdown file.

### The finding: an exclusion constraint does not wait the way a unique index does

A b-tree unique check runs **before** the waiter's own entry exists, so the wait
is one-directional and no cycle is constructible. An exclusion check runs
**after** the waiter's tuple is inserted, so both sides hold something the
other's check will find. That is a cycle, and `deadlock_timeout` (1s) breaks it
with `40P01` — before `LOCK_TIMEOUT_SQL`'s 2s could bound it.

Underneath that: **equality is transitive, so two distinct keys cannot each
conflict with the other. Overlap is not.** #298/#327 moved the slot key from
equality to overlap — which is exactly the capability those issues wanted, since
it catches `19:00 +90` against `19:30 +60` — and the deadlock is the other side
of that same coin. Not a defect in the extraction; an unpriced cost of it.

`ON CONFLICT DO NOTHING` uses speculative insertion, which **withdraws** the
tuple while waiting, restoring the asymmetry on the same constraint. The
deadlock-free path was already in Postgres; nothing needed inventing.

Measured three ways on a throwaway database, three statements each in fixed
order — orderings, not races: plain `INSERT` deadlocks every run; the unique
equivalent cannot be made symmetric at all; `ON CONFLICT DO NOTHING` waits, then
returns `INSERT 0 0` with the constraint upheld.

### `docs/lock-order.md` said the mechanism was unchanged, and that is why it shipped

The document asserted *"An exclusion constraint waits the same way a unique index
does."* One sentence, in the one document whose job is to be right about this,
turning a reproducible deadlock into a shrug. It names no object and only
describes one wrongly — the shape a keyword sweep structurally cannot find.
Corrected by replacement in this round.

### The acceptance signal is the deadlock counter, not the test

`pg_stat_database.deadlocks` on the test database: **633 before, 633 after —
delta zero** across four consecutive full integration runs. Re-derive with
`docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c "SELECT deadlocks FROM pg_stat_database WHERE datname='ethical_yoga_test'"`.
A green test says the loser answered 409 *this time*; the counter says the
deadlock never happened. The distinction is the whole reason this was mislabelled
once already.

### Five claims of mine were falsified, and the pattern is the point

That the loser exceeded the 2s bound (no — `deadlock_timeout` is 1s and fires
first). That the deadlock is inherent to `EXCLUDE` constraints (no — to a *plain
INSERT* against one). That a mutation yields a generic 500 (no — a code-less
503). That three statements wait (four). That the counter read 625 (633, two
hours stale). **Every one was prose reasoning about code instead of reading it,
and every one was caught by a "verify before writing" step.** The claims that
shipped with a command attached survived four implementers and eleven review
seats.

**The lock arithmetic was wrong twice before it was right.** #228 recorded `N =
2`; this round's first correction said three; the answer is **four**, because
generation is two lock-taking writes, not one. `4 × 2s = 8s` inside a 10s budget
— 2s of headroom, and a fifth waiting statement consumes it entirely.

### Two defect shapes worth naming

**Annotation instead of replacement cost two fix rounds.** A correction written
*beside* a wrong claim rather than over it produced a paragraph asserting "zero
now" and, two sentences later, that the set was non-empty. CLAUDE.md bans the
pattern because it manufactures a contradiction, not merely because it leaves
one.

**Right per task, wrong for the branch.** Task 1 corrected a docblock; Task 2
mirrored the *code* and not the *correction*, so `rule-slot-holder.ts` named one
exception where there were two and `entry-conflict.ts`'s twin never got the
parallel fix at all. No task reviewer could see either, and the invalidation
sweep's greps could not reach those files. The whole-branch review is what
caught them — and its sharpest finding was that both entry routes had **deleted
the argument that makes a zero-row skip mean a slot conflict**, which was
decoration under the old catch (it matched by constraint name) and load-bearing
under `ON CONFLICT DO NOTHING` (which carries no conflict target).

### Two out, both attached rather than filed

**#301's premise is falsified.** It describes a pause/resume cross-family race as
a bare 500 *because the generator raises `YG001`*. Nothing has raised `YG001`
since #327, and this round deleted the last matcher. The gap survives under
`23P01` on `CalendarEntry_teacher_slot_excl`, for which `classifyApiError` has no
arm — recorded as an update on 301, per §7's fourth test, rather than filed
beside it. **#228** likewise carries the note that the two entry routes share its
unbounded shape and are outside its scope, and that nothing pins either `busy`
arm's content.

`src/lib/cross-family-conflict.ts` and its two test files went at zero callers.
That deletion was flagged as "a decision someone should make on purpose" at the
start of the day; it needed the caller count to reach zero, not more deliberation.

**Open count: 104.** `104 (2026-08-27 snapshot) + 2 filed (#331 #332) − 2 closed
(#331 #228) = 104`. Reconciles exactly, measured with
`gh issue list --state open --limit 200`. This round itself: **2 in, 0 out** —
both issues closed, nothing filed, two existing issues extended instead.

**Triage re-derived 2026-08-27** — **54 numbers**, one `gh issue view` each, both
rot directions: 23 carried as open work, all `OPEN`; 31 carried as done, all
`CLOSED / COMPLETED`. **No rot found** — three consecutive clean rounds since the
pair of decision-list rots on 08-24.

One paging hazard worth recording, because it nearly hid a closure. `gh issue
list --state all --limit 40` sorts by creation, so #228 — closed this round but
filed long before — did not appear in a listing of "everything touched today" at
all. The count is measured at `--limit 200` and each closure verified
individually for exactly this reason; a listing that silently pages is not a
census.

## Round: #332 — the archive becomes one implementation, and the pause half gets a trigger (PR #335)

**Closed #332** (rebase-merged 2026-08-27 as 19 commits, head `035d3322`). Stage
C1 of the #297/#298 decision: both families' `archiveOrUnarchive` now run on one
generic `archiveOrUnarchiveRule` over a `TemplateFamily` descriptor in
`src/services/rule-lifecycle.ts`, and the two old functions are one-line wrappers.

**The issue's own headline claim was the one that did not survive.** #332 said the
four functions had "identical docblocks" and shipped commands to re-derive its
other counts. Measured: **534 lines of code under 1322 lines of comment** across
the four — not identical, four *divergent* copies cross-referencing each other.
That inverted the difficulty estimate. The code merge was the small half; a whole
task went to the prose, and the prose is where every interesting failure was.
All four line numbers the issue cited had also drifted, moved by PR #334 the same
day. Re-derive the ratio per function with
`sed -n 'A,Bp' <file> | grep -vE '^[[:space:]]*(//|\*|/\*)' | grep -cvE '^[[:space:]]*$'`.

**One measurement scoped the entire round.** The two *archive* result unions have
identical seven-arm sets; the two *pause* unions differ by exactly one arm
(`room_archived`, class only). Every archive difference lives inside the
transaction body; the pause difference reaches the public type. Archive merged on
that basis and pause did not — so the round is C1's archive half, with the pause
half filed as **#336** carrying a trigger that is a re-check rather than an
argument: a `diff` over the two unions' reason sets, empty when it is due, today
emitting exactly `reason: 'room_archived'`. #272 landing is what fires it.

**A defect found by verifying the premise, not by building.** The studio
`pauseOrResume` residual threw — a 500 at `error`, the paging level — where the
class family answered `busy` (503). `aed305f8` fixed the class side for #116 and
the port never happened, while the class comment claimed the two families agreed.
The spec's evidence for it was *also* wrong and was corrected mid-build: it said
neither branch had a test, on a grep over **log-message strings**, which a
result-asserting test never contains. That method could not have found what it
claimed to have counted — §2's failure in its purest form, committed by this
round's own spec.

**Three type decisions were settled by compiling, not by reasoning**, and two of
them were plan defects caught before any code was written. A two-parameter
`TemplateFamily<TChild, TState>` does not compile — `TState` sat in a return and a
parameter position at once, making the hook invariant and un-unionable. That was
the *identical* variance failure the plan had already measured for `TChild` and
then reintroduced one parameter later. `Record<ClassFamily, unknown>` compiles and
is **blind** to a half-defined family (`{ regular: CLASS_FAMILY, studio: 42 }`
passes); the named-union form catches it. And the plan's four `as unknown as
TChild` casts were avoidable — a third candidate needs no cast and no extra field.

**The sharpest find on the branch was a deleted correction.** `rule-lifecycle.ts`
claimed its transaction budget covers "the delete, the notifications, the record
write" — true with one caller, false the moment the studio family joined with
`withdraw: null`. The studio body the branch *deleted* had carried exactly that
correction. No grep over changed code can reach that: the invalidated object was a
paragraph that no longer exists. §4's "sweep for what you invalidated" has a
second mode nobody had named.

**And a verification command had gone stale.** `db-locks.ts` carries a grep whose
stated claim is "expect FOUR hits, every one in THIS FILE — a hit anywhere else is
a site that took one of these row locks without going through either helper." It
returned **five**: the shared archive splices its table name from
`family.childTable`, so the filter's literal `"ClassTemplate"` stopped matching and
a *template*-row lock read as a `Class` one. Not a stale name and not a stale
description — an **executable** claim that silently began returning a wrong answer.
A new category for the hazard list.

**A correction landing in one twin and not the other happened three times**, and
the third is the instructive one: fixing one copy of a shared comment left the file
**self-contradictory**, which is worse than consistent error, because a reader now
finds two answers and no way to tell which is current.

**The multi-agent PR review earned its seat, and its best finding was subtractive.**
Five reviewers; the type reviewer proposed removing a hook's return value, which
*dissolved* two coverage gaps the test reviewer had found rather than filling them —
both confirmed by running the mutations it predicted would stay green (they did,
5/5 and 112/112). A mutation you cannot write beats a mutation you catch. The
silent-failure hunter found the round's one user-reachable defect: the archive's
CAS-miss branch answered `unchanged` unconditionally, so a teacher clicked Archive
and got no message, no error, an unchanged button, and a template still live and
still generating — with no server log at all. Fixed to `log.warn` + `busy` (503),
no wire change.

**Ratio: 1 in, 2 out — and the reason is not discovery.** #336 is a *mandatory
pointer*, not a spin-out: #332 exists precisely because closing #327 left stage C
without one, which was itself the second occurrence, and closing #332 without
filing C1b would have made it the third. Only **#337** is a genuine spin-out (two
"sole importer" comments measured at 8 and 6 importers — false premises whose
safety conclusion is true, filed as a decision because the durable fix is a tether,
not a number).

**Open count: 105.** `104 (2026-08-27 snapshot) − 1 closed (#332) + 2 filed (#336
#337) = 105`. Reconciles exactly, measured with
`gh issue list --state open --limit 200 --json number -q 'length'`.

**Triage lists re-derived, and this round found rot after three clean ones.** Every
number named as live work in "Live bugs" (#193 #267 #265), "Blocked on a decision"
(#213 #214 #219 #226 #266 #52) and "Test-seam debt" (#225 #178 #177 #143) verified
`OPEN` with one `gh issue view` each; "Someone is currently worse off" is still
empty. **The rot was inside an entry rather than in the list's own bookkeeping:**
#219's text reads "the token's escape hatch is sized by #104 and empties when #104
lands", and **#104 is CLOSED**. #219 is correctly open; a reader is simply told
something is pending that already landed. The open *count* reconciles either way,
which is why only the per-issue pass reaches it.

## Round: #297 + #298 — the two class families share a calendar identity (PR #314)

**Closed #297 and #298** (rebase-merged 2026-08-24). Both were `question`
issues, so the deliverable is a recorded decision, not a diff: **C and D
together, both as extraction** — `CalendarEntry` and `ScheduleRule` take the
calendar identity, the four existing tables survive holding their economics,
and single-table-with-a-discriminator is rejected at both layers. #297's rule is
absolute non-intersection, half-open, enforced by `EXCLUDE USING gist`. The
decision and the first implementation plan are committed under
`docs/superpowers/{specs,plans}/2026-08-24-*`.

The release trigger #298 set for itself — the close of #283 and #276 — had
fired, which is why this ran now.

**What was learned beyond the issues.**

*A decision issue's own comments rot exactly like code comments do.* Six of the
recorded decision's claims did not survive re-derivation. Five were numbers and
left the decision intact; the sixth changed the schema. That ratio is the useful
part: re-deriving found the small errors and missed the large one.

*The large one came from a gate question, not from the sweep.* #298's comment
kept exact-start matching at the rule layer, reasoning that rule conflict "is
derived from activity and date range". The maintainer asked at the spec gate
what happens when a template later gains a date range — and the answer is that
**no rule has one today**, so every live rule reaches every week and an
overlapping rule pair collides every week, exactly as certainly as an
identical-start pair. The design would have refused one certain conflict at edit
time and admitted an equally certain one. `ScheduleRule` now takes the same
range exclusion as `CalendarEntry`. **The sweep re-derived five numbers and
missed the claim that mattered; one question found it.**

*A correction of a correction, committed inside the document describing that
defect.* §2.2(a) corrected an inherited claim ("`durationMinutes` participates
in no validation anywhere" — it has 8 Zod sites) and replaced it with another
wrong one: "nothing in this system computes when a class ends". It does, at
`class-lifecycle.ts:550` and `class-transitions.ts:532`. The wrong-producing
method is the record worth keeping: the reference list was read by eye and
`settings/`- and `page.tsx`-shaped paths classified as display, which skips
`src/services/` — the one directory where the claim could fail.

*And a fix that reached one artifact and not its twin, in the same document.*
The §2.2(f) correction that gave the rule layer an exclusion constraint reached
§4.4 and never reached §7.1's test census, which went on counting two
"pre-existing violating pair" cases where there are four. Knowing §4's rule is
not the same as having a procedure that catches it.

**Executing beats reading, and this round has the cleanest demonstration yet.**
The migration plan was reviewed by *running* it against a seeded copy rather
than reading it, and **it could not run at all**. Two fatal defects: `ScheduleRule`
declared `withdrawnCount NOT NULL` where both children declare it `Int?` and
every live row is NULL (11/11 and 1/1, because only an archive writes it); and
the four #296 template triggers hold four of the nine columns the migration
drops — `pg_depend` records 10 column dependencies from their `WHEN` clauses, so
the drops fail until the triggers go first. Fixing the second collapsed an
entire later task, including two `DROP INDEX` statements that would have matched
nothing while reading like they did something.

A third finding is subtler and worth naming: the plan **defended a correct
ordering with a false reason.** `CHECK`-before-FK was justified by a window a
concurrent writer could exploit; measured, that window does not exist inside the
transaction the file runs in. The order is right, the hazard was fiction — the
kind of claim that survives review because nobody can falsify it by reading.

**A capability nobody asked for.** All entry-level slot indexes key on `date`,
so a 23:30 class running 60 minutes ends at 00:30 the *next day* and can collide
with the next morning invisibly. No per-date key could ever see it; the range
constraint catches it for free. Measured both directions.

**Scope discovered mid-plan.** The spec is three plans, not one — rule layer,
entry layer, and a triad merge that itself splits, because `pauseOrResume` and
`archiveOrUnarchive` are ready as soon as `ScheduleRule` exists (the studio
service already imports `LastScheduledClass` from its twin) while `update` is
blocked on #284: `generationState`/`firstFreeWeek` appears 9 times in the class
service and 0 times in the studio one. Recorded as an update on #284 rather than
filed, per §7's fourth test.

**Open count: 98.** `95 (2026-08-24 snapshot) + 4 filed outside a round
(#310 #311 #312 #313) − 2 closed (#297 #298) + 1 filed (#315) = 98`. Reconciles
exactly. The +4 is why the previous snapshot read stale rather than corrupt.
This round itself: **2 in, 1 out** — two decisions closed, one implementation
issue filed carrying the two later stages in its body rather than as separate
trackers.

**Triage re-derived 2026-08-24** after this round — 33 numbers across all three
lists, one `gh issue view` each, both rot directions. **No rot found.** The
previous round's two decisions-list rots are confirmed corrected. One gap
recorded rather than fixed: #297 and #298 were never on the decisions list
despite being `question` issues, and **#284 still is not**, though this file's
own bundle line calls it "one decision left on its face".
