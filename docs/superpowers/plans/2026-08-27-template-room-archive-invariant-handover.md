# Handover — the template/room archive invariant (issue 272)

You are implementing a plan that is already written. This document is not a
summary of it: it carries what the plan cannot, which is the set of things you
will get wrong *by reading the correct documents carefully*.

Everything below was verified on **2026-08-27** against this checkout at
`d2806ef1`. Where a reference has drifted by the time you read it, fix it and
say so in your report — that is a finding, not a nuisance.

---

## 0. Read these four, in this order

1. **`CLAUDE.md`** — the whole file, but *Comment Discipline* and *Class
   Lifecycle* are the two that will actually change what you write. If your
   harness auto-loads `AGENTS.md`, note that it is an 85-line quick-start that
   **points at `CLAUDE.md` from a reference table (line 83)** rather than
   containing it. Reading `AGENTS.md` is not reading `CLAUDE.md`.
2. **The spec** — `docs/superpowers/specs/2026-08-27-template-room-archive-invariant-design.md`.
   §3 is the mechanism, §4 is the evidence, **§5 contains the two docblocks
   already written for you.** Copy them; do not paraphrase them. §5 exists
   because the hazard on this branch is a misreading, and a paraphrase
   reintroduces it.
3. **The plan** — `docs/superpowers/plans/2026-08-27-template-room-archive-invariant.md`.
   Six tasks. Every step has real code and real commands.
4. **This file** — sections 1 and 2 before you touch anything.

---

## 1. The derailers

These are ordered by how expensive they are to discover late.

### D1 — the two new columns will read as #298 being undone

`ClassTemplate` gains `ruleLive`. Issue 298 *moved `isActive` off `ClassTemplate`
onto `ScheduleRule`*, three issues ago, and the schema docblocks say so. A
careful reader arriving at `ruleLive` concludes someone has quietly undone that
and "tidies" it away — taking the invariant with it.

`ruleLive` is **not** `isActive`. It is a copy the database writes and keeps
current, and the composite foreign key makes a row that disagrees with its parent
unstorable. Ownership did not move back.

The defence is spec §5's docblock, verbatim, on the columns. **Write it in the
same commit that adds the columns, not afterwards.** This class of error — a
description that is wrong rather than a name that is wrong — is invisible to
every keyword sweep, and this repo has been bitten by it repeatedly.

### D2 — door 5 must NOT copy door 4's shape, however symmetric it looks

Door 4 (create) writes `roomArchived: false`, *asserting* the room is open. No
read, so nothing can go stale: an archived room has no matching parent key and
the foreign key refuses the insert. It is the nicer pattern and you will want to
reuse it.

**Door 5 (move) cannot use it.** A *paused* template may legitimately move onto
an archived room — that is `door 5b` in the test file, and it must keep passing.
Door 5 has to mirror the target room's real `isArchived`, which means a stale
read yields `23503` and a fresh-but-forbidden one yields `23514`. Both are
refusals and both become the same 409, but the write is genuinely different.

If you find yourself deleting `door 5b` because it looks like an odd extra case,
stop — you have just built the bug.

### D3 — a true sentence you will be tempted to "correct"

`src/lib/template-selection.ts` says `ACTIVE_TEMPLATE_WHERE` reads only the
template's own flags and **never** `teacherRoom.isArchived`. Task 6 asks you to
sweep for stale claims, and this sentence will surface.

**It is still true, and it must not be changed.** What changes is the
*consequence*: the generator no longer needs to read the room, because an active
template on an archived room is not a representable state. Rewriting a still-true
claim is the mirror-image defect of leaving a stale one, and it costs more.

Give every sweep hit a verdict. Expect legitimate survivors.

### D4 — one mutation proves its point by staying GREEN

Task 4, mutation 6: delete the route's pre-check and the tests must **still
pass** with a 409. That is the proof that enforcement lives in the constraint and
the pre-check only decides which path produces the sentence.

You will be inclined to read a green mutation as "the mutation didn't work" and
go looking for a stronger one. Don't. If that mutation turns anything RED, the
pre-check is still doing enforcement work and Task 4 is unfinished.

### D5 — `23514` is also this repo's terminality SQLSTATE

`src/lib/api-errors.ts` has `isTerminalStatusViolation`, which matches `23514`
*plus* the phrase `which is terminal`. Your new CHECK raises a bare `23514`.

Two wrong turns follow from noticing this, and both look like diligence:

- Reaching for `isTerminalStatusViolation` to classify your error. It is not a
  terminality violation; that matcher will correctly refuse it.
- Adding a tail to `TERMINAL_TRIGGER_TAILS` so `api-errors.test.ts` "knows
  about" your constraint. That suite sweeps migration bodies for
  `USING ERRCODE = '23514'` — a clause a plain `CHECK` never carries — so your
  constraint is outside its census by construction. If that suite reddens, read
  the failure; do not feed it.

The right answer is Task 3's `isCheckViolationOn`, which discriminates by
constraint *name*.

### D6 — `prisma migrate dev` offering a second migration is a failure signal

The migration is hand-authored **and** the schema is edited, both describing the
same thing. If they disagree by one character, `migrate dev` offers to generate a
migration for the difference. Accepting it is the wrong move twice over: it
papers over the disagreement, and it leaves a migration whose checksum you will
later want to change.

Expected output is that the pending migration applies and **nothing new is
generated**. If Prisma offers, fix the hand-authored SQL — never the schema —
delete anything Prisma created, and re-run.

### D7 — if the race test is flaky, do not loosen its assertion

`src/services/template-room-race.test.ts` asserts the archive *waited* for the
resume (`archiveSettledAt >= resumeCommittedAt`). That assertion is the entire
point: a guard that merely read the room would also have refused, and would also
have been wrong. It runs in the `unit` project, which has
`fileParallelism: true` (`vitest.config.ts`), so it shares a database with
concurrent files.

If it is flaky, the acceptable fixes are: raise the transaction hold above
`1500`, or move the file into `SWEEP_TESTS` (`vitest.config.ts` line 8) so it
runs serially. **Weakening or deleting the timing assertion is not a fix** — it
turns the test into a duplicate of one Task 1 already has.

---

## 2. Verify, don't assume

Run this block first. Every line was run on 2026-08-27 and the expected output is
what it actually produced. A mismatch is a finding — fix the reference in the
plan and report it.

```bash
# The database container. Both `unit` and `integration` need it.
docker ps --format '{{.Names}}' | grep fairyoga
#   fairyoga-db-1

# The dev server. DO NOT START OR RESTART IT — see section 6.
curl -s -o /dev/null -w "%{http_code}\n" --max-time 4 http://localhost:3000/
#   307        <- redirecting an anonymous request; the server is up

# Every line number the plan leans on.
grep -n "result.reason === 'room_archived'" 'src/app/api/class-templates/[id]/route.ts'
#   135:   <- door 5's arm (PUT)
#   295:   <- door 3's arm (PATCH)

grep -n "teacherRoom.isArchived" 'src/app/api/class-templates/route.ts'
#   70:    <- door 4, in the ROUTE, not the service

grep -n "^export async function setTeacherRoomArchived" src/services/room-archive.ts
#   95:

grep -n "KNOWN-OPEN" src/services/room-archive.ts
#   157:   <- the note Task 5 rewrites

grep -n "KNOWN-OPEN, and deliberate" src/services/class-generator.ts
#   817:   <- the note Task 6 retires

grep -n "if (desiredActive && template.teacherRoom.isArchived)" src/services/class-template-lifecycle.ts
#   1474:  <- door 3's guard

grep -n "if (teacherRoom.isArchived && data.teacherRoomId" src/services/class-template-lifecycle.ts
#   891:   <- door 5's guard

grep -n "reason: 'room_archived' }" src/services/class-template-lifecycle.ts
#   525:   <- PauseTemplateResult's arm
#   896:   <- door 5's return
#   1264:  <- UpdateClassTemplateResult's arm
#   1479:  <- door 3's return

# There are no violating rows to remediate. Confirm rather than assume.
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -At -c '
  SELECT count(*) FROM "ClassTemplate" ct
    JOIN "ScheduleRule" sr ON sr.id = ct."scheduleRuleId"
    JOIN "TeacherRoom"  tr ON tr.id = ct."teacherRoomId"
   WHERE sr."isActive" AND NOT sr."isArchived" AND tr."isArchived";'
#   0

# Nothing in Postgres enforces this yet. Fifteen triggers, none on TeacherRoom.
grep -rh "CREATE TRIGGER" prisma/migrations/*/migration.sql | sort -u | wc -l
#   15
```

**One reference the plan deliberately does not pin:** Task 4 tells you to locate
the tests that currently assert `reason: 'room_archived'` with a `grep`, rather
than naming files and lines. That is not laziness — those assertions move
whenever the unions do, and a named line here would be the first thing to rot.

---

## 3. Harness differences

You are not running in Claude Code, so several things the plan assumes are not
automatic:

- **No skills system.** The plan references `superpowers:subagent-driven-development`
  in its header; ignore that line. Work the tasks in order yourself.
- **TDD ordering is not enforced for you, and the plan depends on it.** Several
  steps say "run it and watch it fail" and then describe *why* it fails. Those
  are not ceremony: Task 1 Step 2 distinguishes "fails because the write
  succeeded" from "fails because the fixture is wrong", and only the first means
  the test is measuring the invariant.
- **Mutations are deliverables, not scratch work.** Six of them are specified.
  Each one's exact error text goes in the PR body. A mutation you ran and did not
  record is a mutation nobody can check.
- **Commit per task.** The PR is rebase-merged, never squashed — the per-task
  history is the record. Do not amend earlier task commits to tidy them.
- **Branch from `main`**, named `fix/272-template-room-invariant`.

---

## 4. Task order, and which constraints are load-bearing

**Tasks 1 → 3 → 4 is a hard order.** Task 4 imports `isCheckViolationOn` from
Task 3, and Task 3's tests describe error shapes that only exist once Task 1's
constraint does. Task 2 can move (it only needs Task 1). Task 5 needs Task 3.
Task 6 is last by definition — it sweeps for what the others invalidated.

Within Task 1, **the order of steps 3–6 is load-bearing** and the reason is not
obvious: the migration must be applied *before* the schema is declared, because
`prisma migrate dev` reconciles the two and you want it to find them already in
agreement. Declaring first and applying second still works, but the failure mode
is worse — Prisma generates a migration for the difference and you have to
recognise that as a signal rather than a step.

**Preference, not constraint:** the file names in the plan's name table, the
`dayOfWeek` numbers in the test fixtures (change them freely if
`ScheduleRule_teacher_slot_excl` fires — a `23P01` there means the fixture
collided, not that the invariant is wrong), and whether Task 5's log line uses
`info` or `warn`.

**Constraint, not preference:** every object name in that same table. They appear
in the migration, the schema, three test files, two services and two routes, and
a rename halfway through is how a branch ends up with two spellings of one
constraint.

---

## 5. Stop conditions

Stop and report rather than working around, if:

1. **Task 1 Step 6 cannot reach `exit=0`.** The drift check is the required CI
   gate (`.github/workflows/ci.yml`, *"Check schema/migration drift"*). If the
   generated column cannot be declared driftlessly, take the documented fallback
   in Step 5 (three plain mirrored columns, no generated column) — **and report
   what forced it**, because the spec claims the generated form measures green
   and that claim would then be wrong.
2. **Task 1 Step 9 does not redden doors 1, 3, 4, 5.** Dropping the CHECK must
   break them. If it does not, the tests are asserting something other than the
   invariant and everything downstream is built on a test that cannot fail.
3. **Task 4 mutation 6 turns anything RED.** Deleting a route pre-check must
   leave the suite green (D4). Red means the pre-check is enforcing, which is the
   thing this branch exists to stop.
4. **`npm run verify` is red for a reason you did not introduce.** Report the
   failure; do not fix unrelated breakage on this branch.

Mutations 2 (drop the CHECK) and 6 (delete the pre-check) are the two that matter
most. The first proves the constraint does the work; the second proves nothing
else does.

---

## 6. Hazards this repo has actually been bitten by

Trimmed to what this branch can reach.

- **Never start or restart the dev server on :3000.** The user runs it, it serves
  this checkout, and `integration` talks to it over HTTP. If it is down, say so
  and stop.
- **Never edit an applied migration — a comment-only edit counts.** It changes
  the file's checksum while `prisma migrate status` compares only names, so
  nothing catches it until the next `prisma migrate dev` demands a reset. Prose
  about a migration goes in `docs/`.
- **Never `git add -A` or `git add .`.** Stage exact paths. Quote any path
  containing parentheses — `'src/app/api/class-templates/[id]/route.ts'` needs
  quoting for the brackets too.
- **Never write a GitHub auto-close keyword immediately before `#<number>`** in a
  commit message, PR body, or issue comment. The parser does not understand a
  negation in front of it, and this has closed the wrong issue on this repo
  twice — the second time inside a commit written to *document* the trap, because
  it quoted the phrase verbatim. Write "#N is unaffected", or separate the token
  from the number.
- **Do not leave probe or scratch `.test.ts` files under `src/`.** The `unit`
  project's glob is `src/**/*.test.ts`, so anything you leave there joins the
  suite and runs in parallel against the shared test database. Two agents have
  done this on this repo already.
- **Warm routes before scoring anything through HTTP.** `next dev` compiles
  lazily after a source edit, and the first request can blow a timeout in a way
  that reads exactly like an assertion failure.
- **Post `gh` prose from a `--body-file`, never `--body "…"`.** Backticks inside
  a double-quoted shell string reach the shell as command substitution even
  escaped, and it fails silently — a published comment with content eaten out of
  the middle.

---

## 7. The baseline, measured

Measured on this checkout at `d2806ef1` on 2026-08-27 by running the suite, not
by reading a previous document. Per project, so the arithmetic can be re-derived:

| Project | Files | Tests |
|---|---:|---:|
| `unit` | 68 | 1027 |
| `components` | 46 | 302 |
| `unit-sweeps` | 10 | 123 |
| `integration` | 33 | 527 |
| **Total** | **157** | **1979** |

The split reconciles against the real run rather than only against itself.
`npm test` is two invocations, and **both** were run separately (so a red first
tier could not hide the second) and both exited `0`:

- `unit` + `components` reported **114 files / 1329 passed** — which is
  `68 + 46 = 114` and `1027 + 302 = 1329`.
- `unit-sweeps` + `integration` reported **43 files / 650 passed** — which is
  `10 + 33 = 43` and `123 + 527 = 650`.

`114 + 43 = 157` and `1329 + 650 = 1979`, the totals in the table.
Re-derive the per-project figures without paying for a run:

```bash
for p in unit components unit-sweeps integration; do
  echo "$p: files=$(npx vitest list --project "$p" --filesOnly | grep -cE '\.test\.tsx?$') \
tests=$(npx vitest list --project "$p" | grep -c ' > ')"
done
```

**Predicted after this branch: 160 files / roughly 2000 tests** — three new files
(`template-room-constraint.test.ts` with 8 cases, `template-room-race.test.ts`
with 1, `check-violation.test.ts` with 6), plus whatever Tasks 4 and 5 add to
existing files.

**Measure it anyway and use the measured number.** A previous handover on this
repo predicted 1294 and the real figure was 1296, because that branch's own
review added tests the prediction could not have known about. The prediction is
there so a wild divergence is visible, not so you can copy it.

### Runs versus changes

This branch **changes** files in `src/services/`, `src/lib/`, `src/app/api/`,
`prisma/`, and `docs/`, and adds three test files under `src/`. Task 4 also
modifies tests under `tests/integration/` — locate them by grep rather than from
a list here.

It **runs** everything: `npm run verify` executes every vitest project, so a
green `verify` means all 157 files ran, not just the ones you touched. Say that
in the PR body with the arithmetic above, and still name the integration files
you changed by path so a reviewer knows where to look.

**"Green" is load-bearing in that sentence.** `npm test` is two invocations
joined by `&&`, so a single red unit test means the second never runs and
`integration` reports *nothing* — not zero failures, no line at all. While
anything earlier is failing, run `npx vitest run --project integration` directly
rather than reading a red `verify` as evidence about that tier.

---

## 8. What "done" looks like

- All six tasks committed, one commit each, on `fix/272-template-room-invariant`.
- `npm run verify` green.
- All six mutations run, each restored, each re-verified green afterwards.
- The `#336` trigger `diff` (Task 4, Step 10) run, with its output recorded
  whatever it says.

### What the PR body must record

- **Every mutation, with its exact error text.** Including the two that prove
  something by *not* failing.
- **The drift check's control beside its pass** — `exit=2` with the
  `Altered column \`live\`` message, then `exit=0`.
- **The race test's negative control** — what the suite reports with the CHECK
  dropped, which is issue 272 reproduced.
- **The measured baseline and the measured after-figure**, with arithmetic a
  reader can re-derive, and the prediction above noted as a prediction.
- **Which inherited claims you checked and which held.** The plan and spec make
  claims about line numbers, error shapes and Prisma behaviour; say which you
  confirmed and which had drifted.
- **The `#336` diff output**, verbatim.
- **What this branch does not do:** the class-side invariant — door 2
  (`class-lifecycle.ts`) and door 1's `classes` count — is unaffected and remains
  enforced by non-transactional reads. Issue 336 is unaffected by this branch;
  it only becomes *due*. Phrase both with "is unaffected", never the auto-close
  wording.

### What to report back

1. Anything in section 2 that had drifted, and what you changed it to.
2. Which of the three open sub-choices (plan Task 1, Steps 12–13, and the Step 5
   fallback) went which way, and on what evidence. **The Prisma client shape is
   genuinely unknown** — the spec says so in terms, because `prisma generate`
   could not be run during the design spike. Your measurement is the first real
   one.
3. Any plan step whose predicted output was wrong. Surface it rather than bending
   the code to match — four wrong predictions have been caught that way on this
   repo, and each was a plan defect, not an implementation one.
4. The deadlock probe's result (Task 6, Step 5), whatever it is.

---

## 9. Final checklist — one line per irreversible mistake

- [ ] I did not restart the dev server on :3000.
- [ ] I did not edit an applied migration, including its comments.
- [ ] I did not `git add -A`; every commit staged exact, quoted paths.
- [ ] No auto-close keyword sits immediately before a `#number` in any commit
      message or PR body.
- [ ] No scratch `.test.ts` file is left anywhere under `src/`.
- [ ] Every mutation I applied was restored, and the suite was re-run green after
      each restoration.
- [ ] Any probe database I created was dropped; `ethical_yoga` and
      `ethical_yoga_test` are the only ones left.
- [ ] The two docblocks came from spec §5 verbatim, and neither says what a
      comment used to say.
- [ ] `PauseTemplateResult` lost its `room_archived` arm and I ran the `#336`
      diff rather than assuming what it would print.
