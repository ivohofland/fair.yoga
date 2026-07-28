# Generate from the row the claim locked

**Date:** 2026-07-28
**Status:** Approved (issue #102; design agreed with Ivo in discussion)

## Problem

`claimTemplateForGeneration` takes `SELECT "id" … FOR UPDATE` on the template
row and then **throws the row away**. The sweep goes on to generate from the
object its outer `findMany` read minutes earlier:

```ts
const templates = await db.classTemplate.findMany({ ... });   // the snapshot

for (const template of templates) {
  await db.$transaction(async (tx) => {
    if (!(await claimTemplateForGeneration(tx, template.id))) return 0;
    return generateInstancesForTemplate(tx, template, startDate);  // still stale
  });
}
```

So #95 closed the race for the two columns the claim re-checks —
`isActive` and `isArchived` — and left it open for every column generation
actually reads: `dayOfWeek`, `startTime`, `durationMinutes`, `teacherRoomId`,
`roomCost`, `minRate`, `targetRate`, `minStudents`, `maxStudents`,
`cancelDeadline`, `autoCancelCheck`. `generateStudioClassInstances` has the
same shape against `location` and `hourlyRate`.

### Why it matters, and why nothing repairs it

A teacher edits `dayOfWeek` while a sweep is in flight. The two orderings are
not symmetric:

- **Sweep commits first, then the PUT** — `syncTemplateInstances` sees the
  wrong-day instances and deletes them. Repaired.
- **PUT commits first, then the sweep** — sync has already run. The sweep,
  holding its pre-PUT snapshot, then creates a fresh window on the *old* day.
  **Nothing repairs it**: generators only ever create, and sync will not run
  again until the next edit.

The result is up to four weeks of `open`, publicly bookable classes on a day
the teacher no longer teaches. The same interleaving silently reprices a window
when the edit was to `roomCost` or the rates.

The lock itself is already correct: `updateClassTemplate`'s `UPDATE` takes
`FOR NO KEY UPDATE`, which conflicts with the claim's `FOR UPDATE`, so a
concurrent edit genuinely blocks. The sweep simply never reads what the lock is
holding for it.

## Design

### 1. The claim returns the row it locked

```ts
export async function claimTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<TemplateWithTimezone | null>;
```

`null` means not eligible — archived, paused, or gone. Non-null means **locked
and current**. The caller stops holding a stale object at all, rather than being
trusted to remember to re-read one.

Internally it keeps the raw `SELECT "id" … FOR UPDATE` exactly as it is — that
statement exists to take the lock and to re-check eligibility at lock time, and
its `WHERE` must stay in the locking statement so Postgres re-evaluates it
against the new row version when the wait ends (the #95 reasoning, unchanged).
It then reads the row through typed Prisma, inside the same transaction and
under the held lock:

```ts
const rows = await tx.$queryRaw<Array<{ id: string }>>`… FOR UPDATE`;
if (rows.length !== 1) return null;

return tx.classTemplate.findUniqueOrThrow({
  where: { id: templateId },
  include: { teacher: { select: { defaultTimezone: true } } },
});
```

**Two statements, deliberately, rather than one `SELECT *`.** `roomCost`,
`minRate` and `targetRate` are `DECIMAL(10,2)`; a raw row hands back a value
that is not Prisma's `Decimal`, and hand-mapping eleven columns — three of them
money — is exactly the fragility to avoid in a path that writes class prices.
Raw SQL locks; Prisma reads.

`findUniqueOrThrow`, not `findUnique`: under the lock the row provably exists,
because the `FOR UPDATE` above just matched it. A `| null` there would be an
impossible branch that every caller has to pretend to handle. If it ever does
throw, the sweep's per-template `catch` logs it and moves on, which is the right
posture for an invariant violation.

### 2. The sweeps generate from that row

Class family:

```ts
const fresh = await claimTemplateForGeneration(tx, template.id);
if (!fresh) return 0;
return generateInstancesForTemplate(tx, fresh, startDate);
```

Studio family: the same, with the loop body reading `fresh.dayOfWeek`,
`fresh.startTime`, `fresh.durationMinutes`, `fresh.location`, `fresh.hourlyRate`
and `fresh.teacherId` instead of the snapshot's.

The outer `findMany` stays. It is a pre-filter that decides *which* templates to
consider, and it is still the right tool for that — it just stops being the
source of the values written.

### 3. `generateInstancesForTemplate`'s signature does not change

It keeps taking a `TemplateWithTimezone`. Two of its three other callers pass
a row they read or wrote inside their own transaction; the third does not:

| Caller | Freshness |
|---|---|
| `POST /api/class-templates` | the row it just created, same transaction |
| `pauseOrResumeTemplate` | the row it just updated, same transaction |
| `syncTemplateInstances` | **not fresh** — read on the bare `db` (`template-sync.ts:36`), before its own `$transaction` opens (`:41`), and handed to `generateInstancesForTemplate` on the bare `db` again (`:101`) after that transaction has already committed. Neither statement is in a transaction; no lock is ever taken. |

`syncTemplateInstances` is the exception, not a third instance of the same
guarantee, and this fix does not close it. The window between its read and
its reuse spans its entire inner transaction, unguarded by any lock, so a
second write to the same template can land inside it. Two overlapping `PUT`s
that both edit `dayOfWeek` can interleave so that the *later* sync's delete
runs off a stale snapshot: it deletes the window the earlier edit correctly
built, then refills on the day the stale snapshot names — worse than the
sweep's original bug, because here the delete itself is stale, not only the
regenerate. As with the sweep, nothing subsequently repairs it: sync only
runs again on the next edit to this template.

Passing an id instead of a row would not have fixed this caller. An id just
moves the re-read to immediately before use — but `syncTemplateInstances`
holds no lock for that re-read to happen *under*, so the second write can
still land in the (shorter, but still real) gap between the re-read and the
call. This is #83's write/sync atomicity seam — `syncTemplateInstances` runs
outside a transaction entirely — not something this fix reaches.

For the two callers that are genuinely fresh, making the signature take an id
would still be the wrong move: a redundant re-read to fix a problem only the
sweep has. The signature stays as it is.

## Testing

**The race, deterministically** — the same lever #95 used, since uncommitted
writes are invisible under `READ COMMITTED`:

1. Open a transaction that edits the template (`dayOfWeek` and `startTime`) and
   **do not commit**. It holds the row lock; the change is invisible to others.
2. Start the sweep without awaiting it. Its `findMany` still reads the old
   values — the exact stale snapshot this issue is about — so the template
   enters the loop, and its claim blocks on the lock.
3. Assert the sweep has **not** settled. Without the lock it would already have
   generated from the stale row.
4. Commit the edit. Await the sweep.
5. Assert the created classes carry the **new** `dayOfWeek` and `startTime`.

Step 5 is what fails today: the sweep generates, but on the old day.

**Both families**, since both have the defect.

**The claim's own contract:** its four existing predicate tests move from
`toBe(true)`/`toBe(false)` to `not.toBeNull()`/`toBeNull()`, plus one asserting
the returned row carries values written *after* the outer read — the property
the boolean could never express.

**Mutation-verified**, and per the #66 lesson each mutation is confirmed to have
applied inside the function under test before its result is trusted. The
load-bearing mutation is passing `template` instead of `fresh` at the call site:
the predicate tests must still pass and the race test must fail. A fix whose
tests pass against the stale object has not been tested.

## Out of scope

- **Repairing windows already generated on a stale snapshot.** Nothing knows
  which existing rows came from a lost race, and the deletion rule that could
  find them belongs to the archive path, not the generator. If this has bitten
  in production it shows up as classes on a day the template no longer names —
  findable, but a one-off cleanup rather than part of this fix.
- **#83's write/sync atomicity.** `syncTemplateInstances` runs outside a
  transaction, which is its own issue and its own seam.
- **The `findMany` pre-filter's own staleness.** It can still include a template
  that becomes ineligible before the loop reaches it — that is what the claim's
  `WHERE` is for, and #95 closed it.

## Risks

- **One extra query per template per sweep.** A primary-key `findUnique` under a
  held lock; negligible against the 4 `findFirst` + up to 4 `create` already in
  that transaction.
- **The lock is held marginally longer.** By one indexed read. The archive and
  pause paths that wait on it already budget 10 s (#95), far above this.
- **`findUniqueOrThrow` turns an impossible state into an exception** rather than
  a skip. That is the intent — but it means a future change that releases the
  lock earlier would convert a silent bug into a noisy one, which is the correct
  direction and worth stating so nobody "fixes" it back to `findUnique`.
