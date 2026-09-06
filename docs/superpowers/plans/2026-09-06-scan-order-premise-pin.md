# Close the heap-ordered path the forced plan left open — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gdpr-lock-order.test.ts`'s AB-BA premise assertion stops reddening at
random on the merge gate, without becoming vacuous.

**Architecture:** The three `SET LOCAL`s these files share remove one of the two
heap-ordered scan paths Postgres has. Add the fourth (`enable_bitmapscan = off`)
so physical order is unreachable, make the probe plan like the statement it
models, assert the fixture's key assignments as data, and put the plan text in
the failure message.

**Tech Stack:** Vitest (`unit-sweeps` project, serial), Prisma raw SQL,
PostgreSQL 16 in `fairyoga-db-1`.

**Spec:** `docs/superpowers/specs/2026-09-06-scan-order-premise-pin-design.md`
— read §2 before editing; every number below comes from there.

**Task order is load-bearing.** Task 2 measures Task 1's tree.

**Amended during execution, and the amendment reaches this whole document — the
Architecture paragraph above included, not only the steps below.** Task 1's
review overturned one instruction: Step 2 says to add `e."cancelledAt" IS NULL`
to the teacher probe, and the shipped probe does not carry it — that qual is
what makes a partial GiST index an eligible path, and GiST returns no key order.
So the Architecture line "make the probe plan like the statement it models" is
the goal that was *abandoned*: the probe is a fixture check, not a model, and
spec §3.2 records why no probe can be one. The reasoning and what replaced it
are spec §3.2 and §2.5.

The prose is left as it was written, here and in the steps, since a plan is the
record of what was instructed rather than of what shipped. Where a step states a
fact about Postgres that turned out false, the fact is corrected in place.

## Global Constraints

- **Test-only.** No production code, no schema change, no migration.
  `src/lib/db-locks.ts` and `src/services/gdpr.ts` are read, and mutated only
  transiently inside Task 2 (restored and re-verified in the same task).
- **Mirror, do not import.** The planner settings stay written inline per file.
  Recorded decision, `gdpr-lock-order.test.ts:305-307`: *"a test helper crossing
  suites would couple two files whose fixtures are independent."* A file-local
  helper consolidating one file's own sites is not what that forbids.
- **Comments state what is true now** (CLAUDE.md, *Comment Discipline*). No
  "this previously read X". Correction history goes in the PR body.
- **No counts or censuses in comments.** The six-site table is the spec's and
  the PR body's; a comment may say "the same four settings as
  `forceIndexOrderedPlan`", never how many sites carry them.
- **Worktree limits.** `integration` and `e2e` cannot run here (both need the
  dev server on `:3000` and the shared dev DB). Local verification is
  typecheck, lint, `unit`, `unit-sweeps`, `components`; cite the CI run for the
  other two tiers.

---

### Task 1: Close the path, and make the probe model the statement

**Files:**
- Modify: `src/lib/db-locks-lock-order.test.ts` — `forceIndexOrderedPlan` and its docblock
- Modify: `src/services/template-lock-order.test.ts` — `expectPremiseOrder` and its docblock
- Modify: `src/services/gdpr-lock-order.test.ts` — the two probes in the `#174` `it`, the two `$executeRawUnsafe` hooks, and the fixture comments they rest on

**Interfaces:**
- Consumes: `CLASS_TO_ENTRY_JOIN` and `CLASS_TO_WAITLIST_JOIN`, already exported from `src/lib/db-locks.ts`.
- Produces: nothing importable. Task 2 measures this tree.

- [ ] **Step 1: Add `enable_bitmapscan = off` at every site that has the three**

Find them:

```bash
grep -rn 'enable_seqscan = off' src
```

Each hit is either a code site (a `$executeRaw` template, or a
`query(['SET LOCAL …'])` call inside a `$extends` hook) or prose. Add the
fourth setting to every code site, immediately after `enable_seqscan`, in the
same style the site already uses. Leave prose to Steps 5 and 6.

- [ ] **Step 2: Make the teacher probe plan like the statement it models**

In `gdpr-lock-order.test.ts`, the `scanOrder` probe hand-copies
`deleteTeacherAccount`'s pre-lock (`gdpr.ts:1133`) and drops two clauses that
the spec measured as plan-relevant (§2.4). Rebuild it so that:

- the `FROM`/`JOIN` comes from `CLASS_TO_ENTRY_JOIN`, spliced with
  `Prisma.sql`, rather than being retyped — so a change to the fragment the
  production call site passes moves this probe with it;
- the predicate carries `e."cancelledAt" IS NULL`;
- the statement ends `FOR UPDATE OF c`.

The status list stays a literal (`CANCELLABLE_STATUSES_SQL` is module-private
to `gdpr.ts`; §3.2 records why it is not exported for this).

The probe runs before the two holder transactions start, so its row locks are
uncontended — say so in one line beside the `FOR UPDATE`, because a reader will
otherwise ask.

Do the same for the `joinOrder` probe with `CLASS_TO_WAITLIST_JOIN`. That
statement's production twin (`gdpr.ts:440`) passes no extra predicate, so
`FOR UPDATE OF c` is the only clause it gains.

- [ ] **Step 3: Capture the plan, and attach it to the failure**

In the same transaction and under the same settings, run `EXPLAIN` for the
probe statement and keep the text. Pass it as the row-order assertion's message
so a failure prints the plan that produced the order rather than only the two
ids.

Both probes now do the same three things — set the planner settings, `EXPLAIN`,
run — so consolidate them into one file-local helper in this file taking the
`Prisma.Sql` statement and returning `{ ids, plan }`. One helper, two call
sites; this does not cross files.

`EXPLAIN` on a `FOR UPDATE` statement plans without executing and takes no
locks; the row-returning statement that follows takes them.

- [ ] **Step 4: Assert what the fixture assigned, as data**

Before the probes, read the two classes and their entries and assert the three
assignments the fixture makes on purpose (spec §3.3):

- HIGH holds the **lower** `calendarEntryId`
- HIGH's entry holds the **earlier** `date`
- HIGH holds the **higher** `Class.id`

Compare in TypeScript, not in SQL — the point is that no planner decides the
result. The third is the one that looks backwards and is not: the student side's
natural order is `Class.id` ascending, and the premise is that the two sides
disagree.

Each gets its own `expect`, so the failure names which half moved.

- [ ] **Step 5: Replace the claims Step 1 and Step 2 made false**

In `gdpr-lock-order.test.ts`, the comment above `scanOrder` says the forced plan
"is an index scan on `Class_calendarEntryId_key`". Measured, the driving side is
usually `CalendarEntry_teacherId_date_idx` and moves between runs (spec §2.2).
Replace the claim with what is true now: under these settings every remaining
scan path is index-ordered, and the fixture assigns every key those plans order
by. Name no index as *the* one.

The block ending "with `ORDER BY c.id` deleted from the helper the test still
passes 3/3" is a measurement that still holds — Task 2 re-measures it. Keep it.

Replace, do not annotate. No "this previously read X".

- [ ] **Step 6: Replace the same claim in the two sibling files**

`db-locks-lock-order.test.ts`'s `forceIndexOrderedPlan` docblock says the three
settings leave "an index-driven nested loop as the only cheap shape". A
bitmap-driven nested loop is also cheap and also index-*driven* — it is not
index-*ordered*, which is the property the sentence is reaching for. State the
property the settings actually buy: sequential and bitmap scans are the two
paths that return physical order, and both are off, so what is left is an index
or index-only scan. Say **btree** index order, not "index order" — a GiST index
scan is an index scan that returns no key order (`pg_indexam_has_property`), and
this schema has two GiST indexes. Spec §2.5.

`template-lock-order.test.ts`'s `expectPremiseOrder` docblock names "the three
settings"; correct the number-word and the property alongside it.

- [ ] **Step 7: Sweep for what these steps invalidated**

Names and phrases that may now be stale across the three files:

```bash
grep -rn 'three settings\|all three\|only cheap shape\|Class_calendarEntryId_key\|enable_seqscan' src
```

Give every hit a verdict. Expect legitimate survivors — a sentence about
`enable_seqscan = off` discouraging rather than forbidding is still true and
still needed. A sentence claiming three settings suffice is not.

- [ ] **Step 8: Verify — the three files pass**

```bash
npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts src/services/template-lock-order.test.ts src/lib/db-locks-lock-order.test.ts
```

Expected: all three files pass. The two siblings are the ones most likely to
notice a changed plan space, which is why they run here and not only in Step 9.

- [ ] **Step 9: Verify — the whole local surface**

```bash
npx tsc --noEmit && npm run lint && npx vitest run --project unit --project unit-sweeps --project components
```

Expected: clean typecheck, clean lint, all three projects pass. Use
`npm run lint`, not `next lint` (removed in Next 16).

- [ ] **Step 10: Commit**

```bash
git add src/lib/db-locks-lock-order.test.ts src/services/template-lock-order.test.ts src/services/gdpr-lock-order.test.ts
git commit -m "test(lock-order): the fourth setting closes the heap-ordered path the three left open (#470)"
```

---

### Task 2: Prove the premise still bites, and measure what is left

**Files:**
- Modify: `src/services/gdpr-lock-order.test.ts` (only if Steps below find a claim Task 1 left stale)
- Create: nothing committed. Scripts are throwaway; results go in the PR body.

**Interfaces:**
- Consumes: Task 1's tree.
- Produces: the measured numbers the PR body cites.

- [ ] **Step 1: Mutation — delete the clause the test exists to guard**

In `src/lib/db-locks.ts`, delete `ORDER BY c.id` from the statement in
`lockClassRowsOrdered`. Then:

```bash
npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts
```

Record the verbatim failure block — test name, assertion, and message — for the
PR body. A green run here is a **defect in this work**, not a curiosity: it
means the premise has gone vacuous, which is the exact state issue #470 says
must not be reached. Stop and report rather than proceeding.

Note which assertion fails. If it is the `40P01` negation rather than the
premise, that is the stronger result and is worth saying so explicitly.

- [ ] **Step 2: Restore, and re-verify**

Restore the clause. Re-run the command from Step 1 and confirm green. Confirm
`git diff src/lib/db-locks.ts` is empty before going on — the mutation must not
reach the branch.

- [ ] **Step 3: Prove the fourth setting is the one doing the work**

Second mutation, this time of Task 1's own change: remove
`enable_bitmapscan = off` from the two `gdpr-lock-order.test.ts` probes only,
and re-run the sweep from spec §2.1 to confirm the bitmap path reappears in the
plan space. This measures the *setting*, not the test — the test is expected to
stay green, because a knife-edge does not fall the same way on demand. Say
exactly that in the PR body rather than implying the run proves more than it
does (`docs/solve-issue-lessons.md#3`).

Restore afterwards.

- [ ] **Step 4: Residual flake rate**

Run the file repeatedly and report the count honestly:

```bash
for i in $(seq 1 20); do npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts 2>&1 | tail -4; done
```

State the number of runs behind the claim, and state plainly that a local
database is not CI's — CI creates `ethical_yoga_test` fresh with
`prisma migrate deploy` and never seeds it, then runs `--project unit` (parallel,
churning) before `--project unit-sweeps` reaches this file. That churn is the
statistics input the knife-edge reads, and it is not reproducible locally. The
honest claim is "N/N locally, and the plan space no longer contains a
heap-ordered path", not "fixed".

- [ ] **Step 5: Reproduce the spec's §2.2 instability, post-fix**

Re-run the two-identical-sweeps experiment from spec §2.2 with
`enable_bitmapscan = off` added to the sweep's settings. The driving side is
expected to keep moving — that is not what this work fixes. What must hold is
that every shape observed is an index scan, and that its ordering key is one the
fixture assigns. Record the shapes seen and their count in the PR body.

If a `Class_pkey`-driven shape appears, that is spec §4's unreconcilable case:
report it, do not paper over it.

- [ ] **Step 6: Verify the whole local surface again**

```bash
npx tsc --noEmit && npm run lint && npx vitest run --project unit --project unit-sweeps --project components
```

- [ ] **Step 7: Commit**

```bash
git add src/services/gdpr-lock-order.test.ts
git commit -m "test(lock-order): record what the closed path buys and what it does not (#470)"
```

(If Task 1 left nothing stale, this task commits no code — say so and skip.)

---

## Finishing

- PR body carries: the §2.1 bitmap plan, cited as ONE measurement at one
  database state alongside §2.1's four-state table showing the gap's sign
  flipping twice — never as "not preferred" or "27% dearer", which is the
  property framing §2.1 now disowns; the §2.2 two-run table, the §2.4 plan
  mismatch, the Step 1 verbatim mutation failure, the Step 4 run count, the
  Step 5 shapes, and spec §4's residual verbatim. What the fourth setting buys
  is stated as eligibility (the `disable_cost` probe in §2.1's closing
  paragraph), not as a cost advantage. Name by path which `integration` files
  this branch touched (none) and cite the CI run for `integration` and `e2e`.
- Correct issue #470's body: it states that `enable_seqscan = off` "forces an
  index path". It does not — it removes one of two heap-ordered paths. Correct
  it in place rather than appending a comment that contradicts the body.
- **#448 and #459 are unaffected**; say so.
