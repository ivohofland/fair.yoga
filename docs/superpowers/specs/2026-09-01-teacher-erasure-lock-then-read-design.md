# `deleteTeacherAccount`: lock the classes before reading them, not after

Issue #367 (spun out of #229's implementation review, itself a sub-issue of
#383).

## 1. The problem, as measured

`deleteTeacherAccount` (`src/services/gdpr.ts`) cancels every upcoming class
before erasing the teacher. Today that happens in three statements, in this
order, inside one transaction:

1. `tx.class.findMany({ where: { calendarEntry: { teacherId, cancelledAt:
   null }, status: { in: CANCELLABLE_STATUSES } }, orderBy: { id: 'asc' },
   select: { id, calendarEntry: { id, classType, date, startTime } } })` —
   line 1033. **Unlocked.** This is `upcoming`, the set the cancel loop
   iterates.
2. Two raw `SELECT ... FOR UPDATE OF ct` / `FOR UPDATE OF sct` statements
   locking `ClassTemplate`/`StudioClassTemplate` rows for this teacher — line
   1092-1103 (#229).
3. `lockClassRowsOrdered(tx, { join: ... CalendarEntry e ..., where: e."teacherId" =
   ${teacherId} AND e."cancelledAt" IS NULL AND c.status IN
   (${CANCELLABLE_STATUSES_SQL}), entries: true })` — line 1197. This
   re-evaluates the **same predicate** as step 1, fresh, and locks whatever
   matches at that moment.

Steps 1 and 3 are two different snapshots. A class created (or rescheduled
into a cancellable status) between them is absent from `upcoming` — so the
loop never visits it — but present in step 3's fresh predicate, so it gets
locked anyway. Concretely: **locked for the rest of the transaction, never
cancelled, orphaned under a teacher whose account no longer exists.** Not a
performance nit — a live defect on an Article 17 path. The gap already
existed before #229 (the code says so, at gdpr.ts:1157-1164, "What still
escapes, stated plainly"); #229 widened it by inserting the two template
locks — up to 4s of lock wait — between steps 1 and 3.

## 2. Why the issue's proposed fix is rejected

The issue proposes replacing steps 1 and 3 with one hand-written
`tx.$queryRaw<UpcomingClass[]>` doing `SELECT ... FOR UPDATE OF c, e`, reading
and locking in the same statement. Rejected, for two independent reasons
found while reading `db-locks.ts` and `docs/lock-order.md`:

**It duplicates a raw-SQL lock statement that already has one home.**
`db-locks.ts` states the rule directly: *"Every `SELECT … FOR UPDATE` on a
`Class` or `CalendarEntry` row goes through [`lockClassRow`] or
[`lockClassRowsOrdered`] now — no site keeps its own inline statement."* That
property is pinned by a re-derivable grep, kept identically in **two**
files (`db-locks.ts`'s own docblock and `docs/lock-order.md`'s "Ordering
BETWEEN `Class` and its `CalendarEntry`" section), both asserting "expect
FIVE lines." A sixth inline `FOR UPDATE` breaks both censuses and needs its
own justification the way `room-archive.ts`'s false-positive sixth line
does — for a statement that is a real `Class` lock, not a false positive, no
such justification exists.

**It changes the lock-acquisition topology in a way nothing in this
codebase has tested.** Every existing site that locks both `Class` and
`CalendarEntry` does it as **two statements naming two tables** — lock every
`Class` row ascending, *then* lock every `CalendarEntry` row ascending
(`lockClassRow`'s docblock: *"TWO STATEMENTS NAMING TWO TABLES, not one
join... a statement that waited on the join's non-locked member has already
evaluated its predicate against the pre-wait snapshot"*). A single `FOR
UPDATE OF c, e` on a joined query instead locks per row as the join is
evaluated — `c1, e1, c2, e2, ...` — a different interleaving than "every `c`,
then every `e`." Whether that composes safely with the rest of
`docs/lock-order.md`'s "Class first, then CalendarEntry, always" discipline
is an open question nothing here answers, on the one transaction in the
codebase that has *already* self-deadlocked existing tests once from a
statement-order change (`2a19ccd2`, cited in gdpr.ts:1151-1155). Not the
place to introduce an unverified locking pattern.

Neither objection is about raw SQL being wrong — this codebase's locking is
necessarily raw SQL, Prisma has no `FOR UPDATE`. The objection is that the
issue's raw SQL (a) duplicates instead of reuses, and (b) picks an untested
topology for the enrichment when the enrichment doesn't need raw SQL at all.

## 3. The chosen design: mirror `deleteStudentAccount`

`deleteStudentAccount`, four functions above this one in the same file,
already has this exact shape, and it is the pattern this design adopts
wholesale rather than inventing a new one:

```
await lockClassRowsOrdered(tx, { join: ..., where: ... });   // lock first
const waitingClassIds = (await tx.waitlistEntry.findMany({    // read after,
  where: { studentId, status: 'waiting' },                    // under the
  select: { classId: true },                                  // rows this
})).map((w) => w.classId);                                     // tx now holds
```

(gdpr.ts:433-448, comment: *"Read AFTER the lock rather than before it —
under the rows this transaction now holds, so it cannot see a queue another
writer is mid-change."*)

`deleteTeacherAccount` becomes:

1. `setLockTimeout(tx)` + the two template locks — **unchanged**, same two
   raw statements, same position (now the transaction's first two
   statements, since nothing precedes them any more).
2. `const lockedIds = await lockClassRowsOrdered(tx, { join: ... CalendarEntry
   e ..., where: e."teacherId" = ${teacherId} AND e."cancelledAt" IS NULL
   AND c.status IN (${CANCELLABLE_STATUSES_SQL}), entries: true })` —
   **unchanged call**, moved to run immediately after the template locks,
   before any class-level read.
3. **New**, replacing the old `upcoming` read:
   ```ts
   const upcoming = await tx.class.findMany({
     where: { id: { in: lockedIds } },
     orderBy: { id: 'asc' },
     select: {
       id: true,
       calendarEntry: { select: { id: true, classType: true, date: true, startTime: true } },
     },
   });
   ```
4. The cancel loop — **unchanged** — iterates `upcoming`, exactly as today.

`lockClassRowsOrdered`'s signature, `db-locks.ts`, and its other three
callers (`deleteStudentAccount`, `withdrawWaitingEntriesForTeacher`,
`archiveOrUnarchiveTemplate`) are untouched. No new raw SQL is written
anywhere. The FOR-UPDATE census in `db-locks.ts` and `docs/lock-order.md`
stays at five lines — the call site moved, the statement didn't change.

**Why this closes the gap exactly as the issue wants.** `lockedIds` comes
from the lock statement's own fresh snapshot. The new `upcoming` read is
scoped to `id: { in: lockedIds } }` — nothing more, nothing less — so lock
set and read set are identical by construction, the same guarantee the
issue's atomic statement would have given, achieved by reading rows this
transaction already holds instead of merging lock and read into one
statement. A class created after `lockClassRowsOrdered` runs is in neither
set — the one residual the issue itself accepts as inherent to any
read-then-transact system, now correctly narrowed to "after the one lock
statement" instead of "after an unlocked read taken earlier, with a widening
template-lock delay in between."

**Ordering note.** `deleteStudentAccount` locks `Class` with no `entries:
true` (it never reads or writes `CalendarEntry` — see its own VERDICT
comment); `deleteTeacherAccount` needs `entries: true` because its read
pulls `classType`/`date`/`startTime`, all on `CalendarEntry` since #327,
and its later write is `CalendarEntry.cancelledAt`. That part is already
correct in the current code (line 1191-1196's VERDICT comment) and is kept.

## 4. What this design does NOT touch

Worth stating plainly, because it's the difference between a bounded fix and
a rewrite of the file's locking:

- `db-locks.ts` — no changes. `lockClassRowsOrdered`'s signature, body, and
  the other three call sites are untouched.
- `db-locks.test.ts`, `db-locks-lock-order.test.ts` — no changes expected;
  neither calls `deleteTeacherAccount`.
- `gdpr-lock-order.test.ts` — the deadlock reproduction test races the two
  `lockClassRowsOrdered` pre-lock statements (teacher vs. student) directly,
  via a forced query plan hook on `setLockTimeout`'s `$executeRawUnsafe`
  call (gdpr-lock-order.test.ts:37, 185-191: *"the test does not need to
  reach inside [`deleteTeacherAccount`] ... rides that one statement to set
  the plan for its whole transaction"*). `setLockTimeout` is still the first
  raw statement issued by the transaction under this design (the old
  `upcoming` read was a plain `findMany`, never a raw statement, so it was
  never "riding" anything) — this test's mechanism is unaffected. Confirm by
  running it, not by inspection alone (see §6).
- The per-class CAS (`calendarEntry.updateMany` at gdpr.ts:1236) and the
  registration/waitlist re-read under it (lines 1297-1332) — unchanged.
  These remain correct and are kept as defense-in-depth even though §5 below
  finds their "concurrent completion" trigger condition can no longer occur
  once the lock runs first.
- The template-claim serialization tests (`deleteTeacherAccount serialises
  against a claim in progress`, `... studio claim in progress`, #315) —
  these assert the whole transaction waits behind a held `ClassTemplate`/
  `StudioClassTemplate` row, using a release-flag mechanism external to the
  read/lock statements this design reorders. Unaffected.

## 5. Test impact: two races this design closes, not just narrows

Two existing tests in `gdpr.test.ts` inject a concurrent write into the
window between the *old* unlocked `upcoming` read and the *old*,
later-running class lock. That window is exactly what this design removes —
locking now happens before any class-level read at all — so both tests'
injection mechanism no longer has anywhere to land. This is a larger blast
radius than "re-point a discriminator"; each needs its racing mechanism
reconsidered, not just its hook's `where`-shape check updated.

### 5.1 `'leaves a class that completed after the erasure read alone, and still erases'` (gdpr.test.ts:1387)

Today: hooks `class.findMany`, discriminates "the transaction's read" by
`status` being an `{ in: [...] }` object (vs. the pre-transaction sweep's
bare `status: 'in_progress'`), and on that call injects a concurrent
`prisma.class.updateMany({ where: { id: classId }, data: { status:
'completed' } })` — a genuinely separate, immediately-committing write,
because at that point in the *old* code nothing has locked the row yet.

Under this design, the transaction's only `class.findMany` (the new,
lock-scoped read) runs **after** `lockClassRowsOrdered` has already taken
`FOR UPDATE` on this row (assuming it was still cancellable, which it must
be to appear in `lockedIds`). The hook's injected `updateMany` would now
have to acquire a lock this transaction already holds — it blocks instead of
completing, and the race the test depends on can't be constructed the same
way; the test needs to be re-verified against the new code to see its exact
failure mode (hang vs. timeout) before deciding the replacement mechanism,
not assumed.

**What replaces it.** The scenario "CAS predicate doesn't match the row it
expected" (line 1245's `cancelled.count === 0` branch, with `observedStatus:
'completed'`) is worth keeping direct coverage for — it's real
defense-in-depth even though this design removes its only known live
trigger. Construct it directly instead of via a timing race: mock
`lockClassRowsOrdered` (`vi.mock('@/lib/db-locks', ...)`, spying/wrapping the
real implementation) to return an id whose class is **not** actually in a
cancellable status, simulating a hypothetical future disagreement between
the lock set and the CAS's live re-check. This asserts the warn-and-skip
path fires correctly without depending on a race window that no longer
exists — and is a more direct proof of "the guard bites" than a timing race
ever was (`docs/solve-issue-lessons.md#3-prove-every-guard-bites`).

Also update the discriminator: the new read has no `status` field at all
(filtering now happens entirely in `lockClassRowsOrdered`'s SQL predicate),
so "is this the transaction's read" needs a different shape check — e.g. the
presence of `id: { in: [...] } }` in `where` — if any hook on
`class.findMany` is still needed once the mock-based replacement above is in
place. It may not be: if the CAS-mismatch scenario is fully covered by
mocking `lockClassRowsOrdered`, this test no longer needs to hook
`class.findMany` at all.

### 5.2 `'tells a student who registered after the class read but before the cancel'` (gdpr.test.ts:1653)

Today: same discriminator, and on the transaction's read, injects a new
`Registration` for a second student via `lockClassRow(tx, classId)` +
`registration.create` in a **separate** transaction. The comment states the
premise directly: *"It cannot block here: the erasure has not reached its
own CAS yet, so nothing holds this row"* (line 1675-1676) — true only
because in the old code, at the moment this hook fires, `lockClassRowsOrdered`
hasn't run yet.

Under this design that premise is false: by the time the transaction's
`class.findMany` runs, `lockClassRowsOrdered` already holds the row. The
injected transaction's own `lockClassRow(tx, classId)` call would block
behind it. More importantly, the same is true for **any** real concurrent
registration attempt during the live transaction, not just this test's
injection: Postgres takes an automatic `FOR KEY SHARE` lock on the
referenced `Class` row for any INSERT with a foreign key into it (the same
mechanism `docs/lock-order.md`'s advisory-lock section calls "the fourth
path"), and `FOR KEY SHARE` conflicts with `FOR UPDATE`. So this design
doesn't just close the test's specific race — it closes the underlying
race in production: **no registration can land on a class this transaction
has locked, for as long as the transaction runs.** The #174 fix this test
pins (re-reading recipients under the lock, lines 1297-1332, rather than
from a stale eager-load) remains correct and stays in place, but the
specific "registered in the gap, still got notified" scenario it was built
to prove can no longer occur — there is no more gap for a registration to
land in.

**What replaces it.** Re-verify against the new code first (§6) to see
whether the injected `lockClassRow` call blocks, times out, or errors.
Likely replacement: assert the **positive** structural property directly —
that a concurrent registration attempt, raced against a real
`deleteTeacherAccount` call, either (a) blocks until the erasure transaction
completes and then is rejected by whatever application-level guard refuses
registration on a cancelled/terminal class (if one exists on this path), or
(b) is a scenario that no longer needs its own test because it is now
subsumed by the ordinary "locked rows serialize concurrent writers" property
`gdpr-lock-order.test.ts` and the `#315` claim-serialization tests already
prove for this same transaction. Decide which during implementation, once
§6's empirical run shows the actual failure mode — don't guess it from
prose.

### 5.3 Everything else in `gdpr.test.ts`

The remaining `deleteTeacherAccount` describe blocks (`cancels future studio
classes`, `notifies whoever is registered` — the *positive* half of that
block, the parts of it not covered by 5.2 — `refuses to erase an
already-erased profile`, `serialises against a claim in progress` ×2, the
composed-route-order test) call `deleteTeacherAccount` without hooking
`class.findMany` at all, or hook something else entirely (the template-claim
tests hold a `ClassTemplate`/`StudioClassTemplate` row via an external
release flag). Expected to pass unmodified; verify by running the full file,
not by this enumeration alone.

## 6. Verification the plan must include

Per this project's "prove every guard bites" discipline, no test rewrite in
§5 gets designed from prose reasoning alone:

1. Run `gdpr.test.ts` and `gdpr-lock-order.test.ts` green on the current
   code first — the measured baseline.
2. Apply the statement reorder from §3 alone (no test changes yet). Run both
   files again. Record the **exact** failure mode of the two tests named in
   §5.1 and §5.2 — error text, hang-vs-timeout, which assertion fails first.
   This is the evidence the replacement mechanism gets designed against, not
   assumed.
3. Build each replacement per §5's direction, confirm it fails when the §3
   fix is reverted (proving it actually exercises something), then confirm
   it passes with the fix in place.
4. Run `gdpr-lock-order.test.ts`'s deadlock reproduction unmodified, confirm
   still green (validates §4's "unaffected" claim rather than asserting it).

## 7. Documentation to correct

**`gdpr.ts` inline comments**, lines 1007-1204 (the whole passage
surrounding the old `upcoming` read and the pre-lock): the "What still
escapes, stated plainly" paragraph (1157-1164) describes a gap this design
closes — it needs to state the new, narrower truth (only a class created
after the single lock statement escapes) or be removed if nothing is left
to say. The surrounding paragraphs narrating *why* the pre-lock was placed
after the read (1113-1155, referencing the plan-vs-shipped swap from
`2a19ccd2`) describe a structure that no longer exists once the read moves
to after the lock — replace with what's true now, not "this used to read
X" (Comment Discipline, CLAUDE.md). Per that same discipline, correct these
by replacing the claim, not annotating it with its history — the history
belongs in this spec and the PR body.

**`docs/lock-order.md`**, line 1618-1627 (the `deleteTeacherAccount` bullet
in "Known conformance"): currently reads *"`Class`, via an ordered
`lockClassRowsOrdered` pre-lock ... taken before the cancel loop and first
in the transaction (#237)."* This is already stale against the *current*
shipped code independent of this change — the two template locks (#229,
which landed after this passage was written) run before it, so it is not
"first in the transaction" today. Found while reading this document for
this spec, not introduced by this change — correct it as part of this PR
since it's the same passage this design's own reorder touches: describe the
new order (template locks, then the class+entry pre-lock as the transaction's
*second* lock acquisition and now also its first class-level read of any
kind, then the lock-scoped `upcoming` read, then the loop).

No changes needed to `docs/lock-order.md`'s FOR-UPDATE census sections
(§"Ordering BETWEEN `Class` and its `CalendarEntry`", "expect FIVE lines") —
per §3, no statement is added, removed, or given new raw SQL; one existing
statement's call site moves earlier in the same function.

## 8. Acceptance

- The old unlocked `tx.class.findMany` reading `upcoming` (gdpr.ts:1033-1054)
  is gone. `lockClassRowsOrdered` (unchanged call) runs immediately after
  the template locks. A new `tx.class.findMany({ where: { id: { in:
  lockedIds } }, orderBy: { id: 'asc' }, select: {...} })` replaces it,
  reading only rows this transaction already holds.
- `lockClassRowsOrdered`'s signature, `db-locks.ts`, and its other three
  callers are unchanged. No new raw SQL statement exists anywhere.
- The two FOR-UPDATE censuses (`db-locks.ts`, `docs/lock-order.md`) still
  report exactly five lines.
- `gdpr.ts`'s "What still escapes" comment and the read/pre-lock ordering
  narrative are rewritten to state the new structure and its (narrower)
  residual gap — not left describing the old one.
- `docs/lock-order.md`'s `deleteTeacherAccount` "Known conformance" bullet
  is corrected, both for this change and for the pre-existing "first in the
  transaction" staleness found in §7.
- §5's two tests are rebuilt per §6's verify-first process, each proven to
  fail against the old structure (if reverted) and pass against the new one.
- `gdpr-lock-order.test.ts`'s deadlock reproduction and every other
  `deleteTeacherAccount`/`deleteStudentAccount` test in `gdpr.test.ts` pass
  unmodified.
- `npm run verify` green; CI green (this branch touches `integration`-tier
  tests, so cite the CI run for that tier per this project's own rule, not a
  local `verify`, if built from a worktree).

## 9. Out of scope

- Simplifying or removing the per-class CAS (line 1236) or its
  now-narrower-triggering defensive branches. §4 keeps it deliberately as
  defense-in-depth; removing it is a separate, riskier change this issue
  did not ask for.
- Any change to `deleteStudentAccount`, `withdrawWaitingEntriesForTeacher`,
  or `archiveOrUnarchiveTemplate` — the issue's own comparison table found
  none of the three has this race, and this design doesn't touch their
  shared helper.
- Resizing `deleteTeacherAccount`'s transaction `timeout` — unrelated to
  this fix, and the prior spec for this same function (`docs/superpowers/
  specs/2026-08-16-ordered-class-locking-design.md`, §4.1) already declined
  to touch it for the same reason.
