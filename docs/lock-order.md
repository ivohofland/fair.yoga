# Lock order

Nothing enforces this. It is a convention, and the only defence against a
deadlock is that every transaction taking two of these rows takes them in this
order:

    Student → Class → WaitlistEntry → Registration → StudentPrivacy → TeacherStudent → Payment → Invitation → TeacherBlock

`Student` binds the sites that lock it explicitly and any transaction that
updates or deletes a `Student` row — "The `Student` row is the erasure's gate"
below names the former and gives the rule for the latter. A child-row insert's
automatic `FOR KEY SHARE` on its `Student` parent conflicts with neither gate
mode, so it creates no ordering obligation; the erasure's closing `UPDATE`,
which it does conflict with, is covered in the same section.

## Why it is written down rather than enforced

Postgres breaks a genuine cycle by aborting one transaction with `40P01`, which
reaches the user as a 500 through `withErrorHandler`. No constraint, trigger or
type can prevent the cycle forming — only the order can.

## `Class` is the real gate; the rest is not

`Class` is not merely early in the list — every site below that touches more
than one of these tables also holds `Class`'s row lock before touching any of
the tables after it, *when it touches `Class` at all*. Two different
statements take that lock and both count: `lockClassRow` (or `lockClassRowsOrdered`), and a
compare-and-swap `class.updateMany` (an `UPDATE` locks the rows it matches).
No site in `src/` relies on the second alone any more — `transitionClass`
(`class-lifecycle.ts`) was the last, until #327 gave its CAS a second table and
`lockClassRow` with it, and `deleteTeacherAccount` before that, until #237
folded its per-class CAS behind its own `lockClassRowsOrdered` pre-lock. The
sentence still names both, because a CAS added tomorrow takes the lock whether
or not its author meant to. Those are the two that take it
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
to write. `deleteStudentAccount` under "Known conformance" is where the second
condition used to fail for `WaitlistEntry` — its `Class` lock set smaller than
its `WaitlistEntry` write set, with the cycle outside that set reproduced — and
that entry records what closed it (#183). Its `Registration` writes still reach
classes it never locked, so do not read this section as a blanket escape. The
first condition is why the
entries further down this list matter: several
sites reach `StudentPrivacy`, `TeacherStudent`, `Invitation` or `TeacherBlock`
for a (teacher, student) or (teacher, email) pair with **no** `Class` row in
scope at all (`unlinkTeacher` when the student is not waiting in any of that
teacher's classes; `acceptInvitation`; `deleteStudentAccount` erasing links to
teachers whose classes the student never joined a waitlist for;
`archiveStudent` and `reopenPayment`, #265). For that
suffix of the list — `StudentPrivacy → TeacherStudent → Payment → Invitation →
TeacherBlock` — the order is the *only* thing preventing a cycle, not a
side-effect of a shared lock elsewhere. Both of #174 task 7's fixes are in
that suffix.

## Ordering WITHIN `Class`

The list above orders the *tables*. It says nothing about the order of two rows
of the SAME table, and `Class` is the one table where that matters: **five**
sites lock more than one `Class` row inside a single transaction, and two of
them taking the same pair in opposite sequences is an AB-BA cycle exactly like
any cross-table one.

**Five until #194**, which deleted the template edit's propagation and with it
the fifth site; five again since #259, whose `switchToSharedRoom`
(`room-switch.ts`) locks every upcoming class on the private link. Re-derived
by `grep -rn 'lockClassRowsOrdered(' src --include='*.ts' | grep -v '\.test\.ts' | grep -vE ':[0-9]+: *(//|\*)'` — the
helper's definition plus five callers — rather than incremented, because this
document's own history is of counts that stayed plausible while their
membership moved. Since #464 a test holds the other half:
`src/lib/db-locks-verdict-census.test.ts` requires every production call site
(not the defining module, which it excludes) to carry a `VERDICT (#327)` comment
immediately above it, and every such comment to have a call under it. **It does
not watch this count.** A site that arrives or leaves together
with its verdict passes it, so the drift this paragraph is about is still the
command's job; what the test removes is a call and its verdict moving apart.

**The rule: ascending by `id`, taken by `lockClassRowsOrdered`
(`src/lib/db-locks.ts`).** Every site that locks more than one `Class` row goes
through it, and it is the only production `SELECT … FOR UPDATE OF c` **on
`Class`** in `src/` — so the check is a grep, not a list:

    grep -rn 'FOR UPDATE OF' --include="*.ts" src/ \
      | grep -v '\.test\.ts' \
      | grep -vE ':[0-9]+: *(//|\*|/\*)'

**That claimed to return exactly one line, and Task 3 (#315, issue 298)
falsified it — measured, not merely noticed: it returns six today.** The point
was never the count of exactly one; it was that every multi-row `Class` lock
goes through this one helper, and that is still true. `src/lib/db-locks.ts`
(`lockClassRowsOrdered`) is the only line locking `Class`. The other five lock
a DIFFERENT row entirely, in three groups. Two are #327's `FOR UPDATE OF e`
companions on the `CalendarEntry` side, one inside `lockClassRow` and one
inside `lockClassRowsOrdered` — same file, same convention, a second row per
class rather than a second class. One is `claimRuleForGeneration`
(`entry-generation.ts`), whose `FOR UPDATE OF tpl` takes a single
`ClassTemplate` / `StudioClassTemplate` row with the table name spliced from
the family descriptor: ONE line serving both families, where
`class-generator.ts` and `studio-class-generator.ts` each had one of their own
(`FOR UPDATE OF ct` / `FOR UPDATE OF sct`) until issue 284 merged them. The
last two are `deleteTeacherAccount`'s bulk archive (`gdpr.ts`), the ordered
multi-row form of that same lock, one per family. "The child row is the lock
node for the template families" below is the section that names and explains
the template-side three.

Re-run for issue 758 on 2026-10-06 it returns eight: the six above, and the
currency switch's ordered pre-lock (`switchTeacherCurrency`,
`currency-switch.ts`), the same two-line shape as `deleteTeacherAccount`'s —
`FOR UPDATE OF ct` then `FOR UPDATE OF sct` over every template of one
teacher. `db-locks.ts` is still the only file locking `Class`.

The regression this check exists to catch is a line locking `Class` or
`CalendarEntry` from outside `db-locks.ts`, not a rising count by itself —
which is why the ALIAS in that spliced statement is load-bearing. `c` is this
codebase's alias for `Class`, so a template lock written `FOR UPDATE OF c`
reads here exactly like a stray `Class` lock, and the spliced table name that
would tell them apart sits several lines up where a line-by-line filter cannot
see it. `claimRuleForGeneration` uses `tpl` for that reason, and its own
comment says so.

`lockClassRowsOrdered` owns the order, the `FOR UPDATE OF c` lock mode, the
shared 2s bound and the dedupe for `Class`; a new `Class` site inherits all
FIVE by calling it: the order, the lock mode, the timeout, the dedupe, and —
since #245 — the fragment screen that refuses a caller's own `ORDER BY`/
locking clause/`LIMIT`/`OFFSET`/`;` (`ILLEGAL_IN_FRAGMENT`, `db-locks.ts`).

## Ordering BETWEEN `Class` and its `CalendarEntry` (#327)

**`Class` first, then `CalendarEntry`. Always.** A class's calendar identity —
`classType`, `date`, `startTime`, `durationMinutes`, `cancelledAt` — lives on
its entry since #327, so a transaction that decides from one and writes the
other now touches two rows where it used to touch one. Two such transactions
taking the pair in opposite sequences is an AB-BA cycle exactly like any other.

Three things take both, and all three take them in this order:

- **`lockClassRow` (`src/lib/db-locks.ts`)** — two statements naming the two
  tables, `Class` then `CalendarEntry`. Not one joined statement: `FOR UPDATE
  OF e` on a join locks only `e`, and a statement that waited on the join's
  non-locked member has already evaluated its predicate against the pre-wait
  snapshot (`EvalPlanQual` re-fetches locked rows only). Measured 6/6 during
  stage A.
- **`lockClassRowsOrdered` with `entries: true`** — every `Class` row first,
  ascending by `c.id`; then their entries, ascending by `e.id`. Two of its
  callers pass the flag (the callers are re-derived under "Ordering WITHIN
  `Class`" above); each carries its own written verdict at the call site.
- **`class_sync_entry_completed`**, the trigger function that stamps
  `CalendarEntry.classCompletedAt`. Two triggers fire it — `AFTER UPDATE OF
  status ON "Class"` and, since
  `20260826140000_entry_guard_restorations`, `AFTER INSERT ON "Class"` — and
  both take the same order: the statement already holds the `Class` tuple it
  wrote when the function updates the entry, so it is `Class` then entry,
  inside the writing transaction. That is why terminality reaches the entry as
  a WRITE rather than as a cross-table read: a guard on `CalendarEntry` that
  consulted `Class.status` would acquire Entry then Class, against this order,
  and a measured `40P01` on the schedule-write hot path is what that produced.

  **The reverse direction is cheap and is still not free.** A guard on `Class`
  that consulted `CalendarEntry` would take Class then entry, which composes
  with everything above — so the objection to it is not the ordering, it is
  what the read costs. A guard's sibling read is an unlocked `SELECT`, and
  "One teacher, one slot" below prices that mechanism where it was measured:
  under the cross-family triggers, two transactions writing opposite sides of
  one slot both committed in 200 of 200 forced-overlap runs, because an
  unlocked read cannot see an uncommitted sibling. A guard is not a substitute
  for a constraint.

  That is why one terminality arm was never closed with a trigger: a cancelled
  class's `Class.status` is still not frozen at the database, and freezing it
  needs exactly that read. It is closed by a CONSTRAINT instead —
  `CalendarEntry_not_cancelled_and_completed`
  (`20260826200000_entry_marker_exclusivity`), a single-row `CHECK` that takes
  no lock and reads no second table, because the extraction put both markers on
  one row. The completing `UPDATE "Class"` still runs; the sync trigger's own
  write to the entry is what violates the CHECK and aborts the transaction, so
  the refusal lands `Class` then entry like every other writer here. The full
  argument sits beside `TERMINAL_CLASS_STATUSES` in
  `src/services/class-lifecycle.ts`; what belongs here is the mechanism it
  turns on.

Nothing takes an entry lock and then asks for a class lock, which is what makes
the order sufficient rather than merely conventional. The check is the same
grep the section above prescribes, minus the template tables:

    grep -rn 'FOR UPDATE' --include='*.ts' src/ \
      | grep -v '\.test\.ts:' \
      | grep -vE ':[0-9]+: *(\*|//)' \
      | grep -vE 'OF (ct|sct|tpl)`|"ClassTemplate"|"StudioClassTemplate"|family\.childTable'

**Expect TEN lines: the four in `src/lib/db-locks.ts` — `lockClassRow`'s two
and `lockClassRowsOrdered`'s two — plus six that are not `Class` or
`CalendarEntry` locks at all:**

- `src/services/room-archive.ts:251` and `src/services/room-switch.ts:88`, the
  archive's and the switch's step-1 pre-locks, both on `ClassTemplate` rows;
- `src/services/room-switch.ts:93` and `:138`, the switch's step-2 and step-3
  locks on the private and the shared `TeacherRoom` (#259);
- `src/services/roster-link.ts:123`, `lockTeacherStudentLink`'s lock on one
  `TeacherStudent` link row (#265);
- `src/lib/auth/handoff.ts:149`, `reserveHandoffComparisons`'s lock on one
  `HandoffAttemptBudget` row (#767), a standing exception: a single-row budget
  lock. The reservation's transaction holds only that row and waits on nothing
  else, so the erasures that delete the same row after their profile locks
  cannot form a cycle with it.

Four of the six are false positives this command cannot suppress: the
table name (`"ClassTemplate"` at `room-archive.ts:251` and `room-switch.ts:88`,
`"TeacherRoom"` at `room-switch.ts:138`, `"TeacherStudent"` at
`roster-link.ts:123`) sits on a line ABOVE its `FOR UPDATE`, and every
filter here matches line by line. The other two, `room-switch.ts:93` and
`handoff.ts:149`, carry their table name (`"TeacherRoom"`,
`"HandoffAttemptBudget"`) on their own line and pass only because this command
filters the template tables, not every table that is not `Class` or
`CalendarEntry`.
Both copies of this census share these lines, so both return ten; the
four blind-spot lines cannot be "fixed" by tightening the filter, only by
rewriting each statement onto one line, which nothing else wants. Any ELEVENTH
line is the real signal — a site that took a `Class` or `CalendarEntry` row
lock without going through either helper.

The last alternative, `family\.childTable`, is the one this command was missing
until issue 336. `archiveOrUnarchiveRule` and `pauseOrResumeRule`
(`rule-lifecycle.ts`) each lock the child template row for BOTH families from
one statement, splicing the table name in from the family descriptor, so the
literal table names never appear at those sites. Without the alternative both
spliced TEMPLATE locks are counted here as `Class` ones. Qualified —
`family.childTable`, not the bare token — for the reason `db-locks.ts` gives
beside its own copy: it matches that splice as written and nothing else, where
a bare alternative would also swallow a `FOR UPDATE` line that merely mentions
a same-named property somewhere else. What the splice itself can name is
bounded by its type rather than by this filter: `TemplateFamily.childTable` is
`Extract<Prisma.ModelName, 'ClassTemplate' | 'StudioClassTemplate'>`
(`src/services/rule-lifecycle.ts`), so no descriptor can splice `Class` or
`CalendarEntry` in here at all — pinned by an `@ts-expect-error` in
`src/services/rule-lifecycle.test.ts`. The two copies differ only in shell
quoting; their FILTERS must stay identical, and both times they have drifted it
was this one that was missing an alternative.

`tpl` in the FIRST alternative is the same problem one statement further on,
and it is why `claimRuleForGeneration` (`entry-generation.ts`) may not go back
to calling its child row `c`. Issue 284 merged the two claims into one spliced
statement whose table name sits several lines above its `FOR UPDATE OF`, out
of reach of every filter here; the alias is the only thing left on that line
to match on, and `c` is `Class`'s. `ct` and `sct` are the aliases the two
per-family claims used before the merge, still issued by `gdpr.ts`'s bulk
archive.

The third filter is not optional, and leaving it off is how this check shipped
broken. Drop it and the same command returns **99** lines across twenty-one files
where it returns ten with it — this codebase discusses `FOR UPDATE` far more
often than it issues it, so a reader running the unfiltered version concludes
on first use that the convention is already abandoned. Caught by #239's
review, which is to say: after it shipped. The two figures are the same command
run with and without that one filter; do not carry either forward without
re-running both.

**Before #237 this section was a five-row table**, and it was corrected about
its own membership four times — the last of them by the round that filed the
issue, which added `deleteStudentAccount`'s statement to the table and not to
the derivation below it. The table is gone rather than corrected a fifth time.

**One exception survives, and it is about a predicate rather than an order.**
`archiveOrUnarchiveTemplate`'s (`class-template-lifecycle.ts`) call covers
`date > today`, so a same-day instance rescheduled into the future by
`updateClass` (`class-lifecycle.ts`) — which takes the `Class` row lock via
`lockClassRow`, holds it only until its own commit, and never takes the
template lock — between that call and the `deleteMany` is deleted without
ever having been held. The AB-BA cycle against
`deleteStudentAccount` can still form through that window. It is narrow (it
needs a concurrent reschedule *and* an erasure timed into the same gap, of a
student in one of two shapes: waitlisted across both classes, or waitlisted on
the rescheduled class and named in the audience of an announcement scoped to
another class the same delete removes first — the second shape since #48, see
"`Announcement` rows: the audience scrub (#48)"), it is measured rather than theorised,
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
that orders these rows: a slot constraint makes plain INSERTs take part too,
which is a case a site enumeration is built not to find. Since #327 the
constraint is `CalendarEntry_teacher_slot_excl` and the statements that join
that wait chain are entry writes, not `Class` writes — so the rows it orders
are one hop from the ones this section is about.

## Ordering BETWEEN `StudioClass` and its `CalendarEntry` (#327)

**`CalendarEntry` first, then `StudioClass`. Always — and that is the OPPOSITE
of the section above.** Read that as a fact about the two families rather than
as an inconsistency to tidy: the direction is not free in either family, and
each is pinned by something that cannot move.

The class family is pinned by `lockClassRow`. Ten callers take a `Class` row
lock because `Class` is the entity they are operating on, and the entry lock
follows; re-deciding that would re-decide all ten.

The studio family is pinned by its CASCADES. Two of its three writers of the
pair delete the entry and let `ON DELETE CASCADE` take the child —
`archiveOrUnarchiveStudioTemplate`'s `calendarEntry.deleteMany` (the shared
one in `rule-lifecycle.ts`, reached with `STUDIO_FAMILY`) and
`DELETE /api/studio-classes/[id]`.
PostgreSQL locks the parent tuple, then the RI trigger deletes the child, so
both acquire entry then `StudioClass` with no statement to reorder. The third
is `PUT /api/studio-classes/[id]`, which writes both rows in one transaction
and is therefore the only one with a choice; it takes them in the cascades'
order.

The class family has the same cascade and resolves it the other way, which is
worth seeing side by side rather than as a special case:
`archiveOrUnarchiveTemplate`'s `calendarEntry.deleteMany` would acquire
entry then `Class` too, and it does not, because
`lockClassRowsOrdered(tx, { …, entries: true })` has already taken every
`Class` row and then every entry. The delete then acquires nothing new. That
pre-lock is what makes `Class`-first sufficient rather than merely usual, and
it is the reason the flag is opt-in with a written verdict per call site.

**No pre-lock exists for the studio pair, and none is needed.** With all three
writers of the pair agreeing, there is no second order for one to protect against.
`lockClassRowsOrdered` reads `FROM "Class"` and cannot serve this family
without becoming a different function; a studio equivalent would add wait edges
to defend an order nothing takes.

**The orders do not compose into a cycle.** The edges are
`Class → CalendarEntry`, `CalendarEntry → StudioClass`, and `Class →
StudioClass` from the currency switch (`switchTeacherCurrency`,
`currency-switch.ts`, #758), whose `studioClass.updateMany` locks the
`StudioClass` rows it relabels while the transaction holds this teacher's
`Class` rows from `lockClassRowsOrdered`. Before those it holds the `Teacher`
row and every template row of the teacher. A cycle needs something that holds
a `StudioClass` row and then waits on a `Class` row, an entry, a template or
the `Teacher` row, and nothing does:

- no `SELECT … FOR UPDATE` names `StudioClass` anywhere in `src/`;
- `PUT /api/studio-classes/[id]` acquires its entry and then its `StudioClass`
  row and takes nothing after them. The switch takes no entry lock, so the PUT
  never waits on the switch; the switch may wait on the PUT's `StudioClass`
  row, which is the one direction;
- `DELETE /api/studio-classes/[id]` is a single cascading statement, entry
  then `StudioClass`, with nothing after it;
- the studio archive holds its `StudioClassTemplate` row `FOR UPDATE` before
  its cascading delete, and the switch takes that row before any `Class` or
  `StudioClass` row, so an archive and a switch serialise on the template
  before either reaches a child;
- `deleteTeacherAccount` touches both families' children but writes no
  `StudioClass` row, and it serialises with the switch on the `Teacher` row,
  which both take first.

Re-derive the three censuses with:

    # (a) nothing takes an explicit StudioClass row lock — expect NO output
    grep -rn '"StudioClass"' --include='*.ts' src/ | grep -v '\.test\.ts:' \
      | grep -E 'FOR UPDATE|FOR NO KEY UPDATE'

    # (b) direct StudioClass writers — expect THREE: the PUT's `update`, the
    #     currency switch's `updateMany` (`currency-switch.ts`) and
    #     `studio-class-generator.ts`'s `createMany`. An insert takes no
    #     existing row's lock, so the PUT and the switch are the two that
    #     acquire one outside a cascade. Re-run for #758 on 2026-10-06: three.
    grep -rnE 'studioClass\.(update|updateMany|delete|deleteMany|createMany)' \
      --include='*.ts' src/ | grep -v '\.test\.ts:' | grep -vE ':[0-9]+: *(\*|//)'

    # (c) the cascade side — expect TWO `CalendarEntry` deleting statements:
    #     the studio DELETE route's `delete` (`studio-classes/[id]/route.ts`)
    #     and the one shared `deleteMany` in `rule-lifecycle.ts`'s
    #     `archiveOrUnarchiveRule`, which serves both archives — the studio one
    #     reached with `STUDIO_FAMILY`, and the class one, which is the one
    #     with a pre-lock in front of it. Three deleting paths, two
    #     statements. Re-run for #758 on 2026-10-06: two.
    grep -rnE 'calendarEntry\.(delete|deleteMany)\(' --include='*.ts' src/ \
      | grep -v '\.test\.ts:'

The filter on (b) drops prose: this codebase discusses these statements more
often than it issues them, the same reason the class section's own grep needs
its third filter.

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
   still cannot conflict on the row it inserts, but it can conflict on the
   slot, which since #327 is `CalendarEntry_teacher_slot_excl` and is written
   by entry inserts rather than `Class` inserts. That is why this check alone
   no longer bounds the candidate set, and neither does the multiplicity
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
   **It returned four hits when this check was first written, and returned
   fourteen when re-derived for issue 259.** Re-run for issue 767 on
   2026-10-07 it returns eighteen: the fourteen issue 259 reconciled, plus
   `roster-link.ts:123`, `currency-switch.ts:56` and `:62`, and
   `src/lib/auth/handoff.ts:149`.

   Of the original four, two were never `Class` locks at all — the
   two generators' template claims, then written per family as
   `FOR UPDATE OF ct` / `FOR UPDATE OF sct` on a `ClassTemplate` /
   `StudioClassTemplate` row — so the claim above holds over them rather than
   being violated by them, and the other two were the `Class` helpers in
   `db-locks.ts`, which is the whole point. Those two claim lines are now ONE:
   issue 284 merged both generators onto `claimRuleForGeneration`
   (`entry-generation.ts`), whose single `FOR UPDATE OF tpl` splices its table
   name from the family descriptor and serves either family.

   That accounts for three of the fourteen issue 259 reconciled: the two `db-locks.ts` `Class`
   helpers, plus the merged claim standing where two lines used to. The other
   eleven were added since, and are of four kinds. Five come from the split
   "The child row is the lock node for the template families" below describes:
   three single-id plain `FOR UPDATE`s on a child template row, all in
   `rule-lifecycle.ts` with the table name spliced rather than written
   literally — `archiveOrUnarchiveRule`, `pauseOrResumeRule` and `updateRule`,
   each serving BOTH of its verb's entry points (issue 332 merged the two
   archive lines into the first, issue 336 the two pause lines into the
   second, and `updateClassTemplate` and `updateStudioClassTemplate` both run
   on the third) — plus two ordered `FOR UPDATE OF` locks in
   `deleteTeacherAccount`'s bulk archive (`gdpr.ts`), one per template family,
   which the `FOR UPDATE OF` census one section up counts alongside the merged
   claim. Two more are #327's `FOR UPDATE OF e` companions inside
   `lockClassRow` and `lockClassRowsOrdered`, which now take two lines each.
   One is `room-archive.ts`'s cascade pre-lock, which holds every
   `ClassTemplate` row of the room being archived. The last three are
   `switchToSharedRoom`'s (`room-switch.ts`, issue 259): its step-1 pre-lock,
   the same shape as the archive's, and its step-2 and step-3 locks on the
   private and the shared `TeacherRoom`. None of those four belongs to a
   convention on this page, and they are the four non-`Class` lines the
   `Class`-scoped census returned when issue 259 reconciled it. Three plus five plus two plus one plus three is
   the fourteen the command returned then, and that sum is the only reconciliation
   this paragraph offers. Cut a different way: eight of those fourteen lock a
   `ClassTemplate` or `StudioClassTemplate` row — the merged claim, the three
   single-id lifecycle locks, the two ordered bulk-archive locks, and the
   archive's and the switch's pre-locks — two lock a `TeacherRoom` row, and
   the remaining four are in `db-locks.ts`, which is where every `Class` and
   `CalendarEntry` row lock still lives. Re-derived for issue 259, this
   paragraph's previous figure (twelve) had already drifted to eleven before
   the switch arrived: `updateClassTemplate`'s and
   `updateStudioClassTemplate`'s two locks had become `updateRule`'s one. A
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
   was.

   Re-run for issue 758 on 2026-10-06 it returns seventeen: the fourteen
   above; `roster-link.ts`'s `TeacherStudent` row lock
   (`lockTeacherStudentLink`, #265), which landed without a note here; and
   this issue's two, the currency switch's ordered `FOR UPDATE OF ct` and
   `FOR UPDATE OF sct` pre-locks (`switchTeacherCurrency`,
   `currency-switch.ts`). Ten of the seventeen now lock a template row, and
   `db-locks.ts` still holds every `Class` and `CalendarEntry` row lock;
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
is the word this passage exists to earn — a completeness claim here has been
short before, and a table of names cannot say so about itself. So the table is
re-derived rather than remembered, and it ships the command that re-derives it:
run this and it should return one line per row below, with no row unaccounted
for and no line unlisted.

    grep -rn 'createBulkNotifications(' src/ \
      | grep -v 'services/notifications.ts:' | grep -v '\.test\.'

Against each, the class its notifications carry:

| Call site | Classes per transaction |
|---|---|
| `deleteTeacherAccount` (`gdpr.ts`) | one — the loop's current class (the named exception above) |
| `autoCancelClasses` (`class-transitions.ts`) | one — `cls.id`, and one transaction per class |
| `completeClass` (`class-lifecycle.ts`) | one — `cls.id` |
| `activateRegistration` `spot_taken` (`waitlist.ts`) | one — `input.classId`, under the `ClassLock` its caller passes |
| `promoteNext` (`waitlist.ts`) | one — `classId` |
| `claimSpot` (`waitlist.ts`) | one — `classId` |
| `handleSpotFreed` broadcast (`waitlist.ts`) | one — `classId`, inside its own transaction under `lockClassRow` (#212) |
| `sendPaymentReminder` (`payments.ts`) | one — the payment's registration's class |
| `sendPaymentReminders` (`payment-reminders.ts`) | one — per-payment, one transaction each |
| `POST /api/registrations` | one — the class being booked |
| `completeWalkIn` (`walk-ins.ts`) | one — the class being walked into, under the `lockClassRow` `POST /api/registrations` already holds |
| `POST /api/announcements` | at most one — the class of a class-scoped send; an all-students or custom send names none (#196, #48) |
| `POST /api/classes/[id]/cancel` | one — the class being cancelled, under `lockClassRow` (#327; this is where the transition route's cancel branch went) |
| `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`) | **many** — every class the archive withdrew (#112) |

> **#212 moved the broadcast inside a transaction, and the order is unchanged.**
> It was one of **four** `createBulkNotifications` sites taking no `Class` row
> lock. The other three still take none: `sendPaymentReminder`
> (`payments.ts`) and `sendPaymentReminders` (`payment-reminders.ts`), both
> payment-scoped and reaching a class only through the `relatedClassId` on the
> notification they write; and `sendAnnouncement` (`services/announcements.ts`,
> called by `POST /api/announcements`), whose
> `lockAnnouncementSlot` is an **advisory** lock, not a `Class` row lock — as
> the #196/#215 section of this document says below. `handleSpotFreed`'s broadcast takes `lockClassRow`
> and then inserts
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

**That sweep arrived, and it is the `archiveOrUnarchiveTemplate` row above**
— named rather than numbered, because every insertion into that table moved the
number and none of them moved this sentence. #112 made
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

**A single-class transaction can take the order backwards through this path
too.** The class reminder's student claim (`processClassReminders`,
`class-reminders.ts`, #721) writes one registration and one notification for
one class — no second `Class` lock, so nothing in the table above concerns it.
But the inbox row it inserts carries `relatedClassId`, so were its
`Registration` CAS its first statement, the insert's `FOR KEY SHARE` on `Class`
would arrive *after* the `Registration` lock: `Registration → Class`, against
the line at the top. The erasures take the other order —
`deleteStudentAccount` and `deleteTeacherAccount` lock `Class` `FOR UPDATE`
and then update that class's `registered` rows — so the two could close a
cycle. The claim therefore opens with
`SELECT 1 FROM "Class" WHERE id = … FOR KEY SHARE`, so it is
`Class → Registration`, and the later insert's lock lands on a row it already
holds. The teacher claim needs nothing: its CAS is on `Class` itself.
Pinned by `class-reminders-lock-order.test.ts`, which holds the class
`FOR UPDATE` on a second connection and, while the claim waits, takes the
registration `FOR UPDATE NOWAIT`; without the opening statement that probe
fails with `55P03`. A child-row insert is a `Class` lock for ordering
purposes, wherever it sits in the transaction.

Three things about that table are easy to get wrong and are the reason it exists:

**The lock order of a loop is the order of the read it walks — unless something
locks first.** `deleteTeacherAccount` used to be the pure case: no explicit lock
at all, its CAS `UPDATE` was the lock, and there was no line of code that "takes
the locks" to inspect. Its `findMany` had no `orderBy` until the whole-branch
review of #174, which meant its lock order was whatever the heap returned: for
freshly inserted rows, physical (insertion) order, which is uncorrelated with
id. Against `deleteStudentAccount`, which sorted, that is a live cycle and it
was reproduced — Postgres `40P01 deadlock detected`, either side the victim.

Since #237 an ordered `lockClassRowsOrdered` pre-lock runs ahead of that
loop, so the rule no longer describes this site: the pre-lock is first
among `Class`/`CalendarEntry` locks (not first in the transaction — #229's
`ClassTemplate`/`StudioClassTemplate` locks run before it), and since #367
it is also first among any read of this teacher's classes INSIDE THE
TRANSACTION — the completion sweep above it (`db.class.findMany` over
`in_progress`) reads them too, but runs in a transaction of its own before
this one opens, so it is ordered against nothing here. The read the loop
walks is scoped to the pre-lock's own returned ids, not an
independently-timed `findMany`, so `orderBy: { id: 'asc' }` on that read is
presentation only (it fixes the notification order) for a stronger reason
than before: there is no longer a separate snapshot for it to agree or
disagree with. The rule still applies to any future loop that CASes
without pre-locking, which is why it is kept. Pinned by
`gdpr-lock-order.test.ts`, "does not deadlock when a teacher erasure and a
student erasure overlap on two classes"; that test fails with `40P01` if
the pre-lock is removed. The same fix closes the inherited disagreement
with `withdrawWaitingEntriesForTeacher`, which has sorted since #166.

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
`enable_mergejoin`, `enable_seqscan` AND `enable_bitmapscan` off as well, which
leaves a nested loop whose order comes from index structure rather than from a
cost comparison. If you write another lock-order reproduction, force the plan;
do not hope for it.
`archiveOrUnarchiveTemplate` does not even pass ids — its `deleteMany` takes a
predicate, so it has no array to sort in the first place.

All four, and the fourth is the one #470 came back for. Index-DRIVEN is not
index-ORDERED: a bitmap heap scan is fed by a bitmap index scan and still
returns physical heap order — the same warning this section opens with, two
paragraphs up — so the three settings above left one heap-ordered path open,
reachable rather than excluded. Postgres's scan paths over a plain table are
sequential, index, index-only, bitmap heap, and TID — and of those, sequential
and bitmap heap are the two that return physical order for the statements here.
Turn both off and what remains is index and index-only scans. **A TID scan is
the qualifier that belongs on that sentence** (`enable_tidscan` is `on` and is
not one of the four settings): it needs a `ctid` qual, which none of these
statements has, so it is unreachable to them rather than excluded by anything.
A statement that grew one would be back to heap order with every setting still
in force. Measured (including with every path carrying `disable_cost`) in
`docs/superpowers/specs/2026-09-06-scan-order-premise-pin-design.md`. Both
settings discourage rather than forbid, so neither can make a statement fail.
(The premise assertion #470 came from had flaked before, on 2026-08-27, in a
copy of the test that carried none of these settings — a different gap, closed
by adding them.)

**Forcing the plan buys BTREE order, and only where no GiST index is
eligible.** `pg_indexam_has_property(gist,'can_order')` is false: a GiST
`Index Scan` returns tree-traversal order, which no fixture can assign. The
schema has exactly two GiST indexes, `CalendarEntry_teacher_slot_excl` and
`ScheduleRule_teacher_slot_excl` (#296/#327's exclusion constraints), and both
are PARTIAL — on `cancelledAt IS NULL` and `isArchived = false`. A statement
reaches one only by carrying its predicate, so a probe written to mirror
production faithfully can put ITSELF on an unordered index by copying a qual
across. Copy the join and the locking clause; leave those two quals out, and
say in the comment that you did. This count and both members are owned here
rather than in the three test files that depend on them, because a migration
adding a third GiST index would falsify a comment its author never opens.
Re-derive the set, and the `can_order` property that makes it matter, with:

    SELECT t.relname AS "table", c.relname AS index,
           pg_get_expr(i.indpred, i.indrelid) AS partial_on
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_am am   ON am.oid = c.relam
     WHERE am.amname = 'gist'
     ORDER BY 1, 2;

    SELECT amname, pg_indexam_has_property(oid, 'can_order') AS can_order
      FROM pg_am WHERE amtype = 'i' ORDER BY amname;

A row in the first query with a NULL `partial_on` would be worse than a third
partial one: an unconditional GiST index is reachable by any statement touching
its table, with no qual to leave out.

**"A btree index scan returns key order" carries two conditions, and neither is
live in today's three files — which is exactly why they are written here rather
than discovered later.**

- **Equal keys fall back to physical order.** A btree scan returns *key* order;
  rows whose keys tie come back in heap TID order. Every eligible driving index
  in these reproductions leads with a key that distinguishes the two fixture
  rows, and the fixture assigns it — but a future fixture whose rows tie on the
  driving key gets heap order back *through* a btree `Index Scan`, with none of
  the settings above able to prevent it. Assign the leading key, not just some
  key — or keep the index out of reach. `Class_status_idx` (#224) is the live
  case: fixtures routinely share a status, so a probe predicate on
  `c.status` makes a tie-prone index eligible to drive, and under
  `FORCED_PLAN_SETTINGS` a selective-looking status list does drive from it.
  `gdpr-lock-order.test.ts`'s teacher probe omits its status list for that
  reason.
- **A parallel plan interleaves.** A `Gather` above a btree index scan returns
  neither key order nor heap order, and none of the four settings forbids one.
  `gdpr-lock-order.test.ts`'s two probes are immune **by construction**, and
  that is a second thing `FOR UPDATE OF c` earns its place with: a locking
  clause makes a query parallel-unsafe, so no parallel path is generated at
  any size. The other two files' probes carry no locking clause and are **not**
  structurally immune. Do not reach for the size threshold to excuse that —
  measured here, `CalendarEntry_teacherId_date_idx` is already 832 kB against a
  512 kB `min_parallel_index_scan_size`, so the threshold is behind us, not
  ahead. What keeps those two serial is cost: `parallel_setup_cost` is 1000
  against single-row estimates, so a `Gather` cannot pay for itself. That is a
  cost argument, which is the weak kind — if either probe ever drives off a
  large estimate, add a locking clause or `SET LOCAL
  max_parallel_workers_per_gather = 0` and make it structural.

  Re-derive both numbers:

      SHOW min_parallel_index_scan_size; SHOW parallel_setup_cost;
      SELECT relname, pg_size_pretty(pg_relation_size(oid))
        FROM pg_class WHERE relkind = 'i' ORDER BY pg_relation_size(oid) DESC LIMIT 5;

The consequence for `CalendarEntry` is worth stating plainly, because it bounds
what a probe can prove: production's own pre-lock in `deleteTeacherAccount`
DOES carry `cancelledAt IS NULL`, so the mutated form of that statement — the
one with `ORDER BY c.id` removed, which is what an ordering reproduction's
premise is a counterfactual about — can plan onto an index with no key order at
all. No probe on this schema establishes that counterfactual. Deleting the
`ORDER BY` and watching the test redden does.

Forcing the plan is a NARROWING, not a pin, and a reproduction that needs one
should say so in its own comments. Index order is not one order: it is whichever
key the chosen index leads with, so the fixture has to assign every key an
eligible plan could order by. Attach the statement's `EXPLAIN` to the
assertion's failure message; a bare
`expected [ …(2) ] to deeply equal [ …(2) ]` costs an archaeology session every
time.

**Where two callers must disagree about the same table, ask which indexes each
statement makes ELIGIBLE before concluding the shapes cannot be reconciled.**
Postgres builds an index path only where the index has usable clauses, useful
pathkeys, a useful predicate, or supports an index-only scan
(`build_index_paths`, `indxpath.c`). Two statements that join the same table on
*different* columns
therefore reach *different* indexes on it, and a fixture assigning those two
columns in opposite directions makes the two callers disagree by construction —
no cost comparison involved, and nothing for a planner to revisit.

Establish it by hiding the winner, not by reading the chosen plan: a chosen plan
tells you which path won, never whether the other was generated. Set
`indisvalid = false` on the winning index inside `BEGIN … ROLLBACK` and re-plan,
**with `enable_seqscan = off` in force**. Then a `Seq Scan` fallback means the
alternative was never generated; the alternative appearing instead means it was
there all along and merely lost.

**That setting is not optional, and without it the recipe's normal case is its
failure case.** On single-page test tables an undiscouraged sequential scan
costs about 1.02 and wins against almost anything, so a `Seq Scan` fallback
would be the answer whether or not an index path exists. With
`enable_seqscan = off` the fallback carries `disable_cost`, so any generated
index path must beat 1e10 to stay hidden — which none does. Measured on this
schema, hiding `Class_calendarEntryId_key` for the teacher pre-lock plus a
`c.id > …` predicate:

    seqscan allowed  ->  Seq Scan on "Class"  (cost=0.00..1.02)
    enable_seqscan=off -> Index Scan using "Class_pkey"  (cost=0.12..8.15)
                          Index Cond: (id > …)

Same statement, same hiding, opposite conclusions — and the second is the true
one, since `Class_pkey` plainly is generated for a statement with a `c.id`
clause.

Run the positive control too — the same statement with the clause that *should*
make the path eligible — or a broken instrument reads as a proof. Worked through
for the two `Class` pre-locks in
`docs/superpowers/specs/2026-09-06-scan-order-premise-pin-design.md` §1.1.

The whole recipe, runnable. Substitute your own statement and the index you saw
win; nothing commits:

    -- 1. THE QUESTION: is the absent index unreachable, or merely outbid?
    BEGIN;
    UPDATE pg_index SET indisvalid = false
     WHERE indexrelid = '"Class_calendarEntryId_key"'::regclass;   -- the winner
    SET LOCAL enable_hashjoin = off; SET LOCAL enable_mergejoin = off;
    SET LOCAL enable_seqscan = off;  SET LOCAL enable_bitmapscan = off;
    EXPLAIN SELECT c.id FROM "Class" c
      JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
     WHERE e."teacherId" = '00000000-0000-4000-8000-000000000001'
     FOR UPDATE OF c;
    ROLLBACK;
    -- Seq Scan at 1e10  -> the alternative was never generated.
    -- the alternative   -> it was there all along and merely lost.

    -- 2. THE POSITIVE CONTROL: add the clause that SHOULD make it eligible.
    --    Without this step a broken instrument reads as a proof.
    BEGIN;
    UPDATE pg_index SET indisvalid = false
     WHERE indexrelid = '"Class_calendarEntryId_key"'::regclass;
    SET LOCAL enable_hashjoin = off; SET LOCAL enable_mergejoin = off;
    SET LOCAL enable_seqscan = off;  SET LOCAL enable_bitmapscan = off;
    EXPLAIN SELECT c.id FROM "Class" c
      JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
     WHERE e."teacherId" = '00000000-0000-4000-8000-000000000001'
     ORDER BY c.id                                  -- supplies the pathkeys
     FOR UPDATE OF c;
    ROLLBACK;
    -- must reach Class_pkey, with no 1e10 term, or step 1 proved nothing.

    -- 3. CONFIRM NOTHING STUCK.
    SELECT c.relname, i.indisvalid FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'Class_calendarEntryId_key';   -- expect t

`enable_seqscan = off` in both steps is the part that is easy to drop and fatal
to drop — see the counterexample above. Left as a runnable block rather than a
committed assertion deliberately: a test here would assert on literal planner
output and pin the suite to one Postgres version's internals, while the
behaviour that matters is already covered by the lock-order tests.

It stays an argument about specific statements against a specific schema: a new
index, or one added clause, can put the path back. Re-measure when either
changes.

Ordering a multi-row write means locking the rows first, explicitly: an
`ORDER BY … FOR UPDATE` ahead of the write itself. In `src/` that is always
`lockClassRowsOrdered` (`db-locks.ts`) — `withdrawWaitingEntriesForTeacher`
and `archiveOrUnarchiveTemplate` take theirs as a pre-lock ahead of their
`updateMany`/`deleteMany` (issue 180), and both erasures reach the same helper
(#237). The template edit was a third until #194 deleted its propagation.
A per-row `lockClassRow` loop over a sorted read also works and is what `deleteStudentAccount` used before
#216/#182; it costs 2N round trips, which is why it was replaced.

### `Notification` rows: the retention sweep against erasure (#223)

Not a `Class` edge at all: two writers contending on `Notification` rows
directly. The daily retention sweep (`reapExpiredNotifications`) deletes
expired rows in batches, each batch its own `DELETE … WHERE id IN (…)`. GDPR
erasure writes `Notification` rows inside its transaction in two ways:
`deleteStudentAccount` and `deleteTeacherAccount` each `deleteMany` the
subject's own rows by `recipientType`/`recipientId`, and `deleteStudentAccount`
also `updateMany`s the TEACHER's `booking_confirmed` rows that name the
student, matched by `relatedClassId`, `type` and a body prefix rather than by
`recipientId`. Either write can lock rows a sweep batch also locks — expired
rows of an account being erased while the daily run is mid-sweep — in a
different order, so a `40P01` between the two is possible.

Each side handles it:

- **Erasure.** `DELETE /api/account` catches the failure itself and answers
  through its own `erasureFailure()`, which calls `isTransientDbError` and
  answers a retryable 503 (`ERASURE_BUSY`, or `PARTIAL_ERASURE_BUSY` when a
  dual-role account's student half already committed). It never reaches
  `withErrorHandler`/`classifyApiError`.
- **Sweep.** The failing retention period is logged at `warn` (the error is
  transient), marked `failed` in the run's summary, and the other period
  still runs; batches already committed stay deleted and the next daily run
  picks up the rest. The run then throws `NotificationRetentionFailedError`.
  Under the scheduler, `isolatedSweeps` rethrows it, which sets the
  `daily-cleanup` job's `lastError`, so `/api/health` reports the job
  unhealthy and its body reads `degraded` until the next successful daily
  run clears it. Through `POST /api/cron/daily-cleanup`, `settle` classifies
  it with `classifyApiError`: the error is not a raw `40P01` and carries no
  `cause`, so it classifies as permanent and the route answers 500 (pinned in
  that route's `route.test.ts`).

The sweep takes no `Class` lock: deleting a row that references `Class` (via
`relatedClassId`) takes no lock on the row it references, only on the row
itself.

### Every site that bounds a lock wait

`db-locks.ts`'s `lockClassRow` docblock defers this figure here, the same way
it defers the `FOR UPDATE OF` one, and for the same reason: a count belongs
where somebody owns it, and the comment owns only the code it sits on.

`LOCK_TIMEOUT_SQL` (`db-locks.ts`) is the single bound. It reaches a
transaction two ways — through `setLockTimeout`, or spliced straight into a
`$executeRawUnsafe` where the caller already holds a raw client. The check:

```
grep -rn 'setLockTimeout\|LOCK_TIMEOUT_SQL' src/ --include='*.ts' \
  | grep -v "\.test\.ts:" \
  | grep -vE ":[0-9]+: *(\*|//)" \
  | grep -vE ":[0-9]+:import "
```

The filters are not cosmetic. On 2026-09-16 (issue 183) the unfiltered needle
returned 100 lines across 26 files: 52 of them in `.test.ts` files, 26 more
comment prose outside the tests — five of those in `db-locks.ts` itself,
quoting the needle back at its own reader. That is the failure the
`FOR UPDATE` census one section up already records: a reader who runs the
unfiltered version concludes on first use that the convention is not worth
checking.

**On 2026-09-16 (issue 183) it returned 18.** Three of the 18 are the bound
itself and the helper that issues it, all three in `db-locks.ts`; two are
members of multi-line `import { … }` blocks that name `setLockTimeout`
without issuing it —
`gdpr.ts`'s and `class-template-lifecycle.ts`'s own `  setLockTimeout,`
lines — which the `import ` filter cannot drop, since it matches only a line
that itself starts with `import `; the remaining thirteen are transactions
arming it, spread over `db-locks.ts` (four helpers now: `lockClassRow`,
`lockClassRowsOrdered`, and #183's `lockStudentForErasure` and
`lockLiveStudent`), `rule-lifecycle.ts`, `studio-class-template-lifecycle.ts`,
`class-template-lifecycle.ts`, `entry-generation.ts`, `gdpr.ts` and
`room-archive.ts`. What the number is for is noticing a MOVE — a new
transaction that takes a contended row lock without arming the bound does not
appear here at all, so a count that has not moved is not on its own evidence
that nothing was missed. Re-derive the list, not the total.

Re-run for issue 259 it returns 19: `switchToSharedRoom`'s own transaction
arming it (`room-switch.ts`) is new, and every other line sits in one of the
files listed above.

Re-run for issue 265 on 2026-09-28 it returns 22 = the 19 above + 3 new
transactions arming it, each before its `TeacherStudent` row lock:
`reopenPayment` (`payments.ts`), and `archiveStudent`'s two
(`student-archive.ts` — its own transaction, and the re-read after a waive
miss). Pinned by `src/services/student-archive-lock-order.test.ts`'s
"archiving and reopening bound their wait on the link row" describe, which
holds the link row past the bound and expects `55P03` inside the hold.

Re-run for issue 46 on 2026-09-29 it returns 23 = the 22 above + 1:
`lockLiveTeacher` (`db-locks.ts`), the photo upload's gate on the `Teacher`
row — "The `Teacher` row is the photo upload's gate (#46)" below. Every other
line sits in one of the files listed above.

Re-run for issue 758 on 2026-10-06 it returns 22 = the 23 above + 2 − 3. The
two added lines are in `db-locks.ts`: `lockTeacherForNoKeyUpdate` and
`lockTeacherForShare`, the `Teacher` first lock — "The `Teacher` row is the
first lock (#758)" below. The three removed are `createClassTemplate`'s and
`createStudioClassTemplate`'s own `setLockTimeout` calls, and
`class-template-lifecycle.ts`'s `  setLockTimeout,` import line: both creates
now arm the bound through `lockTeacherForShare`, their first statement.
`deleteTeacherAccount` arms it through `lockTeacherForNoKeyUpdate`, and its
own `setLockTimeout` line was already counted; the two one-off create routes
and the currency switch arm it through the same helpers and add no line.
Every other line sits in one of the files listed above.

Re-run for issue 767 on 2026-10-07 it returns 23 = the 22 above + 1:
`reserveHandoffComparisons` (`src/lib/auth/handoff.ts`), the handoff-code
budget reservation, which arms it before its `HandoffAttemptBudget` row lock.
Pinned by `handoff.test.ts`'s "a claim held past the lock timeout fails as a
transient 503" test, which holds the row past the bound and expects `55P03`
inside the hold. Every other line sits in one of the files listed above.

### Template creation's transaction budget (#758)

`CREATE_TEMPLATE_TIMEOUT_MS` (`class-template-lifecycle.ts`) and
`CREATE_STUDIO_TEMPLATE_TIMEOUT_MS` (`studio-class-template-lifecycle.ts`)
are 12s: the statements in each create's transaction that can wait on a lock,
times the 2s `lock_timeout` each wait may run to, plus 2s of headroom. Under
READ COMMITTED a plain read waits on no lock, so only writes and explicit
locks are in the sum. On 2026-10-06 each transaction had five:
`lockTeacherForShare`, the `ScheduleRule` insert, the template insert, and
generation's two writes (`generateEntriesForRule`'s
`calendarEntry.createManyAndReturn` and the family's `createChildren`, a
`class.createMany` or `studioClass.createMany`). 5 × 2s + 2s = 12s. Before
#758 the `Teacher` lock was absent and the budget 10s.

Re-derive by reading each create's transaction and `generateEntriesForRule`
(`entry-generation.ts`) for statements that write or lock; a grep cannot tell
a write reached through a family descriptor from a read. A new one moves the
budget by the lock timeout.

### Currency save's transaction budget (#758)

`CURRENCY_SAVE_TIMEOUT_MS` (`teacher-profile.ts`) is 15s: the statements in
the currency save's transaction that can wait on a lock, times the 2s
`lock_timeout` each wait may run to (armed by `lockTeacherForNoKeyUpdate`),
plus 3s of headroom. As above, a plain read waits on no lock. Unlike the
template creates, a write is left out of the sum when every row it touches is
one the transaction already holds and it changes no key column, because it
then has nothing to wait for. On 2026-10-06 the transaction had six:

- `switchTeacherCurrency`'s `lockTeacherForNoKeyUpdate`, its
  `FOR UPDATE OF ct` and `FOR UPDATE OF sct` statements, and its
  `lockClassRowsOrdered`;
- its `studioClass.updateMany`, whose rows nothing locked first;
- the save's `teacher.updateMany` of the other fields, which writes the held
  row but, when it changes `pageSlug`, waits on another transaction's
  uncommitted claim of the same slug (the #197 race,
  `src/app/api/teachers/[id]/route-lock-order.test.ts`).

Left out: the switch's `class.updateMany`, over the rows `lockClassRowsOrdered`
returned (its `UPDATE OF currency` trigger reads only the row), and its
`teacher.update` of `currency`, a non-key column of the held row. 6 × 2s + 3s
= 15s.

Re-derive by reading `saveWithCurrency` (`teacher-profile.ts`) and
`switchTeacherCurrency` (`currency-switch.ts`) for statements that write or
lock, and checking each write's rows against the locks taken before it.

### The slot key is a wait edge, and the ascending-by-`id` rule cannot see it (#196)

A slot key is a lock in every sense that matters here. Two transactions
writing the same key make the second wait on the first's uncommitted index
entry, as a `ShareLock` on the first's transaction id, which the deadlock
detector reads exactly like a row lock. The upsert-quirk section below already
says as much about `TeacherStudent`'s roster-link write. It has two
consequences a site enumeration over `FOR UPDATE`/`UPDATE`/`DELETE` is shaped
to miss.

**The key moved twice, and the mechanism did not.** Everything measured in this
section was measured against `Class_teacher_slot_unique`, `(teacherId, date,
startTime) WHERE status <> 'cancelled'`, which #327 dropped along with the three
columns it keyed on. The slot now lives on `CalendarEntry_teacher_slot_excl`, an
`EXCLUDE USING gist` over the generated `span`, partial on `cancelledAt IS
NULL`. Read the transcripts below as evidence about a mechanism this database
still has, on a different object, and read every `Class` statement in them as
the `CalendarEntry` statement that carries the columns now.

**But an exclusion constraint does NOT wait the way a unique index does, and
this paragraph said it did.** Both make the second writer block on the first's
uncommitted entry. What differs is *when the waiter inserts its own entry*, and
that difference decides whether the wait can be symmetric:

- A **b-tree unique** check runs BEFORE the waiter's entry exists. The waiter
  holds nothing the first transaction could block on, so the wait is
  one-directional and no cycle is constructible.
- An **exclusion constraint** check runs AFTER the waiter's tuple is inserted
  (`CONTEXT: while checking exclusion constraint on tuple …`). Both sides hold
  a tuple the other's check will find, so two conflicting inserts can wait on
  each other. That is a cycle, and `deadlock_timeout` (1s) breaks it with
  `40P01` — before `LOCK_TIMEOUT_SQL`'s 2s could bound it.

Measured deterministically, three statements, on a throwaway database with
`btree_gist`, `uniq (t, s)` unique against `excl (t, span)` exclusion:

- `excl`: A inserts `[10,20)`; B inserts `[15,25)` and blocks; A inserts
  `[24,30)`, which overlaps B's pending tuple — **`deadlock detected`**,
  `CONTEXT: while checking exclusion constraint on tuple (0,2) in relation
  "excl"`. Reproduces every run; it is an ordering, not a race.
- `uniq`: the same shape run against equality — A inserts `(1,1)`; B inserts
  `(1,1)` and blocks; A inserts `(1,2)` — **both of A's inserts complete**, and
  `pg_stat_activity` shows B `active` / `wait_event_type = Lock`, still inside
  its own `INSERT` with no entry of its own. B succeeds once A rolls back.

The equality case cannot even be made symmetric: equality is transitive, so two
distinct keys cannot each conflict with the other. Overlap is not transitive,
which is what gives the exclusion constraint a cycle to have. This is why a
`40P01` on a plain concurrent create is new since #298/#327 rather than
inherited, and why issue 331 was first read as flake — this paragraph said the
mechanism was unchanged.

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
`ClassTemplate_teacher_slot_unique` was dropped. The candidate set is no longer
"statements that can lock an existing row" but **"statements that write the
slot"** — since #327 every `CalendarEntry` insert, and every update of `date`,
`startTime` or `durationMinutes`, or of `cancelledAt` across the null boundary.
`updateClass` (`class-lifecycle.ts`) joins on that basis: it accepts `date`,
`startTime` and `durationMinutes` from `updateClassSchema` and writes them to
the entry, and a single-row autocommit `UPDATE` turns out to be perfectly
capable of being half a cycle.

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
collide on a dated slot — `(teacherId, date, startTime)` when this was
measured, an overlapping `(teacherId, span)` since #327 — if their templates
agree on `(teacherId, dayOfWeek, startTime)`, because a template generates on
one weekday at one time, so same slot means same weekday and same time. That
is the key `ScheduleRule_teacher_slot_excl` forbids now, where
`ClassTemplate_teacher_slot_unique` forbade it when this was measured: #298 replaced one with the other, and the
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

**Since #232, every `deadlock` kind logs at `error`** — `TRANSIENT_KIND_LEVEL`
(`src/lib/api-errors.ts`) is the authority, and the reason is general to the
kind, not specific to this cycle. What follows from that here: the
`updateClass` × `updateClass` slot-key trade this section keeps recording
rather than fixing will log at `error` every time it fires. Which other
slot-key cycles are still live is argued where each is recorded in this
section, not restated here.

## The `Student` row is the erasure's gate (#183)

`deleteStudentAccount` (`src/services/gdpr.ts`) chooses its `Class` lock set
with one statement and deletes its subject's `WaitlistEntry` rows with a later
one, and under READ COMMITTED each statement reads its own snapshot. Before
this gate, an entry a waitlist join committed between the two was deleted
outside the lock set (its class renumbered unlocked too), and one still
uncommitted when the delete ran survived the erasure, roster link included.

Two halves, both in `src/lib/db-locks.ts`, each arming the shared 2s bound
itself:

| Site | Helper | Where | Mode | On an erased or absent profile |
|---|---|---|---|---|
| `deleteStudentAccount` (`gdpr.ts`) | `lockStudentForErasure` | first lock of its transaction, right after `setLockTimeout` | `FOR NO KEY UPDATE` | no check at the lock; the closing compare-and-swap aborts an erased one with the module-private `AlreadyErasedError`, and the function resolves `{ erased: false, reason: 'already-erased' }` (`DELETE /api/account` answers 200 `unchanged` when every half it attempted was already erased); an absent one fails before the transaction opens, at `findUniqueOrThrow` (`P2025`) |
| `addToWaitlist` (`waitlist.ts`) | `lockLiveStudent` | first statement of its transaction | `FOR SHARE` | refuses: `StudentErasedError`, surfaced as `WaitlistJoinError` `student_erased` (409 `STUDENT_ERASED` from `POST /api/waitlist`) |
| `POST /api/registrations` (`src/app/api/registrations/route.ts`) | `lockLiveStudent` | first lock of its transaction, on the student's booking, the teacher's roster add and a walk-in alike — preceded, on a walk-in's create branch, by the `Student` INSERT itself (`resolveWalkInStudent`, in the same transaction) | `FOR SHARE` | refuses: 409 `STUDENT_ERASED`, worded for the student or the teacher; on a booking or a roster add an absent one is answered 404 `Student not found` before the transaction opens, and a walk-in has no such 404, since its student is resolved, or created, inside the transaction |
| `acceptInvitation` (`src/services/invitations.ts`) | `lockLiveStudent` | first statement of its transaction, before its roster-link insert | `FOR SHARE` | refuses the raced case: 409 `STUDENT_ERASED` (`POST /api/invitations/[id]/respond`); a fully committed erasure is answered 404 `NOT_FOUND` instead, by the pre-transaction read — keyed by email, and `deleteStudentAccount` anonymizes `Invitation.email` unconditionally (#520) — before the gate is ever reached |
| `unlinkTeacher` (`src/services/invitations.ts`) | `lockLiveStudent` | first statement of its transaction, before its `Class` locks and its `StudentPrivacy` upsert | `FOR SHARE` | refuses the raced case: 409 `STUDENT_ERASED` (`DELETE /api/teacher-links/[teacherId]`); a fully committed erasure is answered 404 `NOT_FOUND` instead, by the pre-transaction `TeacherStudent` read, which the erasure has already deleted, before the gate is ever reached |
| `updateStudentPrivacy` (`src/services/student-privacy.ts`) | `lockLiveStudent` | first statement of its transaction | `FOR SHARE` | refuses the raced case: 409 `STUDENT_ERASED` (`PUT /api/students/[id]/privacy`); a fully committed erasure is answered 403 `TEACHER_NOT_LINKED` or 401 instead, by the route's `hasTeacherLink` check or by session validation — both plain, non-locking reads that run before the gate's transaction opens — before the gate is ever reached |

**`Student → Class` at every site.** Each takes the `Student` row before its first
`Class` row, so an erasure and a gated writer can meet only at the `Student`
row, and what each side sees after waiting there is decided by who arrived
first:

- **The erasure first.** The writer waits at `lockLiveStudent`. Once the
  erasure commits, the writer's read under the lock sees the committed
  `deletedAt`, and the writer refuses before it writes anything — no entry, no
  roster link. An erasure that outlasts the 2s bound leaves the writer with
  `55P03`, which `classifyApiError` answers as transient (the booking's case:
  `src/app/api/registrations/route-lock-order.test.ts`, "answers a booking
  that times out behind an erasure lock as busy, not as deleted").
- **The writer first.** The erasure waits at `lockStudentForErasure` until the
  writer commits. Its class pre-lock runs after that, in a snapshot that
  contains what the writer committed, so a class where the student now holds
  an entry (a join's) is locked, and its entries deleted and renumbered under
  the lock. The erasure's `upcoming` read then sees the booking, so for an
  open, uncancelled class `handleSpotFreed` runs, even outside the lock set. A
  teacher's walk-in into an `in_progress` class is kept, as the erasure keeps
  every in-progress registration. The erasure's wait is bounded by its own 2s
  `lock_timeout`: a writer that holds the gate longer fails the erasure with
  `55P03`, which `DELETE /api/account` answers with 503 `ERASURE_BUSY`, saying
  nothing was changed.
- **After the erasure committed**, a gated writer's request is refused without
  waiting. A self-booking made after that never reaches the gate: the erasure
  removed its session, so the route answers 401 — unless the account's live
  teacher profile kept the session (`deleteStudentAccount` deletes it only
  when none does), in which case the session survives but no longer resolves
  a student, and the route answers 403 `Student access required`. A teacher's
  roster add reaches the gate only through a roster link that outlived the
  erasure; without one, the route answers 403 `Student is not in your roster`
  first. In this route, only the teacher path reaches the gate's sequential
  refusal, through such a link.

For a join, the order is observable only on a REJOIN — a join into a class
where the subject already holds an entry of any status, `waiting` included (a
no-op rejoin still takes the class lock), so that class is in the erasure's
lock set. With the join taking the class first, it would hold that class while
waiting on the `Student` row, and the erasure's pre-lock would wait on that
class: `40P01`. Pinned by `src/services/gdpr-lock-order.test.ts`, describe "the
erasure takes the Student row before any Class row (#183)" — "refuses a rejoin
that waits behind it" for the first case and the order, "waits behind a join
that holds the gate" for the second — and by `src/services/waitlist.test.ts`
("addToWaitlist refuses an erased student (#183)") for the third.

- The booking's order is observable when the booked class is in the erasure's
  lock set, that is, when the student holds an entry there.
- That case is pinned by `src/app/api/registrations/route-lock-order.test.ts`,
  test "refuses a booking that waits behind the erasure, in a class the
  erasure locks".
- The reverse race is pinned by "makes an erasure that arrives mid-booking
  wait, then cancel the booking and pass the seat on".
- The teacher path's order is pinned by "refuses a teacher adding a student
  who waits behind the erasure, in a class the erasure locks".
- The teacher path is pinned by "refuses a teacher adding an erased student
  whose roster link survived" and "refuses a teacher adding the student after
  the erasure cancelled registrations".

### Why these modes

| held ↓ / requested → | `KEY SHARE` | `SHARE` | `NO KEY UPDATE` | `UPDATE` |
|---|---|---|---|---|
| `KEY SHARE` (a child-row insert's FK check) | – | – | – | conflict |
| `SHARE` (`lockLiveStudent`) | – | – | conflict | conflict |
| `NO KEY UPDATE` (`lockStudentForErasure`) | – | conflict | conflict | conflict |

Two requirements choose the pair:

- **The two halves must conflict with each other.** `SHARE` against
  `NO KEY UPDATE` does.
- **The erasure's half must not conflict with `FOR KEY SHARE`.** `promoteNext`
  holds a class and then inserts the promoted student's `Registration`, which
  takes `FOR KEY SHARE` on that student's row. An erasure holding `FOR UPDATE`
  on the student while waiting on that class would close a cycle;
  `FOR NO KEY UPDATE` lets the insert through.

Pinned by `src/lib/db-locks-lock-order.test.ts` ("the Student gate: lock
modes"), and end to end by `src/services/gdpr-lock-order.test.ts` ("lets a
promotion of the student finish while it waits, then passes the freed seat
on"), which fails with `40P01` when `lockStudentForErasure` takes `FOR UPDATE`.

### Why gating one writer at a time is safe

A writer that is not gated takes only the automatic `FOR KEY SHARE` of a
child-row insert on the `Student` row, and that conflicts with neither half —
so leaving a writer ungated adds no wait edge against the gate. That holds
under one rule:

**An `UPDATE` or `DELETE` of a `Student` row is itself a lock on the `Student`
node, and `Student → …` binds it exactly as it binds an explicit lock.** An
`UPDATE` takes `FOR NO KEY UPDATE` (`FOR UPDATE` if it changes a key column)
and a `DELETE` takes `FOR UPDATE`; each conflicts with both halves of the gate.
So outside the erasure, such a statement must come before any other row lock
in its transaction — in practice it runs as a statement of its own, which is
what every production `Student` update does today (the census below).

- A gated writer's own `FOR SHARE` on the row counts as such a lock.
- An update of the row inside a gated transaction is an upgrade.
- Two gated writers of one student each hold `FOR SHARE`, because the mode is
  compatible with itself, and if both upgrade they deadlock.
- Measured 2026-09-16: two sessions each took `FOR SHARE` on one `Student`
  row, then each updated it. One of them failed with `40P01` "while updating
  tuple … in relation "Student"" — which session Postgres aborts depends on
  timing:

    -- session A, then session B 0.3s later
    BEGIN;
    SELECT id FROM "Student" WHERE id = '<id>' FOR SHARE;
    -- after both hold it:
    UPDATE "Student" SET "tierSelectedAt" = "tierSelectedAt" WHERE id = '<id>';

A transaction that first took ANY row the erasure or a gated writer goes on to
request, and then wrote the student's row, would wait on the gate while holding
what the gate's holder is about to wait on. A `Class` row or a `FOR KEY SHARE`
on the student is the obvious case, not the only one: an `Invitation` row
carrying the student's address is another, since the erasure anonymises those
rows (`gdpr.ts`) and a gated writer's `resolveInvitationOnLink` updates them
(`link-consent.ts`), both while holding their half of the gate.

`POST /api/registrations` writes `Student.tierSelectedAt` after its transaction
commits because of this rule — the case that surfaced it. It used to write it
inside, after inserting the `Registration`, and that closed two cycles with the
erasure: on any class,
the booking held `FOR KEY SHARE` and waited for `FOR NO KEY UPDATE` while the
erasure's closing `UPDATE` waited on that `FOR KEY SHARE`; on a class in the
erasure's lock set, the booking held the `Class` row and waited on `Student`
while the erasure held `Student` and waited on the `Class` row
(`docs/superpowers/specs/2026-09-16-waitlist-erasure-gate-design.md`, §1,
*Correction*), while the booking was ungated. Since #625 the booking is gated,
so what keeps the write outside is the upgrade described above: an update
inside the transaction would upgrade the gate's `FOR SHARE`. Pinned over HTTP by
`tests/integration/registrations-api.test.ts` ("a first self-booking does not
wait on a share lock held on its student's row"): the pinning test's holder takes
`FOR SHARE`, the gate's own mode. The booking's gate shares it, and only an
update waits on it.

A `Student` update that waits on the gate is not refused when the erasure
commits. Under READ COMMITTED it re-checks its `WHERE` against the row version
the erasure committed, and applies there unless that `WHERE` requires
`deletedAt: null`. The erasure holds the row from its first lock, right after
its `setLockTimeout`, to its commit, so the window is the whole erasure. `PUT /api/students/[id]`, the
student's self-edit, writes names and contact details, so its `update` is
scoped to `deletedAt: null` and answers 404 when the scope misses. Pinned by
`tests/integration/students-api.test.ts` ("does not write onto a profile
erased while the edit waited on it (#183)"), which sees the edit's name on the
erased row and a 200 when the scope is removed. The `tierSelectedAt` marker
writes that `POST /api/registrations` and `POST /api/waitlist` make after
their transactions commit are scoped the same way. That marker carries no
personal data, so their scope is consistency rather than protection, and no
test pins it.

Who updates or deletes a `Student` row, through any receiver:

    git grep -n -E 'student[[:space:]]*\.[[:space:]]*(update|updateMany|upsert|delete|deleteMany)\(' -- src ':!*.test.ts'

then read each hit's enclosing transaction. On 2026-09-16 it returned six
lines. Five run on the bare client, each an autocommit statement in no
transaction at all; the sixth is the erasure's own closing
`student.updateMany`. No production code deletes a `Student`. The grep is
line-based, so a call split between `student` and `.update(` across two lines
would escape it.

It sees Prisma calls only. The two other ways a statement can update a
`Student` row were checked the same day and are empty in `src/`: raw SQL
(`git grep -n 'UPDATE "Student"' -- src`), and a delete of an `Account`,
whose foreign key from `Student` is `ON DELETE SET NULL`
(`git grep -n -E '\.account\.(delete|deleteMany)\(' -- src ':!*.test.ts'`).

The spellings are deliberate. `git grep -E` on macOS supports neither `\b`
nor `\s`: a `\b` matches nothing, even with the test files let back in, and
`\s` is read as a literal `s`, so `student\s*\.` misses `student .update(` and
matches `students.update(` as well as `student.update(`. `[[:space:]]` and `\(` behave the same in
`git grep -E` and `grep -E`.

### What still escalates

The erasure's closing `student.updateMany` changes `email`, and
`Student_email_key` is a plain unique index, so that `UPDATE` takes
`FOR UPDATE` — which does conflict with `FOR KEY SHARE`, and waits for every
holder. By then the erasure holds every class in its lock set, and a promotion
or claim needs the student's entry in the class it holds, so no promotion of
this student is in flight.

That wait is also what the erasure's `ErasureLockSetError` check relies on,
and why the check runs after this `UPDATE` rather than beside the delete. An
entry an ungated writer was still inserting when the delete ran is invisible
to every read before the `UPDATE`; the `UPDATE` waits for that insert's
transaction to end, so the read after it sees the entry. Pinned by
`src/services/gdpr-lock-order.test.ts` ("refuses to commit when an entry for
the student was still being written outside its lock set").

An ungated writer can. Any ungated writer that inserts a `Student` child row,
taking `FOR KEY SHARE`, and then waits on a row the erasure has already
written closes a cycle with that closing `UPDATE` — three writers were
reasoned into this shape and all three are now gated, one reproduced before
its gate landed and two not:

- The booking route (`POST /api/registrations`), closed by #625. Its cycle
  WAS reproduced against the ungated route on 2026-09-16, by the test
  `src/app/api/registrations/route-lock-order.test.ts` ("refuses a booking
  whose roster link the erasure has already deleted"): the booking's
  roster-link insert failed with `40P01`, and the route answered 503.
- `acceptInvitation` (`src/services/invitations.ts`), which inserts the
  roster link and then updates an `Invitation` row the erasure anonymises.
  Closed by #626, unreproduced.
- `unlinkTeacher` (same file), whose `StudentPrivacy` upsert inserts, then
  deletes a `TeacherStudent` row the erasure has deleted. Closed by #626,
  unreproduced.

### Who is not gated yet

The inserters into tables with a foreign key to `Student`, other than the
five gated writers above:

- `promoteNext` and `claimSpot` (`src/services/waitlist.ts`) — ungated and
  not tracked, because they need no gate: each inserts only for a student
  holding a `waiting` entry in the class it has locked, which puts that class
  in the erasure's lock set, so the `Class` row already serialises the two.

Re-derived from the insert statements and the two shared helpers that issue
most of them (`linkTeacherStudent`, `activateRegistration`):

    git grep -n -E '\.(studentPrivacy|teacherStudent|registration|waitlistEntry)\.(create|createMany|createManyAndReturn|upsert)\(' -- src ':!*.test.ts'
    git grep -n -E '(linkTeacherStudent|activateRegistration)\(' -- src ':!*.test.ts' \
      | grep -vE ':[0-9]+: *(\*|//)'

On 2026-09-17 the first returned five statement sites — `student-privacy.ts`,
`unlinkTeacher`'s privacy upsert, `linkTeacherStudent`, `activateRegistration`
and `addToWaitlist`'s own `create` — and the second the two helpers'
definitions plus their callers: the registrations route, `acceptInvitation`,
`addToWaitlist`, `promoteNext` and `claimSpot`.

The gate's call sites, filtered to calls and definitions (the middle two
filters drop comment prose and the members of multi-line `import { … }`
blocks, and the last drops a single-line `import` statement):

    grep -rn 'lockStudentForErasure\|lockLiveStudent' src/ --include='*.ts' \
      | grep -v '\.test\.ts:' \
      | grep -vE ':[0-9]+: *(\*|//)' \
      | grep -vE ':[0-9]+: +[A-Za-z]+,$' \
      | grep -vE ':[0-9]+:import '

On 2026-09-17 it returned eight lines: the two definitions in `db-locks.ts`,
and one call each in `gdpr.ts`, `waitlist.ts`,
`src/app/api/registrations/route.ts`, and `student-privacy.ts`, and two in
`invitations.ts` (`acceptInvitation` and `unlinkTeacher`).

### `Announcement` rows: the audience scrub (#48)

`Announcement.audienceStudentIds` holds the ids of the students a send
notified, so `deleteStudentAccount` removes its subject's id from every row
that holds it (`array_remove`, filtered by `@>`). That makes `Announcement` a
node in the erasure's lock set: the statement takes `FOR NO KEY UPDATE` on each
row it rewrites. The column is in no unique index, so the lock never escalates
to `FOR UPDATE`, and it is no foreign key, so the `UPDATE` fires no RI check
and takes no `FOR KEY SHARE` on the row's `Teacher` or `Class`.

It runs after the class pre-lock, like every write in that transaction, so the
erasure's order is `Student → Class → Announcement`. `Announcement` is not on
the canonical line: the erasure scrubs it before `reorderWaitingEntries`
writes `WaitlistEntry` rows, which the line puts earlier, so no one position on
the line describes it; its order is the pairs in this section. Who else locks
an EXISTING `Announcement` row, and what each meeting does:

- **`sendAnnouncement` never does.** Its dedupe read is a plain `findMany`, no
  `FOR UPDATE`, and its one write inserts a new row. A row a send has inserted
  but not committed is invisible to the scrub, which therefore never waits on a
  send, so no cycle runs through this node with one. The other direction is
  older than this node: a send's `Announcement` and `Notification` inserts take
  `FOR KEY SHARE` on their `Class`, which waits on an erasure holding that
  class, while the erasure waits on nothing the send holds.
- **The `ON DELETE SET NULL` of `Announcement_classId_fkey`.** Deleting a
  `Class` rewrites `classId` on its announcements, `FOR NO KEY UPDATE` on each,
  which conflicts with the scrub's. In `src/` a `Class` is deleted only by the
  template archive's `calendarEntry.deleteMany` (`rule-lifecycle.ts`), through
  `Class`'s cascade from its entry, and that transaction pre-locks its classes
  first, so its order is `Class → Announcement` too. A class both transactions
  need is met at the `Class` row, before either touches an announcement. A
  scrub waiting on a row the archive has nulled waits, within its own 2s
  `lock_timeout`, for a transaction that waits on nothing the erasure holds,
  then re-checks `@>` on the committed version (the array is unchanged by the
  null) and applies. The archive re-applies its null onto a row the scrub
  committed the same way. The exception is the archive pre-lock's documented
  residual ("Ordering WITHIN `Class`", "One exception survives"; `gdpr.ts`,
  the comment above the erasure's first write): an entry rescheduled into the
  delete's predicate after the pre-lock is deleted without its `Class` held.
  If the erasure holds that class (the subject has a `WaitlistEntry` there,
  which is what puts a class in the erasure's lock set), and the
  same delete has already nulled an announcement, scoped to another of its
  classes, whose audience names the subject, the archive holds a row the scrub
  wants while waiting on the class the erasure holds: `40P01`. This is a
  second shape of that residual, beside the original one (the subject
  waitlisted in both classes), through the same window, and it is accepted
  with it.
- **The `ON DELETE CASCADE` of `Announcement_teacherId_fkey`.** No production
  code deletes a `Teacher`; erasure anonymises it.

The census of `Announcement` writers and of `Class`/`Teacher` deletes:

    git grep -n -i -E 'announcement[[:space:]]*\.[[:space:]]*(update|updateMany|upsert|delete|deleteMany|create|createMany)\(|"Announcement"' -- src ':!*.test.ts'
    git grep -n -E '(class|teacher|calendarEntry)[[:space:]]*\.[[:space:]]*(delete|deleteMany)\(' -- src ':!*.test.ts'

On 2026-10-01 the first returned `sendAnnouncement`'s `create` and the scrub
itself; the second the archive's `calendarEntry.deleteMany` and the studio
class route's `calendarEntry.delete`, whose entry is a studio one and has no
`Class` beneath it.

**A send that read before the erasure and commits after the scrub writes the
id back.** The scrub cleans the rows that exist when it runs. A send that
starts after the erasure has committed reads an audience without the erased
profile: both audience reads in `POST /api/announcements`
(`listAnnouncementAudience`, and the class-scoped `registration.findMany`)
require `deletedAt: null` on the student. But the route reads its audience
before `sendAnnouncement`'s transaction opens and takes no `Student` lock, so a
send that read the audience before the erasure committed, and whose row is not
yet committed when the scrub runs, writes the erased id into that new row, and
nothing scrubs it afterwards. This is accepted: the id is an opaque uuid of a
profile that no longer names anyone, and it stops affecting anything once the
row leaves the dedupe window. The same send's `Notification` to that profile
outlives the erasure the same way — `Notification` has no foreign key to
`Student`, and the erasure deletes only the notifications that exist when it
runs — so the announcement's text stays addressed to the erased profile until
the one-year inbox retention sweep (`src/lib/notification-retention.ts`)
deletes it.

## The `TeacherStudent` row is the archive's gate (#265)

Archiving a student (`archiveStudent`, `src/services/student-archive.ts`)
keeps one invariant — an archived link has nothing live — and
`docs/data-model.md` (TeacherStudent) states it with its "live" predicate and
every act that clears the flag again. This section is why those acts and the
archive all take the pair's link row lock, and where that lock sits in the
canonical line.

### The race it closes

Without a lock on the link row:

1. A booking inserts its `Registration`, uncommitted. The pair is already
   linked, so `linkTeacherStudent`'s `INSERT … ON CONFLICT DO NOTHING` finds
   the conflict committed and takes no lock on the row.
2. An archive counts live registrations — the booking's is invisible to it —
   finds none, archives, commits.
3. The booking commits. Archived link, live registration: the state the
   invariant forbids.

### The lock, and both orders it serialises

`lockTeacherStudentLink` (`src/services/roster-link.ts`) is a `SELECT … FOR
UPDATE` of the pair's row and writes nothing. `archiveStudent` takes it as the
first lock of its transaction, right after arming the lock timeout. Every act that makes the pair live takes
it too, through `activateTeacherStudentLink`, which clears `isArchived` under
it: `linkTeacherStudent` calls that after its insert, so every linking path
inherits the lock, and the teacher's roster add calls it directly.
`reopenPayment` (`src/services/payments.ts`) takes it before its
compare-and-swap. The two sides then queue on the one row in either order:

- **Booking first.** The archive's lock waits until the booking commits. Its
  registration count is a fresh statement under READ COMMITTED, so it sees
  the booking's registration and refuses `STUDENT_HAS_UNBILLED_CLASSES`.
- **Archive first.** The booking's `activateTeacherStudentLink` waits until
  the archive commits, re-reads the row with `isArchived = true`, and clears
  it in the booking's own transaction.
- **Reopen against archive** is the same argument with a payment for the
  registration: an archive holding the lock goes through (a `not_charged`
  payment is not outstanding), and the reopen, let through after it, makes
  the payment owed and un-archives; a reopen holding the lock commits a
  `pending` payment the archive's read then sees, and the archive refuses
  `STUDENT_HAS_OUTSTANDING_PAYMENTS`.

`completeClass` takes no link lock and needs none: the registrations it bills
were live and visible before it ran, so an archive concurrent with it refuses
on the registration (before completion commits) or on the new payment (after).

The teacher's own un-archive (`PATCH /api/students/[id]?state=unarchived`,
`src/app/api/students/[id]/route.ts`) is an unlocked `findUnique` of the link
followed, only when it read `isArchived = true`, by a `teacherStudent.update`.
That `UPDATE` takes the same row lock. The read does not, so an un-archive
racing an archive that holds the lock reads the row still active, answers
`unchanged`, and the archive then commits — the un-archive serialised before
the archive, a valid order: the teacher asked for "active" and got the answer
true when it was given.

`unlinkTeacher`'s `teacherStudent.delete` and the erasures'
`teacherStudent.deleteMany` take the row lock too, so a `DELETE` of the link
queues behind a linking transaction's `FOR UPDATE` instead of landing
between its roster-link write and what follows it —
`src/services/invitations-lock-order.test.ts` pins that for
`acceptInvitation` ("the roster-link lock closes this window"). The linking
transaction holds that lock to its end, so an unlink that queued on it
proceeds only once the linker has committed or rolled back.

### The gap before the lock: a link deleted under the linker

`linkTeacherStudent` is two statements, the insert and then the lock. On a
pair already linked, the insert (`INSERT … ON CONFLICT DO NOTHING`) meets a
committed row and takes no lock on it, so an unlink or erasure can delete
the row and commit in between. The `FOR UPDATE` then returns no row and
`activateTeacherStudentLink` reports `'missing'`. `linkTeacherStudent` throws
`RosterLinkVanishedError` on that, and the caller's transaction rolls back
rather than committing its booking, waitlist entry, claim, promotion, walk-in
or acceptance with no link beside it. It does not re-insert: the delete is
the student's unlink (with its `TeacherBlock`) or an erasure, and recreating
the link would override it.

Each route whose transaction reaches `linkTeacherStudent` answers the error
409 `CONCURRENT_MODIFICATION`, so a retry meets the pair as it now stands:
`POST /api/registrations` (self-booking and walk-in), `POST /api/waitlist`,
`POST /api/waitlist/claim`, and `POST /api/invitations/[id]/respond`, where
`acceptInvitation` maps it to its own `CONCURRENT_MODIFICATION` reason.
`promoteNext` runs in no request of its own, behind `handleSpotFreed`, whose
callers — the cancel route's `promoteAfterCancel`, the erasure's post-commit
loop and the waitlist-reconciliation sweep — log a failure per class and
carry on.

What neither the lock nor this error can see is an unlink committed before
the insert: after `acceptInvitation`'s outside `TeacherBlock` pre-check, and
either before its transaction opens or inside it ahead of the roster-link
write. The link is gone by then, so the insert genuinely creates it
(`'created'`, no throw), the lock finds that new row, and on a `delivered:
false` invitation the unlink leaves `pending` (#502) the CAS succeeds too.
`acceptInvitation`'s in-transaction `TeacherBlock` re-check, the last
statement of its transaction, is what refuses that accept — it must read
inside the transaction; a read before `$transaction` opens misses an unlink
landing inside it. Pinned by `src/services/invitations-lock-order.test.ts`'s
"an unlink committed inside the transaction before the roster-link insert
is refused by the in-transaction block re-check", which commits a real
`unlinkTeacher` from a hook on the insert before letting it run. Measured on
2026-09-28 by moving the re-check to a read just before `$transaction`:
that case fails with `{ ok: true, outcome: 'applied' }`, a link and an
`accepted` invitation; the two cases that commit the unlink from the
pre-check's own read stay green, since both reads come after it.

Pinned in `src/services/roster-link.test.ts` ("throws
RosterLinkVanishedError, rolling the caller back, when the link is deleted
before its lock": a holder takes the row's lock so the linker's insert
passes and its `FOR UPDATE` parks, then deletes the row and commits); over
HTTP in `tests/integration/student-archive-reactivation.test.ts` ("a
self-booking whose link is deleted while it waits on the link answers
CONCURRENT_MODIFICATION, no registration"); and for `acceptInvitation` in
`src/services/invitations-lock-order.test.ts` ("an unlink committed between
the roster-link insert and its lock rolls the accept back"), which commits a
real `unlinkTeacher` from a hook on the insert.

`src/services/student-archive-lock-order.test.ts` pins each order against the
real functions, observing the waiter in `pg_stat_activity` /
`pg_blocking_pids` before releasing the holder: "booking first", "archive
first", "reopen vs archive" (the archive holds) and "reopen first" (the
reopen holds). Measured on 2026-09-28 by removing `FOR UPDATE` from
`lockTeacherStudentLink`: all four fail, and the booking-first and
reopen-first cases both with `expected a refusal, got
{"kind":"archived","waivedCount":0}` — the forbidden state, an archived link
beside a live registration or an owed payment. Replacing only
`reopenPayment`'s lock with a plain `findUnique` fails "reopen vs archive".

### What the archive does not lock: the payment it waives

`markPaymentPaid`, `markPaymentNotCharged`, `markPaymentOverdue` and the
reminder writers (`src/services/payments.ts`,
`src/services/payment-reminders.ts`) write a `Payment` row without taking the
link lock. So a payment the archive read as open can be settled between that
read and the waive. The waive is therefore a status-filtered `updateMany`, and
a row count short of what the archive read open throws
`OutstandingChangedError`, rolling back the waive and the archive together;
the teacher is answered `STUDENT_HAS_OUTSTANDING_PAYMENTS` with the re-read
amount. That re-read is a transaction of its own that takes the link lock
again, since the rollback released it: a pair unlinked in between answers
`not-linked` instead (the lock-order file's "a pair unlinked after a waive
miss answers not-linked, not a refusal"). Pinned by the lock-order file's "a payment settled between the archive
reading it open and waiving it refuses the whole archive", which holds a copy
of `markPaymentPaid`'s `updateMany` uncommitted while the archive queues on
the payment row. Measured on 2026-09-28 by deleting the `count !== open.length`
throw: that case fails with `expected a refusal, got
{"kind":"archived","waivedCount":1}`.

No cycle follows from the archive waiting on a `Payment` row while holding
`TeacherStudent`: none of those payment writers ever requests the link lock,
so none holds a `Payment` row while waiting on one.

### Where `Payment` sits: after `TeacherStudent`

`archiveStudent` takes `TeacherStudent` (lock), reads `Registration` and
`Payment` unlocked, writes `Payment` (the waive), then writes
`TeacherStudent`. `reopenPayment` reads the payment unlocked, then takes
`TeacherStudent`, then writes `Payment`. Both take the link before any
`Payment` row lock, which is the position the canonical line gives it. The
booking paths are unchanged in order (`… → Registration → TeacherStudent`, then
`Invitation`/`TeacherBlock` on the paths that reach them);
`TeacherStudent` is an actual lock on them, for an existing link as much as
for a new one.

The census that placement was checked against — every `Payment` writer, and
which of them also locks `TeacherStudent`:

    grep -rnE "payment\.(create|update|updateMany|delete|deleteMany|upsert)\(" src | grep -v "\.test\."

On 2026-09-28 (branch `fix/265-student-archive-semantics`) it returned 9
lines = 5 in `payments.ts` (`markPaymentPaid`, `markPaymentOverdue`,
`reopenPayment`, `markPaymentNotCharged`, `sendPaymentReminder`) + 2 in
`payment-reminders.ts` (`markOverduePayments`, `sendPaymentReminders`) + 1 in
`class-lifecycle.ts` (`completeClass`'s `create`) + 1 in `student-archive.ts`
(`archiveStudent`'s waive). Two of the nine also lock `TeacherStudent` —
`reopenPayment` and `archiveStudent`, both link-first — and none touches
`Invitation` or `TeacherBlock`. A wider pattern,
`payment\.[a-zA-Z]+\(` minus the `find*`/`count`/`aggregate`/`groupBy`
readers, returned the same nine.

The erasures, read rather than grepped (`src/services/gdpr.ts`): neither
`deleteStudentAccount`'s nor `deleteTeacherAccount`'s transaction writes a
`Payment` row. Both anonymise rather than delete — the student erasure
cancels upcoming `Registration` rows with an `updateMany`, the teacher erasure
cancels `CalendarEntry` rows — so no `ON DELETE CASCADE` from `Registration`
reaches `Payment` either, and no trigger on `Payment` exists. The one
`Payment` write the teacher erasure causes is `completeClass` on each
in-progress class, and that runs in its own transaction before the erasure's
transaction opens. So no erasure transaction holds `Payment` and
`TeacherStudent` together, and neither constrains the position.

### Every caller of the lock

    git grep -n -E '(lockTeacherStudentLink|activateTeacherStudentLink|linkTeacherStudent)\(' -- src ':!*.test.ts'

On 2026-09-28 it returned 15 lines = 3 definitions + 2 calls inside
`roster-link.ts` (`linkTeacherStudent` → `activateTeacherStudentLink` →
`lockTeacherStudentLink`) + 10 call sites:

- `lockTeacherStudentLink` directly: `archiveStudent` (twice — its
  transaction, and the re-read after a waive miss), `reopenPayment`;
- `activateTeacherStudentLink` directly: the roster add in `POST
  /api/registrations` (`'missing'` rolls the registration back);
- `linkTeacherStudent`: the self-booking branch of `POST /api/registrations`,
  `acceptInvitation`, `addToWaitlist`, `promoteNext`, `claimSpot`, and
  `completeWalkIn` (`src/services/walk-ins.ts`, the walk-in path of the same
  route).

## The `Teacher` row is the photo upload's gate (#46)

A teacher's profile photo is a `TeacherPhoto` row (`docs/data-model.md`,
TeacherPhoto), written by `saveTeacherPhoto` and deleted by
`deleteTeacherAccount`'s closing transaction (`src/services/teacher-photo.ts`,
`src/services/gdpr.ts`). This section is why the two serialise on the
teacher's row, and why the erasure's delete sits where it does.

### The race it closes

The upload decodes and re-encodes the image with sharp before it writes
anything, which can take hundreds of milliseconds. Without a gate:

1. An upload passes its session check and starts processing the image.
2. An erasure anonymises the teacher, deletes its photo (none yet), commits.
3. The upload inserts its `TeacherPhoto` row and commits. The erased teacher
   now has a photo: personal data the erasure was asked to remove.

The foreign key does not stop step 3. The erasure is a soft delete, so the
`Teacher` row the insert references still exists, and the `FOR KEY SHARE` its
foreign-key check takes waits at most for the erasure to commit and then
passes: it reads nothing about whether the teacher is live.

### The lock, and both orders it serialises

`lockLiveTeacher` (`src/lib/db-locks.ts`) arms the shared lock timeout and
takes the teacher's row `FOR SHARE`, and it answers whether the row is live
(`deletedAt IS NULL`) from the read it locks with. `saveTeacherPhoto` takes it
as the first statement of its transaction, and refuses with `teacher-gone`
when the answer is no. The image is processed before `saveTeacherPhoto` is
called, so sharp's time is not spent holding the lock. The erasure's first
statement takes the row `FOR NO KEY UPDATE` (`lockTeacherForNoKeyUpdate`,
"The `Teacher` row is the first lock (#758)" below), which conflicts with
`FOR SHARE`; its closing anonymising `teacher.updateMany` rewrites `email` and
`pageSlug`, both unique, and so holds the row `FOR UPDATE` from there to
commit. The two queue on the one row in either order:

- **Upload first.** The erasure's first lock waits until the upload commits.
  The erasure's `teacherPhoto.deleteMany`, a later statement under READ
  COMMITTED, takes a fresh snapshot, sees the row the upload wrote, and
  deletes it.
- **Erasure first.** The upload's `FOR SHARE` waits until the erasure commits,
  then reads the row with `deletedAt` set, and the upload refuses without
  writing.

The erasure holds the row from its first statement, so an upload that arrives
during an erasure waits out the whole erasure transaction: the cancel loop
over every upcoming class, the notifications, the deletes. The upload's wait
is bounded by the shared 2s `lock_timeout`. For a teacher whose erasure runs
longer than that, the upload fails with `55P03` before it can read the row. It
then answers as a transient failure (503, `classifyApiError`,
`src/lib/api-errors.ts`) instead of `teacher-gone`. Either way it writes
nothing.

**The placement rule: the erasure's `teacherPhoto.deleteMany` goes after its
`Teacher` lock, never before.** Before it, the upload-first order leaks: the
delete finds nothing, the lock then waits out the upload, and the upload's row
survives the erasure. It sits after the closing `teacher.updateMany` in the
code, which satisfies the rule with room to spare.

### Why `FOR SHARE` and not `FOR KEY SHARE`

`FOR KEY SHARE` conflicts only with `FOR UPDATE`, which an `UPDATE` takes only
when it changes a key column — one covered by a unique index a foreign key
could use: non-partial, non-expression. `Teacher_account_live_unique` is
partial (`WHERE "deletedAt" IS NULL`), so `accountId` does not count even
though it is unique among live rows. The erasure's
`UPDATE` does that today, through `email` and `pageSlug`, so against today's
erasure `FOR KEY SHARE` would also serialise: measured below, and by a
`NOWAIT` probe on 2026-09-29 against a holder rewriting `email` and
`pageSlug` (both modes refused `55P03`) and one writing `deletedAt` alone
(`FOR KEY SHARE` acquired, `FOR SHARE` refused). The gate should
not depend on which columns the anonymisation happens to rewrite. An erasure
that kept `pageSlug` and `email`, or anything else writing `deletedAt` alone,
takes `FOR NO KEY UPDATE`, which `FOR KEY SHARE` does not wait for and
`FOR SHARE` does. `FOR SHARE` conflicts with every `UPDATE` of the row.

Two uploads for the same teacher both hold `FOR SHARE` at once, since the mode
does not conflict with itself. Prisma issues their `upsert`s as one statement,
`INSERT … ON CONFLICT ("teacherId") DO UPDATE` (read from its query log on
2026-09-29), so they meet on the `TeacherPhoto` row: the second waits for the
first's insert to commit, and then updates it. Last write wins, with no unique
violation — `src/services/teacher-photo.test.ts`'s "two concurrent saves for
one teacher leave one row and no error".

### Where `TeacherPhoto` sits: after `Teacher`

The upload takes `Teacher` (`FOR SHARE`) and then the `TeacherPhoto` row its
`upsert` inserts or updates. The erasure takes `Teacher` (`FOR NO KEY
UPDATE`, as its first lock) and, at the end, the `TeacherPhoto` row its
`deleteMany` removes. Both take `Teacher` first. The upload takes no other lock, so it holds nothing another
transaction could be waiting on while it waits for `Teacher`, and no cycle
through it is possible. `removeTeacherPhoto` is a single `deleteMany` of the
`TeacherPhoto` row and takes no `Teacher` lock, so the photo's own row is the
only one it holds or waits on.

### How it is pinned

`src/services/teacher-photo-lock-order.test.ts` stages both orders and
observes the waiter in `pg_stat_activity` / `pg_blocking_pids` before
releasing the holder:

- "an erasure that waits behind an upload still deletes what the upload
  wrote": a spy on `lockLiveTeacher` pauses the upload holding the gate, and
  the real `deleteTeacherAccount` runs against it. Measured on 2026-09-29 by
  moving the `deleteMany` to the top of the closing transaction: this case
  fails on the final photo count, `expected 1 to be +0`. The sequential case in
  `src/services/gdpr.test.ts` ("teacher erasure deletes the stored photo and
  the export carried it") stays green under that mutation.
- "an upload that waits behind an erasure is refused and writes nothing": a
  holder on a second connection writes `deletedAt` alone, so it takes
  `FOR NO KEY UPDATE`, and holds it. Measured on 2026-09-29 by changing the
  gate to `FOR KEY SHARE`: this case fails with `expected null not to be
  null`, the upload never having parked. The upload-first case stays green
  under that mutation, because the real erasure's `UPDATE` takes `FOR UPDATE`.

## The `Teacher` row is the first lock (#758)

An EXPLICIT lock on the teacher's row — one of the helpers below — comes
before every other row its transaction locks:

    Teacher → ClassTemplate → StudioClassTemplate → Class → …

A transaction that locks the teacher's row explicitly does it as its first
lock, before any template, `Class` or `CalendarEntry` row. Later
acquisitions on the same row are not explicit locks and are not covered by
that sentence: a foreign-key check's `FOR KEY SHARE` (below, "Why `FOR NO KEY
UPDATE`"), the erasure's own raise to `FOR UPDATE` at its closing `UPDATE`,
and the same raise in a currency-switching save that also changes `pageSlug`
(the switch's entry below). The sites:

- `deleteTeacherAccount` (`src/services/gdpr.ts`): `lockTeacherForNoKeyUpdate`,
  as the first statement of its closing transaction and ahead of the
  `FOR UPDATE OF ct` / `FOR UPDATE OF sct` pre-locks. Its answer is not
  consulted. A duplicate erasure waits there for the first one's commit; the
  helper's `"deletedAt" IS NULL` then fails on the re-checked row, so the
  duplicate locks nothing there and runs on until its closing
  `teacher.updateMany` matches no row and throws `AlreadyErasedError`. A
  transaction that holds no `Teacher` lock owes this order nothing. A live
  teacher's closing `teacher.updateMany` writes a row the transaction already
  holds. That `UPDATE` rewrites `email` and `pageSlug`, so it raises the hold
  to `FOR UPDATE`. By then the transaction holds every template and `Class`
  row it locks. After that `UPDATE` it deletes the teacher's
  `TeacherBankAccount` rows, under the `Teacher` lock it still holds, so a
  bank-account save (below) either committed before the erasure took that
  lock and is deleted here, or waits it out and writes nothing.
- `PUT /api/teachers/[id]`'s save (`updateTeacherProfile`,
  `src/services/teacher-profile.ts`) without a `currency` takes no explicit
  lock, but its `teacher.updateMany` waits on an erasure's hold and, scoped to
  `deletedAt: null`, writes nothing once the erasure commits. The PUT answers
  404. Without that scope it re-matched the anonymised row by `id` and wrote
  the PUT's profile fields back onto it.
- The payment-link save and removal (`savePaymentLink` and
  `removePaymentLink`, `src/services/payment-link.ts`, behind
  `PUT`/`DELETE /api/teachers/[id]/payment-link`): `lockTeacherForNoKeyUpdate`
  as the first statement (#786), then a read of the stored link, the
  `Teacher` `UPDATE` of that non-key column, and an insert of the
  `PayoutChangeEvent` that records it. Reading under the lock makes the event's
  "before" the link the write replaces: two saves serialise, and the second
  reads what the first committed. A write arriving during an erasure waits on
  the lock, finds the row erased and answers 404 without inserting an event.
  `src/services/payment-link.test.ts` pins both: its erasure race, and a
  `FOR SHARE` holder parking each writer in its first statement.
- The currency switch (`switchTeacherCurrency`,
  `src/services/currency-switch.ts`), which the same save runs when the body
  names a `currency`, in one transaction with the other fields:
  `lockTeacherForNoKeyUpdate` first, then this teacher's `ClassTemplate` rows
  and then its `StudioClassTemplate` rows `FOR UPDATE` in id order, then
  `lockClassRowsOrdered` over its unbooked, unfinished, live classes, then
  `UPDATE`s of those classes, of its `StudioClass` rows dated from its today,
  and of the teacher. The switch's own `Teacher` `UPDATE` writes a non-key
  column of a row the transaction already holds `FOR NO KEY UPDATE`, so it
  raises nothing. The other fields' write that follows it in the same
  transaction can: when it changes `pageSlug` (a unique column, so a key
  column to PostgreSQL), that `UPDATE` raises the hold to `FOR UPDATE`, which
  conflicts with a foreign-key check's `FOR KEY SHARE` and may wait for a
  transaction that inserted a row referencing this teacher. No cycle forms,
  because that holder never waits on a row the switch holds: the
  `FOR KEY SHARE` takers that also lock a template or `Class` row — the
  generator, `POST /api/registrations` (below, "Why `FOR NO KEY UPDATE`") —
  take that row first and insert after, so either they queued behind the
  switch on that row before reaching their insert, or the row is one the
  switch did not lock. By the raise the switch holds every row it will lock.
  An erasure and a switch serialise on the first lock; the one that waits
  for an erasure finds the row erased and answers 404. The other fields'
  write keeps the `deletedAt: null` scope above.
- The transactions that create a row under no existing template:
  `lockTeacherForShare` as their first lock, stamping the currency it returns.
  `POST /api/classes` (`src/app/api/classes/route.ts`, ahead of its room's
  `FOR KEY SHARE`), `POST /api/studio-classes`
  (`src/app/api/studio-classes/route.ts`), and template creation in both
  families (`createClassTemplate` in `class-template-lifecycle.ts`,
  `createStudioClassTemplate` in `studio-class-template-lifecycle.ts`), which
  generates its first window in the same transaction. `FOR SHARE` conflicts
  with the switch's `FOR NO KEY UPDATE`, so a create waits out a switch and
  stamps the currency it wrote, and a switch waits out a create and then
  relabels what it committed. Creators do not conflict with one another.
- The photo upload (`saveTeacherPhoto`, `src/services/teacher-photo.ts`):
  `lockLiveTeacher`, `FOR SHARE`, as its first lock, and the only one on
  `Teacher`. See the section above.
- The bank-account save and removal (`saveBankAccount` and
  `removeBankAccount`, `src/services/bank-accounts.ts`, behind
  `PUT`/`DELETE /api/teachers/[id]/bank-accounts/[currency]`):
  `lockTeacherForNoKeyUpdate` as the first lock (#786), then a read of the one `TeacherBankAccount` row on
  `(teacherId, currency)`, its upsert or delete, and an insert of the
  `PayoutChangeEvent` that records the change. A save whose values are
  already stored writes nothing and inserts no event. Under `FOR SHARE` two
  saves could both read the same row as "before"; this mode conflicts with
  itself, so they serialise. It also conflicts with
  the `FOR SHARE` creators above, which these writers wait out and which
  wait them out; neither side holds another lock the other wants. An erasure
  holds the row `FOR NO KEY UPDATE`, so a save that arrives during one waits,
  finds the row erased and answers 404. Without the lock the upsert's
  foreign-key `FOR KEY SHARE` is all that touches the teacher row. It does
  not conflict with `FOR NO KEY UPDATE`, and after the closing `UPDATE`'s
  raise it waits only for the erasure's commit and then passes against the
  anonymised row, which the erasure keeps. Either way the account it inserts
  outlives the erasure's delete.
  `src/app/api/teachers/[id]/bank-accounts/[currency]/route-lock-order.test.ts`
  pins this, and that a `FOR SHARE` holder parks both writers.
- The pause (`pausePayments`, `src/services/payout-pause.ts`, behind
  `POST /api/payout-pause`): a plain read of the `PayoutPauseToken` row by its
  hash, then `lockTeacherForNoKeyUpdate` as the first lock (#786). Under it:
  the token's `deleteMany` (the consume), reads of the teacher and of its
  earliest `PayoutChangeEvent`, a `Teacher` `UPDATE` of non-key columns
  (which raises nothing) unless already paused, then deletes of the
  account's `Session`, `PushSubscription` and `MagicLinkToken` rows and,
  last, of its passkeys created at or after the cutoff (or the frozen one,
  if later). Sessions go before passkeys: `Session.passkeyCredentialId` is
  `ON DELETE SET NULL`, and the sessions that existed are deleted first, so
  the passkey delete's `SET NULL` reaches only a session a passkey sign-in
  inserted between the two statements. The session delete is a statement
  snapshot, so a sign-in landing between the two statements leaves a live
  session: one with a passkey this delete removes has its credential nulled,
  and a session with no credential cannot satisfy a resume; one with a passkey
  created before the cutoff keeps its credential, which is the teacher's own
  by the trust model the cutoff states. None of
  those rows is locked by a transaction that then waits on
  `Teacher`. A pause arriving during an erasure waits on the lock, finds the
  row erased and answers `invalid` without consuming. A failure after the
  consume rolls it back: `src/services/payout-pause-lock-order.test.ts` holds
  the passkey row so the last delete times out, and the link still pauses
  afterwards.
- The resume (`resumePayments`, `src/services/payout-resume.ts`, behind
  `POST /api/teachers/[id]/payments-resume`): plain reads of the teacher and of
  the session's passkey before the transaction, then
  `lockTeacherForNoKeyUpdate` as the first lock (#786). Under it: re-reads of
  the teacher's pause columns, the session and its credential, and the
  teacher's `TeacherBankAccount` rows and link for the fingerprint; a
  `Teacher` `UPDATE` of non-key columns (which raises nothing); a delete of the
  teacher's `PayoutPauseToken` rows; a read of its outstanding `Payment` rows,
  an `UPDATE` of their `reminderSentAt`, and `Notification` inserts, each of
  whose foreign-key check takes `FOR KEY SHARE` on its `Class`
  (`relatedClassId`). The `Payment` `UPDATE` can wait on a holder of one of
  those rows, such as a mark-paid in flight, and a `Notification` insert on a
  `Class` `FOR UPDATE` holder (`completeClass` through `lockClassRow`,
  `updateClass`); none of those holders waits on `Teacher`, since each that
  takes the teacher row takes it first. Taking
  the payout writers' own lock is what makes the fingerprint meaningful: a
  bank-account or link save in flight finishes first, and the resume reads
  what it wrote. `src/services/payout-resume-lock-order.test.ts` holds a
  save's lock and its account change on a second connection, and asserts the
  resume parks and then answers `details_changed`. A resume arriving during an
  erasure waits, finds the row erased and answers 404.
- The passkey removal (`deletePasskey`, `src/services/passkey-credentials.ts`,
  behind `DELETE /api/auth/passkey/[id]`): a plain read of the account's live
  teacher, then, when there is one, `lockTeacherForNoKeyUpdate` as the first
  lock (#786) and a read of its `paymentsPausedAt` under it; paused answers
  the refusal with nothing written. Then the `PasskeyCredential` read and
  delete, whose `ON DELETE SET NULL` updates every `Session` naming the
  credential, and the `RemovedPasskey` insert, which has no foreign key.
  Without the teacher lock this deadlocks against the pause: the pause deletes
  the sessions and then the passkeys, the removal deletes a passkey and then
  sets its sessions' credential to null, so each can hold the row the other
  waits on. With it, the two serialise on `Teacher` before either touches a
  session or a passkey, and a removal that waited out a pause reads it
  paused. An account with no live teacher profile takes no teacher lock: no
  pause can reach it. `src/services/passkey-credentials-lock-order.test.ts`
  holds the teacher row and a pause's `UPDATE` on a second connection, and
  asserts the removal parks and then answers `payments_paused`.
- The passkey-added email's "This wasn't me" link (`revokePasskeyByLink`,
  `src/services/passkey-revoke.ts`): a plain read of the `PasskeyRevokeToken`
  row by hash, then `lockForPasskeyRemoval`: a plain read of the account's
  live teacher, then, when there is one, `lockTeacherForNoKeyUpdate` as the
  first lock and a read of its `paymentsPausedAt` under it. Under it the
  token's `deleteMany`, a read of the `Account`, when the account is not paused
  the `PasskeyCredential` read and delete (its `SET NULL` reaches `Session`)
  and the `RemovedPasskey` insert, then the `Session` and `PushSubscription`
  deletes and the `MagicLinkToken` delete. The passkey goes before the
  sessions so that a passkey sign-in cannot slip a `Session` in between: one
  committed before the passkey delete is caught by the session delete (a later
  `READ COMMITTED` statement sees it), and one arriving after blocks on the
  credential row and fails its foreign key once the redemption commits. It
  cannot deadlock against a pause: both serialise on `Teacher` before touching
  a session or a passkey. Passkey before sessions is also `deletePasskey`'s
  order. An account with no live teacher profile takes no teacher lock, so
  there the link can still deadlock with `deleteStudentAccount` (`gdpr.ts`,
  student half), which deletes the sessions, then the passkeys, then rows of
  its own tokens (`RemovedPasskey`, `PasskeyRevokeToken`, ...): each can hold
  what the other waits on, and the loser answers 40P01. The link's side rolls
  back, the consume with it, and the link can be used again; an erasure that
  loses is a 500 and is retried. A link redeemed during a pause signs out and
  keeps the passkey.
  `src/services/passkey-revoke.test.ts` holds the pause and the removal's
  outcomes, `src/services/passkey-revoke-order.test.ts` holds the order of the
  two deletes, and
  `src/services/passkey-revoke-lock-order.test.ts` holds a session row on a
  second connection so the passkey delete (whose `SET NULL` updates it) times
  out, and asserts the token is still usable afterwards. An account with no
  teacher profile takes no teacher lock and so sets no `lock_timeout`: its wait
  is bounded by the transaction's own timeout instead.

A generated row needs no `Teacher` lock: the generator holds its template row
`FOR UPDATE` across the insert and reads the teacher's currency under that
lock (`claimRuleForGeneration`, `entry-generation.ts`). The switch takes every
template row of the teacher before it reads a class, so it waits out a
generation in flight and its class lock sees the rows that generation
committed; a generation that starts later waits on its template and reads the
new currency.

Re-derive the call sites with:

    grep -rnE "(lockTeacherForNoKeyUpdate|lockTeacherForShare|lockLiveTeacher|lockForPasskeyRemoval)\(" src | grep -v "\.test\." | grep -v "db-locks.ts" | grep -v "export async function" | grep -vE ":[0-9]+: *(\*|//)"

It prints call lines only: an import has no `(` after the name, and the last
three filters drop the definitions and comment lines. Run on 2026-10-10 after
the passkey-added link joined them, it printed `classes/route.ts`,
`studio-classes/route.ts`, `class-template-lifecycle.ts`,
`studio-class-template-lifecycle.ts`, `gdpr.ts`, `currency-switch.ts`,
`teacher-photo.ts`, `bank-accounts.ts` (its save and its removal),
`payment-link.ts` (its save and its removal), `payout-pause.ts`,
`payout-resume.ts`, `passkey-credentials.ts` (the helper's own lock and
`deletePasskey`'s call of it) and `passkey-revoke.ts`, each a site with an
entry above.
Re-derive the list rather than trusting it.

### Why `FOR NO KEY UPDATE` and not `FOR UPDATE`

An insert into any table with a foreign key to `Teacher` takes `FOR KEY SHARE`
on the teacher's row in the foreign-key check. `CalendarEntry`, `ScheduleRule`,
`TeacherStudent`, `TeacherRoom`, `Invitation`, `TeacherBlock`, `StudentPrivacy`,
`TeacherPhoto`, `TeacherBankAccount`, `Announcement`, `PayoutChangeEvent` and
`PayoutPauseToken` all reference it
(`prisma/schema.prisma`).
`FOR UPDATE` conflicts with `FOR KEY SHARE`, so a `Teacher` lock in that mode
would add a wait edge to every site that inserts such a row while holding a
template or `Class` row. Two of them close a cycle against a first lock in
that mode:

- **The generator.** `claimRuleForGeneration` (`entry-generation.ts`) holds the
  template row `FOR UPDATE OF tpl` and then inserts `CalendarEntry` rows. An
  erasure holding `Teacher FOR UPDATE` and waiting for that template row is
  AB-BA. On 2026-10-06, flipping `lockTeacherForNoKeyUpdate` to `FOR UPDATE`
  made `gdpr-lock-order.test.ts`'s "does not deadlock against a generation
  holding the template row and inserting an entry" fail with `40P01`.
- **`POST /api/registrations`.** It holds `lockClassRow` and then
  `linkTeacherStudent` inserts `TeacherStudent`. An erasure holding
  `Teacher FOR UPDATE` and waiting in `lockClassRowsOrdered` for that class is
  AB-BA. On 2026-10-06 a probe staged this: a holder took `lockClassRow`,
  waited until the real `deleteTeacherAccount` was blocked behind it, and then
  inserted the `TeacherStudent` row. Under `FOR UPDATE` that ended in `40P01`.
  Under `FOR NO KEY UPDATE` both committed. The probe was not kept as a test.
  The generator test pins the same mechanism.

A `TeacherBankAccount` insert holds no template or `Class` row, so it closes no
cycle of this kind: it holds no row a template or `Class` lock waits on.

`FOR NO KEY UPDATE` does not conflict with `FOR KEY SHARE`, so neither insert
waits. It does conflict with `FOR SHARE` (every `lockTeacherForShare` and
`lockLiveTeacher` site above) and with itself (erasure against the switch), and those are the
serialisations this node exists for. `src/lib/db-locks.test.ts`, "the Teacher
first lock (#758)", probes each mode with `NOWAIT`.

The closing `UPDATE`'s raise to `FOR UPDATE` is an acquisition this
transaction has always made at that point. Before #758 it was made from
nothing, so moving a weaker lock to the top adds no wait edge at the end.

### What else takes `Teacher` inside a transaction

`grep -rn -e 'tx\.teacher\.\(update\|upsert\|delete\)' -e 'FROM "Teacher"' -e 'lockLiveTeacher(' src | grep -v '\.test\.'`
on 2026-10-06 found the two lock helpers' callers above, a lock-free
`COUNT(*)` in `db-provision.ts`, and the erasure's own `teacher.updateMany`.
Re-run after the currency switch landed the same day, it also finds the
switch's closing `teacher.update` (`currency-switch.ts`) and the currency
save's `teacher.updateMany` of the other fields (`teacher-profile.ts`),
both writing a row their transaction took `FOR NO KEY UPDATE` as its first
lock. No site holds a template or `Class` row and then explicitly locks or
writes a `Teacher` row it does not already hold. The foreign-key `KEY SHARE` above is the only implicit edge, and
`FOR NO KEY UPDATE` is chosen so that it does not conflict.

### How it is pinned

`src/services/gdpr-lock-order.test.ts`, "deleteTeacherAccount takes the Teacher
row first (#758)":

- "issues a FOR NO KEY UPDATE on Teacher as its first lock, before the template
  pre-lock" records every raw locking statement in order. On 2026-10-06,
  moving the call after the `FOR UPDATE OF ct` pre-lock made it fail with
  `expected 1 to be +0`.
- "holds no ClassTemplate row while it waits for a holder of the Teacher row":
  a second connection holds `Teacher` `FOR SHARE`, and a third probes the
  template row `FOR UPDATE NOWAIT` while the erasure is parked. Under the same
  mutation, the probe was refused instead of answering `free`.
- "does not deadlock against a generation holding the template row and
  inserting an entry": the mode pin described above.

`src/services/currency-switch-lock-order.test.ts` stages each of the switch's
races with a second connection holding the other side's row until the request
under test is parked behind it. Mutations measured on 2026-10-06, each
restored afterwards:

- Dropping `FOR UPDATE OF ct` from the switch made "relabels a class a
  generation inserted while the switch waited on its template" fail with
  `expected 'EUR' to be 'GBP'`; dropping `FOR UPDATE OF sct` did the same to
  its studio twin.
- Replacing `lockTeacherForShare` in `POST /api/classes` with a plain read made
  "POST /api/classes waits for the switch and stamps its currency" fail with
  `expected [ 'EUR' ] to deeply equal [ 'GBP' ]`.
- Dropping `NOT c."settingsLocked"` from the switch's class lock made "keeps the
  currency of a class booked while the switch waited on it" fail with the class
  ending `GBP`. `src/services/currency-switch.test.ts`'s relabel-set case
  failed under the same mutation, the booked class counted as relabelled.

## The advisory lock, which is not a row in the line above (#196, #215)

`lockAnnouncementSlot` (`src/services/announcements.ts`) is the first and so far only
advisory lock in this project. It takes
`pg_advisory_xact_lock(196, hash32("<teacherId>|<message>"))` — the
two-int form, first argument a constant namespace — as the **first statement**
of the transaction in `sendAnnouncement` (`src/services/announcements.ts`), so that two
sends of the same text from one teacher cannot both read an empty duplicate check and both fan out one
`Notification` per recipient. The key names the same two columns the transaction's
`findMany` dedupe compare filters on, and no class: dedupe is per recipient, so a
class-scoped and an all-students or custom send of one text contend for the same lock.

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

**It cannot be half of a cycle today, and the reason is structural at the service boundary (#215).**
A cycle needs some other transaction to hold a `Class` row lock and then wait on this advisory lock.
Nothing can: `lockAnnouncementSlot` is **module-private** to `src/services/announcements.ts` (issue #215)
and is called from only one place — the first statement of `sendAnnouncement`'s transaction. Because it is not exported, another
transaction (such as a notification sweep or cancellation path that already holds a `Class` row lock)
cannot invoke `lockAnnouncementSlot` and create an inversion without explicitly breaking the service module
boundary. Two announcement sends racing each other take the two locks in the same order (`advisory → Class`),
which is not a cycle either.

**The single-call-site invariant is now enforced by the module boundary, not a comment.**
Originally (#196), `lockAnnouncementSlot` lived in `src/lib/db-locks.ts` as an exported helper,
relying on a warning in this document asking contributors to check for a second call site before
calling it. Issue #215 resolved this by encapsulating the advisory lock inside `sendAnnouncement`
in `src/services/announcements.ts`. "First statement in transaction" and "exactly one call site"
are now facts about the service boundary rather than conventions a reader has to remember.

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
`P2028` that eventually surfaces is a 503 via `TRANSIENT_PRISMA_CODE_KIND`
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

This still matters for the real `TeacherBlock` upserts in `invitations.ts` —
`unlinkTeacher`'s and `declineInvitation`'s, every one of them `update: {}`
and every one taking `Invitation` before `TeacherBlock`. Re-derive both halves
of that claim — the payload and the order — with:

```sh
grep -nE -A3 'tx\.(invitation|teacherBlock)\.(update|updateMany|upsert)\(' \
  src/services/invitations.ts
```

Each `teacherBlock.upsert` carries its `update: {}` inside the printed window,
and each is preceded within its own transaction by that transaction's
`invitation` write — read off the ascending line numbers. `acceptInvitation`'s
`invitation.updateMany` matches too; it upserts no block, so it is not one of
these sites.

`resolveInvitationOnLink` takes `TeacherBlock` and `Invitation` in the
opposite order (see "Known safe by accident" below), and the reason racing
them doesn't currently deadlock is those upserts taking no row lock whenever
the block row already exists — **not** because either order is safe.

Until #181 the same quirk also covered five `TeacherStudent` call sites, each
upserting it with `update: {}` while racing a transaction that took the
opposite order on purpose or by circumstance — `acceptInvitation`
(`invitations.ts`); `addToWaitlist`, `promoteNext`, `claimSpot`
(`waitlist.ts`); and `POST /api/registrations` (`route.ts`). #181 replaced all
five with one shared writer, `linkTeacherStudent` (`services/roster-link.ts`)
— `createMany` with `skipDuplicates`, which compiles to `INSERT ... ON
CONFLICT DO NOTHING`, one statement with no separate `update` payload left for
a future edit to widen. That retires the "one real column away from
vanishing" risk this section used to warn about for `TeacherStudent`
specifically.

It does NOT retire the wait edge the old `TeacherStudent` upsert's `INSERT`
path already had when the row did not exist yet. Measured directly (#181 task
1): `ON CONFLICT DO NOTHING` still asks Postgres for the row lock against an
uncommitted conflicting tuple, and that wait still participates in deadlock
detection exactly like the old `INSERT` path's did. #179's `{Invitation,
TeacherStudent}` reorder (see "Known conformance" below) is what closes that
cycle, and it remains load-bearing after this statement change — the new
statement does not close it by itself. What #181 removed was the `P2002` a
losing caller used to get on that wait, not the wait itself.

**If you are the future reader who turns one of those `TeacherBlock`
`update: {}` payloads into something with a real field in it** (an `updatedAt`
stamp, a bookkeeping flag, anything) — stop. That edit restores the atomic,
lock-taking path for that upsert, and if the write order at that call site
doesn't already match this document, you have just reintroduced a live
`40P01`. Check this file first.

For `declineInvitation` that edit is no longer silent, and the executable form
of this paragraph is worth more than the paragraph: the first test of the
`Invitation and TeacherBlock take one lock order` describe in
`src/services/invitations-lock-order.test.ts` races the real
`declineInvitation` against the real `resolveInvitationOnLink` and settles.
Give that upsert a real field and that test goes red. The second test in the
describe shows what the field costs — the same race gets `40P01` — but its
decline side is hand-rolled, because the payload is the mutation under test
and no client extension can reach inside it. So it is the first test, not the
second, that watches the production function.

`unlinkTeacher`'s upsert has no equivalent pin: the #174 task 7 measurement
below raced hand-shaped transactions, not that function, so an edit to its
payload still fails first in production.

`StudentPrivacy`'s upsert (`unlinkTeacher`, `SILENCED_PRIVACY`) is never
empty — six real boolean columns, every call — so it was never protected by
this quirk. The `{StudentPrivacy, TeacherStudent}` inversion #174 task 7 fixed
was a live, reproduced deadlock in real production code, not a theoretical one.

## The RESTRICT trigger is a wait edge, and a route guard is what closes it (#103)

`ClassTemplate_teacherRoomId_roomArchived_fkey`
(`20260827120000_template_room_archive_invariant/migration.sql`; formerly
`ClassTemplate_teacherRoomId_fkey`) and `Class_teacherRoomId_roomArchived_fkey`
(`20260905120000_class_room_archive_invariant/migration.sql`; formerly
`Class_teacherRoomId_fkey`) are both
`ON DELETE RESTRICT`. A
`DELETE FROM "TeacherRoom"` therefore locks the parent row and then runs the
triggers' `SELECT 1 FROM "ClassTemplate" WHERE "teacherRoomId" = $1 AND
"roomArchived" = $2 FOR KEY SHARE` — a lock nothing in this document's site
enumeration can see, because no source line issues it. The second conjunct
arrived with issue 272, which widened the key to carry the room mirror; it
changes nothing about the lock, because the mirror guarantees every child row
matches its parent's value, but the check Postgres runs is the two-column one
and this section exists to state it exactly. Issue 339 widened the `Class`
side's key the same way, so its own RESTRICT trigger runs the identical
two-column check against `Class` — see "The class mirrors' foreign keys are
wait edges (#339)" below for that edge; nothing in the argument here changes,
because it was never about `Class`'s name, only about whether a second,
independent cycle exists (next).

The cycle:

| | holds | waits for |
|---|---|---|
| generator sweep | `ClassTemplate` `FOR UPDATE` (`claimTemplateForGeneration`) | `TeacherRoom` `FOR KEY SHARE`, from its `Class` insert's FK check |
| room delete | `TeacherRoom`, exclusively | `ClassTemplate` `FOR KEY SHARE`, from the RESTRICT trigger |

AB-BA, so `40P01`. It did not exist before #95, which is when the sweep first
held a template lock across its inserts.

**What closes it is a guard in each delete route, not a lock.** Both routes
count `ClassTemplate` rows and refuse with 409 before issuing the `DELETE`
(`countRoomDeleteBlockers` in the rooms route, `countTeacherRoomDeleteBlockers`
in the teacher-rooms route, both in `src/services/room-deletion.ts`), and the cycle
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

**Why `Class_teacherRoomId_roomArchived_fkey` does NOT add a second unclosable cycle**, which
an earlier version of this section wrongly claimed. For the sweep to be
inserting a `Class` on `TeacherRoom` X it must be holding
`claimTemplateForGeneration`'s `FOR UPDATE` on a `ClassTemplate` whose
`teacherRoomId` IS X (the generator's `Class` insert copies `template.teacherRoomId`
onto every row it inserts). That template row is committed, and the pre-check
counts **every** template with no `isActive`/`isArchived` filter
(`countRoomDeleteBlockers`, `countTeacherRoomDeleteBlockers`), so it sees it, answers 409, and the `DELETE` is never
issued — the same mechanism that closes the template edge. The `Class` edge is
reachable only inside the check-to-`DELETE` window described next, not as an
independent cycle.

**Residual, and accepted:** a template created between the check and the
`DELETE`. The wait is bounded well below the sweep's `{ timeout: 10_000 }`
envelope (`class-generator.ts:408`): Postgres's `deadlock_timeout` breaks the
cycle at its 1 s default, which this repo does not override, and the sweep's
own `LOCK_TIMEOUT_SQL` is `SET LOCAL lock_timeout = '2s'` (`db-locks.ts`).
Both outcomes are legible — `40P01` is in `TRANSIENT_SQLSTATE_KIND`
(`api-errors.ts`) and answers 503 retryable, and the far likelier `P2003`
is answered 409 by the catch, which logs at `warn` because reaching it means
the pre-check did not stop the delete. A
`lock_timeout` on the delete was considered and rejected: it would add a
lock-taking node to the within-`Class` ascending-id order ("Ordering WITHIN
`Class`" above), for a few seconds in a window that needs a concurrent
template creation.

## One teacher, one slot: two exclusion constraints (#296, #298, #327)

One teacher holds at most one live row per slot ACROSS the two families, at
both layers. Since #327 both halves are the same KIND of mechanism, and neither
is a trigger:

- **`CalendarEntry`, since #327.** `CalendarEntry_teacher_slot_excl`, one
  `EXCLUDE USING gist` over `("teacherId" WITH =, span WITH &&)`, partial on
  `"cancelledAt" IS NULL`. `span` is a generated `tsrange` over
  `[date + startTime, date + startTime + durationMinutes)`, so it is RANGE, not
  exact-start: two live entries of either kind whose windows overlap now
  conflict even when their start times differ, and an entry running past
  midnight conflicts with one on the following date.
- **`ScheduleRule`, since #298.** `ScheduleRule_teacher_slot_excl`, the same
  shape one layer up — `(teacherId, dayOfWeek, slot)`, partial on
  `isArchived = false`, RANGE rather than exact-start for the same reason.

Both are index-backed and therefore **race-free by construction**: the second
writer blocks on the first's uncommitted index entry — the `ShareLock` "The
slot key is a wait edge" above describes — and is refused with `23P01` once
that transaction commits. Neither needs a lock of its own, for the same reason
within-family exclusivity never did.

Re-derivable rather than remembered:

```sql
SELECT conrelid::regclass AS "table", conname, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE contype = 'x' ORDER BY 1;
```

**`YG001` has no raiser left, and neither does its matcher any more.**
Both halves of this invariant used to be trigger functions running a plain
`SELECT … LIMIT 1` against the SIBLING table and raising the user-defined
SQLSTATE `YG001`: one function per table, fired by an INSERT trigger and an
UPDATE trigger each. #298 folded the template half into
`ScheduleRule_teacher_slot_excl` and #327 the entry half into
`CalendarEntry_teacher_slot_excl`, so what is left is a number rather than a
roster — and it is a query, not a memory:

```sql
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosrc LIKE '%YG001%';
```

It returns **0** — measured against `ethical_yoga_test` on 2026-08-26. The
earlier values are deliberately not written down here: nobody ran this query
before those extractions, and a number nobody measured does not become true by
being plausible. The two template `POST` routes' dead arms that called
`isCrossFamilySlotConflict` are gone (issues 331/228), and with them the
function's last two callers. `src/lib/cross-family-conflict.ts` and its test
were deleted in the same round rather than kept at zero callers —
`grep -rn 'isCrossFamilySlotConflict' src` now matches only comment prose in
other files narrating what the deleted predicate used to do, no import or
call site among them.

**The migration comments that this document owns.** Each entry below is prose
about an APPLIED migration — immutable, comments included — that cannot live
where it belongs: either it was written into the migration and is wrong or stale
there, or it is what should have been written there and now never can be.

The first was briefly added as a comment inside
`20260821120000_cross_family_slot_guard/migration.sql`. A comment-only edit
still changes the file's SHA-256, and `_prisma_migrations` stores that checksum
— measured, `861bd46…` against `3867657…`. `prisma migrate status` compares
NAMES and passes regardless, so nothing catches it until the next
`prisma migrate dev` reports the migration as modified and demands a reset.
Applied migrations are immutable including their comments; prose about a
migration belongs in prose. What it said: the invariant spans two tables, so no
unique index could express it, and a trigger was what was left. That premise is
what #298 and #327 removed — a *generated range column* on a single shared
table is an expression a unique-style constraint can carry, and the two
extractions are what created the shared table to put it on.

The second is `20260825065109_schedule_rule_backfill/migration.sql`, block 4,
which drops the four TEMPLATE-half triggers —
`class_template_cross_family_slot_insert_guard`,
`class_template_cross_family_slot_update_guard`,
`studio_class_template_cross_family_slot_insert_guard`,
`studio_class_template_cross_family_slot_update_guard` — ahead of dropping the
columns their `WHEN` clauses name, and whose own comment there reads:

> Measured: 10 dependencies across the four triggers, on teacherId,
> dayOfWeek, startTime and isArchived.

That is a prose count and a member roster reaching into the previous
migration ("since the previous migration"), both of which CLAUDE.md's Comment
Discipline forbids, and the migration is applied — so the comment stays wrong
where it sits. This document is the live copy, re-derivable rather than
remembered:

```sql
SELECT count(*) FROM pg_depend d
JOIN pg_trigger t ON t.oid = d.objid AND d.classid = 'pg_trigger'::regclass
JOIN pg_class c ON c.oid = d.refobjid
WHERE d.refclassid = 'pg_class'::regclass AND d.refobjsubid > 0
  AND c.relname IN ('ClassTemplate','StudioClassTemplate');
```

It returned 10 before #298 (the count the stranded comment records) and returns
0 after — measured against both `ethical_yoga_test` and `ethical_yoga` on
2026-08-25. A reader who finds the migration comment first should believe this
paragraph, not that one: the triggers it counted dependencies for no longer
exist, on either table.

The third is `20260827120000_template_room_archive_invariant/migration.sql`,
whose `REMEDIATION` block pauses every live `ClassTemplate` found on an
archived `TeacherRoom`, by clearing `isActive` on the `ScheduleRule` above it —

```sql
UPDATE "ScheduleRule" sr SET "isActive" = false
  FROM "ClassTemplate" ct
  JOIN "TeacherRoom" tr ON tr."id" = ct."teacherRoomId"
 WHERE ct."scheduleRuleId" = sr."id"
   AND sr."isActive" AND NOT sr."isArchived"
   AND tr."isArchived";
```

— and says nothing about having run. No `RAISE NOTICE`, no `GET DIAGNOSTICS`,
no audit row (`grep -rn 'AuditLog\|audit_log' src/ prisma/` prints nothing),
and **not even an `updatedAt` bump**: `ScheduleRule.updatedAt` is `@updatedAt`,
which Prisma enforces in its client, and raw migration SQL never reaches that
client. A teacher whose template stopped generating classes has, in the
database, no record that the platform stopped it. That is issue #463. The
comment above the statement — which calls itself `REMEDIATION` and argues why
pausing beats un-archiving the room — is the whole of the record, and it sits
in the source tree rather than in any database an operator can query.

It is not repaired where it sits, for the reason the first entry above gives:
the migration is applied, so a comment-only edit changes a checksum nothing
compares until the next `prisma migrate dev` demands a reset.

**A later migration re-running the remediation under a notice would be inert,
and inert in the worst place.** The `CHECK` at the foot of that same file,
`ClassTemplate_live_needs_open_room` — `NOT ("ruleLive" AND "roomArchived")` —
forbids exactly the rows the `UPDATE` targets: each mirror column is one column
of a composite foreign key to its parent, so a row cannot store a mirror its
parent disagrees with, and `ruleLive AND roomArchived` therefore *is*
`(isActive AND NOT isArchived) AND tr.isArchived`. Every door into that state is
proven refused in `src/services/template-room-constraint.test.ts`. And Prisma
applies migrations in name order, so against the one kind of database that
would have anything to report — a stale one still holding violating rows —
`20260827120000` runs first and silently repairs them; the later migration then
reports zero. The announcement would be guaranteed silent in precisely the case
it exists for.

**What an operator can still run.** It lists paused rules whose template sits on
an archived room:

```sql
SELECT sr."id" AS rule, sr."teacherId" AS teacher, ct."id" AS template,
       tr."id" AS room, sr."updatedAt"
  FROM "ScheduleRule"  sr
  JOIN "ClassTemplate" ct ON ct."scheduleRuleId" = sr."id"
  JOIN "TeacherRoom"   tr ON tr."id" = ct."teacherRoomId"
 WHERE NOT sr."isActive" AND NOT sr."isArchived" AND tr."isArchived"
 ORDER BY sr."updatedAt";
```

It returns 0 rows against both `ethical_yoga` and `ethical_yoga_test` —
measured 2026-09-05. **Those are candidates, not a roster, and an empty result
is not an all-clear.** A rule the migration paused and one the teacher paused
before archiving the room are indistinguishable in the stored state: door 1
refuses archiving a room a live template sits on, so pausing first is what a
teacher doing this by hand also does.

**`updatedAt` is evidence for the operator to weigh, not a filter** — which is
why it is selected and not tested in the `WHERE`. The raw `UPDATE` never touched
it, so a row the migration paused and nothing has written since still carries a
value predating the migration. But writing that row does not require resuming
it: `updateRule` (`src/services/rule-lifecycle.ts`) sends the teacher-editable
schedule fields — the compiler's own roster, `TeacherEditableScheduleRuleField`
(`src/services/class-template-lifecycle.ts`) — to `ScheduleRule` through the
Prisma client, which bumps `@updatedAt`. It cannot touch `isActive` or
`isArchived`: both sit in `PlainUpdateForbiddenScheduleRuleField`, and that
statement's payload types every member of it as `never`. A teacher who edits the schedule of a template that is still
paused therefore pushes `updatedAt` past the migration without changing anything
about its pausedness. So a later value rules out only *"still sitting as the
migration left it"*, never *"was never remediated"*, and a `WHERE` clause
excluding those rows would hide genuine candidates rather than sharpen the list.

Nor does 0 rows mean the remediation never fired. A rule it paused that was
later resumed, or one whose room was later un-archived, leaves exactly the same
nothing behind — and so does a rule that was later ARCHIVED, which
`NOT sr."isArchived"` drops. That third one is the likeliest of the three and
the worst, because the incident and its erasure share a cause: a teacher whose
template silently stopped generating classes is exactly the person who then
archives it as dead. Two doors reach it — `archiveOrUnarchiveRule`
(`src/services/rule-lifecycle.ts`), archiving being legal from paused, and
`deleteTeacherAccount` (`src/services/gdpr.ts`), which writes
`{ isActive: false, isArchived: true }` across every rule the teacher has. To
see those too, drop `AND NOT sr."isArchived"` from the query and select the
column instead of testing it. A third case does not empty the list but does corrupt it — a
rule that stayed paused and had its day, time or duration edited afterwards
still appears, carrying an `updatedAt` later than the migration, which an
operator reading that column as an alibi would wrongly strike off.

**Where that comparison needs the migration's instant, take it from
`_prisma_migrations.finished_at` and never from the timestamp in the migration's
name** — and that is not fastidiousness. The name encodes `2026-08-27 12:00`;
both databases on this machine recorded an instant LATER than that, and a
different one from each other, because `ethical_yoga_test` is rebuilt from
migrations every time the test setup runs. Anything hard-coding the name's
instant is wrong on at least one of any two databases. What each database
actually recorded, re-derived rather than remembered:

```sql
SELECT migration_name, finished_at FROM "_prisma_migrations"
 WHERE migration_name = '20260827120000_template_room_archive_invariant';
```

**Since #463 a migration landing after `20260903195051_student_signup_purposes`
must announce or explain a data change, for the two shapes the rule reads.**
`untracedDataChanges` (`tests/migration-sql.ts`, pinned by
`src/lib/migration-remediation-trace.test.ts`) reports any migration sorting
after that cutoff whose comment-stripped SQL contains `UPDATE "…"` or
`DELETE FROM "…"` — in any case, upper or lower, and with an optional `ONLY`
between the verb and the table — without a real `RAISE NOTICE`, unless the raw
text carries `-- DML WITHOUT NOTICE: <reason>` with a non-empty reason. Those two shapes are the whole of it:
`UPDATE "public"."X"` IS seen, since the quote follows the verb, but the
unquoted `UPDATE public."X"` is not, nor are `TRUNCATE`, `MERGE`,
`ON CONFLICT DO UPDATE`, or an `ALTER TABLE … ALTER COLUMN … USING <expr>` that
rewrites every row.

**The exemption is per FILE, not per statement**, which is the rule's other
boundary. One real `RAISE NOTICE` anywhere in a migration exempts every data
change in it, so a silent remediation added beside an announced one passes.
That shape is precedented rather than hypothetical — the tree's one compliant
example already carries more than one data change under a single notice:

```sh
perl -0777 -ne '
  my $s = $_; $s =~ s{/\*.*?\*/}{ }gs; $s =~ s{--[^\n]*}{}g;
  my $d = () = $s =~ /\bUPDATE\s*(?:ONLY\s+)?"|\bDELETE\s+FROM\s*(?:ONLY\s+)?"/gi;
  my $n = () = $s =~ /\bRAISE\s+NOTICE\b/gi;
  print "$ARGV: $d data change(s), $n notice(s)\n";
' prisma/migrations/20260905120000_class_room_archive_invariant/migration.sql
```

It prints **3 data changes and 1 notice** — measured 2026-09-05. Pairing each
write with its own notice needs a plpgsql-aware statement splitter, a larger
design than this rule, and is deliberately not built.

The same census without vitest — and it strips comments on both sides, because
a command that did not would disagree with the rule in both directions. It is a
close approximation and not the rule itself: it does not subtract
`CREATE OR REPLACE FUNCTION` bodies, so a migration whose only notice sits in a
trigger body would be exempted here and reported by
`untracedDataChanges`. No migration in the tree has that shape today — the one
real notice sits in a `DO $$` block, which both read alike:

```sh
perl -0777 -ne '
  my $s = $_; $s =~ s{/\*.*?\*/}{ }gs; $s =~ s{--[^\n]*}{}g;
  print "$ARGV\n"
    if $s =~ /\bUPDATE\s*(?:ONLY\s+)?"|\bDELETE\s+FROM\s*(?:ONLY\s+)?"/i
    && $s !~ /\bRAISE\s+NOTICE\b/i
    && $_ !~ /^[ \t]*--[ \t]*DML WITHOUT NOTICE:[ \t]*\S/m;
' prisma/migrations/*/migration.sql
```

Unbounded like this it prints 7 migrations today, `20260827120000` among them,
and every one of them sorts before the cutoff — which is the condition the
sweep is green on. Delete the two `s{…}` lines so both tests read the raw file
and it prints 8, wrong in both directions at once: it gains
`20260826182710_entry_completion_marker_guard` and
`20260826200000_entry_marker_exclusivity`, which only *discuss* an `UPDATE`,
and it loses `20260825065109_schedule_rule_backfill`, exempted by a comment
that merely names `RAISE NOTICE` while the migration raises none. Flip
`!~ /\bRAISE\s+NOTICE\b/i` to `=~` on the stripped text and it lists the
migrations that carry a data change AND announce it — a migration with a notice
and no data change never reaches that test: one,
`20260905120000_class_room_archive_invariant` (#339), which landed the day this
entry was written and is the first this tree has ever had.

**The four SLOT partial unique indexes of `20260811202634` are all gone too.**
That migration declared six; the other two are the `Room` identity pair.
`ClassTemplate_teacher_slot_unique` and
`StudioClassTemplate_teacher_slot_unique` folded into
`ScheduleRule_teacher_slot_excl` at #298; `Class_teacher_slot_unique` and
`StudioClass_teacher_slot_unique` folded into
`CalendarEntry_teacher_slot_excl` at #327. Each layer's within-family and
cross-family exclusivity is now ONE constraint rather than two mechanisms
layered on each other, which is what removed the residual race this section
used to price — an unlocked cross-table `SELECT` cannot see an uncommitted
sibling insert, and there is no longer an unlocked cross-table `SELECT`.
Two transactions writing opposite families at one slot were measured
committing in **200 of 200** forced-overlap runs under the trigger design; the
constraint that replaced it cannot produce that outcome at all, because the
second writer waits on the first's index entry rather than reading past it.

### What keeps the realistic path away from the constraint

The generator pre-checks — one function for both families since #284
(`generateEntriesForRule`, `services/entry-generation.ts`), and there is ONE
entry table, so the pre-check reads it directly rather than reaching across to
a sibling — and declines the date as `blocked_by_overlap` rather than letting
`CalendarEntry_teacher_slot_excl` refuse the insert. Behind
them, **ten write endpoints across eight route files** answer 409, in two
groups that answer differently because the two layers can say different things:

| Layer | How it reaches the 409 | Endpoints |
|---|---|---|
| entry, `CalendarEntry_teacher_slot_excl` | `probeConflictingEntry` for WHICH entry, once a write is refused — four call sites, `grep -rn "probeConflictingEntry(" src/services/ src/app/api/` | `POST /api/classes`, `POST /api/studio-classes`: a zero-row `skipDuplicates` outcome (issue 331); `PUT /api/studio-classes/[id]`: a `catch` on `isExclusionConflictOn(err, 'CalendarEntry_teacher_slot_excl')`; `PUT /api/classes/[id]`: its service returns `slot_conflict` and the route runs the same probe — four, `grep -rn 'entryConflictMessage(conflict' src/app/api/` |
| rule, `ScheduleRule_teacher_slot_excl` | `SLOT_TAKEN[heldBy]`, keyed on `ruleSlotHolder`'s `RuleSlotHolder` — four call sites, `grep -rn "ruleSlotHolder(" src/services/ src/app/api/` | `POST /api/class-templates`, `POST /api/studio-class-templates`, `PUT /api/class-templates/[id]`, `PUT /api/studio-class-templates/[id]`, `PATCH /api/class-templates/[id]?state=unarchived`, `PATCH /api/studio-class-templates/[id]?state=unarchived` — six, `grep -rn 'SLOT_TAKEN\[result.heldBy\]' src/` |

Four ENDPOINTS and six — the ten above, split by layer, and the third column is
where they are named. The middle column counts call sites instead, which need
not agree: the rule layer's edit and unarchive probes sit in `rule-lifecycle.ts`,
generic over the child and so serving both template families from one line each.
An earlier version of this paragraph said "all eight routes …
five catch, three return", counting FILES on one side of the sentence and
ENDPOINTS on the other, and so undercounted the reason-based side by the two
`PATCH` unarchive arms. It closed by saying "named rather than counted", which
is the right instinct and was defeated by naming an incomplete set — so the
table above is the naming, and each row ships the grep that re-derives its call
sites. Each row's ENDPOINTS are re-derivable too, on the line every endpoint in
that row runs to build its 409 — the rule row's slot-taken lookup, the entry
row's message call — so both third columns ship that command beside the names.
The entry row's is scoped to `src/app/api/`, where its endpoints live, because
the same call appears in a test file as well.

**The two layers name different things, and that is a deliberate asymmetry.**
The rule layer can only say which FAMILY holds the weekday slot, because a
recurring rule has no single date to point at, and `'unknown'` is a real third
answer there — the holder can be archived between the refusal and the read.
The entry layer names the holder itself: family, start time and date, because
a range overlap need share neither a start time nor, across midnight, a date,
so "you already have something at that time" would describe a clash the teacher
cannot find. `src/lib/entry-conflict.ts` carries that argument; `heldBy` falls
out of the same row as a projection.

**The `CROSS_FAMILY_` grep no longer measures this.**
`grep -rn "CROSS_FAMILY_" src/app/api/` returned 12 before #298, 11 after, and
returns **6** now (re-measured 2026-08-26, excluding tests): four in the
template routes' `SLOT_TAKEN` maps, and two in the dead `YG001` arms the
section above describes. The entry layer dropped out of it entirely — with both
families in one table, a refusal there is `DUPLICATE_CLASS_SLOT` or
`DUPLICATE_STUDIO_SLOT` named for the ASKING surface, and the family of the
holder rides in the message rather than in the code.

That is the same division of labour `countRoomDeleteBlockers` has with the
RESTRICT trigger one section up: the constraint is the backstop, the pre-check
is what means it almost never fires.

### How the pre-check must be tested, and the mutation that lied

Removing the pre-check no longer makes the batch insert fail at all, and that
is a change worth stating plainly: since #327 the entry insert is
`createManyAndReturn` with `skipDuplicates: true` — a bare
`ON CONFLICT DO NOTHING`, no conflict target, which covers an exclusion
constraint as well as a unique key. A date the pre-check would have declined is
simply not returned, so it falls into the `'raced'` arm instead of
`blocked_by_overlap`. The mutation therefore shows up as the REASON moving, not
as a throw and not as `created` moving, and the suite asserts the reason for
exactly that purpose.

**That is not what this section said first, twice over, and both ways of being
wrong are worth keeping.**

The first was #296's own: it shipped a `catch` around `createManyAndReturn`
that retried per date, and the mutation was recorded as *masked* — the trigger
fires, the fallback retries, the date is reclassified `'raced'`,
`result.created` does not move. Every word of that was observed, in the **unit
tests**, which call both generators with a bare `PrismaClient`, where each
statement is its own transaction and a retry after an abort is perfectly legal.
Every PRODUCTION caller passes a transaction client (both sweeps, both POST
routes, both pause/resume services), Prisma takes no savepoint per statement,
so `RAISE EXCEPTION` left the transaction aborted and the first retried
`create` returned `25P02` — costing the whole window, and turning a wordable
409 into a 500. The fallback was deleted in review.

The second was this document's, and it survived the trigger it described: a
paragraph here said the mutation makes the generator THROW, which was true
while a `RAISE EXCEPTION` aborted the statement and stopped being true when
`ON CONFLICT DO NOTHING` replaced it. (An earlier draft before that said
"`created` drops to 0 **and** the generator throws"; those were mutually
exclusive, and only the second happened.)

The lesson generalises past both: **a mutation is only evidence about the
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

    SELECT tpl."id" FROM "ClassTemplate" tpl
      JOIN "ScheduleRule" sr ON sr."id" = tpl."scheduleRuleId"
     WHERE tpl."id" = $1
       AND sr."isActive" = true
       AND sr."isArchived" = false
     FOR UPDATE OF tpl;

`"ClassTemplate"` is spliced from the family descriptor rather than written,
so this one statement is also the `StudioClassTemplate` one. `tpl` and not
`ct`, `sct` or `c`: the alias is the only part of that line a line-by-line
census can read, and `c` is `Class`'s — see "Ordering BETWEEN `Class` and its
`CalendarEntry`" above.

**Rejected: lock both rows.** That would add `ScheduleRule` as a second node
to an ordering this document has twice declined to extend for lesser reasons,
with a named AB-BA against `updateClassTemplate`, in a codebase that previously
carried a `ClassTemplate`-vs-`Class` ordering violation (since resolved
in #229). **Rejected: narrowing the
extraction.** The cross-family slot constraint's `WHERE isArchived = false`
needs that column on the rule, so keeping a copy of the lifecycle flags on the
child would restore the two-sources-of-truth drift this extraction exists to
remove.

Ten call sites hold the child row `FOR UPDATE` today, across eight
statements: `deleteTeacherAccount`'s bulk archive and the currency switch
(#758) each take one per family, the
two claim entry points share the one inside `claimRuleForGeneration`, the
two archive entry points share the one inside `archiveOrUnarchiveRule`,
the two pause entry points share the one inside `pauseOrResumeRule`, and
the two update entry points share the one inside `updateRule`:

| Site | File | Shape |
|---|---|---|
| `claimTemplateForGeneration` | statement in `entry-generation.ts`, family in `class-generator.ts` | joined predicate, `FOR UPDATE OF tpl`, table name spliced from `CLASS_GENERATOR.childTable` |
| `claimStudioTemplateForGeneration` | statement in `entry-generation.ts`, family in `studio-class-generator.ts` | joined predicate, `FOR UPDATE OF tpl`, table name spliced from `STUDIO_GENERATOR.childTable` |
| `updateClassTemplate` | statement in `rule-lifecycle.ts`, family in `class-template-lifecycle.ts` | single-id, plain `FOR UPDATE`, table name spliced from `CLASS_FAMILY.childTable` |
| `pauseOrResumeTemplate` | statement in `rule-lifecycle.ts`, family in `class-template-lifecycle.ts` | single-id, plain `FOR UPDATE`, table name spliced from `CLASS_FAMILY.childTable` |
| `archiveOrUnarchiveTemplate` | statement in `rule-lifecycle.ts`, family in `class-template-lifecycle.ts` | single-id, plain `FOR UPDATE`, table name spliced from `CLASS_FAMILY.childTable` |
| `updateStudioClassTemplate` | statement in `rule-lifecycle.ts`, family in `studio-class-template-lifecycle.ts` | single-id, plain `FOR UPDATE`, table name spliced from `STUDIO_FAMILY.childTable` |
| `pauseOrResumeStudioTemplate` | statement in `rule-lifecycle.ts`, family in `studio-class-template-lifecycle.ts` | single-id, plain `FOR UPDATE`, table name spliced from `STUDIO_FAMILY.childTable` |
| `archiveOrUnarchiveStudioTemplate` | statement in `rule-lifecycle.ts`, family in `studio-class-template-lifecycle.ts` | single-id, plain `FOR UPDATE`, table name spliced from `STUDIO_FAMILY.childTable` |
| `deleteTeacherAccount` (bulk archive) | `gdpr.ts` | ordered, `FOR UPDATE OF ct` **and** `FOR UPDATE OF sct` |
| `switchTeacherCurrency` (#758) | `currency-switch.ts` | ordered, `FOR UPDATE OF ct` **and** `FOR UPDATE OF sct` |

**This is a convention enforced by a grep and a test, not by the database** —
the same standing every other convention in this document has, and the same
one `lockClassRowsOrdered` has for `Class`. The grep is the two censuses one
and two sections up, re-run together; a new writer of a rule's lifecycle or
calendar columns that skips the child lock is invisible to both until it is
added to the table above. The test is the load-bearing half: every row in the
table above is independently proven necessary in
`class-generator-lock-order.test.ts`, `studio-class-generator.test.ts`,
`class-template-lifecycle-lock-order.test.ts`,
`studio-class-template-lifecycle-lock-order.test.ts`,
`gdpr-lock-order.test.ts` and, for the currency switch,
`currency-switch-lock-order.test.ts` — each site's lock was removed in isolation and the
specific case it protects was confirmed to redden, then restored (Task 3c
report, `.superpowers/sdd/`).

**The claim's own `FOR UPDATE OF tpl` is not, by itself, sufficient — and this
was measured, not assumed.** `FOR UPDATE OF tpl` locks only `tpl`, deliberately
(the "reject locking both rows" decision above), so when the claim's own
`SELECT` has to WAIT for that lock — because one of the nine sites above
already holds it — Postgres evaluates the join's `sr."isActive"`/
`sr."isArchived"` predicate against the snapshot the statement took when it
STARTED, before the wait. `EvalPlanQual`, Postgres's re-check on unblock,
re-verifies the columns of the LOCKED row (`tpl`) if that row changed; it does
not re-fetch `sr` on `tpl`'s account, because `sr` was never part of the lock
set. Measured directly, isolated from Prisma — two throwaway tables shaped
like the real ones, one session holding the child row and updating (but not
committing) the parent's flag, a second session's joined `FOR UPDATE OF`
blocking on the first and unblocking on its commit: the second session's join
predicate read the PRE-commit flag, six of six runs, unchanged even when the
first session also issued a real `UPDATE` on the child row itself to force
`EvalPlanQual`. So `rows.length === 1` in the claim's raw statement is a fast
path, not the verdict, whenever the statement actually waited. What closes it:
the family's own `readChildOrThrow` immediately after is a SEPARATE statement,
issued only once the lock is actually held, and a separate statement takes its
own fresh READ COMMITTED snapshot regardless of what the statement before it
waited on — so eligibility is re-checked against THAT read, not trusted from
the raw statement's `WHERE`. See `claimRuleForGeneration`'s own docblock
(`entry-generation.ts`) for the same argument at the call site.

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
`updateMany`. Pinned by `gdpr-lock-order.test.ts`, "waits for a concurrent claim to
release the child row before archiving the teacher templates"
(describe block `deleteTeacherAccount serialises against a claim in progress
(#315)`), mutation-proven the same way
as the other nine sites.

Not a new node on the canonical `Student → Class → WaitlistEntry → …` ordering above.
Since #229 `deleteTeacherAccount` takes `ClassTemplate` before `Class` —
consistent with every other site — so these child locks come after the
`Teacher` lock ("The `Teacher` row is the first lock (#758)") and ahead of
`lockClassRowsOrdered`.

## A CAS miss no re-read can classify answers `busy`, not a throw (issue 332)

`pauseOrResumeRule` (`rule-lifecycle.ts`, reached by `pauseOrResumeTemplate`
and `pauseOrResumeStudioTemplate`)
disambiguates a zero-count CAS with a plain re-read, and has a residual
branch for the case that re-read matches no classification: under READ
COMMITTED every statement takes its own snapshot, so a row that changed and
changed back between the CAS and the re-read reaches it. That branch returns
the internal `{ outcome: 'busy' }` and logs the observed row at `warn`; the
function's post-transaction switch is what maps that to the public
`{ ok: false, reason: 'busy' }`. `archiveOrUnarchiveRule`
(`rule-lifecycle.ts`) is the same shape one verb over and answers `busy`
directly: its re-read either finds the target state reached, which is a real
`unchanged`, or finds the transition reversed, which is this case. The
reasoning is here rather than in any of those comments because every
load-bearing part of it is a fact about a different module, and a comment
carrying it has no owner in the file that would falsify it.

**Why `busy` and not a throw.** The CAS matched zero rows, so the transaction
wrote nothing and rolls back clean — a lost race a retry wins, which is what
`busy` means at every other site that produces it. `PATCH
/api/class-templates/[id]` and `PATCH /api/studio-class-templates/[id]` render
it as a 503 telling the teacher nothing was changed and to wait a moment and
try again. A throw surfaces the same state as a 500 logged at `error` — the
paging level — for exactly the condition `classifyApiError`'s transient branch
(`src/lib/api-errors.ts`) exists to demote to a retryable 503.

**Why both families answer alike.** Structurally, since issue 336: there is
one branch, and both entry points reach it. Before that there were two, and
they disagreed for two issues — `aed305f8` gave the class branch `busy` for
#116 and the port to the studio branch never happened, so one interleaving
answered 503 in one family and 500 in the other; issue 332 ported the
behaviour and pinned it. One live pin covers the branch today — "the residual
CAS miss answers busy rather than throwing"
(`studio-class-template-lifecycle.test.ts`); the class family's equivalent was
retired when #272 closed the window that could stage it, and
`class-template-lifecycle-lock-order.test.ts` records that where its test stood.
Re-derive both halves:

```sh
git log -S'residual fourth state' --oneline -- src/services/class-template-lifecycle.test.ts
git log -S'residual CAS miss answers busy' --oneline -- src/services/studio-class-template-lifecycle.test.ts
```

A distinction only one family draws costs more than the distinction is worth;
that judgement is the same one the shared archive in `rule-lifecycle.ts` rests
on. Its own CAS-miss branch reaches the same answer from the same reasoning:
the winner applied the transition, a third request reversed it, and the
re-read sees the state this request asked to move away from.

**Why logged rather than silent.** `busy` covers two causes worth telling
apart in production — a lock wait that timed out (the function's `catch`,
which carries `err`) and this one, which carries the observed row instead. A
steady trickle here with no concurrent writer means the CAS predicate and the
classification beneath it have drifted apart.

## A diagnostic read inside an interactive transaction cannot be guarded (issue #242)

`.catch()` on a statement inside `db.$transaction(async (tx) => …)` does not
protect the transaction. Postgres aborts the whole transaction at the first
statement error, and Prisma issues no per-statement `SAVEPOINT`, so every
later statement raises `25P02 current transaction is aborted, commands ignored
until end of transaction block` until rollback. The guard swallows the cause
and the transaction dies anyway, one statement later, naming a failure nowhere
near the one that caused it.

Measured 2026-09-02 against `ethical_yoga_test` — a `SELECT 1/0` (`22012`)
caught with `.catch()`, followed by a valid read in the same transaction:

```
raw follow-up:   PrismaClientKnownRequestError P2010 — Raw query failed.
                 Code: `25P02`
model follow-up: PrismaClientUnknownRequestError — PostgresError
                 { code: "25P02", … }
control:         OK
```

`rule-lifecycle.test.ts`'s "swallows a failure from the shared delete" case
stages the same behaviour as a test fixture; re-derive it with:

```sh
git log -S'Every later statement raises' --oneline -- src/services/rule-lifecycle.test.ts
```

**Why the guard is worse than no guard.** `TRANSIENT_SQLSTATE_KIND` and
`TRANSIENT_PRISMA_CODE_KIND` (`src/lib/api-errors.ts`) list neither `25P02` nor
anything it arrives as, so `isTransientDbError` answers `false` for it while it
answers `true` for the `55P03` the guarded statement would have thrown.
`erasureFailure` (`src/app/api/account/route.ts`) reads that boolean: a
teacher whose erasure lost a lock race is told to wait a moment and press
Delete again (503 `ERASURE_BUSY`); with the guard in place the same teacher is
told that pressing Delete again will not help and to contact support (500
`ERASURE_FAILED`).

**So the fix for a diagnostic that must not fail its operation is placement,
not `.catch()`.** `deleteTeacherAccount` (`src/services/gdpr.ts`) collects the
class ids whose cancel CAS matched nothing, returns them from the transaction,
and reads their cause after the commit — where `db` is not `tx`, a failed read
costs only the field it fills, and `.catch()` means what it says. Declaring the
list inside the transaction callback and returning it rather than capturing it
in a variable declared outside the transaction callback is load-bearing: the
value then exists only if the transaction committed, so "logged a skip for an
erasure that rolled back" is not a state the function can reach.
`deleteStudentAccount` in the same file has the same shape for
`freedClassIds`.

A `.catch()` on the whole `$transaction(…)` promise is a different thing and is
fine — `acceptInvitation` and `unlinkTeacher` (`src/services/invitations.ts`)
both do it. So is one on a promise from a helper that queries the database
itself, outside any transaction it did not open — `deliverInvitation`'s own
`.catch()` on the async IIFE it starts (`src/services/invitations.ts`, since
#391 owns its rejection path internally rather than leaving it to each caller)
and `ownedInvitation` (`src/app/api/invitations/[id]/route.ts`) are this
shape. The rule is about a statement inside an interactive-transaction
callback.

This grep is a spot-check, not a proof: it matches `.catch(` syntax, not
every suppression shape a statement inside a transaction could take — a
`try`/`catch` wrapped around a `tx.` call, a two-argument `.then(v, err)`,
or `Promise.allSettled([tx.x()])` are the same poisoning risk and none of
them match. `grep -v "\.test\."` also filters lines, not paths, so a real
offender whose trailing comment happened to name a test file would drop out
silently. No `.catch()`-syntax site in `src/` breaks the rule today;
re-derive with:

```sh
grep -rn "\.catch(" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Every hit is either a real `.catch()` call site — on `db`/`prisma`, on a
`$transaction(…)` promise, on a promise from a helper querying outside any
transaction, or outside the database entirely — or a comment merely
mentioning `.catch()` with no call site, which the post-commit diagnostic in
`deleteTeacherAccount`'s comment is one instance of.

## Known conformance

- **`unlinkTeacher`** (`src/services/invitations.ts`) — `Class`/`WaitlistEntry`
  via `withdrawWaitingEntriesForTeacher` (must run first; its own docblock
  in `waitlist.ts` explains why — a deadlock question, not a preference),
  then `StudentPrivacy`, `TeacherStudent`, `Invitation`,
  `TeacherBlock`. `StudentPrivacy` before `TeacherStudent` is the canonical
  line's order, and #174 reproduced the reverse order deadlocking (see below).
- **`declineInvitation`** (`src/services/invitations.ts`) — `Invitation` then
  `TeacherBlock` (#522), the same direction `unlinkTeacher` takes and the one
  the canonical line names. Conformant by order, and separately safe by the
  empty-`update` quirk above: its block upsert is `update: {}`, which is what
  keeps it from deadlocking against `resolveInvitationOnLink`'s opposite
  order. The `Invitation and TeacherBlock` describe in
  `src/services/invitations-lock-order.test.ts` pins both halves, but only its
  first test drives this function — the second hand-rolls the decline side so
  it can vary the upsert payload, which is the thing under test there.
- **`declineByToken`** (`src/services/unsubscribe.ts`) — `Invitation` then
  `TeacherBlock`, through `declinePending`, the same helper and order
  `declineInvitation` takes.
- **`acceptInvitation`** (`src/services/invitations.ts`) — `TeacherStudent`
  then `Invitation`. Was the other way round until #174 task 7, and **the old
  order deadlocks against a real production writer**:
  `POST /api/registrations` writes the roster link and then reaches
  `Invitation` through `resolveInvitationOnLink`, so on a pair with no link
  yet both transactions `INSERT` the same `(teacherId, studentId)` key —
  and Postgres makes the second inserter wait on the first's uncommitted
  tuple, a wait that deadlocks exactly like a row lock. Reproduced against
  the real function and the route's real statement order, three runs per
  order: old `accept: REJECTED 40P01` 3/3, new no deadlock 3/3. #181 replaced
  the upsert both sides used with `linkTeacherStudent`'s `createMany`/`ON
  CONFLICT DO NOTHING`, and re-measured the same reproduction against it —
  the wait edge survives the statement change (see the quirk section above),
  so this order still has to hold.

  When the link ALREADY exists, `linkTeacherStudent`'s `INSERT ... ON
  CONFLICT DO NOTHING` finds the conflict already committed and returns
  without taking a lock on that row — the same already-safe case the old
  upsert's three-`SELECT` path covered, just by a different mechanism. That
  is why the reorder was made on principle before anyone had a reproduction,
  and why `src/services/invitations-lock-order.test.ts` also pins the write
  ORDER's effect directly, with a hand-rolled non-empty `TeacherStudent`
  write standing in for whichever statement shape sat at this call site.
  That file lived in `tests/integration/` until #174's four-specialist
  review moved it — it is a DB-invariant suite with no HTTP surface, and the
  `integration` project deliberately runs against dev.

  That insert is not the whole of the roster-link write: its
  `INSERT ... ON CONFLICT DO NOTHING` takes no lock on a committed
  conflict, but `linkTeacherStudent` follows it with
  `activateTeacherStudentLink`'s explicit `FOR UPDATE` of the same row. So
  `acceptInvitation` holds the `TeacherStudent` row lock from its roster-link
  write to commit on both branches — created or already linked — and the
  order above, `TeacherStudent` then `Invitation`, is a held lock on the
  already-linked branch too, not only on the inserting one. Why the lock is
  there: "The `TeacherStudent` row is the archive's gate (#265)" above.

  Two tests, not one, and the split is deliberate. The deadlock reproduction
  needs a handshake to widen a window one round trip wide; unforced it is a
  race, not a reproduction — with the reorder reverted and the handshake
  removed, 1 of 6 runs deadlocked. So the write ORDER is pinned separately
  and unconditionally by "takes
  TeacherStudent before Invitation, and accepts". An earlier version of this
  entry claimed no reproduction was possible at all; that was wrong, and
  wrong because it generalised from a counterparty whose roster-link write
  came first — which is not where the registration route puts it.
- **`archiveStudent`** (`src/services/student-archive.ts`, #265) —
  `TeacherStudent` via `lockTeacherStudentLink`, first statement of its
  transaction; then `Registration` and `Payment` read unlocked; then
  `Payment` written (the waive, a status-filtered `updateMany`, only when the
  teacher confirmed exactly the open set); then the `TeacherStudent` row it
  already holds. `TeacherStudent` before `Payment`, as the canonical line
  names. It never takes `Class`, `Invitation` or `TeacherBlock`. "The
  `TeacherStudent` row is the archive's gate (#265)" above has the race and
  the tests.
- **`reopenPayment`** (`src/services/payments.ts`, #265) — `Payment` read
  unlocked (to learn the pair), then `TeacherStudent` via
  `lockTeacherStudentLink`, then the `Payment` compare-and-swap, then the
  `TeacherStudent` un-archive when the link was archived. `TeacherStudent`
  before `Payment`; conformant. The only `Payment` writer in `payments.ts`
  that takes the link lock — the others take `Payment` alone.
- **`deleteStudentAccount`** (`src/services/gdpr.ts`) — `Student`, via
  `lockStudentForErasure` (#183; "The `Student` row is the erasure's gate"
  above), then `Class`, via a single ordered `SELECT … FOR UPDATE OF c` joined
  through `WaitlistEntry`, covering every class the student holds an entry in
  of **any** status, ahead of every row write (#174 task 5 hoisted it;
  #216/#182's review made it one statement). Then `Registration`,
  `StudentPrivacy`, `TeacherStudent`, `WaitlistEntry`, `Invitation`
  (anonymized in place, not deleted). Was already `StudentPrivacy` before
  `TeacherStudent`; not the outlier on that pair.

  **Any status, not `waiting` only, and that is a fix rather than caution**
  (#216/#182 whole-branch review). The `deleteMany` below has no status
  scope, so a lock set scoped to `waiting` is strictly smaller than the write
  set it is meant to gate. The two used to
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
  Since #183 the delete is also scoped to the classes the pre-lock returned,
  and after its closing update the erasure reads the subject's remaining
  entries, so a lock set that narrowed again would fail the erasure with
  `ErasureLockSetError` rather than delete outside it.

  **One statement, not a loop, and that is a correctness property rather than a
  speed one.** `lockClassRow` is two round trips, so a loop cost 2N of them and
  the transaction's `timeout` had to grow with N to pay for it — while nothing
  in production deletes a `WaitlistEntry` except this very transaction, making
  an all-status count monotone for the life of the account. Past the ceiling the
  erasure failed and the retry re-read the same count and failed identically: an
  account that could never be erased. (The count half of that argument is
  rebutted in `gdpr.ts`'s transaction-budget comment, #246:
  `min(5_000 + N × 2_000, 20_000)` is monotone non-decreasing in N and
  capped, so an all-status count could only ever grant MORE budget, never
  less.) The single statement makes the lock cost O(1) ROUND TRIPS — not
  O(1) waiting, which an earlier version of this
  sentence implied by saying "O(1) statements" and letting the budget be sized
  by the reorder loop's `waiting` count. `lock_timeout` is armed per lock
  acquisition, so one statement over N contended rows can still spend N × 2s
  (measured 2026-08-16: two rows, releases at 1.5s and 3.0s, one waiter at 2s,
  succeeded after 2.67s). #240 removed the sizing term for that reason; the
  budget is a flat `{ timeout: 20_000 }`. The single statement also closes
  the read-then-lock window, since the lock is taken BY the statement that
  chooses the rows.

  Pinned by "waits for a class row another transaction holds when the erased
  entry is %s" (`gdpr-lock-order.test.ts`), which resolves the erasure to the
  holder's own release flag — a causal assertion rather than a wall-clock
  threshold — and fails if the lock set narrows again: the narrowed erasure
  never asks for the held class, and rejects with `ErasureLockSetError`.

  It is the outlier on `WaitlistEntry`, though, and in **three** ways, not the
  one this entry used to name: it writes `Registration`, `StudentPrivacy` AND
  `TeacherStudent` all before `WaitlistEntry`, where the canonical line puts
  `WaitlistEntry` before all three. The whole-branch review of #174 added the
  two that were missing here.

  What protects all three is "`Class` is the real gate" above, over the
  classes this function locked — and since #183 those are all the classes its
  `WaitlistEntry` writes can reach. The #174 whole-branch review reproduced the
  disagreement directly against the real functions, first with the entry
  inside the lock set:

  - **Inside the gate — no cycle.** Student already `waiting` in the class:
    a real `unlinkTeacher` racing this erasure did not deadlock (it failed
    instead with the unrelated `P2025` filed at the bottom of this document),
    and a real `deleteTeacherAccount` racing it completed cleanly. Both of
    those counterparties take the canonical direction (`WaitlistEntry` before
    `StudentPrivacy`/`TeacherStudent`), so they are the disagreement, and the
    shared `Class` lock is what makes it harmless.

  With the `waiting` entry appearing only after this function had read its
  set, the same two counterparties both deadlocked — `40P01 deadlock
  detected`, raised at `unlinkTeacher`'s `studentPrivacy.upsert` and at
  `deleteTeacherAccount`'s `studentPrivacy.deleteMany`. Two things close that
  window (#183):

  - **No join can put an entry outside the lock set.** This function takes
    the `Student` row before its pre-lock, and `addToWaitlist` — the only
    production creator of entries (the census under "Who is not gated yet")
    — takes the other half of that gate before its own class lock. An entry
    committed before the erasure's `Student` lock is in the pre-lock's
    snapshot; a join that arrives after it waits for the erasure to end, and
    is refused if the erasure committed.
  - **The erasure never requests the row lock of an entry whose class it does
    not hold.** Its `waitlistEntry.deleteMany` is scoped to the classes the
    pre-lock returned, and after its closing update a read of the subject's
    remaining entries refuses to commit if any exists
    (`ErasureLockSetError`) — which is what an ungated insert would leave.
    That request — made while holding its own
    `StudentPrivacy`/`TeacherStudent` row locks — was the wait edge both
    recorded `40P01` cycles needed
    (`docs/superpowers/specs/2026-09-16-waitlist-erasure-gate-design.md`;
    not re-reproduced).

  The `Registration` half stays open. Round 1 review of #174 task 7 could not
  construct a live counterparty — the one candidate disagreement,
  `promoteNext`'s conditional stale-head drop above, needs the erased student
  to hold both an active `Registration` and a `waiting` `WaitlistEntry` for
  the same class at once, a state `POST /api/registrations`'s own
  waitlist-resolution step actively prevents in the normal booking flow — but
  "no counterparty found" is not the same claim as "safe," and none is made
  here. Its `registration.updateMany` also reaches classes outside the lock
  set. A booking cannot race it there, because `POST /api/registrations` takes
  the other half of the `Student` gate (#625). A booking's registration is
  therefore either in the erasure's statement snapshots or refused.

  Status: the `WaitlistEntry` window is closed (#183); the `Registration` half
  stays open.
- **`deleteTeacherAccount`** (`src/services/gdpr.ts`) — `Class`, via an
  ordered `lockClassRowsOrdered` pre-lock over every class in
  `CANCELLABLE_STATUSES`. Not first in the transaction — the two template
  locks (#229, `ClassTemplate`/`StudioClassTemplate`) run before it — but
  first among `Class`/`CalendarEntry` locks, and the transaction's first read
  of any `Class` data at all (#367; the completion sweep that runs BEFORE the
  transaction opens is its own transaction, ordered against nothing here): the
  read that feeds the cancel loop is scoped to
  `where: { id: { in: lockedIds } }`, the ids this same pre-lock statement
  returned, not an independently-timed read. `orderBy: { id: 'asc' }` on that
  read is presentation only (notification order) — `lockedIds` is already
  ascending, so nothing about lock ORDER depends on it; see "Ordering WITHIN
  `Class`" for what it used to order and why it stopped. Then, per class,
  `WaitlistEntry` and the `Registration` read that chooses who gets the
  cancellation notice — under the same lock, not a separate eager-load (#174
  whole-branch review: a student registering after an eager-loaded read had
  their class cancelled and was never told; #367 additionally closed the
  unlocked interval such a registration could land in freely, by putting the
  pre-lock ahead of the read rather than after it — the blocking itself is
  the automatic `FOR KEY SHARE` lock the "fourth path" above documents,
  which is the pre-lock's own property and not something #367 introduced, so
  a test that observes the blocking cannot tell the two orders apart; only
  the statement order says which one this site is in). After the
  loop: `StudentPrivacy`, `TeacherStudent`, `Invitation`
  (deleted, not anonymized — the teacher is soft-deleted, not scrubbed like
  a student's identity is). Was already `StudentPrivacy` before
  `TeacherStudent`; not the outlier.
- **`transitionClass`** (`src/services/class-lifecycle.ts`) — `Class` via
  `lockClassRow`, then its CAS `class.updateMany` on the same row. It took the
  lock through the CAS alone until #327, which is the one thing about this site
  that used to be different from every other on this list; the extraction gave
  the CAS a conjunct on `CalendarEntry` and `EvalPlanQual` re-fetches only the
  locked row, so the second table's subplan kept a pre-wait snapshot and a
  cancel committing mid-transition was invisible. `lockClassRow` also carries
  the `setLockTimeout` this site used to issue itself, so its CAS still gets
  the bounded 2s `55P03` every `lockClassRow` site gets rather than Prisma's 5s
  `P2028`.
  When the CAS succeeds and the target is `in_progress`, it writes
  `WaitlistEntry` next, via `closeQueueOnStart` — `Class → WaitlistEntry`,
  conformant with the order above, and the whole write set is the two
  tables and nothing else: the refusal-diagnosis reads below the
  transaction decide nothing that gets persisted. The only production
  caller left since #216/#182 removed the sweep's is
  `POST /api/classes/[id]/transition`, which now does nothing but call it.
- **`POST /api/classes/[id]/cancel`** (#327) — `Class` then `CalendarEntry`
  via `lockClassRow`, then the CAS `calendarEntry.updateMany` that writes
  `cancelledAt` on a row this transaction already holds, then `Registration`
  (read only — who gets the notice), then `WaitlistEntry` (closed to
  `removed`), then `Notification` via `createBulkNotifications`. This is the
  transition route's cancel branch, moved to its own door when `cancelled` left
  `ClassStatus`, and the move is what gave it a deliberate lock: the old branch
  let its CAS `class.updateMany` take the `Class` row for free, and the CAS now
  writes the ENTRY, so the free lock would have landed on the wrong row. It
  reads `Registration` before writing `WaitlistEntry`, which the canonical line
  orders the other way — no edge either way, because a plain `findMany` takes
  no row lock; the WRITE order is `Class → CalendarEntry → WaitlistEntry →
  Notification`. The `relatedClassId` on those notifications takes
  `FOR KEY SHARE` on the class row this transaction is already holding
  `FOR UPDATE`, one class per transaction, exactly as the table above records.
- **`completeClass`** (`src/services/class-lifecycle.ts`) — `Class` via
  `lockClassRow`, then `WaitlistEntry` (via `closeQueueOnStart`, #216/#182 —
  only on the inline `open → in_progress` bump this function does when a
  teacher completes an `open` class directly; for a class already
  `in_progress` it writes none, because its queue closed on the way in),
  then `Registration`, `Payment`. `transitionClass`'s own
  docblock names this and `autoCancelClasses`
  as the two sites that read more state than a bare status under the
  decision, and take the lock instead of a plain CAS for that reason — the
  older of the two reasons to take it, which since #327 no longer
  distinguishes them from `transitionClass` itself. Since
  #216/#182 this is also where `autoCompleteClasses`' timing decision lives:
  `autoCompleteClasses` itself takes no lock of its own — its `sweepAt` (and
  the teacher route's `teacherAt`) is compared against `autoFinishAt`/
  `finishOpensAt` of the fresh, locked row's recomputed end (and, for
  `finishOpensAt`, start) inside this function, under the same
  `lockClassRow` that already guards the status re-read, rather than in a
  second lock the sweep would otherwise need to take.
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
- **`addToWaitlist`** (`src/services/waitlist.ts`) — `Student`
  (`lockLiveStudent`, #183), then `Class`, then `TeacherStudent`
  (`linkTeacherStudent`), then `TeacherBlock`/`Invitation` via
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
  `Student` (`lockLiveStudent`, #625), then `Class`, then `Registration`,
  `WaitlistEntry`, `TeacherStudent`, then `TeacherBlock`/`Invitation` via
  `resolveInvitationOnLink` — the same `TeacherBlock`-before-`Invitation`
  disagreement as `addToWaitlist`, not conformant on that sub-order for the
  same reason.
  **The walk-in path** (an `invitationId` or `newContact` body, #255) takes a
  different tail and never calls `resolveInvitationOnLink`: `Student` (an
  INSERT by `resolveWalkInStudent` on the create branch, then
  `lockLiveStudent`), then `Class`, then `Registration`, `WaitlistEntry`, then
  `completeWalkIn` (`src/services/walk-ins.ts`): `StudentPrivacy` (create
  branch only), `TeacherStudent` (`linkTeacherStudent`), `Invitation`, then
  `TeacherBlock` as a plain read, then the `walk_in_added` notification
  INSERT. `resolveWalkInStudent` also reads
  `Invitation` and `TeacherBlock` before its INSERT, both plain reads that
  take no row lock. From `StudentPrivacy` on, this conforms to the canonical
  line — `Invitation` before `TeacherBlock`, unlike the self-booking path
  above.
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
  survives on three mechanical facts: this sweep never writes a `Class` row and
  never writes a `CalendarEntry` row, so it takes no
  `CalendarEntry_teacher_slot_excl` index-entry lock and joins no slot-key wait
  chain; deleting a CHILD row takes no FK lock on the
  parent (only an `INSERT`/`UPDATE` of one takes `FOR KEY SHARE`), so its
  `deleteMany` adds no `Class` edge past the `lockClassRow` it took on purpose;
  and no production writer holds a `WaitlistEntry` row lock while requesting a
  `Class` lock, so there is no reverse edge to close a cycle against.

  **Against `deleteStudentAccount` specifically, the `Class` row lock is what
  removes the cycle — not the batch size.** The write sets do overlap: that
  function's `waitlistEntry.deleteMany` is keyed on `studentId` and the
  classes its pre-lock returned, with no class-status scope, so it deletes
  entries on terminal classes too, which is
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
  not have. What one class at a time actually buys is keeping this sweep out
  of the "sites lock more than one `Class` row" count under **Ordering WITHIN
  `Class`** — above, not below — and a bound on how long the sweep holds locks
  against live traffic. (That count has moved with #194 and #259; this
  bullet's argument did not.)

## Known safe by accident, not by order — not fixed here

**`resolveInvitationOnLink`** (`src/services/link-consent.ts`, called from
`addToWaitlist` and `POST /api/registrations`) takes `TeacherBlock` before
`Invitation` — the opposite of the `Invitation` then `TeacherBlock` the
canonical line names and `invitations.ts`'s block upserts take. Directly
tested twice, and the two measurements differ in what they drove. #174 task 7:
a transaction shaped like `resolveInvitationOnLink`'s order racing one shaped
like `unlinkTeacher`'s did **not** deadlock. #522: the real
`declineInvitation` racing the real `resolveInvitationOnLink` also did not —
and the same race **did** deadlock once the block upsert's payload carried a
real field, with the decline side hand-rolled for that one so the payload
could be varied (`src/services/invitations-lock-order.test.ts`; the booking
side is the real function in both). Both settle for the same
reason — those upserts are `update: {}` and hit the non-locking path described
above whenever a block already exists. This is not a "shared prior
`TeacherStudent` lock" protecting it — an earlier working hypothesis, now
shown wrong — it is the same upsert quirk on a different table. Not fixed, per
instruction: doing so would widen the original task past the two pairs it was
scoped to. If a future edit makes any of those `update` payloads non-empty,
this pair needs the same treatment `{Invitation, TeacherStudent}` and
`{StudentPrivacy, TeacherStudent}` already got.

#181 does not trip this trigger. It replaced `acceptInvitation`'s
`TeacherStudent` upsert with `linkTeacherStudent`'s `createMany`, a different
lock node from either member of this pair — `TeacherBlock` and `Invitation`
are untouched by that change, and neither upsert's `update` payload was
touched either. The `{TeacherBlock, Invitation}` order recorded here is
unaffected.

**Why the canonical line names `unlinkTeacher`'s direction, not
`resolveInvitationOnLink`'s.** Not by head-count, and counting is the wrong
instrument here twice over. Every site that disagrees reaches these two tables
through the same function — `addToWaitlist` and `POST /api/registrations` both
call `resolveInvitationOnLink` — so a tally of call sites counts one decision
as many. And a tally of functions moves whenever someone writes a new one —
#522 added `declineInvitation` to the conforming side — so a majority was
never what the line was resting on. What it rests on is which order was
reasoned about: `unlinkTeacher` is the one function in this codebase that
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

## Resolved: `{Class, ClassTemplate}` order standardised (#229)

`ClassTemplate` before `Class` is the canonical order. Every site that locks
both now takes them in that direction.

**History.** `deleteTeacherAccount` (`gdpr.ts`) was the sole site taking
`Class` before `ClassTemplate`. Five other sites — `claimTemplateForGeneration`
(`class-generator.ts`, calling `claimRuleForGeneration` in `entry-generation.ts`),
`pauseOrResumeTemplate`,
`archiveOrUnarchiveTemplate`, `POST /api/class-templates`, and
`updateClassTemplate` (`class-template-lifecycle.ts`) — took the opposite
order. No deadlock was ever reproduced between them, but the inversion was
documented and tracked.

**Resolution.** `deleteTeacherAccount`'s `ClassTemplate`/`StudioClassTemplate`
ordered locks were moved ahead of its `lockClassRowsOrdered` call, with an
explicit `setLockTimeout(tx)` before them. The transaction budget
(`{ timeout: 10_000 }`) is unchanged — the same bounded waits are present in
both orderings, just resequenced.

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

## The room mirror's foreign keys are wait edges (#272)

`ClassTemplate_teacherRoomId_roomArchived_fkey` and
`ClassTemplate_scheduleRuleId_kind_ruleLive_fkey` acquire locks no application
code asks for, and they are the mechanism, not a side effect:

- updating `TeacherRoom."isArchived"` must rewrite every `ClassTemplate` row
  that mirrors it, so it locks those rows (`TeacherRoom → ClassTemplate`)
- updating `ClassTemplate."teacherRoomId"` or `."roomArchived"` takes
  `KEY SHARE` on the referenced `TeacherRoom` row
  (`ClassTemplate → TeacherRoom`)

Measured: with a resume holding its transaction open, a concurrent archive
blocked on the child row and was refused with `23514` once the resume
committed — the same shape as the exclusion constraints above, with a row lock
in place of an index entry. Re-derive the constraint set with:

    SELECT conrelid::regclass AS "table", conname, pg_get_constraintdef(oid)
      FROM pg_constraint
     WHERE conname LIKE '%roomArchived%' OR conname LIKE '%ruleLive%'
        OR conname IN ('ClassTemplate_live_needs_open_room',
                       'TeacherRoom_id_isArchived_key',
                       'ScheduleRule_id_kind_live_key');

The two parent unique keys are in that list deliberately: neither mirror
foreign key can exist without the key it references, so a re-derivation that
returned only the children would report a complete set while missing what
holds it up.

The `TeacherRoom → ClassTemplate` edge makes an archive transaction hold the
room while it waits on a child — a backward edge against the generator's sweep
(`ClassTemplate` `FOR UPDATE`, then its `Class` insert's `KEY SHARE` on the
room), with a single room, was measured to deadlock (`40P01`, the archive
aborted). The archive route closes the cycle by taking the room's child rows
`FOR UPDATE` before the room row itself, so both wait in the same direction
(`setTeacherRoomArchived`). That pre-lock carries the shared `setLockTimeout`
bound like every other node here: the row it waits on is the one
`claimTemplateForGeneration` holds for a whole generation sweep, and Prisma's
transaction budget cannot cut short a statement already blocked inside
Postgres. Both properties are pinned from the archive's side in
`room-archive-lock-order.test.ts`, one case per property, each verified to fail
when its guard is removed. They live in their own file, and serially, because a
multi-second hold in a parallel tier is exactly the noise the `#180` case below
cannot tell from the defect it watches for. What remains is the two-room shape: two transactions
row-locking two rooms in opposite orders. That one is pre-existing and is not a
shape this migration introduces — the room-delete wait edge it rides on is
"The RESTRICT trigger is a wait edge, and a route guard is what closes it
(#103)" earlier in this file, which describes the edge but not this cycle.
Probe results for both shapes are in PR #340.

### The referencing side is indexed, and that was measured (#272)

`ClassTemplate_teacherRoomId_roomArchived_fkey` is a foreign key, and
PostgreSQL indexes a foreign key's REFERENCED side automatically and its
referencing side never. Paths that read that side (the cascade and the
RESTRICT check do so while holding the room row):

- the archive's pre-lock (`setTeacherRoomArchived`), inside the transaction
  that later takes the room row
- the `ON UPDATE CASCADE` that rewrites every mirroring child when a room's
  `isArchived` flips, in that same transaction
- the `ON DELETE RESTRICT` check behind `ROOM_DELETE_RESTRICT_FKS`
- `switchToSharedRoom`'s own step-1 pre-lock (`src/services/room-switch.ts`,
  issue 259), the same shape as the archive's pre-lock above, added after the
  measurement below and not part of it

Measured before adding the index rather than after, because the design asked
for a measurement rather than an index on principle (#272 design §7.3).
Scratch database built from the real migrations, median of 15 runs:

| rows | path | no index | with index |
|---|---|---|---|
| 10k | archive pre-lock | 3.40 ms | 2.98 ms |
| 10k | archive (FK cascade) | 3.51 ms | 2.86 ms |
| 10k | room-delete RESTRICT | 2.77 ms | 1.41 ms |
| 100k | archive pre-lock | 9.63 ms | 2.77 ms |
| 100k | archive (FK cascade) | 14.23 ms | 3.60 ms |
| 100k | room-delete RESTRICT | 14.21 ms | 1.82 ms |

The scan alone, which is the part that scales: `Seq Scan … actual time
4.925..4.949` against `Bitmap Heap Scan … 0.107..0.449` at 100k rows. Index
size 752 kB against a 13 MB table.

The case for it is the SLOPE and the LOCK HOLD, not the latency: without the
index the cost grows linearly with the table, and the cascade and the RESTRICT
check spend it while holding the room row against the generator. On a small table the
planner will still choose a sequential scan, which is correct — the index earns
its place as the table grows, not today. Re-derive with:

    EXPLAIN (ANALYZE, BUFFERS)
    SELECT ct."id" FROM "ClassTemplate" ct
     WHERE ct."teacherRoomId" = '<a room with children>' FOR UPDATE;

### Where a resume onto an archived room is refused (issue 336)

Three sites are involved in a resume, and only one of them enforces anything.
The enforcement is `ClassTemplate_live_needs_open_room`, `CHECK (NOT ("ruleLive"
AND "roomArchived"))` on `ClassTemplate`
(`20260827120000_template_room_archive_invariant`). It keys on the two mirror
columns, so it fires on the write itself and needs no second read — the
property the section above exists to explain.

`pauseOrResumeRule` (`rule-lifecycle.ts`) knows nothing about rooms. It is one
body over both template families and `TemplateFamily` carries no room field, so
it neither pre-checks nor catches: the CHECK's `23514` leaves its
`$transaction` as an ordinary throw, past a `catch` that returns `busy` only
for `isTransientDbError` and rethrows everything else. That is why the shared
function's docblock points here instead of arguing it.

`PATCH /api/class-templates/[id]` is what turns that into a sentence a teacher
can act on. Its pre-check runs only when `state === 'active'`, and only for a
row this teacher owns whose rule is not archived — both conditions load-bearing
and each a defect while it was missing: without the ownership conjunct the
probe is an existence oracle where the service answers 403, and without the
`isArchived` conjunct it outranks the `archived` refusal with advice
("unarchive the room") that would accomplish nothing for an archived template.
The route's `catch` on `isCheckViolationOn(e,
'ClassTemplate_live_needs_open_room')` covers the race between that read and
the write, and renders the same sentence.

The studio family has no such constraint and no such door.
`StudioClassTemplate` has no room, no `roomArchived` mirror, and `PATCH
/api/studio-class-templates/[id]` carries neither pre-check nor catch — a room
refusal cannot arise on that side at all.

The CHECK refuses more writes than a resume, and the three sites above are only
the ones a resume passes through. Its production refusal handlers — every place
in `src/` that catches this constraint by name and turns it into an answer —
re-derive as:

    grep -rn "isCheckViolationOn(.*'ClassTemplate_live_needs_open_room'" src/ \
      | grep -v '\.test\.ts'

which returns four lines in three files. Two are the class-template route's:
the resume catch described above, in `PATCH /api/class-templates/[id]`, and the
edit catch in the `PUT` on the same file, which covers a template moved onto an
archived room. The other two belong to different writes entirely, and are named
here so this section is not mistaken for a census of the constraint: `POST
/api/class-templates`, where a template is created live onto an archived room,
and `setTeacherRoomArchived` (`room-archive.ts`), where the room is the thing
being archived out from under a live template. Neither is a further door onto
a resume.

The unqualified `grep -rn 'ClassTemplate_live_needs_open_room' src/ prisma/`
answers a different question: it returns 24 lines across 13 files — the
two migrations, the schema comment, the tests, and the prose about all of it — which
is the constraint's whole footprint rather than the set of sites that refuse.

## Switching to a shared room (#259)

`switchToSharedRoom` (`room-switch.ts`) moves a teacher off a private
`TeacherRoom` P onto S, the teacher's link to the already-shared `Room` with
the same identity (created at step 3 if absent). The guards are
`docs/superpowers/specs/2026-09-26-switch-to-shared-room-design.md` §3.2; this
section is the lock order alone. One `$transaction`, `setLockTimeout` first:

| Step | What | Lock |
|---|---|---|
| 1 | Lock every `ClassTemplate` with `teacherRoomId = P` | `FOR UPDATE`, ascending `id` |
| 2 | Lock P, re-read it and its room, and run the guards against it; the two `Room` rows are read unlocked (spec §4.1) | `FOR UPDATE` on `TeacherRoom` P |
| 3 | S: insert if absent (`ON CONFLICT DO NOTHING`), then lock it; un-archive it if it was archived | `FOR UPDATE` on `TeacherRoom` S |
| 4 | Lock P's classes that are `draft`, `open` or `in_progress` and live (`entryLive`) | `lockClassRowsOrdered`, ascending `id` (`db-locks.ts`) |
| 5 | Move the locked classes onto S | already held (steps 3–4) |
| 6 | Move every template still on P onto S, by predicate rather than the step-1 id set | already held, for every template step 1 locked; a template moved onto P between steps 1 and 2 is locked here for the FIRST time, after P — see below |
| 7 | Archive P | `TeacherRoom` P (already held, step 2); its own cascade then locks every `Class` row still on P — the terminal ones step 4 excluded — for the FIRST time, also after P — see below |

Two edges here are not new shapes — each is an existing edge this file already
states, carried into a transaction that touches both a template family and a
class family at once:

- **`ClassTemplate` before `TeacherRoom` P (1 → 2)** is
  `setTeacherRoomArchived`'s own pre-lock order ("The room mirror's foreign
  keys are wait edges (#272)"), against the same generator hold and for
  the same reason: locking P before its templates would let the generator's
  `ClassTemplate FOR UPDATE` → `Class` `KEY SHARE` on P close a cycle against
  it.
- **`TeacherRoom` S before `Class` (3 → 4)** is the same order
  `POST /api/classes`'s `FOR KEY SHARE` pre-read uses ahead of its own insert
  ("`TeacherRoom → Class`: `switchToSharedRoom`'s step 5 writes it, and adds
  no wait edge"). Step 5 writes
  `Class.teacherRoomId`, and its foreign-key `KEY SHARE` on S is satisfied by
  the lock step 3 already holds, so it waits on nothing new.

The following shapes are accepted rather than closed, each narrower than the
two edges above — none of them is the general P-side order those edges
establish:

- **Un-archiving S (step 3) cascades onto S's own `Class` rows before step 4
  locks P's** — two ascending `Class` runs in one transaction, not one, so a
  teacher-wide multi-class locker taking its rows in a single ascending run
  (`withdrawWaitingEntriesForTeacher`, for example) can in principle
  interleave between them. The same shape `setTeacherRoomArchived(…,
  'unarchived')` already has on its own.
- **Un-archiving S also cascades onto S's own `ClassTemplate` rows, and does
  so AFTER the `TeacherRoom` S lock (step 3) — the reverse of
  `setTeacherRoomArchived`'s templates-then-link order.** A paused or
  archived template may legally sit on an archived room —
  `ClassTemplate_live_needs_open_room` only forbids a LIVE one on an archived
  room — so a reused S that is archived can hold templates for this cascade
  to reach. The precondition is narrow: `setTeacherRoomArchived`'s own
  `unchanged` early return reads `isArchived` before
  it ever opens a transaction, so a concurrent `setTeacherRoomArchived(S,
  'archived')` reaches its own pre-lock only if ITS pre-read already saw S
  live — which means a SECOND, distinct archive of S has to commit in the
  window between that pre-read and this transaction's own step 3, which is
  what sees S archived. Given that window, the two transactions take the same
  two locks in opposite orders — this one locks S then S's templates, the
  concurrent archive locks S's templates then S — which is exactly what
  Postgres's deadlock detector exists for: it ends in `40P01` on one side,
  with nothing half-applied on either. **Accepted**, on the same grounds as
  the `Class` cascade above.
- **Step 6 locks a template moved onto P between steps 1 and 2 for the first
  time, after P — the reverse of edge 1 → 2, for that one row.**
  `room-switch.ts`'s own step-6 comment names the case: a template that
  arrives on P after step 1's pre-lock has already run is caught by step 6's
  predicate rather than the step-1 id set, so step 1 never locked it, and this
  transaction takes it only after already holding P. A generator concurrently
  holding that same template `FOR UPDATE` (`claimTemplateForGeneration`) and
  then inserting a `Class` row on P (`KEY SHARE`) is the #272 counterparty:
  this transaction holds P and waits on the template, the generator holds the
  template and waits on P. **Accepted**, on the same grounds — it exists only
  for a template arriving on P inside this transaction's own step 1–2 window,
  never for a template step 1 already locked.
- **Step 7's archive cascades onto every `Class` row still referencing P, not
  only the ones step 4 locked.** Step 4's predicate excludes terminal
  (completed or cancelled) classes; step 7's `ON UPDATE CASCADE`
  (`Class_teacherRoomId_roomArchived_fkey`) carries no such filter, so it
  locks those terminal rows for the first time, after P — a second `Class`
  run in this transaction, outside the ascending order step 4 alone keeps.
  `withdrawWaitingEntriesForTeacher` (`waitlist.ts:1213-1217`) locks a
  teacher's classes with a waiting entry — `Class` rows only, with no status
  filter of its own — so it can hold one of those terminal rows while waiting
  on a class this transaction holds (a step-4 row, or a terminal row the
  cascade reached first), while this transaction's step-7 cascade waits on
  the row it holds. That is two `Class` runs out of order, the same shape as
  the S-cascade bullet above. **Accepted**: `40P01` on one side, nothing
  half-applied, the same as every other cycle this section records.
- **`setTeacherRoomArchived(S, 'archived')`, run after this transaction has
  already committed.** Its own pre-lock reaches the templates this
  transaction just moved onto S the ordinary way — they are simply S's
  templates now — but a generator concurrently holding one of THOSE
  templates `FOR UPDATE` and inserting a `Class` row that takes `KEY SHARE`
  on S is the ordinary #272 shape (the archive holds S waiting on the
  template, the generator holds the template waiting on S), not a new one
  this transaction introduces. **Accepted**, on #272's own grounds: `40P01`
  on one side if the archive gets there first; otherwise the generator's
  insert commits first and the archive's own CHECK answers `in_use`.

Re-derive the writes these edges and shapes are about with:

    grep -nE 'teacherRoom\.update\(|\.updateMany\(' src/services/room-switch.ts

which returns four lines, in step order:

- step 3's un-archive of S (`teacherRoom.update`, `isArchived: false`), whose
  cascades are the first two accepted-shape bullets;
- step 5's `Class` `updateMany`, covered by the "`TeacherRoom` S before
  `Class` (3 → 4)" edge;
- step 6's `ClassTemplate` `updateMany`, covered by the templates-before-P
  edge (1 → 2) for every template step 1 already locked, and by step 6's own
  accepted-shape bullet for one that arrives on P inside this transaction's
  own step 1–2 window;
- step 7's archive of P (`teacherRoom.update`, `isArchived: true`), whose
  cascade is the step-7 bullet.

The last bullet, an archive of S after this transaction commits, is a write
of `setTeacherRoomArchived`'s rather than of this file's.

Pinned by `room-switch-lock-order.test.ts`, one case per property — re-derive
the cases with `grep -n "^  it(" src/services/room-switch-lock-order.test.ts`:

- **Templates before the private link.** While the switch waits on one of
  P's templates, P is still free: a probe takes it under a short
  `lock_timeout`. Moving the step-1 pre-lock after step 2 makes that probe
  time out instead.
- **The moving set is read after the wait.** A class the generator inserted
  onto P while the switch waited on its template still moves. Not a
  lock-order probe — the step-1 pre-lock blocks on the held template in any
  order — but it pins that step 4 reads the set AFTER the wait.
- **Cancellation is re-checked on the locked row.** A class cancelled while
  the switch waits on its own row stays on P: `entryLive` is read on the row
  this transaction holds, not through a join evaluated before the wait — the
  same distinction the "`CalendarEntry → Class` is backward, and safe because
  every writer takes `Class` first" subsection draws for a different writer.
- **A generator that claims a template while the switch is parked generates
  onto S.** The switch holds P's templates, P and S and waits on one of P's
  classes; the generator's claim on a template blocks on the switch, and once
  the switch commits the generator re-reads the template and generates onto
  S. Moving the step-1 pre-lock to after step 4 turns this case into a
  `40P01` between the two.

## The class mirrors' foreign keys are wait edges (#339)

`Class_calendarEntryId_kind_entryLive_fkey` and
`Class_teacherRoomId_roomArchived_fkey` are the same mechanism as the
`ClassTemplate` pair above, one layer over — `Class_live_needs_open_room`
(`20260905120000_class_room_archive_invariant`) is #272's constraint applied
to `Class`, and its two mirror columns acquire the same uninvited locks:

- flipping `CalendarEntry."cancelledAt"` from null must rewrite the mirroring
  `Class` row's `entryLive`, so it locks that row (`CalendarEntry → Class`)
- updating `TeacherRoom."isArchived"` must rewrite every `Class` row that
  mirrors it, not only every `ClassTemplate` row, so it locks those rows too
  (`TeacherRoom → Class`, alongside `TeacherRoom → ClassTemplate`)

### `CalendarEntry → Class` is backward, and safe because every writer takes `Class` first

This edge runs the OPPOSITE direction from this repo's fixed order — `Class`
first, then its entry ("Ordering BETWEEN `Class` and its `CalendarEntry`"
above) — because the cascade fires from the entry side. A transaction that
writes `cancelledAt` therefore locks the `Class` row from INSIDE the statement
that holds its entry, which is exactly the shape an AB-BA cycle needs, unless
every such writer already owns the `Class` lock before it gets there — in
which case the cascade re-locks a row the transaction already holds and waits
on nothing.

That is the case for every regular-entry `cancelledAt` writer in `src/`:

| writer | `Class` lock | entry write |
|---|---|---|
| `POST /api/classes/[id]/cancel` | `:61` `lockClassRow` | `:72` |
| `autoCancelClasses` (`class-transitions.ts`) | `:410` `lockClassRow` | `:493` |
| `deleteTeacherAccount` erasure (`gdpr.ts`) | `:1120` `lockClassRowsOrdered` | `:1209` |
| `deleteTeacherAccount` studio cancel (`gdpr.ts:1292`) | — | `kind: 'studio'`; no `Class` child, so no counterpart lock is needed |
| `PUT /api/studio-classes/[id]` (`route.ts:192-198`) | — | `kind: 'studio'`; no `Class` child, so no counterpart lock is needed |

Re-derive the writer set with:

    grep -rn "cancelledAt: new Date()" --include="*.ts" src/ | grep -v '\.test\.'

which returns 7 lines. Three write `Registration.cancelledAt` — a different
column on a different table — at `api/registrations/[id]/route.ts`'s DELETE
handler (its late-cancel and full-cancel `updateMany` calls) and `gdpr.ts:529`.
`7 − 3 = 4`, the FIRST four rows of the table above — this
command cannot find the fifth. The subtraction has to be done by READING each
hit rather than by path alone: `gdpr.ts:529` writes a `Registration` while
*filtering* on `calendarEntry: { cancelledAt: null }`, so the needle appears
in a statement that mentions both columns and a path-only count would
misclassify it.

This command is scoped to the literal call shape `cancelledAt: new Date()` —
an unconditional cancel — because that is the shape every regular-entry writer
takes (a regular entry, once cancelled, can never be un-cancelled:
`entry_terminal_liveness_guard` below refuses the reverse write), and it
happens to also be `gdpr.ts:1292`'s studio shape. `PUT /api/studio-classes/[id]`
does not share it: a studio cancellation is reversible, so its write is a
ternary that can set `cancelledAt` to either `new Date(…)` or `null` in the
same statement, and the literal grep above does not match it — it is found
only by the wider

    grep -rn "cancelledAt:" --include="*.ts" src/ | grep -v '\.test\.' | grep -v "cancelledAt: null"

The row is added to the table above by reading, not by the narrower command,
the same way the `gdpr.ts:1292` studio row already was. Its safety argument is
identical to that row's: `kind: 'studio'`, no `Class` child, so the cascade
this section is about cannot fire from it regardless of direction.

The flip is one-way for this family, which bounds how many times the cascade
can fire: `entry_terminal_liveness_guard` (`entry_reject_terminal_liveness_change`,
`20260826140000_entry_guard_restorations`) refuses a change to `cancelledAt`
on a regular entry that is already terminal — cancelled or completed — so once
a regular entry's `cancelledAt` has flipped once, no writer, conforming or not,
can flip it again. The cascade into `Class.entryLive` therefore fires at most
once per class.

Pinned by `room-archive-lock-order.test.ts`, "CalendarEntry → Class cascade —
lock discipline (issue 339)": one case runs the canonical order (lock the
class, then write the entry) concurrently against a second writer wanting the
same class row, and asserts neither `40P01` nor `55P03` — meaningless on its
own, since it would also pass against a schema with no cascade at all. The
second case is the mutation as a test: a real `Class` row held open on a
second connection — the row alone, deliberately not through `lockClassRow`,
which would also lock the entry directly and give the backward writer a
second, direct lock to block on instead of the cascade this case exists to
pin — then a `cancelledAt` write that goes straight to the entry WITHOUT
taking the class lock first — the shape a fifth writer would have if it
skipped `lockClassRow`. Measured, not assumed: this blocks and then fails with
`55P03 canceling statement due to lock timeout`, not `40P01` — the holder here
only waits on an external release signal, never on anything the backward
writer holds, so there is no cycle for the deadlock detector to find. The
backward writer's own `setLockTimeout` is what ends the wait. Confirmed
sensitive to the mechanism itself, not just to the staging: with
`Class_calendarEntryId_kind_entryLive_fkey` dropped outright on a scratch
database, the same backward write resolves instead of rejecting — the
assertion reddens, because there is no longer anything on the `Class` row for
it to wait on.

### `TeacherRoom → Class`: `switchToSharedRoom`'s step 5 writes it, and adds no wait edge

The archive's write cascades into every `Class` row in the room as well as
every `ClassTemplate` row, so in principle a transaction holding a `Class` row
lock that then waited on `TeacherRoom` would be the counterparty — the same
shape #272 closed on the `ClassTemplate` side with the pre-lock in
`setTeacherRoomArchived`. `switchToSharedRoom`'s step 5 (`room-switch.ts`,
"Switching to a shared room") is a transaction that holds `Class` rows and
then touches this foreign key; it adds no wait, because the link the key
reaches is one it already holds (the second bullet below):

- An `UPDATE` on `Class` triggers no referential check at all unless it
  touches an FK column, because Postgres only fires an FK trigger for the
  columns a statement actually writes. `transitionClass` and `completeClass`
  (`class-lifecycle.ts`) both hold a `Class` row lock, and neither writes
  `teacherRoomId` or `roomArchived`: `transitionClass`'s CAS writes only
  `status`; `completeClass`'s terminal write additionally sets
  `effectiveTeacherRate`, `totalStudents` and `totalRevenue`. Neither set
  touches the room mirror, so neither takes a room lock despite the hold.
- `switchToSharedRoom`'s step 5 writes `Class.teacherRoomId`, unlike
  `transitionClass` and `completeClass` above. Writing it takes `KEY SHARE` on
  the shared link S via the same foreign key, on rows this transaction already
  holds `FOR UPDATE` from step 4. The `KEY SHARE` is not a new wait: step 3
  already holds S `FOR UPDATE`, ahead of step 4, so the write's own
  foreign-key check is satisfied by a lock this transaction took on itself
  earlier in the same transaction, not one it waits on now.
- Besides that one case, the only statement taking `KEY SHARE` on a room via
  this key is a `Class` **INSERT** (`api/classes/route.ts`,
  `class-generator.ts`), and an insert holds no prior lock on the row it is
  creating — nothing for the archive to wait behind. `api/classes/route.ts`
  reads the room with an explicit
  `SELECT "isArchived" FROM "TeacherRoom" … FOR KEY SHARE` ahead of that
  insert — the only explicit `FOR KEY SHARE` on `TeacherRoom` in `src/` — held for the
  length of the create transaction and, deliberately, with no
  `setLockTimeout` of its own (issue 228, the same bound the route's own
  comment already names for the create paths generally). It introduces no
  cycle: it takes the room lock FIRST and only inserts afterward, so it never
  waits on anything the archive or a room delete holds; `KEY SHARE` is
  self-compatible with the generator's own `KEY SHARE` on the same row; and
  the ordering is `TeacherRoom → Class` on every side, the same as everywhere
  else in this section.
- `gdpr.ts` never writes `TeacherRoom` at all —
  `grep -n "teacherRoom\.\|teacherRoom:" src/services/gdpr.ts` returns nothing.

The generator's insert does take `KEY SHARE` on the room while the archive
wants an exclusive lock on it, but the two already serialise earlier: both
take the room's `ClassTemplate` rows `FOR UPDATE` first, the same pre-lock
#272 added. Pinned by extending #272's own case rather than duplicating it —
`room-archive-lock-order.test.ts`, "has not taken the room row while it waits
on a child — the same order protects the Class cascade too (#339)". The
underlying property ("children before the room") is symmetric across both
cascades: it is about WHEN the room lock is taken, not about which children the
pre-lock explicitly names, so the existing single case covers both without a
second staging.

The mutation: removing the `if (archiving)` pre-lock block from
`room-archive.ts`. **Measured rather than assumed to be `40P01`, and it is
not.** This case stages one blocked archive against a statically held child on
a second connection — no second REAL transaction that is itself blocked on the
archive — so there is nothing for a genuine two-sided deadlock to form between.
With the pre-lock removed, `teacherRoom.update` takes the free room row
immediately and then blocks on its own cascade into the held child; the
probe's own `SET LOCAL lock_timeout = '500ms'; SELECT … FOR UPDATE` on the room
then times out too, because the room is no longer free — `55P03 canceling
statement due to lock timeout` on the probe, and the archive's own wait ends
the same way once its longer bound elapses. The genuine two-sided `40P01` this
edge would produce needs a second real actor independently blocked on the
archive — the generator, in production — which is exactly the shape measured
in "The room mirror's foreign keys are wait edges" above and detailed in PR
#340, not the shape this unit test stages.

### The referencing side is indexed, and that was measured (#339)

`Class` had no index on `teacherRoomId`. The referencing side of
`Class_teacherRoomId_roomArchived_fkey` is read by the `ON UPDATE CASCADE`
that rewrites every mirroring `Class` row when a room's `isArchived` flips,
and by the `ON DELETE RESTRICT` check behind `ROOM_DELETE_RESTRICT_FKS`; in the
archive and the delete, neither runs under a `Class` lock of its own
transaction. (#272 had a third path on the `ClassTemplate` side — the
archive's own explicit pre-lock — and the archive (`setTeacherRoomArchived`,
issue 339) has no counterpart on this side, because it takes no `Class` lock
of its own. `switchToSharedRoom` (issue 259) does take `Class` locks, at its
step 4, ahead of its own step-7 cascade — see "Switching to a shared room
(#259)" above.)

Measured before adding, the same way #272's design §7.3 asked for. Scratch
database (`ethical_yoga_scratch_339`) seeded with one target `TeacherRoom`
holding a handful of `Class` rows and a background `TeacherRoom` holding the
rest, so a scan of the whole table has to pass over almost every row before
reaching a match — the target rows are inserted last, at the physical tail of
the heap. Median of 15 runs, `EXPLAIN (ANALYZE, BUFFERS)`, each wrapped in
`BEGIN; … ROLLBACK;` so repeated runs never accumulate state:

| rows | path | no index | with index |
|---|---|---|---|
| 10k | archive (`ON UPDATE CASCADE`) | 2.075 ms | 0.743 ms |
| 10k | room-delete `RESTRICT` check | 1.440 ms | 0.058 ms |
| 100k | archive (`ON UPDATE CASCADE`) | 13.644 ms | 0.695 ms |
| 100k | room-delete `RESTRICT` check | 12.991 ms | 0.051 ms |

The "archive" row is the sum of the `Trigger for constraint
Class_teacherRoomId_roomArchived_fkey` lines `EXPLAIN ANALYZE` prints for the
`UPDATE "TeacherRoom" SET "isArchived" = true …` that fires the cascade — two
lines (one on `TeacherRoom`, one on `Class`) because the cascade both rewrites
the child row and re-validates its own foreign key against the parent it just
changed.

**The literal `EXPLAIN (ANALYZE, BUFFERS) DELETE FROM "TeacherRoom" WHERE …`
this issue's plan named cannot be run against a room WITH children, and that
was checked rather than assumed.** `ON DELETE RESTRICT` raises the foreign-key
violation from inside an `AFTER` trigger before `EXPLAIN` ever gets to print a
plan, so the statement returns only the error — verified directly: an
`EXPLAIN ANALYZE DELETE` against the measurement's own target room produced no
plan output at all, only `ERROR: update or delete on table "TeacherRoom"
violates foreign key constraint …`. The "room-delete RESTRICT check" row above
measures the query Postgres's own RI trigger issues internally instead —
`SELECT 1 FROM ONLY "Class" x WHERE x."teacherRoomId" = … AND x."roomArchived"
= false LIMIT 1 FOR KEY SHARE OF x` — the same substitution this document's
`#272` section already makes for the archive's own pre-lock (a representative
`SELECT`, not a literal call into the guarded function).

The scan alone, which is the part that scales: at 100k rows the no-index plan
is `Seq Scan on "Class" x … actual time=12.743..12.743 rows=1 … Rows Removed
by Filter: 99995` against `Index Scan using
"Class_teacherRoomId_roomArchived_idx" … actual time=0.018..0.018 rows=1`.
Index size 704 kB against a 14 MB table.

The case for it is the SLOPE, the same argument #272's own index made: without
it, both paths grow roughly linearly with the table (2.075 ms → 13.644 ms and
1.440 ms → 12.991 ms across a 10× row-count increase); with it, both stay flat
regardless of table size. Added as its own migration,
`20260905130000_index_class_room_fk`, whose comment carries this section's
location rather than the numbers, per the convention
`20260828120000_index_template_room_fk` set. Re-derive with:

    EXPLAIN (ANALYZE, BUFFERS)
    SELECT 1 FROM ONLY "Class" x
     WHERE x."teacherRoomId" = '<a room with children>' AND x."roomArchived" = false
     LIMIT 1 FOR KEY SHARE OF x;
