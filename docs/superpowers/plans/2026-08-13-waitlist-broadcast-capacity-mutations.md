# Mutation Log — Waitlist Broadcast Capacity (#212)

Every guard touched by this branch is broken once, its exact failure recorded
here, and restored. A guard that compiles but cannot fail certifies nothing.

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
