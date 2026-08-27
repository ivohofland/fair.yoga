# A plain INSERT against an exclusion constraint can deadlock — issue 331

**Date:** 2026-08-27 · **Issue:** 331 · **Depends on:** PR #333 (diagnostics and
the corrected `lock-order.md` paragraph)

## The defect

`POST /api/studio-class-templates`, two identical creates in flight, answers
`[201, 503]` where it should answer `[201, 409]`. Currently red on `main`.

The 503 is `40P01` — a deadlock between the two `INSERT`s into `ScheduleRule`,
raised `while checking exclusion constraint`. `40P01` is in
`TRANSIENT_SQLSTATES`, so `classifyApiError` answers 503, correctly for what it
was handed. The loser never reaches the branch that would answer 409.

Nothing is half-written: `40P01` aborts the whole transaction, and the
`toHaveLength(1)` assertions in the failing test are not what fails. This is
about **which answer the loser gets**.

## Two premises this spec falsifies, both mine

1. **"The loser exceeds `LOCK_TIMEOUT_SQL`'s 2s budget."** No.
   `deadlock_timeout` is 1s and fires first. The `55P03` path is real elsewhere
   — 54 lock-timeout cancellations in the same window — but is not this failure.
2. **"The deadlock is inherent to `EXCLUDE` constraints."** No. It is inherent
   to a **plain `INSERT`** against one. See the measurement below.

## Measured

Throwaway database, `btree_gist`, `excl (t int, span int4range)` with
`EXCLUDE USING gist (t WITH =, span WITH &&)`; `uniq (t, s)` with a unique
index. Three statements, fixed order, so these are orderings rather than races.

| Shape | Result |
|---|---|
| `excl`, plain `INSERT`: A `[10,20)`; B `[15,25)` blocks; A `[24,30)` | **`deadlock detected`**, `CONTEXT: while checking exclusion constraint on tuple (0,2)` |
| `uniq`, same shape: A `(1,1)`; B `(1,1)` blocks; A `(1,2)` | both of A's inserts complete; B `active`/`wait_event_type = Lock`, no entry of its own; succeeds on A's rollback |
| `excl` + `ON CONFLICT DO NOTHING`: A `[10,20)`; B `[15,25)`; A commits; B commits | A `INSERT 0 1`, B **`INSERT 0 0`**. One row. No deadlock, constraint upheld. |

**The mechanism is when the waiter's own entry exists.** A b-tree unique check
runs before it; an exclusion check runs after it, so both sides hold a tuple the
other's check will find. `ON CONFLICT DO NOTHING` uses speculative insertion and
**withdraws** its tuple while waiting — restoring the asymmetry, on the same
exclusion constraint.

Re-derive the production instance with
`docker logs fairyoga-db-1 --since 45m 2>&1 | grep -A 12 'deadlock detected'`.

## Decision: let the database refuse, and read the count (option 4)

`INSERT 0 0` is exactly the signal a 409 needs — a create that inserts zero rows
*is* "that slot is taken". Prisma's `createManyAndReturn({ skipDuplicates: true })`
returns those rows, so the endpoint answers deterministically whatever the
interleaving.

**Rejected, with reasons:**

- **An advisory slot lock.** Correct, and the fallback if the restructure below
  fights the nested-write shape. Rejected because `docs/lock-order.md` records
  `lockAnnouncementSlot` as the only advisory lock in this project and names a
  second holder as the thing that inverts order silently; because that lock's
  hold is measured as unbounded (13,516 ms and 12,013 ms under a "5000 ms"
  Prisma timeout); and because option 4 adds no node to the lock graph at all.
- **Retry the `40P01`.** This is the Bundle 7 retry-at-the-API-contract
  question and stays decision-gated.
- **Map `40P01` to 409.** A deadlock is not proof the slot was taken.

## Scope

**The generators need no change and must not be touched.** `class-generator.ts:523`
and `studio-class-generator.ts:325` already use `createManyAndReturn` with
`skipDuplicates: true` — a bare `ON CONFLICT DO NOTHING`, no conflict target, so
it covers the exclusion constraint. They are already on the deadlock-free path;
`api/class-templates/route.ts`'s own comment says the first half of this and
does not know the second.

**In scope — the four plain inserts.** Re-derive with
`grep -rn 'calendarEntry.create\|scheduleRule: {' src --include='*.ts' | grep -v '\.test\.'`:

| Site | Parent inserted | Today |
|---|---|---|
| `api/class-templates/route.ts:131` | `ScheduleRule` (nested at :133) | inside `$transaction`, `timeout: 10_000` |
| `api/studio-class-templates/route.ts:113` | `ScheduleRule` (nested at :115) | inside `$transaction`, `timeout: 10_000` |
| `api/classes/route.ts:89` | `CalendarEntry` | **no transaction** |
| `api/studio-classes/route.ts:63` | `CalendarEntry` | **no transaction** |

**Out of scope — the slot-moving `UPDATE`s.** `docs/lock-order.md`'s
vacate-and-claim shape ("no order to take", `updateClass` vs `updateClass`,
`40P01` in 32 of 100 runs) is a different defect, already recorded there as
known and not fixed. Issue 331 does not reproduce it, and `ON CONFLICT` has
nothing to say about an `UPDATE`. Say so in the PR body; it stays open.

## The change, per site

Each nested create splits into: insert the parent alone with
`skipDuplicates: true` → branch on whether a row came back → insert the child
keyed on the returned `(id, kind)`.

**On a zero count, the endpoint must still say which conflict it was.** The
existing catch blocks already probe for and name the conflicting row —
`ruleSlotHolder` for the rule layer, `probeConflictingEntry` for the entry
layer. Those probes are reused unchanged; only their trigger moves from "caught
an exclusion violation" to "the insert returned no row". The 409 bodies and
codes are unchanged.

**`ON CONFLICT DO NOTHING` has no conflict target, so a skip is not
self-describing.** It covers every constraint on the table, not only the slot
exclusion. For `CalendarEntry` that includes `@@unique([scheduleRuleId, date])`
— but both entry routes insert with a null `scheduleRuleId` (neither handler
sets one; `studio-classes/route.ts` says so in a comment), and Postgres permits
repeated nulls in a unique key, so that constraint cannot be the skip's cause on
these two paths. Where a probe finds no slot conflict, the endpoint must not
invent one: it answers the existing generic conflict path rather than a
`DUPLICATE_*_SLOT` it cannot substantiate.

**The two entry routes get an EXPLICIT transaction, which is not a new one.**
Measured — Prisma's query log for one bare nested `calendarEntry.create`:

```
1. BEGIN
2. INSERT INTO "public"."CalendarEntry" …
3. INSERT INTO "public"."StudioClass" …
4. SELECT …
5. COMMIT
```

Prisma wraps a nested write in a transaction of its own, so **these routes
already hold the entry row across a second insert, and already do so
unbounded.** The explicit `$transaction` preserves that atomicity across two
separate Prisma calls (two calls would otherwise be two implicit transactions,
opening a window where a `CalendarEntry` exists with no child). It does not
create a lock-holding path; it makes an existing one visible.

Order is parent then child, forced by the foreign key. This is a creation path,
so it does not interact with `docs/lock-order.md`'s `Class`-then-entry rule for
`updateClass`, which governs a write to two **existing** rows. State that in the
code, next to the transaction, not here.

**`setLockTimeout` goes on all four.** The two template routes call it as the
transaction's first statement today; it stays first. The two entry routes get it
too.

An earlier draft of this spec declined that, reasoning that the entry routes had
no transaction and no bound, so adding one was a behaviour change beyond this
defect. **The measurement above falsifies the premise:** the transaction is
already there and the hold is already unbounded, so this is not a bound
introduced onto a bare statement — it is a bound applied to a lock-holding path
that has been running without one. Two further reasons:

- The template routes are bounded *because* they are transactional. After this
  change all four are explicitly transactional, and leaving two unbounded is an
  asymmetry that reads as an oversight later rather than as a decision.
- The cost — a slow create becomes a failed one — is what a timeout is *for*,
  and this project has taken that trade already at both template routes, at
  `lockClassRow`, and at `deleteStudentAccount` (`services/gdpr.ts`), whose own
  comment records that a Prisma transaction budget "cannot roll back a statement
  already blocked inside Postgres, only decline to begin another one".

Note what the bound does and does not buy: `lock_timeout` bounds each *wait*,
not the transaction. `docs/lock-order.md` records the `lockAnnouncementSlot`
measurement — 13,516 ms and 12,013 ms under a "5000 ms" Prisma timeout —
precisely because Prisma's budget is not a bound on a blocked statement. A
`SET LOCAL lock_timeout` is.

## Acceptance

1. The racing pair answers `[201, 409]` with code `DUPLICATE_STUDIO_TEMPLATE_SLOT`
   regardless of interleaving, across repeated full-suite runs. Today it fails
   roughly 1 in 4 locally and about half of CI runs.
2. `pg_stat_database.deadlocks` on the test database stops advancing for this
   pattern. Snapshot before and after a suite run:
   `docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c "SELECT deadlocks FROM pg_stat_database WHERE datname='ethical_yoga_test'"`.
3. All four sites answer their existing 409 code and message unchanged. No new
   status, no new code, no widened assertion.
4. All four sites are explicitly transactional and all four call
   `setLockTimeout` as the transaction's first statement. Re-derive with
   `grep -n 'setLockTimeout' src/app/api/classes/route.ts src/app/api/studio-classes/route.ts src/app/api/class-templates/route.ts src/app/api/studio-class-templates/route.ts`.
5. `main` green.

## Proving each guard bites (§3)

Per site, break it, record the exact error text, restore, re-verify:

- **Remove `skipDuplicates`** from the parent insert → the racing test must fail
  with a deadlock or an exclusion violation, not pass. A site whose test still
  passes without `skipDuplicates` is not testing the fix.
- **Invert the count branch** (treat zero rows as success) → the test must fail
  on the *child* insert or on the 201, not silently produce a second row.
- **Make the probe return "unknown"** → the 409 must still be a 409; the probe
  chooses the sentence, not the status.

The realistic regression is not "someone deletes `skipDuplicates`" — it is
someone reinstating a nested create for brevity. The racing test is the only
thing that catches that, so it must be run repeatedly rather than once: the
existing single-shot case passes against the bug 3 times in 4.

## Not doing

- The slot-moving `UPDATE` deadlock (above). Issue 331 is unaffected by leaving it.
- A retry policy (Bundle 7).
- An error code on the 503 body. PR #333 records that gap; it is real and it is
  not this defect.
