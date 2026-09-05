# Extracting the lock-staging tests out of `gdpr`, `waitlist` and `class-template-lifecycle`

Issue #459. Design spec.

## 1. What the issue asked, and what measuring it changed

The issue proposes moving the lock-staging tests out of three parallel-tier
files into `*-lock-order.test.ts` siblings, so only the siblings need
`LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`. That direction survives contact
with the code. Six of its supporting claims did not.

### 1.1 The candidate lists are census output, and the census over-reports

The issue's own script attributes a marker to the nearest *preceding* `it()`
line. In these three files the docblock of test *N+1* sits between test *N*'s
closing brace and test *N+1*'s `it(` line, so **every marker in a test's
docblock is attributed to the test above it**. That is the whole explanation
for the "needing a verdict" lists.

Re-running the same idea with the span bounded by the *next* `it()` — the
script is `census.mjs`, reproduced in §8 — and then reading each survivor
gives this:

| File | Issue's candidates | Adjudicated: move |
|---|---|---|
| `gdpr.test.ts` | ~12 | **9 blocks / 13 tests** |
| `waitlist.test.ts` | ~9 | **5 blocks / 5 tests** |
| `class-template-lifecycle.test.ts` | ~8 | **5 blocks / 5 tests** |

Every one of the issue's thirteen "needing a verdict" entries is resolved
below by name, and **eleven of the thirteen stay**.

### 1.2 The headline test counts are `it()` blocks, not tests

The issue reports "31 / 50 / 65 tests". Those are `it()` **block** counts.
Vitest reports **35 / 50 / 66**, because `gdpr.test.ts:517` is an `it.each`
over five statuses (+4) and `class-template-lifecycle.test.ts:1858` is an
`it.each` over two (+1). The issue's own acceptance criterion ("An `it.each`
over five statuses moves as five") uses the vitest sense, so the two halves of
the issue disagree with each other. Both senses are stated for every number in
this spec.

Re-derivation, per file:

```
npx vitest list --project unit <file> | grep -c '^\[unit\]'
```

### 1.3 `waitlist.test.ts:2150` and `:2131` are the same test

`:2150` is the `FOR UPDATE` line *inside* the `it()` block that opens at
`:2131`. The issue lists it once as a confirmed candidate and once as needing
a verdict. One test, not two.

### 1.4 `class-template-lifecycle.test.ts:2929` is mis-attributed by one test

The issue describes `:2929` as "~2 s `FOR KEY SHARE` held while the resume
times out". That is `:3001` ("blocks a concurrent Class insert while
generating, and answers busy"), which the issue's table never lists on its own
— it is only implied by the `:3064` row's "second of the pair originally read
as one test". `:2929` itself stages no lock at all: it interposes a
`scheduleRule.update` through `$extends` and asserts `unchanged`.

### 1.5 The issue's list misses `class-template-lifecycle.test.ts:1028`

"a concurrent delete blocks on the write lock and completes cleanly once the
edit commits" holds a `ClassTemplate` row lock across a promise gate while a
`setLockTimeout`-bounded delete queues behind it, and asserts
`deleteSettled === false` after 300 ms. It appears in no list in the issue.

### 1.6 The acceptance criterion about `vitest.tiers.ts`'s note is wrong

The issue asks for "`vitest.tiers.ts`'s note that files in the parallel tier
still assert on lock outcomes is updated, since this issue is what makes it
untrue."

**It does not become untrue.** Sweeping the whole `unit` include for real lock
machinery —

```
grep -rlnE "SELECT .*FOR (UPDATE|KEY SHARE|NO KEY UPDATE|SHARE)|SET LOCAL lock_timeout|setLockTimeout\(" \
  --include='*.test.ts' src
```

— returns 19 files. Nine are already serial: five on `LOCK_CONTENTION_TESTS`
(`db-locks-lock-order`, `gdpr-lock-order`, `invitations-lock-order`,
`room-archive-lock-order`, `template-lock-order` — the list's other two members
stage contention this grep does not reach, DDL and an insert race) and four on
`SWEEP_TESTS` (`class-transitions`, `studio-class-generator`,
`waitlist-reconciliation`, `waitlist-retention`). Three are this issue's.
19 − 9 − 3 = **seven remain in the parallel tier afterwards:**

- `src/lib/api-errors.test.ts`
- `src/lib/db-locks.test.ts`
- `src/services/class-generator.test.ts`
- `src/services/class-lifecycle.test.ts`
- `src/services/room-archive.test.ts` — already named in the note as a known holder
- `src/services/studio-class-template-lifecycle.test.ts`
- `src/services/transition-class-lock-order.test.ts`

Two of those are near-identical twins of tests this change moves:
`class-lifecycle.test.ts:1232` carries the *same title* as the three waitlist
guards ("gives up on the 2s bound when another transaction holds the class
row"), and `studio-class-template-lifecycle.test.ts:552` is the studio twin of
`class-template-lifecycle.test.ts:2237` ("two concurrent archives: the loser
records nothing over the winner"). And `transition-class-lock-order.test.ts`
carries the `-lock-order` filename convention while sitting in the parallel
tier with no marker and no entry on the list.

So the note is **narrowed and re-pointed**, not deleted: what changes is that
#459 is no longer the open owner of the whole property. A follow-up issue owns
the seven; the comment cites it rather than rostering them (*Comment
Discipline*: a roster of other files has no owner here).

### 1.7 What held

- All 19 line references in the issue point at what the issue says they do,
  against the current tree. No drift.
- The four hazards are all real. Two more are added in §4.
- The `+101%` reasoning for extracting rather than moving whole files holds.
- The serial tier's baseline re-measures at **49.50 s** on this tree
  (17 files, 167 tests), against the 50.19 s the issue recorded. Same number
  within noise; this spec uses its own measurement.

## 2. Direction

Extract, do not move whole files. Three destinations:

| Source | Destination | New file? |
|---|---|---|
| `src/services/gdpr.test.ts` | `src/services/gdpr-lock-order.test.ts` | no — **appends** |
| `src/services/waitlist.test.ts` | `src/services/waitlist-lock-order.test.ts` | yes |
| `src/services/class-template-lifecycle.test.ts` | `src/services/class-template-lifecycle-lock-order.test.ts` | yes |

`gdpr-lock-order.test.ts` already exists, already carries the marker and is
already on `LOCK_CONTENTION_TESTS`. Appending keeps **one sibling per source
file** and avoids inventing a third naming pattern beside `*-lock-order.test.ts`
(five files) and the unsuffixed `roster-link.test.ts`. Its header is rewritten
to state one reason covering the whole file rather than only its original
AB-BA probe.

**Fixtures are duplicated, not shared.** Both prior extractions
(`gdpr-lock-order.test.ts`, `class-lifecycle-tier-guard.test.ts`) build
self-contained fixtures; the only shared helper in this area is
`createClassFixture` (`tests/class-fixtures.ts`), which stays shared. Hoisting
a `makeStudentWaitingInClass` into a shared module is rejected: it is 140
lines of gdpr-specific prose that one remaining test still needs, and moving
it would put the explanation a third file away from both users.

## 3. The adjudication, test by test

Verdicts below are on the **current tree**. "Machinery" means a real row lock,
an injected `lock_timeout`, a second client, or a hold a concurrent operation
must queue behind — not a marker appearing in the next test's docblock.

### 3.1 `src/services/gdpr.test.ts` — 31 blocks / 35 tests

**Moving — 9 blocks / 13 tests:**

| Line | Machinery |
|---|---|
| `:453` | `Class … FOR UPDATE` held 900 ms; `Promise.race` against a 400 ms timer |
| `:517` (`it.each` ×5 → **5 tests**) | same lever, per entry status |
| `:591` | `Registration … FOR UPDATE` held 4 s; asserts `55P03` |
| `:686` | six staggered `Class … FOR UPDATE` on a `connection_limit` client via `pg_sleep`; asserts `elapsedMs > 5_000` |
| `:804` | hand-built AB-BA probe; asserts **neither** side deadlocked, written `toBe('returned')` |
| `:2267` | erasure holds the `Class` row while a registration INSERT queues on its `FOR KEY SHARE` |
| `:2456` | third client takes `Student … FOR UPDATE`; two erasures race under `setLockTimeout` |
| `:2800` | `claimTemplateForGeneration` holds the child row across a promise gate; erasure blocks |
| `:2903` | studio twin of `:2800` |

**Staying — the issue's four "needing a verdict", all four:**

| Line | Why the census flagged it | Verdict |
|---|---|---|
| `:1614` | the word `Promise.all` inside a comment about a past refactor | stays |
| `:1676` | `new PrismaClient` at `:1753` belongs to the *next* describe | stays |
| `:2088` | `new PrismaClient` at `:2177` belongs to the *next* describe | stays |
| `:2685` | `new PrismaClient` at `:2720` belongs to the *next* describe | stays |

Also staying, and flagged by the issue's own script as false positives it
already identified: `:925` (`new PrismaClient` at `:972`, the next describe),
`:2538` and `:2595` (the string `55P03` inside an *injected* error message,
never a real one).

**After:** 22 blocks / **22 tests** (the `it.each` leaves with the batch).

### 3.2 `src/services/waitlist.test.ts` — 50 blocks / 50 tests

**Moving — 5 blocks / 5 tests:** `:556`, `:896`, `:1275` (three `addToWaitlist`
/ `promoteNext` / `claimSpot` guards, each holding `Class … FOR UPDATE` for
3 500 ms on its own `PrismaClient` and asserting `55P03`), `:1777` (900 ms hold,
`Promise.race`), `:2131` (3 500 ms hold, asserts `55P03`).

**Staying — four of the issue's five "needing a verdict":**

| Line | Why the census flagged it | Verdict |
|---|---|---|
| `:493` | the 41-line docblock of `:556` sits inside its span | stays |
| `:1222` | the docblock of `:1275` | stays |
| `:1637` | the whole `removeFromWaitlist takes the class lock (DB)` describe header and `beforeAll` sit inside its span | stays |
| `:2081` | the 36-line docblock of `:2131` | stays |

The fifth, `:2131`, is the `:2150` of the confirmed table — see §1.3.

**After:** 45 blocks / **45 tests**.

### 3.3 `src/services/class-template-lifecycle.test.ts` — 65 blocks / 66 tests

**Moving — 5 blocks / 5 tests:** `:1028` (see §1.5), `:2237` (two concurrent
archives, ~500 ms `FOR UPDATE`), `:2399` and `:3064` (interposed flip under
`SET LOCAL lock_timeout = 1500`, asserting `55P03`), `:3001` (second client
holds `FOR KEY SHARE` ~2 s while the resume's bound expires).

**Staying — the issue's three "needing a verdict", plus two the issue listed
as confirmed:**

| Line | Why | Verdict |
|---|---|---|
| `:887` | markers are in the docblock of `:953` | stays |
| `:953` | markers are in the docblock of `:1028` | stays |
| `:1596` | markers are in a comment, not code | stays |
| `:2338` | **issue listed this as a candidate.** It interposes a `delete` through `$extends`; the archive's own `FOR UPDATE` then matches zero rows and returns at once. Nothing is held, nothing queues, and the assertion is a `not_found` plus a log line — not a contention outcome | stays |
| `:2929` | **issue listed this as a candidate.** See §1.4 — the description belongs to `:3001` | stays |

**After:** 60 blocks / **61 tests** (the `it.each` ×2 at `:1858` stays).

### 3.4 Reconciliation

**Rebased mid-branch.** PR #461 (issue #453's pre-lock scope decoys) merged
while this work was in flight and added four tests across all three files —
`gdpr.test.ts` +2, `class-template-lifecycle.test.ts` +1,
`waitlist.test.ts` +1. Each was re-adjudicated: all four are cross-owner
decoys asserting that a pre-lock's row set is SCOPED to its owner, and none
stages contention. **The moving lists in §3.1-3.3 are unchanged.** Only the
counts and the line numbers move, and the line numbers in this spec are the
pre-rebase ones — the titles are the durable reference.

Counts below are on the rebased tree (branch point `9cd7fd43`):

| File | Before (blocks / tests) | Moved | After (blocks / tests) |
|---|---|---|---|
| `gdpr.test.ts` | 33 / 37 | 9 / 13 | 24 / 24 |
| `waitlist.test.ts` | 51 / 51 | 5 / 5 | 46 / 46 |
| `class-template-lifecycle.test.ts` | 66 / 67 | 5 / 5 | 61 / 62 |
| `gdpr-lock-order.test.ts` | 1 / 1 | +9 / +13 | 10 / 14 |
| `waitlist-lock-order.test.ts` | — | +5 / +5 | 5 / 5 |
| `class-template-lifecycle-lock-order.test.ts` | — | +5 / +5 | 5 / 5 |

Repo-wide test count is unchanged: 37 + 51 + 67 + 1 = 156 before,
24 + 46 + 62 + 14 + 5 + 5 = 156 after.

The pre-rebase numbers, kept because §1.2's argument about the two counting
senses was derived from them: 31 / 35, 50 / 50, 65 / 66 — 152 either way.

## 4. Hazards

The issue names four. All four are real. Two more were found.

**H1 — an inter-test ordering docblock that extraction falsifies.**
`waitlist.test.ts:2025-2031`, the docblock of `:2033` (which stays), says it
runs "between the two tests above and below … and `takes the class row lock
before it counts` re-fills the seat right after this". `:2131` is the test
being moved, so the second half becomes false. Behaviour is unaffected —
`:2033`'s own transaction rolls back — but the sentence must be **replaced**,
not annotated (*Comment Discipline*). The dependency on `:1996` above it is
real and stays.

The same sentence has a copy outside the file:
`docs/superpowers/specs/2026-08-13-waitlist-reconciliation-design.md:410`. That
one is a **record** of a past design and is left alone.

**H2 — prose call-counts.** `class-template-lifecycle.test.ts:153`
("calls makeTemplate 11 times"), `:1179` ("calls makeClass 38 times at runtime
(37 call sites, one of them an `it.each` over 2 statuses)") and `:2484`
("calls makeTemplate 9 times"). Extraction invalidates all three. They are
**deleted, not corrected**: CLAUDE.md's *Comment Discipline* forbids a prose
count outright, and the load-bearing half of each paragraph — that each slot is
spaced wider than any one call's own `durationMinutes`, so
`ScheduleRule_teacher_slot_excl`'s range overlap cannot bite — is a per-call
property that needs no count. `slotTime`'s own `throw` is the tether that
replaces them.

`:3154-3158` explains taking an explicit `'08:00'` because "the last counter
value is spoken for". Removing `:3001` and `:3064` frees two counter slots, so
the workaround stops being *necessary*; it stays *correct*. It is rewritten to
drop the exhaustion claim and keep the reason `'08:00'` is legal.

**H3 — counter-derived fixture slots.** Each describe allocates `ScheduleRule`
slots from a running counter with block-specific spacing (×75 with
`durationMinutes: 60` in `updateClassTemplate`; ×60/60 in `pauseOrResumeTemplate`;
×10/10 for `makeClass` in `archiveOrUnarchiveTemplate`). Copying the wrong
spacing fails at **fixture build** under `ScheduleRule_teacher_slot_excl`, not
as a lock failure, so the error will not look related. The new file allocates
its own counter and its own teacher; each extracted test keeps the spacing of
the block it came from.

**H4 — dead imports.** In `class-template-lifecycle.test.ts`, `setLockTimeout`
(`:14`) loses its last runtime use with `:1028`, and `isTransientDbError`
(`:10`) loses both of its (`:2445` in the `:2399` block, `:3109` in the `:3064`
block). Both must be removed from the import list; `npm run lint` catches them.

**H5 (new) — a describe whose name survives only its extracted test.**
`waitlist.test.ts:1671`, `describe('removeFromWaitlist takes the class lock (DB)')`,
holds exactly two tests: `:1777` (moving) and `:1837` (staying, an interposed
delete with no lock staging). After extraction the block's name describes
nothing it contains. It is renamed to what the remaining test is about.

**H6 (new) — name-based citations of moving tests, in live documents.**
`docs/lock-order.md:1433` cites `gdpr.test.ts`, "waits for a concurrent claim
to release the child row…" — a test that moves. Every live citation naming a
moving test by title or by file must be re-pointed. Records
(`docs/superpowers/plans/`, `docs/superpowers/specs/`) are **not** updated:
they state what was true when written.

The sweep is by title, not by filename — a citation naming the test but not the
file is the one a filename grep misses:

```
grep -rnFf <titles> --include='*.ts' --include='*.tsx' --include='*.md' . \
  | grep -v node_modules | grep -v '^./docs/superpowers/'
```

## 5. Also true, and deliberately out of scope

`class-lifecycle.test.ts:1232`, `studio-class-template-lifecycle.test.ts:552`
and `transition-class-lock-order.test.ts` stage contention in the parallel tier
and are not this issue's files. They are filed as a follow-up rather than
folded in: each needs the same per-test adjudication this spec did for three
files, and doing six files in one branch buries the reconciliation that is this
change's whole acceptance criterion. **#459 is unaffected** by whether they
move.

## 6. Acceptance

1. Neither `gdpr.test.ts`, `waitlist.test.ts` nor
   `class-template-lifecycle.test.ts` stages lock contention or asserts on a
   contention outcome. Re-derived by the §1.6 sweep returning none of the three.
2. Each new sibling carries `@serial-tier lock-contention` in its header with
   its own reason and is on `LOCK_CONTENTION_TESTS`;
   `src/lib/serial-tier-membership.test.ts` passes.
3. The §3.4 reconciliation holds, re-derived with `vitest list`.
4. H1-H6 each addressed.
5. `vitest.tiers.ts`'s note is narrowed per §1.6 and cites the follow-up.
6. The serial tier's new duration is measured against **49.50 s** (§1.7).
7. Every moved test still passes, and each new file passes run alone.

`npm run typecheck` in a worktree reports one error this branch does not own:
`src/components/schedule/class-list.test.tsx(86,5)`, missing `live`. The
generated Prisma client in the shared `node_modules` was built from another
branch's schema (PR #462 adds `CalendarEntry.live`); this branch's
`prisma/schema.prisma` has no such column. CI generates from the branch's own
schema, and `origin/main` is green with the identical file. Typecheck is clean
here iff that is the only line.

## 7. Not doing

- Not moving whole files (the issue's own measurement rules it out).
- Not hoisting fixtures into a shared module (§2).
- Not touching the four files named in §5.
- Not changing any test's behaviour. A moved test's body changes only where a
  name it closed over has to be rebound to the new file's fixture.

## 8. The census script

`census.mjs` — the issue's script with the attribution bug fixed, kept in the
PR body rather than the repo, since its output is a starting point and not a
verdict. Bounds each `it()`'s span by the *next* `it()`, which is what stops a
docblock counting against the test above it. It still produces false positives
(a marker inside a comment) and false negatives (`gdpr.test.ts:2903`, which
holds through a `$transaction` and a promise gate with no `FOR UPDATE` in it).
**No census decides membership. The marker plus
`src/lib/serial-tier-membership.test.ts` is what holds it.**
