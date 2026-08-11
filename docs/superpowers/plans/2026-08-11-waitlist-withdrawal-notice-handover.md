# Handover: implement the waitlist withdrawal notice plan (#112)

**You are implementing an already-approved plan.** The design decisions are
made, the reachability argument is settled, the tests are written out for you.
Your job is to execute it faithfully — not to redesign it, improve it, or extend
it.

Read this whole file before you touch anything. It exists because this change
sits next to a statement that **must not be modified**, and the obvious way to
"do it properly" would reintroduce a race that a previous issue was opened to
close.

---

## 1. Orientation

| | |
|---|---|
| Working directory | `/Users/ivohofland/Projects/fair.yoga/.claude/worktrees/fix+112-archive-waitlist` |
| **Not** this one | `/Users/ivohofland/Projects/fair.yoga` — that is the main checkout, on a different branch. Do not work there. |
| Branch | `fix/112-archive-waitlist` — already created, already has 6 commits: the spec (and three rounds of corrections to it), the plan, and this handover. No source file has been touched yet. |
| Your plan | `docs/superpowers/plans/2026-08-11-waitlist-withdrawal-notice.md` |
| The reasoning behind it | `docs/superpowers/specs/2026-08-11-waitlist-withdrawal-notice-design.md` |
| Project rules | `CLAUDE.md` in the repo root — read it, it is short and it overrides your defaults |

This is a **git worktree**, not a clone. It has its own `.env` and its own
`node_modules` (both verified present). Run every command from the worktree
path above.

**One GitHub issue is being closed: #112 — "Archiving deletes classes with
waiting students, and tells nobody."**

A student sitting in a waitlist queue is never told when their class stops being
offered. Measurement widened this from one path to three:

- **Archive** (`class-template-lifecycle.ts`) — the queue is *cascade-deleted*
  along with the class, silently. This is the one the issue reported.
- **Auto-cancel** (`class-transitions.ts`) — the class is cancelled, the queue is
  left pointing at it, nobody is told. The issue cited this function as the
  example of getting it *right*; it has the same bug.
- **Teacher account erasure** (`gdpr.ts`) — the queue is closed correctly
  already, but the students are not told.

**Six tasks. Work through them in order, committing after each.** Do not start
Task 2 until Task 1 is committed.

---

## 2. Before you start

Confirm the environment. Run these and check the output against what is stated —
every number and string below was measured on this branch immediately before
this file was written, not assumed.

```bash
cd /Users/ivohofland/Projects/fair.yoga/.claude/worktrees/fix+112-archive-waitlist
git branch --show-current      # must print: fix/112-archive-waitlist
git status --short             # must print NOTHING — the tree is clean
docker ps --format '{{.Names}}' | grep fairyoga-db    # must print: fairyoga-db-1
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:3000/
```

- **The database container must be up.** Both the `unit` and `integration` test
  projects talk to a real PostgreSQL — unit tests are not pure functions here.
  Expect `fairyoga-db-1`. If `docker ps` shows nothing, stop and ask.
- **Databases:** dev is `ethical_yoga`, tests use `ethical_yoga_test`, user
  `yoga`. The unit project prints `[unit-db] unit tests run against
  ethical_yoga_test` when it starts — that line is your confirmation that your
  fixtures are not touching dev data.
- **The app on :3000 must be up.** The `curl` prints **`307`** on a healthy
  server (`/` redirects with no session cookie). Any 2xx/3xx means up. `000`, a
  timeout, or `ECONNREFUSED` in test output means down: **stop and ask the human
  to start it.** Never start it yourself — see §3.6.
- **Known and fine:** the process on :3000 serves the *main* checkout
  (`/Users/ivohofland/Projects/fair.yoga`), which is on a different branch — not
  this worktree. That is not a problem for this issue and it is not something to
  fix. `npm run verify` was run from this worktree against that server and came
  back fully green, because #112 changes no API route and no page. Do not try to
  point the server at this worktree.
- If `git status` shows anything at all, stop and ask.

---

## 3. Rules that override your instincts

These are the things you are most likely to get wrong. Each one is a real
failure mode on this project.

### 3.1 The archive `deleteMany` must not be modified. At all.

In `src/services/class-template-lifecycle.ts:693`:

```ts
const { count: deleted } = await tx.class.deleteMany({
  where: {
    ...scheduledWhere(templateId, { gt: today }),
    registrations: { none: { status: { in: [...CHARGED_STATUSES] } } },
  },
});
```

Task 4 asks you to notify the students waiting on the classes this statement
removes. The natural way to write that is to read the rows first, keep their
ids, delete by id, and notify from what you read. **Do not do this.** There is a
twelve-line comment directly above the statement (`:683-692`) forbidding exactly
that, ending with *"Do not 'optimise' this back into a read-then-delete."*

Why: passing the predicate straight to `deleteMany` makes PostgreSQL re-evaluate
it at execution time. A registration that commits between a read and a delete
would be invisible to a delete keyed on already-read ids — and the class would
be destroyed, cascading away a registration a student owes money for. The
single statement is the only thing preventing that.

The plan's design works *around* the statement, never through it: read candidates
before it, read survivors after it, notify the difference. Both reads are new
code on either side; the statement itself keeps every character.

**Check before committing Task 4:**

```bash
git diff main -- src/services/class-template-lifecycle.ts | grep -n "deleteMany" -B6 -A6
```

`deleteMany` and its comment must appear only as context lines, never with a
leading `+` or `-`.

### 3.2 A waiting entry does not spare a class from deletion

Reading the issue title, the intuitive fix is: "if a student is waiting, don't
delete the class." **That is explicitly out of scope and it must not be
implemented.**

Issue #86 drew this line deliberately: before a booking, a class instance is an
*offer* the template made; after a booking, it is a commitment. Joining a queue
is not a booking, so a waiting student sits on the offer side — the same side as
a cancelled registration. Reopening that means reopening #86's whole design.

What #86 got wrong was one sentence, not the rule: it justified the deletion
with *"nobody is affected and nothing is owed"*, using the money test to answer
the who-is-affected question. Nothing is owed by a waiting student. They are
still affected.

**You are fixing the silence, not the deletion.** If you find yourself adding
`waitlistEntries: { none: … }` to any delete predicate, stop.

### 3.3 Teacher erasure is already half-fixed — do not add what exists

`src/services/gdpr.ts:736` already runs:

```ts
await tx.waitlistEntry.updateMany({
  where: { classId: cls.id, status: 'waiting' },
  data: { status: 'removed' },
});
```

The queue is closed correctly on this path today. Task 3 adds **only** the
notification, plus one guard fix. Do not add a second `updateMany`. The plan
restructures the existing one into read-then-update, because `updateMany`
returns a count rather than rows and the recipient list has to be taken first.

Also on that path: **the CAS-refused `continue` branch at `gdpr.ts:704-734` stays
exactly as it is.** It deliberately skips the waitlist sweep and logs the
residual it accepts as `waitingEntriesLeft`. It looks like an oversight — a
`waiting` entry left on a class nobody can promote from. It is not: a
half-applied skip would tell a student their class was cancelled after
`completeClass` had already asked them to pay for it, and an existing test pins
that. Do not "finish" it.

### 3.4 Four things nearby that stay untouched

- **`src/services/template-sync.ts`.** It deletes classes too, and it does not
  notify. It is provably unreachable with a queue: joining a waitlist requires
  the class to be full, being full requires at least one registration
  (`maxStudents >= 1`), and one registration latches `settingsLocked: true`
  one-way — while `template-sync.ts:58` only deletes rows where
  `settingsLocked` is false. Adding notification there is dead code.
- **`src/services/studio-class-template-lifecycle.ts`.** It has a near-identical
  archive with a near-identical `deleteMany`. `StudioClass` has no registrations
  and no waitlist — it is a pure calendar and income record. There is nothing to
  notify. Symmetry is not a reason.
- **The archive confirmation copy.** It stays *"3 classes withdrawn"*. Do not add
  a withdrawn-waiters count to `ArchiveTemplateResult`, to the API response, or
  to the button copy. A second persisted count needs a migration and can drift
  from what the transaction actually did — the exact failure #97 and #111 were
  opened to remove.
- **The erasure's registration-status filter.** `gdpr.ts:757` reads
  `status: 'registered'` only, deliberately narrower than its sibling site's
  `registered`/`attended`/`no_show`. The comment above it calls widening that *"a
  product decision, not a lock-discipline fix"*. That decision is still deferred.
  You are adding waiting students; you are not touching which registration
  statuses are included.

### 3.5 The mutation steps are the deliverable, not busywork

The plan contains **eight** mutations: break the guard, run the test, record the
exact failure, restore, re-verify. They are listed in Task 6's ledger.

**Do all of them. Do not skip any. Do not substitute reasoning for running them.**

A test that has never been observed to fail proves nothing. This project has
shipped tests that passed against the bug they were written to catch, and
type-level assertions that compiled cleanly whether the code was right or wrong.

For each mutation:

1. Make the change.
2. Run the test command the plan names.
3. **Copy the actual error text into your report**, including the numbers
   ("expected 1 to be 0"). Paraphrasing does not count.
4. Undo the change.
5. Re-run and confirm green.
6. Confirm `git diff` is clean before committing.

**Three of these mutations deserve special attention:**

- **Task 1's FK mutation runs against the database, not the code.** It alters
  `WaitlistEntry_classId_fkey` on `ethical_yoga_test` to `ON DELETE RESTRICT`.
  **You must restore it**, including `ON UPDATE CASCADE`, which the constraint
  carries today and which a careless restore would silently drop. A test
  database left on `RESTRICT` breaks unrelated tests on later runs, and the
  failure will not look like it came from you. The exact expected definition is
  in the plan; verify it reads back correctly before moving on.
- **Task 5's mutation must be run against Task 4's tests too.** Set
  `withdrawn = candidates` and confirm that the concurrency test fails *while
  Task 4's two archive tests stay green*. That contrast is the entire argument
  for why the concurrency test exists. Report both halves.
- **Task 3's guard mutation** (`recipients.length` back to
  `registrations.length`) must fail. If it does not, your fixture has a
  registered student in it and is not the queue-only class the plan calls for.

If a mutation does **not** cause a failure, that is an important finding. Write
it down and flag it — see §6.

### 3.6 Never start, restart, or stop the dev server

The human runs the app on port 3000. Do not run `npm run dev`, do not kill the
process, do not run `next dev`. If it seems broken or stale, **stop and ask.**

### 3.7 Git rules

- **Never `git add -A` or `git add .`** Stage the exact file paths the plan lists.
- **Quote any path containing parentheses.** This repo has directories named
  `(public)`, `(teacher)`, `(student)`. Unquoted, your shell silently matches
  nothing and the file is not staged. No task in this plan touches such a path,
  but the habit matters if you go looking.
- **Commit after every task**, with the message the plan gives.
- **Do not push. Do not open a pull request. Do not rebase or merge.** The human
  does that.
- **Never modify `docs/backlog-roadmap.md`.** It is deliberately untracked and it
  does not exist in this worktree.
- Do not amend, reword, or drop the commits already on this branch.

### 3.8 TypeScript rules

- `strict: true` and `noUncheckedIndexedAccess` are on.
- **No `any`. No `@ts-ignore`. No `@ts-expect-error`. No casts to silence an
  error.** The one cast in the plan (Task 5's `as unknown as typeof prisma`) is
  copied from an existing test at `class-template-lifecycle.test.ts:224` and is
  explained in the comment there — the extended client lacks `$on`, so it is not
  assignable to a `PrismaClient` parameter. That is the only cast. If the
  compiler complains elsewhere and you cannot fix it honestly, stop and ask.
- Indexing an array gives `T | undefined`. Prefer `.map()`, `.filter()` or
  iteration over `arr[0]!`.
- Do not add or change any npm dependency.
- Two new imports are needed and both are safe:
  `createBulkNotifications` / `CreateNotificationInput` from `./notifications`,
  and `formatDateShort` from `@/lib/format`. **`@/lib/format` is safe because its
  only import is `import type { PaymentStatus }`, which erases completely.** Do
  not import `@/lib/log` into anything new — it is pino and server-only.

### 3.9 Do not fix things you notice in passing

You will see other things that look wrong. Leave them. Write them at the end of
your report under "Noticed but not touched". A branch that fixes five unrelated
things cannot be reviewed.

---

## 4. Running the tests

There are three test projects with different file patterns. Using the wrong one
silently runs zero tests and prints a pass, which looks like success.

**Everything in this plan is in the `unit` project.** No integration test, no
component test.

| File you changed | Command |
|---|---|
| `src/services/class-transitions.test.ts` | `npx vitest run --project unit src/services/class-transitions.test.ts` |
| `src/services/gdpr.test.ts` | `npx vitest run --project unit src/services/gdpr.test.ts` |
| `src/services/class-template-lifecycle.test.ts` | `npx vitest run --project unit src/services/class-template-lifecycle.test.ts` |

A single test by name: append `-t 'part of the test name'`.

Typecheck: `npx tsc --noEmit`
Lint: `npm run lint`
Everything: `npm run verify` (typecheck + lint + all three projects) — needs :3000 live, takes ~110s.

**Always read vitest's summary line.** `Test Files 0 passed (0)` means your
filter matched nothing — that is a failure, not a pass.

### Expected test counts

Measured on this branch before you started. Use them as a mechanical check:
after each task the count should be exactly what this table says. Too low means
a test you wrote is not running; too high means you added something the plan did
not ask for.

| File | Now | After T1 | T2 | T3 | T4 | T5 |
|---|---|---|---|---|---|---|
| `class-transitions.test.ts` | 11 | 11 | **12** | 12 | 12 | 12 |
| `gdpr.test.ts` | 15 (+2 todo) | 15 | 15 | **16** | 16 | 16 |
| `class-template-lifecycle.test.ts` | 40 | **41** | 41 | 41 | **43** | **44** |

Task 4 adds two tests, not one — the notify case and the spared case. Task 6
adds no tests; it writes a markdown ledger.

Do not count tests by grepping for `it(`. On this project that has produced
wrong numbers repeatedly. Read vitest's own summary line.

### The whole suite, before and after

`npm run verify` was run from this worktree immediately before handover, and was
**fully green** — typecheck clean, lint clean:

```
Test Files  105 passed (105)
     Tests  1123 passed | 2 todo (1125)
  Duration  106.31s
```

**You are adding 6 tests and no new test files.** So when you are done,
`npm run verify` must report:

```
Test Files  105 passed (105)
     Tests  1129 passed | 2 todo (1131)
```

If the file count changed, you created a test file the plan did not ask for. If
the test count is below 1129, something you wrote is not running.

**Any failure you see is yours.** The suite was green before you started, so do
not attribute a red test to a pre-existing problem without evidence.

### Alarming log output that is not a failure

The suite prints a lot of JSON to stdout, including lines that look like crashes:

```
{"level":50, … "message":"boom-alpha" … "msg":"test-job sweep failed"}
{"level":50, … "reason":"boom","msg":"email fallback send failed"}
{"level":40, … "timeZone":"Not/AZone","msg":"invalid timezone, falling back to UTC"}
```

**These are deliberate.** Tests that verify error handling have to *cause*
errors, and the logger writes them out. `level:50` is pino's "error" level, not
a test result. Ignore all of it and read only vitest's summary lines.

---

## 5. The task loop

For each of the six tasks in the plan:

1. Read the whole task before editing anything.
2. Write the test exactly as given. Do not simplify it or drop assertions.
3. **Run it and watch it fail.** Confirm it fails for the reason the plan
   predicts. If it fails for a different reason, stop and ask.
4. Make the implementation change exactly as given, **including the comments**.
   The long explanatory comments are part of the deliverable; this codebase
   records *why* beside the code on purpose, and the reviewers check for it.
5. Run the test again and watch it pass.
6. Do the task's mutation steps (§3.5).
7. `npx tsc --noEmit` and `npm run lint` — both clean.
8. Stage the exact paths and commit with the given message.
9. Move to the next task.

**Three tasks start green rather than red, and that is correct:** Task 1's
cascade pin, Task 5's concurrency test, and one assertion inside Task 3 all pin
behaviour that already works. For those, the mutation step is the whole point —
it is what turns a passing test into evidence. Do not "fix" them to fail first.

**Order matters in one place:** Task 5 tests the survivor filter that Task 4
introduces. It cannot be written first. Tasks 1, 2 and 3 are independent of each
other and of Task 4.

---

## 6. When to stop and ask

Stop, do not improvise, and report, if any of these happen:

- A test fails for a different reason than the plan predicted.
- A mutation you were told to make **does not** break any test. Especially Task
  5's — if `withdrawn = candidates` leaves the concurrency test green, the
  interposition never fired and the test is proving nothing. Do not paper over
  it; report it.
- Task 5's `expect(raced).toBe(true)` fails. That means the `$extends` hook did
  not intercept the read inside the transaction. Report it rather than
  restructuring the test — it would change what the test proves.
- `npx tsc --noEmit` reports an error you can only silence with `any` or an
  ignore comment.
- The app on :3000 is down, or integration tests give `ECONNREFUSED`.
- You cannot restore the FK constraint in Task 1. **This one is urgent** — say so
  immediately rather than continuing; every later unit run is affected.
- The plan asks for something that contradicts the code you actually see.
- You believe a plan step is wrong. **Say so rather than quietly bending the code
  to match it.** Plan defects found this way have been valuable on this project
  several times — an implementer who reports "your predicted output is wrong" is
  doing the job correctly. The line numbers in the plan were verified on this
  branch, but code moves.
- You are tempted to do something §3 forbids.

Asking is cheap. A branch that silently deviated from the plan is expensive,
because the review will not know which deviations were deliberate.

---

## 7. What to report when you finish

Write your report as a message to the human — do **not** add it to the repo as a
file. (Task 6's mutation ledger *is* a repo file; that one is committed. The
report is not.) Cover:

1. **Per task:** what you changed, which test command you ran, and the pass/fail
   counts. Actual numbers, not "tests pass".
2. **Every mutation:** what you broke, the **exact error text** you saw, and
   confirmation you restored it. All eight, in one list.
3. **Task 5 specifically:** state plainly whether Task 4's two archive tests
   stayed green under the `withdrawn = candidates` mutation. If they did, that is
   the expected and desired result — it is the evidence that ordinary tests
   cannot see this defect. Say it explicitly either way.
4. **The FK constraint:** paste the `\d "WaitlistEntry"` line for
   `WaitlistEntry_classId_fkey` as it reads *after* you finished, so the human
   can see it was restored to `ON UPDATE CASCADE ON DELETE CASCADE`.
5. **`npm run verify` output** — the final summary lines for typecheck, lint, and
   the test totals.
6. **Anything that did not go to plan** — a step that failed unexpectedly, a
   prediction that turned out wrong, a mutation that did not bite, a line number
   that had moved.
7. **Noticed but not touched** — anything that looked wrong that you correctly
   left alone.

Be accurate over reassuring. If something is half-done, say it is half-done. If
you skipped a step, say which and why. A report that says "all tests pass" when
one project ran zero tests is worse than no report.

---

## 8. Final checklist

Before you say you are done:

- [ ] All six tasks committed, one commit each, in order, on
      `fix/112-archive-waitlist`.
- [ ] `npm run verify` reports exactly `Test Files 105 passed (105)` and
      `Tests 1129 passed | 2 todo (1131)`. Any other numbers need explaining in
      your report — do not round, do not say "all green" without the figures.
- [ ] `git diff main -- src/services/class-template-lifecycle.ts` shows the
      `deleteMany` at `:693` and its comment block **only as context**, never as
      `+`/`-` lines (§3.1).
- [ ] No delete predicate anywhere gained a waitlist condition (§3.2).
- [ ] `git diff main --stat` touches **none** of:
      `src/services/template-sync.ts`,
      `src/services/studio-class-template-lifecycle.ts`,
      `src/services/studio-class-generator.ts`,
      `src/components/settings/`.
- [ ] `gdpr.ts` has exactly **one** `waitlistEntry.updateMany` in
      `deleteTeacherAccount`, not two (§3.3).
- [ ] The FK on `ethical_yoga_test` reads
      `ON UPDATE CASCADE ON DELETE CASCADE` (§3.5).
- [ ] `git diff` is empty — every mutation restored.
- [ ] `git status --short` shows nothing untracked that you did not intend.
- [ ] Nothing pushed, no PR opened, no rebase performed.
- [ ] Your report includes the exact error text from all eight mutations.
