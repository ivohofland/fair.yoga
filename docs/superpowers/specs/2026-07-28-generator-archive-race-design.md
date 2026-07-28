# The generator must not re-materialise a withdrawn window

**Date:** 2026-07-28
**Status:** Approved (issue #95; design agreed with Ivo — lock, not reconcile;
the backfill question split out separately)

## Problem

`generateClassInstances` (`src/services/class-generator.ts`) reads its template
list at the top of a sweep and then loops:

```ts
const templates = await db.classTemplate.findMany({
  where: { isActive: true, isArchived: false, ... },
});

for (const template of templates) {
  totalCreated += await generateInstancesForTemplate(db, template, startDate);
}
```

An archive committing after that read and before the loop reaches a given
template makes the sweep create classes for a template that is now archived.
`generateStudioClassInstances` has the identical shape.

Before #86 that was untidy. After #86 it is a correctness bug: instances are
created `status: 'open'`, and the public booking page filters on status and date
without consulting the template (`src/app/(public)/[slug]/page.tsx`). A
re-materialised window is **publicly bookable for a class the teacher shelved** —
exactly what #86 closed.

Self-healing in the wrong direction: the next sweep reads `isActive: false` and
stops, so no more are created, but the ones already created persist until someone
notices.

## Scope: only the sweep has this gap

`generateInstancesForTemplate` has four callers. Three cannot race, and the fix
must not be pushed down into them:

| Caller | Why it is safe |
|---|---|
| `POST /api/class-templates` | Creates the template, then generates, in one transaction. The template cannot be archived before it exists. |
| `pauseOrResumeTemplate` | `UPDATE`s `isActive` then generates, in one transaction. That `UPDATE` already holds the row lock this spec is about. |
| `syncTemplateInstances` | Reached from `updateClassTemplate`; its atomicity is **#83's** subject, not this one. Deliberately untouched. |
| **`generateClassInstances`** | **Reads a list, then loops. The gap.** |

So the guard belongs in `generateClassInstances` and its studio twin, per
template, not in `generateInstancesForTemplate`.

## Why a re-read is not enough

Issue #95's Option 1 says "re-read its `isActive`/`isArchived` in the same
transaction as the create". That narrows the window; it does not close it. Under
`READ COMMITTED` — this codebase overrides isolation nowhere — each statement
takes a fresh snapshot, so an archive committing between the re-read and the
`create` is still invisible to the re-read and still lost.

Closing it requires the archive's own write to be made to **wait**.
`archiveOrUnarchiveTemplate` runs `tx.classTemplate.update(...)` inside a
transaction, which takes a row-level exclusive lock held until commit. If the
generator takes the same lock first, the two serialise:

- **Generator locks first** — archive's `UPDATE` blocks. The generator creates
  its instances and commits. Archive then proceeds, and its `deleteMany` (which
  runs after the update in the same transaction, and re-evaluates its predicate
  at execution time per #93) removes those just-created unbooked classes.
  **Correct.**
- **Archive locks first** — the generator's claim blocks until archive commits,
  then reads `isArchived: true` and skips the template entirely. **Correct.**

Both interleavings end with no bookable class for an archived template. This is
the same principle #93 used for the delete: let Postgres evaluate the predicate
at execution time rather than trusting a value read earlier.

## The claim

A small helper per family, taking the lock and the decision in one statement:

```ts
/**
 * Claims a template for generation, or reports that it is no longer eligible.
 *
 * `FOR UPDATE` is the point, not the SELECT: it takes the same row lock
 * `archiveOrUnarchiveTemplate`'s `update` takes, so the two serialise instead
 * of interleaving. A plain re-read would still lose an archive that commits
 * between the read and the create.
 */
async function claimTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ClassTemplate"
    WHERE "id" = ${templateId}
      AND "isActive" = true
      AND "isArchived" = false
    FOR UPDATE`;
  return rows.length === 1;
}
```

and the sweep becomes:

```ts
for (const template of templates) {
  try {
    totalCreated += await db.$transaction(async (tx) => {
      if (!(await claimTemplateForGeneration(tx, template.id))) return 0;
      return generateInstancesForTemplate(tx, template, startDate);
    });
  } catch (err) {
    log.error({ err, templateId: template.id, teacherId: template.teacherId },
      'class generation failed for template');
    errors.push(err);
  }
}
```

Per-template error isolation is preserved: the transaction is inside the
existing `try`, so one template's failure still skips only that template.

### Why raw SQL

**Correction.** An earlier draft of this spec claimed `src/` contained no
`$queryRaw`/`$executeRaw`, so the change would be setting a precedent. That was
wrong — the check behind it was a shell-quoting mistake (`"\$queryRaw"` in
double quotes collapses to `$queryRaw`, which grep reads as an end-of-line
anchor and never matches). This branch **follows an existing convention**:

- `src/services/waitlist.ts:166`, `:280`, `:390` — `tx.$queryRaw` running
  `SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE` inside a
  transaction, three times.
- `src/app/api/registrations/route.ts:92` — the same statement again.

So the row-lock-via-raw-`FOR UPDATE` idiom is already how this codebase
serialises concurrent writes to a row, and the design below is a fourth and
fifth use of it rather than a new departure.

The two new claims deliberately differ from those four in two ways: they carry
an eligibility predicate in the `WHERE` (so the lock and the decision are one
statement), and they set `lock_timeout` (so a cron sweep cannot hang on a
contended row). Both differences follow from being called in a loop from a
background job rather than once from a request.

The typed alternative is a conditional `updateMany` as the claim —
`updateMany({ where: { id, isActive: true, isArchived: false }, data: {...} })`
takes the same lock with the same execution-time predicate, and returns `count`.
It is rejected because Prisma's `@updatedAt` fires on every update: the sweep
would rewrite every active template row every hour, making `ClassTemplate.updatedAt`
mean "last cron sweep" instead of "last edited", and adding hourly row churn and
autovacuum load on a 2 GB VPS for a lock that needs to write nothing.

Prisma has no native row-lock API, so `FOR UPDATE` is the only way to lock
without writing. The precedent is contained deliberately: one helper per family,
each a single `SELECT ... FOR UPDATE` on a primary key, with the identifiers
quoted (Prisma's default mapping is the verbatim model name — confirmed against
`prisma/migrations/20260403092044_init/migration.sql`) and the id bound as a
parameter, never interpolated. `ClassTemplate.id` is `TEXT`, so no cast.

### Lock timeout, and its interaction with Prisma's

Two timeouts govern this wait and they must be ordered deliberately, or the
symptom of a slow archive becomes a confusing Prisma error instead of a clean
skip.

- `SET LOCAL lock_timeout = '2s'` as the first statement of each claim
  transaction. The sweep runs in-process on an interval
  (`src/lib/scheduler.ts`); without it, one stuck lock stalls the whole job.
- `db.$transaction(fn, { timeout: 10_000 })` — Prisma's interactive-transaction
  default is 5 s, which the lock wait would otherwise eat into. Raising it well
  above `lock_timeout` guarantees Postgres's timeout fires first.

So a pathological lock surfaces as a Postgres lock-timeout error, the existing
per-template `catch` logs and skips it, and the next sweep retries — the same
failure posture the loop already has for every other error. Two seconds is far
above the sub-second archive transaction it can legitimately wait on.

## Studio family

Identical treatment, one difference: `generateStudioClassInstances` is a single
flat function with no per-template equivalent, so the claim wraps the body of its
existing `for (const template of templates)` loop rather than a function call.
Table `"StudioClassTemplate"`, same two columns.

The two families keep separate helpers rather than one generic over a delegate,
matching the decision recorded in `studio-class-template-lifecycle.ts` and
re-endorsed in #93's review.

## Testing

**The claim predicate — deterministic, no concurrency:**

- returns true for a live template (`isActive: true, isArchived: false`);
- false for an archived one;
- false for an inactive one;
- false for an id that does not exist.

**The lock — one real mutual-exclusion test per family.** The predicate tests
above pass just as well without `FOR UPDATE`, so they do not pin the fix. This
one does:

1. Open transaction A; claim the template; hold the transaction open.
2. Start `archiveOrUnarchiveTemplate` on the same template without awaiting it.
3. Assert it has **not** settled while A holds the lock (`Promise.race` against a
   200 ms timer — the lock is held until we choose to release, so this is a
   bounded wait on a deterministic state, not a race against a scheduler).
4. Commit A. Await the archive. Assert it now succeeds.

**The sweep-level outcome — the real race, reproduced deterministically.** This
is the test the whole change exists for, and it needs no test-only hooks in
production code. Uncommitted writes are invisible to other transactions under
`READ COMMITTED`, which is exactly the lever:

1. Open a transaction that archives the template (`isArchived: true`) and **do
   not commit**. It now holds the row lock, and its change is invisible to
   everyone else.
2. Start `generateClassInstances` without awaiting it. Its top-level `findMany`
   still sees the template as live — the archive is uncommitted — so the
   template enters the loop, which is precisely the stale list the bug is about.
   Its claim then blocks on the lock.
3. Commit the archiving transaction.
4. Await the sweep. The claim unblocks, re-reads, sees `isArchived: true`, and
   returns false.
5. Assert the sweep created **no** classes for that template.

Without `FOR UPDATE`, step 2's claim does not block: it reads the pre-commit row,
sees a live template, and generates — so this test fails, which is what makes it
the load-bearing one. Prisma's transaction timeout must be raised as above or
step 2 aborts rather than waiting.

**Mutation-verified**, and per the #66 lesson each mutation is confirmed to have
applied inside the function under test before its result is trusted. The
load-bearing mutation is deleting ` FOR UPDATE` from the claim: the predicate
tests must still pass and the mutual-exclusion test must fail. A fix whose only
failing test is one that also fails without the lock has not been tested.

## Out of scope

- **Backfilling templates archived before #93.** Those windows are still
  standing — not from this race, but because #93 only withdraws at archive time.
  That population is deterministic and much larger than any race could produce,
  and a one-off cleanup that knows each teacher's timezone is the right shape for
  it. Filed separately; sizing query to be run against production first.
- **#83's write/sync seam.** `syncTemplateInstances` has its own atomicity
  question and its own issue.
- **#94's empty studio window on resume.** Different interaction, same area.
- **Isolation-level changes.** `READ COMMITTED` stays; the fix works within it.

## Risks

- **Lock contention.** Each lock is one row, held for at most four inserts. The
  only contender is an archive PATCH for that same template, which waits
  milliseconds. Bounded by `lock_timeout` in the pathological case.
- **A transaction per template** where the sweep previously ran flat. For a
  hobby-scale instance this is a handful of short transactions per hour. If the
  template count ever makes this matter, the sweep is due for batching anyway.
- **Raw SQL drift.** If a future migration renames the table or either column,
  the SQL breaks at runtime rather than at compile time — the one real cost of
  leaving Prisma's typed API. Mitigated by keeping it to a single statement per
  family and by the claim tests, which fail loudly if the query stops matching.
