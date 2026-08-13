# Waitlist Broadcast Capacity Check — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The final-hour waitlist broadcast stops announcing spots that are already taken, and the capacity rule it forgot gets one implementation instead of five.

**Architecture:** The broadcast branch of `handleSpotFreed` moves inside a transaction opened with `lockClassRow`, counts active registrations there, and returns `{ action: 'none' }` when the class is full. The count-and-compare is extracted to `readSeatCount` (`src/services/capacity.ts`) and the status list it filters on moves to an import-free `src/lib/registration-status.ts`, so the omission that caused this bug is harder to repeat.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma + PostgreSQL, Vitest (three projects: `unit`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-08-13-waitlist-broadcast-capacity-design.md`
**Branch:** `fix/212-waitlist-broadcast-capacity` (already created; the spec is committed on it)

## Global Constraints

- **TypeScript `strict: true`** — no `any`, no implicit types. `noUncheckedIndexedAccess` is on: indexing an array yields `T | undefined`.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project talks to it over HTTP.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `"src/app/(teacher)/..."`.
- **`@/lib/log` is pino and server-only.** Neither new module may import it, directly or transitively.
- **Prisma's `in:` filter wants a mutable `RegistrationStatus[]`** and rejects a `readonly` one. Call sites spread: `in: [...ACTIVE_REGISTRATION_STATUSES]`. This is a constraint on the call site, not the constant (`class-lifecycle.ts:160-167` says the same about `CHARGED_STATUSES`).
- **`.includes()` on the readonly tuple needs a widening cast** — `(ACTIVE_REGISTRATION_STATUSES as readonly string[]).includes(x)` — because the tuple's element type is a literal union and `x` is the full `RegistrationStatus`. `waitlist.ts:694` already uses exactly this form.
- **Every guard gets a mutation proof.** Break it, record the exact error text in `docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md`, restore, re-verify. A guard that compiles but cannot fail certifies nothing.
- **Per-task verification:** `npx tsc --noEmit` plus the task's own test file by explicit path (`npx vitest run --project unit <path>`). **`npm run verify` runs once, at the end, before push** — it needs the app live on :3000.

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/registration-status.ts` | The one definition of which registration statuses occupy a seat. Import-free at runtime so any layer can use it. |
| `src/services/capacity.ts` | `readSeatCount` — the one implementation of "how many seats are left in this class". |
| `src/services/capacity.test.ts` | Its arithmetic, including the overbooked and `late_cancel` cases. |
| `docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md` | The recorded mutation log — every guard, its break, its exact error. |

**Modified**

| File | Change |
|---|---|
| `src/services/waitlist.ts` | Delete the private const (T1); the broadcast fix (T3); three adoptions (T4). |
| `src/services/class-transitions.ts` | Delete the private const, import the shared one, spread at three call sites (T1). |
| `src/app/api/registrations/route.ts` | Two literals → the constant (T1); adopt `readSeatCount` (T4). |
| `src/app/(student)/bookings/page.tsx` | One literal → the constant (T1). |
| `src/app/(teacher)/class/[id]/page.tsx` | One literal → the constant (T1). |
| `src/services/class-lifecycle.ts` | `CHARGED_STATUSES` docblock pointer (T1); the "Full is derived" pointer (T2). |
| `src/lib/db-locks.ts` | The brand register gains `readSeatCount` (T2). |
| `src/lib/db-locks.test.ts` | The brand pin gains one `@ts-expect-error` line (T2). |
| `src/services/waitlist.test.ts` | New `handleSpotFreed (DB)` describe (T3). |
| `docs/lock-order.md` | The broadcast's table row is no longer "outside any transaction" (T3). |
| `docs/technical-architecture.md` | The Waitlist sketch, corrected (T3). |

**Task order is load-bearing.** T1 → T2 (the helper imports the constant) → T3 (the fix calls the helper). T4 is last deliberately: it is a pure refactor of four working sites, so it is the one task a reviewer could reject without stranding the bug fix.

---

## Task 1: One home for the active-status list

**Files:**
- Create: `src/lib/registration-status.ts`
- Modify: `src/services/waitlist.ts:44-45` (delete const), `:186`, `:413`, `:551`, `:694` (import)
- Modify: `src/services/class-transitions.ts:28-35` (delete const), `:137`, `:287`, `:302`
- Modify: `src/app/api/registrations/route.ts:143`, `:156`
- Modify: `src/app/(student)/bookings/page.tsx:71`
- Modify: `src/app/(teacher)/class/[id]/page.tsx:73`
- Modify: `src/services/class-lifecycle.ts:160-167` (docblock pointer only)

**Interfaces:**
- Produces: `ACTIVE_REGISTRATION_STATUSES: readonly ['registered', 'attended', 'no_show']`, exported from `@/lib/registration-status`. Every later task imports it from there.

- [ ] **Step 1: Create the shared constant**

Create `src/lib/registration-status.ts`:

```ts
/**
 * The registration statuses that occupy a seat.
 *
 * One definition, in `lib/` and import-free at runtime, for the same reason
 * `class-fields.ts` and `tiers.ts` are: a `'use client'` component that ever
 * needs this list must be able to import it without dragging `@/lib/log`
 * (pino, server-only) into the browser bundle. The `import type` below erases
 * completely, so this module emits no runtime import at all.
 *
 * `cancelled` and `late_cancel` are absent deliberately — both freed the seat.
 * `late_cancel` still bills (it is in `CHARGED_STATUSES`,
 * `services/class-lifecycle.ts`), which is why the two sets exist and differ
 * by exactly that one member.
 *
 * The `satisfies` pins MEMBERSHIP, not completeness: every entry must be a
 * real `RegistrationStatus`, so a renamed enum member fails `tsc`. It does
 * NOT assert the list is exhaustive, and must not be "fixed" into something
 * that does — this list is a subset by design. (#39 shipped the opposite
 * mistake: a `satisfies` read as a completeness pin when it only ever pinned
 * membership.)
 *
 * Prisma's `in:` filter wants a mutable `RegistrationStatus[]` and will not
 * take a readonly one, so callers spread — `in: [...ACTIVE_REGISTRATION_STATUSES]`
 * — exactly as `CHARGED_STATUSES`' callers do. That is a constraint on the
 * call site, not on the source of truth.
 */
import type { RegistrationStatus } from '@prisma/client';

export const ACTIVE_REGISTRATION_STATUSES = ['registered', 'attended', 'no_show'] as const
  satisfies readonly RegistrationStatus[];
```

- [ ] **Step 2: Prove the `satisfies` pin bites**

Temporarily change `'no_show'` to `'no_shows'`.

Run: `npx tsc --noEmit`
Expected: FAIL, naming the `satisfies` clause and `'no_shows'`.

**Record the exact error** in the mutations log (create
`docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md`
with a `## M1 — the status-list membership pin` section). Then restore
`'no_show'` and re-run `npx tsc --noEmit` — expected: clean.

- [ ] **Step 3: Re-point `waitlist.ts`**

Delete lines 44-45:

```ts
/** Registration statuses that occupy a spot. */
const ACTIVE_REGISTRATION_STATUSES = ['registered', 'attended', 'no_show'] as const;
```

Add to the import block (after line 15):

```ts
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
```

The four usages (`:186`, `:413`, `:551` spread; `:694` cast) are already written
in the forms the shared constant requires — **do not change them**.

- [ ] **Step 4: Re-point `class-transitions.ts`, and spread at three call sites**

Delete lines 28-35 (the docblock and the const). Add the import beside the
existing ones.

This file's const was typed `RegistrationStatus[]` — mutable — so its three
usages pass it bare. The shared constant is `readonly`, so each must now
spread:

```ts
// :137
select: { registrations: { where: { status: { in: [...ACTIVE_REGISTRATION_STATUSES] } } } },

// :287
const activeCount = await tx.registration.count({
  where: { classId: cls.id, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
});

// :302
const registrations = await tx.registration.findMany({
  where: { classId: cls.id, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
  select: { studentId: true },
});
```

The deleted docblock said the list is "named once because `autoCancelClasses`
asks the same question twice". That reason survives and widens; move its
substance into the comment at `:130-131`, which already cross-references
`(student)/bookings/page.tsx`:

```ts
  // the same filtered shape, with the same status set, that
  // `(student)/bookings/page.tsx` already uses — now literally the same
  // constant (`@/lib/registration-status`), not just the same spelling. The
  // pre-filter and the authoritative count under the lock must answer the
  // same question, or the pre-filter skips classes the locked check would
  // have cancelled.
```

- [ ] **Step 5: Re-point `registrations/route.ts` — note the two different forms**

`:143` is a Prisma filter (spread); `:156` is an `.includes()` (cast):

```ts
// :142-144
const registrationCount = await tx.registration.count({
  where: { classId: body.classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
});

// :156 — the cast is required: the tuple's element type is a literal union,
// `existing.status` is the full `RegistrationStatus`. Same form as
// `waitlist.ts`'s `hasActiveRegistration`.
if (existing && (ACTIVE_REGISTRATION_STATUSES as readonly string[]).includes(existing.status)) {
```

Add `import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';`
to the import block.

- [ ] **Step 6: Re-point the two pages**

`src/app/(student)/bookings/page.tsx:71` — a Prisma filter, so spread:

```ts
                  where: { status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
```

`src/app/(teacher)/class/[id]/page.tsx:73` — an `.includes()`, so cast. Keep
the existing comment above it, which explains why `late_cancel` is excluded:

```ts
  const seatCount = cls.registrations.filter((r) =>
    (ACTIVE_REGISTRATION_STATUSES as readonly string[]).includes(r.status),
  ).length;
```

Both files are server components (no `'use client'`), so the import is safe on
any reading — and the module is import-free anyway.

- [ ] **Step 7: Re-point the `CHARGED_STATUSES` docblock**

`src/services/class-lifecycle.ts:165-166` currently reads:

```
 * callers spread (`in: [...CHARGED_STATUSES]`) exactly as `waitlist.ts` does
 * with `ACTIVE_REGISTRATION_STATUSES`.
```

That citation is now wrong — the constant moved. Replace with:

```
 * callers spread (`in: [...CHARGED_STATUSES]`) exactly as the callers of
 * `ACTIVE_REGISTRATION_STATUSES` (`@/lib/registration-status`) do. That set
 * is this one minus `late_cancel`: it asks who occupies a seat, this one asks
 * who gets billed. This constant stays here rather than joining it in `lib/`
 * because only server-side services use it, and four comments across three
 * test files name this file as its home — one of them by line number.
```

- [ ] **Step 8: Typecheck, lint, and run the touched suites**

```bash
npx tsc --noEmit
npx eslint src/lib/registration-status.ts src/services/waitlist.ts src/services/class-transitions.ts src/app/api/registrations/route.ts "src/app/(student)/bookings/page.tsx" "src/app/(teacher)/class/[id]/page.tsx" src/services/class-lifecycle.ts
npx vitest run --project unit src/services/waitlist.test.ts src/services/class-transitions.test.ts
```

Expected: clean, and both suites pass unchanged. This task changes no
behaviour — a failure here is a real regression, not a fixture that needs
updating.

- [ ] **Step 9: Verify the census closed**

```bash
grep -rn "'registered'" src --include='*.ts' --include='*.tsx' | grep attended | wc -l
```

Expected: **8**. Was 13. The arithmetic: 13 − 6 adopters + 1 new definition = 8.
The 8 are 1 definition + 5 `CHARGED_STATUSES` inliners (a different,
four-element list — out of scope) + 2 test files (deliberately left inline: a
test that imports the constant it exists to pin goes green when the constant
changes).

If the count is not 8, do not adjust the expectation — find the site that was
missed.

- [ ] **Step 10: Commit**

```bash
git add src/lib/registration-status.ts src/services/waitlist.ts src/services/class-transitions.ts src/app/api/registrations/route.ts "src/app/(student)/bookings/page.tsx" "src/app/(teacher)/class/[id]/page.tsx" src/services/class-lifecycle.ts docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md
git commit -m "refactor: one home for the statuses that occupy a seat, six sites down to one

Two module-private constants and four bare literals, all spelling the same
three-element list. grep for the literal: 13 lines before, 8 after (1
definition + 5 inliners of the DIFFERENT four-element CHARGED_STATUSES set +
2 test files left inline on purpose).

The satisfies pins membership, not completeness — the list is a subset by
design. Mutation M1 recorded.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `readSeatCount`

**Files:**
- Create: `src/services/capacity.ts`, `src/services/capacity.test.ts`
- Modify: `src/lib/db-locks.ts` (the brand register), `src/lib/db-locks.test.ts` (the pin)
- Modify: `src/services/class-lifecycle.ts:7` (one-line pointer)

**Interfaces:**
- Consumes: `ACTIVE_REGISTRATION_STATUSES` from `@/lib/registration-status` (Task 1); `TransactionClientOnly` from `@/lib/db-locks`.
- Produces: `readSeatCount(tx: TransactionClientOnly, classId: string): Promise<{ maxStudents: number; activeCount: number; freeSeats: number }>`. Tasks 3 and 4 call it. `freeSeats` is `maxStudents − activeCount` and **may be negative**.

- [ ] **Step 1: Write the failing test**

Create `src/services/capacity.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { readSeatCount } from './capacity';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

describe('readSeatCount (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const mail = `capacity-teacher-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Capacity',
        lastName: 'Teacher',
        email: mail,
        account: { create: { email: mail } },
        bio: 'Test teacher for readSeatCount tests',
        pageSlug: `capacity-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Capacity Studio',
        address: `${uniqueSuffix} Capacity St`,
        city: 'Amsterdam',
        postcode: '9012CP',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Capacity Flow',
        date: new Date('2026-06-02'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 2,
        cancelDeadline: 'HOURS_24',
        status: 'open',
      },
    });
    classId = cls.id;

    for (const label of ['a', 'b', 'c', 'd']) {
      const student = await prisma.student.create({
        data: {
          firstName: 'Capacity',
          lastName: label,
          email: `capacity-${label}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
        },
      });
      studentIds.push(student.id);
    }
  });

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /** The four phases run in order against one class, each adding to the last. */
  it('counts only seat-occupying registrations, and reports overbooking honestly', async () => {
    // Phase 1 — empty class: every seat free.
    const empty = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(empty).toEqual({ maxStudents: 2, activeCount: 0, freeSeats: 2 });

    // Phase 2 — one registered: one seat left.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, tierAtBooking: 3 },
    });
    const partial = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(partial).toEqual({ maxStudents: 2, activeCount: 1, freeSeats: 1 });

    // Phase 3 — the two statuses that freed their seat must not count. A
    // `late_cancel` is still BILLED (it is in `CHARGED_STATUSES`) but its seat
    // is sold, so counting it here would make a full class look empty. This is
    // the phase that fails if the wrong status list is used.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[1]!, tierAtBooking: 3, status: 'cancelled' },
    });
    await prisma.registration.create({
      data: { classId, studentId: studentIds[2]!, tierAtBooking: 3, status: 'late_cancel' },
    });
    const withFreed = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(withFreed).toEqual({ maxStudents: 2, activeCount: 1, freeSeats: 1 });

    // Phase 4 — overbooked. Walk-ins may exceed maxStudents by design
    // (`registrations/route.ts`), so `freeSeats` goes NEGATIVE rather than
    // clamping at zero: how overbooked a class is, is real information, and
    // all four callers test `<= 0`.
    await prisma.registration.create({
      data: { classId, studentId: studentIds[3]!, tierAtBooking: 3 },
    });
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
      data: { status: 'registered' },
    });
    const over = await prisma.$transaction((tx) => readSeatCount(tx, classId));
    expect(over).toEqual({ maxStudents: 2, activeCount: 3, freeSeats: -1 });
  });
});
```

- [ ] **Step 2: Run it to watch it fail**

Run: `npx vitest run --project unit src/services/capacity.test.ts`
Expected: FAIL — `Failed to resolve import "./capacity"`.

- [ ] **Step 3: Write the implementation**

Create `src/services/capacity.ts`:

```ts
/**
 * Class capacity — the one implementation of "how many seats are left".
 *
 * "Full" is derived, never stored (`class-lifecycle.ts`), so every path that
 * hands out or announces a seat has to ask this question itself. Before this
 * module there were five such paths and each asked in its own words; one —
 * the final-hour waitlist broadcast — forgot to ask at all, which is #212.
 */
import { ACTIVE_REGISTRATION_STATUSES } from '@/lib/registration-status';
import type { TransactionClientOnly } from '@/lib/db-locks';

/** A class's seat position at one instant. `freeSeats` may be negative. */
export interface SeatCount {
  maxStudents: number;
  activeCount: number;
  /**
   * `maxStudents − activeCount`. NOT clamped at zero: walk-ins deliberately
   * exceed `maxStudents` (`POST /api/registrations`), so a negative value is
   * a real state describing how overbooked a class is. Callers test `<= 0`,
   * and a clamp added later would silently change what all of them mean.
   */
  freeSeats: number;
}

/**
 * Counts the seats left in a class, from the caller's transaction.
 *
 * **Precondition: the caller must already hold the `Class` row lock.** Without
 * it this is a snapshot with no meaning — a registration committing a
 * millisecond later makes the answer wrong, which is exactly the defect this
 * module exists to fix. Every caller takes that lock first: four via their own
 * inline `SELECT … FOR UPDATE` (the sites `db-locks.ts` reserves for #104),
 * the waitlist broadcast via `lockClassRow`.
 *
 * This function deliberately does NOT take the lock itself. Doing so would
 * retrofit `lockClassRow`'s bounded 2s wait onto those four pre-existing
 * sites, which `db-locks.ts` reserves for #104 — "retrofitting them from here
 * would blur what that issue is accountable for."
 *
 * It reads the class rather than accepting one, so a caller cannot compare a
 * freshly-locked count against a `maxStudents` it read BEFORE taking the lock.
 * That half-locked comparison is the subtle version of the bug, and this
 * signature makes it unrepresentable. The extra read is one PK lookup on a row
 * the transaction already holds locked.
 *
 * The `TransactionClientOnly` brand rejects a bare `PrismaClient` at compile
 * time (see `db-locks.ts` for how the brand works). It cannot check that the
 * caller actually took the lock — nothing in TypeScript or Postgres can — so
 * the precondition above is a review obligation, not a guarantee.
 */
export async function readSeatCount(
  tx: TransactionClientOnly,
  classId: string,
): Promise<SeatCount> {
  const cls = await tx.class.findUniqueOrThrow({
    where: { id: classId },
    select: { maxStudents: true },
  });

  const activeCount = await tx.registration.count({
    where: { classId, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } },
  });

  return { maxStudents: cls.maxStudents, activeCount, freeSeats: cls.maxStudents - activeCount };
}
```

- [ ] **Step 4: Run it to watch it pass**

Run: `npx vitest run --project unit src/services/capacity.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Prove the status list is load-bearing (mutation M2)**

In `capacity.ts`, temporarily replace the filter with one that counts
everything:

```ts
  const activeCount = await tx.registration.count({ where: { classId } });
```

Run: `npx vitest run --project unit src/services/capacity.test.ts`
Expected: FAIL at phase 3 — `activeCount` 3 instead of 1, `freeSeats` −1
instead of 1.

**Record the exact assertion diff** as `## M2 — the seat-occupying filter` in
the mutations log. Restore, re-run, expect PASS.

This is the mutation that matters: it uses a value the correct code cannot
produce, and it is the realistic regression (someone "simplifies" the filter
away), not a convenient one.

- [ ] **Step 6: Pin the brand**

In `src/lib/db-locks.test.ts`, add one line to `_theBrandRejectsABareClient`
(the docblock there says **one directive per branded function**, so it gets its
own, not a shared one). Add the import at the top of the file alongside the
others:

```ts
import { readSeatCount } from '@/services/capacity';
```

and inside the function, after the existing directives:

```ts
  // @ts-expect-error Read-only, but meaningless off a bare client: it would
  // count outside the caller's lock, which is the defect it exists to prevent.
  await readSeatCount(client, 'never-called');
```

- [ ] **Step 7: Prove the brand pin bites (mutation M3)**

Temporarily change `readSeatCount`'s parameter from `TransactionClientOnly` to
`Prisma.TransactionClient`.

Run: `npx tsc --noEmit`
Expected: FAIL — `Unused '@ts-expect-error' directive` at the new line, because
a bare `PrismaClient` is structurally assignable to `Prisma.TransactionClient`.

**Record it** as `## M3 — the transaction-client brand` in the mutations log.
Restore and re-run: clean.

- [ ] **Step 8: Add the register line and the derivation pointer**

In `src/lib/db-locks.ts`, in the register inside `TransactionClientOnly`'s
docblock, add to the `adopt` group:

```
 *   adopt  `readSeatCount` (`services/capacity.ts`) — the exception to the
 *          rule above and the reason the rule says "decided per site": it
 *          issues no transaction-scoped statement, only reads. It is branded
 *          because its whole purpose is counting UNDER the caller's lock, and
 *          on a bare client it would count outside it — the "reading around
 *          its caller's uncommitted writes" case this register names.
```

In `src/services/class-lifecycle.ts:7`, extend the existing line:

```
 * "Full" is derived (registrations >= maxStudents), not a stored state —
 * `services/capacity.ts` is where that derivation lives.
```

- [ ] **Step 9: Typecheck, lint, and commit**

```bash
npx tsc --noEmit
npx eslint src/services/capacity.ts src/services/capacity.test.ts src/lib/db-locks.ts src/lib/db-locks.test.ts src/services/class-lifecycle.ts
npx vitest run --project unit src/services/capacity.test.ts src/lib/db-locks.test.ts
```

```bash
git add src/services/capacity.ts src/services/capacity.test.ts src/lib/db-locks.ts src/lib/db-locks.test.ts src/services/class-lifecycle.ts docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md
git commit -m "feat: readSeatCount, the one answer to how many seats are left

Reads the class itself rather than taking one, so a caller cannot compare a
locked count against a maxStudents it read before locking. Branded against a
bare client — an exception to the db-locks register's read-only rule, recorded
there with its reason. It does not take the lock: that would retrofit a bounded
wait onto the four sites #104 owns.

freeSeats is not clamped — walk-ins legitimately overbook. Mutations M2 (the
status filter) and M3 (the brand) recorded.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The fix — the broadcast counts under the lock

**Files:**
- Modify: `src/services/waitlist.ts:658-675`
- Modify: `src/services/waitlist.test.ts` (new describe at the end of the file)
- Modify: `docs/lock-order.md:174`
- Modify: `docs/technical-architecture.md:191-207`

**Interfaces:**
- Consumes: `readSeatCount` (Task 2); `lockClassRow` (already imported at `waitlist.ts:14`).
- Produces: no signature change. `handleSpotFreed` still returns `SpotFreedResult`; the full-class case reuses the existing `{ action: 'none' }` member.

- [ ] **Step 1: Write the failing test**

Append to `src/services/waitlist.test.ts`. Add `handleSpotFreed` to the import
block at the top of the file.

```ts
describe('handleSpotFreed (DB)', () => {
  // One fixed class drives every instant, so nothing here reads the wall
  // clock. Same derivation as the `claimSpot (DB)` block above:
  //   class starts       2026-06-03 09:00 UTC  (teacher default timezone UTC)
  //   HOURS_24        →  deadline 2026-06-02 09:00 UTC
  //   cutoff = deadline − 1h        2026-06-02 08:00 UTC
  const IN_CLAIM_WINDOW = new Date('2026-06-02T08:30:00Z');

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let fillerId: string;
  const waiterIds: string[] = [];

  beforeAll(async () => {
    const mail = `spotfreed-teacher-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'SpotFreed',
        lastName: 'Teacher',
        email: mail,
        account: { create: { email: mail } },
        bio: 'Test teacher for handleSpotFreed tests',
        pageSlug: `spotfreed-teacher-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'SpotFreed Studio',
        address: `${uniqueSuffix} SpotFreed St`,
        city: 'Amsterdam',
        postcode: '9012SF',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 15 },
    });
    teacherRoomId = teacherRoom.id;

    const mk = async (label: string) =>
      (
        await prisma.student.create({
          data: {
            firstName: 'SpotFreed',
            lastName: label,
            email: `spotfreed-${label}-${uniqueSuffix}@test.local`,
            incomeTier: 3,
          },
        })
      ).id;
    fillerId = await mk('filler');
    waiterIds.push(await mk('waiter1'), await mk('waiter2'));

    // maxStudents: 1 plus one registration is the cheapest way to be full,
    // which is what `addToWaitlist` requires before it will accept anyone.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'SpotFreed Flow',
        date: new Date('2026-06-03'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 1,
        cancelDeadline: 'HOURS_24',
        status: 'open',
      },
    });
    classId = cls.id;

    await prisma.registration.create({
      data: { classId, studentId: fillerId, tierAtBooking: 3 },
    });
    for (const waiterId of waiterIds) {
      await addToWaitlist(prisma, classId, waiterId);
    }
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.deleteMany({ where: { id: { in: [fillerId, ...waiterIds] } } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
  });

  const countBroadcasts = () =>
    prisma.notification.count({ where: { relatedClassId: classId, type: 'spot_available' } });

  /**
   * #212. Both halves are one test on purpose: the second is the control that
   * makes the first mean something. Asserting only "no notifications on a full
   * class" would pass against a `handleSpotFreed` that had been broken to do
   * nothing at all, which is not the property under test.
   */
  it('stays silent when the class is already full, and broadcasts when it is not', async () => {
    // The class is full (maxStudents 1, filler still registered) and the clock
    // is inside the final-hour window — the exact state a refill leaves behind
    // when it commits between a cancel and this hook. Before the fix, this
    // branch read the queue and notified both waiters without ever counting.
    const whenFull = await handleSpotFreed(prisma, classId, IN_CLAIM_WINDOW);
    expect(whenFull).toEqual({ action: 'none' });
    expect(await countBroadcasts()).toBe(0);

    // Now free the seat. Same class, same queue, same instant — the only thing
    // that changed is that a seat exists.
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId: fillerId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });

    const whenFree = await handleSpotFreed(prisma, classId, IN_CLAIM_WINDOW);
    expect(whenFree).toEqual({ action: 'broadcast', notified: 2 });
    expect(await countBroadcasts()).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to watch it fail against the bug**

Run: `npx vitest run --project unit src/services/waitlist.test.ts -t 'stays silent'`
Expected: FAIL on the first assertion — the current code returns
`{ action: 'broadcast', notified: 2 }` for a full class, and
`countBroadcasts()` is 2 where 0 is expected.

**This failure is the bug.** Record it as `## M4 — the broadcast's capacity
guard (pre-fix baseline)` in the mutations log — for this guard the mutation
and the original defect are the same edit, so the baseline failure IS the
proof, and re-deleting the guard after the fix must reproduce it exactly.

- [ ] **Step 3: Implement the fix**

Replace `src/services/waitlist.ts:658-675` (from the
`// first_come_first_claimed:` comment through the `return { action:
'broadcast', … }`) with:

```ts
  // first_come_first_claimed: notify everyone waiting; first claim wins.
  //
  // Under the class row lock, and counting before it speaks (#212). Both
  // siblings that hand out a seat check capacity — `promoteNext` and
  // `claimSpot` above — and this branch did not, so a class refilled between
  // the cancel and this hook still told every waiting student a spot had
  // opened. `claimSpot`'s own check then rejected them: the notification was
  // wrong when it was written, not merely stale by the time it was read.
  //
  // The lock is what makes the count mean anything. Read outside it, this
  // would only move the race from "cancel-commit → findMany" to "count →
  // createMany" — and a race is the ONLY way to reach this state, since a
  // cancel frees the seat it announces. Every writer that creates a
  // registration takes this same row lock, so they serialise against this
  // transaction: one arriving after the count blocks until this commits.
  //
  // `lockClassRow`, not the inline `FOR UPDATE` the three functions above
  // use: those are pre-existing unbounded waits that `db-locks.ts` reserves
  // for #104. This site is new, so it takes the bounded 2s wait from the
  // start. The cost is that a class row held longer than that drops the
  // broadcast entirely — both callers log and swallow. That is the
  // conservative outcome: a writer holding this row that long is probably
  // filling the seat.
  const entries = await db.$transaction(async (tx) => {
    await lockClassRow(tx, classId);

    const { freeSeats } = await readSeatCount(tx, classId);
    if (freeSeats <= 0) return [];

    const waiting = await tx.waitlistEntry.findMany({
      where: { classId, status: 'waiting' },
    });
    if (waiting.length === 0) return [];

    await createBulkNotifications(
      tx,
      waiting.map((w) => ({
        recipientType: 'student' as const,
        recipientId: w.studentId,
        type: 'spot_available' as const,
        title: 'A spot opened up',
        body: `A spot opened in ${cls.classType}. The first to claim it gets it.`,
        relatedClassId: classId,
      })),
    );
    return waiting;
  });

  // No log line on the full-class path, deliberately. The auto-promote branch
  // above already handles this exact event silently — it catches
  // `promoteNext`'s `class_full` and returns the same `{ action: 'none' }`
  // under "A concurrent registration may have refilled the spot — that's
  // fine." One event, one story; a `warn` would ask an operator to act on an
  // outcome where the cancel and the refill both did the right thing.
  return entries.length === 0
    ? { action: 'none' }
    : { action: 'broadcast', notified: entries.length };
```

Add `readSeatCount` to the imports at the top of `waitlist.ts`:

```ts
import { readSeatCount } from './capacity';
```

`lockClassRow` is already imported (`:14`). `cls` is the pre-lock read at
`:631` and is still what supplies `classType` for the message body —
re-deriving `status` and `window` under the lock is out of scope (spec §7).

- [ ] **Step 4: Run it to watch it pass**

Run: `npx vitest run --project unit src/services/waitlist.test.ts`
Expected: PASS — the new test and every pre-existing test in the file.

- [ ] **Step 5: Re-run the mutation**

Delete the two guard lines:

```ts
    const { freeSeats } = await readSeatCount(tx, classId);
    if (freeSeats <= 0) return [];
```

Run: `npx vitest run --project unit src/services/waitlist.test.ts -t 'stays silent'`
Expected: FAIL, **identical to the Step 2 baseline**. Confirm the messages
match and note that in the M4 entry — a mutation that fails differently from
the original defect is testing something else.

Restore, re-run, expect PASS.

- [ ] **Step 6: Check the callers' suites still pass**

Both call sites reach this branch through routes:

```bash
npx vitest run --project unit src/services/gdpr.test.ts
```

Expected: PASS, and the reason is worth knowing before you run it rather than
after. `gdpr.test.ts:1550` drives the erasure path deliberately inside the
final-hour window — the only window where `handleSpotFreed` broadcasts. Its
fixture is a `maxStudents: 1` class where the **erased student holds the only
seat**, and the erasure cancels that registration inside its transaction
before the post-commit hook runs. So `freeSeats` is 1 when the new guard reads
it, and the broadcast still goes out.

If that suite fails, the fix is over-firing — the guard is seeing a full class
where a seat was genuinely freed. Investigate the guard, **not** the fixture.

- [ ] **Step 7: Update `docs/lock-order.md:174`**

Replace the table row:

```
| `handleSpotFreed` broadcast (`waitlist.ts`) | one — `classId`, and outside any transaction |
```

with:

```
| `handleSpotFreed` broadcast (`waitlist.ts`) | one — `classId`, inside its own transaction under `lockClassRow` (#212) |
```

Add below the table:

> **#212 moved the broadcast inside a transaction, and the order is unchanged.**
> It was one of three `createBulkNotifications` sites taking no `Class` row
> lock. The other two — `sendPaymentReminder` (`payments.ts`) and
> `sendPaymentReminders` (`payment-reminders.ts`) — still take none: both are
> payment-scoped, reaching a class only through the `relatedClassId` on the
> notification they write. It now takes `lockClassRow` and then inserts
> notifications carrying `relatedClassId` — a `FOR KEY SHARE` on the row it
> already holds `FOR UPDATE`, exactly as `deleteTeacherAccount`'s named
> exception above. One class per transaction, so it adds no edge.

**This step originally told the implementer to write "the one site that took no
`Class` lock at all", which is false** — `payments.ts` and
`payment-reminders.ts` contain neither `lockClassRow` nor `FOR UPDATE`, so there
were three such sites. It was written into the spec, copied here, and
implemented faithfully; PR review caught it. Corrected in place rather than
silently, because the failure was a completeness claim asserted without the one
grep that would have checked it.

- [ ] **Step 8: Correct `docs/technical-architecture.md:191-207`**

The sketch names three functions that do not exist and inverts the window.
Replace the code block with one that matches the code:

```typescript
// More than 1h before cancel_deadline: auto-promote the queue head
// Final hour BEFORE the deadline: first-come-first-claimed broadcast
// At or after the deadline: frozen — nothing happens
async function handleSpotFreed(db, classId, now?): Promise<SpotFreedResult> {
  const cls = await db.class.findUnique({ where: { id: classId }, ... });
  if (!cls || cls.status !== 'open') return { action: 'none' };

  const window = getWaitlistWindow(cls.date, cls.startTime, cls.cancelDeadline, tz, now);
  if (window === 'frozen') return { action: 'frozen' };

  if (window === 'auto_promote') {
    // promoteNext: under the Class row lock, checks capacity, promotes the head
    return ...;
  }

  // first_come_first_claimed: under the Class row lock, counts free seats
  // (#212 — it used to notify without checking), then notifies everyone
  // waiting. The first claim wins; claimSpot re-checks capacity.
  return ...;
}
```

- [ ] **Step 9: Typecheck, lint, and commit**

```bash
npx tsc --noEmit
npx eslint src/services/waitlist.ts src/services/waitlist.test.ts
```

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts docs/lock-order.md docs/technical-architecture.md docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md
git commit -m "fix: the final-hour broadcast counts seats before it announces one

Closes the #212 defect. Both siblings that hand out a seat check capacity; the
broadcast did not, so a class refilled between the cancel and the hook still
told every waiting student a spot had opened — wrong when written, not stale
when read.

Counted under lockClassRow, not bare: a cancel frees the seat it announces, so
a race is the only way to reach this state, and an unlocked count would move
the race rather than close it. lockClassRow rather than the inline FOR UPDATE
its three neighbours use — those are #104's unbounded waits, this site is new.

The test's second half is the control: without it the first half would pass
against a hook broken to do nothing. Mutation M4 reproduces the original
failure exactly.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Adopt `readSeatCount` at the four pre-existing sites

Pure refactor. No behaviour changes — same errors, same codes, same
boundaries. **Each site's guard is mutation-proved, because adoption is exactly
where a `<` silently becomes a `<=`.**

**Files:**
- Modify: `src/services/waitlist.ts:185-193` (`addToWaitlist`), `:412-417` (`promoteNext`), `:550-555` (`claimSpot`)
- Modify: `src/app/api/registrations/route.ts:142-148`

**Interfaces:**
- Consumes: `readSeatCount` (Task 2). No new exports.

- [ ] **Step 1: `addToWaitlist` — note the inverted comparison**

Replace `:185-193`:

```ts
    const { freeSeats } = await readSeatCount(tx, classId);
    if (freeSeats > 0) {
      throw new WaitlistJoinError(
        'The class still has open spots — book directly instead',
        'class_not_full',
      );
    }
```

This is the one site whose test is inverted — it refuses when a seat *is*
free. Also drop `maxStudents` from the `select` at `:176`, now unused there:

```ts
      select: { status: true, teacherId: true },
```

- [ ] **Step 2: `promoteNext` and `claimSpot`**

`:412-417` becomes:

```ts
    const { freeSeats } = await readSeatCount(tx, classId);
    if (freeSeats <= 0) {
      throw new WaitlistPromotionError('Class is full', 'class_full');
    }
```

`:550-555` becomes:

```ts
    const { freeSeats } = await readSeatCount(tx, classId);
    if (freeSeats <= 0) {
      throw new WaitlistPromotionError('The spot has already been claimed', 'class_full');
    }
```

Leave both `findUniqueOrThrow` reads alone — they fetch the full row for
`status`, the window fields and `teacher.defaultTimezone`.

- [ ] **Step 3: The booking route**

Replace `registrations/route.ts:142-148`:

```ts
      const { freeSeats } = await readSeatCount(tx, body.classId);

      if (freeSeats <= 0 && !isWalkIn) {
        throw new ClassFullError();
      }
```

**`body.classId`, not `classId`** — this handler has no local `classId`
binding; every query in it reads `body.classId`.

Two things to check before deleting the old lines: that `registrationCount` is
not referenced anywhere else in the handler (`grep -n registrationCount
src/app/api/registrations/route.ts`), and that
`ACTIVE_REGISTRATION_STATUSES`'s import is still needed for the `.includes()`
at `:156` — **it is**, so do not remove it.

Add the import:

```ts
import { readSeatCount } from '@/services/capacity';
```

- [ ] **Step 4: Run the affected suites before mutating**

```bash
npx vitest run --project unit src/services/waitlist.test.ts
npx vitest run --project integration tests/integration/registrations-api.test.ts tests/integration/waitlist-api.test.ts
```

Expected: PASS, unchanged. The `integration` project needs the app live on
:3000 — do not start it; ask the user if it is not running.

- [ ] **Step 5: Prove all four guards bite (mutations M5-M8)**

One at a time — mutate, run, record the exact failure, restore, re-run:

| # | Site | Mutation | Expected failure |
|---|---|---|---|
| M5 | `addToWaitlist` | `freeSeats > 0` → `freeSeats >= 0` | A student joins a waitlist on a class with a free seat instead of getting `class_not_full` |
| M6 | `promoteNext` | `freeSeats <= 0` → `freeSeats < 0` | A promotion succeeds into a class at exactly `maxStudents` |
| M7 | `claimSpot` | `freeSeats <= 0` → `freeSeats < 0` | A claim succeeds on a full class instead of `class_full` |
| M8 | booking route | `freeSeats <= 0` → `freeSeats < 0` | A booking is accepted at exactly `maxStudents` instead of 409 |

Every one is an off-by-one at the boundary, which is the realistic regression
for this refactor — not a mutation that deletes the guard outright. If any
mutation passes, the boundary is untested: **write the missing test before
continuing**, and note in the log that the coverage gap was found by the
mutation rather than assumed away.

Record all four in the mutations log.

- [ ] **Step 6: Typecheck, lint, and commit**

```bash
npx tsc --noEmit
npx eslint src/services/waitlist.ts src/app/api/registrations/route.ts
```

```bash
git add src/services/waitlist.ts src/app/api/registrations/route.ts docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md
git commit -m "refactor: the four remaining capacity checks call readSeatCount

Same errors, same codes, same boundaries — only the counting is shared; each
site keeps its own policy, including addToWaitlist's inverted one. Mutations
M5-M8 prove each boundary still bites at exactly maxStudents, which is where
this kind of adoption goes wrong.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Final verification, before pushing

- [ ] **Step 1: The whole suite**

```bash
npm run verify
```

Needs the app running on :3000 (the user runs it — never start or restart it).
Without it, expect a wall of `ECONNREFUSED` from the `integration` project.

Green `verify` is a strong signal but **not** a substitute for CI: CI also runs
`prisma validate`, a migration-drift check, `npm run build`, and Playwright. A
build-only defect passes here and fails there.

Record the test counts (`N = a unit + b components + c integration`) — that
arithmetic is what turns "every integration file ran" into a checkable claim in
the PR body.

- [ ] **Step 2: Re-run the census**

```bash
grep -rn "'registered'" src --include='*.ts' --include='*.tsx' | grep attended | wc -l
```

Expected: 8 (see Task 1 Step 9 for the arithmetic).

```bash
grep -rn "registration.count" src --include='*.ts' | grep -v '\.test\.'
```

Expected: **2** — `capacity.ts` and `class-transitions.ts:287` (which counts
against `minStudents`, a different question). The four capacity sites and the
new one all route through `readSeatCount`.

- [ ] **Step 3: Confirm the mutations log is complete**

`docs/superpowers/plans/2026-08-13-waitlist-broadcast-capacity-mutations.md`
must hold **eight** entries, M1-M8, each with the exact error text observed —
not a paraphrase. A guard listed without its recorded failure has not been
proved.

- [ ] **Step 4: Push and open the PR**

The PR body must record: what was measured, which of the issue's claims held
and which did not (its walk-in and re-registration scenarios do not — see spec
§1), the arithmetic behind every number, the behaviour change under lock
contention (spec §4.4), what the PR does **not** do (spec §7), and which suites
ran, naming the touched `integration` files by path.

**Write "#104 is unaffected" and "#182 is unaffected"** — never the phrasing
with a GitHub closing keyword in front of a number, which auto-closes the issue
it was written to exempt. That trap has fired twice on this repo, the second
time inside a commit written to document it.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| §4.1 `registration-status.ts`, membership pin, `CHARGED_STATUSES` pointer | T1 (steps 1, 2, 7) |
| §4.2 `readSeatCount`, no lock, brand, no clamp | T2 (steps 3, 6, 8) |
| §4.3 five sites adopting the helper | T3 (the broadcast) + T4 (the other four) |
| §4.4 the lock, `lockClassRow`, lock-order | T3 (steps 3, 7) |
| §4.5 `{ action: 'none' }`, no log | T3 (step 3, the trailing comment) |
| §5 tests and mutations | T2 (M2, M3), T3 (M4), T4 (M5-M8), T1 (M1) |
| §6 documentation | T1 (step 7), T2 (step 8), T3 (steps 7, 8) |
| §8 acceptance 1-7 | T3 (1), all (2), T1 step 9 (3), final step 2 (4), T4 step 4 (5), T3 steps 7-8 (6), final step 1 (7) |

No spec requirement is unassigned.
