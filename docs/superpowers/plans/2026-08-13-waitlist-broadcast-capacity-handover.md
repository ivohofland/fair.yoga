# Handover: implement the waitlist broadcast capacity plan (#212)

You are picking up #212. The bug fix itself is about fifteen lines. Most of this
branch is the consolidation around it — one status list replacing six copies,
one seat-count helper replacing five hand-written ones — because the omission
being fixed is what that duplication produces.

Two things will try to send you the wrong way, and both are documents you will
read before this one: **the GitHub issue's account of how the bug happens is
wrong**, and **the fix it recommends does not work**. §1 covers both. They are
not traps you can reason your way out of mid-implementation; read that section
before you open a file.

**Read in this order, before touching anything:**

1. `CLAUDE.md` — the stack, the data model, the design philosophy. opencode
   auto-loads `AGENTS.md`, which only *links* to `CLAUDE.md`. Read it anyway.
2. `docs/superpowers/specs/2026-08-13-waitlist-broadcast-capacity-design.md` —
   the design. §1 is what the issue got wrong and why it matters; §2 is why the
   obvious fix is not the fix; §4.2 is the helper's contract.
3. `docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity.md` — the plan
   you execute. Four tasks, all full TDD cycles.
4. This file.

You are on branch `fix/212-waitlist-broadcast-capacity`, cut from `main`. Both
commits on it are documentation — the spec and the plan. `git diff main...HEAD
--stat` shows exactly two files, both under `docs/`. `git status` should be
clean except for the untracked `docs/backlog-roadmap.md`, which stays untracked
forever and is not yours to edit.

---

## 1. Orientation, and the two things most likely to derail you

`handleSpotFreed` (`src/services/waitlist.ts:626`) has three branches. Two of
them hand out a seat and both check capacity first, under the class row lock:

- `promoteNext:415` — `if (activeCount >= cls.maxStudents) throw … 'class_full'`
- `claimSpot` — `if (activeCount >= cls.maxStudents) throw … 'class_full'`

The third — the final-hour `first_come_first_claimed` broadcast at `:658-675` —
reads the waiting list and notifies. It contains no `registration.count` and no
comparison against `maxStudents`. A class that is full when the hook runs still
tells every waiting student a spot opened. They tap claim and get a 409.

No schema change. **No migration** — if you think you need one, that is a plan
defect: stop and report it.

### Derailer 1: the issue's scenario cannot actually happen

Issue #212's "What a student hits" section says the class gets refilled by
*"a second cancellation and re-registration, or a walk-in"*. **Neither works,
and if you try to build a test from that narrative you will not be able to reach
the state.**

- A cancel frees the seat it announces. `activeCount` is `maxStudents − 1` the
  instant it commits, so the broadcast that follows is *correct*.
- A walk-in cannot happen in this window. Walk-ins need
  `now >= classStart − 15min` (`registrations/route.ts:46,139`); the claim
  window ends at earliest `classStart − 6h` (`getWaitlistWindow`, deadline
  minimum `HOURS_6`). Disjoint by 5h45m, and past the deadline the window is
  `frozen` anyway.
- A teacher shrinking `maxStudents` cannot happen either — it is an
  `ECONOMIC_FIELD` (`lib/class-fields.ts:13-19`), frozen once `settingsLocked`
  flips on the first registration.

**The only reachable path is a refill committing between the cancel and the
hook's read** — a booking, or a `claimSpot` from an earlier broadcast. Spec §1
has the full derivation. This does not make the bug less real; it decides what
the fix has to be, which is derailer 2.

You do **not** need to stage that race to test the guard. "Full class with
students waiting" is the ordinary resting state of a waitlist — `addToWaitlist`
only accepts anyone on a class that is *already* full — so the plan's test
reaches it directly, with no concurrency.

### Derailer 2: the fix the issue recommends leaves the bug

Issue #212's option 1 — its own recommendation, and the one that looks like the
siblings — is a bare count:

```ts
const activeCount = await db.registration.count({ … });   // WRONG — do not ship this
if (activeCount >= cls.maxStudents) return { action: 'none' };
```

Outside a transaction that holds the class row lock, this moves the race from
*cancel-commit → findMany* to *count → createMany*. Since a race is the **only**
way to reach this bug, a fix that leaves a race leaves the bug. The count and
the notification insert go in **one transaction under `lockClassRow`**, which is
what makes `promoteNext`'s and `claimSpot`'s checks sound rather than
decorative.

If you find yourself writing `db.registration.count` in `handleSpotFreed`, you
are implementing the issue body rather than the spec.

---

## 2. Before you start — verify, don't assume

Every issue worked in this project has had a premise that was wrong or
incomplete, and every plan has had at least one line reference drift. These were
all true when this file was written; each takes seconds.

```bash
# 1. The four lines the plan edits by number are still where it says.
sed -n '45p'  src/services/waitlist.ts
sed -n '658p' src/services/waitlist.ts
sed -n '35p'  src/services/class-transitions.ts
sed -n '143p' src/app/api/registrations/route.ts
```

Expected, exactly:

```
const ACTIVE_REGISTRATION_STATUSES = ['registered', 'attended', 'no_show'] as const;
  // first_come_first_claimed: notify everyone waiting; first claim wins.
const ACTIVE_REGISTRATION_STATUSES: RegistrationStatus[] = ['registered', 'attended', 'no_show'];
        where: { classId: body.classId, status: { in: ['registered', 'attended', 'no_show'] } },
```

If any has moved, find the real line — do not edit by line number alone.

```bash
# 2. The duplication census the branch closes.
grep -rn "'registered'" src --include='*.ts' --include='*.tsx' | grep attended | wc -l
```

Expected: **13**. Ends at 8 (1 definition + 5 inliners of the *different*
four-element `CHARGED_STATUSES` list + 2 test files left alone deliberately).
If it is not 13 now, someone added a copy — say so, and adopt it too.

```bash
# 3. The capacity counts the helper replaces.
grep -rn "registration\.count" src --include='*.ts' | grep -v '\.test\.'
```

Expected: **6 lines, 5 of them real** — `registrations/route.ts:142`,
`class-transitions.ts:286`, `waitlist.ts:185`, `:412`, `:550`, plus a prose
mention in a comment at `class-transitions.ts:220` that is not a call site.
Ends at 3 lines / 2 real: `capacity.ts` and `class-transitions.ts:286` (which
counts against `minStudents` — a different question, deliberately left alone).

```bash
# 4. `handleSpotFreed` is NOT yet imported by the test file.
grep -n "handleSpotFreed" src/services/waitlist.test.ts
```

Expected: **one hit, at `:889`, inside a comment.** The import block at the top
does not include it. Task 3 must add it — do not read that grep hit as "already
imported".

```bash
# 5. The dev server is up. You need it for `npm run verify`; you must not start it.
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login
```

Expected `200`. If not, **stop and ask the owner to start it.**

---

## 3. You are not running under Claude Code

The plan's header says *"REQUIRED SUB-SKILL: Use
superpowers:subagent-driven-development"*. That is written for the harness the
plan was authored in. **Superpowers is not installed for opencode here**, so you
have no `superpowers:*` skills.

**What to do instead:** execute the plan yourself, task by task, in order. Every
task carries the full TDD cycle as explicit steps — write the failing test, run
it and watch it fail, implement, run it and watch it pass, run the mutations,
commit. Follow them literally. That is all the missing skill would have given
you.

**No `/pr-review-toolkit:review-pr`.** Finish the four tasks, push, open the PR,
then **stop and hand back** — the owner runs the multi-agent review in the other
harness.

---

## 4. Task order, and what is actually independent

**The order is mandatory for 1 → 2 → 3**, by real dependency:

| # | Task | Depends on | Notes |
|---|---|---|---|
| 1 | One home for the active-status list | — | 6 sites. Pure refactor, no behaviour change. Mutation M1. |
| 2 | `readSeatCount` | T1 (imports the constant) | New file + test + brand pin. Mutations M2, M3. |
| 3 | **The fix** — the broadcast counts under the lock | T2 (calls the helper) | The issue's deliverable. Mutation M4. |
| 4 | Adopt the helper at the four pre-existing sites | T2 | Pure refactor. Mutations M5-M8. |

**Task 4 is last on purpose, and it is the one task you may report as blocked
without stranding anything.** It changes four working guards for consistency
alone; the bug is already fixed by the end of Task 3. If Task 4 goes wrong in a
way you cannot articulate, stop and report — do not force it, and do not fold
its changes back into Task 3 to make the branch look tidier.

The reverse does not hold: do not reorder Task 3 before Task 2 by inlining the
count "just for now". That is derailer 2 wearing a different hat.

---

## 5. The stop conditions that matter most

### Task 3's test must fail before the fix — and it is the mutation

For this guard the mutation and the original defect are the **same edit**: the
guard is missing, not wrong. So the pre-fix run is the baseline, and after you
implement, re-deleting the guard must reproduce that failure *exactly*. A
re-deletion that fails differently is testing something else — say so rather
than accepting it.

Expected pre-fix failure: `handleSpotFreed` returns
`{ action: 'broadcast', notified: 2 }` where `{ action: 'none' }` is expected,
and `countBroadcasts()` is 2 where 0 is expected.

**If that test passes before you implement the fix, stop and report it.** The
likely causes are a fixture that is not actually full, or a `now` outside the
claim window — both mean the test is not testing what it claims. Do not adjust
the assertion until it goes red.

### The second half of that test is not optional

The test asserts silence on a full class, **then frees the seat and demands the
broadcast**. That second half is the control: without it, the test passes
against a `handleSpotFreed` broken to do nothing at all, which is not the
property under test. This project has shipped guards that existed and could not
fail (#39 shipped three); the control is how that stops repeating. Do not
simplify it away.

### The mutations are the deliverable, not busywork

Eight, recorded with their **exact error text** — not a paraphrase — in
`docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md`,
which you create in Task 1.

| # | Task | Mutation | Must fail on |
|---|---|---|---|
| M1 | 1 | `'no_show'` → `'no_shows'` | `tsc --noEmit`, at the `satisfies` clause |
| M2 | 2 | drop the status filter from the count | `capacity.test.ts` phase 3: `activeCount` 3 not 1 |
| M3 | 2 | brand → `Prisma.TransactionClient` | `tsc`: unused `@ts-expect-error` |
| M4 | 3 | delete the capacity guard | the pre-fix baseline, reproduced exactly |
| M5 | 4 | `addToWaitlist`: `> 0` → `>= 0` | a join accepted on a class with a free seat |
| M6 | 4 | `promoteNext`: `<= 0` → `< 0` | a promotion at exactly `maxStudents` |
| M7 | 4 | `claimSpot`: `<= 0` → `< 0` | a claim at exactly `maxStudents` |
| M8 | 4 | booking route: `<= 0` → `< 0` | a booking accepted at exactly `maxStudents` |

M5-M8 are **off-by-one at the boundary, not deletions**, and that is deliberate.
Deleting a guard you just refactored proves only that it exists; moving the
boundary by one proves it still bites at exactly `maxStudents`, which is how a
working guard actually breaks during adoption.

**If any of M5-M8 passes, the boundary is untested.** Write the missing test
before continuing, and say in your report that the gap was found by the mutation
rather than assumed away. Do not record a passing mutation as "covered
elsewhere" without naming the test that covers it.

Restore after every mutation and re-run to confirm green before moving on.

---

## 6. Hazards that have actually bitten this project

- **Prisma's `in:` rejects a readonly array; `.includes()` rejects a widened
  one.** This is the compile error you will hit in Task 1, at six sites, and the
  wrong reaction is to weaken the constant. The two correct forms already exist
  in the codebase:
  - filter → `status: { in: [...ACTIVE_REGISTRATION_STATUSES] }`
  - membership → `(ACTIVE_REGISTRATION_STATUSES as readonly string[]).includes(x)`

  `class-transitions.ts`'s three usages pass the array **bare** today, because
  its local copy was typed mutable. All three need the spread once they import
  the shared readonly one. `waitlist.ts:694` is the existing example of the cast.
- **`@/lib/log` is pino and server-only.** `src/lib/registration-status.ts` must
  stay import-free at runtime — a bare `export const` plus one `import type`,
  which erases. This is why `lib/class-fields.ts` exists at all; its docblock
  records the incident. Do not "tidy" the new module by importing anything from
  `services/`.
- **The in-process scheduler is running against the dev database, and it cannot
  reach your fixtures — for a reason worth knowing.** `src/instrumentation.ts`
  starts it with the dev server, and its sweeps rewrite past-dated `open`
  classes. Both new test fixtures are dated June 2026 (in the past) and would be
  eaten — except the `unit` project runs against `DATABASE_URL_TEST`
  (`ethical_yoga_test`, a separate database; `vitest.config.ts`,
  `tests/setup/unit-db.ts`), and in CI, where that variable is unset, the
  scheduler is off. Safe on both paths, for two different reasons. **If you move
  either test to the `integration` project, that protection is gone** and the
  dates must move to 2099 — see `docs/superpowers/plans/2026-08-13-stranded-waitlist-display-handover.md` §6.
- **`Class` carries a partial unique index Prisma cannot express:**
  `Class_teacher_slot_unique` on `(teacherId, date, startTime) WHERE status <>
  'cancelled'` (`prisma/schema.prisma:379-383` — the previous handover cited
  `378-382`, and re-measuring for this one is how the drift was caught; treat
  every line number here the same way). Both new fixtures create one
  class each, under their own new teacher, on distinct dates — no collision. If
  you add a second class to either block, give it its own `startTime` or its own
  teacher, as `waitlist.test.ts`'s `claimSpot (DB)` block does.
- **zsh globs `(`, `)`, `[`, `]`.** Task 1 edits
  `src/app/(student)/bookings/page.tsx` and
  `src/app/(teacher)/class/[id]/page.tsx`. An unquoted path in `grep`, `sed` or
  `git add` either errors with `no matches found` or silently matches nothing.
  Quote every path with brackets or parentheses, including `--include='*.ts'`.
- **Never write a GitHub closing keyword immediately before a `#N` reference in
  a commit message**, in any grammatical role — including as a noun, and
  including with a colon between. A commit body reading *"the class-template
  **fix: #196**'s partial unique index"* closed #196 by accident. It has since
  happened again, inside the commit written to document it. The words are `fix`,
  `fixes`, `fixed`, `close`, `closes`, `closed`, `resolve`, `resolves`,
  `resolved`. Write "for #212" or "#104 is unaffected". Only the PR body may
  deliberately close #212.
- **Never edit an applied migration.** No migration belongs in this branch.
- **Never start or restart the dev server on :3000.** The owner runs it.
- **Do not fix things you notice in passing.** Five specifically:
  - **The five `CHARGED_STATUSES` inliners** — `(public)/[slug]/page.tsx:53`,
    `(public)/[slug]/book/[classId]/page.tsx:32`, `(teacher)/page.tsx:46`,
    `(teacher)/settings/reporting/page.tsx:43`,
    `(teacher)/schedule/past/page.tsx:23`. They inline a **different**,
    four-element list (`+ late_cancel`) that already has a name in
    `class-lifecycle.ts:168`. Same-looking, different question. Out of scope.
  - **`CHARGED_STATUSES` itself does not move** to `lib/`. Spec §4.1 records why
    (four comments across three test files name its current home, one by line
    number) and that the decision was deliberate rather than overlooked.
  - **`registrations/[id]/route.ts`'s `notIn: ['cancelled', 'late_cancel']`** is
    the complement form, asking "not already cancelled" rather than "occupies a
    seat". It stays a literal because it means what it says.
  - **#104** — the five inline unbounded `FOR UPDATE` waits, four of them in
    `waitlist.ts`. `db-locks.ts:139-152` names them as deliberately excluded.
    Your new lock uses `lockClassRow`; the four beside it do not change.
  - **#182** — `handleSpotFreed` still decides `status` and `window` from a
    pre-lock read. Same family, different owner. Spec §7 records it as a
    deliberate exclusion.

  If you find a *sixth* thing, write it in your report; do not fix it.

---

## 7. Running the tests

```bash
npx vitest run --project unit src/services/capacity.test.ts   # the fast loop
npx vitest run --project unit src/services/waitlist.test.ts
npm run verify                                                # typecheck + lint + all three projects
```

`npm run verify` needs the app on :3000.

### Expected counts

**Baseline, measured by `npm run verify` on this branch immediately before this
file was written, with no source changes yet:**

```
Test Files  113 passed (113)
Tests       1296 passed | 2 todo (1298)
Duration    139.49s
```

Which splits, so the total is checkable rather than a number to trust:

```
files:  48 unit + 37 components + 28 integration = 113 ✓
tests: 702 unit + 202 components + 392 integration = 1296 ✓
```

`unit` (48 / 702 + 2 todo) and `components` (37 / 202) were measured directly
for this handover; `integration` is the remainder and reconciles exactly against
the full-suite total. **Both todos live in `unit`** — if `integration` or
`components` ever reports one, something was skipped.

That baseline was measured, not inherited, and the difference matters: the
previous branch's handover *predicted* 1294 tests after its merge. The real
number is 1296, because that branch's review added two the prediction could not
know about. **Measure yours the same way rather than trusting this file's
"after" figures.**

Two and a half minutes is the normal duration for the full run. It is not hung.

This branch adds **1 new file and 2 tests**, both in the `unit` project
(`capacity.test.ts` with one test; one appended to `waitlist.test.ts`), so a
correct finish is:

```
Test Files  114 passed (114)
Tests       1298 passed | 2 todo (1300)

files:  49 unit + 37 components + 28 integration = 114 ✓
tests: 704 unit + 202 components + 392 integration = 1298 ✓
```

**That is a floor, not a target.** If a Task 4 mutation exposes an untested
boundary you must add a test, and the count goes higher — which is a good
outcome, not a discrepancy. State the number you measured and what you added.
Anything *lower* means a test was deleted or renamed: say so explicitly rather
than letting the total pass as normal.

**This branch touches no `integration` file.** Both new tests are unit-tier.
Task 4 *runs* `tests/integration/registrations-api.test.ts` and
`tests/integration/waitlist-api.test.ts` to confirm the booking route's
refactor changed nothing, but does not modify them. Say exactly that in the PR
body — "no integration file changed; the whole integration project ran green via
`verify`" — rather than naming files as touched that were only executed.

Green `verify` is a strong signal but **not** a substitute for CI: CI also runs
`prisma validate`, a migration-drift check, `npm run build`, and Playwright. A
build-only defect passes `verify` and fails CI — which is the realistic risk in
Task 1, since it adds an import to two page components.

### Alarming output that is not a failure

- **`ECONNREFUSED` across the integration project** means the dev server is
  down. Stop and report; do not start one.
- **`error` level pino lines are expected** — several tests deliberately drive
  failure paths. All of these appeared in the clean baseline above:
  `email fallback send failed` (`reason: "boom"`), `socket hang up`,
  `failed to release email-fallback claim (will not retry)`,
  `failed to claim notification for email fallback`, `test-job sweep failed`
  (`boom-alpha`, `boom-gamma`),
  `class generation could not fill every date in the window`,
  `invalid timezone, falling back to UTC`. **Judge by vitest's summary line, not
  by log noise.**
- **Postgres `40P01` deadlock output** is a documented, classified condition on
  this schema (`docs/lock-order.md`). If it appears in a *new* place — and your
  branch adds a lock — report it rather than re-running until it passes.

---

## 8. What done looks like

1. Two new source files (`src/lib/registration-status.ts`,
   `src/services/capacity.ts`), one new test file
   (`src/services/capacity.test.ts`), and the modified files listed in the
   plan's File Structure table. Nothing else in `src/`.
2. `handleSpotFreed`'s broadcast counts under `lockClassRow` and returns
   `{ action: 'none' }` when `freeSeats <= 0`.
3. All eight mutations run, restored, and each failure's **exact text** recorded
   in the mutations file and referenced from the relevant commit message.
4. `npm run verify` green, with the arithmetic stated (`114 files = 49 + 37 +
   28`; `1298 tests = 704 + 202 + 392`), not just asserted.
5. Both census greps re-run and reported: the literal list at **8** (from 13),
   `registration.count` at **3 lines / 2 real** (from 6 / 5).
6. `git diff main...HEAD --name-only` reconciled against the plan's File
   Structure table. An extra source file in that list needs explaining.
7. `docs/backlog-roadmap.md` **untouched and still untracked.** Do not edit it,
   do not `git add` it, and do not read it as authority on this branch.
8. `git log main..HEAD --format=%B | grep -inE '(clos|fix|resolv)[a-z]*[[:space:]:]+#[0-9]+'`
   — **then read what it prints.** A previous branch ran this exact grep, it
   printed the offending line, and the output was misread as clean.
9. PR pushed and opened. Then **stop** — the owner runs the review.

### The PR body must record

- The `verify` arithmetic, before and after, with the per-project split.
- Every mutation and its failure text — including that M4 reproduces the pre-fix
  baseline exactly.
- That **no integration file changed**, and that the whole integration project
  nonetheless ran green via `verify` (see §7 — do not claim files as touched
  that were only executed).
- Which inherited claims you checked and which held. Three in #212 are false or
  incomplete: the walk-in scenario, the re-registration scenario, and the
  recommended bare-count fix. One held: that `claimSpot`'s check is the only
  thing between the message and the truth.
- The behaviour change under lock contention: a class row held longer than
  `lockClassRow`'s 2s bound now drops the broadcast entirely, where it
  previously always fired. Both callers log and swallow. Spec §4.4 argues this
  is the right failure; state it anyway, because a reviewer should get to
  disagree.
- What the PR does **not** do: it does not re-derive `status` or `window` under
  the lock, does not change the first-come-first-claimed contract, does not
  touch the four inline unbounded locks, and adds no migration. Write
  "**#104 is unaffected**" and "**#182 is unaffected**". Never write the negated
  form with a closing keyword next to the number — GitHub reads it as a
  directive and the negation is invisible to the parser.

### What to report when you hand back

- Which tasks completed, which blocked, and why.
- Every mutation with its recorded failure text, and any that passed (with the
  test you then wrote).
- The `verify` arithmetic, before and after.
- **Anything in the plan that turned out to be wrong.** Four task briefs on an
  earlier branch were wrong about the state of the code, and every one was
  caught by an implementer checking rather than complying. Surfacing a plan
  defect is worth more than working around it — say so plainly rather than
  quietly adapting. The plan's line numbers and its claim that
  `registrationCount` is unreferenced elsewhere in the booking handler are the
  two most likely to have drifted.
- Anything you noticed and deliberately did not fix.

---

## 9. Final checklist

- [ ] On `fix/212-waitlist-broadcast-capacity`; clean but for the untracked roadmap
- [ ] `CLAUDE.md` read; the spec read; §2's five checks run
- [ ] No `db.registration.count` inside `handleSpotFreed` — the count is inside the transaction, under `lockClassRow`
- [ ] Task 3's test was seen to fail before the fix, for the stated reason
- [ ] The test's second half (free the seat, demand the broadcast) is still there
- [ ] All eight mutations run, restored, and recorded with exact text
- [ ] No M5-M8 mutation left passing without a new test
- [ ] `src/lib/registration-status.ts` imports nothing at runtime
- [ ] Six sites import the shared constant; spread for filters, cast for `.includes()`
- [ ] The five `CHARGED_STATUSES` inliners and the `notIn` complement untouched
- [ ] No migration; `prisma/schema.prisma` untouched
- [ ] No commit message puts a closing keyword before a `#N`
- [ ] `docs/backlog-roadmap.md` untouched and still untracked
- [ ] `npm run verify` green at ≥114 files / ≥1298 passed / 2 todo, up from 113 / 1296 / 2
- [ ] PR opened; handed back without running the review
