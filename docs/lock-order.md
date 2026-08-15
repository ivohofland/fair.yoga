# Lock order

Nothing enforces this. It is a convention, and the only defence against a
deadlock is that every transaction taking two of these rows takes them in this
order:

    Class → WaitlistEntry → Registration → StudentPrivacy → TeacherStudent → Invitation → TeacherBlock

## Why it is written down rather than enforced

Postgres breaks a genuine cycle by aborting one transaction with `40P01`, which
reaches the user as a 500 through `withErrorHandler`. No constraint, trigger or
type can prevent the cycle forming — only the order can.

## `Class` is the real gate; the rest is not

`Class` is not merely first in the list — every site below that touches more
than one of these tables also holds `Class`'s row lock before touching any of
the others, *when it touches `Class` at all*. Three different statements take
that lock and all three count: `lockClassRow`, an inline
`SELECT ... FOR UPDATE`, and a compare-and-swap `class.updateMany` (an
`UPDATE` locks the rows it matches — `deleteTeacherAccount` takes its
per-class lock this way and no other, so a version of this sentence that names
only the first two writes it out of the rule it is subject to). `POST
/api/registrations` writes `Registration` before `WaitlistEntry`;
`promoteNext` can write `WaitlistEntry` before `Registration`, but only
conditionally (the stale-head-drop loop — it runs only when the current queue
head already holds an active registration, not the common case); `claimSpot`
never writes `WaitlistEntry` before `Registration` at all — its `WaitlistEntry`
writes are the promotion `update` and the `reorderWaitingEntries` call after
it, both after `activateRegistration`. (Not "its only `WaitlistEntry` write":
the reorder is a second one, and it issues an `UPDATE` per remaining queue
member.) An earlier version of this document claimed otherwise for both, first
corrected in round 1 review. None of
that is a bug regardless: all three of those sites lock `Class` first, so only
one of them can ever be past that lock for a given class at a time — they
cannot hold conflicting `WaitlistEntry`/`Registration` locks concurrently
regardless of which table each reaches for second, or whether it reaches for
it at all. That protection is real but conditional twice over — on the `Class`
lock actually being taken, and on it covering the rows the transaction goes on
to write. `deleteStudentAccount` under "Known conformance" is a case where the
second condition fails (its `Class` lock set is strictly smaller than its
`WaitlistEntry` write set) and the cycle outside that set was reproduced, so do
not read this section as a blanket escape. The first condition is why the
entries further down this list matter: several
sites reach `StudentPrivacy`, `TeacherStudent`, `Invitation` or `TeacherBlock`
for a (teacher, student) or (teacher, email) pair with **no** `Class` row in
scope at all (`unlinkTeacher` when the student is not waiting in any of that
teacher's classes; `acceptInvitation`; `deleteStudentAccount` erasing links to
teachers whose classes the student never joined a waitlist for). For that
suffix of the list — `StudentPrivacy → TeacherStudent → Invitation →
TeacherBlock` — the order is the *only* thing preventing a cycle, not a
side-effect of a shared lock elsewhere. Both of #174 task 7's fixes are in
that suffix.

## Ordering WITHIN `Class`

The list above orders the *tables*. It says nothing about the order of two rows
of the SAME table, and `Class` is the one table where that matters: **five**
sites lock more than one `Class` row inside a single transaction, and two of
them taking the same pair in opposite sequences is an AB-BA cycle exactly like
any cross-table one.

**The rule: ascending by `id`. All five take an order now — but one of the
five is not total, and that exception is load-bearing.** See "The slot key is
a wait edge" below before assuming `id` is the only thing that orders two
`Class` rows: since #196 a unique index on `(teacherId, date, startTime)`
makes plain INSERTs take part too, which is a case the five-site enumeration
is built not to find. An earlier version of this section said "three sites"
and "all three take it that way"; both were false, and an enumeration
asserted as complete is exactly what stops the next reader looking for the
ones it missed. A later version said two of the five disagreed, live and
unfixed; that too is stale — `syncTemplateInstances` and
`archiveOrUnarchiveTemplate` each gained an ordered pre-lock ahead of their
respective multi-row write (issue 180, atomic-template-update).

**A third version said "all five follow it now", flatly, and that is the one
this paragraph exists to correct.** `archiveOrUnarchiveTemplate`'s pre-lock
covers `date > today`, so a same-day instance rescheduled into the future by
`updateClass` (`class-lifecycle.ts`) — a bare `db.class.updateMany` holding
neither the template lock nor any `Class` lock — between that pre-lock and
the `deleteMany` is deleted without ever having been held in order. The
AB-BA cycle against `deleteStudentAccount` can still form through that
window. It is narrow (it needs a concurrent reschedule *and* an erasure of a
student waitlisted across both classes, timed into the same gap), it is
measured rather than theorised, and it is no worse than the pre-branch state,
which had no ordering at all — but it is not closed, and the deleted "two
that do not" section warned in as many words that shipping a cycle under a
comment saying it was closed is the failure mode this whole document exists
to prevent. Tracked as a residual in the atomic-template-update spec's risk
list. `syncTemplateInstances` does not share it: its write set is
`id: { in: lockedIds }`, a structural subset of what its own pre-lock
returned, not a predicate re-evaluated later.

| Site | How it locks | Order it takes |
|---|---|---|
| `deleteStudentAccount` (`gdpr.ts`) | `lockClassRow` in a loop | ascending — `[...ids].sort()` in JS, before the loop |
| `withdrawWaitingEntriesForTeacher` (`waitlist.ts`) | one `SELECT … FOR UPDATE OF c` | ascending — `ORDER BY c.id` in SQL |
| `deleteTeacherAccount` (`gdpr.ts`) | the per-class cancel CAS `UPDATE`, one per iteration | ascending — `orderBy: { id: 'asc' }` on the read the loop walks |
| `syncTemplateInstances` (`template-sync.ts`) | `class.deleteMany` (wrong-day) then `class.updateMany` (same-day), each multi-row | ascending — an ordered `SELECT … FOR UPDATE OF c … ORDER BY c.id` pre-lock (issue 180) taken before either write; the delete/update statements themselves still visit in whatever order the planner picks, but every row either could touch is already held by the pre-lock |
| `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`) | one multi-row `class.deleteMany` | ascending, **but not total** — an ordered `SELECT … FOR UPDATE OF c … ORDER BY c.id` pre-lock over the full `scheduledWhere` candidate set, taken before the `deleteMany`; both statements bounded at 2s by `SET LOCAL lock_timeout`. The pre-lock covers `date > today`, so an instance rescheduled out of today by `updateClass` after it runs is deleted unheld — see the paragraph above the table |

`syncTemplateInstances`'s pre-lock carries no `status`/`settingsLocked`
narrowing beyond `templateId`/`teacherId`/`date >` the current UTC calendar
date, so it briefly locks every future instance of the template — including
ones already `settingsLocked` by a registration, which its own writes will
never touch. That is the safe direction for lock ordering, but it means a
booking on one of those instances can now contend with a template edit, where
before this branch it could not — **for the rest of the edit transaction, not
merely for the pre-lock statement**. `SELECT … FOR UPDATE` holds until the
transaction ends, so in production the exposure is bounded by
`updateClassTemplate`'s `{ timeout: 15_000 }`, not by how long the `SELECT`
itself takes.

### How that enumeration was derived

Mechanically, not by recall — the defect being fixed was an incomplete list
asserted as complete. An earlier version of this passage opened by asserting
that a `Class` row lock "can only come from `UPDATE`, `DELETE` or
`SELECT … FOR UPDATE` on that table". That is false — there is a fourth path,
described after the list — and a completeness argument resting on it was
unsound even though its answer happened to be right.

The candidate set is bounded by these four checks over `src/`, minus
`*.test.ts` (re-runnable; deliberately greps rather than counts, since a count
rots on the first unrelated change and one of these hits a docblock rather than
a call):

1. `\bclass\.\(update\|updateMany\|delete\|deleteMany\|upsert\)(` — the Prisma
   writes **that can lock an existing row**. `create`/`createMany` are
   deliberately absent: a freshly inserted row's lock conflicts with nothing,
   so it carries no ordering obligation. **`createManyAndReturn` joins them**,
   for the same reason and not by oversight: #164/#192 replaced both
   generators' per-date `create` loop with one `createManyAndReturn`, which is
   still only inserts. Re-run at that time: this grep returned 14 on the branch
   and 14 on `main`, so the candidate set did not move. The occupancy
   `findMany` those generators gained, and the `class.count` on the class
   family's resume, are reads — no locks under READ COMMITTED, no edges.
   **True of the row, false since #196 of its index entries** — see "The
   slot key is a wait edge" below: a bare `create`/`createManyAndReturn`
   still cannot conflict on the row it inserts, but it can now conflict on
   `(teacherId, date, startTime)`, which is why this check alone no longer
   bounds the candidate set for `Class`, and neither does the multiplicity
   filter below;
2. `'"Class"'` — the raw statements: **8** in total, re-counted for this
   branch rather than trusted (grep it yourself before relying on this
   number — that is this whole subsection's point). **5** are single-id
   `FOR UPDATE`: four written inline, plus `lockClassRow`'s body (itself
   called from exactly five places, grep 3 — re-derived on the
   waitlist-reconciliation branch, where the previous count of four turned
   out to be already stale). The reconciliation sweep
   (`services/waitlist-reconciliation.ts`) adds no call site of either kind,
   but it reaches **both** kinds through `handleSpotFreed`: the broadcast
   branch's bounded `lockClassRow` in `handleSpotFreed` (`waitlist.ts`),
   and — via the
   auto-promote branch and `promoteNext` — one of the four inline
   `FOR UPDATE`s, which is unbounded (#104). Stating only the first would
   understate what a contended tick can wait on. Its multiplicity is
   `autoCancelClasses`': a loop over classes, each in its own
   `db.$transaction`, so it holds one row lock at a time and never two. **The
   other 3 are multi-row, not one**: `withdrawWaitingEntriesForTeacher`'s join
   (`waitlist.ts:904`), and the atomic-template-update branch's two ordered
   pre-locks — `syncTemplateInstances` (`template-sync.ts:77`) and
   `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`, the
   `$queryRaw` immediately above its `waitlistEntry.findMany` candidate
   read), each an
   `ORDER BY c.id … FOR UPDATE OF c` ahead of its own multi-row write (issue
   180, "Ordering WITHIN `Class`" above). An earlier version of this passage
   said "all but one … the exception is `withdrawWaitingEntriesForTeacher`'s
   join" — true before those two pre-locks existed, stale now that the table
   above them already reflects both;
3. `lockClassRow(` — the helper's callers;
4. **parent deletes that cascade onto `Class` without naming it** — the
   category a grep for `class.` misses. `Class` holds three FKs pointing *out*
   at its parents: `teacher` (`onDelete: Cascade`), `template`
   (`onDelete: SetNull`), and `teacherRoom` (no action given, so `Restrict` —
   a required relation, so it errors rather than writing). Deleting one of
   those parents would therefore issue a mass `DELETE`/`UPDATE` across `Class`
   rows. No `teacher.delete` or `classTemplate.delete` exists anywhere in
   `src/`: erasure soft-deletes teachers and archiving soft-deletes templates.
   If either ever becomes a hard delete, it joins this table.

Each candidate was then classified by multiplicity — can this transaction end
up holding more than one `Class` row lock? Single-`id` writes and single-`id`
`FOR UPDATE`s cannot; a loop or a multi-row predicate can. That leaves the five
above for lock-ordering *within* `Class`, the concern this section derives.
**It is not the right bound for `Class` as a whole any more.** Since #196 a
single-row write can be half of a slot-key deadlock without ever holding a
second `Class` row lock — see "The slot key is a wait edge" below, where
`updateClass` joins the candidate set on exactly that basis despite locking
only one row. Note `autoCancelClasses` is *not* one of the five multi-lock
sites: it opens a separate `db.$transaction` per class, so it holds one row
lock at a time.

**The fourth path, which none of those checks would find: an FK lock taken
from a CHILD table, by an `INSERT` that never mentions `Class` at all.**
Inserting a row that references a class — `Registration`, `WaitlistEntry`,
`Notification.relatedClassId`, `Announcement.classId` — makes Postgres take
`FOR KEY SHARE` on the parent `Class` row for the rest of that transaction.
That is not a weak advisory lock: measured here, an uncommitted
`notification.create` carrying `relatedClassId` made a third connection's
`SELECT … FOR UPDATE NOWAIT` on that class fail with `55P03`, and blocked a
`DELETE` of it. So it conflicts with `lockClassRow` and with every site in the
table above.

It changes the answer nowhere, and that was checked rather than assumed: a
transaction only acquires a *second* `Class` lock this way if it inserts
children of more than one class. Exactly one does — `deleteTeacherAccount`'s
`createBulkNotifications` — and it runs inside the per-class loop, on the class
whose CAS it has just taken, so the `FOR KEY SHARE` lands on a row it already
holds a stronger lock on, in the same ascending sequence. Every other
child-insert in `src/` is scoped to one class per transaction.

That was checked across every `createBulkNotifications` call site, and "every"
is the word this passage exists to earn: an earlier version of it asserted
completeness and then listed **seven**, where `grep -rn 'createBulkNotifications('
src/` (minus the definition in `notifications.ts`) returns **eleven**. Three
were missing — `autoCancelClasses` (`class-transitions.ts`),
`sendPaymentReminder` (`payments.ts`), and `handleSpotFreed`'s broadcast, a THIRD site in
`waitlist.ts` beyond the two "both waitlist paths" covered. Re-derived here in
full, with the class each one's notifications carry:

| Call site | Classes per transaction |
|---|---|
| `deleteTeacherAccount` (`gdpr.ts`) | one — the loop's current class (the named exception above) |
| `autoCancelClasses` (`class-transitions.ts`) | one — `cls.id`, and one transaction per class |
| `completeClass` (`class-lifecycle.ts`) | one — `cls.id` |
| `promoteNext` (`waitlist.ts`) | one — `classId` |
| `claimSpot` (`waitlist.ts`) | one — `classId` |
| `handleSpotFreed` broadcast (`waitlist.ts`) | one — `classId`, inside its own transaction under `lockClassRow` (#212) |
| `sendPaymentReminder` (`payments.ts`) | one — the payment's registration's class |
| `sendPaymentReminders` (`payment-reminders.ts`) | one — per-payment, one transaction each |
| `POST /api/registrations` | one — the class being booked |
| `POST /api/announcements` | one — the announcement's class, inside the dedupe transaction (#196; it ran outside any transaction until then) |
| `POST /api/classes/[id]/transition` | one — the class being transitioned |
| `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`) | **many** — every class the archive withdrew (#112) |

> **#212 moved the broadcast inside a transaction, and the order is unchanged.**
> It was one of **four** `createBulkNotifications` sites taking no `Class` row
> lock. The other three still take none: `sendPaymentReminder`
> (`payments.ts`) and `sendPaymentReminders` (`payment-reminders.ts`), both
> payment-scoped and reaching a class only through the `relatedClassId` on the
> notification they write; and `POST /api/announcements`, whose
> `lockAnnouncementSlot` is an **advisory** lock, not a `Class` row lock — as
> the #196 section of this document already says 300 lines below. It now takes `lockClassRow` and then inserts
> notifications carrying `relatedClassId` — a `FOR KEY SHARE` on the row it
> already holds `FOR UPDATE`, exactly as `deleteTeacherAccount`'s named
> exception above. One class per transaction, so it adds no edge.
>
> The first sentence originally read "the **one** site that took no `Class`
> lock at all", which was false, and it is left recorded rather than quietly
> corrected: it was written into #212's spec, carried into the plan, and
> implemented faithfully — a completeness claim asserted twenty lines below
> the paragraph explaining that an earlier completeness claim here undercounted
> seven against eleven. Neither `payments.ts` nor `payment-reminders.ts`
> contains `lockClassRow` or `FOR UPDATE`; that is one grep, and it was not run
> until PR review.

Five stands — but a future sweep that notifies across classes in one
transaction would be a sixth site, and none of the four checks above would
surface it.

**That sweep arrived, and it is the twelfth row above.** #112 made
`archiveOrUnarchiveTemplate` notify the waiting students of every class its
`deleteMany` took, in one `createMany`, inside the archive transaction — the
first site in `src/` that notifies across more than one class at a time, and
exactly the case this paragraph predicted would slip past the four checks. It
did: nothing in that change touched this file until PR review caught it.

The answer is still unchanged, for a reason worth stating rather than
re-deriving: those notifications carry **no `relatedClassId`**. They cannot,
because their classes are deleted earlier in the same transaction and the FK
would reject the insert. `Notification.recipientId` has no foreign key at all,
so that `createMany` takes `FOR KEY SHARE` on nothing and adds no edge to the
order — the one child-insert in the codebase that notifies across many classes
is also the one that references none of them.

Read that as a coincidence this file is now watching, not as a rule. Give an
archive notification a `relatedClassId` and it becomes a transaction taking
`FOR KEY SHARE` on many `Class` rows at once, in `candidates` order, which is
whatever the query planner returned — not the ascending order the rest of this
document depends on.

Three things about that table are easy to get wrong and are the reason it exists:

**The lock order of a loop is the order of the read it walks.** `deleteTeacherAccount`
takes no explicit lock at all — its `UPDATE` is the lock — so there is no line
of code that "takes the locks" to inspect. Its `findMany` had no `orderBy` until
the whole-branch review of #174, which meant its lock order was whatever the
heap returned: for freshly inserted rows, physical (insertion) order, which is
uncorrelated with id. Against `deleteStudentAccount`, which sorts, that is a
live cycle and it was reproduced — Postgres `40P01 deadlock detected`, either
side the victim. Pinned by `gdpr.test.ts`, "does not deadlock when a teacher
erasure and a student erasure overlap on two classes"; that test fails with
that error if the `orderBy` is removed. The same fix closes the inherited
disagreement with `withdrawWaitingEntriesForTeacher`, which has sorted since
#166.

**JS and SQL have to agree, and that was checked, not assumed.** One of the
three ordered sites sorts in JavaScript and two sort in Postgres, so
`[...].sort()` and `ORDER BY id` producing different sequences would
reintroduce the cycle with every site looking individually correct. Verified
directly against this project's database: `Class.id` is `text` with the default
collation, the database is `en_US.utf8`, and over 4000 random uuids the
JS-sorted and SQL-sorted sequences were identical element for element. The
check is scoped to uuid-shaped ids (`[0-9a-f-]` only) — that is all `Class.id`
ever holds — and should be re-run rather than assumed if that ever stops being
true.

**Sorting the id array does NOT order a multi-row write.** This is the trap the
two unordered sites sit in, and it is why neither was "fixed" with a one-line
sort. `class.deleteMany({ where: { id: { in: ids } } })` compiles to
`… WHERE id = ANY($1)`, and the row-visit order — which *is* the lock order —
is chosen by the planner, never by the array. Measured directly: one
transaction holding a row, the multi-row `UPDATE` blocked on it, and a third
transaction probing the other row with `FOR UPDATE NOWAIT` gave an identical
answer for both array orders, in both directions. The array order changed
nothing.

Which order you actually get depends on the plan, and therefore on table size
and statistics — the measured fixture took a `Seq Scan` (heap order), a large
table may take a bitmap scan (also heap order) or a btree `ScalarArrayOp` index
scan (index order, which for `id` would *coincidentally* be ascending). Do not
build on that coincidence: it can change under you with no code change at all,
which is worse than a plainly wrong order because it will test green.
`archiveOrUnarchiveTemplate` does not even pass ids — its `deleteMany` takes a
predicate, so it has no array to sort in the first place.

Ordering a multi-row write means locking the rows first, explicitly: an
`ORDER BY … FOR UPDATE` ahead of the write itself — what
`withdrawWaitingEntriesForTeacher` does, and what `syncTemplateInstances` and
`archiveOrUnarchiveTemplate` now do too, as an ordered pre-lock ahead of their
`updateMany`/`deleteMany` (issue 180) — or a `lockClassRow` loop over a sorted
read (what `deleteStudentAccount` does).

### The slot key is a wait edge, and the table above cannot see it (#196)

`Class_teacher_slot_unique` — `(teacherId, date, startTime) WHERE status <>
'cancelled'` — is a lock in every sense that matters here. Two transactions
writing the same key make the second wait on the first's uncommitted index
entry, as a `ShareLock` on the first's transaction id, which the deadlock
detector reads exactly like a row lock. The upsert-quirk section below already
says this in one line about `TeacherStudent`. On `Class` it has two
consequences the five-site table above is shaped to miss.

**It falsifies a stated premise of "How that enumeration was derived".** Check 1
excuses `create`/`createMany`/`createManyAndReturn` — "a freshly inserted row's
lock conflicts with nothing, so it carries no ordering obligation". True of the
row, false of its index entries since #196: `updateClass`'s single-row
`UPDATE` was measured as one half of a reproduced `40P01` (see "The slot key
is a wait edge" below — `syncTemplateInstances` vs `updateClass`, 1 of 120
runs, and `updateClass` vs `updateClass`, 32 of 100). The generator's own
`createManyAndReturn` is not what was reproduced here: measured against
`syncTemplateInstances` it came back clean, 6 of 6, in the shipped
configuration (see "The pairing that looks worst is currently unreachable"
below), and only deadlocks — 3 of 3 — once `ClassTemplate_teacher_slot_unique`
is dropped. For `Class` the candidate set is no longer "statements that can
lock an existing row" but **"statements that write `(teacherId, date,
startTime)`"** — every
`Class` insert, and every update of those three columns or of `status` across
the `cancelled` boundary. `updateClass` (`class-lifecycle.ts`) joins on that
basis: its `class.updateMany` accepts `date` and `startTime` from
`updateClassSchema`, and a single-row autocommit `UPDATE` turns out to be
perfectly capable of being half a cycle.

**And unlike the ascending-by-`id` rule, this one has no order to take.** A
transaction that moves a class from one slot to another *vacates* one key and
*claims* another in the same statement. Two of them crossing — each claiming
what the other is vacating — deadlock whatever order anything is sorted in.
There is no pre-lock that fixes it either: the resource is a key that does not
exist yet.

Reproduced against the real functions, on a throwaway database with the full
migration history, **with no handshake at all** — these are the statements
production issues, raced as-is:

- **`syncTemplateInstances` vs `updateClass`**, crossing on one date (the sync
  moves the template's instance 09:00 → 10:00 while the teacher moves a
  one-off class on that date 10:00 → 09:00): `40P01` in **1 of 120** runs,
  raised on the `updateClass` side. The other 119 ended with both sides taking
  an ordinary `23505` — the window is one row's heap-update-to-index-insert
  gap, so it is narrow, not absent. Postgres names the resource itself:
  `CONTEXT: while inserting index tuple (1,31) in relation
  "Class_teacher_slot_unique"`.
- **`updateClass` vs `updateClass`**, two classes on one date swapping their
  start times: `40P01` in **32 of 100** runs, either side the victim. Two
  single-statement autocommit `UPDATE`s, no transaction on either side.

Both are new to #196, proven by mutation rather than argued: with
`Class_teacher_slot_unique` dropped and nothing else changed, the same races
run clean — 120 of 120 for `syncTemplateInstances` vs `updateClass`, 60 of 60
for `updateClass` vs `updateClass`. The second figure is a smaller sample than
the 100-run original measurement above; the point of this mutation check is
the pattern disappearing entirely once the index is gone, not reproducing the
original run count, and 60/60 clean already establishes that as firmly as
100/100 would — and leaves behind exactly the duplicate slots #196 exists to
prevent. The trade was taken knowingly in that direction; it is
recorded here, not fixed. The cheap fix (retry on `40P01`) is a decision about
`withErrorHandler`, not about lock order, and a deferrable unique index would
give up the immediate `409` the create routes answer with.

**The pairing that looks worst is currently unreachable, and only because a
SECOND new index blocks it.** A `POST /api/class-templates` transaction
(`classTemplate.create`, then a four-week `createManyAndReturn`) against a
`syncTemplateInstances` transaction is the case where both sides hold several
`Class` slot keys across statements — the generator inserting in date order,
the sync updating in heap order, an inversion of exactly the kind this section
is about. Measured both orderings, three runs each, widened with a third
connection holding one `Class` row so the sync sat parked mid-`updateMany`
(confirmed by `FOR UPDATE NOWAIT` from a fourth connection answering `55P03`
for a row it had already taken): **no `40P01`, 6 of 6**. Every run died earlier
and elsewhere — `P2002` on `ClassTemplate_teacher_slot_unique`, at
`classTemplate.create` or at the PUT's `classTemplate.update`.

That is not the probe failing to bite. Drop `ClassTemplate_teacher_slot_unique`
alone, leave everything else as it is, and the identical race deadlocks **3 of
3**, on the generator's insert:

```
A (POST /api/class-templates): REJECTED 40P01 deadlock detected
    at class-generator.ts:177  db.class.createManyAndReturn()
B (syncTemplateInstances)    : ok {"synced":4,"regenerated":0,"kept":0}
```

The reason is structural, not luck. Two template-driven writers can only
collide on `(teacherId, date, startTime)` if their templates agree on
`(teacherId, dayOfWeek, startTime)` — a template generates on one weekday at
one time, so same slot means same weekday and same time — and that is the key
`ClassTemplate_teacher_slot_unique` forbids. The archived-template hole in that
partial index does not open it: archiving deletes every future `draft`/`open`
instance (`scheduledWhere`, `gt: today`), and what survives is either dated
today or in a status `syncTemplateInstances`'s `mutable` filter drops, so an
archived template's sync writes no slot key at all.

So one of the six new indexes is what keeps another of the six from being a
live deadlock. **Nothing in the code says so, and nothing enforces it** — which
is the same condition as the rest of this document. If
`ClassTemplate_teacher_slot_unique` is ever dropped, narrowed, or given a
predicate that lets two live templates share a weekday and time, the pairing
above becomes live and it will not announce itself.

**#196 (PR #208) made this legible, not impossible.** The premise it started
from — that `classifyApiError` had no branch for `40P01` and let this reach
a teacher as a bare 500 — did not hold: an unrelated, already-merged PR
(#174) had already given `40P01` a branch, grouped with `55P03`/`40001`/the
matching Prisma codes under "lost a contention race, not a bad request"
(`isTransientDbError`, checked after `isTerminalStatusViolation`'s `23514` but
before `P2002`'s 409 in `src/lib/api-errors.ts`). Reproduced directly rather than
trusted: two real `updateClass` writes racing over
`Class_teacher_slot_unique` with no synchronisation, throwaway database, hit
on attempt 5 of a 150-attempt budget.
The error was a `PrismaClientUnknownRequestError` with no `.code` property and
`code: "40P01"` embedded in its message — already the exact shape
`isTransientDbError` matches — and `classifyApiError` already answered 503,
"The system was busy … Please try again", at `warn`. Pinned at
`src/lib/api-errors.test.ts` ("maps the real Class_teacher_slot_unique
deadlock … to a 503, not a 500"), mutation-proven against the pre-existing
branch (commented out: that test and 6 others in the file flip to 500;
restored: 19/19 green).

What stays true regardless of which status code answers it: the cycle itself
is not fixable by reordering, only classifiable once it happens. A transaction
that moves a class vacates one slot key and claims another in the same
statement, so an ascending-by-`id` rule — or any other pre-lock ordering —
has no resource to sort, because the resource being contested does not exist
until the statement that claims it runs. Two of these crossing will deadlock
under any ordering discipline this document could add. The branch above
answers "what does the client see", not "does this still happen" — it still
does, at the rates measured above (32/100, 1/120).

## The advisory lock, which is not a row in the line above (#196)

`lockAnnouncementSlot` (`src/lib/db-locks.ts`) is the first and so far only
advisory lock in this project. It takes
`pg_advisory_xact_lock(196, hash32("<teacherId>|<classId ?? ''>|<message>"))`
— note the empty middle segment for an all-students send — the
two-int form, first argument a constant namespace — as the **first statement**
of the transaction in `POST /api/announcements`, so that two identical sends
cannot both read an empty duplicate check and both fan out one `Notification`
per recipient.

It is not a row of any table, so nothing about the canonical line applies to it
directly. What does apply:

**It is ordered ABOVE `Class`, and the plan that introduced it predicted it
would be ordered against nothing.** That prediction was wrong, and the reason is
already in this document: the transaction holding this lock goes on to insert
`Notification` rows carrying `relatedClassId` and an `Announcement` carrying
`classId`, and each of those takes `FOR KEY SHARE` on the parent `Class` row —
"the fourth path" above. So the real sequence is `advisory → Class`, and the
`createBulkNotifications` table above had to change its `POST /api/announcements`
row from "outside any transaction" to inside one for the same reason.

**It cannot be half of a cycle today, and the reason is a property of the call
graph, not of the lock.** A cycle needs some other transaction to hold a `Class`
row lock and then wait on this advisory lock. Nothing can: `lockAnnouncementSlot`
has exactly one call site in `src/` (`api/announcements/route.ts` — a `grep` also
returns `db-locks.test.ts`, none of whose holders takes a `Class` lock), and
that call site takes it before it touches `Class` at all. Two announcement sends
racing each other take the two locks in the same order, which is not a cycle
either.

**So the thing to check is a second call site, not a reordering.** Add one
inside a transaction that already holds a `Class` row lock — a notification
sweep, a cancellation path — and the inversion is immediate and will not
announce itself, exactly like `ClassTemplate_teacher_slot_unique` quietly
holding another pairing shut in "The slot key is a wait edge" above.

**Not bounded by `LOCK_TIMEOUT_SQL`, and the wait really is unbounded in wall
clock. This paragraph has now been wrong twice, in opposite directions, and the
second time is the instructive one.**

The transaction issues no `SET LOCAL lock_timeout`, so nothing bounds its
`FOR KEY SHARE` wait on `Class` — and it waits while holding the advisory lock,
queueing other identical sends of the same message behind it for the whole
duration.

The first version said that and concluded, without checking, that adding the
bound "would convert a slow send into a failed one". The second version tried to
correct it by claiming Prisma's 5000 ms interactive-transaction timeout already
bounds the wait, and pasted this as evidence:

```
threw after 13516 ms -> P2028 … The timeout for this transaction was 5000 ms
```

**Read that again: the wait ran 13.5 seconds under a "5000 ms" timeout.** The
evidence disproved the claim it was quoted to support. Re-measured
independently — blocker holding a row 12 s, waiter taking the advisory lock and
then blocking on it — the waiter returned after **12013 ms**, again with
`P2028`.

Prisma's transaction timeout does not cancel a statement already blocked inside
Postgres; it only refuses to begin the *next* one once the blocked statement
returns. **This project already had that written down** — `services/gdpr.ts`,
where the erasure's own lock bound was added: *"That timeout cannot roll back a
statement already blocked inside Postgres, only decline to begin another one."*

So: the wait is unbounded, the advisory lock is held for all of it, and the
`P2028` that eventually surfaces is a 503 via `TRANSIENT_PRISMA_CODES`
(`src/lib/api-errors.ts`) rather than a bound. Still left unchanged — a bound
here turns a slow send into a failed one, which is the original reasoning and
survives — but the cost is now stated honestly instead of being talked down to
"three seconds and an error string".

## The empty-`update` upsert quirk — read this before "tidying" one

Prisma 6.19.3 does **not** compile `tx.someTable.upsert({ where, update: {},
create: {...} })` to the atomic `INSERT ... ON CONFLICT DO UPDATE` when the
target row already exists. It compiles to three plain, non-locking `SELECT`s
instead — confirmed by direct query logging (`DEBUG=prisma:query` emits
nothing on this Prisma version; a standalone
`new PrismaClient({ log: [{ emit: 'event', level: 'query' }] })` was used).
Give the same call a single real column — `update: { isArchived: false }`, for
instance — and Prisma switches to the atomic path, which **does** take the row
lock.

This matters here because five call sites upsert `TeacherStudent` with
`update: {}` while racing a transaction that takes the opposite order on
purpose or by circumstance:

- `acceptInvitation` (`invitations.ts`) — `TeacherStudent` upsert, `update: {}`.
- `addToWaitlist`, `promoteNext`, `claimSpot` (`waitlist.ts`) and
  `POST /api/registrations` (`route.ts`) — same, `update: {}`.
- `unlinkTeacher`'s `TeacherBlock` upsert (`invitations.ts`) — also `update: {}`,
  a sixth upsert, on a different table.

None of those five `TeacherStudent` upserts, and neither the `TeacherStudent`
upsert nor the `TeacherBlock` upsert, currently take the row lock **when the
row already exists** — the only case in which a race against a delete or a
decline of that same row is possible. That is why `acceptInvitation`'s old
order never deadlocked against `unlinkTeacher` (which needs the link to
exist, or it returns `NOT_LINKED` and writes nothing), and why
`resolveInvitationOnLink` racing `unlinkTeacher` on `{TeacherBlock,
Invitation}` doesn't either (see "Known safe by accident" below) — **not**
because either order was safe.

Read that as scoped to the row-already-exists case, because the other case is
not safe: when the row does NOT exist yet, the same `update: {}` upsert
`INSERT`s, two concurrent `INSERT`s of one unique key make the second wait on
the first's uncommitted tuple, and that wait deadlocks like any other.
`acceptInvitation`'s old order against `POST /api/registrations` is exactly
that pairing and it was reproduced — see "Known conformance" below. An earlier
version of this section was read as covering both cases; it never did.

**If you are the future reader who turns one of these `update: {}` objects
into something with a real field in it** (an `updatedAt` stamp, a bookkeeping
flag, anything) — stop. That edit silently restores the atomic, lock-taking
path for that upsert, and if the write order at that call site doesn't already
match this document, you have just reintroduced a live `40P01`. Check this
file first.

`StudentPrivacy`'s upsert (`unlinkTeacher`, `SILENCED_PRIVACY`) is never
empty — six real boolean columns, every call — so it was never protected by
this quirk. The `{StudentPrivacy, TeacherStudent}` inversion #174 task 7 fixed
was a live, reproduced deadlock in real production code, not a theoretical one.

## Known conformance

- **`unlinkTeacher`** (`src/services/invitations.ts`) — `Class`/`WaitlistEntry`
  via `withdrawWaitingEntriesForTeacher` (must run first; its own docblock
  in `waitlist.ts` explains why — a deadlock question, not a preference),
  then `StudentPrivacy`, `TeacherStudent`, `Invitation`,
  `TeacherBlock`. `StudentPrivacy` used to come after `TeacherStudent`; fixed
  in #174 task 7 after a direct reproduction (see below).
- **`acceptInvitation`** (`src/services/invitations.ts`) — `TeacherStudent`
  then `Invitation`. Was the other way round until #174 task 7, and **the old
  order deadlocks against a real production writer**:
  `POST /api/registrations` upserts `TeacherStudent` and then reaches
  `Invitation` through `resolveInvitationOnLink`, so on a pair with no link
  yet both transactions `INSERT` the same `(teacherId, studentId)` key —
  and Postgres makes the second inserter wait on the first's uncommitted
  tuple, a wait that deadlocks exactly like a row lock. Reproduced against
  the real function and the route's real statement order, three runs per
  order: old `accept: REJECTED 40P01` 3/3, new no deadlock 3/3.

  What the quirk section above still explains is the case where the link
  ALREADY exists: there the upsert takes no lock in either order, which is
  why the reorder was made on principle before anyone had a reproduction, and
  why `src/services/invitations-lock-order.test.ts` also pins the mechanism
  with a synthetic non-empty `update`. That file lived in
  `tests/integration/` until #174's four-specialist review moved it — it is a
  DB-invariant suite with no HTTP surface, and the `integration` project
  deliberately runs against dev.

  Two tests, not one, and the split is deliberate. The deadlock reproduction
  needs a handshake to widen a window one round trip wide; unforced it is a
  race, not a reproduction — with the reorder reverted and the handshake
  removed, 1 of 6 runs deadlocked. So the write ORDER is pinned separately
  and unconditionally by "takes
  TeacherStudent before Invitation, and accepts". An earlier version of this
  entry claimed no reproduction was possible at all; that was wrong, and
  wrong because it generalised from a counterparty that upserted
  `TeacherStudent` first — which is not where the registration route puts it.
- **`deleteStudentAccount`** (`src/services/gdpr.ts`) — `Class`, looped via
  `lockClassRow` over every class the student is `waiting` in (sorted
  ascending; see "Ordering WITHIN `Class`"), hoisted ahead of every row write
  by #174 task 5. Then `Registration`, `StudentPrivacy`, `TeacherStudent`,
  `WaitlistEntry`, `Invitation` (anonymized in place, not deleted). Was
  already `StudentPrivacy` before `TeacherStudent`; not the outlier on that
  pair.

  It is the outlier on `WaitlistEntry`, though, and in **three** ways, not the
  one this entry used to name: it writes `Registration`, `StudentPrivacy` AND
  `TeacherStudent` all before `WaitlistEntry`, where the canonical line puts
  `WaitlistEntry` before all three. The whole-branch review of #174 added the
  two that were missing here.

  What protects all three is the same thing, and it is partial. "`Class` is
  the real gate" above applies, but only to the classes this function actually
  locked — the ones the student was `waiting` in **as of its own read of that
  set**. Its `waitlistEntry.deleteMany` is keyed on `studentId` alone, with no
  class scope, so its `WaitlistEntry` write set is strictly larger than its
  `Class` lock set: an entry that appears after that read is written but was
  never gated. Both halves were reproduced directly against the real
  functions (#174 whole-branch review):

  - **Inside the gate — no cycle.** Student already `waiting` in the class:
    a real `unlinkTeacher` racing this erasure did not deadlock (it failed
    instead with the unrelated `P2025` filed at the bottom of this document),
    and a real `deleteTeacherAccount` racing it completed cleanly. Both of
    those counterparties take the canonical direction (`WaitlistEntry` before
    `StudentPrivacy`/`TeacherStudent`), so they are the disagreement, and the
    shared `Class` lock is what makes it harmless.
  - **Outside the gate — a live cycle.** With the `waiting` entry appearing
    only after this function read its waiting set, the same two counterparties
    both deadlocked: `40P01 deadlock detected`, raised at `unlinkTeacher`'s
    `studentPrivacy.upsert` and at `deleteTeacherAccount`'s
    `studentPrivacy.deleteMany` respectively.

  That residual window is the unscoped `waitlistEntry.deleteMany` already
  filed as a separate concern, not a new one, and nothing here changes it —
  recorded so the next reader does not re-derive "the `Class` gate covers it"
  and stop one step early, which is what the entry above used to invite. The
  `Registration` half stays as it was: round 1 review of #174 task 7 could not
  construct a live counterparty — the one candidate disagreement,
  `promoteNext`'s conditional stale-head drop above, needs the erased student
  to hold both an active `Registration` and a `waiting` `WaitlistEntry` for
  the same class at once, a state `POST /api/registrations`'s own
  waitlist-resolution step actively prevents in the normal booking flow — but
  "no counterparty found" is not the same claim as "safe," and none is made
  here. All three left open, not resolved: no code changed for any of them.
- **`deleteTeacherAccount`** (`src/services/gdpr.ts`) — `Class`, via a
  per-class compare-and-swap `class.updateMany` inside a loop over upcoming
  classes (not `lockClassRow`, but still a lock-taking `UPDATE`, and still
  first), the loop walking an `orderBy: { id: 'asc' }` read — see "Ordering
  WITHIN `Class`" for why that `orderBy` is a lock and not a presentation
  choice. Then, per class, `WaitlistEntry` and the `Registration` read that
  chooses who gets the cancellation notice — that read moved inside the lock
  in the whole-branch review of #174, having been an eager-load on the
  pre-lock `findMany` until then, which meant a student registering in the gap
  had their class cancelled and was never told. After the loop:
  `StudentPrivacy`, `TeacherStudent`, `Invitation` (deleted, not anonymized —
  the teacher is soft-deleted, not scrubbed like a student's identity is). Was
  already `StudentPrivacy` before `TeacherStudent`; not the outlier.
- **`completeClass`** (`src/services/class-lifecycle.ts`) — `Class` via
  `lockClassRow`, then `Registration`, `Payment`. `transitionClass`'s own
  docblock names this and `autoCancelClasses`
  as the two sites that read more state than a bare status under the
  decision, and take the lock instead of a plain CAS for that reason.
- **`autoCancelClasses`** (`src/services/class-transitions.ts`) — `Class` via
  `lockClassRow` (#174 task 6), then a `Registration` count read, then the
  CAS `class.updateMany`. Matches `transitionClass`'s docblock.
- **`addToWaitlist`** (`src/services/waitlist.ts`) — `Class`, then
  `TeacherStudent` (upsert), then `TeacherBlock`/`Invitation` via
  `resolveInvitationOnLink`, then `WaitlistEntry`. That call takes
  `TeacherBlock` BEFORE `Invitation` — the opposite of this document's
  canonical line, and of `unlinkTeacher`'s own order. Not conformant on that
  one sub-order; conformant on everything else. See "Known safe by accident"
  below for why the disagreement is not currently live, and why the
  canonical line still names `unlinkTeacher`'s direction over this one's.
- **`promoteNext`** (`src/services/waitlist.ts`) — `Class`, then
  conditionally `WaitlistEntry` (the stale-head-drop loop — only when the
  current queue head already holds an active registration, not the common
  case), then `Registration` (`activateRegistration`), `TeacherStudent`, then
  `WaitlistEntry` again (the promotion and the reorder).
  **`claimSpot`** (`src/services/waitlist.ts`) — `Class`, then `Registration`
  (`activateRegistration`), `TeacherStudent`, then `WaitlistEntry` TWICE (the
  promotion `update`, then `reorderWaitingEntries`) — never before
  `Registration`. An earlier version of this document claimed both functions
  wrote `WaitlistEntry` before `Registration` unconditionally; wrong for
  `claimSpot` and overstated for `promoteNext`, corrected in round 1 review.
  A later version called the promotion `update` `claimSpot`'s "only"
  `WaitlistEntry` write, which the reorder after it contradicts.
  Neither calls `resolveInvitationOnLink` (deliberately — see each
  function's own docblock), so neither touches `Invitation`/`TeacherBlock`.
- **`removeFromWaitlist`**, **`withdrawWaitingEntriesForTeacher`**
  (`src/services/waitlist.ts`) — `Class` then `WaitlistEntry` only.
- **`POST /api/registrations`** (`src/app/api/registrations/route.ts`) —
  `Class`, then `Registration`, `WaitlistEntry`, `TeacherStudent`, then
  `TeacherBlock`/`Invitation` via `resolveInvitationOnLink` — the same
  `TeacherBlock`-before-`Invitation` disagreement as `addToWaitlist`, not
  conformant on that sub-order for the same reason.

## Known safe by accident, not by order — not fixed here

**`resolveInvitationOnLink`** (`src/services/link-consent.ts`, called from
`addToWaitlist` and `POST /api/registrations`) takes `TeacherBlock` before
`Invitation` — the opposite of `unlinkTeacher`'s `Invitation` then
`TeacherBlock`. Directly tested (#174 task 7): a transaction shaped like
`resolveInvitationOnLink`'s order racing one shaped like `unlinkTeacher`'s did
**not** deadlock, because `unlinkTeacher`'s own `TeacherBlock` upsert is also
`update: {}` and hits the same non-locking path described above whenever a
block already exists. This is not a "shared prior `TeacherStudent` lock"
protecting it — an earlier working hypothesis, now shown wrong — it is the
same upsert quirk on a different table. Not fixed, per instruction: doing so
would widen this task past the two pairs it was scoped to. If a future edit to
either upsert's `update` payload makes it non-empty, this pair needs the same
treatment `{Invitation, TeacherStudent}` and `{StudentPrivacy, TeacherStudent}`
already got.

**Why the canonical line names `unlinkTeacher`'s direction, not
`resolveInvitationOnLink`'s.** By call site this looks like 2-against-1 —
`addToWaitlist` and `POST /api/registrations` both disagree with
`unlinkTeacher` — but both of those call the SAME function,
`resolveInvitationOnLink`; by function it is 1-against-1, not a majority
either way. `unlinkTeacher` is the one function in this codebase that
touches every table in the canonical line — `StudentPrivacy`,
`TeacherStudent`, `Invitation` AND `TeacherBlock` — and its order across the
first three of those was directly audited and fixed for lock safety in #174
task 7. `resolveInvitationOnLink`'s own order was not chosen with lock
safety in mind at all, as far as this document can tell from the comment at
its `teacherBlock.deleteMany` (`link-consent.ts` — an inline comment, not the
function's docblock, which an earlier version of this passage attributed it
to): "the block is the thing that actually stands between them — so clearing
it is what makes booking the student's route back" is a narrative choice
about
which state change makes sense first from the student's side, not a
decision that ever weighed deadlock risk. Anchoring the canonical line on
the function that WAS reasoned about for lock safety, rather than the one
that wasn't, is the basis for the choice — not a claim that
`unlinkTeacher`'s direction is inherently safer on its own merits.

## Known violation, not fixed here

`deleteTeacherAccount` takes `Class` before `ClassTemplate`; the generator
(`src/services/class-generator.ts`) and four template paths take them in the
opposite order, and that counterparty is a sweep that runs continuously.
Choosing a canonical order there touches the whole template family, so it is
filed as a decision rather than resolved from here. See issue #229.

**Inherited from an earlier draft of this document, not re-verified in #174
task 7.** This entry is unrelated to either pair task 7 fixed, and nothing in
that task's work re-derived it from the code. In particular, "three template
paths" was not re-counted at that time and should not have been trusted at
that precision without an independent check — the count and file list then
were as-inherited, not as-confirmed.

**Re-counted for the atomic-template-update branch (issue 180 §2.5).** The
`ClassTemplate → Class` side is `1 generator + 4 template paths = 5`:
`claimTemplateForGeneration` plus its refill, inside `generateClassInstances`
(`class-generator.ts`); `pauseOrResumeTemplate`; `archiveOrUnarchiveTemplate`;
`POST /api/class-templates` — all four counted before this branch — and, new
here, `updateClassTemplate` (`class-template-lifecycle.ts`) as a **fifth**:
now that its write and its instance sync are one transaction, it locks the
template row before any `Class` row the same way the other four do.
`deleteTeacherAccount` (`gdpr.ts`) remains the sole site on the inverse side,
and carries a flat `{ timeout: 10_000 }` **transaction** budget already argued
to be tight for the per-class cancel loop it walks — which is part of why
re-ordering it is not free. (Not a *lock* timeout, and not the tuned one: the
sized budget, `Math.min(5_000 + waitingCount * 2_000, 20_000)`, belongs to
`deleteStudentAccount`. An earlier version of this sentence conflated the two,
which matters because the tuned budget is the one that would absorb a
re-ordering and the flat one is not.) Still filed as a decision, not resolved
here. See issue #229.

## Related, but not a lock-order issue — found while fixing the above, not fixed

`unlinkTeacher` reads the `TeacherStudent` row's id with a plain `findUnique`
**before** opening its transaction, then deletes it by that id
(`tx.teacherStudent.delete({ where: { id: link.id } })`). If a concurrent
`deleteStudentAccount` or `deleteTeacherAccount` deletes and commits that same
row at any point between that read and `unlinkTeacher`'s own delete-by-id, the
id no longer exists and Prisma throws `P2025 record not found for a delete`.
That window has two distinct shapes, not one: the erasure can commit entirely
before `unlinkTeacher`'s transaction even opens — pure sequencing, no lock
contention involved at all — or `unlinkTeacher`'s transaction can already be
open and blocked on a lock the erasure holds (exactly what happens when
`unlinkTeacher` loses the `StudentPrivacy` race the rest of this document is
about), in which case the erasure finishes and commits while `unlinkTeacher`
waits, with the same result once it unblocks. Reordering `unlinkTeacher`
closes the second shape's likeliest path to that outcome (the deadlock that
used to fire first is gone) but does nothing about the first, which does not
depend on lock order, or even on `StudentPrivacy`, at all. `classifyApiError`
(`src/lib/api-errors.ts`) has no branch for `P2025`, so it falls through to
the generic 500. Reproduced directly, reliably, three times in a row (#174
task 7 report has the transcripts). The pre-transaction read itself predates
this task — byte-identical at commit `e99c165`, well before task 7 touched
this file. Left as a finding for a separate issue: the fix is either a
`deleteMany` (count-tolerant) in place of the single-row `delete`, or
re-verifying the link inside the transaction rather than trusting a
pre-transaction read.
