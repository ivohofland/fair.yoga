# Handover: implement the generator slot-reporting plan (#164 + #192)

**You are implementing an already-approved plan.** The design is settled, the
decisions were made at three review gates with the repo owner, and most of the
test code is written out for you. Your job is to execute it faithfully — not to
redesign it, improve on it, or widen it.

Read this whole file before you touch anything. It is not long. The two things
it exists to tell you are:

- **§4 — one task order cannot move**, and the step that proves the fix works is
  a step that must be watched to *fail* first. Get that backwards and you will
  ship guards that certify nothing.
- **§3 — you are not running under Claude Code**, so the plan's header instruction
  ("REQUIRED SUB-SKILL: superpowers:subagent-driven-development") does not apply
  to you. Execute the tasks yourself, in order.

---

## 1. Orientation

| | |
|---|---|
| Working directory | `/Users/ivohofland/Projects/fair.yoga` — the main checkout. **Not a worktree.** |
| Branch | `fix/164-192-generator-slot-reporting` — already created off `main`, already has 2 commits (spec, plan). **No source file has been touched.** |
| Your plan | `docs/superpowers/plans/2026-08-11-generator-slot-reporting.md` |
| The reasoning behind it | `docs/superpowers/specs/2026-08-11-generator-slot-reporting-design.md` |
| Project rules | `AGENTS.md` (you get this automatically) **and `CLAUDE.md` (you do not — read it)** |

**Two GitHub issues close on this branch:**

- **#164** — "Generator: continue cannot continue an aborted transaction — Resume
  reports success while the template stays paused."
- **#192** — "The studio generator cannot tell idempotent skip from a permanently
  unfillable date."

They are one branch because **#196** — the next issue in the queue — adds partial
unique indexes to both `Class` and `StudioClass`, and is blocked until both
generators stop aborting. Splitting these two would mean rewriting the same eight
lines twice.

### What is actually wrong

`src/services/class-generator.ts` catches `P2002` from a per-date `create` and
`continue`s, commented *"a concurrent run created this instance first"*. Its
docblock advertises the function as idempotent on that basis.

Prisma does not savepoint individual queries inside an interactive transaction,
so a caught `P2002` leaves Postgres with an **aborted** transaction. Four of the
five call sites pass a transaction client. Measured on this schema:

```
tx, collision NOT last : next statement -> 25P02 "current transaction is aborted"
tx, collision IS last  : $transaction -> RESOLVED, reported created=1
                         the row it claims to have created: NOT committed
```

The second line is the whole issue. `COMMIT` on an aborted transaction returns
the `ROLLBACK` tag with **no error**, so a teacher clicking Resume is told
`{ ok: true, action: 'active' }` while the `isActive: true` was rolled back in
the same transaction. The template stays paused, the window stays empty, and
there is no log line to find it by.

`src/services/studio-class-generator.ts` has the identical hedge, plus #192's
separate defect: its existence probe cannot tell "already generated" from
"a cancelled row holds this date permanently".

**Nine tasks. Commit after each.** Tasks 1→2→3 are sequential. Tasks 4 and 5 are
independent of each other but both must precede Task 6.

---

## 2. Before you start — verify, don't assume

```bash
cd /Users/ivohofland/Projects/fair.yoga
git branch --show-current   # must print: fix/164-192-generator-slot-reporting
git status --short          # must print ONLY: ?? docs/backlog-roadmap.md
docker ps --format '{{.Names}}' | grep fairyoga-db     # must print: fairyoga-db-1
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://localhost:3000/   # 307
```

Everything below was measured immediately before this file was written.

- **`docs/backlog-roadmap.md` is untracked and must stay untracked.** It is the
  owner's local map. Never `git add` it. This is also why you must never run
  `git add -A` or `git add .` — stage exact paths, always.
- **The app on :3000 is `next dev` serving THIS checkout on THIS branch.**
  Verified: the listener's parent is
  `node /Users/ivohofland/Projects/fair.yoga/node_modules/.bin/next dev`, cwd
  `/Users/ivohofland/Projects/fair.yoga`. Your edits reach it by hot reload.
- **Never start, restart, or kill the dev server.** The owner runs it. The
  `integration` vitest project talks to it over HTTP; without it you get a wall
  of `ECONNREFUSED`, and that is a signal to stop and say so, not to start one.
- **Unit tests do not touch the dev database.** `vitest.config.ts:71` sets
  `env: { DATABASE_URL: testUrl }` for the `unit` project, and
  `tests/setup/unit-db.ts` *refuses to run* if `DATABASE_URL_TEST` equals
  `DATABASE_URL`. This matters for Task 2, which opens a **second**
  `new PrismaClient()` for the lock holder: because the project has already
  rewritten `DATABASE_URL`, that second client lands on `ethical_yoga_test` like
  the first. Do not "fix" it by passing a `datasources` override.

Which database each project uses:

| project | files | database |
|---|---|---|
| `unit` | `src/**/*.test.ts` | `ethical_yoga_test` |
| `integration` | `tests/integration/**/*.test.ts` | dev DB, via the app on :3000 |
| `components` | `src/components/**.test.tsx` | none (jsdom) |

---

## 3. You are not running under Claude Code

The plan's header says *"REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development"*.
That is written for the harness the plan was authored in. **Superpowers is not
installed for opencode here** — the global config at
`~/.config/opencode/opencode.jsonc` has no `plugin` array, so you have no
`superpowers:*` skills available.

**What to do instead:** execute the plan yourself, task by task, in the order
given. Each task in the plan already carries the full TDD cycle as explicit
steps — write the failing test, run it and watch it fail, implement, run it and
watch it pass, commit. Follow those steps literally. That is all the missing
skill would have given you.

Two more harness differences that will bite:

- **opencode auto-loads `AGENTS.md`, not `CLAUDE.md`.** `CLAUDE.md` is the file
  carrying the data model, the design philosophy, and the development
  principles, and `AGENTS.md` only links to it. **Read `CLAUDE.md` before Task 1.**
- **No `/pr-review-toolkit:review-pr`.** Task 9 step 3 calls for a multi-agent PR
  review that only exists in the other harness. Do Task 9 steps 1 and 2 (verify,
  push, open the PR), then **stop and hand back** — the owner runs the review.

---

## 4. The one task order that cannot move

Task 1 rewrites the class generator. Task 2 adds the two tests that reproduce
the bug. **Task 2's tests can only be observed failing against the pre-fix
generator, which Task 1 has already replaced.**

The plan solves this and you must not simplify it away. Task 2, step 2:

```bash
git stash push -- src/services/class-generator.ts src/lib/generation.ts
npx vitest run --project unit src/services/class-generator.test.ts -t "a clash during generation"
# observe BOTH failures, record the exact text
git stash pop
```

Stashing breaks compilation of Task 1's own tests — that is expected, which is
why the command is scoped with `-t` to the new describe block.

**Both tests must fail, and they must fail differently:**

| test | expected failure against the stashed generator |
|---|---|
| clash on the **last** free date | `expected false to be true` on `after.isActive` — the *silent* variant. `$transaction` resolved, `{ ok: true, action: 'active' }` came back, the `isActive: true` was rolled back with the transaction. |
| clash on the **first** of two free dates | **throws** — the *loud* variant. `create` raises P2002, `continue` runs, the next read raises `25P02`, which is not P2002 so it is rethrown past Resume's P2025-only `.catch`. |

### STOP CONDITION

**If either test passes against the stashed generator, stop and report.** Do not
proceed, do not adjust the assertion until it goes red, and do not decide the
test is "close enough". A test that cannot fail against the bug it is named for
proves nothing — this project has shipped three such guards before and caught
all three only at review.

The likely causes, in order: the 400 ms window in `raceResumeAgainst` was too
short for the resume to reach its insert and park on the lock; or the fixture
template has a null `teacherRoomId`, so there is no row to lock. Report which
you think it is and hand back.

### Why the lock lever works

Task 2 parks the generator's insert by holding `FOR UPDATE` on the `TeacherRoom`
row. This is not a trick — it is the measured behaviour:

- A Postgres FK check takes `FOR KEY SHARE` on the referenced row.
- `FOR KEY SHARE` conflicts with `FOR UPDATE`, and **does not** conflict with
  `FOR NO KEY UPDATE`.
- `pauseOrResumeTemplate`'s `update` only flips `isActive`, a non-key column, so
  Postgres grants it `FOR NO KEY UPDATE` — which is exactly why the holder can
  work alongside it, and also why this bug is reachable on the Resume path in
  production today.

Both directions were measured before this plan was written. #164's own issue text
says the Resume path is *protected* by that lock; **it is wrong**, and the
correction is in §1.2 of the spec.

---

## 5. Per-task notes the plan does not repeat

**Task 1.** `src/lib/generation.ts` must stay import-free. `@/lib/log` is pino
and server-only, and these type names travel as far as
`src/components/settings/template-action-messages.ts`, which is reached from
`'use client'` components. `src/lib/tiers.ts` and `src/lib/class-fields.ts` are
import-free for the same reason — follow them.

**Task 1, step 7 is not optional.** The spec's §5 says all 16 call sites "read a
number today". That is wrong — most *discard* the return value. Correct the spec
in the same commit. In this project a claim gets fixed in every artifact that
carries it, and the spec is an artifact.

**Task 3.** The studio family has no room FK, and its resume already takes the
`FOR UPDATE` claim (`studio-class-template-lifecycle.ts:352`), so you cannot run
the Task 2 lever against it. That asymmetry belongs to **#116** and you are not
fixing it. Delete the long `try`/`catch` comment at
`studio-class-generator.ts:153-208` in full — it documents a hedge that no longer
exists, and leaving it is worse than leaving nothing.

**Task 4.** Convert the class route's ternary to a `switch`. The studio route
already carries the comment explaining why: a ternary's `else` limb "would have
dropped them silently while staying correct for `unchanged`". You are adding
fields to the `active` arm, which is exactly the case that goes wrong.

**Task 6.** `TemplateToggleResponse`'s `active` arm carries a phantom brand,
`scheduled?: never; added?: never`. It is the only thing stopping
`resolveTemplateConfirmation(studioPayload)` from compiling, and PR review has
measured two live bugs it catches. Giving the class arm real counts makes both
arms structurally identical, so **the brand must be replaced, not deleted** — by
the required `templateKind` discriminator, pinned with `@ts-expect-error` in both
directions. If `tsc` reports either directive as *unused*, the pin is not doing
its job: stop and report.

**Task 6, argument order.** `resumeStudioMessage`'s docblock records that
transposing its arguments once left `tsc` clean and every test green, because
every fixture passed equal numbers. Keep at least one resolver-level fixture with
unequal values or that paragraph stops being true.

**Task 8.** Follow the ledger format of
`docs/superpowers/plans/2026-08-11-cancellation-notice-names-class-mutations.md`:
a table with the **verbatim** assertion text in the `Observed` column. Apply the
mutation, run the named test, record the exact error, `git checkout` the file,
re-run to confirm green. Eight mutations. Mutation 1 is the whole issue and its
two observations are the ones from §4's table.

---

## 6. Hazards that have actually bitten this project

- **`npm run verify` before pushing.** Typecheck, lint, and all three vitest
  projects. A per-diff review cannot see a defect that exists only in the union
  of several diffs — that is how a dark test file and a red lint once reached a
  pushed branch past nine reviews.
- **Green `verify` is not CI.** CI also runs `prisma validate`, a migration-drift
  check, `npm run build`, and Playwright. A build-only defect passes `verify` and
  fails CI. The usual cause is a server-only import reaching a client component —
  see the `@/lib/log` note above.
- **No migration on this branch.** You are not creating any index. The pre-check
  is written to match the predicates #196 *will* use; the constraint itself is
  #196's. If you find yourself editing `prisma/schema.prisma`, you have gone out
  of scope — stop.
- **Never edit an applied migration.**
- **Quote paths with parentheses when staging** — `(public)`, `(teacher)`,
  `(student)`. An unquoted glob over one of these silently matches nothing.
- **Post `gh` prose from `--body-file`, never `--body "…"`.** Backticks inside a
  double-quoted zsh string reach the shell as command substitution even when
  escaped, and it fails *silently* — a comment once published with two file paths
  eaten and nobody noticed until later.
- **Never write `does not close #N`.** GitHub's parser matches `close #N` and does
  not read the negation in front of it; a scope note written exactly that way
  closed an unrelated issue. Write "**#N is unaffected**". Same trap for `fixes`,
  `fixed`, `resolves`, `resolved`, `closed`. You will need this in Task 9's PR
  body for **#116** and **#196**.
- **Rebase-merge, never squash.** The commit-per-task history is the record. (The
  owner does the merge; this is here so you do not "helpfully" squash.)

---

## 7. What done looks like

1. Nine commits on `fix/164-192-generator-slot-reporting`, one per task, on top
   of the two that are already there.
2. Both Task 2 tests were watched failing against the stashed generator, with the
   exact failure text recorded in the mutation ledger.
3. All eight mutations in Task 8 applied, observed failing, reverted, re-verified.
4. `npm run verify` green, with the per-project totals recorded as arithmetic
   (e.g. `N = a unit + b components + c integration`) — that is what turns "every
   integration file ran" from a reassurance into a checkable claim.
5. A PR whose body states what was measured, **including the errors in this
   project's own artifacts**: #164's reachability table row 3 was wrong, its
   silent-commit claim was right and is now measured, and the spec's §5
   call-site claim was wrong and was corrected in Task 1.
6. You stop there and hand back for the review.

## 8. What not to do

- Do not fix **#116** (the class resume does not take the generation claim), even
  though you will read its evidence in the spec. Do not fix **#83**, **#194**,
  **#122**, **#180** or **#103**. They are adjacent and they are not yours.
- Do not add `cancelledAt: null` / `status` to the *own-template* half of the
  probe. #192 rules it out explicitly: `@@unique([templateId, date])` makes that
  a clash rather than a regeneration. The skip is correct; only the reporting was
  wrong.
- Do not reintroduce a `catch` around the insert. There is nothing it can do that
  the constraint does not, and putting one back is the defect.
- Do not change the copy wording in Task 6 beyond what the plan specifies. The
  sentences were agreed with the owner.
- Do not commit `docs/backlog-roadmap.md`.
- If something in the plan looks wrong, **say so and stop** rather than bending
  the code to match it. Four wrong predicted outputs have been caught that way on
  this project; every one was the plan's error, not the implementer's.

---

## 9. Launching

```bash
cd /Users/ivohofland/Projects/fair.yoga
opencode
```

Then give it this, verbatim:

> Read `docs/superpowers/plans/2026-08-11-generator-slot-reporting-handover.md`
> in full before doing anything else, then read `CLAUDE.md`, then execute
> `docs/superpowers/plans/2026-08-11-generator-slot-reporting.md` task by task,
> committing after each. Task 2 step 2 has a stop condition — honour it.
