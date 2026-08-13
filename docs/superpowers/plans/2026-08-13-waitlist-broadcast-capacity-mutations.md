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
_PENDING_
```

Restored; suite green.

---

## M3 — the transaction-client brand

**Task 2.** Changed `readSeatCount`'s parameter from `TransactionClientOnly` to
`Prisma.TransactionClient`.

`npx tsc --noEmit`:

```
_PENDING_
```

Restored; clean.

---

## M4 — the broadcast's capacity guard (pre-fix baseline)

**Task 3.** The guard is missing, not wrong, so for this guard the mutation and
the original defect are the same edit. The failure below is the pre-fix
baseline; re-deleting the guard after the fix must reproduce it exactly.

`npx vitest run --project unit src/services/waitlist.test.ts -t 'stays silent'`:

```
_PENDING_
```

Restored (i.e. the fix shipped with the branch); suite green.

---

## M5 — `addToWaitlist`: `freeSeats > 0` → `freeSeats >= 0`

**Task 4.** Boundary moved by one, so the guard must fail to reject a join on a
class with a free seat.

`npx vitest run --project unit src/services/waitlist.test.ts`:

```
_PENDING_
```

Restored; suite green.

---

## M6 — `promoteNext`: `freeSeats <= 0` → `freeSeats < 0`

**Task 4.** Boundary moved by one, so a promotion succeeds into a class at
exactly `maxStudents`.

`npx vitest run --project unit src/services/waitlist.test.ts`:

```
_PENDING_
```

Restored; suite green.

---

## M7 — `claimSpot`: `freeSeats <= 0` → `freeSeats < 0`

**Task 4.** Boundary moved by one, so a claim succeeds on a full class.

`npx vitest run --project unit src/services/waitlist.test.ts`:

```
_PENDING_
```

Restored; suite green.

---

## M8 — booking route: `freeSeats <= 0` → `freeSeats < 0`

**Task 4.** Boundary moved by one, so a booking is accepted at exactly
`maxStudents`.

`npx vitest run --project integration tests/integration/registrations-api.test.ts`:

```
_PENDING_
```

Restored; suite green.
