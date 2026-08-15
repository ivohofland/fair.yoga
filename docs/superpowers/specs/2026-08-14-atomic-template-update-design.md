# Atomic template update, and the lock cycle it widens

Issues 209, 83 and 180. `PUT /api/class-templates/[id]` commits the template
row, then propagates to its generated instances, then refills the window —
three separately-committed steps. When step 2 fails, the teacher gets a 409 for
a change that already landed, and nothing ever re-syncs the instances.

This branch makes all three steps one transaction. Doing so concentrates lock
waits that are today spread across three transactions, and lengthens the window
on a **reproduced** deadlock, so it also lands the ordered pre-lock that closes
that cycle.

Measured against the tree at `c57727a`.

## 1. What the issues claim, and what is actually true

| Claim | Verdict | Evidence |
|---|---|---|
| 83: `updateClassTemplate` and `syncTemplateInstances` both take `PrismaClient` | **True** | `class-template-lifecycle.ts:238`, `template-sync.ts:47` |
| 83: `generateInstancesForTemplate` already accepts the union — 84 removed that blocker | **True** | `class-generator.ts:117` |
| 83: three sequential non-atomic steps, not two | **True** | write `:286` → sync's inner `$transaction` `template-sync.ts:55` → refill `:139-142` |
| 83: a sync failure "propagates as a 500" | **Half false today** | Since 196 the two P2002 shapes map to 409 (`slot_conflict`, `sync_conflict`) and P2025 to 404. Only a refill/DB failure still reaches 500 |
| 209: template moves, instances do not, nothing re-syncs | **True**, and pinned as correct | `tests/integration/class-templates-api.test.ts:1127-1186` asserts the desync |
| 209: PR 208 fixed the copy, not the atomicity | **True** | `[id]/route.ts:100-106` |
| 209: the post-commit refill is load-bearing for 164, so one transaction collides with a documented decision | **STALE — this is the correction that matters** | See below |
| 180: the cheap fix (sorting the id array) is inert | **True**, and measured in that issue | Writes visit in plan order, never array order |
| 180: two `it.todo` markers need repointing | **Already done** | `gdpr.test.ts:1359-1364` already name 180; they now need *deleting* |

### 1.1 The expired blocker

Issue 209 says option 1 "collides with a documented design decision…
load-bearing for 164 (a `P2002` inside an interactive transaction aborts it;
Prisma exposes no savepoint)". That was true when 209 was filed. PR 204 retired
it.

`generateInstancesForTemplate` (`class-generator.ts:116-213`) today:

- has **no `catch`** — `class-generator.ts:110` says "Do not reintroduce a
  `catch` here; there is nothing it can do that the constraint does not";
- inserts with `createManyAndReturn({ skipDuplicates: true })`, which compiles
  to a **bare `ON CONFLICT DO NOTHING`** — no conflict target, so it covers
  `Class_teacher_slot_unique` too (`:84-88`);
- takes `PrismaClient | Prisma.TransactionClient` (`:117`), "so a route can
  create the template and its window atomically" (`:113-114`).

So the refill cannot abort a transaction it is composed into. Two comments go
further and name this exact branch as the intended consumer:

- `class-generator.ts:107` — "`syncTemplateInstances` (`template-sync.ts`) is
  the one that does not, and passes a bare `PrismaClient`."
- `template-sync.ts:136-138` — "documented as accepting a transaction client
  precisely so a caller can compose it — **which is what would close the seam
  described above, if that ever happens**."

### 1.2 The blocker that replaces it, which no issue names in this context

`docs/lock-order.md:286-345` records a **reproduced** `40P01`:

```
syncTemplateInstances : ok {"synced":1,"regenerated":1,"kept":0}
deleteStudentAccount  : REJECTED 40P01,deadlock detected
```

`syncTemplateInstances` and `archiveOrUnarchiveTemplate` take their `Class` row
locks in heap order; three other sites take them in ascending id order. Making
the seam atomic holds those heap-ordered locks alongside the template row lock
for longer. It does not create the cycle — it widens a live one. That is issue
180, which this branch therefore also closes.

### 1.3 Reachability is narrower than 209's title

`sync_conflict` is raised by the `sameDay` `updateMany` writing `startTime`
(`template-sync.ts:96-112`). A pure `dayOfWeek` change puts every mutable
instance in `wrongDay` — deleted, not updated — and the refill cannot raise
P2002 at all (§1.1). So today's desync is reachable via a **`startTime` change
with `dayOfWeek` unchanged**, not by a day change.

### 1.4 Why nothing re-syncs, which 209 asserts without a mechanism

The hourly generator cannot repair it. The stale instances still occupy their
dates, so `@@unique([templateId, date])` makes the refill report
`already_generated` and create nothing (`class-generator.ts:149-159`). Nothing
in `src/` updates or deletes them. They stand indefinitely.

### 1.5 Found while verifying, named by neither issue

`syncTemplateInstances`'s inner `$transaction` (`template-sync.ts:55-116`)
passes **no options**, so it runs on Prisma's 5 s default while every peer
template transaction budgets 10 s. Corroborated independently at
`docs/lock-order.md:319`. The lock-race branch that landed today fixed exactly
this for the two create routes and did not cover this one. It stops mattering
here only because the inner transaction disappears.

## 2. Design

### 2.1 One transaction

`updateClassTemplate` keeps its three guards — existence, ownership, room —
**outside** the transaction; they are reads that must not hold locks. It then
opens one `$transaction` containing the template write, the sync, and the
refill. `syncTemplateInstances` stops opening its own and takes the caller's
client.

The `catch` stays **outside** the `$transaction` call. That is what makes a
P2002 usable: it aborts the transaction, Prisma surfaces the failure from
`$transaction` itself rather than from the individual `await`, and we map it to
a reason once everything has already rolled back. `archiveOrUnarchiveTemplate:806-811`
already uses this shape and documents why.

```
updateClassTemplate(db, ...)
  ├ findUnique / ownership / room guards       (outside tx)
  └ db.$transaction(async (tx) => {
        setLockTimeout(tx)
        tx.classTemplate.update(...)
        syncTemplateInstances(tx, id)          // no inner tx
           ├ ordered SELECT ... FOR UPDATE OF c
           ├ re-read under the lock, filter mutable/kept
           ├ deleteMany wrong-day
           ├ updateMany same-day
           └ generateInstancesForTemplate(tx, template)
     }, { timeout: 15_000 })
  catch → not_found | slot_conflict | sync_conflict | busy
```

### 2.2 Signature changes: one widening and one narrowing

Issue 83 calls for "two signature widenings". That is half right.

- `syncTemplateInstances` will issue `SET LOCAL` and `FOR UPDATE`, so it takes
  **`TransactionClientOnly`** (`@/lib/db-locks:58`), not the plain union. The
  brand exists because `Prisma.TransactionClient` is `Omit<PrismaClient,
  ITXClientDenyList>` and `Omit` drops members only from the *type* — a bare
  `PrismaClient` stays structurally assignable and would make both statements
  evaporate silently (`db-locks.ts:106-127`). This is a **narrowing**.
- `updateClassTemplate` keeps `db: PrismaClient`. It opens the transaction; it
  is not composed into one. **No change.**

`db-locks.ts:17-52` carries a register of which helpers are branded and why,
explicitly maintained as complete. `syncTemplateInstances` gets an entry, and
the `skip` entry for `generateInstancesForTemplate` (`:44-52`) stays correct —
it still delegates its lock to the claim helper.

This lands as its own commit with no behaviour delta, per 83's sequencing.

### 2.3 The ordered pre-lock, at both sites

`docs/lock-order.md:313` rules out the cheap fix by name: sorting the id array
changes no lock order, because the write visits in plan order. The working fix
is a separate ordered statement, and `withdrawWaitingEntriesForTeacher`
(`waitlist.ts:902-923`) is the pattern already in this codebase:

```sql
SELECT c.id FROM "Class" c
WHERE ...
ORDER BY c.id
FOR UPDATE OF c
```

…followed by a **re-read through Prisma under the lock**. Both sites adopt it:

- **`syncTemplateInstances`** — lock the future-instance candidates
  (`templateId`, `teacherId`, `date > now`) in id order, then re-read and apply
  the existing mutable/kept filter under the lock.
- **`archiveOrUnarchiveTemplate`** — the same statement between its candidate
  read and its `deleteMany`.

One ordered statement costs **one** bounded wait, not N. That is why this is
affordable where `deleteStudentAccount`'s per-class `lockClassRow` loop is not
(`db-locks.ts:139-147`).

**A second defect this closes, unnamed by any issue.** Today the
`settingsLocked`/`status` filter (`template-sync.ts:71-73`) is decided from an
**unlocked** read. A registration landing between the read and the
`updateMany` lets the propagation rewrite a class it was supposed to keep — the
`kept` guarantee is advisory. Locking then re-reading makes it real. The
tripwire comment at `template-sync.ts:82-91`, which argues the `!settingsLocked`
filter is what keeps the `deleteMany` from destroying waitlist queues silently,
depends on this filter being sound; it is currently sound only under no
concurrency.

### 2.4 The arithmetic `lock-order.md:339` says is owed

Statements in the new combined transaction that can wait on a lock, at 2 s each
under `LOCK_TIMEOUT_SQL`:

| # | Statement | Waits on |
|---|---|---|
| 1 | `classTemplate.update` | `claimTemplateForGeneration`'s `FOR UPDATE` |
| 2 | ordered `FOR UPDATE OF c` | any `Class` row lock |
| 3 | `class.deleteMany` | `WaitlistEntry` cascade rows, not covered by 2 |
| 4 | `class.updateMany` | `Class_teacher_slot_unique` index-entry `ShareLock` |
| 5 | refill `createManyAndReturn` | the same wait edge |

`5 × 2 s = 10 s` worst case. The family's standard `{ timeout: 10_000 }` would
be **exactly** consumed by lock waits, leaving nothing for work, so this
transaction takes **`{ timeout: 15_000 }`** — 5 s of headroom.

**15 s is new for production, and the arithmetic is its only justification.**
An earlier draft of this spec claimed the value was "already used elsewhere in
this codebase", citing `class-generator.test.ts:357`. That is a `$transaction`
option, but in **test scaffolding** that holds a lock open to create
contention — not a production budget. Every production transaction in this
family budgets 10 s. Do not repeat the softer claim; it makes a derived number
look inherited.

**`archiveOrUnarchiveTemplate` keeps `{ timeout: 10_000 }`, and the pin at
`class-generator.test.ts:396` stands untouched.** An earlier draft moved it to
15 s on the reasoning that a pre-lock takes it from 3 waiting statements to 4.
That reasoning is wrong, and the error is worth recording because it inverts the
conclusion.

Its ten statements, classified by reading the transaction rather than inheriting
`lock-order.md:336-338`'s count — which is **correct as written**:

| Statement | Waits? |
|---|---|
| `setLockTimeout:824` | no |
| `classTemplate.updateMany` CAS `:866` | **yes** — against `claimTemplateForGeneration`'s `FOR UPDATE` |
| `classTemplate.findUnique:897`, `findUniqueOrThrow:914` | no — MVCC reads |
| `waitlistEntry.findMany:961` | no — read |
| `class.deleteMany:986` | **yes** — `Class` rows, plus the `WaitlistEntry` cascade |
| `class.findMany:1007` survivors | no — read |
| `createBulkNotifications:1031` | **yes** — FK `FOR KEY SHARE` on survivor classes |
| `class.count:1041` | no — read |
| `classTemplate.update:1058` | no — row already held `FOR NO KEY UPDATE` by the CAS |

A pre-lock covering **every class the transaction touches** — the deletable ones
*and* the survivors the notifications reference — makes rows 2 and 3 stop
waiting on those rows, because the transaction already holds them. The
`deleteMany` can then wait only on cascade children; the notification inserts
cannot wait at all. The pre-lock **substitutes for** later waits rather than
adding to them, so the realistic bound stays near `3 × 2 = 6 s`.

This asymmetry does not rescue the update path, and the reason is the point:
its statements 4 and 5 wait on an index-entry `ShareLock` — another
transaction's uncommitted entry, not a row any pre-lock could hold. Those two
waits are irreducible, so `5 × 2 s` stands there.

**Load-bearing consequence for the plan:** the pre-lock's row set at the archive
must include the survivors, not only the classes about to be deleted. Narrow it
to the deletable set and the notification inserts start waiting again, and this
arithmetic no longer holds.

### 2.4.1 The archive pre-lock collides with a documented decision

Found while writing the plan, not while writing §2.3. `class-template-lifecycle.ts:955-960`
argues **against** the thing §2.3 requires:

> "Locking every candidate class would work and is simply worse — it blocks
> booking on every future class of the template for the duration of the
> archive, to buy what a second read buys for free."

That is exactly the pre-lock's row set. The collision is real and must be
resolved in the open rather than papered over.

**Why the pre-lock's set has to be the full candidate set.** For deadlock
safety it must cover every `Class` row the transaction *could* lock, in
ascending order. The `deleteMany` predicate is re-evaluated at execution time —
that is the point of `:976-985`, and it must not be changed — so **any**
candidate may match. The safe set is therefore
`scheduledWhere(templateId, { gt: today })` in full:

```
{ templateId, date: { gt: today }, status: { in: ['draft', 'open'] } }
```

(`scheduledWhere:516-520`, `SCHEDULED_STATUSES:503`.)

**Why the comment is not wrong, and is rewritten rather than deleted.** It
weighs a lock against a second read for **notification correctness**, and for
that purpose the read genuinely is free and better. The pre-lock buys something
a read cannot buy at any price: a canonical lock order. The comment's trade-off
predates the requirement rather than contradicting it.

**The cost it names is real, and this branch pays it.** After this change an
archive blocks booking (`POST /api/registrations` takes `SELECT … FOR UPDATE`
on the class row) on every future class of that template for the archive's
duration — bounded by `LOCK_TIMEOUT_SQL` per wait and the 10 s transaction
budget, not unbounded. That is the price of closing 180 at this site, and it
belongs in the PR body rather than in a comment nobody reads.

**This subsumes §2.4's survivor requirement** rather than adding to it: the
candidate set is `deletable ∪ waiter-held`, so survivors are inside it by
construction. The plan does not need a separate instruction to include them —
it needs the predicate above, unnarrowed.

**Rows 4 and 5, measured rather than assumed: `lock_timeout` DOES bound the
index-entry `ShareLock` wait.** Probed non-interactively (two concurrent
Prisma interactive transactions standing in for the brief's two `psql`
sessions, same shape as `src/services/invitations-lock-order.test.ts`'s
established two-`$transaction` races) against `DATABASE_URL_TEST`
(`ethical_yoga_test`) — already migrated through
`20260811202634_teacher_slot_unique_indexes`, so the collision lands on the
real `Class_teacher_slot_unique` partial index rows 4 and 5 name, not a
same-shaped stand-in. Full script, transcript, and cleanup verification are in
`.superpowers/sdd/2026-08-14-atomic-template-update/task-0-report.md`
(script itself is scratch, not committed).

Session A opened a transaction, `INSERT`ed a `Class` row keyed on
`(teacherId, date, startTime)`, and held it open uncommitted for 6 s before
rolling back. Session B opened a transaction, ran `SET LOCAL lock_timeout =
'2s'`, then attempted to `INSERT` a *different* `Class` row on the same key.
Measured three runs, fresh throwaway teacher/room fixtures each time:

```
run 1: B settled after 2108ms — PrismaClientKnownRequestError P2010,
       SQLSTATE 55P03, "canceling statement due to lock timeout"
run 2: B settled after 2049ms — same SQLSTATE, same message
run 3: B settled after 2086ms — same SQLSTATE, same message
```

All three runs: B fails at ~2 s, well inside A's 6 s hold — bounded by
`lock_timeout`, not by however long A happened to keep the transaction open.
The assumption holds: rows 4 and 5's `2 s` each in the `5 × 2 s = 10 s`
arithmetic above is a real, measured bound. The `{ timeout: 15_000 }` budget
stands.

### 2.5 The `{Class, ClassTemplate}` order stays parked

`docs/lock-order.md` holds **two** separate template entries, routinely
conflated:

- *"The two that do not"* (`:286`) — the reproduced `Class`-ordering cycle.
  §2.3 closes it. This is issue 180.
- *"Known violation, not fixed here"* (`:785`) — `deleteTeacherAccount` takes
  `Class → ClassTemplate`; the template family takes the opposite order.

**Re-counted, because that entry warns its own numbers were inherited and never
verified.** The inherited phrasing — "the generator and three template paths" —
**holds**. Sites taking `ClassTemplate` before `Class` in one transaction:

1. `claimTemplateForGeneration` + refill, inside `generateClassInstances`
   (`class-generator.ts:366`) — the generator the sentence names separately
2. `pauseOrResumeTemplate` (`class-template-lifecycle.ts:566`)
3. `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts:811`)
4. `POST /api/class-templates` (`route.ts:65`)

That is `1 generator + 3 template paths = 4`. This branch adds
`updateClassTemplate` as the **fifth** site, `1 + 4`. Exactly one site takes the
inverse: `deleteTeacherAccount` (`gdpr.ts:743`), `class.updateMany:799` before
`classTemplate.updateMany:901`.

Deferred, not resolved. Resolving it means re-ordering a GDPR erasure path that
carries its own timeout arithmetic, and 180's acceptance criterion 4 permits
"explicitly deferred with a reason". Because 180 is the item's only tracker home
and closes here, the deferral is **filed as a decision issue** at the end of
this branch, and `lock-order.md`'s "Known violation" section is pointed at it.

## 3. What the teacher sees

### 3.1 `sync_conflict` copy: a third message, not a revert

An earlier draft called this "a revert of a correction that was right". It is
not, and the difference matters for review. PR 208 made **two** changes to that
message and only one becomes false:

1. *"That change **would** move…"* → *"The recurring class **was updated,
   but**…"* — the state clause. **False after this branch**, because nothing
   commits.
2. Added *"Move or cancel that class, then edit this recurring class again."*
   The pre-208 copy named no remedy at all. **Still true, and still the point of
   208.**

So 208's actual contribution survives. The replacement for clause 1 follows a
convention this codebase already has: the `busy` copy at `[id]/route.ts:178`
and `:235` both end *"Nothing was changed. Wait a moment, then try again."*

> Your scheduled classes could not be moved — you already have a class at that
> time. Nothing was changed. Move or cancel that class, then edit this
> recurring class again.

That is a third message. It keeps 208's remedy, drops the now-false "was
updated", and does not reach back to the counterfactual "would" either.

The distinct code `TEMPLATE_SYNC_SLOT_CONFLICT` **stays**. Cause and remedy
still differ from `DUPLICATE_TEMPLATE_SLOT`: another *class* holds that date and
time, versus another *template* holds that weekday and time.

### 3.2 A new `busy` variant

`UpdateClassTemplateResult` gains `{ ok: false; reason: 'busy' }` → 503
`TEMPLATE_BUSY`, matching the four functions the lock-race branch gave one
today. Its copy must **not** collide with the pause/resume copy at
`[id]/route.ts:233` ("could not update this recurring class"); the PUT says
"could not save your changes to this recurring class."

The route's `never` exhaustiveness guard (`:110`) makes the new variant a
compile error until handled.

### 3.3 Docblocks that become false

Each asserts today's non-atomicity as deliberate, and each is rewritten, not
edited around:

- `class-template-lifecycle.ts:215-235` — two paragraphs, including "The write
  and the propagation are deliberately NOT one transaction" and the "That is not
  the only seam" paragraph
- `template-sync.ts:118-138` — the refill comment, whose closing sentence
  predicts this branch
- `class-generator.ts:104-110` — names `syncTemplateInstances` as the caller
  passing a bare client. That sentence supports a *different* claim in that
  docblock (why the roster says "in production"), so it is rewritten, not deleted
- `tests/integration/class-templates-api.test.ts:1118-1126` — the comment
  explaining why the test asserts a desync
- `docs/lock-order.md` — the within-`Class` table row for
  `syncTemplateInstances` (`:79`) and `archiveOrUnarchiveTemplate` (`:80`) move
  from "none" to ascending; the "live, unfixed, and partly branch-caused"
  section is **deleted, not narrowed** (180 acceptance 3)
- `src/services/gdpr.ts:378-391` — names both sites as locking in heap order
- `class-template-lifecycle.ts:955-960` — argues against locking every
  candidate class. Rewritten per §2.4.1 to say what the lock now buys that the
  second read cannot, and to keep the second read, which is still needed for
  notification correctness and is **not** replaced by the lock

## 4. Tests, and the mutation that proves each bites

| Guard | Mutation that must break it |
|---|---|
| Deadlock, new `src/services/template-lock-order.test.ts` | Revert the pre-lock → `40P01` returns. Must **first** be shown to fail against the unfixed code |
| Atomicity, integration | Existing test `class-templates-api.test.ts:1127-1186` **inverts**: it asserts `template.startTime === '11:18'` today and must assert unchanged |
| Lock-then-re-read | Latch `settingsLocked` between the lock and the write; the propagation must skip that class |
| Archive pre-lock | Its own cycle test — a fix at one site leaves the pairing live through the other (180) |
| `{ timeout: 15_000 }` on the **update** transaction only | Recorded options assertion, modelled on `class-generator.test.ts:396`. The archive's existing `10_000` pin must still pass unchanged — if it needs editing, §2.4's consolidation argument is wrong and the budget question reopens |
| The archive pre-lock uses the full `scheduledWhere` set | Narrow it by adding the `registrations: { none: … }` clause so it covers only deletable classes; the deadlock returns, because a candidate the `deleteMany` re-evaluates into scope was never locked (§2.4.1). **True, but not exercised by this table's baseline fixture — see the note below** |
| `lock_timeout` bounds the index-entry wait | `psql` transcript recorded in §2.4 |

**Correction, added after review round 1: the row above needs a fixture the
plan's baseline one cannot provide, and the claim itself is not weakened by
that.** `template-lock-order.test.ts`'s shared
`makeTemplateWithTwoWaitedInstances` fixture creates zero `Registration`
rows — only `WaitlistEntry` ones — so narrowing the pre-lock to
`registrations: { none: … }` coincides with the wide `scheduledWhere`
predicate on that fixture: both lock exactly the same two rows, and the
mutation as literally described above passes clean either way. That is a gap
in the fixture, not evidence the wide set is unnecessary. The working
negative control needs a charged `Registration` on the lower-id class at
pre-lock time — not yet a delete candidate under the narrow predicate —
cancelled from OUTSIDE the transaction during the candidate-read hook, via
`registration.updateMany({ where: { id }, data: { status: 'cancelled' } })`,
the same write `DELETE /api/registrations/[id]` makes and, like it, one that
takes no `Class` row lock. Under a pre-lock narrowed that way this reproduces
`40P01` at the `deleteMany`; under the wide, shipped pre-lock it produces
`{ ok: true, deleted: 2, remaining: 0 }`. Measured this way and independently
reproduced.

Both transcripts are inlined here rather than only cited, because this is the
sole evidence separating "the wide set is required" from "the wide set is
merely conservative" — the paragraph above establishes that the baseline
fixture cannot distinguish the two predicates at all, so a reference alone
would leave the branch's most-defended design decision resting on a file the
repo does not carry (`.superpowers/sdd/` is gitignored). §2.4 already inlines
task 0's three runs for the same reason; this closes the asymmetry.

With the pre-lock narrowed to `AND NOT EXISTS (SELECT 1 FROM "Registration" r
WHERE r."classId" = c.id AND r.status IN ('registered','attended','no_show',
'late_cancel'))`:

```
recurring class archive lost the template lock race :: PrismaClientUnknownRequestError:
Invalid `tx.class.deleteMany()` invocation in
.../src/services/class-template-lifecycle.ts
Error occurred during query execution:
ConnectorError(... PostgresError { code: "40P01", message: "deadlock detected", ... })
{"a":{"fulfilled":{"ok":false,"reason":"busy"}},"b":{}}
```

With the shipped, wide pre-lock:

```
{"a":{"fulfilled":{"ok":true,"action":"archived", ... "deleted":2,"remaining":0}},"b":{}}
```

The negative control was a throwaway `it` built on
`template-lock-order.test.ts`'s existing `makeTemplateWithTwoWaitedInstances`
fixture, run and then removed rather than committed — it depends on hooking
the archive's candidate read to land a write mid-transaction, which is a
mutation harness, not a regression guard. The wide row set is what ships.

**The trap 180 measured, which the plan must defeat.** A btree `ScalarArrayOp`
index scan visits in **ascending id order**. On a large enough table the
deadlock "disappears" with no code change, and the test goes green for that
reason. A pre-fix reproduction that does not fail proves nothing. 180 confirmed
the plan shape exists here by forcing `enable_seqscan=off`.

**The existing assertion shape is already specific enough.**
`src/services/invitations-lock-order.test.ts` asserts
`/40P01|deadlock/i` over `Promise.allSettled` rejections (`:281`, `:782`), and
pairs each with an absence-assertion after the fix (`:551`). That regex does not
match `55P03`, so a `lock_timeout` expiry fails it rather than satisfying it —
which is exactly what 180 asks for.

Both `it.todo` markers (`gdpr.test.ts:1359-1364`) are **deleted**, replaced by
the real tests. Their docblock says so: "Delete both when 180 lands."

## 5. Acceptance

**Issue 209** — a conflicting edit leaves template and instances consistent; a
test drives the edit and asserts agreement afterwards, not merely a 409.

**Issue 83** — the three steps commit or roll back together; the two signature
changes land as their own no-behaviour-delta commit first.

**Issue 180** — an ordered pre-lock at both sites; a test reproducing `40P01`
before the fix and passing after, asserting the SQLSTATE; the two `it.todo`
markers deleted; `lock-order.md`'s within-`Class` table updated and the
"live and unfixed" note deleted; the `{Class, ClassTemplate}` order explicitly
deferred with a reason.

## 6. Not in scope

- The `{Class, ClassTemplate}` order — deferred per §2.5, recorded, filed as a
  decision.
- Issue 104's five untimed inline `FOR UPDATE` sites.
- Issue 103 (room deletion versus the generator) — a different table pair.
- The `40P01` between two slot-swapping `updateClass` writes. 209 excludes it;
  174 already classifies it 503 and PR 208 regression-tested it.
- The studio family, for a stronger reason than "it is a separate table pair".
  `studio-class-template-lifecycle.ts` exports exactly two functions —
  `pauseOrResumeStudioTemplate:260` and `archiveOrUnarchiveStudioTemplate:612`.
  There is **no studio update or sync path at all**, so this seam has no studio
  twin to keep in step. (An earlier draft named a
  `syncStudioTemplateInstances`; no such function exists.) The studio archive
  does hold a multi-row `studioClass.deleteMany:758`, but on `StudioClass` —
  not the `Class` table whose ordering 180 is about.

## 7. Risks

1. **The `lock_timeout` assertion in §2.4.** If it does not bound index-entry
   waits, two of five statements are unbounded and 15 s is a guess. **Measured
   in task 0, not left as a probe-first risk** — §2.4's "Rows 4 and 5, measured
   rather than assumed" has the transcript: three runs, B settled at ~2 s each
   time via `55P03`, well inside A's 6 s hold. Full script and cleanup
   verification are in `task-0-report.md`. The `{ timeout: 15_000 }` budget
   rests on that measurement.
2. **A deadlock test that passes for the wrong reason** (§4). The pre-fix
   reproduction is the only artifact that can refute a fix-shaped no-op.
3. **An ordered pre-lock is necessary but not sufficient** (180). A `Class` row
   lock can also be taken by an FK `FOR KEY SHARE` from an uncommitted `INSERT`
   into a `Class` child — a route no grep for `Class` will show. This branch does
   not add such an insert; a future one at either site reopens the cycle.
   A second, narrower residual is already live at the archive's pre-lock
   (`class-template-lifecycle.ts`), not the sync's: `updateClass`
   (`class-lifecycle.ts`) writes `Class.date` through a bare
   `db.class.updateMany` that holds neither the `ClassTemplate` lock nor a
   `Class` lock this pre-lock takes. A same-day instance — outside the
   pre-lock's `date > today` predicate — rescheduled into the future between
   the pre-lock and the `deleteMany` (whose predicate is re-evaluated at
   execution time, by design) can still be matched and deleted without ever
   having been locked by the pre-lock. So the ascending-order guarantee at
   this site is not total, and the AB-BA against `deleteStudentAccount` can
   still form — narrow (it needs a concurrent reschedule of a same-day
   instance *and* an erasure of a student waitlisted across both classes,
   timed into the same gap) and no worse than the pre-branch state, which had
   no ordering at all. `syncTemplateInstances`'s pre-lock does not share this
   exposure: its write set is `id: { in: lockedIds }`, a structural subset of
   the ids the pre-lock itself returned, not a predicate argument
   re-evaluated later. Not fixed here — narrowing the `deleteMany` or
   widening the pre-lock past `date > today` are both ruled out: issues 86/112
   need the delete's live predicate re-evaluation regardless, and widening the
   pre-lock past `today` would lock history for no gain, since a past-dated
   row is never a delete candidate.
4. **Longer-held locks on an everyday action.** Editing a recurring class now
   holds the template row and its instances for up to 15 s under contention
   where it previously held three shorter transactions. The `busy` outcome makes
   that legible; it does not make it free.
5. **PR body must not use a closing keyword adjacent to a `#`-reference when
   describing what is *not* closed** — write "issue N is unaffected". PR 191
   closed issue 113 this way, and the commit written to document that closed it
   again.
