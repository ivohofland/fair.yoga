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

**The rule: ascending by `id`. Three of the five follow it; two do not, and the
disagreement is live** — see "The two that do not" below before assuming this
section describes a solved problem. An earlier version of this section said
"three sites" and "all three take it that way"; both were false, and an
enumeration asserted as complete is exactly what stops the next reader looking
for the ones it missed.

| Site | How it locks | Order it takes |
|---|---|---|
| `deleteStudentAccount` (`gdpr.ts`) | `lockClassRow` in a loop | ascending — `[...ids].sort()` in JS, before the loop |
| `withdrawWaitingEntriesForTeacher` (`waitlist.ts`) | one `SELECT … FOR UPDATE OF c` | ascending — `ORDER BY c.id` in SQL |
| `deleteTeacherAccount` (`gdpr.ts`) | the per-class cancel CAS `UPDATE`, one per iteration | ascending — `orderBy: { id: 'asc' }` on the read the loop walks |
| `syncTemplateInstances` (`template-sync.ts`) | `class.deleteMany` (wrong-day) then `class.updateMany` (same-day), each multi-row | **none** — statement order first, then heap order within each statement |
| `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`) | one multi-row `class.deleteMany` | **none** — heap order |

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
   so it carries no ordering obligation;
2. `'"Class"'` — the raw statements. All but one are single-id `FOR UPDATE`:
   four written inline, plus `lockClassRow`'s body (itself called from exactly
   four places, grep 3). The exception is `withdrawWaitingEntriesForTeacher`'s
   join;
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
above. Note `autoCancelClasses` is *not* one of them: it opens a separate
`db.$transaction` per class, so it holds one row lock at a time.

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
| `handleSpotFreed` broadcast (`waitlist.ts`) | one — `classId`, and outside any transaction |
| `sendPaymentReminder` (`payments.ts`) | one — the payment's registration's class |
| `sendPaymentReminders` (`payment-reminders.ts`) | one — per-payment, one transaction each |
| `POST /api/registrations` | one — the class being booked |
| `POST /api/announcements` | one — the announcement's class, outside any transaction |
| `POST /api/classes/[id]/transition` | one — the class being transitioned |

Five stands — but a future sweep that notifies across classes in one
transaction would be a sixth site, and none of the four checks above would
surface it.

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
`ORDER BY … FOR UPDATE` (what `withdrawWaitingEntriesForTeacher` does) or a
`lockClassRow` loop over a sorted read (what `deleteStudentAccount` does).

### The two that do not — live, unfixed, and partly branch-caused

`syncTemplateInstances` and `archiveOrUnarchiveTemplate` take their `Class` row
locks in heap order. Against the three ordered sites that is a real cycle, and
it was reproduced against the real functions:

```
syncTemplateInstances : ok {"synced":1,"regenerated":1,"kept":0}
deleteStudentAccount  : REJECTED 40P01,deadlock detected
```

The trigger is ordinary: a student waitlisted on two instances of one recurring
template deletes their account while the teacher edits or archives that
template.

**The `deleteTeacherAccount` pairing is inherited; the `deleteStudentAccount`
pairing is new in #174.** Proven by mutation rather than argued: with #174 task
5's `lockClassRow` loop removed — pre-branch behaviour, where the erasure took
no `Class` lock at all — the same race gives `syncTemplateInstances : ok` /
`deleteStudentAccount : ok`. Restore the loop and the `40P01` returns. The
branch took that trade knowingly in the other direction: without the loop the
erasure renumbers a queue with no class lock, which is silent corruption, where
this is a rare and retryable 500 on one side or the other.

**Recorded rather than resolved, deliberately.** Three reasons, in order of
weight:

1. The cheap fix does not work. See the paragraph above — sorting the ids at
   either site changes no lock order at all. Shipping it would leave the cycle
   live under a comment saying it was closed, which is the failure mode this
   whole document exists to prevent.
2. The working fix is an ordered pre-lock ahead of the writes, and it has to
   land at **both** sites or the pairing stays live through the other. Both are
   request paths: `syncTemplateInstances` runs under Prisma's 5s default and
   `archiveOrUnarchiveTemplate` under an explicit `{ timeout: 10_000 }`, and
   adding N × 2s `lockClassRow` waits to either needs the same timeout
   arithmetic `deleteStudentAccount` carries — get it wrong and a rare deadlock
   becomes a routine `P2028` on an everyday action (editing a recurring
   template), which is a worse failure more often.
3. The template family is already filed here as an open decision — see "Known
   violation, not fixed here" below, which parks `{Class, ClassTemplate}` for
   the same reason: choosing an order there touches the whole family.

So this is a decision to be taken with the template family, not from inside a
lock-discipline fix wave. Nothing here is claimed to be safe.

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
(`src/services/class-generator.ts`) and three template paths take them in the
opposite order, and that counterparty is a sweep that runs continuously.
Choosing a canonical order there touches the whole template family, so it is
filed as a decision rather than resolved from here.

**Inherited from an earlier draft of this document, not re-verified in #174
task 7.** This entry is unrelated to either pair task 7 fixed, and nothing in
that task's work re-derived it from the code. In particular, "three template
paths" was not re-counted here and should not be trusted at that precision
without an independent check — the count and file list above are
as-inherited, not as-confirmed.

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
