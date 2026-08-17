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

**The rule: ascending by `id`, taken by `lockClassRowsOrdered`
(`src/lib/db-locks.ts`).** Every site that locks more than one `Class` row goes
through it, and it is the only production `SELECT … FOR UPDATE OF c` in `src/`
— so the check is a grep, not a list:

    grep -rn 'FOR UPDATE OF' --include="*.ts" src/ \
      | grep -v '\.test\.ts' \
      | grep -vE ':[0-9]+: *(//|\*|/\*)'

**That returns exactly one line today** — `src/lib/db-locks.ts`, inside
`lockClassRowsOrdered`. A second line is a site that has left the convention,
and that is the whole enforcement. The helper owns the order, the
`FOR UPDATE OF c` lock mode, the shared 2s bound and the dedupe; a new site
inherits all four by calling it.

The third filter is not optional, and leaving it off is how this check shipped
broken. Without it the grep returns **11** lines across four files, ten of them
prose *about* the convention rather than uses of it — this codebase discusses
`FOR UPDATE OF c` far more often than it issues it, so a reader running the
unfiltered version concludes on first use that the convention is already
abandoned. Caught by #239's review, which is to say: after it shipped.

**Before #237 this section was a five-row table**, and it was corrected about
its own membership four times — the last of them by the round that filed the
issue, which added `deleteStudentAccount`'s statement to the table and not to
the derivation below it. The table is gone rather than corrected a fifth time.

**One exception survives, and it is about a predicate rather than an order.**
`archiveOrUnarchiveTemplate`'s (`class-template-lifecycle.ts`) call covers
`date > today`, so a same-day instance rescheduled into the future by
`updateClass` (`class-lifecycle.ts`) — a bare `db.class.updateMany` holding
neither the template lock nor any `Class` lock — between that call and the
`deleteMany` is deleted without ever having been held. The AB-BA cycle against
`deleteStudentAccount` can still form through that window. It is narrow (it
needs a concurrent reschedule *and* an erasure of a student waitlisted across
both classes, timed into the same gap), it is measured rather than theorised,
and it is no worse than the pre-#180 state, which had no ordering at all — but
it is not closed. Widening the call past `today` would lock history for no
gain, and #86/#112 require the delete's live predicate re-evaluation regardless.
`syncTemplateInstances` does not share it: its write set is
`id: { in: lockedIds }`, a structural subset of what its own call returned.

`syncTemplateInstances`'s predicate carries no `status`/`settingsLocked`
narrowing beyond `templateId`/`teacherId`/`date >` the current UTC calendar
date, so it briefly locks every future instance of the template — including
ones already `settingsLocked` by a registration, which its own writes will
never touch. That is the safe direction for lock ordering, but it means a
booking on one of those instances can contend with a template edit, where
before #180 it could not — **for the rest of the edit transaction, not merely
for the statement**. `SELECT … FOR UPDATE` holds until the transaction ends, so
in production the exposure is bounded by `updateClassTemplate`'s
`{ timeout: 15_000 }`, not by how long the `SELECT` itself takes.

See "The slot key is a wait edge" below before assuming `id` is the only thing
that orders two `Class` rows: since #196 a unique index on
`(teacherId, date, startTime)` makes plain INSERTs take part too, which is a
case a site enumeration is built not to find.

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
2. `'"Class"'` — the raw statements. **Do not carry a number here; grep it.**
   An earlier version of this check said "8 in total … the other 3 are
   multi-row"; re-derivation on 2026-08-16 found 9 and 4, because
   `deleteStudentAccount`'s ordered statement had been added to the table above
   without being added here. That is the fourth time this document was wrong
   about its own list, and #237 is the response. What holds now, and is
   checkable rather than remembered: **every multi-row lock is
   `lockClassRowsOrdered` (`db-locks.ts`), and it is the only production
   `FOR UPDATE OF c` in `src/`.** The single-id `FOR UPDATE`s remain plural and
   inline — three in `waitlist.ts` (`addToWaitlist`, `promoteNext`,
   `claimSpot`) and one in `POST /api/registrations` — plus `lockClassRow`'s
   own body, which is bounded and is what `removeFromWaitlist` and
   `handleSpotFreed` reach the lock through rather than inlining it. Those four
   inline ones carry no ordering obligation individually, which is why they
   were never the subject here; their unbounded wait is #104's subject. It was
   four in `waitlist.ts` until #237, when `withdrawWaitingEntriesForTeacher`
   adopted the helper — that took its statement off the inline list and its
   wait off #104's at the same time. Do not substitute another name into the
   vacated slot to keep the count at four: a count that stays right while the
   membership changes is the one error nothing that counts can catch, and this
   document has already made it once (`db-locks.ts`'s register named
   `deleteStudentAccount` as a `lockClassRow` caller long after it stopped
   being one, and the total never moved);
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
`FOR UPDATE`s cannot; a loop or a multi-row predicate can. The multi-row ones
are all handled by `lockClassRowsOrdered`, which is the whole of the
within-`Class` concern this section derives. That leaves the single-`id`
`FOR UPDATE`s out, individually — they carry no ordering obligation.
**It is not the right bound for `Class` as a whole any more.** Since #196 a
single-row write can be half of a slot-key deadlock without ever holding a
second `Class` row lock — see "The slot key is a wait edge" below, where
`updateClass` joins the candidate set on exactly that basis despite locking
only one row. Note `autoCancelClasses` is *not* one of the multi-row sites
covered by `lockClassRowsOrdered`: it opens a separate `db.$transaction` per
class, so it holds one row lock at a time.

**The fourth path, which none of those checks would find: an FK lock taken
from a CHILD table, by an `INSERT` that never mentions `Class` at all.**
Inserting a row that references a class — `Registration`, `WaitlistEntry`,
`Notification.relatedClassId`, `Announcement.classId` — makes Postgres take
`FOR KEY SHARE` on the parent `Class` row for the rest of that transaction.
That is not a weak advisory lock: measured here, an uncommitted
`notification.create` carrying `relatedClassId` made a third connection's
`SELECT … FOR UPDATE NOWAIT` on that class fail with `55P03`, and blocked a
`DELETE` of it. So it conflicts with `lockClassRow`, with `lockClassRowsOrdered`,
and with every site named in "Known conformance" below.

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
| `autoTransitionToInProgress` (`class-transitions.ts`) | one — `cls.id`, and one transaction per class |
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

**The lock order of a loop is the order of the read it walks — unless something
locks first.** `deleteTeacherAccount` used to be the pure case: no explicit lock
at all, its CAS `UPDATE` was the lock, and there was no line of code that "takes
the locks" to inspect. Its `findMany` had no `orderBy` until the whole-branch
review of #174, which meant its lock order was whatever the heap returned: for
freshly inserted rows, physical (insertion) order, which is uncorrelated with
id. Against `deleteStudentAccount`, which sorted, that is a live cycle and it
was reproduced — Postgres `40P01 deadlock detected`, either side the victim.

Since #237 an ordered `lockClassRowsOrdered` pre-lock runs ahead of that loop,
so the rule no longer describes this site: the pre-lock is the transaction's
first lock acquisition, and the read's `orderBy: { id: 'asc' }` is now
presentation only (it fixes the notification order). The rule still applies to
any future loop that CASes without pre-locking, which is why it is kept.
Pinned by `gdpr.test.ts`, "does not deadlock when a teacher erasure and a
student erasure overlap on two classes"; that test fails with `40P01` if the
pre-lock is removed. The same fix closes the inherited disagreement with
`withdrawWaitingEntriesForTeacher`, which has sorted since #166.

**JS and SQL had to agree while one site sorted in JavaScript, and that was
checked, not assumed.** Since #237 every ordered site takes its order from
`lockClassRowsOrdered`'s `ORDER BY c.id`, so nothing sorts in JS and the
question is closed by construction — `grep -n '\.sort(' src/services/gdpr.ts`
returns nothing. Kept because the verification is expensive to redo and a
future site that sorts an id array in JS reopens it: `[...].sort()` and
`ORDER BY id` producing different sequences would reintroduce the cycle with
every site looking individually correct. Verified
directly against this project's database: `Class.id` is `text` with the default
collation, the database is `en_US.utf8`, and over 4000 random uuids the
JS-sorted and SQL-sorted sequences were identical element for element. The
check is scoped to uuid-shaped ids (`[0-9a-f-]` only) — that is all `Class.id`
ever holds — and should be re-run rather than assumed if that ever stops being
true.

**Sorting the id array does NOT order a multi-row write.** This is the trap the
two then-unordered template sites sat in, and it is why neither was "fixed"
with a one-line sort. `class.deleteMany({ where: { id: { in: ids } } })` compiles to
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

That warning came due against this document's own test suite in #239. Both
ordering reproductions asserted a *premise* about the natural order of a
`Class`/`WaitlistEntry` join, forced with `enable_hashjoin = off` — which
removes a join ALGORITHM but not a join DIRECTION. The planner can still drive
that join from `Class`, and then the two callers agree and the cycle cannot be
built. Which side it picks is a cost knife-edge on `w."studentId"`, a column no
index leads with, and it is NON-MONOTONIC in table size: measured on
2026-08-16, background-row counts of 0, 2, 50 and 200 drive from `Class` while
10, 1 000 and 50 000 drive from `WaitlistEntry`. No amount of seeding makes a
cost-chosen plan safe. The fix is to leave the planner no choice —
`enable_mergejoin` and `enable_seqscan` off as well, which leaves an
index-driven nested loop whose order comes from index structure rather than
from a cost comparison. If you write another lock-order reproduction, force the
plan; do not hope for it.
`archiveOrUnarchiveTemplate` does not even pass ids — its `deleteMany` takes a
predicate, so it has no array to sort in the first place.

Ordering a multi-row write means locking the rows first, explicitly: an
`ORDER BY … FOR UPDATE` ahead of the write itself. In `src/` that is always
`lockClassRowsOrdered` (`db-locks.ts`) — `withdrawWaitingEntriesForTeacher`,
`syncTemplateInstances` and `archiveOrUnarchiveTemplate` take theirs as a
pre-lock ahead of their `updateMany`/`deleteMany` (issue 180), and both
erasures reach the same helper (#237). A per-row `lockClassRow` loop over a
sorted read also works and is what `deleteStudentAccount` used before
#216/#182; it costs 2N round trips, which is why it was replaced.

### The slot key is a wait edge, and the ascending-by-`id` rule cannot see it (#196)

`Class_teacher_slot_unique` — `(teacherId, date, startTime) WHERE status <>
'cancelled'` — is a lock in every sense that matters here. Two transactions
writing the same key make the second wait on the first's uncommitted index
entry, as a `ShareLock` on the first's transaction id, which the deadlock
detector reads exactly like a row lock. The upsert-quirk section below already
says this in one line about `TeacherStudent`. On `Class` it has two
consequences a site enumeration over `FOR UPDATE`/`UPDATE`/`DELETE` is shaped
to miss.

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
- **`deleteStudentAccount`** (`src/services/gdpr.ts`) — `Class`, via a single
  ordered `SELECT … FOR UPDATE OF c` joined through `WaitlistEntry`, covering
  every class the student holds an entry in of **any** status, ahead of every
  row write (#174 task 5 hoisted it; #216/#182's review made it one statement).
  Then `Registration`,
  `StudentPrivacy`, `TeacherStudent`, `WaitlistEntry`, `Invitation`
  (anonymized in place, not deleted). Was already `StudentPrivacy` before
  `TeacherStudent`; not the outlier on that pair.

  **Any status, not `waiting` only, and that is a fix rather than caution**
  (#216/#182 whole-branch review). The `deleteMany` below is keyed on
  `studentId` with no status scope, so a lock set scoped to `waiting` is
  strictly smaller than the write set it is meant to gate. The two used to
  coincide by accident: before #216 nothing closed a queue when a class
  *started*, so a student who never got in stayed `waiting` for ever.
  `closeQueueOnStart` flips exactly those rows to `expired`, which dropped
  their classes out of the lock set while the delete went on deleting them —
  and `POST /api/registrations` writes `expired` entries under the class row
  lock when a teacher walks a queued student in, so the window was live, not
  theoretical.

  It is deliberately not narrowed to "statuses another writer can still
  touch". The load-bearing writer is the walk-in resolver in
  `POST /api/registrations`, which matches `CLAIMABLE_WAITLIST_STATUSES`
  (`waiting` ∪ `expired`) and writes under this same class row lock;
  `removeFromWaitlist` also carries no class-status guard of its own. (An
  earlier version of this paragraph reached for `addToWaitlist` instead, which
  does revive an entry of any status on a rejoin — but only on an `open` class,
  and `expired` rows exist only on classes that have started and can never
  return to `open`. It could not have been the example.) Write set equals lock
  set is the form that does not rest on any such enumeration staying true.

  **One statement, not a loop, and that is a correctness property rather than a
  speed one.** `lockClassRow` is two round trips, so a loop cost 2N of them and
  the transaction's `timeout` had to grow with N to pay for it — while nothing
  in production deletes a `WaitlistEntry` except this very transaction, making
  an all-status count monotone for the life of the account. Past the ceiling the
  erasure failed and the retry re-read the same count and failed identically: an
  account that could never be erased. The single statement makes the lock cost
  O(1) ROUND TRIPS — not O(1) waiting, which an earlier version of this
  sentence implied by saying "O(1) statements" and letting the budget be sized
  by the reorder loop's `waiting` count. `lock_timeout` is armed per lock
  acquisition, so one statement over N contended rows can still spend N × 2s
  (measured 2026-08-16: two rows, releases at 1.5s and 3.0s, one waiter at 2s,
  succeeded after 2.67s). #240 removed the sizing term for that reason; the
  budget is a flat `{ timeout: 20_000 }`. The single statement also closes
  the read-then-lock window, since the lock is taken BY the statement that
  chooses the rows.

  Pinned by "waits for a class row another transaction holds even when the
  erased entry is closed" (`gdpr.test.ts`), which resolves the erasure to the
  holder's own release flag — a causal assertion rather than a wall-clock
  threshold — and reads `false` if the lock set narrows again.

  It is the outlier on `WaitlistEntry`, though, and in **three** ways, not the
  one this entry used to name: it writes `Registration`, `StudentPrivacy` AND
  `TeacherStudent` all before `WaitlistEntry`, where the canonical line puts
  `WaitlistEntry` before all three. The whole-branch review of #174 added the
  two that were missing here.

  What protects all three is the same thing, and it is partial — though
  narrower now than it was. "`Class` is the real gate" above applies, but only
  to the classes this function actually locked: the ones the student held an
  entry in **as of its own read of that set**. Its `waitlistEntry.deleteMany`
  is keyed on `studentId` alone, so the gap is now purely a TIME one — an entry
  created after that read is written but was never gated. It used to be a
  status one as well, which was the larger hole and is closed above. Both halves were reproduced directly against the real
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
- **`deleteTeacherAccount`** (`src/services/gdpr.ts`) — `Class`, via an ordered
  `lockClassRowsOrdered` pre-lock over every class in `CANCELLABLE_STATUSES`,
  taken before the cancel loop and first in the transaction (#237). The loop's
  per-class compare-and-swap `class.updateMany` re-takes rows that pre-lock
  already holds, so the read's `orderBy: { id: 'asc' }` is presentation only
  now (notification order) — see "Ordering WITHIN `Class`" for what it used to
  be and why it stopped. Then, per class, `WaitlistEntry` and the `Registration` read that
  chooses who gets the cancellation notice — that read moved inside the lock
  in the whole-branch review of #174, having been an eager-load on the
  pre-lock `findMany` until then, which meant a student registering in the gap
  had their class cancelled and was never told. After the loop:
  `StudentPrivacy`, `TeacherStudent`, `Invitation` (deleted, not anonymized —
  the teacher is soft-deleted, not scrubbed like a student's identity is). Was
  already `StudentPrivacy` before `TeacherStudent`; not the outlier.
- **`transitionClass`** (`src/services/class-lifecycle.ts`) — takes its
  `Class` lock a different way than every other site on this list: not
  `lockClassRow`, not an inline `SELECT ... FOR UPDATE`, but a bare CAS
  `class.updateMany` on the outer client, opened as an interactive
  transaction since #216/#182 (it was a single autocommit `UPDATE` before).
  It calls `setLockTimeout` as its first statement, so its CAS gets the same
  bounded 2s `55P03` every `lockClassRow` site gets rather than Prisma's 5s
  `P2028` — added in the same review, because an interactive transaction with
  no per-statement bound is a worse failure mode than the autocommit statement
  it replaced.
  When the CAS succeeds and the target is `in_progress`, it writes
  `WaitlistEntry` next, via `closeQueueOnStart` — `Class → WaitlistEntry`,
  conformant with the order above, and the whole write set is the two
  tables and nothing else: the refusal-diagnosis reads below the
  transaction decide nothing that gets persisted. The only production
  caller left since #216/#182 removed the sweep's is
  `POST /api/classes/[id]/transition`'s generic branch.
- **`completeClass`** (`src/services/class-lifecycle.ts`) — `Class` via
  `lockClassRow`, then `WaitlistEntry` (via `closeQueueOnStart`, #216/#182 —
  only on the inline `open → in_progress` bump this function does when a
  teacher completes an `open` class directly; the `else` branch, a class
  already `in_progress`, writes none because its queue closed on the way in),
  then `Registration`, `Payment`. `transitionClass`'s own
  docblock names this and `autoCancelClasses`
  as the two sites that read more state than a bare status under the
  decision, and take the lock instead of a plain CAS for that reason. Since
  #216/#182 this is also where `autoCompleteClasses`' timing decision lives:
  `autoCompleteClasses` itself takes no lock of its own — its optional
  `requireEndedBy` is compared against the fresh, locked row's recomputed end
  time inside this function, under the same `lockClassRow` that already
  guards the status re-read, rather than in a second lock the sweep would
  otherwise need to take.
- **`autoCancelClasses`** (`src/services/class-transitions.ts`) — `Class` via
  `lockClassRow` (#174 task 6), then a `Registration` count read, then the
  CAS `class.updateMany`. Matches `transitionClass`'s docblock.
- **`autoTransitionToInProgress`** (`src/services/class-transitions.ts`) —
  `Class` via `lockClassRow` (#216/#182), then a fresh re-read of `status`,
  `date` and `startTime` to recompute the class's start instant from the
  locked row rather than the pre-transaction snapshot, then the CAS
  `class.updateMany`, then `closeQueueOnStart` (`waitlist.ts`) — atomic with
  the CAS, inside the same lock. Same shape as `autoCancelClasses` immediately
  above: one row lock at a time, one transaction per class.
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
- **`reapClosedWaitlistEntries`** (`src/services/waitlist-retention.ts`) —
  `Class`, then `WaitlistEntry`, one class per `db.$transaction` via
  `lockClassRow`. **Deliberately a single-row-lock site**, like
  `autoCancelClasses` and unlike the five `lockClassRowsOrdered` sites counted
  under **Ordering WITHIN `Class`**.
  **But holding one row lock is not by itself why it is safe**, and that is the
  multiplicity bound this document retires at "Ordering WITHIN `Class`" above:
  since #196 a single-row write can be half of a slot-key deadlock while holding
  exactly one `Class` row lock, and `updateClass` is that case. Anyone citing
  this bullet as precedent needs the mechanism, not the count. The conclusion
  survives on three mechanical facts: this sweep never `INSERT`s or `UPDATE`s a
  `Class` row, so it takes no `Class_teacher_slot_unique` index-entry lock and
  joins no slot-key wait chain; deleting a CHILD row takes no FK lock on the
  parent (only an `INSERT`/`UPDATE` of one takes `FOR KEY SHARE`), so its
  `deleteMany` adds no `Class` edge past the `lockClassRow` it took on purpose;
  and no production writer holds a `WaitlistEntry` row lock while requesting a
  `Class` lock, so there is no reverse edge to close a cycle against.

  **Against `deleteStudentAccount` specifically, the `Class` row lock is what
  removes the cycle — not the batch size.** The write sets do overlap: that
  function's `waitlistEntry.deleteMany` is keyed on `studentId` with no
  class-status scope, so it deletes entries on terminal classes too, which is
  exactly what this sweep deletes. But `deleteStudentAccount` PRE-LOCKS every
  `Class` it will delete entries from, before its first write, joined on
  `w."studentId"` with no status predicate; and this sweep takes
  `lockClassRow(tx, classId)` before its own `deleteMany`. So every
  `WaitlistEntry` row in either write set sits beneath a `Class` row lock both
  transactions must acquire first, and the two can never contend on the same
  `WaitlistEntry` row at all — **regardless of how many classes the sweep
  batches**. An earlier version of this bullet credited one-class-at-a-time with
  removing the cycle; it does not, and a future site copying that reasoning
  without also pre-locking its parents would inherit a deadlock this sweep does
  not have. What one class at a time actually buys is the "**five** sites lock
  more than one `Class` row" count under **Ordering WITHIN `Class`** — above,
  not below — staying true, and a bound on how long the sweep holds locks
  against live traffic.

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
re-ordering it is not free. (Not a *lock* timeout. This distinction used to carry
weight for #229: `deleteStudentAccount` had a TUNED budget,
`Math.min(5_000 + waitingCount * 2_000, 20_000)`, which was argued to be the
one that could absorb a re-ordering where a flat one could not. #240 removed
the term, so both erasures now carry flat budgets — `20_000` here, `10_000`
there — and that half of the argument no longer applies. What remains is the
raw size difference, which is a weaker reason than the one it replaces.) Still filed as a decision, not resolved
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
