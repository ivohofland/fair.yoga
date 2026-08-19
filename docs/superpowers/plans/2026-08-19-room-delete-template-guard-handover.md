# Handover — issue 103, the room-delete template guard

You are implementing an approved plan in a different harness. This document is
not a summary of the plan; you have the plan. It carries what the plan cannot:
the wrong turns the *correct* documents will invite, the references I verified
so you do not have to re-derive them, and the two or three mistakes that are
unrecoverable if you make them.

---

## 1. Read these, in this order

| # | File | What actually matters in it |
|---|---|---|
| 1 | `CLAUDE.md` | "Class Lifecycle", "Data Model", and the `known-open` note on `template-sync`. Skip the pricing engine — this branch does not touch money. |
| 2 | `docs/superpowers/specs/2026-08-19-room-delete-template-guard-design.md` | **§1 in full.** It records what the issue got wrong. §2.1 is the design decision you are most likely to reverse by accident. |
| 3 | `docs/superpowers/plans/2026-08-19-room-delete-template-guard.md` | All six tasks. The code blocks are literal — type them, do not paraphrase. |
| 4 | `.claude/skills/solve-issue/SKILL.md` | §2 (counts), §3 (prove every guard bites), §4 (correct a claim in every artifact). These describe failures this repo keeps repeating. |

**On `AGENTS.md`:** your harness probably auto-loads it. Note that it is **not**
a pointer to `CLAUDE.md` — it is 80 lines of genuinely useful operational
content (the three-project test architecture, auth-without-email, the Prisma
rules, the `America/New_York` timezone pin). But it carries **none** of the
business rules, and it mentions `CLAUDE.md` only as one row in a reference table
at the very bottom. Reading `AGENTS.md` and stopping is the default failure.
Read both.

---

## 2. Derailers — read before you touch anything

A derailer is not a hazard. It is a wrong turn that the correct documents
actively invite. Each of these is something you will get wrong *because* you
read the right file carefully.

### D1. `ACTIVE_TEMPLATE_WHERE` will look mandatory. It is wrong here.

`src/lib/template-selection.ts` exports `ACTIVE_TEMPLATE_WHERE = { isActive:
true, isArchived: false }` under a docblock that says, forcefully, that the
generator and the room-archive door **must not be able to answer differently**,
and that the constant exists so divergence takes a deliberate edit. `room-archive.ts`
repeats it. Both are correct, and both are about a **different door**.

Archiving asks *"would a template put classes here?"* — only a live template
would. **Deleting asks *"does a row point here?"* — and a foreign key reads
neither `isActive` nor `isArchived`.**

If you spread `ACTIVE_TEMPLATE_WHERE` into the delete counts, you will:
compile clean, pass every test you would naturally write first, and **restore
the exact 500 this branch exists to remove** — because the row that reproduced
it is an *archived* template.

This is the single most likely way this branch ships broken. The plan's Task 2
mutation exists to catch it. Do not skip that mutation.

### D2. The pre-check and the `try/catch` will look redundant. Removing either is not symmetric.

Both delete routes end up with a count-then-refuse guard **and** a
`isRestrictViolationOn` catch around the delete. Every instinct — and any
simplifier agent you run — will call that belt-and-braces and collapse it.

> **Corrected after PR review — this bullet pair was half wrong.** Both halves
> were invisible to the suite, not one. See the lock-ordering case now in each
> integration file.

- Removing the **catch** loses the race window. Bad, recoverable — and caught
  by **nothing**. The claim here used to read "and a test catches it"; measured,
  no test does. Every reachable test state is stopped by the pre-check first,
  and the race that reaches the catch cannot be forced over HTTP.
- Removing the **pre-check** reopens a database deadlock, **with every test in
  the repo still green** — measured too: `if (false && ...)` in both routes left
  434/434 green, because the catch answers a byte-identical 409. It is pinned
  now, by holding `FOR UPDATE` on the template row and failing when the DELETE
  waits on it. That is because the catch runs *after* the `DELETE` has
  already taken its locks. Converting the outcome is not avoiding the wait.

Both handlers carry an inline comment saying this. Do not "tidy" those comments
into one line; they are the only thing standing between a future reader and a
silent regression. `docs/lock-order.md` (Task 5) is the long form.

### D3. `describeRoomBlockers` is right next door and is the wrong tool.

`src/services/room-archive.ts:63` exports a polished, plural-aware
`describeRoomBlockers({classes, templates})` producing e.g. `"1 recurring class
still uses this room."` You will have a `{classes, templates}` object in hand
and reaching for it is the obvious move.

**Do not.** The approved decision (spec §2.1, chosen by the maintainer) is one
fixed string for the delete door:

```
Cannot delete a room with class history. Archive it instead.
```

`describeRoomBlockers` omits the way out, and the delete door's blockers are
*permanent* — a `ClassTemplate` is never hard-deleted anywhere in `src/`
(there is no `DELETE` verb on `/api/class-templates/[id]`; verify it below).
A message that names a blocker the teacher cannot clear and offers no remedy is
the exact failure #76 spent a round fixing.

### D4. If your reproduction shows 409 before you have written anything, your fixture is wrong.

The bug needs **zero `Class` rows and at least one `ClassTemplate`** on the
link. Any class at all — any status, including `completed` and `cancelled` —
makes the existing guard fire first and answers 409, which looks exactly like a
fix.

This is the #138 failure mode: a check run in a state where both code paths
behave identically proves nothing. Assert the precondition inside the test:

```ts
expect(await prisma.class.count({ where: { teacherRoomId: linkId } })).toBe(0);
```

The plan's tests already do. Keep those lines even if they look redundant.

### D5. The one-query shortcut in `rooms/[id]` is tempting and loses the shared constant.

`src/app/api/rooms/[id]/route.ts:25` already reads
`teacherRooms: { include: { _count: { select: { classes: true } } } }`. Adding
`classTemplates: true` to that `_count` fixes the 500 in one line and one query.

It is not wrong, and it is not the plan. The plan routes both doors through
`src/services/room-deletion.ts` so the **FK-name list has one home** — with the
shortcut, a future constraint rename disarms one route's backstop while the
other keeps working, and nothing fails. Follow the plan. If you think the
shortcut is better, say so in your report; do not just take it.

---

## 3. Verify, don't assume

**I ran every line of this block on 2026-08-19 and pasted the real output.** If
any line disagrees with what you see, the repo has moved: fix the reference,
proceed, and **say so in your report**.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/health
# 200        <- the app must already be running. Do NOT start or restart it.

docker ps --format '{{.Names}}' | grep fairyoga-db-1
# fairyoga-db-1

grep -n "teacherRoomId_fkey" prisma/migrations/20260403092044_init/migration.sql
# 339: ClassTemplate_teacherRoomId_fkey ... ON DELETE RESTRICT
# 345: Class_teacherRoomId_fkey         ... ON DELETE RESTRICT

grep -n "prisma.class.count\|prisma.teacherRoom.delete" "src/app/api/teacher-rooms/[id]/route.ts"
# 139:  const classCount = await prisma.class.count({ where: { teacherRoomId: id } });
# 144:  await prisma.teacherRoom.delete({ where: { id } });

grep -n "const hasClasses\|teacherRoom.deleteMany\|prisma.room.delete" "src/app/api/rooms/[id]/route.ts"
# 37:  const hasClasses = ...
# 49:  await prisma.teacherRoom.deleteMany({ where: { roomId: id } });
# 50:  await prisma.room.delete({ where: { id } });

grep -n "^export function isRecordNotFound\|^export function classifyApiError" src/lib/api-errors.ts
# 245: isRecordNotFound     <- insert isRestrictViolationOn after this one ends (:247)
# 267: classifyApiError

grep -c '^export const DELETE' "src/app/api/class-templates/[id]/route.ts"
# 0          <- D3 depends on this staying 0

grep -n "return { suffix, makeFixture, addClass, addTemplate, cleanup }" tests/room-fixtures.ts
# 128        <- addTemplate(db, f, { isActive, isArchived }) already exists. Do not write a new fixture helper.

grep -n "Drop the guard" tests/integration/rooms-api.test.ts
# 458        <- the comment Task 4 must correct

grep -c 'TeacherRoom' docs/lock-order.md
# 0          <- Task 5 adds the first mention in 985 lines
```

---

## 4. How this harness differs from the one the plan was written in

- **No skills system.** The plan references `superpowers:subagent-driven-development`;
  ignore that. Execute the tasks yourself, in order.
- **TDD ordering is not enforced for you — do it anyway.** Every task is
  written test-first because a test written after the fix routinely passes
  against the bug. Run the failing test and *read the failure message* before
  implementing. If the test passes before you write code, you have written the
  wrong test (see D4).
- **The mutations are deliverables, not optional verification.** A guard that
  compiles but cannot fail certifies nothing, and this repo has shipped three
  such guards through review. Each mutation's *exact error text* goes in the
  commit message for that task.
- **Commit per task.** The PR is **rebase-merged, never squashed** — the
  per-task history is the record. Do not amend earlier tasks into later ones.
- **`npm run verify` needs the app live on :3000** (integration talks to it over
  HTTP). You will get a wall of `ECONNREFUSED` otherwise. The maintainer runs
  that server; never start or restart it.

---

## 5. Task order, and which constraints are load-bearing

Order is **1 → 2 → 3 → 4 → 5 → 6**, and it is load-bearing, not preference:

- Tasks **3 and 4 import from both 1 and 2**. Doing them first means writing
  against symbols that do not exist.
- Task **5's prose cites `countRoomDeleteBlockers` and `src/services/room-deletion.ts`**,
  which Task 2 creates. Written earlier, it documents a file that is not there.
- Tasks **3 and 4 are independent of each other.** Either order is fine; do not
  merge them into one commit, because a reviewer should be able to reject one
  route's wiring while accepting the other's.

**Load-bearing (do not vary):**
- The refusal string, character for character, in both routes.
- The delete predicate counting **every** template (D1).
- Both FK names in `ROOM_DELETE_RESTRICT_FKS` — `Class_teacherRoomId_fkey` is
  there deliberately even though the `Class` guard predates this issue, because
  that guard has the same race and had no backstop at all.
- `isRestrictViolationOn` keying on `meta.constraint` and **never** on
  `meta.modelName`. Measured: the same constraint arrives as
  `modelName: "TeacherRoom"` from one route and `"Room"` from the other. A
  matcher that checks the model passes one route's tests and 500s the other.

**Preference (vary if you have a reason, and report it):**
- Where the new `describe` blocks sit inside the test files.
- The `log.info` on each refusal. It is an addition beyond the spec, included
  for symmetry with the archive door, and flagged in the plan as strikeable.

---

## 6. Stop conditions

Stop and report rather than working around, if:

- **A mutation does not produce a failure.** That means the guard cannot fail,
  which is the defect — not a test-harness annoyance to route around.
- **Task 2's mutation fails the live-template case.** It must stay green. If it
  goes red, your fixtures trip both blockers at once and certify neither.
- **`npm run verify` is red for any reason you did not cause.** Report the
  output; do not fix unrelated failures in this branch.
- **You conclude the plan is wrong.** Say so with evidence and stop. Four plan
  defects have been caught this way on previous branches; bending the code to
  match a wrong instruction is worse than pausing.

### The two mutations that matter most

1. **Task 2 — narrowing to `ACTIVE_TEMPLATE_WHERE`.** Expect **exactly three**
   failures (archived, paused, and the room-scoped archived case) and the
   live-template case **green**. That green case is the proof: it is the test
   that *cannot* detect this edit, which is why the other three must exist.
2. **Task 4 — dropping the guard.** Written honestly in the plan because I
   could not predict it: the P2003 catch may well mask it and answer 409
   anyway. **If it does, say so** — do not manufacture a failure. Then run the
   second mutation (drop the guard *and* the catch) which does bite. A mutation
   that proves nothing is worth reporting as such.

---

## 7. Hazards that have actually bitten this repo

Trimmed to what this branch can reach.

- **Quote every path containing `[` or `(` when staging.** `git add
  src/app/api/rooms/[id]/route.ts` unquoted is a zsh glob (`[id]` = a character
  class), matches nothing, and **fails silently**. Always
  `git add "src/app/api/rooms/[id]/route.ts"`.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Never write `does not close #N`** in a commit message or PR body. GitHub's
  parser matches the keyword and ignores the negation in front of it. This has
  fired twice on this repo, the second time in the very commit written to
  document the first. Write "**#N is unaffected**".
- **`@/lib/log` is pino and server-only.** `src/services/room-deletion.ts` must
  stay import-free of it — the routes do the logging. If you move the log into
  the service, check nothing in a `'use client'` graph value-imports it.
- **Do not hand-list integration files anywhere.** `npm run verify` runs all of
  them; name a file only when its order matters.
- **Never edit an applied migration.** This branch needs no migration at all.
- **The template slot index is partial.** `ClassTemplate_teacher_slot_unique` is
  `(teacherId, dayOfWeek, startTime) WHERE isArchived = false`. The plan's
  fixtures avoid a collision (one archived — excluded from the index — and one
  live at a distinct slot). If you change a `dayOfWeek` or `startTime`, you can
  get a P2002 in `beforeAll` that looks like an unrelated failure.
- **`@@unique([teacherId, roomId])` on `TeacherRoom`** — one link per
  teacher/room pair, which is why each new fixture link gets its own room.

---

## 8. Baseline, done, and what to report

### Measured baseline (`npx vitest run`, 2026-08-19, before any change)

| Project | Files | |
|---|---:|---|
| unit | 62 | `src/**/*.test.ts` |
| integration | 31 | `tests/integration/**/*.test.ts` |
| components | 41 | `src/**/*.test.tsx` |
| **Total** | **134** | vitest reported 134 — reconciles |

**1590 tests, all passing**, 233 s.

Predicted after: **135 files** (one new: `src/services/room-deletion.test.ts`)
and **~1606 tests** (1590 + 4 + 9 + 3). **Measure it anyway and report the real
number.** A previous handover predicted 1294 and the branch measured 1296,
because its own review added tests the prediction could not have known about.

### Done means

- All six tasks committed, one commit each.
- `npm run verify` green — typecheck, lint, and all three vitest projects.
- Every mutation run, restored, and its exact error text in a commit message.

### The PR body must record

- What was **measured**, with arithmetic a reader can re-derive.
- Which inherited claims were checked and **which held** — the issue's
  `migration.sql:339,345` citation held exactly; its "same 'still in use'
  message" framing did not, because the blocker is permanent.
- That `npm run verify` runs the **whole** integration suite, so a green verify
  *is* every integration file — with the arithmetic that proves it. Still name
  by path the two integration files this branch changed:
  `tests/integration/teacher-rooms-api.test.ts`,
  `tests/integration/rooms-api.test.ts`.
- What the PR does **not** do: no migration, no `lock_timeout`, no change to the
  archive door's predicate, no `DELETE` verb for templates. Phrase every such
  line as "**#N is unaffected**".
- Your own errors, if any. They are the most useful part.

### Report back

1. The measured after-figure (files and tests), not the prediction.
2. Each mutation's exact error text, and any that did not fail.
3. Any reference in §3 that had drifted.
4. Anything in the plan you believe is wrong, with evidence.
5. Whether you kept or struck the `log.info` (§5, preference).

---

## 9. Final checklist — one line per irreversible mistake

- [ ] I did **not** start or restart the dev server on :3000.
- [ ] I did **not** reuse `ACTIVE_TEMPLATE_WHERE` in the delete counts.
- [ ] I did **not** collapse the pre-check into the `try/catch`.
- [ ] I did **not** use `describeRoomBlockers` for the delete refusal.
- [ ] I quoted every staged path containing `[` or `(`.
- [ ] I never wrote `does not close #N`; I wrote "#N is unaffected".
- [ ] I did not edit an applied migration.
- [ ] I ran every mutation, **restored every one**, and re-ran the suite green
      after each restore.
- [ ] I committed once per task and did not squash.
- [ ] I reported the measured test count, not the predicted one.
