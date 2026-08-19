# Completing the `Class` row-lock convention (issue 104)

**Status:** design, awaiting review
**Issue:** 104 — "Row-lock call sites have no lock_timeout, including the student booking path"
**Date:** 2026-08-19

---

## 1. What this is

Four production sites take a `Class` row lock with a bare inline
`SELECT … FOR UPDATE` and no `lock_timeout`. This branch converts all four to
`lockClassRow` (`src/lib/db-locks.ts`), which issues `setLockTimeout` and then
the identical statement.

The framing matters more than the diff, and it is not the issue's framing. This
is not "add a timeout to four sites". It is **the last step of #237's thesis** —
*"a convention tracked by prose goes stale; this function is the convention."*
After this branch, every production `Class` row lock goes through
`src/lib/db-locks.ts`, and `grep 'lockClassRow('` is the complete answer to
"who locks a class". The exception list is deleted rather than updated, and a
deleted list cannot rot.

That distinction decides the scope. Bounding only the booking path — the case
the issue calls sharpest — would leave the list, and the list is the defect.

---

## 2. Premise verification

Every claim in the issue was re-derived at HEAD (`af6dda0`). Three of them have
changed, and the issue's own update comment is stale in the opposite direction
from the issue body.

### 2.1 The count of four is correct — the update comment's "five" is not

Method: `grep -rn "FOR UPDATE" src/ --include='*.ts'`, minus `.test.ts` files,
minus lines that are comments (`^\s*(\*|//)`). This is a full census, not a
`head`-limited grep.

**8 statements. Split 4 bounded / 4 unbounded:**

| Bounded | Vehicle |
|---|---|
| `lockClassRow` (`lib/db-locks.ts`) | `setLockTimeout` |
| `lockClassRowsOrdered` (`lib/db-locks.ts`) | `setLockTimeout` |
| `claimTemplateForGeneration` (`services/class-generator.ts`) | `LOCK_TIMEOUT_SQL` |
| `claimStudioTemplateForGeneration` (`services/studio-class-generator.ts`) | `LOCK_TIMEOUT_SQL` |

| Unbounded — this branch's subject | Route |
|---|---|
| `addToWaitlist` (`services/waitlist.ts`) | `POST /api/waitlist` |
| `promoteNext` (`services/waitlist.ts`) | none — called by `handleSpotFreed` and `reconcileWaitlists` |
| `claimSpot` (`services/waitlist.ts`) | `POST /api/waitlist/claim` |
| booking (`app/api/registrations/route.ts`) | `POST /api/registrations` |

The issue's update comment (from #174 / PR #179) says the count of four is stale
and the real number is five, naming `withdrawWaitingEntriesForTeacher`. **That
was true at #179's HEAD and is false now:** #237 moved that function onto
`lockClassRowsOrdered`, which took its statement off the inline list and its
wait off this issue's list in the same edit. `docs/lock-order.md` records the
transition and warns explicitly against substituting another name into the
vacated slot to keep the count at four.

So the issue's *original* enumeration is right again, by coincidence rather than
by having stayed right. Both artifacts need correcting: the issue body's four is
accurate, its comment's five is not.

### 2.2 The comment's "sixth shape" is already fixed

The comment says `deleteTeacherAccount` takes a `Class` row lock per iteration
via a status-predicated CAS with no `lock_timeout` and a flat
`{ timeout: 10_000 }`, so "the two halves of one erasure currently get different
treatment".

`deleteTeacherAccount` (`services/gdpr.ts`) now calls `lockClassRowsOrdered`,
whose `setLockTimeout` bounds every statement left in that transaction. Its own
comment states the change. The asymmetry the comment describes is closed;
nothing in this branch's scope.

### 2.3 The "Related" paragraph belongs to issue 122

The issue's closing section proposes catching `55P03` in the generator claim so a
benign lock loss stops reporting as a red job on `/api/health`.

Issue 122 is open and covers exactly this, with a more precise diagnosis (the
full five-step propagation from `claimStudioTemplateForGeneration` through
per-template isolation, `throw errors[0]`, `scheduler.ts`, to `JobHealth`), a
named suggested fix, and an adjacent pre-existing finding about `Promise.all`
discarding the second rejection.

**Out of scope here.** Building it in this branch would be a second copy of an
existing issue's work. Issue 122 is unaffected by this branch and stays open.

### 2.4 The load-bearing premise is false at HEAD

The issue says:

> the final review confirmed the lock *sets* are disjoint today … so there is
> no contention right now and no cycle. This is about the shape being fragile as
> more lockers appear, not a live bug.

That was true when filed. The lockers appeared. At HEAD, real contenders take
the same `Class` rows these four sites lock:

- **`autoCancelClasses`** (`services/class-transitions.ts`) takes a `FOR UPDATE`
  on in-window open classes **every 60 seconds**. Its own comment: *"every
  concurrent registration on one of those classes queues behind a lock taken
  purely to confirm nothing needed doing."*
- **`autoTransitionToInProgress`** (same file) and **`completeClass`**
  (`services/class-lifecycle.ts`) lock through `lockClassRow`.
- **`deleteStudentAccount`** and **`deleteTeacherAccount`** (`services/gdpr.ts`)
  hold ordered `Class` locks across erasure transactions budgeted at 20 s and
  10 s respectively.

The roadmap entry for this issue says it is *"the kind of thing that belongs in a
code comment rather than the tracker; keep it only if the booking path's
unbounded wait starts to matter."* This is the condition it named, met.

### 2.5 "Waits indefinitely" is right about the wait and wrong about the outcome

The issue implies an unbounded hang. The measured behaviour, recorded in
`services/waitlist-reconciliation.test.ts` on 2026-08-13, is more specific:
`promoteNext` blocked behind a 7 s hold **failed at 7014 ms with `P2028`** — it
waited out the entire hold and failed afterwards.

And `P2028` is already in `TRANSIENT_PRISMA_CODES` (`lib/api-errors.ts`), so it
maps to 503 with retry advice, not 500. All three affected routes go through
`withErrorHandler`, verified at HEAD.

So today's surface is: **occupy a pool connection for the full blocking
duration, then 503 anyway.** This branch is not an error-quality fix — that
surface already exists. It is a *connection-occupancy* and *convention*
fix. Recording this because it changes what the PR body may claim.

---

## 3. The design decision, and the arithmetic behind the value

### 3.1 Two knobs, one budget

There are two timeouts in play and they bound different things:

- **`lock_timeout`** — Postgres, armed **per lock acquisition**, and it
  *cancels a blocked statement* (`55P03`).
- **Prisma's transaction `timeout`** — client-side, and it can only *refuse to
  start the next statement*. It cannot cancel one already blocked inside
  Postgres (`P2028`).

`gdpr.ts` states this at length in its "WHAT THIS DOES NOT BOUND" paragraph. The
7014 ms measurement is the asymmetry made visible: the verdict arrived at 7 s,
not at the 5 s budget, because the budget could not touch the blocked statement.

All four sites open a bare `db.$transaction(async (tx) => …)` with **no options**,
so all four carry Prisma's default 5 s budget. The `FOR UPDATE` is the first
statement in all four.

### 3.2 What a bound of `T` costs and buys

For a competing hold of duration `h`, today:

- `h < 5 s` → lock acquired at `h`, remaining statements run, **request succeeds**.
- `h > 5 s` → waits the full `h`, then the next statement is refused → `P2028` → 503.

Adding `lock_timeout = T`:

- **Buys:** for `h > 5 s` — the erasure holding up to 20 s — failure at `T`
  instead of at `h`, **freeing a pool connection for `h − T` seconds**. On one
  2 GB VPS with a single pool this is the operational prize, and it connects to
  issue 232 (a drained pool logged as a lost lock race).
- **Costs:** for `T < h < 5 s` — a request that would have succeeded now
  returns 503.

### 3.3 Why 2 s, and why not larger

The wait and the work come out of the same 5 s budget. A bound of `T` leaves
`5 − T` seconds for everything after the lock.

How much work is left is measured, not assumed. Counting `await` statements
between the lock and the end of each transaction, as written:

| Site | Statements after the lock | Heaviest among them |
|---|---|---|
| `addToWaitlist` | 8 | `teacherStudent.upsert`, `resolveInvitationOnLink` |
| `promoteNext` | 11 | `activateRegistration`, `createBulkNotifications`, `reorderWaitingEntries` |
| `claimSpot` | 9 | `activateRegistration`, `createBulkNotifications`, `reorderWaitingEntries` |
| `POST /api/registrations` | 12 | `reorderWaitingEntries`, `class.update`, `teacherStudent.upsert`, `createBulkNotifications` |

(`promoteNext`'s count includes statements inside its candidate-selection loop,
so the number executed varies; the others are straight-line.)

At **T = 2 s**: 3 s remain for 8–12 statements. Ample.

At **T = 4 s**: 1 s remains for the same 8–12 statements, several of which are
writes that take **their own** row locks — `teacherStudent.upsert`,
`waitlistEntry.update`, `class.update`, and `reorderWaitingEntries`, which walks
the queue. This does *not* preserve the success window as it first appears to:
it converts slow success into **`P2028` after the lock was won and the work was
done and thrown away**. Nothing partial survives — `P2028` aborts the
interactive transaction and Postgres rolls it back — so the cost is not a
half-written state but a connection held for the full wait plus the work, and a
student who gets a 503 having occupied a pool slot the whole time. Still worse
than failing before touching anything, for the same reason a smaller `T` leaves
more of the 5s budget: the conclusion below is unaffected.

There is a compounding reason the slack must be generous: `SET LOCAL
lock_timeout` governs **every** lock acquisition left in the transaction, not
just the first. `db-locks.ts` documents this and warns that a few contended
acquisitions can exhaust the budget between them. So the worst case is `T` for
the `Class` row **plus up to `T` again per contended write among the 8–12
that follow**, against a 5 s budget. At 2 s that leaves room for one contended
write and change; at 4 s the first contended write alone blows it.

The booking route is the sharpest case on this axis as well as the issue's: 12
statements, four of them lock-taking writes.

So 2 s is not inherited for consistency. It is the largest bound that leaves the
work a viable share of the budget. It also happens to be `LOCK_TIMEOUT_SQL`, the
existing shared constant, which is what keeps contending waits "the same length
by construction rather than by coincidence".

**Decision: all four sites adopt `lockClassRow`, at the existing shared 2 s. No
new constant.** Introducing a second timeout constant would recreate the
two-tier prose distinction #237 existed to delete — trading a stale membership
list for a stale policy list, which is the same disease.

### 3.4 The cost, stated honestly

A competing hold between 2 s and 5 s turns a slow success into a 503 on three
student-facing routes.

I judge this close to empty in practice, because holds on a `Class` row are
bimodal: routine writers (`autoCancelClasses`, `completeClass`,
`autoTransitionToInProgress`) hold for tens of milliseconds, and GDPR erasures
hold for seconds up to their 20 s ceiling. Very little lives in the 2–5 s band.
And the 503 carries retry advice, so the cost is one extra round trip rather
than lost work.

**That is reasoning from the code, not measurement.** No production telemetry
exists to confirm the distribution. Stated as an assumption so a reviewer can
challenge it rather than inherit it.

---

## 4. What changes

### 4.1 The four sites

Each replaces its inline statement with the helper. No signature changes — all
four already have a `tx` inside their own `db.$transaction`, which satisfies
`TransactionClientOnly`.

```ts
// before
await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
// after
await lockClassRow(tx, classId);
```

- `addToWaitlist`, `promoteNext`, `claimSpot` (`services/waitlist.ts`) — the
  file already imports `lockClassRow`.
- `app/api/registrations/route.ts` — needs the import added.

### 4.2 `promoteNext` is the one with a behavioural consequence

The other three are routes: their failure surface is a 503 a human sees, already
wired. `promoteNext` is not a route. It is called by `handleSpotFreed` (which
logs and swallows) and by `reconcileWaitlists`. Its failure surface is *the
reconciliation sweep repairing it later*.

Bounding it changes **which mechanism** drops an auto-promotion: from `P2028`
after the full hold, to `55P03` at 2 s. The sweep already handles both — its
docblock names both — and handles the bounded one sooner. So the change is an
improvement, but it invalidates a test that pins the current mechanism
deliberately. See §6.

**A knock-on this section did not predict, added after Task 3 found it.** The
mechanism change also inverts an *ordering*, not just an error code. The
reconciliation test tracks whether the lock holder had already released by the
time `handleSpotFreed` returned. Under `P2028` the call waited out the entire
hold, so the holder always had released — the assertion was `true`. Under
`55P03` the call gives up at 2 s while the holder still has 1.5 s of its 3.5 s
hold left, so it has **not** — the assertion becomes `false`.

Worth recording because of how it looks in a diff: an inverted boolean
assertion in a test the change does not obviously touch is indistinguishable,
by inspection, from an assertion flipped to force a green suite. It was
re-derived independently from the three timings (hold duration, the 2 s bound,
the 5 s budget) before being accepted. Any future change to the bound must
re-check it, since it depends on the bound being *shorter* than the hold.

### 4.3 A consequence worth naming: `P2028` largely leaves these paths

Once every lock wait at these sites is capped at 2 s under a 5 s budget, `P2028`
is no longer reachable *via the lock path* here. It remains reachable through
non-lock slowness (pool saturation, a slow query), so it must not be described
as impossible — but every piece of prose that explains `P2028` at these sites
**as a lock-wait outcome** becomes wrong.

This is the single most likely place for a half-correction, because the affected
prose does not contain the string `#104`. See §5.

---

## 5. The correction surface

**Twenty** locations need a verdict. Per the process's §4 rule they are
enumerated individually, because a finding that names N locations gets N
verdicts, not one.

They are grouped by **how they were found**, and that grouping is the point:
§5.1 by keyword (9), §5.2 by reconciling the diff (5), §5.3 by sweeping for the
old *shape* (6). This document said thirteen when it was written, then fourteen,
and the true figure is twenty. Read §5.3 before trusting any list here.

> **This section was itself one location short, and that is worth recording
> rather than silently fixing.** It shipped saying thirteen. Task 3's
> implementer, working from it, found a **fourth** stale cross-reference in
> `waitlist-reconciliation.test.ts` — inside the test `reconciles the remaining
> classes when one loses its lock race`, which named the old test by name *and*
> by mechanism. A subsequent exhaustive sweep by that task's reviewer confirmed
> there is no fifth.
>
> So the document that exists to stop a finding being half-corrected was itself
> incomplete about its own enumeration — the second time this spec has caught
> that failure in its own §5, after the misfiled `registrations/route.ts` row
> recorded below. Both were found by someone re-deriving the list rather than
> reading it. That is the only method that works.

The grep that bounds the first group, so a reviewer can check the enumeration is
complete:

```
grep -rn "#104\|issue 104" src/ docs/ --include='*.ts' --include='*.md' \
  | grep -v "docs/backlog-roadmap.md" | grep -v "docs/superpowers/" | grep -v "\.test\.ts:"
```

**Returns 11 lines across 9 locations.** The two numbers differ because
`db-locks.ts` (2 lines, two adjacent paragraphs handled as one edit) and
`docs/lock-order.md` (2 lines, one paragraph) each match twice.
`capacity.ts` also matches twice but gets **two** rows, because its two
paragraphs need different verdicts. Lines are not locations, and neither is the
unit of work.

> **A warning this section earned the hard way.** An earlier draft of this spec
> put `app/api/registrations/route.ts` in the table below. It does not contain
> `#104` — its comment cites #107 and #212 — so it belongs in §5.2, and the grep
> above proves it. Moving it took §5.1 from 10 rows to 9 and §5.2 from 3 to 4,
> leaving **the total unchanged at 13 while the membership moved**. That is
> precisely the failure `docs/lock-order.md` warns about and that §2.1 of this
> spec quotes approvingly. It is recorded rather than quietly fixed, because the
> next person to edit these lists will be one keystroke from repeating it.

### 5.1 Locations that name #104 — 9 rows, 11 grep lines

| # | Location | Verdict required |
|---|---|---|
| 1 | `lib/db-locks.ts` — the "Four pre-existing `FOR UPDATE` sites deliberately do NOT use this" paragraph, and the "It was FIVE until #237" paragraph that follows it | **Delete both.** The exception list is empty. Replace with one sentence stating the convention is now total. |
| 2 | `lib/scheduler.ts` — "`promoteNext`'s inline `FOR UPDATE` is unbounded (#104), so a contended tick can outlast its own interval" | **Rewrite.** The lock wait is now bounded, so a contended tick cannot outlast its interval *on a lock wait*. The `job.running` guard sentence stays. |
| 3 | `services/waitlist.ts` — `removeFromWaitlist`'s comment contrasting its bounded wait with "those four inline sites' unbounded wait (#104; not this branch's to fix)" | **Rewrite.** The contrast no longer exists. |
| 4 | `services/waitlist.ts` — `handleSpotFreed`'s "`lockClassRow`, not the inline `FOR UPDATE` the three functions above use … This site is new, so it takes the bounded 2s wait from the start" | **Rewrite.** All four now take it. The paragraph's *other* claim — that a class row held longer than 2 s drops the broadcast entirely — stays true and must survive. |
| 5 | `services/waitlist.ts` — `reorderWaitingEntries`' docblock, "see `src/lib/db-locks.ts` for the bounded-vs-unbounded split (#104) that remains among the ones that do lock" | **Rewrite.** There is no split. |
| 6 | `services/class-template-lifecycle.ts` — "`POST /api/registrations` holds its `Class` row `FOR UPDATE` … one of the deliberately UNBOUNDED sites `db-locks.ts` names (#104)" | **Partial rewrite — read carefully.** This paragraph is about the booking's *hold*, not its *wait*. Its conclusion — "a student booking one instance can now time a teacher's edit out at 2s" — **stays true**, because this branch does not shorten how long a booking holds the row. Only the "deliberately UNBOUNDED" clause is wrong. Deleting the whole paragraph would remove a still-true hazard. |
| 7 | `services/capacity.ts` — `readSeatCount`'s "Every caller takes that lock first: four via their own inline `SELECT … FOR UPDATE` (the sites `db-locks.ts` reserves for #104), the waitlist broadcast via `lockClassRow`" | **Rewrite.** All five callers now go through `lockClassRow`. |
| 8 | `services/capacity.ts` — "This function deliberately does NOT take the lock itself. Doing so would retrofit `lockClassRow`'s bounded 2s wait onto those four pre-existing sites, which `db-locks.ts` reserves for #104" | **Rewrite — the rationale evaporates.** This paragraph's entire stated reason for not taking the lock disappears with this branch. A replacement reason must be written or the paragraph deleted; see §7 on issue 219. |
| 9 | `docs/lock-order.md` — the paragraph beginning "The single-id `FOR UPDATE`s remain plural and inline", through the #237 four-to-three narrative | **Rewrite.** Keep the multi-row invariant (`lockClassRowsOrdered` is the only production `FOR UPDATE OF c`); replace the inline-list paragraph with the completed convention. Keep the standing warning about counts staying right while membership changes — it is what makes the new claim checkable, and §5's own preamble is a fresh example of it firing. |

### 5.2 Locations that must change but do **not** contain `#104`

**These are the ones a keyword sweep cannot find.** The process's §4 rule applies
directly: derive the post-fix sweep from the wave's diff, not from a keyword.

| # | Location | Verdict required |
|---|---|---|
| 10 | `app/api/registrations/route.ts` — the `#107` comment: "`waitlist.ts` takes this same lock in four places and reads under it in all four — `addToWaitlist`, `promoteNext` and `claimSpot` inline, and the #212 broadcast via `lockClassRow`, which issues the identical statement. This is the fifth." | **Rewrite.** All five are now the same call, so the inline/helper distinction the sentence turns on is gone. The surrounding #107 argument — that the read happens *under* the lock — stays true and must survive. Cites #107 and #212, never #104, which is why the keyword sweep misses it. |
| 11 | `services/waitlist-reconciliation.ts` — the module docblock, "the auto-promote branch blows Prisma's default 5s interactive-transaction budget with `P2028`, measured at 7014 ms against a 7 s hold — it waits out the whole hold and fails afterwards" | **Rewrite.** After this branch the auto-promote branch aborts at 2 s with `55P03` like the broadcast branch. The 7014 ms measurement becomes a historical note and must be **marked** as such rather than silently deleted — it is the evidence for the Prisma-cannot-cancel claim, which stays true and is relied on by `gdpr.ts` and by §3.1 of this spec. |
| 12 | `services/waitlist-reconciliation.test.ts` — the test `repairs an auto-promotion dropped by the transaction budget`: its **name**, its docblock (the 7 s hold and the 7014 ms measurement), and its 7 s hold value | **Rewrite.** See §6.3. |
| 13 | `services/waitlist-reconciliation.test.ts` — the cross-reference inside `promotes the queue head of a class with a free seat`, which names both drop tests by name *and* by mechanism | **Rewrite.** Renaming location 12 breaks this reference; leaving the mechanism unchanged leaves it lying. |
| 14 | `services/waitlist-reconciliation.test.ts` — a **second** cross-reference, inside `reconciles the remaining classes when one loses its lock race`, likewise naming the other drop test by name and by mechanism | **Rewrite.** Missed by this spec's first draft; found by Task 3's implementer. Same treatment as 13 — and do **not** flatten the two drop tests into one, since they cover different branches of `handleSpotFreed` and only their *mechanism* converged, not their subject. |

Locations 10–14 are why this branch's re-review must reconcile against the
**diff**, not a keyword. A `grep '#104'` sweep returns clean while all five sit
untouched — location 10 was misfiled in this spec's first draft for exactly that
reason, and location 14 was missing from it altogether.

### 5.3 Locations neither sweep could find — the concept axis

**Six more, found only after the branch was built, by sweeping for the old
*shape* rather than for the issue number or the diff.** They are numbered 15–20
and they are the most important part of this section.

| # | Location | Why both earlier sweeps missed it |
|---|---|---|
| 15 | `services/waitlist.ts` — `reorderWaitingEntries`' docblock: "`POST /api/registrations` — its own `FOR UPDATE` on the `Class` row" | No `#104`. Worse: it sits **inside a paragraph Task 5 itself edited**. |
| 16 | `docs/lock-order.md` — "Three different statements take that lock and all three count: `lockClassRow`, an inline `SELECT … FOR UPDATE`, and a compare-and-swap" | No `#104`, and it **contradicts a claim the same task wrote 140 lines below it in the same file**. |
| 17 | `services/class-transitions.ts` — "each via its own inline `SELECT … FOR UPDATE` rather than through this helper; `db-locks.ts` records those inline sites as deliberately not adopting it" | No `#104`; file absent from the diff. Its second half names the list this branch deleted. |
| 18 | `services/class-transitions.ts` — a second paragraph asserting in the present tense that five named functions "all do" an inline `FOR UPDATE` | Same file, different paragraph. Fixing 17 alone would have left this standing. |
| 19 | `services/class-template-lifecycle.ts` — "`POST /api/registrations` does take `SELECT … FOR UPDATE` on the class row inline … (`db-locks.ts` lists it as one of five deliberate inline sites)" | No `#104`. **Contradicts `:277-282` in its own file**, which Task 4 corrected. |
| 20 | `services/email-fallback.ts` — "`POST /api/registrations` takes `FOR UPDATE` directly" | No `#104`; found by the fixer's own concept sweep, not by any review. |

**The lesson, stated plainly because it cost a fix round.** This section already
knew that a keyword sweep was insufficient and said so — §5.2 exists precisely
to hold locations that do not contain `#104`. It then derived §5.2 from a
keyword **and** the branch diff, and called that complete. Neither axis can see
a paragraph that describes the old shape without naming the issue and lives in a
file the branch never touches. `class-transitions.ts` and `email-fallback.ts`
are both in that category.

**Three axes are required, not two:**

1. **Keyword** — `grep '#104'`. Finds locations 1–9.
2. **Diff** — reconcile the files changed against the files that should have
   changed. Finds 10–14.
3. **Concept** — sweep for the vocabulary of the thing being removed: `inline`,
   `unbounded`, `deliberately`, `one of the five`, `three different statements`,
   and `FOR UPDATE` appearing in prose. Finds 15–20.

The third is the one that generalises: **when a change makes a claim false,
search for the claim, not for its citation.** Two of these six sat inside or
beside text the fixing task had just edited, so proximity is no protection
either.

One honest limit, recorded rather than papered over: the concept sweep used a
fixed vocabulary list, not a semantic audit. It is thorough, not provably
exhaustive.

### 5.4 Deliberately not edited

`docs/superpowers/plans/` and `docs/superpowers/specs/` contain ~20 further
`#104` references. These are historical records of what was true when written.
Editing them would falsify the record. **Not touched.**

`docs/backlog-roadmap.md` is updated once, at the end of the round, per process.

---

## 6. Testing

### 6.1 The new guards: one per site

Four tests, one per converted site, each proving the wait is now bounded.

**The hold duration is load-bearing and must sit in the 2–5 s band.** 3.5 s,
matching the existing sibling test `reconciles the remaining classes when one
loses its lock race`. The reasoning:

- **With** the bound: fails at ~2 s with `55P03`. ✓
- **Without** the bound: waits 3.5 s, acquires the lock, **succeeds**. ✓ the
  test fails, which is what makes it a guard.

A 7 s hold would **not** distinguish: unbounded gives `P2028`, bounded gives
`55P03`, and a test asserting merely "throws" passes against both. So each test
must assert the **specific SQLSTATE**, not that an error occurred.

### 6.2 Mutation, per guard (process §3)

For each of the four: revert that site to the bare inline `FOR UPDATE`, run the
test, **record the exact failure text**, restore, re-verify. The mutation is the
realistic regression — it is literally the code that is there today — which
satisfies the "break it the way it actually broke" rule.

A guard that still passes with `setLockTimeout` removed certifies nothing and
must be rewritten, not explained.

### 6.3 The re-pinned reconciliation test

The two existing drop tests cover **different branches** of `handleSpotFreed`,
and that distinction survives:

| Test | Branch | Mechanism today | Mechanism after |
|---|---|---|---|
| `repairs an auto-promotion dropped by the transaction budget` | auto-promote (`promoteNext`) | `P2028` at 7014 ms | `55P03` at ~2 s |
| `reconciles the remaining classes when one loses its lock race` | broadcast (`lockClassRow`) | `55P03` at ~2 s | unchanged |

**They do not converge**, because the branch each exercises is different and the
sweep's design rests on that split. The first test keeps its subject and changes
its mechanism: hold shortened 7 s → 3.5 s, assertion `P2028` → `55P03`, name
changed (it is no longer "the transaction budget" that drops it), docblock
rewritten, and the cross-reference in the third test updated to match.

### 6.4 End-to-end

At least one integration test proving `POST /api/registrations` answers **503
with retry advice** — not 500, not a hang — while another connection holds the
class row past 2 s. This pins the user-visible contract, which is the thing the
issue actually cares about.

### 6.5 Suites

`npm run verify` (typecheck + lint + all three vitest projects) before pushing.
It needs the app running on :3000 — confirmed running at time of writing.

**Baseline, measured at HEAD `af6dda0` on 2026-08-19.** Not inherited from any
earlier document — every figure below came from a run made for this spec.

| Project | Files | Tests |
|---|---|---|
| `unit` (`src/**/*.test.ts`) | 63 | 934 |
| `integration` (`tests/integration/**/*.test.ts`) | 31 | 437 |
| `components` (`src/{components,app}/**/*.test.tsx`) | 41 | 242 |
| **Total** | **135** | **1613** |

Both totals reconcile, and each was arrived at twice by independent routes:

- Files: `63 + 31 + 41 = 135`, matching the 135 reported by a full
  `npx vitest run`, and matching a `find` over the three projects' globs.
- Tests: `934 + 437 + 242 = 1613`, matching the 1613 reported by the same full
  run. The per-project figures come from three separate
  `npx vitest run --project <name>` invocations, so the total is a
  cross-check rather than a restatement.

All 1613 pass at HEAD; full-suite duration 197 s. The three projects' globs are
disjoint by construction (the config says so, and the file counts confirm it —
no file is collected twice).

**Predict, then measure anyway.** This branch adds four guards and re-pins one
existing test, so the expected after-figure is 1613 + 4 = **1617**: `unit` gains
three (`addToWaitlist`, `claimSpot`, `promoteNext`) and `integration` gains one
(the booking route). The re-pin modifies a test rather than adding one.

An earlier revision of this section said 1618, counting the booking-route guard
and the §6.4 end-to-end 503 proof as two tests. The plan merges them into one
integration test, which is both of those things at once — the booking route has
no unit test home, and asserting the real HTTP 503 is strictly better evidence
than asserting a thrown SQLSTATE. Corrected here rather than only in the plan.

The implementer must **measure** the real figure rather than assert this one —
the prediction cannot know what the branch's own review will add. On #212 the
predicted 1294 came out at 1296 for exactly that reason.

---

## 7. Relationship to other open issues

**Issue 219 — `readSeatCount`'s lock precondition is a comment.** This branch
makes 219 strictly cheaper, which is a sequencing argument for doing 104 first.

219's recommended option (a `ClassLock` token returned by `lockClassRow` and
required by `readSeatCount`) carries one stated cost: the four inline sites
cannot call `lockClassRow`, so they would need an
`unsafeClassLockTaken(classId)` escape hatch that asserts rather than verifies.

`readSeatCount` has exactly **five** callers, verified at HEAD: the four sites in
this branch, plus `handleSpotFreed`. After this branch all five take their lock
through `lockClassRow`. **219's escape hatch becomes unnecessary** — the option
lands clean, with no `unsafe` surface at all.

219 is unaffected by this branch in the sense that it stays open and is not
implemented here. Its cost changes; its decision does not.

**Issue 229 — the `{Class, ClassTemplate}` lock order decision.** Untouched.
This branch changes *how long a site waits*, never *what it locks or in what
order*, so no lock set and no ordering moves. 229 stays open.

**Issue 122 — a benign `55P03` turning the generation job red.** Untouched, per
§2.3. Worth noting the interaction: this branch adds no new `55P03` source
inside the generator sweep, so it does not make 122 worse.

**Issue 232 — a drained pool logged as a lost lock race.** Untouched, but this
branch reduces the pressure that produces the symptom, by capping how long these
four sites can occupy a connection while blocked.

---

## 8. Acceptance

1. All four sites call `lockClassRow`. The census from §2.1, re-run, returns
   **4 statements**: `8 total − 4 replaced = 4`, being `lockClassRow` and
   `lockClassRowsOrdered` in `lib/db-locks.ts`, plus the two template claims in
   `class-generator.ts` and `studio-class-generator.ts`. No inline `Class` row
   lock survives outside `lib/db-locks.ts`.
2. Four new guards, each asserting `55P03` against a 3.5 s hold, each
   mutation-verified with the failure text recorded.
3. `POST /api/registrations` answers 503 with retry advice under a >2 s hold,
   proven end to end.
4. All 20 locations in §5 have an individual, named verdict, found across all
   three axes: keyword (1–9), branch diff (10–14), and a sweep for the old
   shape's vocabulary (15–20). A `#104` grep alone certifies nothing, and a
   grep plus a diff still missed six.
5. `npm run verify` green, with the after-figure **measured, not predicted**.
6. Issues 122, 219, 229 and 232 all remain open and unaffected.

---

## 9. Open items for the reviewer

- **The 2–5 s distribution assumption (§3.4)** is reasoning, not measurement. If
  a reviewer believes real holds cluster in that band, the value deserves
  re-litigating — though not upward past ~3 s, for the budget reason in §3.3.
- **Location 6 (§5.1)** is the trap in this branch: a still-true hazard sentence
  sitting inside a paragraph whose premise clause is now false. Flagged rather
  than left to be discovered.
- **The `promoteNext` statement count in §3.3** is a count of `await`s as
  written, and some sit inside a candidate-selection loop, so the number
  actually executed varies with how many queue heads hold an active
  registration. Stated because the count is used to argue a budget, and a
  budget argument should be honest about its worst case rather than its
  typical one.
