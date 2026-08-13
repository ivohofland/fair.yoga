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
| "#195 fixes forward only … the population is bounded and no longer grows" | **False.** #195 closed the three exits to `cancelled`. The three exits to `in_progress` close nothing, so an ordinary full class strands its waiters the moment it *starts*. See §7. |
| The fix is `class: { status: { not: 'cancelled' } }` | **Wrong shape.** It leaves the `in_progress` and `completed` population rendering, which is the larger one and the one still growing. The predicate is positive: `status: 'open'`. |
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
| `expired` | **nothing** — no code path writes it | dead enum value; §7 proposes it as the state the missing transition should write |

So after #195 a cancelled class whose queue was closed to `removed` still reports
its old queue length to its teacher, and any class that ever promoted a waiter
counts that person twice. `waiting` alone is the predicate.

### 3.3 Teacher class detail, the class side — `src/components/class/class-info.tsx`

**Added after the PR review, which found §3.2 was half the fix.** Two reviewers
converged on it independently: §3.2 qualifies the *entry* and never the *class*,
so the population §7 documents as growing on every open→`in_progress` transition
still rendered — "3 on waitlist", present tense, on a class that had finished.
That is the sentence this spec opens with, on the teacher's side rather than the
student's.

```tsx
const queueIsLive = cls.status === 'open' || cls.status === 'in_progress';
…
{queueIsLive && waitlistCount > 0 && <> &middot; {waitlistCount} on waitlist</>}
```

It belongs in the component, not the query: a relation `_count` filters the
related rows, not the parent's status, and this component already owns
`showProgress` on the same lifecycle window.

**`in_progress` is included deliberately, and the reasoning is not symmetric with
§3.1's.** `api/registrations/route.ts` sets `allowedStatuses = isTeacher ?
['open', 'in_progress'] : ['open']`, and the walk-in path closes a queued
student's entry to `claimed`. So during check-in a teacher may still walk a waiter
in, which makes the number actionable rather than stale. After `completed` nothing
can consume the queue. `cancelled` already reads 0, since every cancel path closes
its entries to `removed` — so `completed` is the live case this fixes.

The student side has no equivalent window: `canClaim` already requires `open`
(§5), so a row on an `in_progress` class would render as dead text with no action.
The two surfaces differ by one status for a stated reason, not by oversight.

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
  dead text with no action: the same defect, one status over. `in_progress` is
  also where the surviving rows actually come from (§7), which makes including it
  the exact opposite of the fix.
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

Fixture: one student with a `waiting` entry on an `open` class and one on each
non-`open` status a queue can survive into — `in_progress`, `completed`,
`cancelled`. Assert the open class's type appears and the other three do not.

**The `cancelled` case alone would certify nothing, and this is the trap.** The
issue's own proposal, `not: 'cancelled'`, passes a test whose only dead fixture is
a cancelled class — so a fixture chosen to match the issue's wording cannot tell
the shipped predicate from the rejected one. `in_progress` and `completed` are what
make the test discriminate, and they are also where the rows actually come from
(§7). This is #39's shape: a pin that holds for the case it was written from and is
blind to the case that occurs.

**Mutations, each proved separately:**

1. Delete `class: { status: 'open' }` — must fail on all three dead types appearing.
2. Weaken it to `class: { status: { not: 'cancelled' } }` — must fail on the
   `in_progress` and `completed` types appearing. This is the mutation that matters:
   it is not a hypothetical, it is what the issue asked for.

Record the exact assertion text from both.

### 6.2 Teacher — class detail

Fixture: one class carrying one entry in each of **`waiting`, `promoted`,
`removed`**. Assert the page reads `1 on waitlist`, and that it reads neither
`3 on waitlist` nor `2 on waitlist`.

**Mutations, both required:**

1. Delete the `where` from the `_count`. Must fail reading `3 on waitlist`.
2. Weaken it to `status: { not: 'removed' }`. Must fail reading
   `2 on waitlist`.

**This paragraph originally specified `1 waiting + 2 removed`, and that fixture
could not detect mutation 2** — the branch's own review caught it. Both
`status: 'waiting'` and `not: 'removed'` render `1` against it, so the test
pinned "exclude removed" and nothing more. The reasoning given here was that
three-against-one makes the filtered and unfiltered numbers differ by more than
one, so *no off-by-one predicate reproduces it* — true, and insufficient:
`not: 'removed'` is a different shape, not an off-by-one, and it is the natural
mistake ("removed means gone") that keeps double-counting precisely the students
§3.2 exists to stop counting.

Three entries with one in `promoted` keeps the three-versus-one gap and makes the
wrong predicate render 2. `removed` stays represented because it is the state
every queue #195 closed now sits in. The `promoted` row deliberately carries no
`registrationId` — production writes one (`waitlist.ts:480`), but the count query
never reads it, and a fixture `Registration` would add an entity to assert
nothing.

Worth keeping as a record: a symmetric fixture is the shape that let #39 ship
three guards that could not fail, and the first fix for it here was itself
asymmetric in the wrong dimension.

Neither test needs a new file if an existing integration file already owns the
surface; the plan decides placement. `npm run verify` runs all three vitest
projects, so the whole integration suite is the evidence — not a named subset.

## 7. Out of scope — filed as #216

**Nothing closes the queue when a class stops being `open` by *starting*.** The
class-started state is `in_progress`, and that — not completion — is where the
stranding begins. §2's invariant says a waitlist belongs to an `open` class; the
moment a class leaves `open`, every surviving `waiting` row contradicts it.

Every exit from `open`, and what it does with the queue:

| → | Path | Closes the queue? |
|---|---|---|
| `cancelled` | manual route, `transition/route.ts:36` | **yes** — #195 |
| `cancelled` | `autoCancelClasses`, `class-transitions.ts:297` | **yes** — #195 |
| `cancelled` | teacher erasure, `gdpr.ts:783` | **yes** — #195 |
| `in_progress` | `autoTransitionToInProgress:82` → `transitionClass` | **no** |
| `in_progress` | `POST …/transition` with `in_progress` → `transitionClass:109` | **no** |
| `in_progress` | `completeClass:204`, the inline bump when a teacher completes an `open` class directly | **no** |
| row deleted | template archive, `class-template-lifecycle.ts:872` | **yes** — notifies, then cascades |

A queue only forms at `maxStudents`, so a full class that starts is the ordinary
case, and its `waiting` rows survive indefinitely. That is what falsifies the
issue's "bounded" claim in §1 — and note the earliest draft of this spec blamed
`completeClass` alone, which put the gap one state too late and undercounted the
sites by two.

Two of the three sites funnel through `transitionClass`
(`class-lifecycle.ts:123`), so a guard there on `targetStatus === 'in_progress'`
covers both. The third cannot use it: `completeClass` runs inside its own
`$transaction` and `transitionClass` takes a `PrismaClient`, not a transaction
client — the same reason it does its bump inline in the first place.

**Searched before filing, and it is not already filed** — the habit the roadmap
records as the cheap one, after #164 and #192 were each re-found as new. `gh issue
list --search` over `waitlist`, `in_progress`, `queue` and `expired`, plus the
roadmap's own waitlist mentions: no issue covers closing the queue when a class
starts. Three are adjacent and none is a host:

- **#182** rewrites `autoTransitionToInProgress` to decide under `lockClassRow`
  inside a transaction, as #179 did for `autoCancelClasses`. That transaction is
  where this write belongs, in the lock → CAS → read `waiting` → `updateMany`
  shape #195 established, so **#182 should land first or together** — closing the
  queue beforehand means writing a transaction #182 then rewrites. Not the host:
  its subject is `docs/lock-order.md` discipline, it already carries three parts,
  and its PUT half waits on a decision of its own.
- **#183** answers a question this would otherwise have to ask.
  `reorderWaitingEntries` renumbers only `waiting` rows, so closed rows keep stale
  positions by design — which is why closing the whole queue at once needs no
  renumber, and why both cancel paths call `updateMany` with no reorder
  (`transition/route.ts:53`, `class-transitions.ts:325`).
- **#212** is the final-hour broadcast announcing taken spots: adjacent, but a
  capacity check rather than a status one.

#112's spec ruled `completeClass` out explicitly — *"which does not remove a class
from the schedule"* (`2026-08-11-waitlist-withdrawal-notice-design.md:427`). That
was correct for the question #112 asked, which was **whose notice is owed**:
nothing was withdrawn, so nothing is owed. It is silent on the question #199 asks,
which is **what still renders**. Worth naming, because the sentence is true and the
exclusion was right — the gap is in the scope boundary, not in the reasoning. The
`in_progress` transitions were not in #112's frame at all, in either sense.

How far the stale state reaches, so the filed issue does not have to re-derive it:

- `handleSpotFreed` guards `cls.status !== 'open'` (`waitlist.ts:635`), so no
  spurious "a spot opened up" can ever fire on a completed class.
- The GDPR erasure counts stale rows into `waitingCount` (`gdpr.ts:297`), which
  sizes the transaction timeout, and adds their classes to its lock loop: wasted
  row locks and an over-generous timeout, no wrong outcome.
- The Article 15 export (`gdpr.ts:50`) reports `waiting` for a class that already
  ran. **This sentence originally said "the only remaining user-visible
  consequence once §3.1 lands", and the PR review falsified it** — there were two,
  and the second was on a page this branch already edits: the teacher's class
  detail kept rendering "N on waitlist" for a class that had finished, because
  §3.2 qualified the entry's status and not the class's. That is now fixed in
  `class-info.tsx` (§3.3), which leaves the export as the last one. The export
  also selects `classType/date/startTime` and **not** the class's `status`, so
  nothing in the exported record lets a subject work out that the queue is dead —
  an argument for `expired` in #216's decision, recorded there.
- **§3.1 closes the drain as well as the leak, which raises the stakes on #216.**
  The row it hides carried `WaitlistEntryActions`, whose `handleLeave` issues
  `DELETE /api/waitlist/[id]` (`waitlist-entry-actions.tsx:49`, inside
  `handleLeave` at `:45-60`) — so
  until §3.1, a student looking at a dead-class row could at least remove
  themselves, closing that entry to `removed`. Afterwards the row is invisible
  and inert, and **no user action can ever close it**: #216 becomes the only
  mechanism that will. Nobody is worse off — the row was misinformation and
  hiding it is right — but the population can no longer partially self-empty,
  which is worth knowing before choosing #216's status. Found in this branch's
  own review, not before it.

**Filed as #216, as a decision rather than as work**, because the status to write
is a genuine choice and it is the kind that is cheap now and expensive after it
ships. The decision was deliberately left open in #216 rather than settled here:

- **`removed`** — what all three cancel paths write. One vocabulary, no new
  behaviour, and it is what `withdrawWaitingEntriesForTeacher` and
  `removeFromWaitlist` already mean.
- **`expired`** — which exists in `WaitlistStatus` (`prisma/schema.prisma:70`) and
  appears **nowhere else in the codebase**: nothing writes it, nothing reads it, no
  test names it. "The class started while you were still waiting" is exactly what
  the word means, and it is the only distinction a reader of the data can use to
  tell a student who *left* from one who never got in. The Article 15 export
  (`gdpr.ts:50`) reports status verbatim, so this is a difference a student can see.

The notification question, by contrast, **is** answered and the filed issue should
say so rather than reopen it: no notice. #112's promise was about a class *stopping
being offered*; a class that ran is not that, and "it happened without you" is
noise.

Also unchanged: the deletion rule, the notification layer, and `StudioClass` (no
waitlist).

## 8. Acceptance

- `/bookings` renders no waitlist row whose class is not `open`; a `waiting` entry
  on a `completed` class is absent from the HTML.
- The teacher's class detail counts `waiting` entries only; `removed` entries do
  not inflate it.
- Each of the two guards has been broken, the failure text recorded, and restored —
  including the `not: 'cancelled'` weakening in §6.1, not only outright deletion.
- **Done.** The production-count criterion in #199 is answered in the issue itself
  (comment of 2026-08-13) with §4's measurement and the fact that no production
  exists, alongside both falsified claims and the second surface.
- **Done.** The open→`in_progress` gap is **#216**, carrying §7's exit table, the
  `handleSpotFreed` rule-out proof, the open `removed`/`expired` decision, and the
  settled notification question. Its dependency on #182 is recorded in both
  directions: in #216's body, and as a comment on #182 pointing at the transaction
  its own acceptance creates.
