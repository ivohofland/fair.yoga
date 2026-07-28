# Decide under the class lock

**Date:** 2026-07-28
**Status:** Approved (issue #107; design agreed with Ivo in discussion)

## Problem

`POST /api/registrations` takes the class row lock and then decides from a row
it read before the lock existed:

```ts
const cls = await prisma.class.findUnique({ ... });        // bare client, no transaction
if (!allowedStatuses.includes(cls.status)) return 409;     // decided pre-lock
const isWalkIn = … classStartInstant(cls.date, cls.startTime, …) …;

await prisma.$transaction(async (tx) => {
  await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${body.classId} FOR UPDATE`;

  const registrationCount = await tx.registration.count({ … });   // fresh, under the lock
  if (registrationCount >= cls.maxStudents && !isWalkIn) throw new ClassFullError();
  //                      ^^^^^^^^^^^^^^^^ stale
```

The count is fresh; the limit it is compared against is not. The lock's own
comment is accurate about what it does — *"serialize concurrent registrations
for this class"* — but it serialises registrations against **each other**, not
against a concurrent change to the class.

So between the outer read and the lock:

- **a teacher cancels the class** → the status check already passed, and the
  booking is accepted for a class that is not happening;
- **a teacher lowers `maxStudents`** → the fresh count is compared against the
  old cap, and the class goes over capacity;
- **a teacher reschedules** → the walk-in window is computed from the old
  `date`/`startTime`, so a booking is or isn't treated as a walk-in on the basis
  of a time that no longer applies.

Also read from the stale row, with smaller consequences: `settingsLocked` (the
write is idempotent, so a stale `false` merely re-sets `true`) and `classType`
in the two notification bodies.

`teacherId` is read stale too, for the ownership check and the roster upsert,
but nothing in the codebase ever writes `Class.teacherId` after creation — so
that one is safe today and is being moved only because leaving one stale read
behind reintroduces the hazard this fix exists to remove.

### This is the odd one out, not a new pattern

`src/services/waitlist.ts` takes the identical lock in three places and gets it
right in all three — `addToWaitlist` (`:166`), `promoteNext` (`:280`) and
`claimSpot` (`:390`) each open the transaction, take `FOR UPDATE`, then read
the class **inside** and decide from that. The registration
route is the fourth site of a three-site pattern, and the only one that reads
before it locks.

That also settles the fix: this is not a design question, it is bringing one
caller in line with what the codebase already does.

## Design

### 1. Every class read moves inside the transaction

The outer `prisma.class.findUnique` goes away entirely. Inside the transaction,
immediately after the `FOR UPDATE`:

```ts
const cls = await tx.class.findUnique({
  where: { id: body.classId },
  include: { teacher: { select: { defaultTimezone: true } } },
});
if (!cls) throw new ClassNotFoundError();
```

Everything then derives from that row: the status check, `maxStudents`, the
walk-in derivation, `settingsLocked`, `teacherId` for the ownership check and
the roster upsert, and `classType` in the notification bodies.

**Why not keep the outer read for a cheap 404/403 and add a fresh one for the
decisions that matter.** That is the smaller diff, and it is how this bug got
here: two class objects in scope, one safe and one not, distinguished by nothing
the type system can see. The next person adding a decision picks correctly by
luck. One row, read once, under the lock, is the shape that cannot rot.

### 2. Three new typed errors

The status check, the not-found and the ownership check currently return
`respondError` directly because they run before the transaction. Inside, they
become throws that the existing `catch` maps — the route already does exactly
this for `ClassFullError` and `AlreadyRegisteredError`:

| Thrown | Response |
|---|---|
| `ClassNotFoundError` | 404 `Class not found` |
| `NotYourClassError` | 403 `Not your class` |
| `ClassStatusError` (carries the status) | 409 `Cannot register for a class with status "<status>"` |

The read uses `findUnique` and an explicit null check, **not**
`findUniqueOrThrow`. That is the opposite of #102's choice, deliberately: there
the row provably existed because the `FOR UPDATE` had just matched it, so a
`| null` was an impossible branch. Here the id comes from the request body, so
the null is not only reachable but the ordinary way a client gets a 404 — and
`findUnique` + `if (!cls) throw new ClassNotFoundError()` says that in two lines
without routing a Prisma error code through a `catch`.

The response bodies and status codes are unchanged from today's, so no client
sees a difference except in the races this fixes.

### 3. What stays outside

The student lookup and the roster-link check. They concern the student, not the
class, and the class lock does nothing for them — holding it across them would
only widen the lock for no gain.

Session parsing, `rosterStudentId` resolution and `isTeacher` likewise: none of
them reads the class.

## Testing

**Integration, the race made deterministic** — the same lever #95 and #102 used,
adapted to HTTP. Uncommitted writes are invisible under `READ COMMITTED`, and
the dev server holds its own connection, so a transaction held open by the test
genuinely blocks the request:

1. Open a transaction that sets the class `status: 'cancelled'`; **do not
   commit**. It holds the row lock.
2. `fetch` the booking POST **without awaiting**.
3. Assert it has not settled. **This is a liveness check, not the teeth** — it
   holds both before and after the fix, since the pre-fix route also reaches the
   `FOR UPDATE` and blocks there, just after having already read the class. It
   is here to prove the request really is waiting on the lock rather than having
   raced past it, which is what makes step 5 meaningful.
4. Commit the cancellation. Await the POST.
5. Assert **409**, and that no `Registration` row was created.

Pre-fix that returns **201**: the server read the class before the lock, could
not see the uncommitted cancellation, passed the status check, then booked.

**The `maxStudents` variant**, same shape: fill the class to its cap minus one,
hold an uncommitted transaction lowering `maxStudents` below the current count,
fire the booking, commit, and assert 409 `Class is full` rather than an
over-capacity 201.

Hold each transaction ~300 ms, not seconds — the server's own interactive
transaction runs on Prisma's 5 s default, and a longer hold would turn the test
into a P2028 rather than the assertion it is written for.

**Mutation-verified**, and per the #66 lesson each mutation is confirmed to have
applied inside the function under test before its result is trusted. The
load-bearing mutation is moving the class read back outside the transaction:
both new tests must fail. A fix whose tests pass with the read hoisted has not
been tested.

## Out of scope

- **`autoCancelClasses`** (`src/services/class-transitions.ts`). The weaker
  analogue: no lock at all, deciding from `minStudents` and a registration count
  captured in the outer `findMany`, with a compare-and-swap that guards only
  `status: 'open'` and not the count. A registration landing mid-sweep can be
  auto-cancelled out from under. Real, lower stakes — the sweep is hourly and the
  window is one iteration — and a different fix. Filed thinking belongs with it,
  not smuggled in here.
- **Extracting a registration service.** The route carries more logic than
  `CLAUDE.md`'s "thin wrapper" ideal, and moving it would make this testable at
  the unit level. But the integration lever above tests the race without it, and
  a service extraction is a large refactor to land inside a correctness fix.
- **The three `waitlist.ts` sites.** They are already correct; this spec cites
  them as the pattern, not as work.

## Risks

- **The lock is held marginally longer** — by one indexed read that used to
  happen before it. Bounded by the same transaction as the count and the insert
  that already run under it.
- **A 404 now costs a transaction.** `findUnique` after a `FOR UPDATE` that
  matched nothing means opening a transaction to answer "no such class". One
  round trip, on a path that is not hot.
- **Three new error types on a route that already has two.** If a fourth
  category ever appears, the pattern is worth extracting; at five it is worth
  the service the previous section scopes out.
