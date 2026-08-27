# A plain INSERT against an exclusion constraint can deadlock — issue 331

**Date:** 2026-08-27 · **Issues:** 331 and 228 · **Depends on:** PR #333
(diagnostics and the corrected `lock-order.md` paragraph)

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

## The bound, and why issue 228 comes with this round

**Two earlier claims of mine were wrong and are replaced, not annotated.** I
wrote that the two template routes call `setLockTimeout` today. **None of the
four does.** And I proposed adding it to all four as a small consistency fix.
`class-templates/route.ts:246` already refuses that, in writing:

> No `setLockTimeout` here, and that is a scope decision rather than an oversight
> — tracked as issue 228 … Alone, the bound would turn a wait that usually
> succeeds into the generic `classifyApiError` 503 instead of a named one.

A bare bound trades a rare `40P01`-shaped 503 for a commoner `55P03`-shaped one:
the same unhelpful answer, more often. That is the defect class this round exists
to remove, so **the bound only ships with a named outcome**, which is 228's whole
point and needs the service boundary to have somewhere to put the union.

### Issue 228's half

Both template creates move to `src/services/`, beside their three lifecycle
siblings, returning the house-convention union:

```ts
export type CreateTemplateResult =
  | { ok: true; template: ClassTemplate; generation: GenerationResult }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'busy' };
```

`setLockTimeout(tx)` is the transaction's first statement. The catch tests
`isTransientDbError` **before** `isUniqueConflictOn` — `P2028`/`P2024` are
`PrismaClientKnownRequestError`s too, the ordering all three siblings document.
The routes keep auth, parsing and response shaping and close their narrowing
chain with the `never` guard, which is the forcing function 228 is really after:
a future arm cannot be added without the compiler demanding it be answered.

**Both or neither**, per 228 and #227 before it.

### The two halves fit together better than either alone

331's zero-row skip **is** 228's `slot_conflict` arm. The service returns
`{ ok: false, reason: 'slot_conflict' }` when the parent insert comes back with
no row, so 228 gets its named outcome without a catch block, and 331 gets its
refusal without a deadlock. Neither is bolted onto the other.

### Redo the sum — 228 asks for this explicitly

228 records `N = 2` lock-waiting statements against a 10s budget. **That
figure is wrong, and so was this spec's first correction of it.** 228 counted
generation as one statement; it is two lock-taking writes —
`studio-class-generator.ts:325` (`calendarEntry.createManyAndReturn`) and `:340`
(`studioClass.createMany`), with the class family's twin at
`class-generator.ts`. Re-derive with
`grep -nE 'createManyAndReturn|createMany' src/services/*-generator.ts`.

The real count, after 331 splits the nested create: **four** waiting statements
— parent insert, child insert, and generation's two writes. The `findMany` is a
plain read and does not wait under READ COMMITTED. So `4 × 2s = 8s` inside the
10s budget, leaving **2s of headroom, not 4s**. Before 331 it was three, at 6s.

That margin is thin enough to be the constraint: **a fifth waiting statement
takes the sum to 10s and consumes the budget entirely.** `docs/lock-order.md`
asks anyone adding waits to redo this sum, and this is the second time doing so
has changed the answer.

### What the bound does not buy

`lock_timeout` bounds each *wait*, not the transaction. `docs/lock-order.md`
records `lockAnnouncementSlot` running 13,516 ms and 12,013 ms under a "5000 ms"
Prisma budget, because Prisma checks its budget at statement boundaries and
cannot roll back a statement already blocked inside Postgres. A
`SET LOCAL lock_timeout` can.

### The two entry routes are NOT in 228's scope

228 names the two template creates. `POST /api/classes` and
`POST /api/studio-classes` have the same unbounded shape and are not in it. They
get 331's half only — the deadlock fix, no bound, no service move — and the gap
is recorded as an update on 228 rather than filed separately (§7's fourth test:
prefer extending what exists). Widening 228's scope inside this round would make
it a four-route refactor, which is not what it was scoped or measured for.

## Acceptance

1. The racing pair answers `[201, 409]` with code `DUPLICATE_STUDIO_TEMPLATE_SLOT`
   regardless of interleaving, across repeated full-suite runs. Today it fails
   roughly 1 in 4 locally and about half of CI runs.
2. `pg_stat_database.deadlocks` on the test database stops advancing for this
   pattern. Snapshot before and after a suite run:
   `docker exec fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c "SELECT deadlocks FROM pg_stat_database WHERE datname='ethical_yoga_test'"`.
3. All four sites answer their existing 409 code and message unchanged. No new
   status, no new code, no widened assertion.
4. Both template creates live in `src/services/`, return `CreateTemplateResult`,
   call `setLockTimeout` as the transaction's first statement, and their routes
   close the narrowing chain with a `never` guard. Contention answers a named
   `busy`, not `classifyApiError`'s generic sentence. The two entry routes are
   unchanged in this respect and remain unbounded, by decision.
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
