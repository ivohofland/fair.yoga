# Closing the waitlist when a class starts, and locking the two sweeps that start it

**Issues:** #216 (queue close) and #182 (unlocked sweep decisions), deliberately in one
branch. **Date:** 2026-08-15.

#216's own body asks for this: *"#182 should land first, or the two should be done
together … Doing this one first means writing a standalone transaction that #182 then
rewrites."* #182's second comment says the same from the other side. The two were kept
apart as issues because their subjects differ — a missing state transition versus lock
discipline — and because each carried its own product decision. Both decisions are
resolved below, which is what makes one branch viable.

---

## 1. What was measured

Every line number in #216 has drifted since it was filed, by 7 to 36 lines. The
references below were re-derived on 2026-08-15 and are the ones the plan should use.

### 1.1 The invariant, and where it is enforced

`src/services/waitlist.ts` is unanimous that a waitlist belongs to an `open` class:

| Path | Line | On a non-`open` class |
|---|---|---|
| `addToWaitlist` | `:203` | throws `WaitlistJoinError` |
| `promoteNext` | `:414` | throws `WaitlistPromotionError` |
| `claimSpot` | `:544` | throws `WaitlistPromotionError` |
| `handleSpotFreed` | `:669` | returns `{ action: 'none' }` |
| `removeFromWaitlist` | `:342` | **no guard, deliberately** — a student must be able to leave a dead queue |

### 1.2 The enumeration of exits is complete, and provably so

#216 argues from a table of call sites. The state machine proves it outright:

```ts
// src/services/class-lifecycle.ts:32-38
export const VALID_TRANSITIONS: Record<ClassStatus, ClassStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['in_progress', 'cancelled'],   // <- exactly two exits
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
};
```

`ClassStatus` has five members and **no `full`** (`prisma/schema.prisma:50-56`).
CLAUDE.md describes the lifecycle as `open → full → in_progress`; `full` is derived
from registration counts (`services/capacity.ts`), not stored. A class at
`maxStudents` is therefore still `open` — which is the only reason a queue can exist
at all, and why "a full class that starts" is the ordinary case rather than an edge.

Two exits, therefore, plus row deletion. Both deletion paths are already safe and both
already say why in code:

- `template-sync.ts:177-186` — protected by the `!settingsLocked` filter, since a
  class that ever carried a waiter latched `settingsLocked` and is in `kept`. The
  comment calls itself a tripwire.
- `class-template-lifecycle.ts:1310` — notifies the queue, then cascades.

| Exit | Site | Closes the queue? |
|---|---|---|
| `cancelled` | manual route, `transition/route.ts:52-57` | **yes** (#195) |
| `cancelled` | `autoCancelClasses`, `class-transitions.ts:321-326` | **yes** (#195) |
| `cancelled` | teacher erasure, `gdpr.ts:876-879` | **yes** (#195) |
| `in_progress` | `autoTransitionToInProgress`, `class-transitions.ts:75` | **no** |
| `in_progress` | `POST .../transition`, `route.ts:109` → `transitionClass` | **no** |
| `in_progress` | `completeClass`'s inline bump, `class-lifecycle.ts:208-211` | **no** |

`transitionClass` has exactly two production callers — the two above.
`transitionClassSchema` (`schemas.ts:362-364`) accepts `in_progress`, so the manual
route's generic branch is reachable rather than theoretical.

### 1.3 Corrections to #216

**The census is stale, and the conclusion survives by a different route.** #216
measured `waiting|open = 4`, `0 stranded`. Re-run on 2026-08-15:

```sql
SELECT w.status, c.status, count(*) FROM "WaitlistEntry" w
JOIN "Class" c ON c.id = w."classId" GROUP BY 1,2;
-- (0 rows)
```

The dev database now holds **0 `WaitlistEntry` rows of any status** (11 classes, 42
registrations). Still 0 stranded, so **no backfill** — but established by the table
being empty, not by the issue's four live rows. There is no production database.

**A standing instruction #216 does not mention.** `tests/integration/waitlist-display.test.ts:245-248`
already anticipates this branch:

> `expired` is absent because nothing in `src` writes it. If #216 chooses `expired` as
> the state that closes a queue when a class starts, add a row here the same day —
> otherwise `notIn: ['removed','promoted','claimed']` becomes a live leak this fixture
> cannot see.

### 1.4 #182's three sites, re-verified

1. **`autoTransitionToInProgress`** (`class-transitions.ts:53-88`) — decides entirely
   from the pre-transaction `findMany` at `:62`. No transaction, no lock;
   `transitionClass` at `:75` is a bare CAS on the outer client.
2. **`autoCompleteClasses`** (`class-transitions.ts:382-416`) — same shape. Note the
   asymmetry: `completeClass` *does* take `lockClassRow` and re-read, so the **status**
   decision is protected and only the **timing** decision (`start + durationMinutes`,
   computed from the stale snapshot at `:399-402`) is not.
3. **`PUT /api/registrations/[id]`** (`registrations/[id]/route.ts:98-101`) — a bare
   `prisma.registration.update` with no guard on the registration's current status and
   none on the class's. Ownership *is* checked (`:91`).

### 1.5 A claim #182 makes that is wrong about the ordinary case

`class-transitions.ts:206-209` says of the attendance PUT: *"the action is a teacher
marking attendance on a class that has not started, which is not a normal thing to do."*

Measured: `AttendanceList` renders when
`cls.status === 'in_progress' || (cls.status === 'open' && minutesToStart <= 15)`
(`class/[id]/page.tsx:108`). `autoCancelClasses`' window is `[start − 1..4h, start)`.
**The two windows overlap by design** — check-in on an `open` class is the designed
flow, not an anomaly.

The claim's *conclusion* survives anyway, for a reason the comment does not give: the
UI toggle only ever writes `attended ↔ no_show` (`attendance-list.tsx:27`), and both
are already inside `ACTIVE_REGISTRATION_STATUSES`, so it cannot move the count. The
harmful move needs a **source** status outside the counted set — `late_cancel →
attended` — and `late_cancel` is a value no component ever sends. It exists only in
`updateRegistrationSchema` (`schemas.ts:475-477`) as an API-reachable value.

### 1.6 Facts about `no_show` that constrain §3.3

- **One writer, and it is manual.** Only the check-in checkbox writes `no_show`.
  Nothing automatic does.
- **It changes nothing but the record.** `ACTIVE_REGISTRATION_STATUSES` =
  `[registered, attended, no_show]`; `CHARGED_STATUSES` =
  `[registered, attended, no_show, late_cancel]`. `no_show` is in both, so it alters
  no seat count, no price, no payment, no notification. CLAUDE.md by design:
  *"Post-class billing based on registrations (not attendance)."*
- **It is published.** `exportStudentData` (`gdpr.ts:37-38`) pulls registrations with
  `include` and no `select`, so every scalar — `status` included — reaches the
  Article 15 export.

---

## 2. Decisions

### 2.1 `expired`, not `removed` (#216 acceptance 3)

**Decision: `expired`.**

- The Article 15 export publishes `WaitlistEntry.status` verbatim and does **not**
  select the class's status: `waitlistEntries` takes
  `class: { select: { classType, date, startTime } }` (`gdpr.ts:51-52`).
  **The asymmetry is the argument.** The *registrations* half of the same export
  three lines above *does* select `status` on the class (`gdpr.ts:44`), so a subject
  can see that a class they booked has completed — but a subject reading their
  waitlist entries gets `{ class: 'Vinyasa', date: …, status: 'waiting', position: 2 }`
  with nothing in the record from which to work out that the queue is dead.
  `expired` therefore makes a subject-access request self-explanatory **with no change
  to `gdpr.ts` at all**. `removed` would report the student as having withdrawn —
  a different and equally wrong story from the one the data supports.
- It is the only way the data can distinguish a student who *left* from one who *never
  got in*. After #199 the hand-closed population is frozen (no route surfaces an entry
  id for a stranded row any more), so the two sets stay clean rather than being muddied
  going forward.
- **The risk was measured, not assumed.** A new enum value can only leak through a
  *negative* enumeration. Every production predicate over `WaitlistStatus` is positive
  (`status: 'waiting'`); the only `notIn` filters in `src` are over
  `RegistrationStatus` (`registrations/[id]/route.ts:177,193`). There is nothing for
  `expired` to leak through.
- Cost: one fixture row in `waitlist-display.test.ts`, already demanded by name there.

### 2.2 Where the close lives

**Decision: one named helper, three call sites.**

`closeQueueOnStart(tx, classId)` in `waitlist.ts`, called from
`autoTransitionToInProgress`, `transitionClass` and `completeClass`.

The original plan was two call sites — `transitionClass` covering both the sweep and
the manual route. Folding #182 in changes that: the sweep stops calling
`transitionClass` and issues its own CAS under the lock, following `autoCancelClasses`
(which likewise does not call `transitionClass`). Recorded because it is a change from
the shape approved at the gate.

### 2.3 The attendance PUT (#182's stated open decision)

**Decision: scope the write by source status, and reject a cancelled class. Keep
`completed` writable.**

Two guards with distinct jobs:

- **Source-status scope** — `updateMany({ where: { id, status: { notIn: ['cancelled',
  'late_cancel'] } } })`, 409 on `count === 0`. This is the lock-discipline half: a
  registration can then only move *within* the counted set, so the PUT can never make
  `autoCancelClasses`' count too low. It is the shape the DELETE handler in the same
  file already uses twice (`:176-179`, `:192-195`) for the same reason — *"Status in
  the WHERE, not just the pre-check above: that pre-check is a read-then-write and this
  handler opens no transaction."*
- **Reject when the class is `cancelled`** — the product half. A cancelled class has no
  attendance.

**No `lockClassRow`.** The harmful direction is closed by a predicate Postgres
re-evaluates at execution time. Adding a lock would put contention on the hottest row
in the application to protect a write that moves no money (§1.6).

**`completed` is deliberately allowed, and this is a product requirement rather than a
default.** A teacher learns the exact no-shows *after* the class — someone arrives a
minute late, is let in, and the admin is not done at that moment. All three accepted
values are in `CHARGED_STATUSES`, so a post-completion correction provably cannot
change who is billed or by how much.

**No class-*time* guard.** Check-in legitimately runs before the class starts (§1.5).
`waitlist.ts:722-724`'s three-part claim must be narrowed rather than deleted: after
this branch the PUT guards current registration status and class status, and still
does not guard class time — on purpose.

### 2.4 Rejected: auto-flipping `registered → no_show` after the class

**Decision: no auto-flip.** Considered and declined on 2026-08-15, recorded here so it
is not re-proposed as an obvious improvement.

It would be free in every dimension but one: `registered` and `no_show` are both
`ACTIVE` and both `CHARGED`, so nothing downstream would move. But after a completed
class `registered` truthfully means *"the teacher never recorded attendance"*, while
`no_show` asserts *"this person did not come."* An auto-flip fabricates an observation
the system never made — and per §1.6 the Article 15 export publishes it, so a student
who attended could read `no_show` in their own data because their teacher was busy
teaching. That is the same defect this branch exists to fix on the waitlist side: an
export stating something authoritatively that the app knows to be unreliable.

The underlying discomfort is real but lives in the label, not the data: check-in
computes `isAttended = status === 'attended'` and renders everything else as
**"No-show"**, so an untouched `registered` row already *looks* recorded. Filed with
§6.1 rather than fixed here.

### 2.5 The fourth site (#182 comment 1) is folded in

The manual-cancel branch builds its notification body from `cls`, read at the top of
the handler before `parseBody`'s await and outside the transaction
(`transition/route.ts:96`). Since `date` and `startTime` are not in `ECONOMIC_FIELDS`,
a teacher can reschedule a booked `open` class at any time, so a concurrent reschedule
makes the notice name the wrong day.

**Decision: do the re-read.** Four lines, no new lock — the CAS is already the
serialization point, as the route's own comment says. The 24-line `KNOWN RESIDUAL`
note at `:67-90` is **deleted**, not rewritten.

---

## 3. Design

### 3.1 `closeQueueOnStart` (new, `src/services/waitlist.ts`)

```ts
export async function closeQueueOnStart(
  tx: TransactionClientOnly,
  classId: string,
): Promise<number>
```

Writes `status: 'expired'` over every `waiting` row for `classId`; returns the count.

- **`TransactionClientOnly`**, the branded type from `db-locks.ts:65`, not
  `waitlist.ts`'s local `PrismaTransactionClient` alias. Running this outside a
  transaction — where the status flip and the queue close could commit separately —
  *is* the defect, so the type should refuse a bare client.
- **No reorder.** `reorderWaitingEntries` renumbers only `waiting` rows, so closed rows
  keep stale positions by design (#183). Closing an entire queue at once leaves nothing
  to renumber, which is why both cancel paths call `updateMany` with no reorder.
- **No notification.** #112's promise was about a class *ceasing to be offered*. A class
  that ran is not that, and "it happened without you" is noise to someone who was never
  promised a seat.
- **No read-before-write.** The cancel paths read first because they need a recipient
  list. This one does not; `updateMany`'s returned count is the whole result.

### 3.2 The three call sites

**(a) `transitionClass` (`class-lifecycle.ts:124-148`).** The CAS gains a transaction;
the refusal-diagnosis reads stay outside it, so the transaction holds exactly the two
writes and nothing on the failure path.

```ts
const closed = await db.$transaction(async (tx) => {
  const updated = await tx.class.updateMany({
    where: { id: classId, status: { in: sourceStatesFor(targetStatus) } },
    data: { status: targetStatus },
  });
  if (updated.count !== 1) return false;
  if (targetStatus === 'in_progress') await closeQueueOnStart(tx, classId);
  return true;
});
if (closed) return { ok: true, newStatus: targetStatus };
// ...existing refusal diagnosis, unchanged, outside the transaction
```

`transitionClass`'s docblock currently argues at length that it needs no `FOR UPDATE`
because status is the only input to its decision. **That argument still holds** and
must be preserved rather than deleted: the close's own predicate (`classId`,
`status: 'waiting'`) is re-evaluated by Postgres at execution time, and the CAS
`UPDATE` has already taken the `Class` row lock every `WaitlistEntry` writer conflicts
on. The docblock gains a paragraph, not a correction.

**(b) `completeClass` (`class-lifecycle.ts:208-211`).** Already inside a transaction
under `lockClassRow`. One line after the inline bump:

```ts
if (cls.status === 'open') {
  const toInProgress = validateTransition('open', 'in_progress');
  if (!toInProgress.ok) return toInProgress;
  await tx.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
  await closeQueueOnStart(tx, classId);
}
```

The `else` branch needs nothing: a class already `in_progress` had its queue closed
when it got there, and `addToWaitlist` refuses a non-`open` class, so no new `waiting`
row can appear afterwards. `VALID_TRANSITIONS` has no path back to `open`, so the
invariant closes forward.

**(c) `autoTransitionToInProgress`** — see §3.3.

### 3.3 `autoTransitionToInProgress` gets a lock (#182 acceptance 1)

Rewritten to mirror `autoCancelClasses` exactly:

```
snapshot findMany (pre-filter only)
  → per class: $transaction
      → lockClassRow
      → re-read status, date, startTime, teacher.defaultTimezone
      → if !fresh || fresh.status !== 'open' → false
      → recompute classStartInstant from the FRESH row; if start > currentTime → false
      → CAS: updateMany({ where: { id, status: 'open' }, data: { status: 'in_progress' } })
      → if count === 0 → false
      → closeQueueOnStart(tx, cls.id)
      → true
```

The timing check must be recomputed from the **fresh** row, not merely re-tested. That
is the whole defect: `date`/`startTime` are not in `ECONOMIC_FIELDS`, so a teacher can
reschedule an `open` class with registrations at any time, and a stale snapshot starts
a class that has been moved.

Two consequences to record rather than let pass:

- **The sweep stops calling `transitionClass`.** It hardcodes `status: 'open'` in its
  CAS, exactly as `autoCancelClasses` does, losing `sourceStatesFor`'s derivation from
  the state machine. Accepted for consistency with the sibling sweep; the sweep's own
  `findMany` already filters on `status: 'open'`, so the literal appears twice in one
  function and reads as the sweep's subject rather than a duplicated constant.
- **The `log.error` at `:79` goes away.** A refusal is no longer an error — it is the
  ordinary "someone else got there first" outcome, and `autoCancelClasses` returns
  `false` silently for the same case.

### 3.4 `autoCompleteClasses` — the decision moves into `completeClass` (#182 acceptance 1)

`completeClass` already takes `lockClassRow` *before* its read and already re-reads the
class row. It simply never checks timing. Wrapping a second lock around it from the
sweep would be redundant; the decision should move to where the lock already is.

```ts
export async function completeClass(
  db: PrismaClient,
  classId: string,
  opts: { requireEndedBy?: Date } = {},
): Promise<TransitionDbResult>
```

Under the lock, after the re-read:

```ts
if (opts.requireEndedBy) {
  const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
  const end = new Date(start.getTime() + cls.durationMinutes * 60_000);
  if (opts.requireEndedBy < end) {
    return { ok: false, error: `Class ${classId} has not ended yet` };
  }
}
```

`completeClass`'s `include` gains `teacher: { select: { defaultTimezone: true } }`.

**Optional, and that is the point.** `completeClass` has three callers:

| Caller | Passes `requireEndedBy`? | Why |
|---|---|---|
| `autoCompleteClasses` (`class-transitions.ts:403`) | **yes**, `currentTime` | the sweep must not complete a class that was rescheduled later |
| `POST /api/classes/[id]/complete` (`:25`) | no | a teacher finishing early is legitimate |
| `deleteTeacherAccount` (`gdpr.ts:716`) | no | erasure completes in-flight classes regardless of clock |

The sweep keeps its own timing computation as a **pre-filter only**, with the same
comment `autoCancelClasses:143-162` carries: a stale pre-filter can only ever *delay*
a completion by one 60-second tick, never cause a wrong one, because nothing there
decides — it only decides whether to look properly.

### 3.5 The attendance PUT (#182 acceptance 3)

```ts
if (registration.class.status === 'cancelled') {
  return respondError('Cannot record attendance on a cancelled class', 409);
}

const updated = await prisma.registration.updateMany({
  where: { id, status: { notIn: ['cancelled', 'late_cancel'] } },
  data: { status: parsed.data.status },
});
if (updated.count === 0) {
  return respondError('Cannot record attendance on a cancelled registration', 409);
}
return respondOk({ id, status: parsed.data.status });
```

The handler's existing `findUnique` gains `status` on its `class` select. The response
returns `parsed.data.status` rather than `updated.status`, since `updateMany` returns a
count — a small shape change the response type already accommodates.

### 3.6 The manual-cancel notice (§2.5)

After the CAS in `transition/route.ts`, re-read inside the transaction and interpolate
from that row; delete the `KNOWN RESIDUAL` block at `:67-90`. The comment explaining
why `relatedClassId` is inert (`:59-65`) stays — it is unrelated and still true.

---

## 4. Claims this branch makes false

Per the process rule that a correction lands in **every** artifact, not just the one in
front of you. Each of these must be re-derived from the branch's diff at review time,
not grepped for by keyword.

| Location | What goes stale |
|---|---|
| `tests/integration/waitlist-display.test.ts:245-248` | needs the `expired` fixture row and a rewritten comment |
| `src/services/waitlist-reconciliation.ts:163-174` | the `class: { status: 'open' }` join becomes redundant rather than load-bearing; the comment is the main written record of *why* the candidate set was unbounded, so narrow it — do not delete it, and do not remove the join (it is a cost bound, and removing it fails no test by design — #222) |
| `src/app/(student)/bookings/page.tsx:41-62` | "nothing closes the queue when a class leaves `open` by starting (#216)" and "#216 is now the only drain" both become false |
| `src/services/class-transitions.ts:200-211` | the PUT's "not a normal thing to do" is wrong (§1.5) **and** now guarded |
| `src/services/class-transitions.ts:253-258` | "The identical stale-window race is still live in `autoTransitionToInProgress` above and `autoCompleteClasses` below" — both fixed here |
| `src/services/class-transitions.ts:218-230` | the enumeration of `WaitlistEntry` writers gains `closeQueueOnStart` |
| `src/services/waitlist.ts:722-724` | narrow to: the PUT now guards registration status and class status, and still does not guard class time. **It cites `class-transitions.ts:199` by line number**, which this branch moves |
| `src/services/waitlist.ts:861-875` | "two writers flip `WaitlistEntry.status` from `waiting` to `removed`" — a third writer now exists, writing `expired` |
| `src/app/api/classes/[id]/transition/route.ts:67-90` | deleted (§3.6) |
| `docs/lock-order.md` | **0 occurrences** of either sweep today. Both become conforming sites: add to "Known conformance" (`:598+`) and to the "Classes per transaction" table (`:223+`) |
| `src/services/gdpr.ts:288-298` | the `waitingCount` **must not change** (see §7) — but the population it counts no longer grows, which the comment may note |
| Issue #199's body, and `docs/backlog-roadmap.md`'s "Someone is currently worse off" entry | both repeat "#195 fixes forward only … the population is bounded and no longer grows", which #216 falsified. This is #216 acceptance 4 |

---

## 5. Testing

One test per site — they share no code path — each with a **mutation proof**: break the
guard, record the exact failure text, restore, re-verify.

| # | Behaviour | Mutation that must fail it |
|---|---|---|
| 1 | the sweep closes the queue to `expired` | delete `closeQueueOnStart` from `autoTransitionToInProgress` |
| 2 | `POST .../transition` with `in_progress` closes the queue | delete the `targetStatus === 'in_progress'` call in `transitionClass` |
| 3 | `completeClass` on an `open` class closes the queue | delete the call from the open-bump branch |
| 4 | the sweep refuses a class rescheduled after the outer read | make the in-transaction check re-use the snapshot's `start` |
| 5 | `completeClass({ requireEndedBy })` refuses a class rescheduled later | drop the `requireEndedBy` comparison |
| 6 | PUT on a `late_cancel` registration → 409 | drop `notIn` from the `where` |
| 7 | PUT on a `cancelled` class → 409 | drop the class-status reject |
| 8 | **PUT on a `completed` class → 200** | add `completed` to the rejected set |

Test 8 pins a *product requirement*, not a defect. It exists so a future lock-discipline
pass cannot quietly close the hole §2.3 keeps open on purpose. Its comment must say so.

**Mutation values must be ones the code under test cannot produce.** For 4 and 5, move
the class to a date far outside any sweep window rather than by minutes — a nudge that
lands inside the window the sweep already accepts proves nothing.

**Ask of each test whether it could have failed at all.** Tests 4 and 5 turn on
timezone-resolved start instants, and a test that passes by coincidence of the hour it
ran proves nothing. `prisma/seed.ts:8-22` records the concrete hazard: on
`Europe/Amsterdam`, local midnight is `22:00Z` *the previous day*, which is how every
relative date in that file once landed a day early. So a class placed near midnight can
resolve to a different calendar day depending on when the suite runs. Pin explicit
timezones and place class times away from midnight, so neither test's outcome can turn
on the wall clock of the machine running it.

(An earlier draft of this section cited that comment as a warning about "a UTC window in
which both code paths render identically". It is not — it is about *writing* a calendar
date with local instead of UTC accessors. The hazard is real; the citation was wrong.)

Plus the fixture row in `waitlist-display.test.ts` (§1.3), which is a **negative**
requirement: it exists so that a future `notIn` predicate cannot pass while leaking
`expired`.

---

## 6. Spun out rather than folded

### 6.1 Attendance cannot be edited after the class (to be filed)

`AttendanceList` renders only when
`cls.status === 'in_progress' || (cls.status === 'open' && minutesToStart <= 15)`
(`class/[id]/page.tsx:108`); a `completed` class renders `PricingBreakdown` +
`PaymentChecklist` and nothing else (`:172-177`). `autoCompleteClasses` flips a class
to `completed` **within 60 seconds of its scheduled end**. So the attendance UI appears
15 minutes before the start and disappears about a minute after the end — the teacher's
only window is while they are teaching.

Every teacher hits this every class. It is filed rather than folded because it is a UI
change with an open design question (does the editing window ever close?) on a branch
already carrying two issues. **The PUT guard landing here is what makes it safe to
build** — §2.3 keeps `completed` writable precisely for it, and test 8 pins that.

The issue should also carry:

- the "No-show" label conflation from §2.4 — `registered` and `no_show` render
  identically in check-in, which is what makes an auto-flip look attractive
- §2.4's decision and its reasoning, so the auto-flip is not re-proposed

---

## 7. Not in scope

- **`gdpr.ts:298`'s `waitingCount` must not be "harmonised"** with #199's
  `class: { status: 'open' }` predicate. It sizes an erasure transaction's timeout;
  stranded rows inflate it in the *safe* direction, and the comment above it documents
  the undershoot as the dangerous failure. Once this branch closes the rows the count
  corrects itself at the source.
- **The reconciliation sweep's join must not be removed** (§4).
- **Backfill** — 0 rows, no production (§1.3).
- **`draft → cancelled`** — a draft class cannot hold registrations, so it cannot hold
  a queue.
- **`StudioClass`** — has no waitlist.
- **#182's `PUT` class-*time* guard** — deliberately not added (§2.3).
- **#229** (`{Class, ClassTemplate}` lock order) is unaffected.
