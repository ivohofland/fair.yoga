# Open-issue roadmap & bundling

**Snapshot:** 2026-08-15 (revised after #83/#209/#180 merged, PR #230) · **67
open issues**, re-counted with `gh issue list --state open --limit 200` = 67.
Reconciles: 66 + 1 (#228, filed 13:25Z on the 14th) − 1 (#113, closed 17:18Z
by PR #227) + 1 (#229, filed 22:59Z on the 14th) − 3 (#83, #209, #180, all by
PR #230) + 3 (#231, #232, #233, from PR #230's review wave) = 67. Measured,
not derived.

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
merge and reopened** — see the closing-keyword hazard below. This round's PR body
said "**#216 is unaffected**" for exactly that reason, and #216 is still open,
which is the check working.
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
**minus #83/#209/#180 (PR #230) → plus #231, #232, #233**.

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

---

## Recommended sequence

| # | Bundle | Issues | Gate |
|---|---|---|---|
| 1 | ~~Coverage campaign — the tail~~ **DONE** | ~~#71 #66 #69~~ → #67 ✓ closed | — |
| 1b | ~~`teacher-rooms` + #77's `hasClasses` test~~ **DONE** | ~~#53 residue, #77 half~~ | — |
| 1c | ~~`studio-*` coverage + the cron call~~ **DONE** | ~~#53~~ ✓ closed | — |
| 2 | Template-route seams | ~~#86~~ ✓ closed; ~~#83~~ ✓ closed (PR #230); #114 remains | none |
| 2b | ~~What #93 left behind~~ **DONE** | ~~#95 #98 #102 #99 #97 #94 #100~~ — all eight closed | — |
| 3 | Unpinned-list cleanup & types | ~~#59~~ ~~#58~~ ~~#81+#85~~ ~~#101+#115~~ ~~#96~~ ~~#138~~ ~~#136~~ ~~#140~~ ~~#39~~ ~~#121~~ done, then #132 + #133 + #134 | one design call left (#133) |
| 3b | Locking follow-ups | ~~#107~~ ✓, ~~#113~~ ✓ (PR #227), ~~#180~~ ✓ (PR #230); #116 + #117 + #126, #103, #104, #122, #229, #232 | one decision (#229) |
| 4 | CI reliability & framework upkeep | ~~#185~~ ✓, ~~#41~~ ✓ (PR #188) — premise disproved; ~~#40~~ ✓ (PR #198) — nine components, not one, and its framework half closed unverified; then #127 (+#189) | none, but hard/uncertain |
| 5 | Room lifecycle & admin (epic #60) | #73 + #76 + #52 | **product decision** |
| 6 | Feature backlog | ~~#119 + #120~~ ✓; ~~#112~~ ✓; #47, then #46 / #48 / #49 / #51 | product priority |
| 3c | **This week's spin-outs** — see below | ~~#146 + #148~~ ✓ done together (PR #163); #145 + #157 (together), #164, #162, #154, #142, #143, #147, #158, #161 | two are decisions (#147, #164) |

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
  Prisma model key union. Three of the eight exceptions are labelled KNOWN GAP
  with issue numbers (#73, #46, and `cancelledAt`) — latent defects now sit
  beside the guard instead of in a spec nobody re-reads.

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

- **#114 — the studio template family has no forbidden-field pin machinery.**
  #79 built four compile-time pins for `ClassTemplate`; `StudioClassTemplate`
  has none, and `PUT /api/studio-class-templates/[id]` passes `parsed.data`
  straight into `update`. Safe only because its zod schema is `.strict()` and
  happens not to declare the dangerous fields — real protection at the HTTP
  boundary, none at the function boundary, and no pin to fire if someone adds
  one later. #111 is what made this matter: it gave `StudioClassTemplate`
  columns worth forging, closed the gap on the class family, and correctly did
  not invent parallel machinery for the studio side. Mechanical — the class
  family is a working template to copy.

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
  uniqueness + a write set exceeding its lock set). Updates on **#104** (its
  four-site enumeration is stale; the split is now 5 bounded / 5 not) and
  ~~**#83**~~ (`syncTemplateInstances` is the read-then-delete its own sibling
  warns against — closed by PR #230, which put the read under the lock).

**Do #116, #117 and #126 as one sitting** — all three are the class family
measured against what #118 and #125 built for the studio side, and the
comparison is the expensive part to redo.

- **#116 — `pauseOrResumeTemplate` generates without taking the claim**, so its
  `P2002` hedge is broken. The race is live: its `update` only flips `isActive`,
  a non-key column, so Postgres grants `FOR NO KEY UPDATE`, which does *not*
  conflict with the `FOR KEY SHARE` a concurrent `Class` insert takes — and the
  hedge cannot save it, because a `catch` inside an interactive transaction
  leaves an aborted transaction that fails the next statement with `25P02`
  rather than skipping. #118 fixed exactly this on the studio side by taking the
  claim, so the class family is now the *less* safe of the two; the fix is the
  same shape, and the same "a null claim after your own CAS is a logic error,
  not a race" detail applies.
- **#117 — the class family asserts a zero-count CAS holds no lock; sometimes it
  does.** `"the CAS matched nothing, so it acquired none"` is false in the
  blocked-then-EvalPlanQual-recheck interleaving — Postgres takes the lock on the
  newest version *before* the recheck, so a rejection still leaves it held to
  commit. Settled by experiment during #118, not by reading. No live bug (the
  plain re-read is correct either way), but the studio side now carries the
  corrected wording while pointing readers *at this one*, so the two families
  currently disagree about the same mechanism. Introduced by #97's own
  "correct the last round of comment claims" commit, which is the joke that
  writes itself.
- **#126 — `gdpr.ts` is the last file saying the CAS takes "the same row lock"
  as `FOR UPDATE`.** #125 corrected that conflation at six sites across four
  files and settled on one wording; `gdpr.ts` was deliberately left out because
  it is the referent of none of them. The result is one file asserting the
  opposite of six others with nothing recording that the discrepancy is known —
  arguably worse than the uniform-but-wrong state it replaced, since a reader
  who finds `gdpr.ts` first gets no signal. The lock relations were *measured*
  during #125's review (an `updateMany` touching no key column is granted
  `FOR NO KEY UPDATE`; the claim's `FOR UPDATE` is stronger; the two conflict,
  and the conflict is what serialises them), so the correct wording already
  exists — this is one comment, no code.
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
- **#104 — no `lock_timeout` on the four pre-existing row-lock sites**
  (`waitlist.ts` ×3, `registrations/route.ts`). No live bug — #95's review
  confirmed the lock sets are disjoint today. Filed as hardening, and honestly
  the kind of thing that belongs in a code comment rather than the tracker; keep
  it only if the booking path's unbounded wait starts to matter.

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

  **Still blocked, unchanged:** `edit-room-form.tsx` on **#73**'s `isPublic`
  decision, `profile-form.tsx` on **#46**'s `photoUrl`.

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

- **#73 — `PUT { isPublic: true }` is an irreversible one-way door** (locks the
  creator out of edit *and* delete).
- **#76 — room deletion blocked forever** by cancelled/completed classes (no
  status filter on the count). Three real options in the issue: keep + reword,
  filter by status, or archive via the unused `TeacherRoom.isArchived`.
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

#101 ‖ #115 ── same date-boundary family, two different pages ── do together
#114 ── reopens the #72 → #78 → #79 → #82 line for the studio family

#67 (umbrella) ──closed──> settings_locked ✓ , public-room lock ✓ , #71 ✓
#53 (umbrella) ──closed──> every mutating route now has HTTP coverage

#60 (epic) ──subsumes──> #52 , and the admin-mediation of #73 / #76
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
**Live bugs, not just cleanup:** #103's second half (500 on room delete), #113
(an archive that loses the lock race reports "Internal server error" — **reopened
2026-08-13**, see the double-accident note at the top), #193 (a committed toggle
reports "Network error", then answers the retry with silence), #194 (editing a
studio template's day leaves its old classes standing). **Every number in this
list re-derived against `gh issue view` on 2026-08-14** — once more after PR #222
merged. That is how #113 was recovered and how it is now known to have survived
two subsequent merges. #101, #115, #119, #120, #112, #199, #212 and **#220** were
on this list and are legitimately closed.
**Someone is currently worse off:** #113 again, now that it is back — an archive
that loses its lock race shows the teacher a developer string. **#220 held this
slot and closed 2026-08-14** (PR #222): under contention every student queued on
a class was silently not told a seat opened, the seat went unsold, and the
pricing engine then billed everyone who did attend *more*. #226 is the residue —
the same loss, confined to the final minute before the cancel deadline — and is
**not** on this list, because it needs a product decision before it is even
agreed to be a defect. #199 and #212 held this slot and closed 2026-08-13.
**Growth costs, nothing broken yet:** #223 (`Notification` has no retention
policy and only grows, against a fixed 2 GB ceiling), #224 (`WaitlistEntry.status`
and `Class.status` unindexed, scanned every sixty seconds by the reconciliation
sweep), #205 (`StudioClass` has no `(teacherId, date)` index). All three are the
same shape — a scan or a table that is fine until it is not — and all three
should be **measured before anything is added**, which #222 is the argument for:
it justified an index at length and dropped it three commits later when the query
it served went away.
**Blocked on a decision:** #216 (`removed` or `expired` for a queue closed by its
class starting — deliberately left open, because it is the kind of choice that is
cheap now and expensive after it ships, and the Article 15 export publishes the
answer); #213 and #214 (both filed as decisions by #196's branch 2); **#219**
(make `readSeatCount`'s lock precondition structural — a `ClassLock` token, a
`FOR UPDATE` in its own read, or leave it; the token's escape hatch is sized by
#104 and empties when #104 lands); **#226** (a broadcast dropped in the final
minute before the cancel deadline is never repaired — accept it, allow a grace
period for the *sweep only*, tighten the cadence at the window's end, or make the
broadcast durable via an outbox; the last removes the whole class of defect and
is the only one that is not a patch); #194 (withdraw the superseded classes, or
leave them standing?); #73, #76, #52 (all → #60). **#192 was on this list and is
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
