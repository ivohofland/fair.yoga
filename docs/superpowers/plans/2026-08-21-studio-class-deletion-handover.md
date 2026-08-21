# Handover — studio class deletion (issue 279)

You are picking up a branch that is designed but unbuilt. The spec and the plan
are committed; nothing under `src/` has been touched. This document is not a
summary of either — you have both. It carries what they cannot: what will
mislead you on the way.

Branch: `feat/279-studio-class-deletion`, currently two commits ahead of `main`
(`4c03f22` spec, `9f6ed57` plan).

---

## 0. Read these four, in this order

| # | File | What actually matters in it |
|---|---|---|
| 1 | `CLAUDE.md` | **Class Lifecycle** (the studio family's rules sit beside it), **Development Principles** (test-first, `strict: true`, services framework-agnostic), **Design Philosophy** (the copy register, and "essentially no motion"). |
| 2 | `docs/superpowers/specs/2026-08-21-studio-class-deletion-design.md` | §1 is what the issue got wrong and why it matters. **§4.2 and §5 are the two you will be tempted to disagree with** — read §4.2 twice. §6.4 is the answer to "where is the audit trail". |
| 3 | `docs/superpowers/plans/2026-08-21-studio-class-deletion.md` | Six tasks with real code, in order. This is your working document. |
| 4 | `.claude/skills/solve-issue/SKILL.md` | Only §2 (counts), §3 (prove every guard bites) and §4 (correct a claim in every artifact). Skip the rest — it describes a process you are not running. |

**If your harness auto-loads `AGENTS.md`, that is not a substitute for
`CLAUDE.md`.** `AGENTS.md` mentions it once, at line 81, in a reference table
("`CLAUDE.md` | Stack overview, data model, design philosophy"). It links; it
does not carry the content. `AGENTS.md` is genuinely useful for the quick-start
and the three-Vitest-project description — read both.

---

## 1. The derailers

Not hazards. Wrong turns that the **correct** documents invite. They are
unrecoverable once you are mid-implementation, so they come before the first
instruction.

### D1 — `room-deletion.ts` is the model, and copying its backstop is wrong

The spec points at `src/services/room-deletion.ts` repeatedly, and it is the
right model for shape: policy in a framework-agnostic service, route as a thin
wrapper, a named message and a named code. So the natural next move is to copy
its foreign-key backstop (`isRoomDeleteBlocked`, `ROOM_IN_USE_RACE_CODE`) for
the check-to-delete race.

**There is no such race here, and adding a backstop guards nothing.** Neither
disjunct of the predicate can flip `removable → not removable`: `templateId` is
written once at creation and never updated, and a class whose start has passed
cannot un-pass it. The archive door's `deleteMany` is keyed on a concrete
`templateId` with `cancelledAt: null` and `date: { gt: today }`, so it can match
neither a manual row nor a past one. The only real race is a second click, and
`isRecordNotFound` answers it as 404.

If you find yourself writing a `RESTRICT_FKS` array, stop.

### D2 — "past" is the start instant, never the calendar date

`StudioClass.date` is `@db.Date` — midnight UTC of a calendar date. It is
extremely natural to write `sc.date < today` and move on. That is mutation M1,
and it is wrong in a way that passes most tests: it calls a class removable from
local midnight, while the generator still treats that date as a candidate until
the class's `startTime`.

Use `classStartInstant(sc.date, sc.startTime, timeZone) <= now`. It is the same
expression the generator filters candidates by
(`src/services/studio-class-generator.ts:141`), and that is the entire
justification for the rule.

### D3 — there are TWO predicates on the page, and merging them is the bug

`src/app/(teacher)/studio-class/[id]/page.tsx` computes two things that overlap
almost everywhere:

- **removable** — can the sweep undo this removal (start-instant based)
- **counts toward earnings** — is this row inside reporting's window
  (`cancelledAt === null && date <= endOfToday`, calendar-date based —
  `src/app/(teacher)/settings/reporting/page.tsx:36`)

They disagree in exactly two places, and both are real: a **future-dated manual**
class is removable and counts nothing; a class **dated today whose start has
passed** is removable and counts. Deriving one from the other is wrong in both
directions, and it will pass the first three page cases.

### D4 — the parameter type is the guard; do not widen it

`studioClassDeletability` takes `{ templateId, date, startTime }` and nothing
else. That is deliberate and load-bearing: it makes the two reads §4.2 forbids —
template state and `cancelledAt` — *unrepresentable* rather than merely
discouraged.

You will want to widen it. The two temptations, in the order they arrive:

1. "It would be simpler to pass the whole `studioClass`." It would, and it opens
   both wrong reads at once.
2. "An archived template generates nothing, so a future class under one is safe
   to remove." Template state is **reversible** — un-archive, resume, and the
   released date is refilled. A predicate that reads reversible state is a
   predicate that can flip.

`room-deletion.ts:16-20` gives this exact warning one model over, and its last
clause is the important half: *"it compiles, it passes any test written against
a live template."* Here it does not compile, which is the whole point.

### D5 — refusing a future generated class looks like a missing feature

It is not. Removing one releases `(templateId, date)`, and the hourly sweep
recreates it within the hour — silently, forever. A delete that quietly reverses
itself is worse than no delete. Issue 275 withdrew "narrow the unique index" as
a remedy for precisely this reason, in its own first comment.

Cancel is the correct operation there and already exists. The 409 names it.

### D6 — §5 of the spec describes a FUTURE interaction; do not build for it

Issue 284 will make generation week-keyed, after which removing a *past
generated* class can free that class's week. The spec records this so the
justification does not silently go stale. **The predicate does not narrow and no
code in this branch accounts for it.** Today occupancy is per-date and the whole
interaction is inert. Your job is to leave the docblock paragraph intact, not to
implement against it.

### D7 — a delete door already exists, and it is not yours to touch

`archiveOrUnarchiveStudioTemplate` hard-deletes `StudioClass` rows
(`src/services/studio-class-template-lifecycle.ts:1262`). This surprises people,
and the issue's own title denies it. It is correct, it is deliberate, and it is
out of scope. Do not "make it consistent" with the new door — in particular, do
**not** make it stop sparing cancelled rows. Tracker 274 records that lifecycle
as the most complete in the codebase.

---

## 2. Verify, don't assume

Every line number below was checked against `main` at `ab513bc` on 2026-08-21,
and all 26 landed — there is no drifted reference to warn you about this time.
Run the block anyway before your first edit. **If any line has moved, fix the
reference in the spec and the plan and say so in your report** — a silently
corrected citation is how the next reader inherits a wrong one.

```bash
cd /path/to/fair.yoga
chk() { printf '%-56s ' "$1:$2"; sed -n "$2p" "$1" | sed 's/^[[:space:]]*//' | cut -c1-70; }

chk src/lib/timezone.ts 159                                   # export function classStartInstant(
chk src/services/studio-class-generator.ts 141                # classStartInstant(date, template.startTime, ...) > startDate
chk src/services/studio-class-generator.ts 166                # reason: own.cancelledAt !== null ? 'blocked_by_cancelled' : ...
chk src/services/room-deletion.ts 16                          # * `isActive` nor `isArchived` nor `status`. Narrowing this ...
chk src/services/room-deletion.ts 68                          # export const ROOM_DELETE_BLOCKED_MESSAGE =
chk src/services/room-deletion.ts 106                         # export const ROOM_IN_USE_CODE = 'ROOM_IN_USE';
chk 'src/app/api/rooms/[id]/route.ts' 114                     # return respondOk({ deleted: true });
chk src/lib/api-errors.ts 249                                 # return error instanceof Prisma.PrismaClientKnownRequestError ...
chk 'src/app/api/studio-classes/[id]/route.ts' 14             # export const GET = withErrorHandler(async (
chk 'src/app/api/studio-classes/[id]/route.ts' 32             # export const PUT = withErrorHandler(async (
chk 'src/app/api/studio-classes/[id]/route.ts' 79             # });      <- end of the file; DELETE goes after this
chk 'src/app/(teacher)/studio-class/[id]/page.tsx' 60         # {studioClass.cancelledAt ? (
chk 'src/app/(teacher)/studio-class/[id]/page.tsx' 73         # <section className="mt-8 pt-6 border-t border-border">
chk 'src/app/(teacher)/settings/reporting/page.tsx' 36        # where: { teacherId, cancelledAt: null, date: { lte: endOfToday } }
chk 'src/app/(teacher)/settings/reporting/page.tsx' 52        # const studioEarnings = (s: ...) =>
chk prisma/schema.prisma 488                                  # /// withdrawn. An already-cancelled one is an income record ...
chk prisma/schema.prisma 517                                  # model StudioClass {
chk prisma/schema.prisma 535                                  # @@unique([templateId, date])
chk src/services/studio-class-template-lifecycle.ts 664       # const scheduledWhere = (templateId: string, date: ...
chk src/services/studio-class-template-lifecycle.ts 1262      # const { count: deleted } = await tx.studioClass.deleteMany({
chk src/lib/types.ts 32                                       # export type SessionUser = { sessionId: string; accountId: ...
chk prisma/seed.ts 622                                        # // starts, and it never reaches Past classes on its own day...
chk src/lib/schemas.ts 476                                    # export const updateStudioClassSchema = z.object({
chk tests/integration/privacy-page.test.ts 111                # const res = await fetch(`${BASE_URL}/account/privacy`, ...
```

And the environment:

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep fairyoga-db-1
#   fairyoga-db-1   Up ... (healthy)          <- required by the `unit` and `integration` projects

curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
#   307                                        <- the dev server, redirecting an anonymous request
```

**The dev server on :3000 is run by the repo owner. Do not start it, do not
restart it.** The `integration` project talks to it over HTTP; without it you
get a wall of `ECONNREFUSED` that looks like a test failure and is not.

---

## 3. Harness differences

You are not running the harness this plan was written in. Concretely:

- **There is no skills system.** The plan references `superpowers:...` skills in
  its header. Ignore that line; the plan itself is self-contained.
- **TDD ordering is not enforced for you.** The plan's step order — write the
  failing test, watch it fail, implement, watch it pass — is the project's
  stated rule (`CLAUDE.md`, "Development Principles"), not a harness artifact.
  Keep it. "See it fail" is what distinguishes a test from a decoration, and
  this branch's whole value is guards that can actually fail.
- **The mutations are deliverables, not a private exercise.** Task 1 Step 5 and
  Task 2 Step 5 tell you to record the exact failure text. Write them to
  `docs/superpowers/plans/2026-08-21-studio-class-deletion-mutations.md` as you
  go; the PR body quotes that file. A mutation you performed and did not record
  is one nobody can check.
- **Commit per task, and do not squash.** The PR is rebase-merged and the
  commit-per-task history is the record. Six tasks, six commits (Task 6 adds
  none unless verification finds something).
- **Stage exact paths. Never `git add -A` or `git add .`.** And **quote any path
  containing parentheses** — `"src/app/(teacher)/studio-class/[id]/page.tsx"`.
  Unquoted, zsh's glob silently matches nothing and you commit an empty change.

---

## 4. Task order, and which constraints are load-bearing

Two orderings are **required**, not preference:

- **Task 1 before Task 2.** The route imports `studioClassDeletability` and both
  refusal constants. Nothing else provides them.
- **Tasks 1 and 3 before Task 4.** The page imports the predicate *and*
  `DeleteStudioClassButton`.

Everything else is preference, with a reason:

- Task 5 (the documentation) is placed last among the code tasks because it is
  issue 279's actual acceptance and reads better written against code that
  exists. Doing it earlier is fine; doing it *never* fails the issue.
- Task 6 is the whole-branch gate and must genuinely be last.

The **within-task** order is load-bearing everywhere: the failing-test step
exists so you observe the failure, and the observed failure message is the thing
that tells you the test is wired to the right symbol.

---

## 5. Stop conditions

Stop and report rather than working around, if any of these happen:

1. **M4 does not fail `npm run typecheck`.** M4 widens the predicate's parameter
   to carry `template: { isArchived: boolean }`. If that compiles clean, the
   parameter type is not the guard the design claims it is, and §4.2 of the spec
   needs rewriting before you go on. This is the single most important stop
   condition on the branch.
2. **M6 does not fail the cross-teacher integration case.** M6 removes the
   route's ownership check. Ownership is the gate this project's defects
   actually live in, and it hides because authentication and validation pass in
   front of it. A green suite with the check deleted means the case is not
   testing what it says.
3. **M1 does not fail the New York case.** M1 is the day-granularity mutation —
   the realistic wrong implementation, not a convenient one. If it passes, the
   timezone cases are agreeing with UTC and proving nothing (see D2, and
   `prisma/seed.ts:611-625` for the same failure in the class family).
4. **Any verify-don't-assume line has moved by more than a line or two.** That
   means `main` advanced under this branch; rebase and re-check before building
   on stale citations.
5. **A migration appears under `prisma/migrations/`.** This branch adds no
   column, index or constraint. If one shows up, something was added that the
   spec did not ask for.

---

## 6. Hazards this repo has actually been bitten by

Trimmed to what this branch can reach.

- **`@/lib/log` is pino and server-only.** `studio-class-deletion.ts` must not
  import it — the route logs instead. The service is imported by a **server**
  page, so today the chain is safe either way; the constraint exists so it stays
  safe when someone imports the predicate from a client component. `import type`
  is always safe because it erases completely.
- **Never `git add -A`; quote `(teacher)` paths.** Repeated from §3 because it
  has fired here before.
- **Never write "does not close #N" in a commit message or PR body.** GitHub's
  auto-close parser matches the keyword and does not read the negation in front
  of it. PR #191 closed issue 113 that way, and — five minutes after the reopen —
  the commit written to *document* the trap closed it again by quoting the
  phrase. Write "**#N is unaffected**" or "**leaves #N open**". If you need to
  explain the trap, break the token: write the keyword and the number apart, or
  drop the `#`.
- **Warm a route before scoring a mutation on it.** `next dev` recompiles lazily
  after a source edit, and the first request pays compilation — which can blow a
  timeout that reads exactly like an assertion failure. Apply the mutation,
  `curl` the route once, *then* judge RED/GREEN. On issue 285's sweep this would
  have mis-scored three mutations.
- **`npm run verify` needs the app on :3000** and runs all three Vitest projects.
  Green `verify` is a strong signal but not a substitute for CI, which also runs
  `prisma validate`, a migration-drift check, `npm run build` and Playwright. A
  build-only defect passes `verify` and fails CI.
- **Do not hand-list integration files as "unaffected".** The suite covers them;
  name a file only when its order matters. This branch *changes* two integration
  files and *runs* all of them.

---

## 7. The baseline, measured

Run on `feat/279-studio-class-deletion` at `9f6ed57` — that is, on the spec and
plan commits, before any source change.

| Project | Files | Tests |
|---|---|---|
| `unit` (`src/**/*.test.ts`) | 63 | 977 |
| `components` (`src/**/*.test.tsx`) | 41 | 248 |
| `integration` (`tests/integration/**/*.test.ts`) | 31 | 452 |
| **Total** | **63 + 41 + 31 = 135** | **977 + 248 + 452 = 1677** |

All green, 0 failures. Measured twice and independently: `npm run verify` reports
`Test Files 135 passed (135)` / `Tests 1677 passed (1677)` in 243.86s, and the
three per-project runs above sum to the same pair. The arithmetic is spelled out
so you can re-derive it rather than trust it — a bare total is decoration.

**This matters beyond bookkeeping: the suite is green before you touch
anything.** Anything red afterwards is yours.

**Predicted after this branch.** Counted mechanically from the plan's own `it(`
blocks, not estimated — Task 1 = 7, Task 2 = 9, Task 3 = 5, Task 4 = 5:

| Project | Files | Tests | From |
|---|---|---|---|
| `unit` | 63 + 1 = 64 | 977 + 7 = 984 | Task 1 |
| `components` | 41 + 1 = 42 | 248 + 5 = 253 | Task 3 |
| `integration` | 31 + 1 = 32 | 452 + 9 + 5 = 466 | Tasks 2 and 4 |
| **Total** | **138** | **984 + 253 + 466 = 1703** | `1677 + 26` |

Three new files: `src/services/studio-class-deletion.test.ts`,
`src/components/studio-class/delete-studio-class-button.test.tsx`,
`tests/integration/studio-class-page.test.ts`.

**Measure it anyway and report the real figure.** A prediction cannot know what
your own review adds: issue 212's handover predicted 1294 and the branch landed
at 1296, because that branch's review added two tests the prediction could not
have seen. If your number differs, the difference is information, not an error —
say what accounts for it.

### Runs versus changes

This branch **changes** two files under `tests/integration/`:
`studio-api.test.ts` (appended) and `studio-class-page.test.ts` (new). It
**runs** every file in that directory, because `npm run verify` runs all three
projects. Say it that way in the PR body — with the arithmetic, so "every
integration file ran" is a checkable claim rather than a reassurance.

---

## 8. What "done" looks like

- Six commits on `feat/279-studio-class-deletion`, one per task (Task 6 usually
  adds none).
- `npm run verify` green, with the per-project counts recorded.
- `docs/superpowers/plans/2026-08-21-studio-class-deletion-mutations.md` exists
  and carries seven entries, each with the exact failure text.
- `git diff main --stat -- prisma/` shows `schema.prisma` only — **no migration**.
- `grep -rn "income record" prisma/ src/ docs/ CLAUDE.md` returns only the
  corrected passage in `prisma/schema.prisma` and the spec's §1.5, which quotes
  it as the error it is.
- A PR opened, not merged. The repo owner runs the multi-agent review and does
  the rebase-merge.

### What the PR body must record

1. Which of the issue's claims **held** (§1.1, §1.2, §1.3, §1.6) and which were
   **wrong** (§1.4 the delete door that already exists, §1.5 the income-record
   claim). Say plainly that §1.5's error was inherited from
   `prisma/schema.prisma:488` and is corrected by this branch.
2. The mutation table with its recorded errors — including that M4's proof is a
   `tsc` failure rather than a red test, and why that is stronger.
3. The `verify` arithmetic, with totals that reconcile.
4. The two `tests/integration/` files this branch touched, **by path**.
5. What it does **not** do, using the safe phrasing: "#275 is unaffected",
   "leaves #276 open", "#277 is unaffected", "#284 is unaffected as code".
6. Anything the plan got wrong. The plan is not evidence; your diff is. If a
   predicted failure message differed from the real one, say so — four wrong
   predicted outputs were caught that way on an earlier issue, and each one was
   worth more than the prediction.

### What to report back

- The measured after-baseline, and what accounts for any gap against +26.
- Every verify-don't-assume line that had moved, and what you changed.
- Every place you disagreed with the plan, and what you did instead. **Surface a
  plan defect rather than bending the code to match a wrong instruction** — if
  the plan says something false, the plan is what should change.
- Whether the Task 4 Step 5 check in the running app found a stale schedule
  after a removal. If it did, `router.refresh()` beside the `push` is the fix and
  the plan's note says so.

---

## 9. Final checklist — one line per irreversible mistake

- [ ] Did **not** start or restart the dev server on :3000.
- [ ] Did **not** write a close-keyword immediately before any `#N`.
- [ ] Did **not** `git add -A`; quoted every `(teacher)` path.
- [ ] Did **not** edit an applied migration, and added no new one.
- [ ] Did **not** widen `studioClassDeletability`'s parameter type.
- [ ] Did **not** add an FK backstop to the DELETE route.
- [ ] Did **not** change `archiveOrUnarchiveStudioTemplate` or its
      cancelled-row sparing.
- [ ] Did **not** merge the page's two predicates into one.
- [ ] Recorded every mutation's exact failure text before restoring it.
- [ ] Opened a PR; did not merge it.
