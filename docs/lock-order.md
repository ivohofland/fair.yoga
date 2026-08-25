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
the others, *when it touches `Class` at all*. Two different statements take
that lock and both count: `lockClassRow` (or `lockClassRowsOrdered`), and a
compare-and-swap `class.updateMany` (an `UPDATE` locks the rows it matches —
`transitionClass` (`class-lifecycle.ts`) takes its `Class` lock this way and
no other, so a version of this sentence that names only the first writes it
out of the rule it is subject to; `deleteTeacherAccount` used to be this
example, until #237 folded its per-class CAS behind its own
`lockClassRowsOrdered` pre-lock). Those are the two that take it
*deliberately*, which is not the same as being the only two statements that
take it: plain DML on `Class` locks the rows it matches as well, and
`archiveOrUnarchiveTemplate`'s `class.deleteMany` is the example. It is not a
third category today, and the reason is placement rather than kind — it runs
behind an ordered `lockClassRowsOrdered` pre-lock over a superset of the rows
it can match, so it acquires nothing its transaction is not already holding.
There were two of these until #194: the template edit's same-day
`class.updateMany` was the other, and it had the same placement and the same
answer. A bare
`class.updateMany` or `class.deleteMany` added OUTSIDE such a pre-lock joins
this rule as a full member and has to be ordered like one. `POST
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
of the SAME table, and `Class` is the one table where that matters: **four**
sites lock more than one `Class` row inside a single transaction, and two of
them taking the same pair in opposite sequences is an AB-BA cycle exactly like
any cross-table one.

**Five until #194**, which deleted the template edit's propagation and with it
the fifth site. Re-derived by `grep -rn 'lockClassRowsOrdered(' src/` — the
helper's definition plus four callers — rather than decremented, because this
document's own history is of counts that stayed plausible while their
membership moved.

**The rule: ascending by `id`, taken by `lockClassRowsOrdered`
(`src/lib/db-locks.ts`).** Every site that locks more than one `Class` row goes
through it, and it is the only production `SELECT … FOR UPDATE OF c` **on
`Class`** in `src/` — so the check is a grep, not a list:

    grep -rn 'FOR UPDATE OF' --include="*.ts" src/ \
      | grep -v '\.test\.ts' \
      | grep -vE ':[0-9]+: *(//|\*|/\*)'

**That claimed to return exactly one line, and Task 3 (#315, issue 298)
falsified it — measured, not merely noticed: it now returns five.** The point
was never the count of exactly one; it was that every multi-row `Class` lock
goes through this one helper, and that is still true. `src/lib/db-locks.ts`
(`lockClassRowsOrdered`) is the only line locking `Class`. The other four are
legitimate holders of a DIFFERENT row entirely, added by the template-family
extraction: `claimTemplateForGeneration` (`class-generator.ts`) and
`claimStudioTemplateForGeneration` (`studio-class-generator.ts`) each take
`FOR UPDATE OF ct`/`FOR UPDATE OF sct` on a single `ClassTemplate` /
`StudioClassTemplate` row, and `deleteTeacherAccount`'s bulk archive
(`gdpr.ts`) takes the ordered multi-row form of the same two locks — "The
child row is the lock node for the template families" below is the section
that names and explains all four. None of the five is `lockClassRowsOrdered`
locking a second `Class` row in a different form; a sixth line appearing here
in the future is what would actually be the regression this check exists to
catch, not a rising count by itself.

`lockClassRowsOrdered` owns the order, the `FOR UPDATE OF c` lock mode, the
shared 2s bound and the dedupe for `Class`; a new `Class` site inherits all
four by calling it.

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
`withdrawWaitingEntriesForTeacher` (`waitlist.ts`) does not share it: its write
set is keyed on the ids its own `lockClassRowsOrdered` call handed back, a
structural subset rather than a predicate re-evaluated when the write runs.
That is the contrast `lockClassRowsOrdered`'s docblock (`db-locks.ts`) points
back at this document for.

**The template EDIT has left this graph entirely (#194).** A paragraph stood
here describing its pre-lock, and it is worth keeping what it said because the
exposure was real: the predicate carried no `status`/`settingsLocked` narrowing
beyond `templateId`/`teacherId`/`date >` the current UTC calendar date, so it
briefly locked every future instance of the template — including ones already
`settingsLocked` by a registration, which its own writes could never touch —
and `SELECT … FOR UPDATE` holds until the transaction ends, so a booking on one
of those instances contended with a template edit for the rest of that
transaction rather than for the statement. #194 deleted `syncTemplateInstances`
outright. `updateClassTemplate` now writes one `ClassTemplate` row under one
`SET LOCAL lock_timeout` and takes no `Class` lock of any kind, so the exposure
is gone rather than narrowed, and its budget moved 15s → 10s with the four
statements it lost.

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
   checkable rather than remembered: **every multi-row `Class` lock is
   `lockClassRowsOrdered` (`db-locks.ts`)**, and — since Task 3c (#315) —
   it is no longer the only production `FOR UPDATE OF c`-shaped statement in
   `src/`; it is the only one whose locked table is `Class`. The single-id
   `FOR UPDATE`s no longer live at the `Class`-family call sites. Every one
   that used to be inline — three in `waitlist.ts` (`addToWaitlist`,
   `promoteNext`, `claimSpot`) and one in `POST /api/registrations` — now goes
   through `lockClassRow`'s own bounded body instead, the same helper
   `removeFromWaitlist` and `handleSpotFreed` already reached the lock through
   rather than inlining it.
   `grep -rn "FOR UPDATE" src/ --include='*.ts' | grep -v "\.test\.ts:" |
   grep -vE ":[0-9]+: *(\*|//)"` is the check, not a number kept here.
   **It returned four hits when this was last written, and returns twelve
   now** — re-measured for Task 3c (#315), not carried forward. Of the
   original four, two were never `Class` locks at all —
   `claimTemplateForGeneration` (`class-generator.ts`) and
   `claimStudioTemplateForGeneration` (`studio-class-generator.ts`) take
   `FOR UPDATE OF ct`/`FOR UPDATE OF sct` on a `ClassTemplate` /
   `StudioClassTemplate` row — so the claim above holds over them rather than
   being violated by them, and the other two are the `Class` helpers in
   `db-locks.ts`, which is the whole point. **Eight new lines**, all of the
   same non-`Class` kind and all added by the split "The child row is the
   lock node for the template families" below describes: six single-id plain
   `FOR UPDATE`s (`updateClassTemplate`, `pauseOrResumeTemplate`,
   `archiveOrUnarchiveTemplate` and their three studio twins) plus two
   ordered `FOR UPDATE OF` locks in `deleteTeacherAccount`'s bulk archive
   (`gdpr.ts`) — one per template family, the fourth and fifth entries the
   `FOR UPDATE OF` census one section up gained alongside the two claims.
   Twelve lines total, ten of them not a `Class` lock — the two original
   claims plus these eight — and two still are, unchanged:
   `lockClassRow`/`lockClassRowsOrdered` in `db-locks.ts`. A
   count that stays right while the membership changes is the one error
   nothing that counts can catch, and this document has already made that
   mistake once (`db-locks.ts`'s register named `deleteStudentAccount` as a
   `lockClassRow` caller long after it stopped being one, and the total never
   moved). The branch that closed this section produced a fresh instance of
   the same failure in its own planning, not just this file's history: an
   earlier draft of its spec moved a misfiled row between two groups and left
   the TOTAL unchanged at thirteen while the membership moved underneath it,
   and a later task then found a fourteenth location the count had missed
   outright — and the task after that one (#315) shipped its own plan
   asserting this exact census "still returns 4 and is still true" without
   re-deriving it against the six-plus-two new sites its own steps were about
   to add, which is the same mistake in the same document for a fifth time.
   The count was never the thing to trust; re-deriving the list
   was;
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
`lockClassRowsOrdered` (`db-locks.ts`) — `withdrawWaitingEntriesForTeacher`
and `archiveOrUnarchiveTemplate` take theirs as a pre-lock ahead of their
`updateMany`/`deleteMany` (issue 180), and both erasures reach the same helper
(#237). The template edit was a third until #194 deleted its propagation.
A per-row `lockClassRow` loop over a sorted read also works and is what `deleteStudentAccount` used before
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
is a wait edge" below — `updateClass` vs `updateClass`, 32 of 100 runs, and
the template sync vs `updateClass`, 1 of 120, the second of which measured a
function #194 has since deleted). The generator's own `createManyAndReturn` is
not what was reproduced here: measured against that same sync it came back
clean, 6 of 6, in the shipped configuration (see "The pairing that looks worst
is unreachable" below), and only deadlocked — 3 of 3 — once
`ClassTemplate_teacher_slot_unique` was dropped. For `Class` the candidate set
is no longer "statements that can lock an existing row" but **"statements that write `(teacherId, date,
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
migration history, **with no handshake at all** — these were the statements
production issued, raced as-is.

**#194 deleted one of the two participants**, and the results are kept rather
than trimmed: they are evidence about a state this database really was in, and
the mechanism they demonstrate — a slot key is a wait edge, and a
vacate-and-claim has no order to take — is unchanged. Read the first bullet as
history and the second as live. Nothing in `src/` calls `syncTemplateInstances`
now; nothing can, it does not exist.

- **`syncTemplateInstances` vs `updateClass`** — *the sync side no longer
  exists (#194); recorded as measured.* Crossing on one date (the sync
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

Both were new to #196, proven by mutation rather than argued: with
`Class_teacher_slot_unique` dropped and nothing else changed, the same races
ran clean — 120 of 120 for the sync vs `updateClass` (the pairing #194 has
since removed a side of), 60 of 60 for `updateClass` vs `updateClass`, which
is still live. The second figure is a smaller sample than
the 100-run original measurement above; the point of this mutation check is
the pattern disappearing entirely once the index is gone, not reproducing the
original run count, and 60/60 clean already establishes that as firmly as
100/100 would — and leaves behind exactly the duplicate slots #196 exists to
prevent. The trade was taken knowingly in that direction; it is
recorded here, not fixed. The cheap fix (retry on `40P01`) is a decision about
`withErrorHandler`, not about lock order, and a deferrable unique index would
give up the immediate `409` the create routes answer with.

**The pairing that looks worst is unreachable, and only because a
SECOND new index blocks it.** A `POST /api/class-templates` transaction
(`classTemplate.create`, then a four-week `createManyAndReturn`) against a
`syncTemplateInstances` transaction was the case where both sides hold several
`Class` slot keys across statements — the generator inserting in date order,
the sync updating in heap order, an inversion of exactly the kind this section
is about. **#194 deleted the sync side**, so the measurement below is history;
what it establishes is not. Every template-driven writer left is an INSERT in
date order (`generateClassInstances`, `POST /api/class-templates`,
`pauseOrResumeTemplate`'s resume), so the remaining pairings have neither an
inversion nor a second participant that rewrites an existing key — and the
structural argument two paragraphs down, which is what actually blocks them,
never mentioned the sync. Measured both orderings, three runs each, widened with a third
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

*(Transcript kept verbatim. Side B is `syncTemplateInstances`, deleted by #194
— the counts it returned describe a report shape that no longer exists either.
It is retained as the measurement that proved `ClassTemplate_teacher_slot_unique`
is load-bearing, which is a property of the index, not of the sync.)*

The reason is structural, not luck. Two template-driven writers can only
collide on `(teacherId, date, startTime)` if their templates agree on
`(teacherId, dayOfWeek, startTime)` — a template generates on one weekday at
one time, so same slot means same weekday and same time — and that is the key
`ScheduleRule_teacher_slot_excl` forbids now, where `ClassTemplate_teacher_slot_unique`
forbade it when this was measured: #298 replaced one with the other, and the
argument did not change, only which object carries it. The archived-rule hole
in that constraint does not open it: archiving deletes every future
`draft`/`open` instance (`scheduledWhere`, `gt: today`), and an archived rule
writes no `Class` row afterwards by any route — generation skips it, and
since #194 an edit writes no `Class` row for any template at all. (This
sentence used to reach the same conclusion through the sync's own `mutable`
filter dropping what the delete spared; the mechanism went, the conclusion
got shorter.)

So one of the six new indexes was what kept another of the six from being a
live deadlock — **and that sentence has since been tested, not just left
standing.** `ClassTemplate_teacher_slot_unique` WAS dropped, by #298, exactly
the antecedent an earlier version of this paragraph warned about. The
consequence it predicted did not follow: `ScheduleRule_teacher_slot_excl`
inherited the same forbidding role — a stronger one, in fact, RANGE rather
than exact-start — so no two live rules of either kind can share an
overlapping weekday-and-time window for one teacher today either. **Nothing
in the code says so, and nothing enforces it** — which is the same condition
as the rest of this document, now applying to the new object: if
`ScheduleRule_teacher_slot_excl` is ever dropped, narrowed, or given a
predicate that lets two live rules share an overlapping window, the exposure
this section describes reopens — for whichever pairing of template-driven
writers is still live at that point, not necessarily the sync-vs-generator
one below, which stays dead on its own terms regardless (#194 deleted the
sync side).

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
announce itself, exactly like `ScheduleRule_teacher_slot_excl` (formerly
`ClassTemplate_teacher_slot_unique`) quietly holding another pairing shut in
"The slot key is a wait edge" above.

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

## The RESTRICT trigger is a wait edge, and a route guard is what closes it (#103)

`ClassTemplate_teacherRoomId_fkey` and `Class_teacherRoomId_fkey` are both
`ON DELETE RESTRICT` (`20260403092044_init/migration.sql:339,345`). A
`DELETE FROM "TeacherRoom"` therefore locks the parent row and then runs the
triggers' `SELECT 1 FROM "ClassTemplate" WHERE "teacherRoomId" = $1 FOR KEY
SHARE` — a lock nothing in this document's site enumeration can see, because
no source line issues it.

The cycle:

| | holds | waits for |
|---|---|---|
| generator sweep | `ClassTemplate` `FOR UPDATE` (`claimTemplateForGeneration`) | `TeacherRoom` `FOR KEY SHARE`, from its `Class` insert's FK check |
| room delete | `TeacherRoom`, exclusively | `ClassTemplate` `FOR KEY SHARE`, from the RESTRICT trigger |

AB-BA, so `40P01`. It did not exist before #95, which is when the sweep first
held a template lock across its inserts.

**What closes it is a guard in each delete route, not a lock.** Both routes
count `ClassTemplate` rows and refuse with 409 before issuing the `DELETE`
(`countRoomDeleteBlockers`, `src/services/room-deletion.ts`), and the cycle
requires a template row to exist — that row is what gives the trigger something
to lock. With the guard in place the statement is never issued in the
deadlocking case.

**The `isRoomDeleteBlocked` catch beside each guard does NOT substitute for
it.** The catch runs after the `DELETE` has taken its locks; it converts the
outcome, it does not avoid the wait. Removing the pre-check as belt-and-braces
reopens this edge, and until PR review it did so **with every test in the
integration project green** — `if (false && ...)` in both routes left every one
of them passing (434 at the time, 437 once this section's own cases landed;
the whole suite is 1613), because the
catch answers a byte-identical 409 and no status assertion can tell the two
guards apart. Each integration suite now carries a case that can: it holds
`FOR UPDATE` on the template row the RESTRICT trigger needs `FOR KEY SHARE` on,
and fails when the DELETE waits on it instead of refusing outright. That case
is the only thing in the repo that observes this edge, so treat it as part of
the guard rather than as coverage.

**Why `Class_teacherRoomId_fkey` does NOT add a second unclosable cycle**, which
an earlier version of this section wrongly claimed. For the sweep to be
inserting a `Class` on `TeacherRoom` X it must be holding
`claimTemplateForGeneration`'s `FOR UPDATE` on a `ClassTemplate` whose
`teacherRoomId` IS X (`class-generator.ts:186` copies `template.teacherRoomId`
onto every row it inserts). That template row is committed, and the pre-check
counts **every** template with no `isActive`/`isArchived` filter
(`room-deletion.ts:97`), so it sees it, answers 409, and the `DELETE` is never
issued — the same mechanism that closes the template edge. The `Class` edge is
reachable only inside the check-to-`DELETE` window described next, not as an
independent cycle.

**Residual, and accepted:** a template created between the check and the
`DELETE`. The wait is bounded well below the sweep's `{ timeout: 10_000 }`
envelope (`class-generator.ts:408`): Postgres's `deadlock_timeout` breaks the
cycle at its 1 s default, which this repo does not override, and the sweep's
own `LOCK_TIMEOUT_SQL` is `SET LOCAL lock_timeout = '2s'` (`db-locks.ts:94`).
Both outcomes are legible — `40P01` is in `TRANSIENT_SQLSTATES`
(`api-errors.ts:174`) and answers 503 retryable, and the far likelier `P2003`
is answered 409 by the catch, which logs at `warn` because reaching it means
the pre-check did not stop the delete. A
`lock_timeout` on the delete was considered and rejected: it would add a
lock-taking node to the ordering `template-lock-order.test.ts` defends, for a
few seconds in a window that needs a concurrent template creation — the same
trade `room-archive.ts:146-147` refused.

## The cross-family slot guard reads, and does not lock (#296)

One teacher holds at most one live row per slot ACROSS the two class
families. Since #298 the two halves of that invariant are different KINDS of
mechanism, not just different counts of the same kind:

- **`Class`/`StudioClass`, unchanged.** Four triggers — this branch does not
  touch the entry layer: `class_cross_family_slot_insert_guard`,
  `class_cross_family_slot_update_guard`,
  `studio_class_cross_family_slot_insert_guard`,
  `studio_class_cross_family_slot_update_guard`.
- **`ClassTemplate`/`StudioClassTemplate`, now index-backed.**
  `ScheduleRule_teacher_slot_excl`, one `EXCLUDE USING gist` constraint on
  `ScheduleRule`, partial on `isArchived = false`. RANGE, not exact-start: it
  rejects any two live rules of either kind whose
  `[startTime, startTime+durationMinutes)` windows overlap for one teacher on
  one weekday, where the trigger it replaced required an identical start time.

Named rather than counted, on purpose — a bare count is exactly what rotted
here (this was eight triggers, two each on all four tables, until #298 folded
the template half into the constraint above). Both halves are re-derivable
rather than remembered: the trigger roster is

    grep -rn "cross_family_slot" prisma/migrations/

(a hit inside `20260825065109_schedule_rule_backfill` is the migration that
DROPS the four template triggers, not a live one — see the pg_depend note
below, right after this section's migration-comment history), and
the exclusion constraint is `\d+ "ScheduleRule"` or its own `ADD CONSTRAINT`.

The four SLOT partial unique indexes in `20260811202634` each enforced
within-family exclusivity for one table (that migration declared six; the
other two are the `Room` identity pair), and nothing spanned them — which is
why the cross-family invariant needed triggers at all, historically, on every
table it touched. Two of those four
(`ClassTemplate_teacher_slot_unique`, `StudioClassTemplate_teacher_slot_unique`)
are gone now too, folded into the same `ScheduleRule_teacher_slot_excl` that
replaced the template triggers — a teacher's within-family and cross-family
template exclusivity are one constraint now, not two mechanisms layered on
each other. `Class_teacher_slot_unique` and `StudioClass_teacher_slot_unique`
are untouched; the entry layer's within-family and cross-family checks are
still two separate mechanisms (index, then trigger), exactly as before.

That clarification lives here rather than beside the indexes it describes, and
the reason is worth one line: it was briefly added as a comment inside
`20260821120000_cross_family_slot_guard/migration.sql`, which is an APPLIED
migration. A comment-only edit still changes the file's SHA-256, and
`_prisma_migrations` stores that checksum — measured, `861bd46…` against
`3867657…`. `prisma migrate status` compares NAMES and passes regardless, so
nothing catches it until the next `prisma migrate dev` reports the migration as
modified and demands a reset. Applied migrations are immutable including their
comments; prose about a migration belongs in prose. The invariant spans two tables, so no
unique index can express it; a trigger is what is left.

**A second migration comment is stranded the same way, and this document
becomes its owner too.** `20260825065109_schedule_rule_backfill/migration.sql`,
block 4, drops the four TEMPLATE-half triggers this section describes above —
`class_template_cross_family_slot_insert_guard`,
`class_template_cross_family_slot_update_guard`,
`studio_class_template_cross_family_slot_insert_guard`,
`studio_class_template_cross_family_slot_update_guard` — ahead of dropping the
columns their `WHEN` clauses name, and its own comment there reads:

> Measured: 10 dependencies across the four triggers, on teacherId,
> dayOfWeek, startTime and isArchived.

That is a prose count and a member roster reaching into the previous
migration ("since the previous migration"), both of which CLAUDE.md's Comment
Discipline forbids, and the migration is applied — a comment-only edit
changes the checksum `prisma migrate status` never checks (NAMES only), so
nothing would catch the fix until the next `prisma migrate dev` demanded a
reset. The comment stays wrong where it sits. This document is the live copy,
re-derivable rather than remembered:

```sql
SELECT count(*) FROM pg_depend d
JOIN pg_trigger t ON t.oid = d.objid AND d.classid = 'pg_trigger'::regclass
JOIN pg_class c ON c.oid = d.refobjid
WHERE d.refclassid = 'pg_class'::regclass AND d.refobjsubid > 0
  AND c.relname IN ('ClassTemplate','StudioClassTemplate');
```

It returned 10 before this branch (the count the stranded comment records) and
returns 0 after — measured against both `ethical_yoga_test` and `ethical_yoga`
on 2026-08-25, once the migration above had run. A reader who finds the
migration comment first should believe this paragraph, not that one: the
triggers it counted dependencies for no longer exist, on either table.

Each surviving `BEFORE INSERT`/`BEFORE UPDATE` function — the
`Class`/`StudioClass` half only, now — runs a plain `SELECT … LIMIT 1` against
the SIBLING table and raises `YG001` if it finds a live row. **No source line
in `src/` issues that `SELECT`**, which is the
property the #103 section above is about — so the check that finds it is a grep
of `prisma/migrations/`, not of `src/`:

    grep -rn "cross_family_slot" prisma/migrations/

**It adds no node to the ordering above, and that is a claim about the locking
clause rather than about triggers in general.** The `SELECT` carries none — no
`FOR SHARE`, no `FOR KEY SHARE` — so under READ COMMITTED it takes nothing that
is held to commit and cannot be half of a cycle. Contrast the RESTRICT trigger
one section up, whose `SELECT 1 … FOR KEY SHARE` is a real wait edge and did
produce a `40P01`. The difference is one clause.

**The `UPDATE` triggers are narrowed by a `WHEN`, which is a lock-order fact
and not only a performance one.** They fire only when the row is live AND the
slot moved or the row became live. An unrelated update — `spotBroadcastAt`, the
completion totals, `settingsLocked` — pays for no sibling read at all, so the
overwhelming majority of writes to these two tables touch the sibling table
zero times.

### What it costs: a residual race, measured

An unlocked read cannot see an uncommitted sibling insert, so two transactions
writing opposite tables at one slot may both commit.

Measured against `ethical_yoga_test` on the real trigger functions: 200 runs,
each opening two interactive transactions at one identical
`(teacherId, date, startTime)` — one `Class.create`, one `StudioClass.create` —
each holding 40ms after its `INSERT` so both triggers' sibling `SELECT`s
necessarily run before either commits. **Both committed in 200 of 200 runs.** A
control with the two guards dropped also measured 200 of 200: under a forced
overlap the guard makes no measurable difference, which is exactly what an
unlocked `SELECT`'s inability to see an uncommitted row predicts.

**Read that number for what it is.** The harness FORCES the overlap, so
`200/200` is a rate conditional on two writes racing, not a rate of races. How
often two slot writes for one teacher actually overlap was never measured, and
nothing here should be read as if it were. What is established is narrower and
still worth stating: once two such writes overlap, the guard contributes
nothing.

### Why no advisory lock, and what would change that

Both forms were derived and rejected — see
`docs/superpowers/specs/2026-08-21-cross-family-slot-exclusivity-design.md`
§4.2.1 for the full argument. In this document's terms:

- **At the call sites.** Four of the claiming sites issue no transaction at all
  (`prisma.class.create`, `prisma.studioClass.create`,
  `prisma.studioClass.update`, and `updateClass`'s bare `db.class.updateMany`,
  whose first parameter is a full `PrismaClient`), and an `xact` advisory lock
  in autocommit is taken and released by its own implicit transaction before
  the caller's next statement runs. So this design means introducing an
  interactive transaction at four hot paths — one of which is already half of
  the 32-of-100 `40P01` in "The slot key is a wait edge" above. It would also
  add a second advisory namespace beside `lockAnnouncementSlot`'s, whose own
  section warns that **"the thing to check is a second call site"**; this would
  add roughly ten.
- **Inside the trigger functions.** Cheaper, and it works in autocommit because
  the statement's implicit transaction is exactly the right scope. Rejected on
  the ordering derivation rather than the lines: the lock would be taken by a
  line no `grep` over `src/` can find, which is this document's own #103
  lesson, and a `BEFORE UPDATE` trigger fires with the row lock ALREADY held —
  so it would order `Class → advisory` where a call-site design orders
  `advisory → Class`. The two cannot coexist.

**Neither is dormant work.** #298's recorded decision extracts `CalendarEntry`
and makes this invariant a composite foreign key, at which point the second
writer blocks on an uncommitted INDEX ENTRY — the `ShareLock` "The slot key is
a wait edge" describes — and gets `23505` rather than racing past an unlocked
read. That is why the residual is accepted rather than bridged: an index-backed
constraint is race-free by construction, which is why within-family exclusivity
has never needed a lock either.

**Reopen this section if #298 slips materially past #283 and #276**, which is
the sequencing recorded on that issue. The trigger-internal form is the one to
take.

### What keeps the realistic path away from the guard

Both generators pre-check the sibling table and decline the date as
`blocked_by_other_family` (`class-generator.ts`, `studio-class-generator.ts`),
and **ten endpoints across eight route files** answer 409:

| How it reaches the 409 | Endpoints |
|---|---|
| a `catch` beside their own within-family-conflict branch — `isUniqueConflictOn` for the three entry-level writes, `isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')` for the two template `POST`s since #298 replaced their slot index | `POST /api/classes`, `POST /api/studio-classes`, `PUT /api/studio-classes/[id]`, `POST /api/class-templates`, `POST /api/studio-class-templates` |
| a `cross_family_slot_conflict` reason their service returns, because they issue no write of their own | `PUT /api/classes/[id]`, `PUT /api/class-templates/[id]`, `PUT /api/studio-class-templates/[id]`, `PATCH /api/class-templates/[id]?state=unarchived`, `PATCH /api/studio-class-templates/[id]?state=unarchived` |

Five and five. An earlier version of this paragraph said "all eight routes …
five catch, three return", counting FILES on one side of the sentence and
ENDPOINTS on the other, and so undercounted the reason-based side by the two
`PATCH` unarchive arms this same issue added. It closed by saying "named rather
than counted", which is the right instinct and was defeated by naming an
incomplete set — so the table above is the naming.

**The grep does not agree with the table, and should not.**
`grep -rn "CROSS_FAMILY_" src/app/api/ | wc -l` returned 12 before #298 and
returns **11** now (re-measured 2026-08-25): ten endpoints, of which the two
template `POST`s still carry TWO branches each — that count did not move —
but **only one of the two is a trigger any more.** Before #298, both were
`YG001` from two different triggers reading two different sibling tables (the
template's own insert, and generation's), disambiguated by a `conflict.level`
flag on a shared failure object. Since #298 the template insert's own slot
conflict — either family, because `ScheduleRule_teacher_slot_excl` spans both
kinds — is `23P01` from that exclusion constraint, caught by
`isExclusionConflictOn` earlier in the same `catch` and never reaching the
`YG001` branch below it. Only generation's `Class`/`StudioClass` insert can
still raise a `YG001` there. With one of the two raisers gone, the flag that
told them apart has nothing left to disambiguate and is gone with it —
`src/app/api/class-templates/cross-family-conflict-level.test.ts` is the
record of that removal, and the reason its own mocked case survives: the
generator's race is still real and still untested anywhere else. The two
branches still answer `CROSS_FAMILY_*_TEMPLATE_SLOT` and `CROSS_FAMILY_*_SLOT`
respectively — chosen now by WHICH matcher catches the error, not by a flag
read off it.

So: 11 branches, 10 endpoints, 8 files, as of the measurement above. Three
numbers, none of them derivable from either of the others, which is why all
three are written down rather than assumed to have held.

That is the same division of labour `countRoomDeleteBlockers` has with the
RESTRICT trigger one section up: the guard is the backstop, the pre-check is
what means it almost never fires.

### How the pre-check must be tested, and the mutation that lied

Removing the pre-check makes the batch insert hit the trigger, which aborts the
statement — so the generator THROWS. There is no longer a `result` to read a
count from at all, which is a stronger failure than the count moving: every
assertion in the case fails, not just the one about the reason. (An earlier
draft of this paragraph said "`created` drops to 0 **and** the generator
throws"; those are mutually exclusive, and only the second happens.) The suite
asserts the reason regardless, which is the stricter assertion in the cases
where the generator does return.

**That is not what this section said first, and the way it was wrong is the
part worth keeping.** #296 originally shipped a `catch` around
`createManyAndReturn` that retried per date, and the mutation was recorded as
*masked*: the trigger fires, the fallback retries, the date is reclassified
`'raced'`, `result.created` does not move. Every word of that was observed —
in the **unit tests**, which call both generators with a bare `PrismaClient`,
where each statement is its own transaction and a retry after an abort is
perfectly legal.

Every PRODUCTION caller passes a transaction client (both sweeps, both POST
routes, both pause/resume services). Prisma takes no savepoint per statement,
so `RAISE EXCEPTION` leaves the transaction aborted and the first retried
`create` returns `25P02`, which `isCrossFamilySlotConflict` correctly declines
— costing the whole window, and turning the `YG001` those ten endpoints match
into a `25P02` they cannot, so a wordable 409 became a 500. The fallback was
deleted in review.

The lesson generalises past this issue: **a mutation is only evidence about the
configuration it ran in.** The guard reported honestly; the harness asked it
the wrong question, because the test client and the production client differ in
exactly the property under test. `generation-transaction.test.ts` now drives
both generators through a real `$transaction` for that reason.

## The child row is the lock node for the template families (#315)

Issue 298 moved the calendar identity both template families share —
`isActive`, `isArchived`, `archivedAt`, `withdrawnCount`, `classType`,
`dayOfWeek`, `startTime`, `durationMinutes` — off `ClassTemplate` and
`StudioClassTemplate` onto a new shared `ScheduleRule` row. That split a lock:
`claimTemplateForGeneration`'s `FOR UPDATE` (`class-generator.ts`) used to do
three jobs on ONE row — serialise against `archiveOrUnarchiveTemplate`'s CAS,
block a concurrent `Class` insert (its FK check takes `FOR KEY SHARE` on the
template row, #164), and hold the economics authoritative for generation
(#102) — and after the split the first of those needed the rule while the
other two still needed the child. Postgres row locks are per-table, so a
lock taken on only one of the two no longer serialises against a writer that
takes it on only the other.

**The decision, taken with the maintainer: the child stays the only lock
node.** Every writer of a rule's lifecycle or calendar columns takes the
child row's `FOR UPDATE` as its own first statement, before touching
`ScheduleRule` at all:

    SELECT "id" FROM "ClassTemplate" WHERE "id" = $1 FOR UPDATE;

and the claim continues to join the rule for its predicate but lock only the
child:

    SELECT ct."id" FROM "ClassTemplate" ct
      JOIN "ScheduleRule" sr ON sr."id" = ct."scheduleRuleId"
     WHERE ct."id" = $1
       AND sr."isActive" = true
       AND sr."isArchived" = false
     FOR UPDATE OF ct;

**Rejected: lock both rows.** That would add `ScheduleRule` as a second node
to an ordering this document has twice declined to extend for lesser reasons,
with a named AB-BA against `updateClassTemplate`, in a codebase already
carrying one open unfixed `ClassTemplate`-vs-`Class` ordering violation —
"Known violation, not fixed here" below (#229). **Rejected: narrowing the
extraction.** The cross-family slot constraint's `WHERE isArchived = false`
needs that column on the rule, so keeping a copy of the lifecycle flags on the
child would restore the two-sources-of-truth drift this extraction exists to
remove.

Nine call sites hold the child row `FOR UPDATE` today — ten statements, since
`deleteTeacherAccount`'s bulk archive takes one per family — all added or
corrected by Task 3c:

| Site | File | Shape |
|---|---|---|
| `claimTemplateForGeneration` | `class-generator.ts` | joined predicate, `FOR UPDATE OF ct` |
| `claimStudioTemplateForGeneration` | `studio-class-generator.ts` | joined predicate, `FOR UPDATE OF sct` |
| `updateClassTemplate` | `class-template-lifecycle.ts` | single-id, plain `FOR UPDATE` |
| `pauseOrResumeTemplate` | `class-template-lifecycle.ts` | single-id, plain `FOR UPDATE` |
| `archiveOrUnarchiveTemplate` | `class-template-lifecycle.ts` | single-id, plain `FOR UPDATE` |
| `updateStudioClassTemplate` | `studio-class-template-lifecycle.ts` | single-id, plain `FOR UPDATE` |
| `pauseOrResumeStudioTemplate` | `studio-class-template-lifecycle.ts` | single-id, plain `FOR UPDATE` |
| `archiveOrUnarchiveStudioTemplate` | `studio-class-template-lifecycle.ts` | single-id, plain `FOR UPDATE` |
| `deleteTeacherAccount` (bulk archive) | `gdpr.ts` | ordered, `FOR UPDATE OF ct` **and** `FOR UPDATE OF sct` |

**This is a convention enforced by a grep and a test, not by the database** —
the same standing every other convention in this document has, and the same
one `lockClassRowsOrdered` has for `Class`. The grep is the two censuses one
and two sections up, re-run together; a new writer of a rule's lifecycle or
calendar columns that skips the child lock is invisible to both until it is
added to the table above. The test is the load-bearing half: every row in the
table above is independently proven necessary in `class-generator.test.ts`,
`studio-class-generator.test.ts`, `class-template-lifecycle.test.ts`,
`studio-class-template-lifecycle.test.ts` and `gdpr.test.ts` — each site's
lock was removed in isolation and the specific case it protects was confirmed
to redden, then restored (Task 3c report, `.superpowers/sdd/`).

**The claim's own `FOR UPDATE OF ct` is not, by itself, sufficient — and this
was measured, not assumed.** `FOR UPDATE OF ct` locks only `ct`, deliberately
(the "reject locking both rows" decision above), so when the claim's own
`SELECT` has to WAIT for that lock — because one of the nine sites above
already holds it — Postgres evaluates the join's `sr."isActive"`/
`sr."isArchived"` predicate against the snapshot the statement took when it
STARTED, before the wait. `EvalPlanQual`, Postgres's re-check on unblock,
re-verifies the columns of the LOCKED row (`ct`) if that row changed; it does
not re-fetch `sr` on `ct`'s account, because `sr` was never part of the lock
set. Measured directly, isolated from Prisma — two throwaway tables shaped
like the real ones, one session holding the child row and updating (but not
committing) the parent's flag, a second session's joined `FOR UPDATE OF`
blocking on the first and unblocking on its commit: the second session's join
predicate read the PRE-commit flag, six of six runs, unchanged even when the
first session also issued a real `UPDATE` on the child row itself to force
`EvalPlanQual`. So `rows.length === 1` in the claim's raw statement is a fast
path, not the verdict, whenever the statement actually waited. What closes it:
`claimTemplateForGeneration`/`claimStudioTemplateForGeneration`'s own
`findUniqueOrThrow` immediately after is a SEPARATE statement, issued only
once the lock is actually held, and a separate statement takes its own fresh
READ COMMITTED snapshot regardless of what the statement before it waited on
— so eligibility is re-checked against THAT read, not trusted from the raw
statement's `WHERE`. See `claimTemplateForGeneration`'s own docblock
(`class-generator.ts`) for the same argument at the call site.

**`deleteTeacherAccount`'s bulk archive needed the same fix, and the need was
measured rather than assumed to be absent.** Before issue 298 its bulk
`updateMany` wrote `isActive`/`isArchived` on `ClassTemplate`/
`StudioClassTemplate` directly, and a bare `updateMany` locks the rows it
matches — the same "joins this rule as a full member" mechanism "`Class` is
the real gate" above describes — so it already serialised against a sweep's
claim for free. After the split that `updateMany` targets `ScheduleRule`
instead, and the free lock stopped covering the child, the same gap as the
six single-template writers above. Left `known-open` by Task 3; closed by
Task 3c after checking, rather than arguing, whether a sweep can plausibly be
mid-claim when an erasure opens: `ACTIVE_TEMPLATE_WHERE`
(`lib/template-selection.ts`), which the hourly sweep's own candidate
`findMany` selects with, carries no `teacher.deletedAt` filter at all — only
`scheduleRule.isActive`/`isArchived`. So a template belonging to a just-erased
teacher is exactly as visible to the next sweep tick as any other teacher's
until the erasure's own `ScheduleRule` write lands, which is the interleaving
this gap was open for. The fix takes the child locks ordered by id first,
mirroring `lockClassRowsOrdered`'s discipline, over EVERY `ClassTemplate` /
`StudioClassTemplate` row the erased teacher owns (joined through
`ScheduleRule`, since neither child table carries `teacherId` any more) —
two ordered statements, one per family, both before either `ScheduleRule`
`updateMany`. Pinned by `gdpr.test.ts`, "waits for a concurrent claim to
release the child row before archiving the teacher templates"
(describe block `deleteTeacherAccount serialises against a claim in progress
(#315)`), mutation-proven the same way
as the other nine sites.

Not a new node on the canonical `Class → WaitlistEntry → …` ordering above,
and not in tension with "Known violation, not fixed here" below — restoring
this lock returns `deleteTeacherAccount` to the SAME `Class`-before-
`ClassTemplate` direction that violation already documents as accepted, since
before issue 298 this same bulk write already implicitly took it. It does not
make #229 worse; it makes this function's post-298 behaviour match its
pre-298 shape again.

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
  through `lockClassRow` or `lockClassRowsOrdered`, but a bare CAS
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
  `autoCancelClasses` and unlike the four `lockClassRowsOrdered` sites counted
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
  not have. What one class at a time actually buys is the "**four** sites lock
  more than one `Class` row" count under **Ordering WITHIN `Class`** — above,
  not below — staying true, and a bound on how long the sweep holds locks
  against live traffic. (Five until #194 deleted the template edit's
  propagation; the count moved, this bullet's argument did not.)

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
