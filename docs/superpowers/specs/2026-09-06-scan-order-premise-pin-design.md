# The forced plan left a heap-ordered path open — design

**Issue:** #470 — `gdpr-lock-order.test.ts`'s AB-BA premise assertion flakes on
the merge gate; same commit, fail then pass.

**Date:** 2026-09-06. **Postgres:** 16.12 (`postgres:16-alpine` in CI, the
`fairyoga-db-1` container locally). **Database measured:** `ethical_yoga_test`.

---

## 1. The issue's premise, checked

The issue says the assertion "asserts a physical scan order that the planner and
the table's page layout decide". **That holds, and the mechanism is narrower and
more actionable than the issue states.**

The issue's own framing is that `enable_seqscan = off` "forces an index path,
but which index and in what direction is still the planner's choice". Measured,
the first half of that is false: **`enable_seqscan = off` does not force an
index path.** It removes one of the *two* heap-ordered scan paths Postgres has
for a plain table. The other — a **Bitmap Heap Scan** — survives all three
settings, and it returns rows in **physical heap order**, which is exactly the
thing the three settings were added to eliminate.

So the defect is not "the planner may pick a different index". It is "the
planner may pick a plan that reads the heap directly", and the fix is one more
setting rather than a redesign of the assertion.

Two further claims in the tree turned out false, both load-bearing:

- `gdpr-lock-order.test.ts:258-260` states that under the forced settings the
  teacher probe "is an index scan on `Class_calendarEntryId_key`". Measured, the
  driving side is usually `CalendarEntry_teacherId_date_idx`, and which of the
  two wins moves between runs (§2.2). The assertion is correct under both, but
  not for the reason the comment gives.
- `db-locks-lock-order.test.ts:47-50` states that adding `enable_mergejoin` and
  `enable_seqscan` "leaves an index-driven nested loop as the only cheap shape".
  A bitmap-driven nested loop is also cheap, is also index-*driven*, and is
  **not** index-*ordered*. That sentence is what let the hole stay open through
  #239 and this issue.

## 2. What was measured

All commands run against `ethical_yoga_test` in the `fairyoga-db-1` container.
Statistics are faked inside `BEGIN … ROLLBACK`, so nothing commits — the
technique `docs/superpowers/plans/2026-09-04-heap-order-plan-dependence.md`
established.

### 2.1 A bitmap path exists for this statement, and is not excluded

```sql
BEGIN;
SET LOCAL enable_hashjoin = off; SET LOCAL enable_mergejoin = off; SET LOCAL enable_seqscan = off;
SET LOCAL enable_indexscan = off;   -- only to reveal the alternative the planner is choosing between
EXPLAIN SELECT c.id FROM "Class" c
  JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
 WHERE e."teacherId" = '00000000-0000-4000-8000-000000000001'
   AND c.status IN ('draft', 'open', 'in_progress');
ROLLBACK;
```

```
 Nested Loop  (cost=8.41..20.45 rows=1 width=37)
   ->  Bitmap Heap Scan on "CalendarEntry" e  (cost=4.27..8.29 rows=1 width=37)
         ->  Bitmap Index Scan on "CalendarEntry_teacherId_date_idx"  (cost=0.00..4.27 rows=1 width=0)
   ->  Bitmap Heap Scan on "Class" c  (cost=4.13..8.15 rows=1 width=74)
         ->  Bitmap Index Scan on "Class_calendarEntryId_key"  (cost=0.00..4.13 rows=1 width=0)
```

Total cost **20.45**. The index-nested-loop plan the planner actually chose in
the same session's sweep costs **20.46**. That is inside the planner's 1% fuzzy
tie band (`compare_path_costs_fuzzily`), so which of the two wins is decided by
noise in the statistics — and one of the two hands back heap order.

`enable_indexscan = off` appears only to make the alternative visible; it is not
part of the fix and not part of the test.

### 2.2 The plan is not stable on one unchanged database

`plan-sweep2.sql` — 54 `EXPLAIN`s of the probe statement across
`Class` ∈ {(0,0), (-1,0), (1,1), (2,1), (3,1), (5,1), (8,1), (20,1), (100,2)}
and `CalendarEntry` ∈ {(0,0), (-1,0), (2,1), (48,12), (200,3), (5000,50)} as
`(reltuples, relpages)` — was run twice, ten minutes apart, with **no schema
change, no data change and no `ANALYZE` between them**:

| run | `CalendarEntry`-driven | `Class`-driven |
|---|---|---|
| first | 54 | 0 |
| second | 6 | 48 |

Same statement, same faked statistics, opposite driving side. This is the flake
reproduced, on a laptop, without CI.

### 2.3 Every plan observed under the three settings still orders by an
assigned key

| driving scan | output ordered by | fixture assigns | gives |
|---|---|---|---|
| `CalendarEntry_teacherId_date_idx` | `CalendarEntry.date` | HIGH 2099-06-01, LOW 2099-06-02 | `[HIGH, LOW]` |
| `Class_calendarEntryId_key` | `Class.calendarEntryId` | HIGH `00000000-…`, LOW `ffffffff-…` | `[HIGH, LOW]` |
| `CalendarEntry_id_kind_live_key` | `CalendarEntry.id` | same ids as above | `[HIGH, LOW]` |
| **Bitmap Heap Scan (either table)** | **physical heap order** | **nothing** | **either** |

So the fixture's assignment work (#441's shape, applied here) is sound. The one
row that breaks it is the bitmap path, and only that row.

### 2.4 The probe is not the statement it models

The production pre-lock (`gdpr.ts:1133`) adds `e."cancelledAt" IS NULL` and
`FOR UPDATE OF c`. Under **identical** statistics, that statement plans
differently from the probe:

```
 LockRows
   ->  Nested Loop
         Join Filter: (c."calendarEntryId" = e.id)
         ->  Index Scan using "Class_calendarEntryId_key" on "Class" c
         ->  Index Scan using "CalendarEntry_teacherId_date_idx" on "CalendarEntry" e
```

— `Class`-driven, where the probe at that moment was `CalendarEntry`-driven. A
probe that plans differently from the statement under test can be green while
that statement's order is wrong, and red while it is right.

### 2.5 With bitmap scans also off, physical order is unreachable

Postgres's scan paths over a plain table are: sequential, index, index-only,
bitmap heap, and TID (which needs a `ctid` qual none of these statements has).
`enable_seqscan = off` and `enable_bitmapscan = off` together leave only index
and index-only scans, **both of which return index order**.

Checked adversarially — with `enable_indexscan` and `enable_indexonlyscan` off
*as well*, so every path carries `disable_cost`:

```
 Nested Loop  (cost=20000000000.40..20000000110.74 rows=1 width=37)
   ->  Index Scan using "CalendarEntry_id_kind_live_key" on "CalendarEntry" e
   ->  Index Scan using "Class_calendarEntryId_key" on "Class" c
```

Postgres still returns an index-ordered plan rather than falling back to the
heap. This is the property the file has always claimed and never had.

## 3. The design

### 3.1 Add the fourth setting, at every site that has the three

`SET LOCAL enable_bitmapscan = off`, alongside the existing three. Six code
sites across three files:

| file | sites |
|---|---|
| `src/lib/db-locks-lock-order.test.ts` | 1 — `forceIndexOrderedPlan` |
| `src/services/template-lock-order.test.ts` | 1 — `expectPremiseOrder` |
| `src/services/gdpr-lock-order.test.ts` | 4 — two probes, two `$executeRawUnsafe` hooks |

Re-derive with `grep -rn 'enable_seqscan = off' src` and count the lines that
are code rather than prose.

All three files rest on the same property ("order comes from index structure,
not from the heap") and all three state it in prose. Fixing one and leaving two
would leave the same live flake on two more merge-gate files and three
conflicting accounts of what the recipe buys.

The hooks matter as much as the probes: the probe measures the plan space the
*probe* runs in, and the erasures run their own statements. Both must sit in the
same restricted space or §2.4's mismatch returns by another route.

### 3.2 Make the probe model the statement under test

Compose the teacher probe from `CLASS_TO_ENTRY_JOIN` (already exported from
`db-locks.ts`, already what the production call site passes) and add the two
clauses §2.4 measured as plan-relevant: `e."cancelledAt" IS NULL` and
`FOR UPDATE OF c`. The probe transaction runs before the two holder
transactions start, so the row locks it takes are uncontended.

Same for the student probe and `CLASS_TO_WAITLIST_JOIN`.

The status list stays a literal: `CANCELLABLE_STATUSES_SQL` is module-private to
`gdpr.ts`, and exporting a service's internals to let a test spell a filter the
same way buys less than it costs. It is a filter on `Class` under every plan
shape observed, so it is not plan-relevant; the join and the locking clause are.

### 3.3 Assert what the fixture assigned, as data

Three assertions on the stored rows — HIGH holds the lower `calendarEntryId`,
the earlier `CalendarEntry.date`, and the **higher** `Class.id` — evaluated by
comparison in TypeScript, not by any query whose order a planner chooses.

This is what makes the premise *derived* rather than *observed* (the issue's
option 2). Given (a) these assignments and (b) §2.5's guarantee that the plan's
order is some index's key, `[HIGH, LOW]` follows for every index key the fixture
assigns. When it stops following, these assertions say which of the two halves
moved.

### 3.4 Attach the plan to the failure

Capture `EXPLAIN` for the probe statement in the same transaction, under the
same settings, and pass it as the row-order assertion's message. The 2026-08-27
occurrence and this one both cost an archaeology session because
`expected [ …(2) ] to deeply equal [ …(2) ]` says nothing about *why*. With the
plan attached, the next occurrence is one read.

### 3.5 Rejected: a separate plan-membership assertion

Asserting that the driving index is one of §2.3's three was considered and
dropped. It adds a second list to keep current, it reddens on a
plan-shape change that is harmless whenever the new shape's key is also
assigned, and §3.4 already puts the plan in front of whoever reads the failure.
The row assertion plus the plan text carries the same information without the
list.

## 4. The residual, stated plainly

**The pin is narrowed, not closed.** Index order is not one order. A
`Class_pkey`-driven plan would order by `Class.id` — and the fixture assigns
`Class.id` the *opposite* way on purpose, because the student side's natural
order is `Class.id` ascending and the whole premise is that the two sides
disagree. That one shape therefore cannot be reconciled by any fixture, and it
should not be: under it the reproduction really would be vacuous, and a red test
is the correct answer.

It was not observed in any of the ~100 `EXPLAIN`s in §2. Postgres preferred
`Class_calendarEntryId_key` for a `Class`-driven full index scan in every
configuration tried, including ones that made `Class_pkey` artificially cheap.
That is an observation, not a guarantee.

What changes with this work: physical heap order — the only *unbounded* source
of disorder, and the one shared with every other file in the tier — becomes
unreachable, and the remaining space is a small set of index keys the fixture
assigns. What does not change: Postgres has no plan pinning, so this is a
narrowing, and §3.4 exists because a further narrowing may one day be needed.

## 5. Acceptance criteria, mapped

| issue AC | where |
|---|---|
| premise stays asserted; prove by mutation, record exact output | plan Task 2 |
| assertion no longer depends on a physical scan order | §2.5 + §3.1 |
| state what makes it stable | §2.5, and §4 for what does not |
| honest residual flake rate, N runs, CI-shaped database | plan Task 2 |
| if it cannot be made stable, say so | §4 |

## 6. Not in scope

- **#448 is unaffected** — the sibling question about what
  `template-lock-order.test.ts`'s two deadlock tests are *for*. This work adds a
  setting to that file's existing probe; it does not touch what the tests assert.
- **#459 is unaffected** — it neither introduced nor can fix this.
- No production code changes. `src/lib/db-locks.ts` and `src/services/gdpr.ts`
  are read, and mutated only transiently for the Task 2 proof.
