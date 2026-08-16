# The erasure's transaction budget — and why #243 is closed unbuilt

**Issues:** #240 (fixed here), #243 (closed unbuilt, reasoning below) ·
**Date:** 2026-08-16 · **Branch:** `erasure-budget`

Both were split out of PR #239's review and both live inside
`deleteStudentAccount` (`src/services/gdpr.ts`). This branch fixes one and
closes the other.

**Why one and not both.** PR #239 closed a single issue and filed six
(#240–#245), all in `gdpr.ts` and `db-locks.ts`, from a branch of 6 `refactor`
+ 4 `test` + 4 `docs` + 1 `feat` and zero `fix`. Across the last forty commits
on `main`, `docs:` is the largest single category. That is a review loop
sustaining itself: each pass finds true things about the previous pass's
comments and coverage, which become issues, which justify another pass. #240
survives that scrutiny because it is one constant and forty lines of deletion,
and it removes a contradiction the file currently holds. #243 does not, for
the reasons in §1.4 — reasons that only became visible by verifying its
premise, which is why it gets a section here rather than a one-line dismissal.

---

## 1. What was measured

Thirty-two references were checked against this checkout with `sed -n '<n>p'`
on 2026-08-16, in two batches, rather than trusted. **Thirty-one held. One did
not**, and it was one of this document's own: an earlier draft cited
`docs/lock-order.md:686-689` for the damage an unlocked `WaitlistEntry` delete
can do. Line 689 is blank — the passage is `:684-688`, and it does not contain
the detail cited (`P2025` under a bare 500), which lives in
`gdpr.test.ts:381-386`. Both were corrected before this draft.

That is the worked example, and it is worth one paragraph because of *which*
reference failed: not an inherited one, a freshly written one, checked in the
same session it was written. The plan should re-verify every line number it
leans on rather than inheriting this table — a list that has mostly been right
is not a list that cannot be wrong.

### 1.1 Baseline

```
npx vitest run                        → 120 files, 1392 tests, green
npx vitest run --project unit         →  54 files,  775 tests
npx vitest run --project components   →  38 files,  207 tests
npx vitest run --project integration  →  28 files,  410 tests
```

Arithmetic: `54 + 38 + 28 = 120` and `775 + 207 + 410 = 1392`. The dev server
was up on `:3000` for the integration project.

### 1.2 #240 — every stated fact holds

| Claim | Verdict |
|---|---|
| `timeout` is `Math.min(5_000 + waitingCount * 2_000, 20_000)` | **True**, `gdpr.ts:736` |
| `waitingCount` counts `waiting` only | **True**, `gdpr.ts:318` |
| the pre-lock's join carries no status predicate | **True**, `gdpr.ts:405-408` |
| `lock_timeout` is armed per acquisition, not per statement | **True** — already corrected in prose by `3615c10`, at `gdpr.ts:655-666` and `db-locks.ts:252-260`. The arithmetic at `:736` was not touched. |
| the reorder loop's own per-class cost is uncounted | **True** — `reorderWaitingEntries` (`waitlist.ts:976`) is a `findMany` plus up to M individual `UPDATE`s, each separately bounded by the same 2s |
| a student with 0 `waiting` and 30 closed entries gets 5_000ms against 30 lock requests | **True**, and it follows directly from the two rows above |

### 1.3 #240 — the argument standing against its fix is inverted

Not in the issue, and the load-bearing finding.

`gdpr.ts:289-298` argues *against* sizing on the lock set, in terms strong
enough to stop a contributor:

> Counting every entry instead was a real defect, not a conservative choice
> […] an all-status count is monotone non-decreasing for the life of the
> account. Past the `Math.min` ceiling the erasure would fail, and the retry
> would re-read the same count and fail identically — an account that can
> never be erased, which is not a performance note but an Article 17 failure.

**That does not survive arithmetic.** `Math.min(5_000 + N·2_000, 20_000)` is
monotone non-decreasing in N and capped. For any account, with `A` = all-status
entry count and `W` = `waiting` count, `A ≥ W`, therefore

```
budget(A) = min(5_000 + A·2_000, 20_000)  ≥  min(5_000 + W·2_000, 20_000) = budget(W)
```

An all-status count can only ever grant **more** budget than a `waiting`-only
count for the same account. It cannot produce a failure the smaller count
avoids, so it cannot produce an un-erasable account.

What actually made accounts un-erasable is in `7298311`'s own message: the
`lockClassRow` **loop**, two round trips per class, *measured at 6.0s against
the single statement's 13ms for the same class set*. That commit removed the
loop and reverted the count in one change, and justified the revert with "the
lock cost stops scaling with N." #237's review has since measured that this is
true of **round trips** and false of **waiting** — the correction `3615c10`
wrote into the comment three hundred lines further down, without noticing it
had removed the premise the earlier paragraph stands on.

So the file currently contains both halves of a contradiction: `:289-298` says
the count must be `waiting`-only because the lock statement's cost no longer
scales with N, and `:655-666` says it does. **Removing the count removes the
contradiction, which is most of this branch's value.**

### 1.4 #243 — verified, and closed unbuilt

Its mechanism is real:

| Claim | Verdict |
|---|---|
| `lockClassRowsOrdered` returns its ids so a caller can scope the write | **True**, `db-locks.ts:301-315`, argued at `:286-291` |
| three of five callers discard the return | **True.** Discard: `gdpr.ts:405`, `gdpr.ts:992`, `class-template-lifecycle.ts:1254`. Capture: `template-sync.ts:114`, `waitlist.ts:950`. |
| `withdrawWaitingEntriesForTeacher` passes a near-identical fragment plus `AND w.status = 'waiting'` | **True**, `waitlist.ts:950-955` — and it *does* scope its write to the returned ids (`:962-965`). The asymmetry is exact. |
| the narrowing's only symptom is an intermittent `40P01` | **False** |

**The false claim is the one the issue rests on.** `gdpr.test.ts:400` is an
`it.each` over all five `WaitlistEntry` statuses which holds the class row in a
second transaction and asserts the erasure returned *after* the holder released
(`erasedAfterHolder` — a causal assertion, not a wall-clock one). Adding
`AND w.status = 'waiting'` to the pre-lock makes the erasure never ask for that
row, so four of five cases — `promoted`, `claimed`, `expired`, `removed` —
fail deterministically, with no concurrency required. That test was written for
exactly this mutation; `7298311` records it: *"scoping to `waiting` ∪ `expired`
passed the entire unit suite […] now `it.each` over all five statuses; that
mutation fails three of them."*

So the fix's value is not "catches an otherwise-silent hole" but "makes the
invariant structural rather than test-enforced."

**And the fix costs more than the issue says.** `addToWaitlist` takes the
`Class` row lock, requires `cls.status === 'open'`, and creates or revives an
entry. Nothing stops it running for a student whose erasure is in flight — the
erasure's `session.deleteMany` (`gdpr.ts:558`) is inside the same uncommitted
transaction, so a request that authenticated earlier is still live. If such a
join commits for a class **not** in the lock set, between the pre-lock and the
delete:

- **today** (unscoped `deleteMany`) the entry is deleted, without holding that
  class's row lock — the hole the discipline exists to close;
- **scoped to `lockedIds`** (the issue's fix, verbatim) the entry *survives the
  erasure* — a live queue entry for an anonymised student, who can still be
  promoted and notified.

Making the fix safe therefore needs a postcondition guard, a new exported error
class, a branch in `erasureFailure` (`account/route.ts:64` — `isTransientDbError`
classifies by Prisma code and SQLSTATE and cannot see a service-level error, so
without it the caller is told *"Pressing Delete again will not fix it"* about
the one failure pressing Delete again does fix), and two tests, one racing HTTP
against DB interleaving. **All of that to close a race requiring a student to
join a waitlist during their own account erasure.**

Applied honestly, the fold-or-file tests say no: this change makes the coupling
**visible**, not **worse**; the invariant already has a deterministic detector;
and the residual window cannot be closed anyway, only narrowed, because under
READ COMMITTED there is always a gap between the last check and `COMMIT`.

**Disposition:** closed unbuilt, with §1.4 recorded on the issue. The premise
correction is worth more than the code change would have been — the next
person to look at `deleteStudentAccount` should find "this is already tested,
here is the test" rather than re-deriving it.

---

## 2. The design

`gdpr.ts:318`'s pre-transaction `waitlistEntry.count` is deleted along with the
comment block at `:279-317` that defends it. `:736` becomes:

```ts
timeout: 20_000,
```

**Why flat rather than #240's "size it on the lock set".** The term's only
effect is to choose a number ≤ 20_000, and it prices neither of the two things
that scale — it under-counts the lock set (axis 1) and does not count the
reorder loop at all (axis 2). A term that cannot be made honest, and whose only
possible effect is to grant *less* than the ceiling already permits, is worse
than the ceiling alone. Removing it also removes:

- a round trip before the transaction opens;
- the documented drift window at `:303-317` — the count is read outside any
  transaction and can go stale if a waitlist join lands in the gap — which
  exists solely to compute that term;
- roughly forty lines of comment defending a number that no longer needs
  defending, including the contradiction in §1.3.

`Math.min(…, 20_000)` was already "the only real bound" (`gdpr.ts:672-674` says
so). This makes that true by decision instead of by accident — which is #240's
second option, reached by deleting the term rather than by writing a paragraph
about it.

**What the replacement comment must keep**, because it is measured and nothing
else records it:

- `lock_timeout` is armed per acquisition, not per statement, with the
  2026-08-16 measurement (two rows held by sessions releasing at 1.5s and 3.0s,
  one waiter at `lock_timeout='2s'` taking both in one statement, succeeded
  after 2.67s);
- `SET LOCAL lock_timeout` governs every remaining statement in the
  transaction, not only the `FOR UPDATE`, with the round-2 measurement
  (`registration.updateMany` failing at ~2086ms with `55P03`);
- why 20s and not more: the single 2GB VPS, one Postgres connection pool;
- why P2028 is safe: the function is one transaction end to end and its only
  post-commit work swallows its own errors, so a throw means nothing landed —
  which is what `erasureFailure` relies on to say "Nothing was changed";
- that #238 remains the root fix for the lock set growing with account age.

**What it must add:** §1.3's correction, stated as a correction. The paragraph
that argued the opposite is being deleted, and a future contributor who finds
`7298311` in `git log` will find that argument still standing there.

**What it must not claim:** that a flat budget bounds the transaction's real
cost. It bounds how long Prisma will let it *start new statements*; a statement
already blocked inside Postgres is bounded only by `lock_timeout`, per
acquisition. That asymmetry stays exactly as documented.

---

## 3. The test, and the mutation that proves it

One guard, and it carries the whole branch — so its construction matters more
than usual.

**G1 — `gdpr.test.ts`, new.** A student with **zero** `waiting` entries and
closed entries in N classes. N holders take those class rows and release in
**ascending class-id order**, staggered, so that every individual lock wait is
comfortably under the 2s `lock_timeout` while the statement's total elapsed is
comfortably over 5_000ms. The erasure must complete.

**Mutation:** restore `Math.min(5_000 + waitingCount * 2_000, 20_000)` → the
erasure must fail with `P2028`. With zero `waiting` entries that budget is
5_000ms flat, which is the defect #240 describes, reproduced.

Three things about G1 that must be got right, and are cheaper to state here
than to discover:

1. **The two margins are in tension, and both must be wide.** Total elapsed
   must exceed 5_000ms or the mutation passes and the test proves nothing; no
   single wait may reach 2_000ms or the *fixed* code fails with `55P03`.
   **Six classes at 1.5s each**: total ≈9s (4s of margin over the 5s budget),
   each wait ≈1.5s (500ms of margin under the 2s bound). The obvious
   three-at-1.8s version has 400ms and 200ms of margin respectively and will
   flake. `4eb41a0` ("fix a Sunday-morning flake in the refill test") is the
   recent precedent for what getting this wrong costs.
2. **Release order must follow class id, not creation order.** The pre-lock is
   `ORDER BY c.id`, so it waits on the lowest id first. Ids are UUIDs, so
   creation order is not id order — the test must sort the created ids and
   assign hold durations by sorted position. Get this wrong and the waits do
   not stagger: the erasure blocks once on whichever row is released last, that
   single wait exceeds 2s, and the test fails against the *fixed* code.
3. **Holders must release on a server-side clock where practical.** A JS timer
   that fires 300ms late lengthens a real Postgres lock wait from 1.5s to 1.8s
   and eats most of the margin in (1). The plan should decide between
   `pg_sleep` inside the holding transaction and JS timers, and record why.

**Not re-tested:** `gdpr.test.ts:400`'s five-status `it.each`. It is untouched
by this branch and remains the detector for the lock-set narrowing — §1.4's
whole point. The plan must confirm it still passes, not rewrite it.

---

## 4. Every artifact that asserts the removed claim

The sweep below is by *file and reason*, not by keyword, and this branch has
its own worked example of why. The first sweep run here was ``grep -rn "sized
\`timeout\`" src docs`` — three hits, and it **missed `account/route.ts:27-28`,
where "sized" and "`timeout`" sit on opposite sides of a line break.**
Broadening to `grep -rn "sized" src docs/lock-order.md` found seven, that file
among them. Neither number is the census; the table is.

| File | What is wrong after this branch |
|---|---|
| `src/services/gdpr.ts:283` | *"a fixed transaction budget can't be 'sized to the worst case' honestly"* — the premise for a term being deleted |
| `src/services/gdpr.ts:289-298` | the inverted argument in §1.3 |
| `src/services/gdpr.ts:303-317` | the drift window of a count that no longer exists |
| `src/services/gdpr.ts:387` | cross-reference to `waitingCount` |
| `src/services/gdpr.ts:631-736` | the whole `timeout` comment: the base-term arithmetic, `waitingCount * 2_000` in three places, and *"covers up to 7 fully-contended classes before the cap binds"* |
| `src/lib/db-locks.ts:161-165` | *"its call site sizes the erasure transaction's own `timeout` to the number of classes it is about to lock; the arithmetic lives there, not here"* |
| `src/lib/api-errors.ts:122` | *"`deleteStudentAccount`'s sized `timeout`"* |
| `src/app/api/account/route.ts:27-28` | *"`P2028` from `deleteStudentAccount`'s sized `timeout`"* (wraps across the line break) |
| `src/app/api/class-templates/route.ts:121-122` | quotes the formula verbatim |
| `docs/lock-order.md:700-710` | *"The single statement makes the lock cost O(1) statements, so the budget is sized by the reorder loop's `waiting` count"* — the O(1) claim is what #240 falsified |
| `docs/lock-order.md:910` | see below |

**`docs/lock-order.md:910` needs more than a wording fix.** It argues part of
#229's open decision on the grounds that `deleteStudentAccount` has a *tuned*
budget where `deleteTeacherAccount` has a flat `10_000`, and that *"the tuned
budget is the one that would absorb a re-ordering and the flat one is not."*
After this branch both are flat, so that half of the argument dissolves. It is
corrected here, and the effect on #229 is stated in the PR body rather than
left for whoever picks #229 up to discover.

Historical specs and plans under `docs/superpowers/` that quote the old formula
are records of what was believed at the time and are **not** edited. Live
reference docs are.

---

## 5. Out of scope

- **#243** — see §1.4. Closed unbuilt; nothing in `deleteStudentAccount`'s
  lock/write-set coupling changes here. `db-locks.ts:286-291`
  (*"Callers that do not need them may ignore the return value"*) is
  **not** edited: it is #245's subject and remains true.
- **#238** remains the root fix for the lock set growing with account age, and
  the new comment must still say so.
- **#241, #242, #244, #245 are unaffected.**
- No behaviour changes outside the transaction's `timeout` option.

---

## 6. Risks

1. **G1 is the only test on the branch and it is a timing test.** Its two
   margins pull in opposite directions (§3). If it cannot be made reliable, the
   fallback is *not* to drop it silently — it is to say so in the PR body and
   ship the constant unproven, which is a finding, not a shrug.
2. **The flat 20_000 lets a failing erasure hold a pool connection for 20s
   where it previously gave up at 5s.** Accepted at the gate: erasures are
   rare, one per account, and failing four times faster at something the user
   must then retry is not a win for a legally time-bound operation.
3. **The comment rewrite is large and mostly deletion.** The measured facts
   listed in §2 must survive it. The plan should treat "these specific
   measurements are still present" as a checklist item, not an intention.
