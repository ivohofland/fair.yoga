# Handover: implement the waitlist reconciliation plan (#220)

You are picking up #220. The deliverable is one new service of roughly a hundred
lines, one entry in a scheduler array, and seven tests. The code is not hard. What
makes this branch worth care is that **two of its three most natural instincts are
wrong**, and both are wrong in ways that pass review by inspection.

The unusual part first, because it inverts the habit this project trains: **issue
#220's premise is correct.** Every checkable claim in it was verified and held —
which has not been true of any issue worked here so far. Do not go looking for the
error in it; there isn't one. Its problem is that it is **incomplete**, and §1 tells
you exactly where.

**Read in this order, before touching anything:**

1. `CLAUDE.md` — the stack, the data model, the design philosophy. If your harness
   auto-loads `AGENTS.md`, note that it only *links* to `CLAUDE.md`. Read it anyway.
2. `docs/superpowers/specs/2026-08-13-waitlist-reconciliation-design.md` — the design.
   §1.2 is the half the issue misses; §4.3 is the gate; §4.5 is the one that will
   otherwise get "fixed".
3. `docs/superpowers/plans/2026-08-13-waitlist-reconciliation.md` — the plan you
   execute. Four tasks, all full TDD cycles, seven mutations.
4. This file.

You are on branch `fix/220-waitlist-reconciliation`, cut from `main`. Every commit on
it is documentation. `git diff main...HEAD --stat` shows three files, all under
`docs/`. `git status` should be clean except for the untracked
`docs/backlog-roadmap.md`, which stays untracked forever and is **not yours to edit**.

---

## 1. Orientation, and the three things most likely to derail you

`handleSpotFreed` (`src/services/waitlist.ts:630`) is called after a seat frees. It
resolves the waitlist window and takes one of two actions:

- **`auto_promote`** (everything up to the final hour before the cancel deadline) —
  `promoteNext` registers the queue head.
- **`first_come_first_claimed`** (the final hour) — broadcasts to every waiting
  student; first claim wins.

Both callers — `promoteAfterCancel` (`src/app/api/registrations/[id]/route.ts:228`)
and the erasure loop (`src/services/gdpr.ts:654`) — log the failure and swallow it.
Nothing retries. So when the hook fails, **every student queued on that class is
never told a seat opened**, the seat goes unsold, and because per-student price is
`total / sum_of_tier_ratios × student_tier_ratio`, everyone who did attend is billed
more. Nobody involved can tell it happened.

You are building the sweep that makes that recoverable.

**No schema change. No migration.** If you think you need one, that is a plan defect:
stop and report it.

**Do not modify `src/services/waitlist.ts`.** `handleSpotFreed` keeps its exact
signature and behaviour. The whole design rests on the sweep *detecting* and that
function *deciding*. If a task seems to require editing it, stop and report.

### Derailer 1: the unlocked count you must NOT "fix"

`reconcileWaitlists` reads a seat count **outside any lock**, to decide which classes
are worth asking about. This looks exactly like the defect #212 existed to remove —
the branch that merged three days ago, whose spec is one directory over and says an
unlocked count "moves the race rather than closing it."

**Leave it alone.** The distinction is real:

- #212's finding was about an unlocked count used **as a guard** — the thing that
  decides whether to hand out a seat. That is meaningless unlocked.
- This one is **a filter**. It decides only whether to *ask*. `handleSpotFreed`
  re-counts through `readSeatCount` under `lockClassRow` before it acts.

Stale in either direction costs nothing: reads full when actually free, and the seat
waits one more tick (≤1 minute); reads free when actually full, and the hook's locked
count suppresses it, exactly as designed.

Two consequences you must not skip:

1. **It is an equivalent mutant and gets no mutation test.** Breaking it changes no
   outcome. The plan says so, the code comment says so, and if you try to break it and
   observe nothing, that is the design working, not the suite being weak.
2. **The comment explaining this is part of the deliverable**, not decoration. A
   reviewer who reaches that line without it will file a bug against it. The plan has
   the wording; keep it.

### Derailer 2: injected clocks and database clocks are different clocks

Tests place a class in a chosen window by passing `opts.now` — a date in **2099**. But
`Notification.createdAt` is `@default(now())`, so a notification written during the
test is stamped **2026**.

The §4.3 gate asks `createdAt >= claimWindowStart`, and a 2026 timestamp is not inside
a 2099 window. **Any test that needs the gate to *see* a notification must set
`createdAt` explicitly on create.** The plan's Task 2 Step 1 does this; if you write
another such test, do the same.

This is not a bug in the gate. In production both clocks are the same clock.

Related, and equally load-bearing: **never hard-code a window boundary.** Derive every
test timestamp from `classStartInstant(...)`, as the plan's `windowClocks()` helper
does. A literal like `2099-05-31T07:30:00Z` assumes the IANA database still projects
European summer time the same way in 2099. Deriving is correct whatever it projects.

### Derailer 3: half this branch fixes something the issue never mentions

Issue #220 analyses the **broadcast** branch, and correctly identifies it as a
regression introduced by #212 — before that branch the broadcast ran on a bare client
and blocked *unboundedly*, so it always eventually fired; now it aborts at
`lockClassRow`'s 2s `SET LOCAL lock_timeout` with `55P03` and is dropped.

The **`auto_promote`** branch has the same one-way loss and the issue does not mention
it. `promoteNext` runs in a bare `db.$transaction(...)` with no options, so it carries
Prisma's **default 5s** budget while its first statement is an unbounded inline
`FOR UPDATE`. Measured on 2026-08-13 against a 7s hold:

```
window                  = auto_promote
elapsedMs               = 7014        <- waited out the FULL hold, then failed
error                   = P2028 Transaction already closed:
                          timeout was 5000 ms, however 7001 ms passed
isTransientDbError      = true
waitlistEntry.status    = waiting
registration            = NONE
notifications           = 0
```

**Two things follow, and both must reach the PR body:**

1. This half is **pre-existing, not a #212 regression**.
   `git diff 638c25c HEAD -- src/services/waitlist.ts` shows `promoteNext`
   byte-identical across that branch. Do not let the PR body imply #212 caused it.
2. The two branches fail through **different mechanisms** — a Postgres `lock_timeout`
   (`55P03`) versus a Prisma client-side transaction budget (`P2028`). Any test
   comment that treats them as one thing is wrong. This is also why the auto-promote
   test needs a **7s** hold and the isolation test needs **3.5s**: 3.5s is past the 2s
   Postgres bound but under the 5s Prisma one, which is what selects the mechanism.

---

## 2. Before you start — verify, don't assume

Every line reference below was correct when this was written. Check them; if one has
drifted, fix the plan's reference as you go and say so when you hand back.

```bash
# 1. The hook and its two swallowing callers are where the plan says.
grep -n "export async function handleSpotFreed" src/services/waitlist.ts     # 630
grep -n "async function promoteAfterCancel" src/app/api/registrations/\[id\]/route.ts  # 228
grep -n "await handleSpotFreed(db, classId)" src/services/gdpr.ts            # 656

# 2. The scheduler has five jobs, and the overlap guard exists.
grep -c "name: '" src/lib/scheduler.ts        # 5 job names
grep -n "if (job.running) return" src/lib/scheduler.ts                       # 138

# 3. The seat-occupying statuses, and the helper you must NOT call unlocked.
grep -n "ACTIVE_REGISTRATION_STATUSES" src/lib/registration-status.ts        # 58
grep -n "export async function readSeatCount" src/services/capacity.ts       # 93

# 4. The atomicity the gate depends on — all-or-throw, no skipDuplicates.
grep -n "no .skipDuplicates., so the insert is all-or-throw" src/services/waitlist.ts  # ~733

# 5. The new module does not exist yet.
ls src/services/waitlist-reconciliation.ts    # expected: No such file or directory

# 6. The database is up. You need it for every test in this plan.
docker ps --format '{{.Names}}\t{{.Status}}' | grep fairyoga-db-1            # Up (healthy)

# 7. The dev server is up. You need it for `npm run verify`; you must NOT start it.
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health    # 200
```

If #7 returns anything but `200`, **stop and ask the user to start it**. Do not start
or restart it yourself — it serves this checkout and the integration project talks to
it over HTTP.

---

## 3. If you are not running under Claude Code

This plan was written in a harness with a skills system and a specific tool set. If
yours differs, the substance is unaffected, but four things are on you:

- **There is no skill to invoke.** Everything you need is in the four documents listed
  at the top. Read them; do not go looking for a process to load.
- **TDD ordering is not optional here**, and no harness will enforce it. Each step in
  the plan is ordered write-test → watch-it-fail → implement → watch-it-pass. A test
  you never watched fail has proved nothing, which is the single most common way this
  project has shipped a guard that could not bite.
- **The mutations are deliverables.** §5 below explains why. Record the *exact* error
  text each one produces; "it failed as expected" is not a record.
- **Commit per task, not at the end.** The commit-per-task history is the record this
  project merges by — the PR is rebase-merged, never squashed.

---

## 4. Task order, and what is actually independent

Four tasks. **Two of the orderings are load-bearing** and the rest is preference.

| Task | Deliverable | Order constraint |
|---|---|---|
| 1 | `reconcileWaitlists` — detection + the auto-promote half | first: everything else edits this function |
| 2 | The `first_come_first_claimed` broadcast gate | after 1 |
| 3 | Per-class error isolation | **after 1 and 2** — its test needs two candidates with one contended, which is cheap to build only once detection and the gate exist |
| 4 | Register the job; correct the docs it makes stale | **last, and this one matters** |

**Why Task 4 is genuinely last:** adding the entry to `src/lib/scheduler.ts` starts the
sweep running against the **dev** database every 60 seconds. Doing that while the logic
is half-written means an incomplete sweep mutating the user's development data on a
timer. Leave it until the tests are green.

Tasks 2 and 3 both edit the same loop in the same function. That is fine — they are
sequential, not parallel. Do not try to run them concurrently.

---

## 5. The stop conditions that matter most

### The mutations are the deliverable, not busywork

This project has shipped guards that existed and could not fail — three of them on
#39, all caught only at PR review: a `satisfies` clause that pinned membership but not
completeness, nine pinned prices that could not detect a tie-break flip, and a
throwing helper whose call site could be reverted without breaking a single test.

For each mutation in the plan: **break it, run, record the exact error text, restore,
re-run and confirm green.** Four of the seven are worth calling out.

### Task 2 Step 6 is the most important test in the branch

It forces the gate to `return true` — permanently closed. That mutation **passes** the
"does not double-broadcast" test perfectly, while the sweep delivers nothing to
anyone. That is the exact defect this whole branch exists to remove, reintroduced one
level up.

Guards normally get tested in the direction that *fires*. The direction that *never
stops firing* is where the expensive bugs live, and it is invisible to a suite that
only checks suppression. If you skip one mutation, do not let it be this one.

### Task 1 Step 10 fails on exactly one fixture, and that is the point

The mutation changes `activeByClass.get(cls.id) ?? 0` to `?? cls.maxStudents`. Three
of the four tests still pass. Only `reconciles a class with a waiting entry and no
active registration` catches it — because Prisma's `groupBy` emits **no row** for a
class with no matching registrations, so a wrong default silently excludes exactly the
emptiest classes, which are the ones most obviously in need of reconciling.

If that mutation does **not** fail, your fixture has an extra active registration in
it and the test is not testing what it claims.

### A wall-clock assertion is not a proposition about locks

`src/services/waitlist.test.ts:1622-1628` records a test that raced the hook against a
400 ms timer and asserted "did not finish". Under CPU load, with the lock deleted, it
reported a **PASS in 4 runs out of 5** — instrumented, the hook had not yet reached its
`FOR UPDATE` when the verdict fired at 552 ms. Slowness manufactured the evidence, and
CI has fewer cores than the machine that measured it.

So: assert an outcome slowness cannot produce — a SQLSTATE, a row that exists or does
not. Hold the row with a **separate `PrismaClient`**, and assert the holder had not
released before the call under test returned.

### Let the plan be wrong

If a predicted output does not match, or a step cannot be written as described, that is
information — surface it rather than bending the code to match a wrong instruction.
Subagents on earlier branches caught four wrong predicted outputs that way. Say what
you found and what you did instead.

---

## 6. Hazards that have actually bitten this project

- **Never write the negated form of a closing keyword next to an issue number.**
  GitHub's parser matches `<keyword> #N` and does not understand the negation in front
  of it. A PR body scope line reading *"Does not \[keyword] #113 or #122"* closed issue
  113 on merge. Write "**#N is unaffected**" or "**leaves #N open**".

  **And this applies to explaining it, too.** Five minutes after 113 was reopened, the
  commit written to document the trap closed it *again*, because it quoted the
  offending line verbatim to explain it. If you need to reproduce the phrase, break the
  token — separate the word from the number, or drop the `#` and write it as prose.
  This bullet does both, deliberately.

- **Never `git add -A` or `git add .`** — stage exact paths. The untracked
  `docs/backlog-roadmap.md` must never be committed.

- **Quote paths containing parentheses** — `(public)`, `(teacher)`, `(student)`. An
  unquoted variable over one of these silently matches nothing. `promoteAfterCancel`
  lives under `src/app/api/registrations/[id]/`, so quote or escape the brackets too.

- **`@/lib/log` is pino and server-only.** You import it in Tasks 3 and 4. Both
  importers are services, never reached by a `'use client'` component, so this is safe
  — but do not add that import anywhere else without checking the whole transitive
  chain. A build-only failure of this kind passes `npm run verify` and fails CI.

- **Never start or restart the dev server on :3000.** The user runs it.

- **Post `gh issue` / `gh pr` prose from a `--body-file`, never `--body "…"`.**
  Backticks inside a double-quoted shell string reach zsh as command substitution even
  escaped, and it fails *silently* — a real `gh issue comment` succeeded, returned a
  URL, and published a sentence with two file paths eaten.

- **Never edit an applied migration.** Not relevant here, since this branch adds none,
  but it is the rule that makes "stop and report" the right move if you think you need
  one.

---

## 7. Running the tests

Inner loop, single file by explicit path:

```bash
npx vitest run --project unit src/services/waitlist-reconciliation.test.ts
```

Full gate, once, at the end of Task 4:

```bash
npm run verify
```

`verify` runs typecheck, lint, and **all three vitest projects** — so a green result
means the whole integration suite ran, not merely the unit tests. It needs the app
already on :3000; without it you get a wall of `ECONNREFUSED`, which means the server
is down, not that your branch is broken.

Green `verify` is a strong signal, **not** a substitute for CI. CI additionally runs
`prisma validate`, a migration-drift check, `npm run build`, and Playwright — so a
build-only defect passes locally and fails there.

### Expected counts

**Measured on this branch on 2026-08-13, not inherited from an earlier document:**

| Project | Files | Tests |
|---|---|---|
| unit | 50 | 708 passed + 2 todo = 710 |
| components | 37 | 202 |
| integration | 28 | 392 |
| **total** | **115** | **1302 passed + 2 todo = 1304** |

`50 + 37 + 28 = 115` and `710 + 202 + 392 = 1304`. Both reconcile, which is what makes
these checkable rather than decorative.

This plan adds **one unit file with seven tests**, so the expected figure afterwards is
**116 files, 1309 passed + 2 todo = 1311**.

**Measure it; do not trust that prediction.** The equivalent prediction in the previous
handover was wrong — it said 1294 and the real figure was 1296, because that branch's
own review added two tests the prediction could not have known about. Yours will
probably move too. The number that goes in the PR body is the one you observed.

### This branch touches no integration file

It adds a service and a scheduler entry, neither reachable from `tests/integration/`.
Task 4's `npm run verify` **runs** all 28 integration files; that is not the same as
**changing** any, and the PR body must not claim otherwise.

Do not hand-list integration files anywhere. The sweep covers them, and hand-listing is
what left 20 of 26 unobserved on #170.

### Alarming output that is not a failure

The suite prints pino JSON at `level: 50` (error) during normal runs — email-fallback
send failures, scheduler sweep failures, invalid-timezone warnings. These are tests
exercising their error paths. Judge by the final summary, not by the presence of red
JSON.

Your own Task 3 test adds one more: a `warn` line reading
`waitlist reconciliation failed for one class`, carrying a `55P03`. That one is the
test working.

---

## 8. What done looks like

1. Four commits, one per task, each with its tests green at the time it was made.
2. Seven mutations run, each with its exact error text recorded.
3. `npm run verify` green, with the observed counts written down.
4. `docs/lock-order.md`'s `lockClassRow(` caller count **re-derived** and restated —
   run the grep, do not copy a number out of the plan.
5. `docs/audits/2026-07-18-review-round-2.md:75` marked answered.
6. The branch pushed and a PR opened.

### The PR body must record

- That **every** inherited claim from #220 was checked and **held** — with the pricing
  arithmetic shown (`8 students → €7.22 each; 7 students → €8.10 each; +12.1%`, against
  `roomCost 35, minRate 15, targetRate 25, minStudents 1, maxStudents 10`, uniform
  tier 3), so a reader can re-derive it.
- The `P2028` measurement, and explicitly that the `auto_promote` half is
  **pre-existing rather than a #212 regression**, with the `git diff 638c25c HEAD`
  evidence.
- The two limitations accepted by design: the duplicate-notification race in §4.3, and
  the double-failure-in-one-claim-window case.
- Which suites ran, with the arithmetic that proves the integration suite ran in full.
- What this PR does **not** do — phrased as "**#N is unaffected**" for #104, #219 and
  #221. Re-read §6's first bullet before writing that section; it is the one place the
  natural phrasing walks straight into the trap.
- Your own errors, if any. The plan's self-review already records one deliberate
  deviation from the spec (§5's T1 held-row broadcast test, replaced by an unheld one
  plus the auto-promote end-to-end). Leave that visible rather than quietly conforming.

### What to report when you hand back

- Any line reference in §2 that had drifted, and what you changed it to.
- Any plan step whose predicted output did not match, and what actually happened.
- The seven mutation results, with their error text.
- The observed test counts.
- Anything you found that is a real defect but out of scope — do not fix it, and do not
  file it either. Report it and let the user decide; this project tracks its
  issue-open-versus-close ratio deliberately.

---

## 9. Final checklist

- [ ] Read `CLAUDE.md`, the spec, and the plan before opening a source file
- [ ] `docs/backlog-roadmap.md` still untracked and unmodified
- [ ] No migration, no schema change
- [ ] `src/services/waitlist.ts` unmodified
- [ ] The unlocked pre-filter left alone, with its comment intact (Derailer 1)
- [ ] Every test timestamp derived from `classStartInstant`, none hard-coded
- [ ] Seven mutations run, restored, and re-verified green
- [ ] Task 4 done last, after the tests were green
- [ ] `npm run verify` green; counts observed and written down
- [ ] `docs/lock-order.md` count re-derived, not copied
- [ ] PR body says "#N is unaffected", never the negated closing keyword
