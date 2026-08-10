# Handover: implement the studio window reporting plan (#119 + #120)

**You are implementing an already-approved plan.** The design decisions are
made, the copy is fixed, the tests are written out for you. Your job is to
execute it faithfully — not to redesign it, improve it, or extend it.

Read this whole file before you touch anything. It exists because this codebase
contains one thing that *looks* like a bug and is not, and fixing it would make
the product worse.

---

## 1. Orientation

| | |
|---|---|
| Repo | `/Users/ivohofland/Projects/fair.yoga` |
| Branch | `fix/119-120-studio-window-reporting` — already created, already has 2 commits |
| Your plan | `docs/superpowers/plans/2026-08-10-studio-window-reporting.md` |
| The reasoning behind it | `docs/superpowers/specs/2026-08-10-studio-window-reporting-design.md` |
| Project rules | `CLAUDE.md` in the repo root — read it, it is short and it overrides your defaults |

**Two GitHub issues are being closed.**

- **#119** — resuming a paused studio class template generates between zero and
  four classes and tells the teacher nothing. The button relabels and no message
  appears. The count exists; four layers of code throw it away.
- **#120** — creating a studio class template generates nothing at all, so the
  teacher's schedule is empty for up to an hour until a background sweep runs.
  The only button they can see says "Resume studio class", which answers
  `200 unchanged` and does nothing.

**Work through the plan one task at a time, in order, committing after each.**
Five tasks. Do not start Task 2 until Task 1 is committed.

---

## 2. Before you start

Confirm the environment. Run these and check the output:

```bash
cd /Users/ivohofland/Projects/fair.yoga
git branch --show-current      # must print: fix/119-120-studio-window-reporting
git status --short             # should show only: ?? docs/backlog-roadmap.md
docker ps --format '{{.Names}}' | grep fairyoga-db    # must print: fairyoga-db-1
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:3000/
```

- **The database container must be up.** Both the `unit` and `integration` test
  projects talk to a real PostgreSQL — unit tests are not pure functions here.
  Expect `fairyoga-db-1`. If `docker ps` shows nothing, stop and ask.
- **The app must be running on :3000.** The `integration` project drives it over
  HTTP. The `curl` above prints **`307`** on a healthy server — `/` redirects when
  you have no session cookie. Any 2xx or 3xx means it is up. A `000`, a timeout,
  or `ECONNREFUSED` in test output means it is not: **stop and ask the human to
  start it.** Do not start or restart it yourself — see §3.5.
- If `git status` shows anything other than that one untracked file, stop and ask.

---

## 3. Rules that override your instincts

These are the things you are most likely to get wrong. Each one has already
happened on this project.

### 3.1 There is a missing filter that must stay missing

In `src/services/studio-class-generator.ts:144-146`:

```ts
const existing = await db.studioClass.findFirst({
  where: { templateId: template.id, date },
});
if (existing) continue;
```

This checks whether a class already exists on a date, **and it does not filter
out cancelled ones.** Twenty lines away, the archive code *does* filter on
`cancelledAt: null`. It looks inconsistent. It looks like the bug.

**Do not add a `cancelledAt` filter here. Not in any task. Not as a drive-by fix.**

Why: `StudioClass` carries `@@unique([templateId, date])`
(`prisma/schema.prisma:477`). Only one studio class can exist per template per
date, ever. If you filter cancelled rows out of this probe, the code will then
try to `INSERT` a row on a date that already has one, and PostgreSQL will reject
it with a unique-violation error (P2002). That error is caught at
`studio-class-generator.ts:178-193`, where it logs:

> `studio class insert hit @@unique([templateId, date]) — generated without the claim held`

That message would then be **false**, because the claim *was* held. You would
have replaced a clean, correct skip with a misleading error in the logs. Skipping
the date is not a policy choice this plan is making — it is the only behaviour
the database schema permits.

This is written up as "Correction 1" in the spec if you want the longer version.

### 3.2 The copy strings are the specification

Task 1 defines five exact strings:

```
4 classes on your schedule.
4 classes on your schedule. Nothing needed adding.
1 class on your schedule.
1 class on your schedule. Nothing needed adding.
Nothing is scheduled from this template.
```

Reproduce them character for character. Do not reword, re-punctuate, capitalise
differently, or add a friendlier tone. The tests assert whole strings.

**In particular: do not add "for the next 4 weeks".** An earlier draft had it and
it was removed on purpose — the number is counted with no upper date bound, so
that phrase would be a promise the query does not keep. If you find yourself
thinking the sentence sounds incomplete, that is the intended trade-off, not an
oversight.

### 3.3 Do not touch the class-template family

This codebase has two parallel families: *class* templates (public, bookable) and
*studio* templates (the teacher's own income records). They have near-identical
code. The class family has the same reporting gap and it is **tracked separately
on issue #116.**

**Leave these files completely alone:**

```
src/services/class-template-lifecycle.ts
src/services/class-generator.ts
src/services/template-sync.ts
src/app/api/class-templates/route.ts
src/app/api/class-templates/[id]/route.ts
src/components/settings/toggle-template-button.tsx
src/components/settings/archive-template-button.tsx
```

Also, inside `src/components/settings/template-action-messages.ts`, do not modify
`TemplateToggleResponse`, `resolveTemplateConfirmation`, `archiveMessage`, or
`archiveStudioMessage`. You are *adding* alongside them.

Fixing both families "for symmetry" would double the diff and collide with
another issue's work. It is not more thorough; it is out of scope.

### 3.4 The mutation steps are the deliverable, not busywork

Several plan steps tell you to deliberately break the code, run the tests,
record the failure, then restore it. For example: remove `cancelledAt: null`,
run the tests, write down the exact numbers in the failure message, put the line
back.

**Do all of them. Do not skip any. Do not substitute reasoning for running them.**

The reason: a test that has never been observed to fail does not prove anything.
This project has shipped tests that passed against the bug they were written to
catch, and type-level assertions that compiled cleanly whether the code was right
or wrong. The only way to know a test can fail is to make it fail and watch.

For each mutation:

1. Make the change.
2. Run the test command the plan names.
3. **Copy the actual error text into your report**, including the numbers
   ("expected 5, got 4"). Paraphrasing does not count.
4. Undo the change.
5. Re-run and confirm green.
6. Confirm `git diff` is clean before committing.

If a mutation does **not** cause a failure, that is an important finding. Write it
down and flag it — see §6.

### 3.5 Never start, restart, or stop the dev server

The human runs the app on port 3000 themselves. It serves this working copy and
the integration tests need it live. Do not run `npm run dev`, do not kill the
process, do not run `next dev`. If the app seems broken or stale, **stop and ask.**

### 3.6 Git rules

- **Never `git add -A` or `git add .`** Stage the exact file paths the plan lists.
- **Quote any path containing parentheses.** This repo has directories named
  `(public)`, `(teacher)`, `(student)`. Unquoted, your shell will silently match
  nothing and the file will not be staged:

  ```bash
  git add "src/app/api/studio-class-templates/[id]/route.ts"   # quoted — correct
  ```

- **Commit after every task**, with the message the plan gives.
- **Do not push. Do not open a pull request.** The human does that.
- **Never modify `docs/backlog-roadmap.md`.** It is deliberately untracked.

### 3.7 TypeScript rules

- `strict: true` and `noUncheckedIndexedAccess` are on.
- **No `any`. No `@ts-ignore`. No `@ts-expect-error`. No casts to silence an
  error.** If the compiler complains and you cannot fix it honestly, stop and ask.
- Indexing an array gives `T | undefined`. Prefer `.slice()`, `.map()`, or
  iteration over `arr[0]!`. The plan's test code already does this — follow it.
- Do not add or change any npm dependency.

### 3.8 Do not fix things you notice in passing

You will see other things that look wrong. Leave them. Write them at the end of
your report under "Noticed but not touched". Someone will triage them. A branch
that fixes five unrelated things cannot be reviewed.

---

## 4. Running the tests

There are three test projects with different file patterns. Using the wrong one
silently runs zero tests and prints a pass, which looks like success.

| File you changed | Command |
|---|---|
| `src/components/settings/template-action-messages.test.ts` | `npx vitest run --project unit src/components/settings/template-action-messages.test.ts` |
| `src/services/studio-class-template-lifecycle.test.ts` | `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts` |
| `src/components/settings/toggle-studio-template-button.test.tsx` | `npx vitest run --project components src/components/settings/toggle-studio-template-button.test.tsx` |
| `tests/integration/studio-api.test.ts` | `npx vitest run --project integration tests/integration/studio-api.test.ts` |

Typecheck: `npx tsc --noEmit`
Lint: `npm run lint`
Everything: `npm run verify` (typecheck + lint + all three projects) — needs :3000 live.

**Always read the summary line.** `Test Files 0 passed (0)` means your filter
matched nothing — that is a failure, not a pass. You want a non-zero test count.

### Expected test counts

These were measured on this branch before any of your work. Use them as a
mechanical check: after each task, the count should be exactly what this table
says. A number that is too low means a test you wrote is not running; too high
means you added something the plan did not ask for.

| File | Now | After Task 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| `template-action-messages.test.ts` | 25 | **31** | 31 | 31 | 31 | 31 |
| `studio-class-template-lifecycle.test.ts` | 27 | 27 | **29** | 29 | 29 | 29 |
| `studio-api.test.ts` | 20 | 20 | 20 | **21** | 21 | **23** |
| `toggle-studio-template-button.test.tsx` | 5 | 5 | 5 | 5 | **6** | 6 |

Task 2 adds two tests and *extends an existing one* with new assertions, so its
count rises by two, not three. Task 4 adds one test and *corrects a stale fixture*
in another, so its count rises by one.

Do not count tests by grepping for `it(`. On this project that has produced wrong
numbers repeatedly — grepping `template-action-messages.test.ts` gives 19 where
vitest reports 25. Read vitest's own summary line.

### The whole suite, before and after

`npm run verify` was run on this branch before handing it to you, and it was
**fully green**:

```
Test Files  105 passed (105)
     Tests  1108 passed | 2 todo (1110)
  Duration  ~132s
```

Typecheck and lint both passed (they run first, and the chain stops on failure).

**You are adding 12 tests and no new files.** So when you are done, `npm run
verify` must report:

```
Test Files  105 passed (105)
     Tests  1120 passed | 2 todo (1122)
```

If you see 105 files and 1120 passing tests, your work is wired in. If the file
count changed, you created a test file the plan did not ask for. If the test count
is below 1120, something you wrote is not running.

**Any failure you see is yours.** The suite was green before you started, so do
not attribute a red test to a pre-existing problem without evidence.

### Alarming log output that is not a failure

The suite prints a lot of JSON to stdout, including lines that look like crashes:

```
{"level":50, … "message":"boom-alpha" … "msg":"test-job sweep failed"}
{"level":50, … "reason":"boom","msg":"email fallback send failed"}
{"level":40, … "timeZone":"Not/AZone","msg":"invalid timezone, falling back to UTC"}
```

**These are deliberate.** Tests that verify error handling have to *cause* errors,
and the logger writes them out. `level:50` is pino's "error" level, not a test
result. Ignore all of it and read only vitest's summary lines. Do not "fix" these.

---

## 5. The task loop

For each of the five tasks in the plan:

1. Read the whole task before editing anything.
2. Write the test exactly as given. Do not simplify it or drop assertions.
3. **Run it and watch it fail.** Confirm it fails for the reason the plan
   predicts. If it fails for a different reason, stop and ask — the plan may be
   wrong, and that is worth knowing.
4. Make the implementation change exactly as given, including the comments. The
   long explanatory comments are part of the deliverable; this codebase records
   *why* beside the code on purpose.
5. Run the test again and watch it pass.
6. Do the mutation steps (§3.4).
7. `npx tsc --noEmit` and `npm run lint` — both clean.
8. Stage the exact paths and commit with the given message.
9. Move to the next task.

The plan flags **one place where order matters**: Task 4 must come after Task 3.
Task 4 introduces a type that says the API response *definitely* contains two new
fields, and Task 3 is what makes the API actually send them. Reversed, the type
would be describing a response the server cannot produce. Do not reorder.

---

## 6. When to stop and ask

Stop, do not improvise, and report, if any of these happen:

- A test fails for a different reason than the plan predicted.
- A mutation you were told to make **does not** break any test. (Especially Task 4
  Step 7 — if `npx tsc --noEmit` still passes after you revert one studio button
  to `TemplateToggleResponse`, that is a real finding. **Do not** work around it
  with a cast or a `satisfies` clause. Report it and stop; the design needs
  revisiting.)
- `npx tsc --noEmit` reports an error you can only silence with `any` or an
  ignore comment.
- The app on :3000 is down, or integration tests give `ECONNREFUSED`.
- The plan asks for something that contradicts the code you actually see.
- You believe a plan step is wrong. **Say so rather than quietly bending the code
  to match it.** Plan defects found this way have been valuable on this project
  several times — an implementer who reports "your predicted output is wrong" is
  doing the job correctly.
- You are tempted to do something §3 forbids.

Asking is cheap. A branch that silently deviated from the plan is expensive,
because the review will not know which deviations were deliberate.

---

## 7. What to report when you finish

Write your report as a message to the human — do **not** add it to the repo as a
file. Cover:

1. **Per task:** what you changed, which test command you ran, and the pass/fail
   counts. Actual numbers, not "tests pass".
2. **Every mutation:** what you broke, the **exact error text** you saw, and
   confirmation you restored it. All of them, in one list.
3. **`npm run verify` output** — the final summary lines for typecheck, lint, and
   each of the three test projects.
4. **Anything that did not go to plan** — a step that failed unexpectedly, a
   prediction that turned out wrong, a mutation that did not bite.
5. **Task 5 Step 7 specifically.** The plan predicts that moving the `create`
   outside the transaction will *not* fail any route-level test. Say plainly
   whether that prediction held. If it did, say so — that is a known coverage gap
   that has to be recorded honestly, not hidden.
6. **Noticed but not touched** — anything that looked wrong that you correctly
   left alone.

Be accurate over reassuring. If something is half-done, say it is half-done. If
you skipped a step, say which and why. A report that says "all tests pass" when
one project ran zero tests is worse than no report.

---

## 8. Final checklist

Before you say you are done:

- [ ] All five tasks committed, one commit each, in order.
- [ ] `npm run verify` reports exactly `Test Files 105 passed (105)` and
      `Tests 1120 passed | 2 todo (1122)`. Any other numbers need explaining in
      your report — do not round, do not say "all green" without the figures.
- [ ] `grep -rn "for the next 4 weeks" src/` returns **nothing**.
- [ ] `git diff` is empty — every mutation restored.
- [ ] `git diff main --stat` touches **none** of the class-family files listed in §3.3.
- [ ] `src/services/studio-class-generator.ts` has **no** new `cancelledAt` filter
      in the probe at `:144-146` (§3.1). Its only changes are to two comment blocks.
- [ ] `docs/backlog-roadmap.md` is still untracked and unmodified.
- [ ] Nothing pushed, no PR opened.
- [ ] Your report includes the exact error text from every mutation.
