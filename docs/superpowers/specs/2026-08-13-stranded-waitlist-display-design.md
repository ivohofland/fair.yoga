# Stranded waitlist entries render as live (#199)

**Date:** 2026-08-13 · **Issue:** #199 · **Branch:** `fix/199-stranded-waitlist-display`

Two display queries read a `WaitlistEntry` without qualifying the state of the
thing it points at. `/bookings` tells a student they are "position 2" on a class
that will never run; the teacher's class detail says "3 on waitlist" about a queue
that is empty. Both are one predicate short, and the predicate they are short of
is one the service layer already enforces four times over.

## 1. The issue's premise, measured

| Claim in #199 | Verdict |
|---|---|
| `/bookings` filters on entry status and not class status (`bookings/page.tsx:41`) | **True.** `where: { studentId, status: 'waiting' }`, no class predicate. |
| Every class auto-cancelled before #195 still carries `waiting` entries | **True as stated, and empty in practice.** Measured 0 — see §4. |
| "#195 fixes forward only … the population is bounded and no longer grows" | **False.** `completeClass` never closes the queue, so an ordinary full class that *runs* strands its waiters. See §7. |
| The fix is `class: { status: { not: 'cancelled' } }` | **Wrong shape.** It leaves the completed-class population rendering, which is the larger one. The predicate is positive: `status: 'open'`. |
| Option 1 is the display half; options 2 and 3 are backfill and retroactive notice | **2 and 3 do not apply.** There is no production; dev measures 0 stranded rows, so a backfill updates nothing and a retroactive email reaches nobody. |

The issue also names one surface. There are two: the teacher's class detail
carries an unfiltered count that the issue does not mention (§3.2). It is a live
bug — a teacher reads a wrong number today, on current data, with no stranded row
required.

## 2. The invariant already exists; only the reads bypass it

`src/services/waitlist.ts` is unanimous: a waitlist is something only an `open`
class has. Every path that gives, moves, or offers a spot refuses anything else.

| Path | Line | On a non-`open` class |
|---|---|---|
| `addToWaitlist` | :178 | throws `WaitlistJoinError` |
| `promoteNext` | :391 | throws `WaitlistPromotionError` |
| `claimSpot` | :523 | throws `WaitlistPromotionError` |
| `handleSpotFreed` | :635 | returns `{ action: 'none' }` |

One path deliberately does *not* guard, and that asymmetry is correct:
`removeFromWaitlist` (:319) has no status check, because a student must be able to
leave a queue on a class that has already died.

So the direction of the guard is settled: four act paths require `open`, the one
release path requires nothing. The two **read** paths require nothing either —
which is the defect. This change does not invent a rule. It applies the rule the
service layer already states to the two queries that render its results.

That is also the argument for the positive predicate over the negative one.
`not: 'cancelled'` enumerates the ways a class can die, so every future terminal
state is a new leak; `status: 'open'` is the predicate the service layer itself
uses, four times, and there is exactly one of it.

## 3. The changes

Both use a pattern already present in the file being changed or beside it —
neither introduces a new idiom. `bookings/page.tsx:50-52` already writes a
filtered relation `_count`.

### 3.1 `/bookings` — `src/app/(student)/bookings/page.tsx:41`

```ts
where: { studentId: session.studentId, status: 'waiting', class: { status: 'open' } },
```

Consequence to state rather than discover: the empty-state condition at line 102
is `upcoming.length === 0 && past.length === 0 && waitlistEntries.length === 0`, so
a student whose only row was a stranded entry now correctly sees "No bookings yet"
instead of a phantom Waitlist section. That is the intended outcome, not a
regression.

### 3.2 Teacher class detail — `src/app/(teacher)/class/[id]/page.tsx:45`

```ts
_count: { select: { waitlistEntries: { where: { status: 'waiting' } } } },
```

Rendered by `class-info.tsx:35` as `{waitlistCount} on waitlist`. `WaitlistStatus`
has five values and the count filters none of them:

| Status | Written by | Effect on the unfiltered count |
|---|---|---|
| `waiting` | `addToWaitlist` | correct — the only one that belongs |
| `promoted` | `promoteNext:480`, `claimSpot:588` | **double-counts a seated student**: both create the `Registration` in the same transaction (`activateRegistration`) and store its id, so this student is already in the registrations list on this same page |
| `claimed` | `POST /api/registrations:185` | same double-count, by the route rather than the service |
| `removed` | `removeFromWaitlist`, and the three cancel paths #195 added | counts a student who left |
| `expired` | **nothing** — no code path writes it | dead enum value |

So after #195 a cancelled class whose queue was closed to `removed` still reports
its old queue length to its teacher, and any class that ever promoted a waiter
counts that person twice. `waiting` alone is the predicate.

## 4. What was measured

Dev is the only database; there is no production. Every `WaitlistEntry` row,
joined to its class:

```sql
SELECT w.status, c.status, count(*) FROM "WaitlistEntry" w
JOIN "Class" c ON c.id = w."classId" GROUP BY 1,2;
-- waiting | open | 4
```

4 rows total, all `waiting` on `open` classes. Stranded = 4 − 4 = **0**. This is
the count #199 made its first acceptance criterion, answered for the only
environment that exists.

Read surfaces swept for the same defect, so the two above are a census and not a
sample — `grep -rn "waitlistEntry\.\|waitlistEntries" src` over non-test files:

- `src/app/(public)/[slug]/page.tsx:71` — the same unqualified `status: 'waiting'`
  query, and **not** a bug: its outer `class.findMany` (:48) is already scoped to
  `status: 'open', date: { gte: today }`, so every id it can match is live. Safe
  by containment, and left alone.
- `src/services/gdpr.ts:50` — the Article 15 export, which reports entry status
  verbatim. Affected only by §7's separate gap, not by this change.
- Everything else is a service write path or an API route, covered by §2.

## 5. Ruled out

- **A `date` predicate alongside the status.** `open` is the app's own definition
  of live and the transitions sweep owns the date→status mapping. A second date
  test here is a second source of truth that can disagree with the sweep, and it
  drags `defaultTimezone` into a query that does not otherwise need it.
- **Including `in_progress`.** Walk-ins may exceed `maxStudents`, so a teacher
  *could* still take someone — but the claim button already requires
  `cls.status === 'open'` (`bookings/page.tsx:117`), so the row would render as
  dead text with no action: the same defect, one status over.
- **Backfill (issue option 2).** Nothing to update (§4), and a data migration
  written now would ship a permanent empty `UPDATE` against a future database that
  never carried a pre-#195 row.
- **Retroactive notice (issue option 3).** Nobody to notify, and a "class you
  waited for was cancelled weeks ago" email serves no one.
- **Widening the empty state.** No change: showing "No bookings yet" to a student
  whose only row was stranded is the correct outcome.

## 6. Testing

Both are page-HTML fetches, following `tests/integration/privacy-page.test.ts` —
these are render defects, and no JSON body exists to assert on. Class types carry
the file's `uniqueSuffix()` so an absence assertion cannot pass by coincidence
against another run's fixture.

### 6.1 Student — `/bookings`

Fixture: one student, two `waiting` entries — one on an `open` class, one on a
`completed` class. Assert the open class's type appears and the completed class's
type does not.

**Mutation:** delete `class: { status: 'open' }` from the query. Must fail on the
completed class's type appearing in the HTML. Record the exact assertion text.

### 6.2 Teacher — class detail

Fixture: one class, **1 `waiting` and 2 `removed`** entries. Assert the page reads
`1 on waitlist`.

**Mutation:** delete the `where` from the `_count`. Must fail reading
`3 on waitlist`.

The 2/1 split is load-bearing. A fixture with one entry of each status renders `1`
before the fix and `2` after — but so would several wrong predicates, and a
symmetric fixture is exactly the shape that let #39 ship three guards that could
not fail. Two `removed` against one `waiting` makes the filtered and unfiltered
numbers differ by more than one, so no off-by-one predicate reproduces it.

Neither test needs a new file if an existing integration file already owns the
surface; the plan decides placement. `npm run verify` runs all three vitest
projects, so the whole integration suite is the evidence — not a named subset.

## 7. Out of scope, filed separately

**`completeClass` does not close its queue.** `src/services/class-lifecycle.ts`
writes `status: 'completed'` and never touches `WaitlistEntry`; the string
`waitlist` appears once in that file, in an unrelated docblock. A queue only forms
at `maxStudents`, so a full class that runs to completion is the ordinary case, and
every `waiting` row on it survives at `waiting` indefinitely. This is why §1
falsifies the issue's "bounded" claim.

#112's spec ruled `completeClass` out explicitly — *"which does not remove a class
from the schedule"* (`2026-08-11-waitlist-withdrawal-notice-design.md:427`). That
was correct for the question #112 asked, which was **whose notice is owed**:
nothing was withdrawn, so nothing is owed. It is silent on the question #199 asks,
which is **what still renders**. Worth naming, because the sentence is true and the
exclusion was right — the gap is in the scope boundary, not in the reasoning.

How far the stale state reaches, so the filed issue does not have to re-derive it:

- `handleSpotFreed` guards `cls.status !== 'open'` (`waitlist.ts:635`), so no
  spurious "a spot opened up" can ever fire on a completed class.
- The GDPR erasure counts stale rows into `waitingCount` (`gdpr.ts:297`), which
  sizes the transaction timeout, and adds their classes to its lock loop: wasted
  row locks and an over-generous timeout, no wrong outcome.
- The Article 15 export (`gdpr.ts:50`) reports `waiting` for a class that already
  ran. This is the only remaining user-visible consequence once §3.1 lands.

Filed as work rather than as a decision: the option set is one `updateMany` in one
function, and the notification question is already answered — a "the class ran
without you" notice is noise, and #112's promise was about a class *stopping being
offered*, which this is not.

Also unchanged: the deletion rule, the notification layer, `StudioClass` (no
waitlist), and the `expired` enum value, which is dead but harmless and not this
branch's business.

## 8. Acceptance

- `/bookings` renders no waitlist row whose class is not `open`; a `waiting` entry
  on a `completed` class is absent from the HTML.
- The teacher's class detail counts `waiting` entries only; `removed` entries do
  not inflate it.
- Each of the two guards has been broken, the failure text recorded, and restored.
- The production-count criterion in #199 is answered in the issue itself with §4's
  measurement and the fact that no production exists.
- The `completeClass` gap is filed with §7's content before this branch merges.
