# Mutation Log — Waitlist Broadcast Capacity (#212)

Every guard touched by this branch is broken once, its exact failure recorded
here, and restored. A guard that compiles but cannot fail certifies nothing.

**M5-M8 describe code that no longer exists, and are kept as run rather than
rewritten.** They each mutated a `freeSeats <= 0` comparison at one of the four
migrated sites. PR review then moved that predicate into `readSeatCount` as
`isFull`, so those four comparisons are now one — see M10. The entries stay
because they are the record of what was actually executed, and because the
reason the consolidation happened is visible only in how repetitive they are.

## M1 — the status-list membership pin

**Task 1.** Changed `'no_show'` to `'no_shows'` in
`src/lib/registration-status.ts`.

`npx tsc --noEmit`:

```
src/lib/registration-status.ts(29,72): error TS2820: Type '"no_shows"' is not assignable to type 'RegistrationStatus'. Did you mean '"no_show"'?
```

Restored; `tsc --noEmit` clean.

---

## M2 — the seat-occupying filter

**Task 2.** In `capacity.ts`, replaced the status-filtered count with a count
of everything (`where: { classId }`).

`npx vitest run --project unit src/services/capacity.test.ts` failed at phase 3:

```
AssertionError: expected { Object (maxStudents, activeCount, ...) } to deeply equal { Object (maxStudents, activeCount, ...) }

- Expected
+ Received

  {
-   "activeCount": 1,
-   "freeSeats": 1,
+   "activeCount": 3,
+   "freeSeats": -1,
    "maxStudents": 2,
  }
```

`activeCount` 3 instead of 1, `freeSeats` −1 instead of 1 — the cancelled and
late_cancel rows counted. Restored; suite green.

---

## M3 — the transaction-client brand

**Task 2.** Changed `readSeatCount`'s parameter from `TransactionClientOnly` to
`Prisma.TransactionClient`.

`npx tsc --noEmit`:

```
src/lib/db-locks.test.ts(60,3): error TS2578: Unused '@ts-expect-error' directive.
```

A bare `PrismaClient` is structurally assignable to `Prisma.TransactionClient`,
so the new pin line stopped erroring. Restored; clean.

---

## M4 — the broadcast's capacity guard (pre-fix baseline)

**Task 3.** The guard is missing, not wrong, so for this guard the mutation and
the original defect are the same edit. The failure below is the pre-fix
baseline; re-deleting the guard after the fix must reproduce it exactly.

`npx vitest run --project unit src/services/waitlist.test.ts -t 'stays silent'`:

```
AssertionError: expected { action: 'broadcast', notified: 2 } to deeply equal { action: 'none' }

- Expected
+ Received

  {
-   "action": "none",
+   "action": "broadcast",
+   "notified": 2,
  }
```

`handleSpotFreed` returned `{ action: 'broadcast', notified: 2 }` where
`{ action: 'none' }` is expected, and `countBroadcasts()` was 2 where 0 is
expected — the broadcast branch read the queue and notified both waiters
without ever counting. The guard is missing, not wrong, so this baseline IS
the mutation; re-deleting the guard after the fix must reproduce it exactly.

Restored (the fix shipped with the branch); suite green.

Re-deleting the two guard lines (`readSeatCount` + `if (freeSeats <= 0) return
[]`) after the fix reproduces the exact failure above — same assertion, same
message, same diff. The mutation and the original defect are the same edit.

---

## M5 — `addToWaitlist`: `freeSeats > 0` → `freeSeats >= 0`

**Task 4.** Boundary moved by one, so the guard must fail to reject a join on a
class with a free seat.

`npx vitest run --project unit src/services/waitlist.test.ts` — 15 tests failed, each on the same boundary:

```
WaitlistJoinError: The class still has open spots — book directly instead
 ❯ src/services/waitlist.ts:186:13
    184|     const { freeSeats } = await readSeatCount(tx, classId);
    185|     if (freeSeats >= 0) {
    186|       throw new WaitlistJoinError(
       |             ^
    187|         'The class still has open spots — book directly instead',
    188|         'class_not_full',
```

`freeSeats === 0` (a class at exactly `maxStudents`) now throws `class_not_full`
where the join must succeed — the off-by-one at the boundary, in the inverted
comparison's direction. Restored; suite green.

---

## M6 — `promoteNext`: `freeSeats <= 0` → `freeSeats < 0`

**Task 4.** Boundary moved by one, so a promotion succeeds into a class at
exactly `maxStudents`.

**Coverage gap found by the mutation:** the first run PASSED — no existing
test drove `promoteNext` on a class at exactly `maxStudents`. Added the test
`refuses to promote into a class that is exactly at maxStudents` to the
`promoteNext (DB)` block (it re-queues a student with no registration against
the already-full shared fixture, then asserts the `class_full` rejection and
that nothing was written). It passed against the correct guard, then failed
against the mutation — the boundary is now pinned, not assumed.

With the mutation, `npx vitest run --project unit src/services/waitlist.test.ts`:

```
AssertionError: promise resolved "{ …(9) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "classId": "...",
+   "status": "promoted",
+   "studentId": "...",
  }
```

The promotion proceeded into a class at exactly `maxStudents`, creating a
`promoted` entry and a registration. Restored; suite green.

---

## M7 — `claimSpot`: `freeSeats <= 0` → `freeSeats < 0`

**Task 4.** Boundary moved by one, so a claim succeeds on a full class.

`npx vitest run --project unit src/services/waitlist.test.ts`:

```
AssertionError: promise resolved "{ …(9) }" instead of rejecting

- Expected
+ Received

- Error {
-   "message": "rejected promise",
+ {
+   "classId": "...",
+   "status": "promoted",
+   "studentId": "...",
  }
```

Caught by the existing `refuses a claim when the spot has already been taken`
test — the claim proceeded into a class at exactly `maxStudents`. Restored;
suite green.

---

## M8 — booking route: `freeSeats <= 0` → `freeSeats < 0`

**Task 4.** Boundary moved by one, so a booking is accepted at exactly
`maxStudents`.

`npx vitest run --project integration tests/integration/registrations-api.test.ts`
— 3 tests failed; the concurrent one is representative:

```
AssertionError: expected [ 201, 201 ] to deeply equal [ 201, 409 ]

- Expected
+ Received

  [
    201,
-   409,
+   201,
  ]
```

Also caught by `teacher adds before class respect capacity — not walk-ins`
(`expected 201 to be 409`) and `refuses a booking that exceeds a cap lowered
while the request waited`. A booking at exactly `maxStudents` was accepted
instead of 409. Restored; suite green.

---

## M9 — the lock itself (REWRITTEN after the multi-agent review)

**The gap it closes is the branch's own argument.** M1-M8 all prove the *count*.
Nothing proved the **lock**, which is what makes the count mean anything: spec §2
argues an unlocked count only moves the race from "cancel-commit → findMany" to
"count → createMany". So "count without lock" is precisely the fix that does not
work, and it was the one variant the branch could not distinguish from the fix
that does.

**Measured before writing the test.** Deleting `await lockClassRow(tx, classId)`
and running the three unit suites that own this path — `waitlist.test.ts`,
`capacity.test.ts`, `gdpr.test.ts` — left every one of them green.

**The first version of this test was wrong, and only under load.** It held the
row for 900 ms and raced `handleSpotFreed` against a 400 ms timer, asserting "did
not finish". PR review measured it with the lock deleted and 12 busy loops on 10
cores: **4 of 5 runs reported PASS.** Instrumented, the hook had not yet reached
its `FOR UPDATE` when the verdict fired at 552 ms — slowness manufactured the
evidence. CI runs 2-4 cores, so it was likelier there than on the machine that
found it. A wall-clock verdict is not a proposition about locks.

**What replaced it asserts an outcome slowness cannot produce.** The holder keeps
the row for 3.5 s — longer than `lockClassRow`'s own 2 s `SET LOCAL
lock_timeout` — so the hook must abort with **55P03**. A busy machine does not
invent a SQLSTATE; only asking for a held lock produces one. The handshake
(`lockHeld` promise) replaces the 150 ms sleep, whose assumption was measured
failing at 486 ms under load and 428 ms even idle.

The class is still re-filled first, which is the original version's one correct
insight and is retained: a broadcast that reaches its `createMany` takes
`FOR KEY SHARE` on the same row via `relatedClassId` and would block on the
holder regardless, so a test on a class with a free seat passes with the lock
deleted.

Mutation applied (`await lockClassRow(tx, classId)` deleted):

```
AssertionError: expected true to be false // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 38 skipped (39)
```

`outcome.ok` was `true` — without the lock the hook never asks for the row,
counts a full class, and returns `{ action: 'none' }` instead of aborting.

**Detection rate, both states:**

| | shipped (timer) | replacement (55P03) |
|---|---|---|
| lock deleted, idle | detected | **5/5 detected** |
| lock deleted, load avg 8.8 | **4/5 FALSE PASS** | **5/5 detected** |
| lock present, load avg 245 | — | **passes** (61 s run, no flake) |

The last row matters as much as the others: the replacement does not merely fail
the mutant, it survives extreme load against correct code, so it is not trading a
false pass for a false failure.

---

## M10 — the capacity boundary, now in one place

**Found missing by the review.** M5-M8 recorded a boundary mutation at each of the
four migrated sites, but the new site had only a *deletion* (M9's baseline), so
the log claimed a completeness it did not have.

Raised as "run the missing fifth"; answered by removing the need for five. `isFull`
is now computed once in `readSeatCount`, so there is one boundary to move rather
than five, and one mutation that reaches every site through it.

Mutation applied — `isFull: freeSeats <= 0` → `isFull: freeSeats < 0`
(`src/services/capacity.ts`):

```
 FAIL  |unit| src/services/waitlist.test.ts > addToWaitlist + removeFromWaitlist (DB) > adds students with sequential positions
 FAIL  |unit| src/services/waitlist.test.ts > addToWaitlist + removeFromWaitlist (DB) > rejects joining when already actively registered
 FAIL  |unit| src/services/waitlist.test.ts > promoteNext (DB)
 FAIL  |unit| src/services/waitlist.test.ts > claimSpot (DB)
 FAIL  |unit| src/services/waitlist.test.ts > handleSpotFreed (DB)
 FAIL  |unit| src/services/waitlist.test.ts > removeFromWaitlist takes the class lock (DB)
⎯⎯⎯⎯⎯⎯ Failed Tests 15 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected WaitlistJoinError: The class still has op… { reason: '…' } to match object { reason: 'already_registered' }
```

**Fifteen failures, not the two this entry originally predicted, and the gap is
the point.** The prediction was "one unit assertion and one behavioural one". What
actually happens is that a class at exactly `maxStudents` stops reading as full,
so `addToWaitlist`'s `!isFull` rejects every join in the file's fixtures and six
describe blocks fall over. That is the consolidation working: a single character
now has blast radius across every seat decision on the platform, which is exactly
why it should exist in exactly one place and be pinned there.

Restored; suite green.

---

## M11 — the status list's shape, not just its contents

**Added by the review.** M1 pins that every entry is a real `RegistrationStatus`.
Nothing pinned the *encoding*, and the encoding was doing harm: `as const
satisfies` infers a literal tuple, which narrows `includes`' parameter to those
three literals, which is why all three membership sites carried
`as readonly string[]` — a cast that accepts any string at all. Under it,
`ACTIVE_REGISTRATION_STATUSES.includes(waitlistEntry.status)` compiled clean and
answered `false` forever.

Reverting to `as const satisfies readonly RegistrationStatus[]`:

```
src/app/(teacher)/class/[id]/page.tsx(74,43): error TS2345: Argument of type 'RegistrationStatus' is not assignable to parameter of type '"registered" | "attended" | "no_show"'.
src/app/api/registrations/route.ts(155,61): error TS2345: Argument of type 'RegistrationStatus' is not assignable to parameter of type '"registered" | "attended" | "no_show"'.
src/services/waitlist.ts(736,43): error TS2345: Argument of type 'RegistrationStatus' is not assignable to parameter of type '"registered" | "attended" | "no_show"'.
src/lib/registration-status.test.ts(32,19): error TS2352: Conversion of type 'readonly [...]' to type 'string[]' may be a mistake ...
```

**The observed failure is not the predicted one, and that is recorded rather than
tidied away.** The `@ts-expect-error` pin in `registration-status.test.ts` was
expected to report as *unused*. It does not — under `as const` that line still
errors, differently — so the build breaks at four other places instead. Louder
than intended, and it names the three sites that would need re-widening. A guard
whose observed failure differs from its documented one is how a later reader
concludes it does not work.

---

## M12 — the freeze

`Object.freeze` on the status list, mutated by removing it:

```
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: expected false to be true // Object.is equality
      Tests  1 failed (1)
```

(`Object.isFrozen` is the assertion that fails first, before the `push` one.)

One cast (`as string[]`) is all that stands between a global that gates every
capacity decision on the platform and a stray `push`.
