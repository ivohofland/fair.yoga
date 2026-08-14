# Template lock-race reporting

Issue 113. Four template-lifecycle functions can queue behind the hourly
generation sweep on the same row. Today that wait is bounded by nothing but the
transaction's own 10 s budget, and when the budget expires the failure arrives as
a generic transient error that names neither the operation nor its cause.

This branch bounds the wait, gives each function a `busy` outcome its route is
compelled to answer, and records which of the four lost the race.

## What the issue claims, and what is actually true

The issue was filed on 2026-07-28 and its headline symptom has since been fixed
by other work. Measured against the tree at `e3addf1`:

| Claim | Verdict | Evidence |
|---|---|---|
| "`withErrorHandler` special-cases only P2002, so P2028 falls through to `log.error` + `respondError('Internal server error', 500)`" | **False today** | `src/lib/api-errors.ts` defines `TRANSIENT_PRISMA_CODES = new Set(['P2024', 'P2028', 'P2034'])` and checks it *before* the P2002 branch. A P2028 is a **503** at `level: 'warn'` with "The system was busy and could not finish that. Please try again." |
| "**Sees:** 'Archiving...' for ten seconds, then a red *Internal server error*" | **Half false** | The ten seconds are real. The message is not — `archive-template-button.tsx` calls `readErrorMessage`, which surfaces the server's own 503 copy. |
| "the archive sets no `lock_timeout` of its own" | **True** | `SET LOCAL lock_timeout` appears nowhere in either lifecycle module. |
| "Postgres will therefore wait indefinitely" | **True**, bounded only by the Prisma budget | `{ timeout: 10_000 }` on every one of these transactions. |
| "The API routes narrow on these exhaustively, so a new variant is a compile error until it is handled" | **True** | Both `[id]/route.ts` files close each narrowing chain with a `never` guard. |
| Comment 1: `pauseOrResumeTemplate` and `pauseOrResumeStudioTemplate` have the same exposure | **True, and understated** — see below | |
| Comment 2: both create routes wrap create-plus-generate with no `{ timeout }` | **True** | Both call `prisma.$transaction(fn)` single-argument, and `src/lib/db.ts` sets no `transactionOptions`, so both run on Prisma's 5 s default. |

**The correction that matters most.** The issue exists to remove an
uninformative 500, and that 500 is already gone. What survives is narrower and
worth stating plainly, because it changes what "done" means here:

1. **A ten-second wait.** Nothing bounds the lock wait below the transaction
   budget, so a teacher watches a spinner for the full budget before being told
   to try again.
2. **A failure that names neither operation nor cause.** Archive and resume
   reach the identical route with the identical method and path; the only
   discriminator is a query parameter that the request logger deliberately
   excludes. Post-hoc the two are separable only by matching a stack's
   `file:line` against a commit.
3. **No forcing function.** A catch-all classifier makes contention *legible*
   after it escapes. It cannot make handling it *mandatory*.

`src/lib/api-errors.ts`'s own docblock predicted exactly this split and called
the two mechanisms complementary rather than substitutes. That reading holds.

## Scope

Four lifecycle functions and two create routes.

### The four are not one edit applied four times

Each has a different existing error-handling shape, and two of the four need
structural work before a `busy` return is even expressible.

| Function | Module | Existing handling | What this branch must do |
|---|---|---|---|
| `archiveOrUnarchiveTemplate` | `class-template-lifecycle.ts` | `try`/`catch` mapping `isUniqueConflictOn` → `slot_conflict` | Add a branch to the existing catch. |
| `archiveOrUnarchiveStudioTemplate` | `studio-class-template-lifecycle.ts` | Same | Same. |
| `pauseOrResumeTemplate` | `class-template-lifecycle.ts` | A promise `.catch()` that returns `null` for P2025, which the caller maps to `not_found` | The catch already uses its only sentinel. It needs a **second**, and the post-transaction `if (updated === null)` needs a sibling narrowing. |
| `pauseOrResumeStudioTemplate` | `studio-class-template-lifecycle.ts` | **None** | Needs a `try`/`catch` that does not exist. Its transaction result feeds a `switch` on `result.outcome`; the catch wraps the whole call rather than joining that switch, because a thrown error produces no `result` to switch on. |

The fourth is the sharpest case and neither the issue nor its comments identify
it: `pauseOrResumeStudioTemplate` has no error handling at all, so its lock race
propagates raw to the API wrapper today.

### The two create routes

`POST /api/class-templates` and `POST /api/studio-class-templates` each wrap a
create plus a generation in a single-argument `prisma.$transaction`, so both run
on Prisma's 5 s default while every peer transaction touching these rows budgets
10 s. Both get `{ timeout: 10_000 }`.

Both or neither. Comment 2 records why this was not folded into the branch that
found it: that branch's design was explicit parity between the two families, and
raising one create route's budget without the other creates an asymmetry with no
stated reason.

## Design

### 1. Bound the wait

`await setLockTimeout(tx)` — `src/lib/db-locks.ts` — as the **first statement**
of each of the four transactions, ahead of the compare-and-swap that takes the
contended lock.

Two properties that helper's docblock already records are load-bearing here:

- `SET LOCAL` governs every remaining statement in the transaction, not only the
  next one, and resets on `COMMIT` or `ROLLBACK` however the transaction ends.
- Re-issuing it later in the same transaction overwrites rather than stacks or
  errors — verified in psql at the time that comment was written.

The second matters for `pauseOrResumeStudioTemplate` specifically, which takes
the generation claim partway through its transaction and so issues the same bound
a second time.

**Why 2 s, reusing `LOCK_TIMEOUT_SQL` rather than choosing a new value.** The
constant exists because this bound had already drifted into three copies, and its
docblock argues that a bound silently different in one place is worse than one
uniformly wrong — reasoning about which side of a race loses assumes both sides
wait the same length of time. Introducing a second lock-timeout value would
recreate exactly that. It also leaves 8 s of the 10 s budget for the archive's own
work, where an 8 s bound would leave 2 s for a `deleteMany` over a four-week
window plus a count plus an update, reintroducing budget expiry from the other
side.

The cost is real and should not be glossed: a wait that would have succeeded at
3 s now fails at 2 s. The sweep's own hold is short — a claim plus four
`findFirst`/`create` round trips — but the chain
`studio-class-template-lifecycle.ts` documents in its own docblock (sweep holds,
resume queues, archive queues behind the resume) stacks a whole generation into
the wait. Those cases become a `busy` answer and a retry rather than a longer
wait and a success. That trade is deliberate: the retry is one click against copy
that explicitly invites it, and the alternative is the spinner this issue is
about.

### 2. `busy` on the result unions

Each of the four result unions gains `| { ok: false; reason: 'busy' }`.

The mechanism is the point. Both `[id]/route.ts` files end their narrowing chains
with a `never` guard, so widening a union is a `tsc` failure at each site until
the new reason is answered. A classifier at the API boundary cannot offer that; it
only makes an escaped failure legible.

Each catch tests `isTransientDbError(err)` — the same predicate
`src/app/api/account/route.ts` already uses to choose between a busy 503 and a
terminal 500 — and returns `busy` rather than rethrowing. Everything else in each
catch is unchanged, including the existing `isUniqueConflictOn` branches and the
P2025 sentinel.

Ordering inside each catch: the transient test goes **first**. `P2028` and
`P2024` are `PrismaClientKnownRequestError`s, the same class the unique-conflict
and P2025 checks inspect, and `api-errors.ts` documents the same ordering
requirement for the same reason — a transient code falling past a branch that
does not match it lands in the generic path this work exists to leave.

### 3. What the teacher is told

503, a `*_BUSY` code, and copy in the shape
`src/app/api/account/route.ts` already established: what happened to the data,
then what to do.

> The system was busy and could not archive this recurring class. Nothing was
> changed. Wait a moment, then try again.

varying `archive` / `unarchive` / `update` and `recurring class` / `studio class`
by site.

**The issue's proposed copy is rejected deliberately.** It reads "Classes are
being generated for this template right now. Try archiving again in a moment."
That asserts a cause the service cannot know: the writer holding the row may
equally be another tab's resume, another tab's archive, or a concurrent `Teacher`
update taking `FOR UPDATE` for a unique-column change. Naming the sweep would be
a smaller and more confident falsehood than the generic message it replaces. The
sibling route's docblock states the rule directly — saying too much is a failure
mode in its own right, and saying nothing was the failure before it.

**"Nothing was changed" is checked, not assumed.** Every failure this branch
converts to `busy` aborts the whole interactive transaction, so no partial state
survives. That is also precisely what makes the retry the copy invites safe to
offer.

### 4. What the operator is told

Returning `busy` instead of throwing means the API wrapper never sees the error,
and its automatic log line disappears with it. Without a replacement this branch
would be a net observability regression.

Each catch therefore logs before returning:

```
log.warn({ err, templateId, teacherId }, '<operation> lost the generation lock race')
```

with four distinct messages, one per function. Both lifecycle modules already
import `log`, and `err` is still in hand at that point, so the SQLSTATE survives
into the record rather than being inferred later.

This is the half of comment 1 that cannot close any other way. Widening the
request logger to carry the query parameter would work and is the wrong trade —
it would put student names into logs from an unrelated search route. Four
distinct service-level messages separate the operations by outcome instead.

## Claims elsewhere that this branch makes false

Each must be corrected in the same branch that falsifies it:

- `class-template-lifecycle.ts`, on the archive's transaction budget — describes
  a 5 s default turning an archive click into an opaque budget expiry, with no
  bound on the wait.
- `studio-class-template-lifecycle.ts`, on the resume's claim — states that the
  claim's 2 s bound "is not set yet at that point, so nothing bounds this
  particular wait but the 10 s". This branch sets it earlier; the sentence
  becomes false.
- `studio-class-template-lifecycle.ts`, on the archive's three-budget chain —
  ends "issue 113 owns that error surface", which stops being true here.
- `src/lib/api-errors.ts`, on the classifier's relationship to this issue —
  describes the remainder as unqueued.

**A hazard specific to that last file.** Its docblock contains an auto-close
keyword immediately followed by this issue's number. That is inert in source,
because the parser reads commit messages and pull-request bodies rather than file
contents. It is *not* inert if quoted into a commit message — which is how this
issue was closed by accident the second time, by the very commit written to
document the trap. Any commit touching that docblock must break the token:
separate the keyword from the number, or write the number without its `#`.

## Testing

Each of the four functions gets a contention test. `class-generator.test.ts` and
`studio-class-generator.test.ts` already hold a row from a competing transaction
and assert against the archive, so the fixture pattern exists and should be
followed rather than reinvented.

Shape: hold the template row from a competing transaction, call the function,
assert `{ ok: false, reason: 'busy' }` arrives — and assert it arrives on the
lock timeout rather than the transaction budget, since a test that merely
observes failure cannot tell the new bound from the old one.

**Every guard gets a recorded mutation.** A guard that compiles but cannot fail
certifies nothing, and this project has shipped three of those before. Per
function:

- Remove `setLockTimeout(tx)` → the wait must run past the lock timeout, and the
  test must fail. This is the mutation that proves the bound is what produced the
  outcome.
- Remove the `isTransientDbError` branch → the error must propagate instead of
  returning `busy`, and the test must fail.

Record the exact error text each mutation produces, restore, and re-verify.

Mutation values must be ones the code under test cannot itself produce, so a
poisoned fixture cannot resurface later in an unrelated run.

## What this branch does not do

- **It does not add contention handling to any route beyond the six named
  above.** Other transactions in this codebase take bounded waits already.
- **It does not change `classifyApiError`.** The transient branch there stays
  exactly as it is; it remains the backstop for contention that escapes a service
  rather than being caught by one.
- **It does not widen request logging** to include query parameters. That was
  considered and rejected upstream for a good reason, and this branch's
  service-level messages are the alternative.
- **It does not touch the generation sweep's own error path.** The direction
  where the sweep loses is already built: bounded, logged per template, surfaced
  on the health endpoint, self-healing on the next run.
- **Issue 122 is unaffected.**
