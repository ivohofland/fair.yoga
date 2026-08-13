# Handover: implement the stranded waitlist display plan (#199)

You are picking up #199. It is a small branch — two one-line predicate changes —
with a disproportionate amount of care around the tests, because a test on this
surface can pass for three different wrong reasons. Those three reasons are §5
and §6, and they are why this file is longer than the diff.

**Read in this order, before touching anything:**

1. `CLAUDE.md` — the stack, the data model, the design philosophy. opencode
   auto-loads `AGENTS.md`, which only *links* to `CLAUDE.md`. Read it anyway.
2. `docs/superpowers/specs/2026-08-13-stranded-waitlist-display-design.md` — the
   design. §1 is what the issue got wrong; §2 is the reasoning the whole branch
   rests on; §6 is the test design.
3. `docs/superpowers/plans/2026-08-13-stranded-waitlist-display.md` — the plan
   you execute. Three tasks. Tasks 1 and 2 are full TDD cycles; Task 3 is
   verification.
4. This file.

You are on branch `fix/199-stranded-waitlist-display`, cut from `main`. Every
commit already on it is documentation — the spec, the plan, and this file; no
source file has been touched yet, so `git diff main...HEAD --stat` should show
only `docs/`. `git status` should be clean except for the untracked
`docs/backlog-roadmap.md`, which stays untracked forever.

---

## 1. Orientation

Two server-component Prisma queries read a `WaitlistEntry` and qualify only one
side of the relationship:

- `src/app/(student)/bookings/page.tsx:41` filters the **entry's** status
  (`status: 'waiting'`) and never asks about its class. A student sees "position
  2" on a class that will never take another student.
- `src/app/(teacher)/class/[id]/page.tsx:45` is the class's own page, so the
  class is implied — and it counts **every** entry status. A teacher reads "3 on
  waitlist" for a queue that is empty.

Both fixes are one line. Neither is new policy: `src/services/waitlist.ts`
already refuses a non-`open` class in all four paths that grant or offer a spot
(`addToWaitlist:178`, `promoteNext:391`, `claimSpot:523`,
`handleSpotFreed:635`), while `removeFromWaitlist:319` deliberately omits the
guard so a student can leave a dead queue. The two reads were the only paths
bypassing a rule the write layer states unanimously. Spec §2 has the table.

No service change. No schema change. **No migration** — if you think you need
one, that is a plan defect: stop and report it.

### The one thing most likely to derail you

**The issue asks for the wrong predicate, and the issue is the document you will
find first.** #199's title says *"stranded on cancelled classes"* and its body
proposes:

```ts
class: { status: { not: 'cancelled' } }   // WRONG — do not ship this
```

That predicate leaves the `in_progress` and `completed` rows rendering, which is
the larger population **and the only one still growing**. The shipped predicate
is positive:

```ts
class: { status: 'open' }                 // correct
```

Why the issue got it wrong: it assumed #195 had bounded the population. #195
closed the three exits from `open` to `cancelled`. Nothing closes the queue when
a class leaves `open` by **starting** — that is filed as **#216** and is out of
scope here. So `cancelled` is the case the issue noticed, and `in_progress` /
`completed` are the cases that actually accumulate.

A comment on #199 dated 2026-08-13 records this. If you find yourself
implementing a negative predicate, you are implementing the issue body rather
than the spec.

---

## 2. Before you start — verify, don't assume

Every issue worked in this project has had a premise that was wrong or
incomplete, and every plan has had at least one line reference drift. Four
checks, none longer than a few seconds:

```bash
# 1. The two target lines are still where the plan says.
sed -n '41p' "src/app/(student)/bookings/page.tsx"
sed -n '45p' "src/app/(teacher)/class/[id]/page.tsx"
```

Expected, exactly: `where: { studentId: session.studentId, status: 'waiting' },`
and `_count: { select: { waitlistEntries: true } },`. If either has moved, find
it and use the real line — do not edit by line number alone.

```bash
# 2. The dev database's stranded-row census, which is the issue's own
#    acceptance criterion and should still be zero.
docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga -c \
  "SELECT w.status, c.status, count(*) FROM \"WaitlistEntry\" w
   JOIN \"Class\" c ON c.id = w.\"classId\" GROUP BY 1,2 ORDER BY 3 DESC;"
```

Expected when this file was written: one row, `waiting | open | 4`. A non-`open`
class carrying a `waiting` row means someone has been exercising the app — fine,
but say so in your report, because it changes what "0 stranded" meant.

```bash
# 3. The dev server is up. You need it; you must not start it.
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login
```

Expected `200`. If not, **stop and ask the owner to start it.** See §6.

```bash
# 4. Nothing else reads a waitlist entry unqualified.
grep -rn "waitlistEntry\.\|waitlistEntries" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Expected: the two reads you are fixing, `src/app/(public)/[slug]/page.tsx:71`,
`src/services/gdpr.ts` (several), and service write paths. See §6 on the
`[slug]` one — **it is not a bug and you must not "fix" it.**

---

## 3. You are not running under Claude Code

The plan's header says *"REQUIRED SUB-SKILL: Use
superpowers:subagent-driven-development"*. That is written for the harness the
plan was authored in. **Superpowers is not installed for opencode here**, so you
have no `superpowers:*` skills.

**What to do instead:** execute the plan yourself, task by task, in order. Each
task carries the full TDD cycle as explicit steps — write the failing test, run
it and watch it fail, implement, run it and watch it pass, run the mutations,
commit. Follow them literally. That is all the missing skill would have given
you.

**No `/pr-review-toolkit:review-pr`.** Finish the three tasks, push, open the
PR, then **stop and hand back** — the owner runs the multi-agent review in the
other harness.

---

## 4. Task order, and what is actually independent

Unlike most branches here, **the order is mandatory**: Task 2 appends to the test
file Task 1 creates and reuses its fixture graph (`makeClass`, `makeStudent`,
`teacherId`, `teacherRoomId`, `teacherToken`, `classIds`). Task 2 cannot be done
first without inventing that setup twice.

| # | Task | Notes |
|---|---|---|
| 1 | `/bookings` predicate + its test | Creates `tests/integration/waitlist-display.test.ts`. Two mutations. |
| 2 | Teacher count predicate + its test | Extends Task 1's `beforeAll` and appends a `describe`. One mutation. |
| 3 | Whole-branch verification, push, PR | `npm run verify`, the read-surface sweep, then push and open the PR. |

The two *source* edits are genuinely independent of each other — if Task 2's
test proves impossible for a reason you can articulate, Task 1 still ships on
its own. Report the block; do not work around it silently.

---

## 5. The stop condition that matters most

**Both tests must fail before their fix, for the stated reason.** A page test on
this surface can go green for three wrong reasons, and each has a distinct
signature:

1. **The session did not resolve**, so `/bookings` redirected to `/login`. Every
   `not.toContain` then passes trivially. Task 1's test guards this with
   `expect(html).toContain(openType)` *before* the absences — if that assertion
   is the one failing, your fixture or session is broken, not the predicate.
2. **The scheduler rewrote a fixture's status.** See §6 — this is the subtle one,
   and it makes the test pass from a status the fixture never intended.
3. **The assertion cannot see the text it is asserting on** because of React's
   SSR comment splicing. See §6. This one fails *green code*, so you will notice
   — but you may misdiagnose it as the predicate being wrong.

**If a test passes before you implement its fix, stop and report it. Do not
adjust the assertion until it goes red. Do not decide it is close enough.**

### The mutations are the deliverable, not busywork

Seven distinct mutations across the branch as merged — three specified up front,
one added by the branch's own review (spec §6.2), and three more by the
multi-agent PR review, which also found the planned count fix was half a fix
(spec §3.3). The plan below specifies the first four; the PR body records all
seven with their failure text. The second one in Task 1 is the point of the
whole test design:

| Task | Mutation | Must fail on |
|---|---|---|
| 1 | Delete `class: { status: 'open' }` | all three dead class types appearing |
| 1 | **Weaken to `class: { status: { not: 'cancelled' } }`** | `in_progress` and `completed` appearing, while `cancelled` still passes |
| 2 | Delete the `_count` `where` | `1 on waitlist` absent; `3 on waitlist` present |
| 2 | **Weaken the `_count` to `status: { not: 'removed' }`** | `2 on waitlist` rendered — added in review, because the original `1 waiting + 2 removed` fixture rendered `1` under this mutation and passed it |

That middle one is not hypothetical — it is what the issue asked for. A test
whose only dead fixture were a `cancelled` class would pass against it, which is
why the fixture carries `in_progress` and `completed` too. This project shipped
three guards on #39 that existed and could not fail; recording each mutation's
exact failure text in the commit message is how that stops repeating.

Restore after every mutation and re-run to confirm green before moving on.

---

## 6. Hazards that have actually bitten this project

- **The in-process scheduler is RUNNING against the dev database.**
  `src/instrumentation.ts` starts it when the Node server boots; `CRON_SCHEDULER`
  is unset in `.env` (CI sets it `off`). class-transitions sweeps every minute.
  Two of its sweeps will rewrite your fixtures if you let them:
  `autoTransitionToInProgress` takes `open` classes with `date: { lte: now +
  24h }`, and `autoCompleteClasses` takes **every** `in_progress` class with no
  date filter at all, completing those whose computed end instant has passed.
  **Every fixture class is dated `2099-06-01` for this reason.** Do not
  "modernise" the dates. A present-dated `in_progress` fixture gets completed
  underneath the assertion and the test still passes — from a status you never
  set. That is #138's failure mode: a check that runs when both paths agree.
- **React's SSR splices `<!-- -->` around a dynamic text node beside a static
  one.** `src/components/class/class-info.tsx:35` is
  `{waitlistCount} on waitlist`, so the raw HTML reads `1<!-- --> on waitlist`
  and a plain `toContain('1 on waitlist')` **fails against correct output**. Task
  2's test strips the markers first. `tests/integration/privacy-page.test.ts`
  uses plain `toContain` and needs no such step only because the page it checks
  builds its name as a single template string (`privacy/page.tsx:137`) — the
  precedent does not transfer.
- **`Class` carries a partial unique index Prisma cannot express:**
  `Class_teacher_slot_unique` on `(teacherId, date, startTime) WHERE status <>
  'cancelled'` (#196, documented at `prisma/schema.prisma:378-382`). Fixture
  classes for one teacher on one date need distinct `startTime`s. The plan's
  `slot(n)` helper handles it; if you add a class, give it its own index.
- **You cannot build these fixtures through the service layer.**
  `addToWaitlist` throws `WaitlistJoinError` on a non-`open` class
  (`waitlist.ts:178`) — that is the invariant these tests check the *reads*
  against. Use `prisma.waitlistEntry.create` directly. If you find yourself
  reaching for the service to "do it properly", you have inverted the test.
- **zsh globs `[`, `]`, `(`, `)`.** Both files you edit have parentheses in their
  paths, and one has brackets. An unquoted path in `grep`/`git add` either errors
  (`no matches found`) or silently matches nothing. Quote every path containing
  brackets or parentheses, including `--include="*.ts"` on `grep -r`.
- **Never write a GitHub closing keyword immediately before a `#N` reference in a
  commit message**, in any grammatical role — including as a noun, and including
  with a colon between. A commit body reading *"the class-template **fix:
  #196**'s partial unique index"* closed #196 by accident. The words are `fix`,
  `fixes`, `fixed`, `close`, `closes`, `closed`, `resolve`, `resolves`,
  `resolved`. Write "for #199" or "#216 is unaffected". Only the PR body may
  deliberately close #199.
- **Never edit an applied migration.** No migration belongs in this branch at
  all.
- **Do not fix things you notice in passing.** Three specifically:
  - `src/app/(public)/[slug]/page.tsx:71` has the same unqualified
    `status: 'waiting'` query and is **not** a bug — its outer `class.findMany`
    at line 48 is already scoped to `status: 'open', date: { gte: today }`, so
    every id it can match is live. Safe by containment. Adding a redundant
    predicate there would need its own test to be worth anything. Leave it. If
    you think the containment argument is wrong, **report that** — it is a spec
    claim (§4) and worth more as a correction than as a quiet edit.
  - **#216** — nothing closes the queue when a class starts. Filed, with an open
    decision on `removed` vs `expired`, and sequenced after #182. Leave it
    entirely.
  - The `expired` value in `WaitlistStatus` is written by nothing in the
    codebase. That is #216's business, not this branch's.

  If you find a *fourth* thing, write it in your report; do not fix it.

---

## 7. Running the tests

```bash
npx vitest run --project integration tests/integration/waitlist-display.test.ts   # the fast loop
npm run verify                                                                     # typecheck + lint + all three projects
```

`npm run verify` needs the app on :3000.

### Expected counts

**Baseline, measured by `npm run verify` on this branch immediately before this
file was written, with no source changes yet:**

```
Test Files  112 passed (112)
Tests       1292 passed | 2 todo (1294)
Duration    129.76s
```

Which splits, so the total is checkable rather than a number to trust:

```
files:  48 unit + 37 components + 27 integration = 112 ✓
tests: 702 unit + 202 components + 388 integration = 1292 ✓
```

`unit` (48 / 702 + 2 todo) and `components` (37 / 202) were measured directly for
this handover; `integration` is the remainder and reconciles exactly against the
full-suite total. **Both todos live in `unit`** — if `integration` or
`components` ever reports one, something was skipped.

Two minutes is the normal duration for the full run. It is not hung.

This branch adds **2 tests in 1 new file**, so a correct finish is:

```
Test Files  113 passed (113)
Tests       1294 passed | 2 todo (1296)

files:  48 unit + 37 components + 28 integration = 113 ✓
tests: 702 unit + 202 components + 390 integration = 1294 ✓
```

Anything lower means a test was deleted or renamed — say so explicitly rather
than letting the total pass as normal. **State this arithmetic in the PR body
after your own run.** `npm run verify` runs all three projects, so a green
`verify` *is* the whole integration suite; that turns "every integration file
ran" from a reassurance into a claim a reviewer can re-derive.

Green `verify` is a strong signal but **not** a substitute for CI: CI also runs
`prisma validate`, a migration-drift check, `npm run build`, and Playwright. A
build-only defect passes `verify` and fails CI.

### Alarming output that is not a failure

- **`ECONNREFUSED` across the integration project** means the dev server is
  down. Stop and report; do not start one.
- **`error` level pino lines are expected** — several tests deliberately drive
  failure paths. These all appeared in the clean baseline run above and none is a
  failure: `email fallback send failed` (`reason: "boom"`), `socket hang up`,
  `failed to release email-fallback claim (will not retry)`, `failed to claim
  notification for email fallback`, `test-job sweep failed` (`boom-alpha`,
  `boom-gamma`), `class generation could not fill every date in the window`,
  `invalid timezone, falling back to UTC`. **Judge by vitest's summary line, not
  by log noise.**
- **Postgres `40P01` deadlock output** is a documented, classified condition on
  this schema (`docs/lock-order.md`). If it appears in a *new* place, report it.

---

## 8. What done looks like

1. Two source lines changed, in exactly the two files named in §1. Nothing else
   in `src/` touched.
2. `tests/integration/waitlist-display.test.ts` created, 2 tests, both passing.
3. All mutations run, restored, and each failure's exact text recorded in
   the relevant commit message.
4. `npm run verify` green, with the arithmetic stated
   (`113 files = 48 unit + 37 components + 28 integration`; `1294 tests = 702 +
   202 + 390`), not just asserted.
5. `git diff main...HEAD --name-only` reconciled against the plan's File
   Structure table — three files, plus the `docs/` files already committed. A
   fourth source file in that list needs explaining.
6. `docs/backlog-roadmap.md` **untouched and still untracked.** It carries a
   stale claim about this issue at `:2176-2179`, and correcting it is the
   owner's job in the closing stage — not yours. Do not edit it, do not
   `git add` it, and do not read its wording as authority on this branch.
7. `git log main..HEAD --format=%B | grep -inE '(clos|fix|resolv)[a-z]*[[:space:]:]+#[0-9]+'`
   — **then read what it prints.** A previous branch ran this exact grep, it
   printed the offending line, and the output was misread as clean.
8. PR pushed and opened. Then **stop** — the owner runs the review.

### The PR body must record

- The `verify` arithmetic, before and after.
- Every mutation and its failure text.
- `tests/integration/waitlist-display.test.ts` named by path as the integration
  file this branch touches.
- What the PR does **not** do: it does not close the queue when a class starts,
  does not touch the notification layer, and adds no migration. Write
  "**#216 is unaffected**" — never "does not close #216", which closes it.
- Which inherited claims you checked and which held. Two in #199 were false (the
  predicate and the bound); the third — that `/bookings` filters entry status and
  not class status — was true.

### What to report when you hand back

- Which tasks completed, which blocked, and why.
- Every mutation with its recorded failure text.
- The `verify` arithmetic, before and after.
- **Anything in the plan that turned out to be wrong.** Four task briefs on an
  earlier branch were wrong about the state of the code, and every one was caught
  by an implementer checking rather than complying. Surfacing a plan defect is
  worth more than working around it — say so plainly rather than quietly
  adapting.
- Anything you noticed and deliberately did not fix.

---

## 9. Final checklist

- [ ] On `fix/199-stranded-waitlist-display`; clean but for the untracked roadmap
- [ ] `CLAUDE.md` read; the spec read; §2's four checks run
- [ ] The predicate shipped is `class: { status: 'open' }`, **not** `not: 'cancelled'`
- [ ] Neither test was accepted while it passed before its fix
- [ ] Every mutation run, restored, and recorded
- [ ] Fixture classes still dated 2099; no fixture built via `addToWaitlist`
- [ ] `src/app/(public)/[slug]/page.tsx` untouched
- [ ] No migration; `prisma/schema.prisma` untouched
- [ ] No commit message puts a closing keyword before a `#N`
- [ ] `docs/backlog-roadmap.md` untouched and still untracked
- [ ] `npm run verify` green at 113 files / 1294 passed / 2 todo, up from 112 / 1292 / 2
- [ ] PR opened; handed back without running the review
