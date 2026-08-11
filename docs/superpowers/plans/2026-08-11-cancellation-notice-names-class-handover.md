# Handover: implement the cancellation-notice plan (#200)

**You are implementing an already-approved plan.** The design decisions are
made, the copy is fixed, the tests are written out for you. Your job is to
execute it faithfully — not to redesign it, improve it, or extend it.

Read this whole file before you touch anything. It is short, and the one thing
it exists to tell you is in §2: **you are working in the checkout the running
app serves**, which is different from how the last two issues on this project
were handed over, and it changes what a green test means.

---

## 1. Orientation

| | |
|---|---|
| Working directory | `/Users/ivohofland/Projects/fair.yoga` — the main checkout. **Not a worktree.** |
| Branch | `fix/200-cancellation-notice-names-class` — already created, already has 2 commits (spec, plan). No source file touched yet. |
| Your plan | `docs/superpowers/plans/2026-08-11-cancellation-notice-names-class.md` |
| The reasoning behind it | `docs/superpowers/specs/2026-08-11-cancellation-notice-names-class-design.md` |
| Project rules | `CLAUDE.md` in the repo root — read it, it is short and it overrides your defaults |

**One GitHub issue is being closed: #200 — "Manual class cancellation is the one
notice that still does not name the class."**

#112 (PR #195) established a rule — a cancellation notice names the class in
full, type/day/time, because the student usually has nothing else to identify it
by — and applied it to three of five `class_cancelled` bodies. Two were left
behind:

- `src/app/api/classes/[id]/transition/route.ts:63` — the **student** notice a
  teacher's own manual cancellation sends. This is the site #200 names.
- `src/services/class-transitions.ts:360` — the **teacher** notice auto-cancel
  sends. Found while verifying #200's premise; #200's text does not mention it,
  the spec explains why it was missed, and it is in scope.

**Three tasks. Tasks 1 and 2 are independent** — different files, different test
projects — so either order is fine. Task 3 is last. Commit after each.

---

## 2. Before you start — and why the environment is the point this time

```bash
cd /Users/ivohofland/Projects/fair.yoga
git branch --show-current      # must print: fix/200-cancellation-notice-names-class
git status --short             # must print ONLY: ?? docs/backlog-roadmap.md
docker ps --format '{{.Names}}' | grep fairyoga-db    # must print: fairyoga-db-1
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:3000/
```

Everything below was measured immediately before this file was written, not
assumed.

- **The app on :3000 is `next dev`, serving THIS checkout, on THIS branch.**
  Verified: the listener's parent process is
  `node …/node_modules/.bin/next dev`, and its cwd is
  `/Users/ivohofland/Projects/fair.yoga`. That means **your edits to the route
  are picked up by hot reload**, and the integration test in Task 2 exercises
  the code you just wrote.

  This is the whole reason #200 is workable now. It was filed rather than fixed
  during #195 precisely because that work happened in a git worktree while
  :3000 served a different checkout, so a route-level test would have asserted
  against code the running app did not have. That worktree is gone. Do not
  recreate one for this issue — you would reintroduce the blocker.

- **The consequence you must respect:** after every edit to
  `transition/route.ts`, **save and let the dev server recompile before
  re-running the integration test.** That suite talks to the running app over
  HTTP, not to the source on disk. A mutation that appears to "pass" without a
  recompile means the old bundle answered — a green that proves nothing, which
  is the exact failure this project keeps rediscovering. Watch the dev server's
  terminal output, or simply re-run once more if a result surprises you.

- **The `curl` prints `307`** on a healthy server (`/` redirects with no session
  cookie). Any 2xx/3xx means up. `000`, a timeout, or `ECONNREFUSED` in test
  output means down: **stop and ask the human to start it.** Never start,
  restart or stop it yourself — see §3.5.

- **Databases:** dev is `ethical_yoga` (what the app on :3000 uses, and
  therefore what the `integration` project's fixtures live in), tests use
  `ethical_yoga_test` (the `unit` project). User `yoga`. The unit project prints
  `[unit-db] unit tests run against ethical_yoga_test` when it starts.

- If `git status` shows anything besides that one untracked file, stop and ask.

---

## 3. Rules that override your instincts

### 3.1 The copy is the specification

Two strings. Reproduce them character for character — including the em dash in
the teacher body, and the fact that only the archive body starts with "The".

```
${cls.classType} class on ${formatDayHeader(cls.date)} at ${cls.startTime} has been cancelled by your teacher.
```
```
${fresh.classType} class on ${formatDayHeader(fresh.date)} at ${fresh.startTime} was cancelled — only ${activeCount} of ${fresh.minStudents} minimum students registered.
```

Do not reword, re-punctuate, or "tidy" them. In particular:

- **Keep `only ${activeCount} of ${fresh.minStudents} minimum students
  registered`.** It is the one piece of context the teacher body carries that
  no other body has — it says *why* — and a test asserts it.
- **`formatDayHeader`, never `formatDateShort`.** `formatDayHeader` renders
  `Friday, 12 Jun`; the three bodies #195 shipped use it, and #96 existed to
  collapse divergent date renderings after a teacher saw two of them one tap
  apart. `formatDateShort` would still pass a naive `toContain('12 Jun')`
  assertion, which is why the plan's assertions call `formatDayHeader` directly.
- **Titles do not change** — `'Class cancelled'` and `'Class auto-cancelled'`.

### 3.2 Three `toContain`s, not one equality — and the reason matters

Each body gets three separate assertions (type, day, time) plus, on the teacher
side, the "only N of M" clause. Do not "simplify" them into a single
whole-string `toBe`.

An equality assertion would catch everything these do **and** go red on any
deliberate rewording. That sounds stricter and is worse: the next person to
reword the copy hits a failure that is not a defect, and the cheapest way out is
to loosen the assertion until it catches nothing. Three narrow assertions fail
only when a field is actually missing.

### 3.3 Two mutations per body, and the second is the real one

Four mutations total. Do all four; the plan names them per task.

The wholesale revert is the obvious one and the weaker one — nobody is going to
restore the old sentence. **The realistic regression is an edit that trims a
field out of the new sentence**, so each body is also mutated by deleting just
the ` at ${…startTime}` fragment. That mutation is the reason the assertions are
shaped the way §3.2 describes.

For each mutation: make it → run the named test → **copy the actual error text,
including the strings either side of "to contain"** → undo → re-run green →
confirm `git diff` is clean before committing. Paraphrasing does not count.

If a mutation does **not** cause a failure, that is an important finding — write
it down and flag it (§6). For the two integration mutations, first re-check that
the dev server recompiled (§2) before concluding the guard is dud.

### 3.4 Do not touch the two things next door

- **The teacher inbox's missing link.** A teacher's notification row can never
  link anywhere, for any type, because `src/app/(teacher)/inbox/page.tsx`
  selects no `relatedClass` and `NotificationList`'s `hrefById` prop arrives
  `undefined`. That is real, it is **filed as #201**, and it is not this issue.
  Do not "fix it while you're here" — it changes a page's query and a component's
  inputs, and it needs its own coverage.
- **`studentNotificationHref`'s refusal to link a cancelled class**
  (`src/lib/notification-links.ts`). It looks like the bug behind #200. It is a
  deliberate product decision with its reasoning recorded beside it — a cancelled
  class's booking page can do nothing for a student. Naming the class in the body
  is what makes that decision survivable. Leave it alone.

### 3.5 Never start, restart, or stop the dev server

The human runs it. Do not run `npm run dev`, do not kill the process, do not run
`next dev`. If the app seems broken or stale, **stop and ask.** Restarting it is
especially tempting on this issue because your test depends on it — resist that;
hot reload handles source edits on its own.

### 3.6 Git rules

- **Never `git add -A` or `git add .`** Stage the exact paths the plan lists.
- **Quote the route path.** It contains brackets and lives under a parenthesised
  route group elsewhere in this tree; unquoted, your shell may silently match
  nothing and the file will not be staged:

  ```bash
  git add "src/app/api/classes/[id]/transition/route.ts"
  ```

- **Commit after every task**, with the message the plan gives.
- **Do not push. Do not open a pull request. Do not rebase or merge.** The human
  does that.
- **Never modify `docs/backlog-roadmap.md`.** It is deliberately untracked.
- Do not amend or reword the two commits already on this branch.

### 3.7 TypeScript rules

- `strict: true` and `noUncheckedIndexedAccess` are on.
- **No `any`. No `@ts-ignore`. No `@ts-expect-error`. No casts to silence an
  error.** If the compiler complains and you cannot fix it honestly, stop and ask.
- Do not add or change any npm dependency.
- One new import is needed, in the route:
  `import { formatDayHeader } from '@/lib/format';`. That is safe — `lib/format`'s
  only import is `import type { PaymentStatus }`, which erases. Do not import
  `@/lib/log` into anything new; it is pino and server-only.
  `src/services/class-transitions.ts` and `src/services/class-transitions.test.ts`
  **already** import `formatDayHeader` — do not add a second import there.

### 3.8 Do not fix things you notice in passing

You will see other things that look wrong. Leave them. Write them at the end of
your report under "Noticed but not touched". A branch that fixes five unrelated
things cannot be reviewed.

---

## 4. Running the tests

Three test projects with different file patterns. Using the wrong one silently
runs zero tests and prints a pass, which looks like success.

| File you changed | Command |
|---|---|
| `src/services/class-transitions.test.ts` | `npx vitest run --project unit src/services/class-transitions.test.ts` |
| `tests/integration/classes-api.test.ts` | `npx vitest run --project integration tests/integration/classes-api.test.ts` |

A single test by name: append `-t 'part of the test name'`.

Typecheck: `npx tsc --noEmit`
Lint: `npm run lint`
Everything: `npm run verify` — typecheck + lint + all three projects. Needs :3000 live.

**Always read vitest's summary line.** `Test Files 0 passed (0)` means your
filter matched nothing — that is a failure, not a pass.

### Expected test counts

Measured on this branch before you started.

| File | Now | After Task 1 | After Task 2 |
|---|---|---|---|
| `class-transitions.test.ts` (unit) | 12 | 12 | 12 |
| `classes-api.test.ts` (integration) | 20 | 20 | **21** |

**Task 1 adds no test.** It extends an existing one — `auto-cancels
below-minimum classes inside the local check window and notifies the teacher` —
with body assertions. If that count moves to 13, you wrote a new test the plan
did not ask for.

Task 2 adds exactly one.

### The whole suite, before and after

`npm run verify` was green on this branch immediately before handover:

```
Test Files  109 passed (109)
     Tests  1167 passed | 2 todo (1169)
```

**You are adding one test and no new files.** So when you are done it must read:

```
Test Files  109 passed (109)
     Tests  1168 passed | 2 todo (1170)
```

If the file count changed, you created a test file the plan did not ask for.

**Any failure you see is yours.** The suite was green before you started, so do
not attribute a red test to a pre-existing problem without evidence.

### Alarming log output that is not a failure

The suite prints a lot of JSON to stdout, including lines that look like crashes
(`"level":50`, `"msg":"test-job sweep failed"`, `"reason":"boom"`). **These are
deliberate** — tests that verify error handling have to cause errors, and the
logger writes them out. `level:50` is pino's "error" level, not a test result.
Read only vitest's summary lines.

---

## 5. The task loop

For each of the three tasks:

1. Read the whole task before editing anything.
2. Write the test exactly as given. Do not simplify it or drop assertions.
3. **Run it and watch it fail.** The plan states the exact failure text each red
   step should produce — including the rendered day strings, which were computed
   rather than guessed (`2026-07-20` → `Monday, 20 Jul`; `2099-06-01` →
   `Monday, 1 Jun`). If it fails on a *different* assertion than the plan
   predicts, stop and ask; the fixture may be wrong.
4. Make the implementation change exactly as given, **including the comments**.
   The explanatory comments are part of the deliverable; this codebase records
   *why* beside the code on purpose, and reviewers check for it.
5. Run the test again and watch it pass.
6. Do the task's two mutations (§3.3).
7. `npx tsc --noEmit` and `npm run lint` — both clean.
8. Stage the exact paths and commit with the given message.

---

## 6. When to stop and ask

- A test fails for a different reason than the plan predicted.
- A mutation you were told to make **does not** break any test — after you have
  confirmed the dev server recompiled.
- The integration test cannot reach the app (`ECONNREFUSED`, `000`).
- `npx tsc --noEmit` reports an error you can only silence with `any` or an
  ignore comment.
- The plan asks for something that contradicts the code you actually see.
- You believe a plan step is wrong. **Say so rather than quietly bending the code
  to match it.** On the last two issues here, implementers caught genuine plan
  defects that way — including a test asserting a string the body could never
  contain. An implementer who reports "your predicted output is wrong" is doing
  the job correctly.
- You are tempted to do something §3 forbids.

Asking is cheap. A branch that silently deviated from the plan is expensive,
because the review will not know which deviations were deliberate.

---

## 7. What to report when you finish

Write your report as a message to the human — do **not** add it to the repo as a
file. (Task 3's mutation ledger *is* a repo file; that one is committed. The
report is not.) Cover:

1. **Per task:** what you changed, which test command you ran, the pass/fail
   counts. Actual numbers, not "tests pass".
2. **All four mutations:** what you broke, the **exact error text**, and
   confirmation you restored it.
3. **The acceptance grep**, pasted:
   ```bash
   grep -rn "type: 'class_cancelled'" src --include="*.ts" | grep -v "\.test\.ts"
   ```
   Five sites, and every corresponding body containing `formatDayHeader`. That
   grep is the whole acceptance check for this issue.
4. **`npm run verify` output** — the summary lines for typecheck, lint and tests.
5. **Anything that did not go to plan** — a step that failed unexpectedly, a
   prediction that turned out wrong, a mutation that did not bite, a line number
   that had moved.
6. **Noticed but not touched.**

Be accurate over reassuring. If something is half-done, say it is half-done. A
report that says "all tests pass" when one project ran zero tests is worse than
no report.

---

## 8. Final checklist

- [ ] Three tasks committed, one commit each, on
      `fix/200-cancellation-notice-names-class`.
- [ ] `npm run verify` reports exactly `Test Files 109 passed (109)` and
      `Tests 1168 passed | 2 todo (1170)`. Any other numbers need explaining —
      do not round, do not say "all green" without the figures.
- [ ] The acceptance grep shows **five** `class_cancelled` sites and **five**
      bodies containing `formatDayHeader`.
- [ ] `git diff main --stat` touches only:
      `src/services/class-transitions.ts`,
      `src/services/class-transitions.test.ts`,
      `src/app/api/classes/[id]/transition/route.ts`,
      `tests/integration/classes-api.test.ts`,
      and the new mutations doc.
- [ ] `src/app/(teacher)/inbox/page.tsx` and `src/lib/notification-links.ts` are
      **untouched** (§3.4).
- [ ] `git diff` is empty — all four mutations restored.
- [ ] `docs/backlog-roadmap.md` still untracked and unmodified.
- [ ] Nothing pushed, no PR opened, no rebase performed.
- [ ] Your report includes the exact error text from all four mutations.
