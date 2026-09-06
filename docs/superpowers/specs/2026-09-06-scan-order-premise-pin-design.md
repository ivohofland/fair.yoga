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
thing the three settings were added to eliminate. §2.1 measures that path as
reachable, and measures four times over that whether it is also *preferred*
moves with the database state rather than being a fact about the statement.

**Which plan CI actually got is deducible from the failure, and it is exactly
one.** The reported order was `[LOW, HIGH]`. Enumerate what each reachable plan
orders by, against what the fixture assigns (§2.3): every index key the fixture
assigns yields `[HIGH, LOW]`. Two things could in principle yield `[LOW, HIGH]`
— and only one of them was ever reachable by that statement.

That enumeration is closed only because of what the statement CI ran did not
carry, and the clause is load-bearing enough to state: the pre-#470 probe
carried no partial-index predicate, so no GiST path was eligible to it (§2.5),
and an ineligible index has no order to contribute. Against a statement that
DID carry one — production's own pre-lock does — the list below is not
exhaustive, because a GiST index scan orders by nothing a fixture assigns and
so yields either. §4 owns that case. For the statement measured here:

- a plan driven by **`Class_pkey`**, ordering by `Class.id` — which the fixture
  assigns the *opposite* way on purpose. **Not reachable**, and §1.1 below is
  the measurement; or
- **heap order**, from a bitmap heap scan, landing that way by page layout.
  Reachable under the three settings, and closed by the fourth (§2.5, §3.1).

So the second is not merely the one this work closes — it is **the only one
that could have produced the observed failure**, and it is closed.

### 1.1 The two sides disagree by CONSTRUCTION, not by fixture luck

Each statement's own join column decides which index on `Class` Postgres will
generate a path for at all, and the two statements join on different columns:

| statement | joins `Class` on | eligible index on `Class` | orders by | fixture assigns |
|---|---|---|---|---|
| teacher | `c."calendarEntryId"` | `Class_calendarEntryId_key`; **`Class_pkey` not generated** | `calendarEntryId` | `[HIGH, LOW]` |
| student | `c.id` | `Class_pkey`; **`Class_calendarEntryId_key` not generated** | `Class.id` | `[LOW, HIGH]` |

`beforeAll` assigns those two columns in opposite directions, so the two sides'
natural orders differ for a reason the planner has no say in. **That is the
derivation issue #470 asked for** — "pinning it to something a planner cannot
reverse" — and it is this spec's eligibility-not-cost method applied to its own
largest stated residual.

**"Not generated" has to be told apart from "generated but outbid", and a chosen
plan cannot do it** — it is evidence only about the winner. Hiding the winner
can: set `pg_index.indisvalid = false` on it inside `BEGIN … ROLLBACK` and
re-plan.

**Under the four settings, `enable_seqscan = off` among them.** That is
load-bearing rather than incidental: an undiscouraged sequential scan over these
single-page tables costs ~1.02 and would be the fallback whether or not an index
path existed, so the experiment would answer "never generated" every time. With
it off the fallback carries `disable_cost` and any generated index path must
beat 1e10 to stay hidden. `docs/lock-order.md` carries the counterexample that
makes this concrete.

So measured:

| statement | winner hidden | falls back to |
|---|---|---|
| teacher, no `ORDER BY` | `Class_calendarEntryId_key` | **`Seq Scan on "Class"` at 1e10** — not `Class_pkey` |
| **control**: teacher, `ORDER BY c.id` | `Class_calendarEntryId_key` | **`Class_pkey`, cost 0.12..8.14**, no penalty term |
| student, no `ORDER BY` | `Class_pkey` | **`Seq Scan on "Class"` at 1e10** — not `Class_calendarEntryId_key` |

The control row is what makes the other two mean anything: it shows the
instrument can find `Class_pkey` when a path for it exists, so its absence
elsewhere is the index's, not the method's. Note how sharp the contrast is — the
planner takes a sequential scan priced at 1e10 over an index that is present,
un-hidden, and would cost 8.14. That only happens if no path for it was built.

An earlier draft of this section put a pair of `EXPLAIN` costs here and called
them *identical*, offering that as the proof that cost is not what decides.
**Withdrawn**: re-measured, the two differ (`Class_calendarEntryId_key`
0.25..8.27 against `Class_pkey` 0.12..8.14), and they had come from one
`EXPLAIN` at one database state — §2.6's own failure mode, so the table above
does not repeat it. Nothing rests on those numbers; the hiding control is the
evidence.

The mechanism is `build_index_paths` (`indxpath.c`): a path is built when the
index has usable clauses, useful pathkeys, a useful predicate, or supports an
index-only scan. For `Class_pkey` against the teacher statement, none holds —
`c.id` appears in no clause, `ORDER BY c.id` is absent so there are no pathkeys,
the index is not partial, and `FOR UPDATE` rules out index-only.

**This is an argument about two specific statements on today's schema, not a
law.** It turns on which clauses each statement carries, so a new index on
`Class`, or a predicate mentioning `c.id` added to the teacher statement, can
make the path exist again. Measured: adding a bare `c.id > …` to its `WHERE`
is enough to generate a `Class_pkey` path — shown by the same hiding experiment,
which under that variant reaches `Class_pkey` at 0.12..8.15 with an
`Index Cond: (id > …)` instead of falling back. Re-measure before relying on
this after either statement changes.

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

Total cost **20.45**, against **16.12** for the index-nested-loop plan the
planner chooses under the *same* statistics. The method is sound: `disable_cost`
is 1e10 and attaches only to the scan type actually disabled, so the bitmap
plan `enable_indexscan = off` reveals carries no penalty term and 20.45 is a
genuine number. **One observation, at one database state: the bitmap path was
reachable and, there, 4.33 dearer.**

**That is as far as the figure goes, and an earlier draft of this section went
two steps further.** The first draft put 20.45 against 20.46 and called it a
fuzzy tie; those two numbers came from **different statistics states** (the
20.46 from a sweep with faked `pg_class` rows, the 20.45 from the unfaked
table), so the comparison was not one. The draft after it read the corrected
pairing as a property — "reachable but not currently preferred", "roughly 27%
dearer" — and that does not hold either. Re-measured during Task 2 on the actual
`FOR UPDATE` probe, **the sign of the gap flips twice** across four database
states:

| measurement | chosen plan, three settings | bitmap plan, undisabled | bitmap is |
|---|---|---|---|
| this section, above (no `FOR UPDATE`) | 16.12 | 20.45 | dearer by 4.33 |
| Task 2, 1st (`Class` 1 row / 1 page) | 28.59 | 26.59 | **cheaper** by 2.00 |
| Task 2, 2nd (minutes later, no write between) | 21.41 | 20.95 | **cheaper** by 0.46 |
| Task 2, 3rd (after a full suite run and autovacuum) | 23.15 | 28.46 | dearer by 5.31 |

Neither "preferred" nor "not preferred" is a property of this statement; each is
a reading of one state, and this table is §2.6's lesson arriving a second time by
a different route. The middle two rows also mean the planner declined a plan
whose revealed cost was lower than the one it chose — unexplained here, and
nothing in this spec rests on it, because the ruling is on eligibility.

What survives is narrower and is the thing worth acting on: **the three settings
do not exclude a heap-ordered plan**, and whatever cost gap keeps it unchosen at
any given moment is a function of statistics this project does not control on
CI. §3.1 is the setting that removes the path instead of out-pricing it, and
Task 2 measured that removal the only way that does not depend on a cost: with
`enable_indexscan` and `enable_indexonlyscan` off as well, the three settings
still yield a Bitmap Heap Scan carrying no penalty term, while the four yield
`Index Scan`s at 1e10 apiece — no heap-ordered node exists at any price.

`enable_indexscan = off` appears only to make the alternative visible; it is not
part of the fix and not part of the test.

### 2.2 The plan moves with table churn, not with the statement

`plan-sweep2.sql` — 54 `EXPLAIN`s of the probe statement across
`Class` ∈ {(0,0), (-1,0), (1,1), (2,1), (3,1), (5,1), (8,1), (20,1), (100,2)}
and `CalendarEntry` ∈ {(0,0), (-1,0), (2,1), (48,12), (200,3), (5000,50)} as
`(reltuples, relpages)`. Faking `pg_class` is only half a fake: `estimate_rel_size`
(`plancat.c`) reads the relation's **real** block count off disk and uses
`reltuples/relpages` as a density against it. So the same script re-run after the
table has grown or been truncated estimates differently.

Run five times back to back, with nothing in between:

| runs 1-5 | `CalendarEntry`-driven | `Class`-driven |
|---|---|---|
| all five identical | 6 | 48 |

**Deterministic given the database state.** Now the same script across a session
in which `gdpr-lock-order.test.ts` was executed once (it inserts and deletes in
both tables) and background autovacuum then ran:

| when | `CalendarEntry`-driven | `Class`-driven |
|---|---|---|
| before the test run | 54 | 0 |
| after the test run | 6 | 48 |
| ~20 min later, no statement run in between | 42 | 12 |

Same statement, same faked `pg_class` numbers, three different answers — moved
by row churn in the two tables and by autovacuum acting on it. That is precisely
what CI supplies: `--project unit` runs first, in parallel, against the same
`ethical_yoga_test` database (`ci.yml:176-183`), and `--project unit-sweeps`
reaches this file afterwards with whatever heap and statistics that left.

The third row is weaker evidence than the first two: no statement of mine ran
between rows two and three, so autovacuum is inferred from the timing rather
than observed. Rows one and two are the load-bearing ones.

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

**This table is a census of what was OBSERVED, not a closed enumeration of what
is possible.** It has no GiST row because no statement swept here could reach a
GiST index — every one of this schema's is partial, and none of these carried
the matching predicate (§2.5). A statement that carries one earns a breaking row
of its own, alongside the bitmap one and for a different reason — an index scan
that orders by nothing a fixture can assign. §3.2 is the decision that keeps the
probes clear of it, and §4 is what it costs the premise anyway.

Nor is the non-breaking half closed. Task 2 swept both probes under all four
settings and observed a driving index this table does not list —
`WaitlistEntry_classId_position_idx`, whose leading column is `classId` and
which the fixture therefore also assigns. Harmless, and the point: read the rows
above as "these were seen and each is sound", never as "these are the only ones
there are".

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

— `Class`-driven, where the probe at that moment was `CalendarEntry`-driven.

This measurement is sound and its first reading was not. It was read as "the
probe must carry those clauses to be meaningful", which §3.2 reverses. Read
correctly it says something stronger and less comfortable: **no probe can plan
like this statement**, because the clause doing most of the steering is the
`ORDER BY c.id` the probe exists to omit. A probe is therefore a fixture check
and nothing more, and the counterfactual it was reaching for — what the
statement would do with the `ORDER BY` gone — is established by deleting the
clause and running the suite, not by any `SELECT`.

### 2.5 With bitmap scans also off, physical order is unreachable — but "index scan" is not "ordered"

Postgres's scan paths over a plain table are: sequential, index, index-only,
bitmap heap, and TID (which needs a `ctid` qual none of these statements has).
`enable_seqscan = off` and `enable_bitmapscan = off` together leave only index
and index-only scans, so **physical heap order becomes unreachable**.

Checked adversarially — with `enable_indexscan` and `enable_indexonlyscan` off
*as well*, so every path carries `disable_cost`:

```
 Nested Loop  (cost=20000000000.40..20000000110.74 rows=1 width=37)
   ->  Index Scan using "CalendarEntry_id_kind_live_key" on "CalendarEntry" e
   ->  Index Scan using "Class_calendarEntryId_key" on "Class" c
```

Postgres still returns an index scan rather than falling back to the heap.

**That is as far as it goes, and the first draft of this spec went further and
was wrong.** It said the two survivors "both return index order". An `Index
Scan` node returns key order only when its access method can order:

```sql
SELECT amname, pg_indexam_has_property(oid, 'can_order') FROM pg_am
 WHERE amname IN ('btree', 'gist');
--  btree | t
--  gist  | f
```

This schema has exactly two GiST indexes, both from #296/#327's exclusion
constraints: `CalendarEntry_teacher_slot_excl` and
`ScheduleRule_teacher_slot_excl`. Both are PARTIAL —
`WHERE ("cancelledAt" IS NULL)` and the `isArchived` equivalent — so a GiST scan
is eligible only for a statement carrying the matching qual. `WaitlistEntry` is
btree-only, so the student probe cannot reach one at all.

Corrected, the property is: **btree** index scans return key order, and the
settings make a btree or GiST index scan the only reachable shapes. Whether a
statement can reach the GiST one is decided by its own predicate — see §3.2,
where that decides what the teacher probe may carry.

### 2.6 Three runs of one measurement, three answers

The probe-variant sweep of §3.2 — four statement variants × six
`(reltuples, relpages)` configurations for `Class` and `CalendarEntry` — was run
three times by two different people on this one database:

| run | driving scan |
|---|---|
| controller, first | `CalendarEntry_teacherId_date_idx` without the qual; **GiST** with it |
| implementer, after running the lock-order files | `CalendarEntry_teacherId_date_idx`, all 24 |
| controller, re-run after those test runs | `Class_calendarEntryId_key`, all 24 |

**The "GiST-driven 6 of 6" figure this spec first reported is hereby
withdrawn.** It was one database state, presented as a property. What actually
holds is §2.2's finding in its sharpest form yet: the driving side of this
statement moves with table churn, and the churn between these three runs was
nothing but the test files under repair being executed.

That is why §3.2's ruling rests on **eligibility, not cost**. Which plan wins
today is not a thing this project can pin; which plans are *possible* is decided
by the statement's own predicates, and that this project controls.

## 3. The design

### 3.1 Add the fourth setting, at every site that has the three

`SET LOCAL enable_bitmapscan = off`, alongside the existing three. **Five** code
sites across three files:

| file | sites |
|---|---|
| `src/lib/db-locks-lock-order.test.ts` | 1 — `forceIndexOrderedPlan` |
| `src/services/template-lock-order.test.ts` | 1 — `expectPremiseOrder` |
| `src/services/gdpr-lock-order.test.ts` | 3 — `probeUnderForcedPlan`, two `$executeRawUnsafe` hooks |

Re-derive with `grep -rn 'enable_seqscan = off' src` and count the lines that
are code rather than prose: 9 lines, 4 prose, 5 code.

This said "six, and four in `gdpr`" until the build landed, and the build itself
is why: Step 3 consolidated that file's *two* probes onto one shared helper,
`probeUnderForcedPlan`, so the two probe sites became one. A count written
before the edit it describes.

All three files rest on the same property ("order comes from index structure,
not from the heap") and all three state it in prose. Fixing one and leaving two
would leave the same live flake on two more merge-gate files and three
conflicting accounts of what the recipe buys.

The hooks matter as much as the probes: the probe measures the plan space the
*probe* runs in, and the erasures run their own statements. Both must sit in the
same restricted space or §2.4's mismatch returns by another route.

### 3.2 The probe is a fixture check, and carries only clauses that keep it btree-reachable

Compose the teacher probe from `CLASS_TO_ENTRY_JOIN` (already exported from
`db-locks.ts`, already what the production call site passes) and end it
`FOR UPDATE OF c`. The probe transaction runs before the two holder transactions
start, so the row locks it takes are uncontended.

Same for the student probe and `CLASS_TO_WAITLIST_JOIN`.

**It does NOT carry `e."cancelledAt" IS NULL`, and the reversal is the most
important decision in this spec.** This section first said to add it, on §2.4's
argument that the probe should plan like the statement it models. Review
falsified that on two counts:

1. `CalendarEntry_teacher_slot_excl` is **partial on exactly that qual** (§2.5).
   Carrying it makes a GiST scan — which cannot order — an eligible path;
   omitting it makes that path impossible. The qual selects nothing this
   fixture's rows do not already satisfy, both entries being live, so dropping
   it changes **no row the probe returns** — only which index paths exist.
2. The fidelity goal was unreachable from the start. Production's statement
   carries `ORDER BY c.id`, which is itself plan-steering (measured: it selects
   a `Class_pkey`-driven shape), and the probe must not carry it, because
   reading the *unordered* order is the whole point.

So the probe is not a model of the production statement and must not be
described as one. It is a check that the **fixture** is adversarial: read
through an ordered index, these two rows come back HIGH-first. `FOR UPDATE OF c`
stays because it is measured irrelevant to the driving side and costs nothing;
the line between the two clauses is that one widens the plan space to an
unordered scan and the other does not.

The status list stays a literal: `CANCELLABLE_STATUSES_SQL` is module-private to
`gdpr.ts`, and exporting a service's internals to let a test spell a filter the
same way buys less than it costs. It is a filter on `Class` under every plan
shape observed, so it is not plan-relevant; the join is.

### 3.3 Assert what the fixture assigned, as data

Three assertions on the stored rows — HIGH holds the lower `calendarEntryId`,
the earlier `CalendarEntry.date`, and the **higher** `Class.id` — evaluated by
comparison in TypeScript, not by any query whose order a planner chooses.

This is what makes the premise *derived* rather than *observed* (the issue's
option 2). Given

- (a) these assignments;
- (b) §2.5 as corrected — the probe's reachable shapes are btree index scans,
  because §3.2 keeps it clear of the GiST indexes; and
- (c) §1.1 — `Class_pkey` is not among the teacher statement's reachable paths
  at all,

`[HIGH, LOW]` follows for every key those plans order by. When it stops
following, these assertions say which of the two halves moved.

**(c) is not optional and the derivation is false without it.** The third
assertion above deliberately assigns `Class.id` the OTHER way, so a
`Class_pkey`-driven plan would order `[LOW, HIGH]` and "every key those plans
order by" would be untrue. What makes the sentence sound is that the teacher
statement cannot reach that plan — not that the fixture got lucky.

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

**The pin is narrowed, and narrower than earlier drafts of this section
believed. Issue #470's AC 4 still applies to what is left: say so.**

### 4.1 The residual this section used to lead with, and no longer has

This section said: a `Class_pkey`-driven plan orders by `Class.id`, the fixture
assigns `Class.id` the opposite way on purpose, **no fixture can reconcile that
shape** — and named a symmetric exposure on the student side to a
`Class_calendarEntryId_key`-driven plan. Both are **withdrawn**.

§1.1 has the measurement. Neither plan is reachable by the statement it would
break, and for the same structural reason in both directions: each statement
joins `Class` on one column, and that is the only thing making an index on
`Class` worth generating a path for. The teacher statement mentions `c.id`
nowhere, so `Class_pkey` is not generated for it; the student statement mentions
`calendarEntryId` nowhere, so `Class_calendarEntryId_key` is not generated for
it. `Class_pkey` *does* drive the student probe and is benign there, because
`w."classId"` **is** `c.id` — it orders by the same column the `WaitlistEntry`
indexes lead with, and both give `[LOW, HIGH]`.

The earlier draft rested on ~100 `EXPLAIN`s in which `Class_pkey` was never
observed driving the teacher statement, and correctly called that an
observation rather than a guarantee. It was the right caution about the wrong
question: the guarantee was available, and it comes from eligibility rather
than from cost.

**What replaces it is narrower and must not be overstated.** This is an argument
about two specific statements against today's schema. A new index on `Class`, or
a clause mentioning `c.id` added to the teacher statement, can put the path back
— measured, in §1.1. It is not a property of the tables, and it needs
re-measuring whenever either statement changes.

### 4.2 The residual that survives, and it is now the only one

§2.5 has the mechanism — a GiST index scan is an index scan that does not order,
and this schema's are reachable only by a statement carrying their partial
predicate. What §4 owns is where that leaves the premise: the *production*
pre-lock carries `cancelledAt IS NULL`, so its MUTATED form — `ORDER BY c.id`
removed, which is exactly what the premise is a counterfactual about — can plan
onto an index with no key order at all. **No probe on this schema can establish
that counterfactual.** What establishes it is deleting the clause and watching
the test redden: Task 2's mutation, load-bearing now rather than confirmatory,
and it reddened 3/3 on the `40P01` negation with all three premise assertions
still passing.

Note what this residual is *not* about, since §4.1 changed the neighbourhood:
the mutated production statement's `Class` side is still
`Class_calendarEntryId_key`, not `Class_pkey` — measured the same way. The
exposure is on the `CalendarEntry` side, where the qual makes an unordered index
eligible.

So, plainly: **this work does not make the premise unfalsifiable by the
planner.** Postgres offers no plan pinning, and the two remaining levers were
weighed and rejected —

- *installing `pg_hint_plan`* — a database extension added to every developer's
  container and to CI, to pin one assertion in one test file;
- *skipping the test when the plan is unfavourable* (`ctx.skip()` with the plan
  in the message) — it stops the gate reddening, at the price of a merge gate
  that can go quietly vacuous, which is the failure mode #470 says must not be
  reached.

What this work does buy, and it is more than earlier drafts claimed: heap order
— the only *unbounded* source of disorder, and the one shared with every other
file in the tier — leaves the reachable set; the remaining set is a handful of
index keys the fixture assigns, and §1.1 shows that set excludes the one key
assigned the other way; and when a plan outside that set is chosen, the failure
prints the plan instead of two opaque uuids, so the next occurrence is one read
rather than an archaeology session. The last two are §3.

**Which makes the headline claim sharper than "narrowed".** Of the two shapes
§1 identifies as capable of producing CI's `[LOW, HIGH]`, one was never
reachable by that statement and the other is heap order — and heap order is what
the fourth setting closes. So for the probe as it stands, the observed failure
mode is closed, not merely made less likely. §4.2 is what remains, and it is
about the mutated production statement rather than about the probe.

## 5. Acceptance criteria, mapped

| issue AC | where |
|---|---|
| premise stays asserted; prove by mutation, record exact output | plan Task 2 |
| assertion no longer depends on a **physical** scan order | met — §2.5 + §3.1 |
| …nor on any order "the planner may reverse" | **met for the probe** — §1.1: the one reversing plan is not generated for this statement, measured by eligibility rather than cost. **Not met for the mutated production statement** — §4.2 |
| state what makes it stable | §1.1 and §2.5 for what is closed; §4.2 for what is not |
| honest residual flake rate, N runs, CI-shaped database | plan Task 2 |
| if it cannot be made stable, say so | §4, and the PR body |

The middle row was "**not met, and cannot be**" until §1.1 was measured. The
"cannot be" was the part that turned out wrong: it assumed index-order stability
had to come from out-costing the alternative, when the alternative was never
generated. The row is split rather than flipped, because the residual §4.2 owns
is real and is a different statement.

## 6. Not in scope

- **#448 is unaffected** — the sibling question about what
  `template-lock-order.test.ts`'s two deadlock tests are *for*. This work adds a
  setting to that file's existing probe; it does not touch what the tests assert.
- **#459 is unaffected** — it neither introduced nor can fix this.
- No production code changes. `src/lib/db-locks.ts` and `src/services/gdpr.ts`
  are read, and mutated only transiently for the Task 2 proof.
