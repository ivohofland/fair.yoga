# Per-template studio generation

**Date:** 2026-07-29
**Status:** Approved (issue #94; design agreed with Ivo in discussion — extract
with parity, and take the claim on the resume path)

## Problem

`pauseOrResumeStudioTemplate` flips `isActive` and stops. Resuming a studio
template therefore shows an empty schedule until the hourly cron sweep fills it
back in — up to an hour later, with nothing on screen explaining the gap.

Its docstring says why, and the reason is real: `generateStudioClassInstances`
takes no `teacherId` and sweeps every active, unarchived template **platform-wide,
across every teacher**. Calling it from a resume would materialise windows for
every other teacher on the instance inside one PATCH request. The class family
has no such problem — `generateInstancesForTemplate(db, template, from?)` is
scoped to one template and accepts a transaction client, so `pauseOrResumeTemplate`
regenerates inline.

This is pre-existing but **newly reachable**. Before #86, archiving left the
generated window standing, so `pause → archive → un-archive → resume` always had
classes to come back to. Now archive deletes the unbooked window, so that
round-trip lands on an empty schedule.

Contained: studio classes are teacher-facing income records, never publicly
bookable. No student sees anything. It is a confusing empty state, not a data
problem.

## Design

### 1. Extract the per-template generator

`studio-class-generator.ts` currently inlines its generation loop inside the
sweep's transaction callback. Extract it:

```ts
export async function generateStudioInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: StudioTemplateWithTimezone,
  from?: Date,
): Promise<number>
```

Deliberately the same shape as `generateInstancesForTemplate`: the same client
union, the same optional `from`, the same `Promise<number>` of rows created. The
sweep calls it in place of its inline loop, so there is **one** implementation
rather than two that drift.

The client type is the point of the exercise. Nothing in the studio family
accepts `PrismaClient | Prisma.TransactionClient` today, which is exactly why
the resume path had nothing to call.

### 2. Parity in the date maths, not just in the signature

The two families have already drifted, and the drift is the interesting part.
The class family generates `DEFAULT_WEEKS + 1` occurrences, drops any whose
start instant has already passed, and slices back to `DEFAULT_WEEKS`:

```ts
const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
  .filter(
    (date) =>
      classStartInstant(date, template.startTime, template.teacher.defaultTimezone) >
      startDate,
  )
  .slice(0, DEFAULT_WEEKS);
```

The studio family takes `DEFAULT_WEEKS` dates with **no filter at all**, so it
can materialise today's class after that class has already started. The new
function carries the filter.

This is not scope creep, and it is not tidiness. Today the gap only shows up on
an hourly cron run nobody is watching. This change makes generation happen *on
resume*, at a moment the teacher is looking at the screen: resume at 10:00 a
template that runs 09:00 today and a class that already started appears in the
window. The fix is what makes the drift visible, so the fix is what closes it.

Shipping a `generateStudioInstancesForTemplate` that mirrors
`generateInstancesForTemplate` in name and signature while quietly differing in
its date maths would be worse than either behaviour on its own — it invites the
next reader to assume parity that is not there.

### 3. The claim gains a timezone

`classStartInstant` needs a timezone, and `StudioClassTemplate` has no teacher
join. So `claimStudioTemplateForGeneration` gains an include and a payload
alias, mirroring `TemplateWithTimezone`:

```ts
type StudioTemplateWithTimezone = Prisma.StudioClassTemplateGetPayload<{
  include: { teacher: { select: { defaultTimezone: true } } };
}>;
```

Its return type changes from `StudioClassTemplate | null` to
`StudioTemplateWithTimezone | null`. The raw `FOR UPDATE` statement is
unchanged — it still selects only `"id"`, still carries the eligibility
predicate, and is still what does the locking. Only the Prisma read beneath it
widens.

### 4. Resume takes the claim

`pauseOrResumeStudioTemplate` currently does a bare autocommit `update` with no
transaction. It gains one:

```
$transaction(timeout: 10_000):
  update { isActive: true }                  → FOR NO KEY UPDATE
  claimStudioTemplateForGeneration(tx, id)   → FOR UPDATE, upgrading the lock
  generateStudioInstancesForTemplate(tx, claimed)
```

**Why the claim, when the class family's equivalent does not take it.** The
studio claim's docstring currently ends:

> The loop below has no caller other than `generateStudioClassInstances`'s own
> claimed transaction, so there is no unclaimed path left for the branch to
> matter on here.

Adding a second caller falsifies that sentence — and lands it in precisely the
case the same docstring documents as reachable *and* broken for the class
family. A resume's `update` only flips `isActive`, a non-key column, so Postgres
grants `FOR NO KEY UPDATE`, which does **not** conflict with the `FOR KEY SHARE`
a concurrent `StudioClass` insert takes on the template row for FK integrity. So
the race is live; and the generator's `P2002` hedge is broken in that context,
because a `catch` inside an interactive transaction leaves Postgres with an
aborted transaction that fails the next statement with `25P02` rather than
skipping cleanly.

Taking `FOR UPDATE` makes a concurrent insert for this template impossible while
we hold it, which keeps the `P2002` branch unreachable — the invariant the
docstring asserts. The claim also returns the row with the timezone join §2
needs, so it pays for itself twice.

The `10_000` timeout matches the class family and is not arbitrary: the sweep's
claim can hold this row for its own full 10 s transaction, and Prisma's 5 s
default would abort us mid-wait.

**A `null` claim here is impossible, and must not be treated as ordinary.** The
archived case has already returned above; `isActive` was just set to `true` by
our own write; and we hold the row lock, so nothing can archive or delete it
between the two statements. `null` would therefore mean a logic error, not a
race. The code throws with a message saying so. Returning `0` on a provably
unreachable branch is the silent failure this codebase has repeatedly found and
removed.

### 5. What does not change

The pause branch is untouched — it still deletes nothing and still reports
`lastScheduled`. `PauseStudioTemplateResult` keeps its shape, so the PATCH route
and its exhaustive narrowing compile unchanged.

## Testing

**Unit, `generateStudioInstancesForTemplate`:**

- creates the window for an active template, and is idempotent on a second run
  (the `findFirst` guard);
- accepts a transaction client and a bare `PrismaClient` — both callers exist;
- honours `from`;
- **the filter earns its own case:** a template whose start time has already
  passed today does not get today's class, and the window slides one week
  further so the count is still `DEFAULT_WEEKS`. This is the parity behaviour
  and the one most likely to be quietly dropped in a refactor, so it is asserted
  by count *and* by the specific date that must be absent.
- **timezone-discriminating:** a teacher east and a teacher west of UTC, with
  the same template start time and the same instant, must disagree about
  whether today's class is still ahead. A UTC-only fixture cannot tell the
  filter from its absence.

**Unit, the sweep:** unchanged behaviour except the filter — its existing tests
must still pass, and one asserts it now delegates rather than duplicating.

**Unit, `pauseOrResumeStudioTemplate`:** resuming generates the window in the
same transaction; pausing still generates nothing; resuming an archived template
still returns `archived` and writes nothing; a generation failure rolls the
`isActive` flip back, which is what putting it in a transaction buys.

**Integration:** the studio PATCH `?state=active` returns a window that is
populated, not empty — the actual bug, asserted end to end.

**Mutation-verified**, and per the #66 lesson each mutation is confirmed to have
applied inside the function under test before its result is trusted. Two carry
the weight: deleting the `.filter(...)` (the "already started" test must fail,
by name), and passing `db` instead of `tx` in the resume path (the rollback test
must fail).

## Out of scope

- **The class family's `pauseOrResumeTemplate` has the same reachable, broken
  P2002 hedge** — it generates without taking the claim. Ivo's call was to fix
  the studio path and not widen this change into the class path. Filed
  separately rather than left as an undocumented asymmetry.
- **A studio equivalent of `syncTemplateInstances`.** Editing a studio template
  still does not re-sync its instances. Real, pre-existing, and a different
  issue.
- **Generation when a studio template is created.** The class family generates
  in its POST route; the studio POST does not. Same shape of gap, not this
  issue.
- **A `teacherId` parameter on `generateStudioClassInstances`.** The per-template
  function is what the resume path needed; a teacher-scoped sweep has no caller.
- **`DEFAULT_WEEKS` is still declared twice**, once per generator module. Left
  alone: the two families are deliberately parallel-but-separate, and a shared
  constant is the kind of coupling that makes the next divergence harder to see.
- **`StudioClass` has no `@@index([teacherId, date])`** where `Class` does. Noted
  while mapping; unrelated to this change.

## Risks

- **The claim's return type widening touches the sweep and its tests.** Contained
  and compiler-caught — `StudioTemplateWithTimezone` is a strict superset, so
  every existing read still type-checks.
- **The filter changes sweep behaviour, not just resume behaviour.** A studio
  template whose class already started today will no longer get that class
  materialised by the hourly sweep either. That is the intended fix, but it is a
  behaviour change to a cron path, and worth stating plainly rather than
  discovering: a teacher who relied on the sweep back-filling a just-missed
  class will now have to add it by hand.
- **Resume now serialises against the sweep.** Taking `FOR UPDATE` means a
  resume issued while that template's sweep transaction is mid-flight will wait,
  up to the sweep's 2 s `lock_timeout`. Correct, and the reason for the 10 s
  transaction budget — but resume is a user-facing PATCH, and it can now block
  where it previously could not. See #113: an archive that loses this same race
  currently reports "Internal server error", and the resume path will have the
  same shape of problem until that issue is fixed.
