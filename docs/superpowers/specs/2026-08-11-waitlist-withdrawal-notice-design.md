# Telling waitlisted students their class is gone (#112)

## Summary

Four of the five paths that stop offering a scheduled class build their
notification recipient list from registrations alone. A student sitting in a
waitlist queue hears nothing — and when the path is *archive*, their entry is
cascade-deleted on the way out.

**This spec changes who gets told. It does not change what gets deleted.**

## What the issue said, and what measurement showed

The issue is right that the defect exists and right about its mechanism. Three
of its supporting claims do not survive checking, and one of them matters.

| Issue claim | Verdict |
|---|---|
| `WaitlistEntry.class` is `onDelete: Cascade` | **Holds.** At `prisma/schema.prisma:517`. The issue's `:421` is not `Registration`'s either — it is a doc-comment line inside `ClassTemplate.archivedAt`; `Registration.class` cascades at `:497`. |
| The archive transaction creates no notification anywhere | **Holds.** It is CAS → `deleteMany` → `count` → `update` — the CAS `updateMany` at `class-template-lifecycle.ts:620`, the delete at `:693`, the count at `:706`, the record at `:723`. |
| `class_cancelled` is an established type | **Holds**, and it is in `ESSENTIAL_NOTIFICATION_TYPES` (`notification-policy.ts:16`). |
| *"`autoCancelClasses` and `completeClass` both persist notifications inside their transaction for exactly this kind of event"* — offered as the comparison point | **False as a comparison.** `autoCancelClasses` builds its list from `tx.registration.findMany` only (`class-transitions.ts:287`) and never reads `waitlistEntry`. It has the same bug. The only path that gets this right is the manual-cancel route. |
| *"Narrow, but…"* — reachable only when every registration was cancelled | **Understated.** The `late_cancel` branch is gated on `if (isStudent)` (`registrations/[id]/route.ts:149`), so a **teacher** cancelling a registration writes plain `cancelled` at any time, deadline irrelevant. `CHARGED_STATUSES` excludes `cancelled`, so a teacher clearing a class produces the zero-charged state directly. |

### The census

Anchor the pattern to the model, or the count is meaningless: a bare
`grep -rn deleteMany src` returns **271** lines across every table in the schema,
plus prose in comments. `grep -rni 'class\.deleteMany' src` returns **45**, of
which **42** are in `*.test.ts`, leaving three production sites — and naming them
beats counting them:

- `class-template-lifecycle.ts:693` — `tx.class.deleteMany` (archive)
- `template-sync.ts:68` — `tx.class.deleteMany` (day-change sync)
- `studio-class-template-lifecycle.ts:625` — `tx.studioClass.deleteMany`

Adding the three production writes of `status: 'cancelled'` onto a class —
`class-transitions.ts:283`, `gdpr.ts:701`, `transition/route.ts:37` (the other
two hits for that string, `gdpr.ts:377` and `registrations/[id]/route.ts:173`,
write it onto a `Registration`) — gives five paths by which a scheduled class
stops being offered:

| # | Path | Location | Registrations told | Waitlist told | Entries left as |
|---|---|---|---|---|---|
| 1 | Manual cancel | `app/api/classes/[id]/transition/route.ts:47-70` | yes | **yes** | `removed` |
| 2 | Auto-cancel below minimum | `services/class-transitions.ts:287-312` | yes | **no** | `waiting`, on a `cancelled` class |
| 3 | Teacher account erasure | `services/gdpr.ts:736-771` | yes | **no** | already `removed` (`gdpr.ts:736`) |
| 4 | Template archive | `services/class-template-lifecycle.ts:693` | n/a — none are charged | **no** | **cascade-deleted** |
| 5 | Template day-change sync | `services/template-sync.ts:68` | n/a | no | **cascade-deleted** |

**Path 5 is unreachable with a queue, and stays out of scope.** `addToWaitlist`
rejects unless `activeCount >= maxStudents` (`waitlist.ts:188`); `maxStudents`
is `z.number().int().positive()` (`schemas.ts:318`) so it is at least 1;
therefore any waitlisted class has carried at least one registration; therefore
`settingsLocked` is `true`. `template-sync.ts:58` deletes only `!settingsLocked`
rows. `settingsLocked` is written `true` in exactly one place
(`registrations/route.ts:195`) and never written `false` anywhere, so this is a
one-way latch, not a race.

Paths 2, 3 and 4 are in scope. Path 1 is the reference implementation.

### StudioClass is not affected

`StudioClass` has no registrations and no waitlist — it is *"disconnected from
Room/Student — pure calendar + income tracking"* (CLAUDE.md). The studio
archive at `studio-class-template-lifecycle.ts:625` needs no change — a line
that moved from `:536` when #119/#120 landed, which is the standing reason to
re-derive a citation rather than trust one.

## What #86 decided, and what it got wrong

This is not an oversight being corrected. #86 examined this exact cascade.

`docs/superpowers/specs/2026-07-25-template-archive-withdraws-window-design.md:45`
states the principle:

> All key on **student contact**: before a booking an instance is an offer the
> template made; after, it is a commitment that stops being template-managed.

and `:225` lists the consequence in its own cascade table:

> \| `WaitlistEntry.class` \| **Cascade** \| queue for a class nobody can now book \|

Under that principle the deletion is correct: joining a queue is not a booking,
so a waiting student is on the *offer* side of the line, exactly like a
cancelled registration. **The deletion rule is not being reopened here.**

What #86 got wrong is one sentence, at `:56`:

> A registration with status `cancelled` does not count — nobody is affected and
> nothing is owed, so a class everyone cancelled out of *is* deleted.

"Nobody is affected" and "nothing is owed" are different tests, and the second
was used to answer the first. Nothing is owed by a waitlisted student — the
money argument genuinely does not reach them. But they are affected, and the
cascade row in the same document concedes a queue is being destroyed while
justifying it with a description of the state *after* the delete rather than of
who needed to hear about it first.

**The defect is the silence. Silence is what this fixes.**

### #86 asked for a test that was never written

`:231` of that spec:

> Worth an explicit test rather than a one-time reading — the cascade behaviour
> is a schema property that a later migration could change without anyone
> revisiting this file.

`src/services/class-template-lifecycle.test.ts` contains **zero** occurrences of
`waitlist` (case-insensitive). Its only `cascade` mention is a comment about
`late_cancel` at `:518`. `class-transitions.test.ts` has one, also in a comment.
Neither path has any waitlist coverage at all.

## Reachability

Each in-scope path needs its own argument, because they reach the state
differently. All three, however, must first get past the same objection, so it
is settled once here.

### The drain invariant, and the three ways it fails

There is a strong argument that none of this is reachable, and it is worth
stating properly because it is nearly right:

> A queue only forms when the class is full. A full class is above its minimum,
> and has no free seat to lose. So a class carrying a queue is never a class
> in trouble.

**The invariant is real, and it is actively maintained.** Not merely true at
join time: when a seat frees, `handleSpotFreed` promotes the head of the queue,
which refills the seat. Queue of 3 at 8/8 → one cancels → promoted → 8/8, queue
of 2. `activeCount` never dips. So for as long as promotion runs, a class
carrying a queue has its count *pinned* at `maxStudents`; the queue drains to
empty before the count is free to fall at all.

**Exactly one mechanism maintains it.** Nothing else clears entries in response
to the class emptying — `removeFromWaitlist`, `claimSpot` and
`withdrawWaitingEntriesForTeacher` are each driven by someone's explicit act,
not by capacity. So every reachable state in this spec is a state where that
one mechanism did not run. There are three such states:

1. **`frozen`** — past the cancel deadline, `handleSpotFreed` returns
   `{action:'frozen'}` (`waitlist.ts:645`) and promotes nobody. Seats still
   free; nothing refills them.
2. **`first_come_first_claimed` with no claim** — in the final hour before the
   deadline the queue is broadcast to rather than promoted from, so entries
   stay `waiting` until someone claims.
3. **A promotion that failed and was swallowed** — promotion is best-effort.
   `promoteAfterCancel` (`registrations/[id]/route.ts:188`) logs and discards
   every error so a promotion failure cannot turn a successful cancel into a
   500, and `handleSpotFreed` maps `WaitlistPromotionError` to
   `{action:'none'}`. This route needs no timing argument: it can leave the
   count below `maxStudents` with the queue intact at any point.

Routes 1 and 2 are deliberate product behaviour, not defects — freezing exists
so the roster stops churning in the final hours. The gap this spec closes sits
underneath them: the queue is a record of a *past* state ("this class was full
when I asked"), while `minStudents` and `CHARGED_STATUSES` test the *present*
one, and suspending the drain is what lets the two drift apart.

### Path 4 — archive

Requires a class that is `open`, dated after today, under the archived
template, with at least one `waiting` entry and **no** registration in
`CHARGED_STATUSES`.

A queue only forms at `activeCount >= maxStudents`, so the class was full. To
reach zero charged registrations from there, every registration must end as
`cancelled` — not `late_cancel`, which is charged. Two routes:

- **The teacher cancels them.** `registrations/[id]/route.ts:149` puts the
  `late_cancel` branch behind `if (isStudent)`, so a teacher's cancellation
  writes `cancelled` whatever the time. This is the wide route.
- **Students cancel before the deadline**, which writes `cancelled`.

In both cases `handleSpotFreed` fires and would normally promote a waiter into
a `registered` registration — which is charged, and would spare the class.
By the drain invariant above, the surviving state additionally requires
promotion *not* to have fired — via any of its three failure routes, all of
which reach this path.

Archive deletes only `date > today`, so the class is at least one calendar day
out — comfortably compatible with a `HOURS_48` or `HOURS_24` deadline having
already passed. Unlike Path 2, no timing argument is *required* here: the
swallowed-failure route and a teacher's cancellations both reach this state
without reference to the deadline.

### Path 2 — auto-cancel

This is the path where the objection above bites hardest, and it fails hardest:
**auto-cancel can only ever run inside failure route 1.** Not sometimes — always.

The two windows are pushed together by their own purposes, not by coincidence.
Auto-cancel must run late, because it is deciding whether the class happens.
Freezing must happen before that, because it exists to stop the roster churning
in the final hours. So the interval in which the drain is suspended is
precisely the interval auto-cancel operates in.

The configuration confirms it: `DEADLINE_HOURS` is `{48, 24, 12, 6}`
(`waitlist.ts:96`), so the freeze begins at T−6h at the latest;
`CANCEL_CHECK_HOURS` is `{4, 2, 1}` (`class-transitions.ts:21`) and
`inCancelWindow` returns `at >= start − checkHours && at < start`
(`class-transitions.ts:48`), so the sweep fires at T−4h at the earliest.
`min(deadline) = 6 > max(check) = 4`, so across all 4 × 3 = 12 configurations
auto-cancel runs strictly inside the frozen window, with at least a two-hour
margin. There is no setting where they overlap. This is evidence for the
argument above, not the argument itself — a future enum value could close the
gap in hours while leaving the ordering intact.

**What makes the count actually fall** is one status asymmetry: a student
cancelling after the deadline gets `late_cancel`, which is in `CHARGED_STATUSES`
(`class-lifecycle.ts:167`) but **not** in `ACTIVE_REGISTRATION_STATUSES`, the
list auto-cancel counts by at `class-transitions.ts:34`. (That triple is defined
twice — `waitlist.ts:45` holds an identical private copy. Both agree today; cite
the one the code under test actually reads.) So the seat is released
while the registration stays billable — the class is simultaneously
fully-paid-for and below its minimum.

Worked example: `maxStudents 8`, `minStudents 4`, `HOURS_24` deadline,
`HOURS_2` check. Class fills to 8/8, three students queue. Between T−24h and
T−2h, five students late-cancel; nothing promotes, so `activeCount` is 3. At
T−2h auto-cancel sees `3 < 4` and cancels. Three entries are still `waiting`.

Failure route 3 also reaches this path, without needing the freeze — but it is
not what the test should pin, because route 1 is the guaranteed case.

**Consequence for the test:** the fixture must place `now` inside the frozen
window, not merely construct a below-minimum class with a waiting entry. The
latter state is one production cannot reach before the deadline, so a test
built that way would pass without exercising the mechanism and would pin a
shape the invariant forbids. `autoCancelClasses(db, now)` takes an explicit
`now`, so this is controllable.

### Path 3 — teacher account erasure

`gdpr.ts:701` cancels the teacher's future classes and `:757` notifies only
`registered` students. No fullness or timing precondition applies — any class
with a live queue reaches this.

**This path is already half-fixed, which the first draft of this spec missed.**
`gdpr.ts:736` runs `waitlistEntry.updateMany({ classId, status: 'waiting' } →
'removed')` immediately after the CAS, so the queue is closed correctly here
today. The gap is only that the recipient list built twenty lines later never
learns those students existed: their entry is closed and they are not told.
So path 3's change is **notification-only** — no status update to add, and an
existing update to pin.

Two things about this path that must survive the change:

- **The CAS-refused branch at `:733` deliberately skips the waitlist sweep**,
  and `:709-720` documents the residual it accepts: a `waiting` entry left on a
  class that can never promote anyone, counted into a `warn` line as
  `waitingEntriesLeft` so it is a known residual rather than a silent one. That
  `continue` must keep skipping — half-applying a skip is what the existing test
  pins. Notification belongs after the CAS matched, alongside the update that is
  already there.
- **`gdpr.ts:753-756` defers a different question than the one taken here.**
  Its *"a product decision, not a lock-discipline fix"* is about registration
  statuses — `registered` only, versus the sibling site's
  `registered`/`attended`/`no_show`. Widening to waiting students is an adjacent
  decision and is the one taken in this spec; the status question stays deferred
  and out of scope.

## The rule

> A student waiting for a class is told when that class stops being offered, by
> every path that stops offering it. A waiting entry that outlives its class is
> closed, not left pointing at a dead row.

## Changes, per path

The manual-cancel route is the shape to copy — it reads both sets, concatenates
them into one recipient list under one body, and flips surviving entries to
`removed`:

```ts
const notifications: CreateNotificationInput[] = [...registrations, ...waiting].map(...)
```

| Path | Class becomes | Waiting entries | Change |
|---|---|---|---|
| 2 — auto-cancel | `cancelled` | `waiting` **→ `removed`** (new) | add a `waitlistEntry.findMany({ status: 'waiting' })` inside the existing transaction, concatenate into the existing `CreateNotificationInput[]`, add an `updateMany` |
| 3 — erasure | `cancelled` | already `removed` (`gdpr.ts:736`) | **notification only** — read the entries the existing `updateMany` is about to close, concatenate, and fix the empty-list guard below |
| 4 — archive | deleted (unchanged) | cascade away (unchanged) | notify before the delete, filtered by what the delete actually took — see below |

Paths 2 and 3 are additive: both already open a transaction, already build a
`CreateNotificationInput[]`, and already call `createBulkNotifications(tx, …)`,
which accepts a transaction client (`notifications.ts:101`; the `Db =
PrismaClient | Prisma.TransactionClient` union it takes is declared at `:25`).

Only path 2 needs a new status write. `removed` is not a new state — it is what
`removeFromWaitlist`, the manual-cancel route (`transition/route.ts:52`) and
erasure (`gdpr.ts:736`) all already use. Auto-cancel is the one path that closes
a class and leaves its queue pointing at it.

**The empty-list guard is a trap on path 3.** `gdpr.ts:761` wraps the
notification build in `if (registrations.length > 0)`. A class whose only
audience is its queue has `registrations.length === 0`, so leaving that guard
alone silently drops exactly the notification this spec exists to send. It must
test the concatenated list, not the registration list. Path 2 has no such guard —
it always pushes a teacher notification at `class-transitions.ts:304`, so its
array is never empty — and path 1 already gets this right at
`transition/route.ts:66`, testing `notifications.length`.

### Path 4's ordering problem

#86 requires the delete stay one statement
(`class-template-lifecycle.ts:691`: *"Do not 'optimise' this back into a
read-then-delete"*), because a two-step read-then-delete lets a registration
commit in the gap and destroys a now-charged class. Notifying, however, needs
to know who was waiting *before* the rows vanish.

Locking the candidate classes would not close this. `registrations/route.ts`
never calls `lockClassRow`, and its only class-row write — `settingsLocked:
true` at `:195` — is skipped when the class is already locked, which is always
true here. A `SELECT … FOR UPDATE` on candidates would therefore not block a
concurrent booking.

The sequence inside the existing transaction, after the CAS:

1. Read `waiting` entries whose class matches the delete predicate → **candidates**
2. `deleteMany` — **unchanged**, predicate still evaluated at execution time
3. Read back which candidate class ids still exist → **survivors**
4. `createBulkNotifications` for candidates whose class is *not* a survivor

Two extra queries in a transaction that already runs four. Step 2 is not
touched, so #86's anti-race property is preserved intact; the exactness comes
from step 3, not from constraining the delete.

**Rejected:** notifying straight from step 1. Simpler, but a booking landing
between steps 1 and 2 spares the class and the student is told it was withdrawn
while their entry is still `waiting` — a message the app itself contradicts.

## Notification content

One body per path, sent to registrations and waiters alike — the manual-cancel
route's precedent (`transition/route.ts:58`), which does not distinguish them.
A waitlisted student never held a spot, but "this class is cancelled" is true
for both audiences and two bodies would be two things to keep consistent.

`Notification.relatedClass` is `onDelete: SetNull` (`schema.prisma:563`), so an
archive notification **survives its class's deletion with a null class link**.
Its body must therefore name the class itself — type, date, time — rather than
lean on the relation. Paths 2 and 3 keep a live link, since the class survives
as `cancelled`.

One consequence, which closes: `isEmailEligible` reaches its urgent-window path
only with a non-null `classStart` (`notification-policy.ts:38`), so an archive
notification can never take it and always waits out the unread threshold. No
loss — archive touches only `date > today`, so the class is at least a day out
and the 120-minute urgent window could never have applied. `class_cancelled` is
essential, so delivery bypasses `Student.emailNotifications` either way.

## Out of scope

- **The deletion rule.** A waiting entry still does not spare a class from
  archiving. Changing that reopens #86's booked/unbooked line.
- **The archive confirmation copy.** It stays *"3 classes withdrawn"*. The
  teacher's durable record is about their schedule; the students now hear
  directly, which was the actual gap. Adding a second persisted count means a
  migration and a second number that can drift from what the transaction did —
  the exact failure #97 and #111 existed to remove.
- **Path 5** (`template-sync.ts`), unreachable with a queue as shown above.
- **Studio classes**, which have no waitlist.
- **`completeClass`**, which does not remove a class from the schedule.

## Testing

No waitlist coverage exists on paths 2 or 4 today, so these are new files' worth
of cases rather than edits to existing ones.

### Behaviour

- **Path 4:** class with only `cancelled` registrations plus a `waiting` entry →
  archive → the class row is gone, and a `class_cancelled` notification exists
  for the waiter with `relatedClassId` **null** and a body naming the class.
- **Path 4, spared class:** a class with a `registered` registration and a
  waiter is not deleted and its waiter is **not** notified.
- **Path 2:** the worked example above, constructed as a fixture → auto-cancel →
  waiters notified, and their entries are `removed`, not `waiting`.
- **Path 3:** teacher erasure with a queued student → notified, entry `removed`.
  Give this class a waiter and **no** `registered` registration, so it fails
  against the `if (registrations.length > 0)` guard at `gdpr.ts:761` if that
  guard is left keyed on the wrong list. A fixture with both audiences passes
  either way and would certify nothing.
- **Cascade pin (#86's unwritten test):** assert directly that deleting a
  `Class` removes its `WaitlistEntry` rows, so a later migration changing
  `onDelete` fails here rather than silently.

Fixtures write `WaitlistEntry` rows through Prisma directly, bypassing
`addToWaitlist`'s fullness guard — the same thing `gdpr.test.ts:88` does.
Reachability is therefore argued from the code above, not from the fixtures;
the tests pin behaviour *given* the state.

### Mutations — each guard must be shown to fail

Per §3 of the solve-issue skill, every guard is broken, the exact error recorded,
then restored and re-verified.

| Guard | Mutation | Test that must fail |
|---|---|---|
| Path 4's waitlist read | delete it | archive notification test |
| Path 4's **survivor filter** | notify all candidates instead of non-survivors | the concurrency test below |
| Path 2's waitlist read | delete it | auto-cancel notification test |
| Path 2's new `removed` update | delete it | auto-cancel entry-status assertion |
| Path 3's **empty-list guard** | revert it to `if (registrations.length > 0)` | the queue-only erasure test above |
| Path 3's *existing* `removed` update (`gdpr.ts:736`) | delete it | erasure entry-status assertion — this one pins behaviour that already works, so it must be shown to fail too, or it is a test of nothing |
| Cascade | change `WaitlistEntry.class` to `SetNull` in a scratch schema | cascade pin |

The survivor filter is the one guard that needs real concurrency to bite, and
it is testable: interpose on the step-1 `waitlistEntry.findMany` with
`prisma.$extends({ query: … })` — the pattern already used at
`class-template-lifecycle.test.ts:224` — and commit a `registered` registration
on one candidate class from **outside** the transaction. The archive
transaction holds only the template row's lock, so that write commits; under
READ COMMITTED the step-2 `deleteMany` re-evaluates and spares the class; step 3
sees it survive. With the filter removed, that class's waiter is notified and
the test fails.

Note what this rules out: without such a test the survivor filter would be a
guard that compiles and cannot fail — exactly the defect #39 shipped three times.

## Risks

- **Over-notification on the archive path** if step 3 is dropped or wrong. The
  concurrency test above is the only thing that detects it; without that test
  steps 1 and 3 are indistinguishable in every non-concurrent case.
- **Notification volume.** A teacher archiving a template with several queued
  classes now sends one essential email per waiter. Bounded by queue length,
  which is bounded by nothing in the schema — but a queue is per-class and
  formed only by students who were told the class was full, so this is not a
  new fan-out class.
- **Path 3 widens what an erasure emails**, which `gdpr.ts:756` explicitly
  deferred as a product decision. Taken deliberately here; called out so the PR
  review sees it as intended rather than incidental.
