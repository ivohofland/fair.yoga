# Cancelled Class Moves To Past Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `/bookings` (student) so a cancelled class dated in the past moves to **Past classes** instead of staying under **Upcoming** forever, and shows a text "Cancelled" marker there instead of nothing.

**Architecture:** Extract the upcoming/past decision that currently lives inline in `src/app/(student)/bookings/page.tsx` into a small, framework-agnostic predicate — `isUpcomingRegistration` in a new `src/lib/booking-ledger.ts` — following the existing pattern of `src/lib/payment-status.ts` / `src/lib/payment-breakdown.ts` / `src/lib/price-line.ts`, all of which already back this same page. The predicate special-cases a cancelled class (decided by its start instant via `classStartInstant`, not its frozen status) and otherwise preserves the existing status-first logic unchanged. This buys a unit test that can pin an exact UTC/local-timezone divergence, which an integration test hitting live wall-clock time cannot.

**Tech Stack:** Next.js 16 App Router (server component, `force-dynamic`), Prisma, Vitest (unit + integration projects).

**Spec:** None — this is a **bounded** fix (superpowers:brainstorming classification): the flow being changed already exists and reads from a single file, the issue itself (#598) already resolved both open design questions (compare by `classStartInstant`, not raw `date`; the Past marker is text, not a badge), and there is exactly one reasonable approach. The design was presented and approved in-chat rather than written to `docs/superpowers/specs/`.

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types (CLAUDE.md).
- Test-first: write the failing test, watch it fail, implement, watch it pass (CLAUDE.md).
- Comment Discipline (CLAUDE.md): a comment states what is true now and annotates the code it sits on; no prose counts/rosters; issue-number references for historical "why" are the established convention in this codebase and are fine.
- Design brief: payment/lifecycle *state* text is glyph+color, never a `StatusBadge`, for a Past row (CLAUDE.md → Design Philosophy: "payment states are text only... never badges"; issue #598 restates this for the cancelled marker specifically).
- Never edit an applied migration. Not applicable here — no schema change in this plan.

---

### Task 1: Extract `isUpcomingRegistration`, fix the page, add the cancelled marker

**Files:**
- Create: `src/lib/booking-ledger.ts`
- Create: `src/lib/booking-ledger.test.ts`
- Modify: `src/app/(student)/bookings/page.tsx`
- Modify: `tests/integration/bookings-page.test.ts`

**Interfaces:**
- Produces: `isUpcomingRegistration(cls: { status: ClassStatus; calendarEntry: { date: Date; startTime: Date; cancelledAt: Date | null; teacher: { defaultTimezone: string } } }, now: Date): boolean` — exported from `src/lib/booking-ledger.ts`. This is the only new public surface; `bookings/page.tsx` is its only production caller.

#### Background the implementer needs

`src/app/(student)/bookings/page.tsx` currently splits a student's registrations into Upcoming and Past like this (around line 180):

```ts
const now = new Date();
// `cancelledAt` is NOT a filter here, deliberately: this splits the ledger
// into upcoming and past, and a cancelled class the student is registered
// for still belongs in whichever half its date puts it in. The badge below
// is what says it is off.
const upcoming = registrations.filter(
  (r) => r.class.status === 'open'
    || r.class.status === 'in_progress'
    || new Date(r.class.calendarEntry.date) >= now,
);
const past = registrations.filter((r) => !upcoming.includes(r));
```

The bug (#598): a cancelled class keeps whatever `Class.status` it was cancelled from (#327 — cancellation is `CalendarEntry.cancelledAt`, not a status). Every registration this page can load belongs to a class that was, at booking time, `open` — so `r.class.status === 'open'` is true for the overwhelming majority of cancelled classes on this page, and the `||` chain never reaches the date check. The comment above the code describes intended behavior the code doesn't implement.

The fix decides a cancelled class by its **start instant**, not raw `calendarEntry.date`: `calendarEntry.date` is a `@db.Date` stored at UTC midnight, which can sit hours away from the teacher's actual wall-clock start (see `src/lib/timezone.ts`'s `classStartInstant` docblock, and #101/#278 which hit the same trap elsewhere in this codebase). `src/app/(teacher)/settings/reporting/page.tsx:74` already does exactly this on a read path: `classStartInstant(s.calendarEntry, session.defaultTimezone) <= now` — that is the precedent to follow, not `startsInPast` (that helper's fail-closed default and "refusing write" log line are write-refusal semantics, wrong for a read-only page split).

`teacher.defaultTimezone` is not currently selected on this page's registrations query — it needs adding to the `teacher.select` used for `calendarEntry.teacher` (around line 43-51 today):

```ts
teacher: {
  select: {
    firstName: true,
    lastName: true,
    pageSlug: true,
    bankIban: true,
    bankAccountName: true,
  },
},
```

The Past row (around line 370-390 today) renders nothing to mark a class cancelled — its `payment` block is naturally skipped, since a cancelled class never reaches `completed` and so never gets a `Payment` row (`completeClass` is the only creator, and the entry-terminal-liveness guard keeps `cancelledAt` and `completed` from ever coexisting on the same row — CLAUDE.md → Class Lifecycle). This is why the acceptance criteria's "no amount, no How to pay" fall out for free once the class is bucketed as Past — but nothing today tells the student the class didn't happen, per #598:

```tsx
return (
  <div key={reg.id} className="min-h-14 py-3 border-b border-border last:border-b-0">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-base text-ink">{cls.calendarEntry.classType}</p>
        <p className="type-caption">
          {formatDayHeader(cls.calendarEntry.date)} · with {cls.calendarEntry.teacher.firstName} {cls.calendarEntry.teacher.lastName}
        </p>
      </div>
      {payment && (
        <div className="text-right shrink-0">
          <p className={`type-number ${outstanding ? 'text-brown' : ''}`}>
            €{Number(payment.amount).toFixed(2)}
          </p>
          {/* Payment state is text, never a badge */}
          <p className={`type-caption ${paymentStateText(payment.status).className}`}>
            {paymentStateText(payment.status).label}
          </p>
        </div>
      )}
    </div>
    {payment && outstanding && (
      ...How to pay disclosure...
    )}
    {breakdown.kind === 'shown' && (
      <PaymentBreakdown ... />
    )}
  </div>
);
```

`resolvePaymentBreakdown` (`src/lib/payment-breakdown.ts`) already gates on `classStatus !== 'completed'` returning `{ kind: 'hidden' }`, and a cancelled class's status is never `'completed'` — so #576's breakdown is already unaffected by where a cancelled row lands. This task adds a test proving that, but does not need to change `payment-breakdown.ts`.

The 2099-dated cancelled fixture in `tests/integration/bookings-page.test.ts` (describe block `'GET /bookings (page) — price line and link gated on bookable state'`) already covers "a cancelled class still ahead stays under Upcoming" and needs no changes.

`classStartInstant`'s signature: `classStartInstant(cls: { date: Date; startTime: Date }, timeZone: string): Date` (`src/lib/timezone.ts`).

- [ ] **Step 1: Write the failing unit tests for `isUpcomingRegistration`**

Create `src/lib/booking-ledger.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isUpcomingRegistration } from './booking-ledger';
import { hhmmToTime } from './time-of-day';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('isUpcomingRegistration', () => {
  it('is upcoming while open, regardless of date', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'open',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: null,
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('is upcoming while in_progress, regardless of date', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'in_progress',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: null,
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('falls through to the date for a completed class', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'completed',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: null,
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(false);
  });

  /**
   * THE BUG (#598). Before this predicate existed, `status === 'open'` alone
   * put a cancelled class under Upcoming forever, because cancellation never
   * changes `Class.status` (#327).
   */
  it('an open class cancelled in the past is no longer upcoming', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'open',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: new Date('2020-01-01T08:00:00.000Z'),
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('a cancelled class still ahead stays upcoming', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'open',
          calendarEntry: {
            date: day('2099-08-02'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: new Date('2026-06-01T00:00:00.000Z'),
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  /**
   * THE CASE THAT KILLS "compare `calendarEntry.date` directly" for a
   * cancelled class — same fixture `timezone.test.ts`'s `startsInPast`
   * west-of-UTC case proves `classStartInstant` against, borrowed rather
   * than re-derived: 02:00 on 15 June in Los Angeles (PDT, UTC-7) is
   * `2026-06-15T09:00Z`, while the stored `date` column reads UTC midnight,
   * `2026-06-15T00:00Z` — nine hours earlier. `now` sits between the two:
   * after the stored column (a naive comparison reads "past") and before the
   * true start (correct answer: still upcoming).
   */
  it('reads the wall clock in the teacher zone for a cancelled class, not the stored UTC date', () => {
    const cancelledLaClass = {
      status: 'open' as const,
      calendarEntry: {
        date: day('2026-06-15'),
        startTime: hhmmToTime('02:00'),
        cancelledAt: new Date('2026-06-01T00:00:00.000Z'),
        teacher: { defaultTimezone: 'America/Los_Angeles' },
      },
    };

    expect(isUpcomingRegistration(cancelledLaClass, new Date('2026-06-15T05:00:00.000Z'))).toBe(
      true,
    );

    // One hour past the true start: now Past. Proves the case can't pass by
    // always answering `true`.
    expect(isUpcomingRegistration(cancelledLaClass, new Date('2026-06-15T10:00:00.000Z'))).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project unit src/lib/booking-ledger.test.ts`
Expected: FAIL — `Cannot find module './booking-ledger'` (the file doesn't exist yet). If the project has no file named `unit` for plain `src/lib` tests, check `vitest.config.ts`/`vitest.workspace.ts` for the correct project name and use that instead — this repo runs `src/lib/*.test.ts` files as plain unit tests (see `src/lib/timezone.test.ts`, `src/lib/payment-status.test.ts` for precedent), not `--project integration`.

- [ ] **Step 3: Create `src/lib/booking-ledger.ts`**

```ts
import type { ClassStatus } from '@prisma/client';
import { classStartInstant } from './timezone';

interface UpcomingLedgerClass {
  status: ClassStatus;
  calendarEntry: {
    date: Date;
    startTime: Date;
    cancelledAt: Date | null;
    teacher: { defaultTimezone: string };
  };
}

/**
 * Whether a registration's class belongs under Upcoming, not Past, on
 * `/bookings`.
 *
 * A cancelled class keeps whatever status it was cancelled from (#327) — an
 * `open` or `in_progress` class cancelled by any of the three cancel paths
 * never changes `Class.status` — so status alone can't decide a cancelled
 * class. Its start instant does, via `classStartInstant`, not
 * `calendarEntry.date`: that column is a stored UTC-midnight calendar date
 * and can sit hours away from the teacher's actual wall-clock start in
 * either direction (#101, #278).
 *
 * A live (non-cancelled) class stays decided by status first — `open` and
 * `in_progress` are upcoming regardless of date, matching the lifecycle in
 * CLAUDE.md; only a `draft` or `completed` class falls through to the date
 * check.
 */
export function isUpcomingRegistration(cls: UpcomingLedgerClass, now: Date): boolean {
  const { calendarEntry } = cls;
  if (calendarEntry.cancelledAt !== null) {
    return classStartInstant(calendarEntry, calendarEntry.teacher.defaultTimezone) >= now;
  }
  return cls.status === 'open' || cls.status === 'in_progress' || calendarEntry.date >= now;
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/booking-ledger.test.ts` (or whichever project name Step 2 resolved to)
Expected: PASS, all 6 tests.

- [ ] **Step 5: Prove the west-of-UTC guard actually bites**

Temporarily change the cancelled branch in `src/lib/booking-ledger.ts` to the naive, wrong comparison:

```ts
  if (calendarEntry.cancelledAt !== null) {
    return calendarEntry.date >= now;
  }
```

Run: `pnpm exec vitest run --project unit src/lib/booking-ledger.test.ts`
Expected: FAIL — the "reads the wall clock in the teacher zone" test's first assertion now gets `false` instead of `true` (the mutation reads the stored `2026-06-15T00:00Z` against `2026-06-15T05:00Z` and calls it Past). Confirm the failure names that test. Then revert the file to the Step 3 version and re-run to confirm all 6 pass again.

- [ ] **Step 6: Write the failing integration test**

In `tests/integration/bookings-page.test.ts`, add a new `describe` block. Place it after the `'GET /bookings (page) — price line and link gated on bookable state'` block (after its closing `});`, i.e. after line ~506 as the file stands today — find the exact spot by searching for that describe's closing brace, since other tasks may have touched line numbers by the time this runs). Match this file's existing imports (`describe, it, expect, beforeAll, afterAll` from vitest; `BASE_URL, cookie, uniqueSuffix, seedSession` from `'../helpers'`; `createClassFixture` from `'../class-fixtures'`; `hhmmToTime` from `'@/lib/time-of-day'`) — no new imports are needed.

```ts
/**
 * `/bookings` — #598: a class cancelled while it was `open` keeps that
 * status forever (#327), so the ledger split can't use status alone to
 * decide a cancelled class is Past. This class is dated well before `now`
 * and must move to Past classes, with a text "Cancelled" marker and no
 * payment UI — a cancelled class never reaches `completed`, so it never
 * gets a `Payment` row (`completeClass` is the only creator) and #576's
 * payment breakdown (gated on `classStatus === 'completed'`,
 * `src/lib/payment-breakdown.ts`) is unaffected by where it lands.
 */
describe('GET /bookings (page) — cancelled class moves to Past', () => {
  const suffix4 = uniqueSuffix();
  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let roomId = '';
  let cancelledPastClassId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `cancelled-past-teacher-${suffix4}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'CancelledPast', lastName: 'Teacher', email: teacherEmail,
        bio: 'Cancelled-past fixture teacher',
        pageSlug: `cancelled-past-teacher-${suffix4}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Cancelled Past Studio',
        address: `${suffix4} Cancelled St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 10, rentalRate: 15 },
    });

    const studentEmail = `cancelled-past-student-${suffix4}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'CancelledPast', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        incomeTier: 3, tierSelectedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    const cancelledPastClass = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Cancelled Past Class',
      date: new Date('2026-01-10'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 40,
      minStudents: 1,
      maxStudents: 6,
      status: 'open',
      cancelledAt: new Date('2026-01-09T00:00:00.000Z'),
    });
    cancelledPastClassId = cancelledPastClass.id;

    await prisma.registration.create({
      data: { classId: cancelledPastClassId, studentId, tierAtBooking: 3, status: 'registered' },
    });

    // Warm the route before the assertions score anything.
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('shows a cancelled-in-the-past class under Past classes, marked cancelled, with no payment UI', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    // This student has exactly one registration. If it were still bucketed
    // under Upcoming, the Upcoming section (`{upcoming.length > 0 && (...)}`)
    // would render and Past classes would not.
    expect(html).toContain('Past classes');
    expect(html).not.toContain('Upcoming');
    expect(html).toContain('Cancelled Past Class');

    // Text marker, no payment amount, no disclosures — #576's breakdown
    // included, since none of the three renders for a class that never
    // reached `completed`.
    expect(html).toContain('Cancelled');
    expect(html).not.toContain('€');
    expect(html).not.toContain('How to pay');
    expect(html).not.toContain('Where your payment goes');
  });
});
```

- [ ] **Step 7: Run the integration test to verify it fails**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts -t "shows a cancelled-in-the-past class"`
Expected: FAIL on `expect(html).toContain('Past classes')` or `expect(html).not.toContain('Upcoming')` — today's code buckets this class under Upcoming because `status === 'open'`. Confirm the app is running first (`pnpm run worktree:up` in a worktree — see the hazard list in `.claude/skills/solve-issue/`); curl `${INTEGRATION_BASE_URL}/bookings` once to warm the route if the first run times out on compilation rather than the assertion.

- [ ] **Step 8: Add `defaultTimezone` to the teacher select**

In `src/app/(student)/bookings/page.tsx`, in the main `registrations` query, find:

```ts
                teacher: {
                  select: {
                    firstName: true,
                    lastName: true,
                    pageSlug: true,
                    bankIban: true,
                    bankAccountName: true,
                  },
                },
```

(This is inside `include.class.include.calendarEntry.include.teacher`, distinct from the `waitlistEntries` query's own teacher select a little further down — do not touch that one, it already selects `defaultTimezone`.)

Change to:

```ts
                teacher: {
                  select: {
                    firstName: true,
                    lastName: true,
                    pageSlug: true,
                    bankIban: true,
                    bankAccountName: true,
                    defaultTimezone: true,
                  },
                },
```

- [ ] **Step 9: Replace the upcoming/past filter**

Add the import (alongside the other `@/lib/...` imports near the top of the file):

```ts
import { isUpcomingRegistration } from '@/lib/booking-ledger';
```

Replace:

```ts
  const now = new Date();
  // `cancelledAt` is NOT a filter here, deliberately: this splits the ledger
  // into upcoming and past, and a cancelled class the student is registered
  // for still belongs in whichever half its date puts it in. The badge below
  // is what says it is off.
  const upcoming = registrations.filter(
    (r) => r.class.status === 'open'
      || r.class.status === 'in_progress'
      || new Date(r.class.calendarEntry.date) >= now,
  );
  const past = registrations.filter((r) => !upcoming.includes(r));
```

with:

```ts
  const now = new Date();
  const upcoming = registrations.filter((r) => isUpcomingRegistration(r.class, now));
  const past = registrations.filter((r) => !isUpcomingRegistration(r.class, now));
```

- [ ] **Step 10: Add the cancelled marker to the Past row**

In the `past.map((reg) => { ... })` callback, find:

```ts
            const cls = reg.class;
            const payment = reg.payment;
            const outstanding = payment ? isOutstanding(payment.status) : false;
```

Add a `cancelled` flag alongside:

```ts
            const cls = reg.class;
            const payment = reg.payment;
            const outstanding = payment ? isOutstanding(payment.status) : false;
            const cancelled = cls.calendarEntry.cancelledAt !== null;
```

Then find the row's right-hand column:

```tsx
                  {payment && (
                    <div className="text-right shrink-0">
                      <p className={`type-number ${outstanding ? 'text-brown' : ''}`}>
                        €{Number(payment.amount).toFixed(2)}
                      </p>
                      {/* Payment state is text, never a badge */}
                      <p className={`type-caption ${paymentStateText(payment.status).className}`}>
                        {paymentStateText(payment.status).label}
                      </p>
                    </div>
                  )}
```

Replace with:

```tsx
                  {/* A cancelled class never has a payment — `completeClass`
                      is the only creator of one, and the entry's
                      terminal-liveness guard keeps `cancelledAt` and
                      `completed` from ever coexisting (#327) — so this
                      branches on `cancelled` instead of stacking a second
                      independent `&&` guard beside `payment`. */}
                  {cancelled ? (
                    <div className="text-right shrink-0">
                      <p className="type-caption text-brown">Cancelled</p>
                    </div>
                  ) : (
                    payment && (
                      <div className="text-right shrink-0">
                        <p className={`type-number ${outstanding ? 'text-brown' : ''}`}>
                          €{Number(payment.amount).toFixed(2)}
                        </p>
                        {/* Payment state is text, never a badge */}
                        <p className={`type-caption ${paymentStateText(payment.status).className}`}>
                          {paymentStateText(payment.status).label}
                        </p>
                      </div>
                    )
                  )}
```

- [ ] **Step 11: Run the integration test to verify it passes**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts -t "shows a cancelled-in-the-past class"`
Expected: PASS.

- [ ] **Step 12: Run the whole `bookings-page.test.ts` file to check for regressions**

Run: `pnpm exec vitest run --project integration tests/integration/bookings-page.test.ts`
Expected: PASS, every test in the file — in particular `'shows the price line and link for a bookable open class, but not for a cancelled or in-progress one'` (the 2099 cancelled fixture, which must stay under Upcoming) and the `'GET /bookings (page) — past-class payment breakdown'` block (completed classes, unaffected).

- [ ] **Step 13: Typecheck and lint**

Run: `pnpm run typecheck` (or the project's equivalent — check `package.json` scripts if the name differs) and `pnpm run lint`.
Expected: both clean. Pay particular attention to `src/lib/booking-ledger.ts`'s `UpcomingLedgerClass` type against the actual Prisma query shape in `page.tsx` — `strict: true` will catch a mismatched `cancelledAt`/`teacher` nesting at the call site.

- [ ] **Step 14: Commit**

```bash
git add src/lib/booking-ledger.ts src/lib/booking-ledger.test.ts "src/app/(student)/bookings/page.tsx" tests/integration/bookings-page.test.ts
git commit -m "$(cat <<'EOF'
fix(bookings): move a cancelled class to Past once its start has passed

A cancelled class keeps whatever status it was cancelled from (#327), so
the ledger split's status-first disjuncts kept it under Upcoming forever.
isUpcomingRegistration (src/lib/booking-ledger.ts) decides a cancelled
class by its start instant instead, via classStartInstant rather than the
stored UTC-midnight date column. The Past row now says "Cancelled" in
place of the payment column it never has.

Fixes #598

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

**This is the plan's only task.** Its diff is the whole branch, already reviewed at the task level — per `.claude/skills/solve-issue/`, a single-task plan skips the separate whole-branch review step (a second pass over identical content can't catch what that review exists to catch).
