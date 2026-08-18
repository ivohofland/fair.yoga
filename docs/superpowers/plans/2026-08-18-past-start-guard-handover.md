# Handover — the past-start guard (#249)

You are implementing a plan someone else wrote. The plan tells you *what to do*.
This document tells you *what will mislead you on the way*, which the plan
cannot, because the misleading parts come from reading the correct documents.

Branch: `fix/249-past-start-guard`, already created, already carrying four
commits (the spec, two spec corrections, the plan). Base it on nothing else.

---

## 1. Read these four, in this order

| # | File | The part that actually matters |
|---|---|---|
| 1 | `CLAUDE.md` | "Development Principles", "Class Lifecycle", "Waitlist (Hybrid Promotion)". If your harness auto-loads `AGENTS.md`, note that `AGENTS.md` only **links** to `CLAUDE.md` — it is not a substitute, and the lifecycle rules you need are only in `CLAUDE.md`. |
| 2 | `docs/superpowers/specs/2026-08-18-past-start-guard-design.md` | **§3 first** (why this is not a database constraint — it is the single most likely thing to get wrong), then §5 (the two doors), §6 (what is deliberately left alone and why), §7 (blast radius). §1.1 is the premise archaeology; skim it, but read §1.1(c) properly — it is why the design is what it is. |
| 3 | `docs/superpowers/plans/2026-08-18-past-start-guard.md` | All of it. Tasks 1-7, in order. Every code block is the actual code, not a sketch. |
| 4 | This file | §2 (derailers) before you touch anything. |

Everything below assumes you have read §3 and §6 of the spec. If you have not,
you will re-derive a worse design and spend the branch defending it.

---

## 2. The derailers

A derailer is not a hazard. It is a wrong turn that the **correct documents
invite** — you get there by reading carefully, not carelessly. These are ahead
of the first instruction because each is expensive or unrecoverable once you are
mid-implementation.

### D1. You will want to put this in the database. Do not.

This is the big one, and the reason it is first.

The immediately preceding branch (#247) solved a structurally similar problem by
adding a PostgreSQL trigger, `class_terminal_date_guard`. That branch's spec is
excellent, it is right next door in the specs directory, and its argument for
"the service holds the policy, the database holds the invariant" is persuasive
**because it is correct — for that problem**.

It is not correct here, and the difference is exact:

> #247 had a real invariant. A terminal class's `date` must never move, full
> stop, because a deleting sweep reads that column. There is a fact about the
> world for the database to hold.
>
> #249 has **no invariant** — only a rule about which *writes* are allowed. An
> `open` class whose start instant has already passed is a state the system
> produces legitimately and routinely: `generateClassInstances`
> (`src/services/class-generator.ts:45-60`, writing `status: 'open'` at `:199`)
> creates one every time it runs later in the day than its template's own start
> time, and *every* class is in that state for up to the 60 seconds before the
> transition sweep picks it up.

A `now()`-based CHECK constraint or trigger would therefore reject rows the
system is supposed to have — and would additionally reject every past-dated test
fixture and seed row in this repository. **This branch adds no migration.** If
you find yourself writing one, stop and re-read spec §3.

### D2. One test will go red, and the obvious repair silently destroys coverage

`src/services/class-lifecycle.test.ts:1793` sends `date: new Date('2020-01-01')`
to a stub `open` class and expects `{ ok: false, reason: 'terminal', … }`. It
exists to prove that #247's CAS disambiguation branch is reachable — the branch
whose absence turns that issue's single most likely request into a 500.

Your new guard answers before the write, so its `toEqual` fails loudly. Good.

**The trap is the repair.** The expected object is right there, and changing
`'terminal'` to `'past_start'` makes it green in five seconds. It also deletes
every assertion covering that branch, and nothing anywhere will say so.

**Change the payload to a future date. Never the expectation.** Task 2 Step 6
has the exact edit.

### D3. The publish guard must *fall through*, not refuse, in two cases

Reading spec §5.2 as "refuse a publish whose start has passed" produces a guard
that fires whenever `targetStatus === 'open'` and the start is past. That is
wrong in a way that is hard to see, because the guard *looks* correct:

- A **`completed`** class targeted at `open` is illegal on status grounds
  whatever its date. Answering `STARTS_IN_PAST` there is true, misleading, and
  breaks `class-lifecycle.test.ts:496`.
- A **missing** class must still report `NOT_FOUND`.

So the guard's condition includes `sourceStatesFor(targetStatus).includes(cls.status)`
— it says nothing and lets the existing CAS produce the older, stronger reason.
A guard that declines to fire when its own condition is met is counter-intuitive
enough to be "simplified" away by a later reader, which is why Task 3 Step 6 makes
you add a comment to the test that catches it.

Use `sourceStatesFor` (`src/services/class-lifecycle.ts:159`), the same helper
the CAS at `:233` uses. A hand-written status list is a second copy of
`VALID_TRANSITIONS` that will drift.

### D4. Three test fixtures have aged into the past. Re-date them; do not soften the guard.

`class-lifecycle.test.ts:268` (`2026-06-05`), `:358` (`2026-06-01`), and
`tests/integration/full-flow.test.ts:170` (`2026-07-01`) were future-dated when
written. Today they are past, so the publish guard fails them.

They are **not** evidence the guard is too strict. They are the same defect
shape this branch exists to close — a date that was fine when written and is not
fine now. Re-date to 2099 (Task 3 Step 1), before writing the guard, so the only
red in that task is the one you intended.

Leave `:502` (`2026-06-04`) past-dated deliberately: its test is what proves D3's
fall-through.

### D5. Do not add a `now?: Date` parameter to any service

`autoTransitionToInProgress`, `autoCancelClasses` and `autoCompleteClasses` all
take `now?: Date`, and copying that for testability is the natural instinct.

Nothing in this branch needs it. Every fixture is either unambiguously past
(`2020-01-01`) or unambiguously future (`2099-06-01`), and the real clock sits
between them for the next seventy years. A parameter no test would ever pass is
a widening that buys nothing and invites a future caller to shift a clock that
should not be shiftable.

Only `startsInPast` takes `now`, and there it is **required** — its own tests
must sit on both sides of a single instant.

### D6. Do not guard `POST /api/classes`

Spec §1.1(c) says creating a past-dated class is unbounded today, which reads
like a hole. It is not one, and the user explicitly decided against closing it:

- A created class is `status: 'draft'` (`src/app/api/classes/route.ts:80`).
- No sweep selects drafts — `class-transitions.ts:64` and `:225` take `'open'`,
  `:513` takes `'in_progress'`.
- No registration can attach to a draft (`registrations/route.ts:131-133`).

It is inert until published, and publishing is what Task 3 guards. Guarding
create would also need a second read for `Teacher.defaultTimezone`, which that
route does not currently take. Task 4 puts a `min` hint on its date input and
says in a comment that there is deliberately no service guard behind it.

---

## 3. Verify, don't assume

The plan cites specific line numbers. They were correct at `411e0c4`. **Run this
before Task 1** and fix anything that has drifted — then report the drift in
your final message, because a drifted reference means someone else's assumption
also aged.

```bash
cd /Users/ivohofland/Projects/fair.yoga
check() { printf '%-56s %s\n' "$1:$2" "$(sed -n "${2}p" "$1" | sed 's/^[[:space:]]*//' | cut -c1-62)"; }

check src/lib/timezone.ts 130
check src/services/class-lifecycle.ts 113
check src/services/class-lifecycle.ts 159
check src/services/class-lifecycle.ts 220
check src/services/class-lifecycle.ts 233
check src/services/class-lifecycle.ts 684
check src/services/class-lifecycle.ts 741
check src/services/class-lifecycle.ts 754
check "src/app/api/classes/[id]/route.ts" 112
check "src/app/api/classes/[id]/transition/route.ts" 129
check src/services/class-lifecycle.test.ts 268
check src/services/class-lifecycle.test.ts 358
check src/services/class-lifecycle.test.ts 496
check src/services/class-lifecycle.test.ts 1259
check src/services/class-lifecycle.test.ts 1793
check tests/integration/full-flow.test.ts 170
check tests/integration/classes-api.test.ts 143
check src/components/class/class-edit-form.tsx 164
check src/services/waitlist-retention.ts 108
```

Expected output, verbatim (truncated at 62 columns by the helper):

```
src/lib/timezone.ts:130                        export function classStartInstant(classDate: Date, startTime:
src/services/class-lifecycle.ts:113            export type TransitionFailureReason =
src/services/class-lifecycle.ts:159            export function sourceStatesFor(to: ClassStatus): ClassStatus[
src/services/class-lifecycle.ts:220            const moved = await db.$transaction(async (tx) => {
src/services/class-lifecycle.ts:233            where: { id: classId, status: { in: sourceStatesFor(targetStat
src/services/class-lifecycle.ts:684            | { ok: false; reason: 'template_date_conflict' };
src/services/class-lifecycle.ts:741            const cls = await db.class.findUnique({ where: { id: classId }
src/services/class-lifecycle.ts:754            if (TERMINAL_CLASS_STATUSES.includes(cls.status)) {
src/app/api/classes/[id]/route.ts:112          const unhandled: never = result;
src/app/api/classes/[id]/transition/route.ts:129 if (!result.ok) return respondError(result.error, result.reaso
src/services/class-lifecycle.test.ts:268       date: new Date('2026-06-05'),
src/services/class-lifecycle.test.ts:358       date: new Date('2026-06-01'),
src/services/class-lifecycle.test.ts:496       it('reports a missing class differently from an illegal transi
src/services/class-lifecycle.test.ts:1259      const FIXTURE_DATE = '2099-06-01';
src/services/class-lifecycle.test.ts:1793      const result = await updateClass(db, 'stub-class', { date: new
tests/integration/full-flow.test.ts:170        date: new Date('2026-07-01'),
tests/integration/classes-api.test.ts:143      const economicsCls = await makeClass('Classes API Lock (unlock
src/components/class/class-edit-form.tsx:164   label="Date"
src/services/waitlist-retention.ts:108         * WHAT IT DOES NOT BUY, said plainly because this docblock is
```

**A worked example of why this block exists.** Writing the plan turned up two
references that would have failed on you rather than on the author:
`class-edit-form.test.tsx` renders with `classId`/`settingsLocked`/`initial` and
has no `defaultProps` (the plan's first draft invented one), and Task 3's
fixtures never needed the `slotTime(makeClassCounter)` helper the first draft
reached for. Both are corrected in the plan you have. The block above is the
same discipline applied to everything else.

### Environment

```bash
docker ps --format '{{.Names}}\t{{.Status}}' | grep fairyoga-db-1
# expect: fairyoga-db-1   Up N days (healthy)

curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health
# expect: 200
```

**If :3000 is not responding, stop and ask.** The user runs that server; it
serves this checkout and the integration project talks to it over HTTP. Do not
start it, do not restart it. Without it you get a wall of `ECONNREFUSED` and
will conclude, wrongly, that you broke something.

---

## 4. Harness differences

You are not running in the harness this plan was written in. Concretely:

- **No skills system, no enforced TDD ordering.** The plan's red-first steps are
  the substitute — run the test and *see it fail* before implementing. A test
  that has never been observed failing proves nothing about the guard.
- **Mutations are deliverables, not private checks.** For each one: apply it,
  run the named test, **copy the exact failure text**, revert, re-run green. The
  texts go in the PR body. A guard nobody has watched fail is a guard nobody
  knows works.
- **Commit per task**, with the message the plan gives. The PR is **rebase-merged,
  never squashed** — the per-task history is the record, so do not amend seven
  tasks into one commit.
- **`AGENTS.md` is not `CLAUDE.md`.** If your harness auto-loads the former, open
  the latter yourself.
- **Stage exact paths.** Never `git add -A` or `git add .`.

---

## 5. Task order, and which parts of it are load-bearing

| Order | Why | Load-bearing? |
|---|---|---|
| 1 before 2 and 3 | Both guards import `startsInPast` | **Yes** — hard dependency |
| 2 before 3 | Task 3's guard comment claims "a class's stored start can never be moved into the past", which is only true once Task 2 has landed. Writing it earlier ships a comment that is false at the moment it is written | **Yes**, for truthfulness rather than compilation |
| 3 Step 1 before 3 Step 2 | Re-date the three aged fixtures *before* writing the failing test. Otherwise four tests go red at once and you cannot tell the intended failure from the collateral | **Yes** — this is signal, and losing it costs an hour |
| 5 after 2 and 3 | It asserts both routes' status codes | **Yes** |
| 6 after 2 and 3 | It documents what they do | Preference — but writing it earlier means writing it twice |
| 4 anywhere | Touches no service | Preference. Doing it last keeps the service work contiguous |

Within Task 2, the guard's **position in `updateClass` is load-bearing** and the
plan's comment explains it: after the terminal early return (so a completed class
still answers `terminal`, which is the older and stronger reason, and #247's two
tests still pass), before the economic check (because this is a whole-request
refusal like `terminal`, where `locked` is field-level).

---

## 6. Stop conditions

**Stop and report — do not work around — if any of these three mutations fails
to turn its named test red.** Each one is load-bearing for a different reason.

| Mutation | Test that must go red | Why this one matters most |
|---|---|---|
| Task 1: replace the body with `return classDate < now;` | `is false for a class still to come in a zone far ahead of UTC` | This is the naive implementation the whole predicate exists to refuse, and it agrees with the correct one at most hours of most days. If the fixture does not catch it, the fixture is wrong and the timezone handling is unverified — a pass here would prove nothing at all. |
| Task 2: make the guard unconditional (drop the `date`/`startTime` gate) | `leaves a non-scheduling edit alone on a class that has already started` | Without the gate you refuse description edits on every class that has started but not yet been swept — up to 60 seconds for *every class in the product*, plus every generator same-day instance. No test outside this one sees it, and no teacher would report it as anything but "the app is broken sometimes". |
| Task 3: drop the `sourceStatesFor(...).includes(cls.status)` conjunct | `reports a missing class differently from an illegal transition` (`:496`) | The only thing standing between this guard and a wrong answer is a test written for #182 that says nothing about this duty. If it does not go red, you have broken an existing contract and the suite is not telling you. |

Also stop and ask if:

- You conclude the branch needs a migration (see D1).
- `npm run verify` fails on something you did not touch.
- `:3000` is not up.
- A line-number check in §3 comes back different **and** the surrounding code has
  changed meaning, not just moved.

---

## 7. Hazards this branch can actually hit

Trimmed from the project's standing list to what is reachable here.

- **Never write "does not close #N"** in a commit message, a PR body, or a
  comment. GitHub's parser matches the keyword and ignores the negation in front
  of it. It has closed an issue in this repository **twice** — the second time
  from a commit written specifically to document the trap, because that commit
  quoted the offending phrase verbatim. Write "**#N is unaffected**". Same for
  `fixes`, `resolves`, `fixed`, `resolved`, `closed`. If you must explain the
  trap, break the token — separate the keyword from the number.
- **Post `gh issue` / `gh pr` prose from a `--body-file`, never `--body "…"`.**
  Backticks inside a double-quoted zsh string are command substitution even when
  escaped, and it fails *silently* — a published comment on this repo lost two
  file paths that way and returned a success URL.
- **Quote paths containing parentheses** when staging: `"src/app/(teacher)/…"`.
  An unquoted glob over one of these silently matches nothing.
- **`@/lib/log` is pino and server-only.** `src/lib/timezone.ts` already imports
  it, so Task 1 adds no new exposure — but do not value-import `timezone.ts`
  into a `'use client'` component. Task 4 touches client components and needs
  none of it.
- **`npm run verify` is a strong signal, not a substitute for CI.** It runs the
  same static gates and the same vitest suite, but CI also runs
  `prisma validate`, a migration-drift check, `npm run build`, and Playwright. A
  build-only defect passes `verify` and fails CI.
- **Never start or restart the dev server on :3000.**

---

## 8. Baseline, done, and the PR body

### Measured baseline

Run on this branch at `411e0c4`, before any implementation. Not inherited from a
previous document — measured.

| Project | Test files | Tests |
|---|---:|---:|
| `unit` | 57 | 848 |
| `components` | 38 | 207 |
| `integration` | 28 | 412 |
| **Total** | **123** | **1467** |

`57 + 38 + 28 = 123` and `848 + 207 + 412 = 1467`, and both totals match a
single `npm test` run (234 s). The arithmetic is shown so you can re-derive it
rather than trust it.

### Predicted after — and measure it anyway

11 new tests, no new test files (every one is appended to a file that exists):
Task 1 adds 3 to `unit`, Task 2 adds 3 to `unit`, Task 3 adds 2 to `unit`,
Task 4 adds 1 to `components`, Task 5 adds 2 to `integration`.

So: `unit` 856, `components` 208, `integration` 414, **total 1478**, files still 123.

**Measure it regardless.** A previous handover on this project predicted 1294 and
the real figure was 1296, because that branch's own review added tests the
prediction could not have known about. Report what you measure, not what this
document predicted, and say so if they differ.

### Runs vs changes — say the right one

`npm run verify` **runs** all 28 integration files. This branch **changes** two:

- `tests/integration/full-flow.test.ts` (one fixture re-dated)
- `tests/integration/classes-api.test.ts` (one fixture added, two tests added)

The PR body must name those two by path and must not imply it touched more. It
*may* say the whole integration suite ran, because it did — show the arithmetic
(`123 = 57 unit + 38 components + 28 integration`) so that is a checkable claim
rather than a reassurance.

### The PR body must record

- What was measured, and that the four premise corrections in spec §1.1 were the
  **issue's** errors, not inherited ones — plus which of the issue's five links
  held (all five did).
- Which claims were the **author's own** errors: the spec's §7 first reported one
  door's blast radius as the branch total, and the create-path harm was first
  described as immediate when a created class is `draft` and never swept. Both
  are corrected in the committed spec; say so rather than quietly shipping the
  fixed version.
- The arithmetic behind every count.
- Every mutation, with the exact error text it produced.
- What this does **not** do: creation stays unbounded (with the reason), the
  generator is untouched, no migration is added, `StudioClass` is out of reach by
  construction, and **#247 is unaffected**.

### Report back to the user

1. The measured after-baseline, per project, with totals that reconcile.
2. Each mutation and its recorded failure text.
3. Any reference from §3 that had drifted, and what it drifted to.
4. Anything in the plan or spec you found to be **wrong** — not just awkward.
   The plan's author would rather hear it than have you bend code to match a
   wrong instruction. Two subagents on previous rounds caught four wrong
   predicted outputs that way.

---

## 9. Final checklist — one line per irreversible mistake

- [ ] No migration was added. (D1)
- [ ] Test `:1793` was repaired by changing its **payload**, not its expectation. (D2)
- [ ] The publish guard **falls through** for a missing or illegally-sourced class, decided with `sourceStatesFor`. (D3)
- [ ] The three aged fixtures were re-dated to 2099; `:502` was left past-dated on purpose. (D4)
- [ ] No service gained a `now?: Date` parameter. (D5)
- [ ] `POST /api/classes` has no service guard. (D6)
- [ ] Every commit staged **exact paths** — no `git add -A`, no `git add .`.
- [ ] Parenthesised paths were quoted when staged.
- [ ] The phrase "does not close #N" appears nowhere. "#247 is unaffected" is the wording.
- [ ] `gh` prose was posted from `--body-file`, never `--body "…"`.
- [ ] The dev server on :3000 was never started or restarted.
- [ ] `npm run verify` is green, and its counts are in the PR body with the arithmetic shown.
- [ ] Each of the three §6 mutations was observed turning its named test red, and the error text was recorded.
