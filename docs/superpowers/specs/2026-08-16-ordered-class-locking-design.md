# Ordered multi-row `Class` locking — one tested helper

**Issue:** #237 · **Date:** 2026-08-16 · **Branch:** `ordered-class-locking`

Five sites lock more than one `Class` row inside a single transaction. Four
hand-roll the same `SELECT c.id … ORDER BY c.id FOR UPDATE OF c`; the fifth
takes its locks through a per-class CAS loop. Which sites those are, and which
order each takes, is tracked in prose — a five-row table in
`docs/lock-order.md` and a register in `src/lib/db-locks.ts`.

This branch replaces the convention with a helper, pins the ordering once with
a test that can fail, folds the CAS site in, and corrects the claims the
hand-maintained census left stale.

---

## 1. What was measured, and where the issue is wrong

Every number below was re-derived on 2026-08-16 against this checkout. Where a
claim was inherited, it says whether it held.

### 1.1 Baseline

```
npx vitest run --project unit          → 53 files, 769 tests, green
npx vitest run --project unit src/services/template-lock-order.test.ts → 3 tests, green
npx vitest run --project unit src/services/gdpr.test.ts                → 23 tests, green
```

Every line reference in this document was checked against this checkout with
`sed -n '<n>p'` rather than trusted. Two had drifted and are corrected here:
the reorder-loop comment is `gdpr.ts:700`, not `:702`, and the
"cannot roll back" sentence is `gdpr.ts:692`, not `:684-691`. The plan should
re-check them again before leaning on any of them — that is what this
paragraph is a worked example of.

### 1.2 The census — 9 raw statements, not 8; 4 multi-row, not 3

Re-derived with check 2 of `docs/lock-order.md`'s own "How that enumeration was
derived":

```
grep -rn '"Class"' --include="*.ts" src/ | grep -v '\.test\.ts'
```

minus comment lines. Nine statements:

| # | Site | Kind |
|---|---|---|
| 1 | `app/api/registrations/route.ts:103` | single-id, inline |
| 2 | `lib/db-locks.ts:195` — `lockClassRow`'s body | single-id |
| 3 | `services/gdpr.ts:404` — `deleteStudentAccount` | **multi-row `FOR UPDATE OF c`** |
| 4 | `services/template-sync.ts:116` — `syncTemplateInstances` | **multi-row** |
| 5 | `services/class-template-lifecycle.ts:1253` — `archiveOrUnarchiveTemplate` | **multi-row** |
| 6 | `services/waitlist.ts:196` — `addToWaitlist` | single-id, inline |
| 7 | `services/waitlist.ts:435` — `promoteNext` | single-id, inline |
| 8 | `services/waitlist.ts:565` — `claimSpot` | single-id, inline |
| 9 | `services/waitlist.ts:947` — `withdrawWaitingEntriesForTeacher` | **multi-row** |

Arithmetic: `9 = 5 single-id + 4 multi-row`. Add `deleteTeacherAccount`'s CAS
loop, which is not a `FOR UPDATE` at all, and the multi-row-locking count is
**5** — which is what the issue's table says, so **the issue's headline claim
holds**.

**`docs/lock-order.md` does not.** Its derivation subsection says "**8** in
total … **5** are single-id … **The other 3 are multi-row**", and names only
`withdrawWaitingEntriesForTeacher`, `syncTemplateInstances` and
`archiveOrUnarchiveTemplate`. `deleteStudentAccount`'s statement — added last
round by #216/#182 — is absent. The **table** above that subsection was updated
in that round; the **derivation** below it was not.

That is the fourth correction to this same list. The document already records
three: "an earlier version of this section said three sites"; "a later version
said two of the five disagreed"; "a third version said all five follow it now,
and that is the one this paragraph exists to correct." This is the fourth, and
it was introduced by the round that filed the issue asking for the list to stop
being prose.

### 1.3 A second census, stale the same way — with the count intact

`lockClassRow(` has five call sites (grep over `src/`, excluding the definition
at `db-locks.ts:193` and the docblock mention at `:134`):

- `autoTransitionToInProgress` — `class-transitions.ts:88`
- `autoCancelClasses` — `class-transitions.ts:354`
- `completeClass` — `class-lifecycle.ts:282`
- `removeFromWaitlist` — `waitlist.ts:378`
- `handleSpotFreed` — `waitlist.ts:772`

`db-locks.ts:179-186` still names the call sites as `completeClass`,
`removeFromWaitlist`, **`deleteStudentAccount`** and `autoCancelClasses`.
`gdpr.ts` does not call `lockClassRow` at all any more — it imports only
`setLockTimeout` (`gdpr.ts:18`). `autoTransitionToInProgress` is named nowhere.

**The count stayed 5 while the membership changed.** Any check that counts
passes; only re-deriving the names finds it. This is the compensating-error
shape `docs/backlog-roadmap.md` describes for issue counts, in a second
register.

### 1.4 The issue's "Why now" is overstated — measured

The issue says the erasure's `ORDER BY` is no longer guarded by a
reproduction. Mutation: delete `ORDER BY c.id` from `gdpr.ts`'s ordered
statement.

| Scope run | Result |
|---|---|
| `template-lock-order.test.ts` | **3 passed** — the issue's stated claim holds |
| whole `unit` project | **1 failed** — `gdpr.test.ts:1423`, `Raw query failed. Code: 40P01. Message: ERROR: deadlock detected` |

The surviving pin is `gdpr.test.ts:1344`, *"does not deadlock when a teacher
erasure and a student erasure overlap on two classes"*. It is not flaky: **5
runs out of 5** failed under the mutation, and all 23 tests in the file pass
with the clause restored.

So coverage did not vanish; it narrowed from two pairings to one.
`gdpr.ts:485-494` already names that test as the pin. What is false as written
is `template-lock-order.test.ts:363-368` — "guarded … by the shared idiom and
by `docs/lock-order.md`'s within-`Class` table — rather than by a
reproduction … That is a real reduction in coverage."

**The lesson this branch should carry:** the mutation *confirmed* the issue
when run against one file and *refuted the conclusion drawn from it* when run
against the project. A mutation scoped to the tests you expect to fail can only
confirm what you already believe.

The consequence for scope: the issue's stated motivation (repay lost coverage)
is weaker than filed. Its actual thesis (a prose census goes stale) is
stronger — it is stale in two places right now, and mis-explained in three
more.

### 1.5 Three more stale claims, found while measuring

- **`sortedWaitingClassIds` is not sorted.** `gdpr.ts:416` builds it from a
  `findMany` with no `orderBy` and no `.sort()`. There is no `.sort()` anywhere
  in `gdpr.ts`. The name survived #216/#182's rewrite, which moved the ordering
  into SQL. Harmless — the lock is already held by then — but the name asserts
  something untrue.
- **`gdpr.test.ts:~1356-1369` explains its own premise assertion in terms of
  that vanished sort**: "that `[...].sort()` is the load-bearing line — inert if
  the read already hands them back ascending." The test still bites (§1.4); its
  docblock explains why wrongly.
- **`gdpr.ts:665` prices a loop that no longer exists.** "`waitingCount *
  2_000` covers **the lock loop's own worst case**: `lockClassRow`'s `SET LOCAL
  lock_timeout` bounds **each class's** `FOR UPDATE` wait to 2s, and N contended
  classes can burn that in sequence." There is no lock loop; one statement takes
  one 2s bound. `gdpr.ts:700` likewise places the reorder loop "after the lock
  loop above." The formula `Math.min(5_000 + waitingCount * 2_000, 20_000)` is
  now over-generous rather than wrong — but its stated justification is void.

---

## 2. The helper

In `src/lib/db-locks.ts`, beside `lockClassRow`:

```ts
export async function lockClassRowsOrdered(
  tx: TransactionClientOnly,
  source: { join?: Prisma.Sql; where: Prisma.Sql },
): Promise<string[]> {
  await setLockTimeout(tx);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM "Class" c
    ${source.join ?? Prisma.empty}
    WHERE ${source.where}
    ORDER BY c.id
    FOR UPDATE OF c
  `;
  return [...new Set(rows.map((r) => r.id))];
}
```

It owns five things:

1. **`setLockTimeout` first** — every adopting transaction gets the shared 2s
   bound.
2. **`FOR UPDATE OF c`**, never bare `FOR UPDATE` — a bare one locks the joined
   `WaitlistEntry` rows too, adding edges the lock-order document does not model.
3. **`ORDER BY c.id`** — the whole point.
4. **The returned ids**, so a caller can scope its write to the lock set
   (`syncTemplateInstances` already does; the property `docs/lock-order.md`
   singles it out for).
5. **Dedupe.** Postgres refuses `DISTINCT` alongside `FOR UPDATE`, so every
   joined caller needs it. `withdrawWaitingEntriesForTeacher`'s call-site
   `[...new Set(...)]` moves in here.

### 2.1 Why fragments and not a typed selector

The issue anticipated this decision and leaned against fragments: "A helper
taking a raw fragment defeats the point; one taking a union of typed selectors
is honest but grows a member per site."

Rejecting that. **The predicate was never the thing going stale.** What went
stale — four times in `lock-order.md`, once in `db-locks.ts` — is *which sites
exist and what order each takes*. A fragment helper owns the order, the lock
mode, the bound and the returned ids; the predicate is the one part that is
genuinely different at every site and that no reader has ever been misled by.

Two alternatives were considered and rejected with reasons:

- **A discriminated union of typed selectors** (the issue's own suggestion).
  Cannot go stale — the compiler forces a member for a new site. But it *is*
  the five-row table, re-expressed as a type, and it makes `db-locks.ts` know
  every one of its callers by name. It also pulls `ClassStatus` and waitlist
  status into a module whose docblock currently records that it "pulls in only
  `crypto` and a Prisma type."
- **Two fully-typed helpers, one per query shape.** Same domain leakage, plus a
  measured regression: a typed `statuses` field would bind each status as a
  parameter, and `class-template-lifecycle.ts:653` records that a bound text
  parameter compared against the `status` enum column "needs an explicit
  `::text` cast to resolve — measured to cost the index the pre-lock's `WHERE`
  relies on." The helper would have to render them with `Prisma.raw` anyway,
  re-creating the string concatenation it exists to avoid.
- **An id-list helper** (`lockClassRowsOrdered(tx, ids)`), each site doing its
  own Prisma read first. Fully typed, no fragments, no domain leakage — and
  wrong. `gdpr.ts:389-393` records the property it would destroy: "the part a
  loop cannot have — the lock is taken BY the statement that chooses the rows,
  so there is no window between choosing them and holding them." For
  `deleteStudentAccount`, whose `waitlistEntry.deleteMany` is unscoped, a
  waitlist entry created in that window would be deleted on a class this
  transaction never held. Named here because it is the most attractive of the
  rejected options.

### 2.2 What a fragment call site can still get wrong

All loudly, none silently:

| Mistake | Outcome |
|---|---|
| References `w.` with no `join` supplied | SQL error at runtime — any test on the path fails |
| Puts its own `ORDER BY` in the fragment | Spliced before `ORDER BY c.id` — syntax error |
| Puts its own `FOR UPDATE` in the fragment | Syntax error |
| Interpolates unbound input | Only reachable via `Prisma.raw`, which is greppable and used once in `src/`, for a frozen constant |

The failure modes that produced real `40P01`s in this codebase — a missing
`ORDER BY`, a bare `FOR UPDATE`, an unbounded wait, an unordered heap read
standing in for a lock order — are all owned by the helper and unreachable from
a call site.

### 2.3 Brand

`TransactionClientOnly`, and added to `_theBrandRejectsABareClient` in
`db-locks.test.ts` with a `@ts-expect-error`. On a bare client the `SET LOCAL`
and the `FOR UPDATE` each land in their own autocommit transaction and protect
nothing. `tsconfig.json` includes test files, so weakening the brand is a
failing `tsc --noEmit` rather than a silently passing suite.

---

## 3. The ordering pin

The coverage the branch owes. It must fail when `ORDER BY c.id` is deleted from
the helper.

**Two calls with the same predicate prove nothing.** Two identical statements
produce identical plans, scan the same physical order, and serialise with or
without the clause. What makes the clause load-bearing is two sites reaching
the same rows *by different plans*: the `WaitlistEntry` join returns classes in
`WaitlistEntry` order, a plain `Class` scan returns them in `Class` order, and
those two can disagree.

**Fixture.** Two classes inserted **HIGH then LOW** (so an unordered `Class`
scan returns `[HIGH, LOW]`); their `WaitlistEntry` rows inserted **LOW then
HIGH** (so an unordered join returns `[LOW, HIGH]`). Both natural orders are
asserted as premises before the race, this repo's house rule — a planner or
storage change that makes them agree fails loudly rather than leaving the test
green for an unrelated reason.

**Choreography.** A third transaction locks both rows. Both callers start and
block — A on LOW, B on HIGH. Release the third transaction: each waiter is
granted the row it was waiting on, then reaches for the other's.

- **With `ORDER BY c.id`:** both callers want LOW first, so they queue behind
  each other on one row and serialise. No cycle.
- **Without it:** A holds LOW and wants HIGH, B holds HIGH and wants LOW.
  Guaranteed AB-BA — not a race the test hopes to win.

The third-transaction technique is already used in this codebase
(`gdpr.test.ts:1769`). Asserted by SQLSTATE, not by "it passed": a `40P01`, a
`55P03` and a broken fixture must be distinguishable in the failure output.

The helper's own `setLockTimeout` means a mis-built fixture fails at ~2s with
`55P03` rather than hanging.

---

## 4. Call sites

| Site | Change |
|---|---|
| `deleteStudentAccount` (`gdpr.ts`) | statement → helper |
| `withdrawWaitingEntriesForTeacher` (`waitlist.ts`) | statement → helper; drops its own `new Set` |
| `syncTemplateInstances` (`template-sync.ts`) | statement → helper; keeps `id: { in: lockedIds }` on the re-read |
| `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`) | statement → helper |
| `deleteTeacherAccount` (`gdpr.ts`) | **new** ordered pre-lock — see §5 |

### 4.1 `deleteTeacherAccount`

Today it reads `upcoming` with `orderBy: { id: 'asc' }` **outside** any lock,
then takes one row lock per iteration via the cancel CAS. The read's order *is*
the acquisition order, which is why that `orderBy` is load-bearing and
documented as such.

It gains one ordered pre-lock before that read, and keeps everything else.

**The read stays wide and the CAS stays.** Scoping the read to the pre-lock's
ids would make the write set a structural subset of the lock set — the
`syncTemplateInstances` property — but a class created between the pre-lock and
the read would then escape the erasure entirely. That is an Article 17 gap
traded for a lock-order guarantee the CAS already provides. The pre-lock is for
ordering; the CAS remains the correctness mechanism for the gap, exactly as in
`archiveOrUnarchiveTemplate`.

**The transaction is newly bounded at 2s per statement.** It issues no
`setLockTimeout` today, so every statement waits unbounded, capped only by
Prisma's `{ timeout: 10_000 }` — which, as `gdpr.ts:692` records, "cannot roll
back a statement already blocked inside Postgres, only refuse to start a new
one." Adopting the helper brings the bound with it.

Deliberate, not incidental. It is the same argument `gdpr.ts` already makes for
the student erasure — a legally time-bound operation must not hang on a row the
60-second transitions sweep can hold — and Article 17 does not distinguish the
two subjects. `api/account/route.ts` already routes `deleteTeacherAccount`
failures through `isTransientDbError` to a 503 with retry advice.

The cost, stated: transient failures become more likely on a path that can
already be partially applied (`api/account/route.ts:182` — "NOT the same as
'nothing is half-applied'", because the `completeClass` loop runs before the
transaction opens). Bounded-and-retryable beats unbounded-and-hung for a
time-bound erasure, which is the trade `gdpr.ts` already chose once.

`deleteTeacherAccount`'s `{ timeout: 10_000 }` is **not** resized. Sizing it to
a class count would import the arithmetic whose own justification §1.5 found
stale, which is a second question and not this branch's.

### 4.2 `CANCELLABLE_STATUSES`

`['draft', 'open', 'in_progress']` is hand-typed twice in
`deleteTeacherAccount` (the `findMany` filter and the CAS `where`), and the
pre-lock would make it three. One frozen array, with a `Prisma.raw`-rendered
SQL twin derived from it, following `SCHEDULED_STATUSES_SQL`
(`class-template-lifecycle.ts:664`) exactly — including its reason for
`Prisma.raw` over `Prisma.join`, and its precondition that the values are a
frozen hard-coded constant, never input.

That precedent is not stylistic. `class-template-lifecycle.ts:641-651` records
a *measured* instance of this desync: dropping `'draft'` from one of two
hand-written lists "left every test covering this function green, silently
re-opening the deadlock the pre-lock exists to close."

---

## 5. The test that must not go quiet

`gdpr.test.ts:1344` hooks `class.updateMany` and delays after `casCalls === 1`
— the window between two of `deleteTeacherAccount`'s per-class locks. After the
fold there is no such window: every class lock is held before the first CAS
fires. **Left alone, that test passes while guarding nothing.**

This is the failure shape the previous round's third review caught in this same
area: "one test went vacuously green rather than flaking, which keeps CI quiet
while the guard is gone."

So it is re-pointed as its own task with its own mutation, ordered *before* the
call-site conversion is called done — never as cleanup at the end.

It can still bite. Both sides share one `ORDER BY` now, so deleting it from the
helper gives the teacher side `Class`-scan order and the student side join
order — a real disagreement, the same one §3 constructs. The re-pointed hook
keys on the pre-lock's bound value rather than on the CAS, following this
file's house rule of keying hooks on the query's own arguments rather than on
call sequence.

**If it can only pass vacuously, the docblock says so** and the branch leans on
§3's pin, rather than leaving a green test that certifies nothing. Recorded
either way, with the measurement.

---

## 6. Documentation

- **`docs/lock-order.md`'s within-`Class` table** collapses to "these sites call
  `lockClassRowsOrdered`", plus the archive's documented exception.
- **Its derivation subsection** loses the hand-count (§1.2) in favour of a
  greppable invariant: one production `FOR UPDATE OF c`, in `db-locks.ts`. The
  four-check derivation stays — it is how a *new* site is found — but it no
  longer carries a number that rots.
- **`db-locks.ts`'s register** is corrected (§1.3) and gains
  `lockClassRowsOrdered`.
- **The three stale claims in §1.5** are fixed at source: the variable name, the
  timeout arithmetic, and `gdpr.test.ts`'s docblock.
- **`template-lock-order.test.ts:363-368`** is corrected: the erasure's ordering
  was pinned by `gdpr.test.ts:1344` all along, measured 5/5, and that is what
  the docblock should have said.

Per this project's rule that a claim is corrected in *every* artifact: each of
these is a claim with more than one home, so each fix enumerates its locations
and is verdicted per location, not once.

---

## 7. Risks

1. **`Prisma.Sql` splicing into `$queryRaw`.** Standard Prisma behaviour —
   parameters merge across spliced fragments — but it is the load-bearing
   mechanic of the whole design and is verified empirically in task 1, against
   a real database, before any call site is converted. If it does not hold, the
   signature decision reopens.
2. **The archive's `date > today` residual is not closed here.** A same-day
   instance rescheduled into the future by `updateClass` between the pre-lock
   and the `deleteMany` is still deleted unheld. Widening the pre-lock past
   today would lock history for no gain, and #86/#112 require the delete's live
   predicate re-evaluation regardless. It stays a documented exception in the
   collapsed table — the one thing the table still says beyond "they call the
   helper".
3. **`deleteTeacherAccount`'s new 2s bound raises its transient failure rate.**
   Accepted with reasons in §4.1; the route already answers 503 with retry
   advice.
4. **The re-pointed `gdpr.test.ts:1344` may prove unconstructible.** Mitigated
   by §3's pin, which does not depend on either erasure. Honesty in the
   docblock is the fallback, not silence.

## 8. Out of scope — stated in the PR body

- The archive residual above.
- **#104** — the five single-id `FOR UPDATE`s that take an unbounded wait (four
  inline in `waitlist.ts`, one in `POST /api/registrations`). Retrofitting them
  from here would blur what that issue is accountable for, which is the reason
  `db-locks.ts:169-174` already gives.
- **#238** — nothing reaps closed, unfulfilled `WaitlistEntry` rows, which is
  what makes `deleteStudentAccount`'s lock set grow with account age.
- Resizing `deleteTeacherAccount`'s transaction budget (§4.1).

## 9. Acceptance

- One helper in `db-locks.ts` takes every multi-row `Class` lock that is a
  `FOR UPDATE`, branded and bounded; `grep -rn 'FOR UPDATE OF' src/ --include="*.ts"`
  minus tests and comments returns exactly one production statement.
- Deleting `ORDER BY c.id` from the helper fails §3's pin with `40P01`,
  demonstrated by mutation and restored.
- Deleting it also fails the re-pointed `gdpr.test.ts:1344`, or that test's
  docblock records why it cannot.
- `deleteTeacherAccount` takes its `Class` locks in one ordered statement, and
  its status list exists once.
- `docs/lock-order.md`'s within-`Class` table names the helper and one
  exception, not five independent claims.
- `npm run verify` is green, and the suite totals in the PR body reconcile.
