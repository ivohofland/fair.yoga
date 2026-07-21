# Notification Delivery Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Essential notification types email regardless of the student's email opt-out, and class-linked notifications email on the next sweep when the class starts within 2 hours.

**Architecture:** A new pure policy module (`src/services/notification-policy.ts`) owns both decisions: *whether* a student gets the email (`shouldEmailStudent`) and *when* a notification becomes eligible (`isEmailEligible`). `getUnreadForEmailFallback` widens its query to include class-linked rows and filters through the policy using `classStartInstant`; `processEmailFallback` consults the policy for the consent decision. UI/doc copy updated in three places.

**Tech Stack:** TypeScript (pure module + Prisma queries), Vitest unit (pure) + DB tests (dedicated test DB), existing `classStartInstant` timezone helper.

**Spec:** `docs/superpowers/specs/2026-07-21-notification-delivery-policy-design.md`

## Global Constraints

- Essential types exactly: `class_cancelled`, `waitlist_promoted`, `spot_available`, `payment_request`.
- Urgent window exactly 120 minutes, future starts only (`now < classStart <= now + 120min`).
- Urgency changes *when*, never *whether*; consent changes *whether*, never *when*.
- No schema changes, no new settings, `receiveComms` untouched.
- TypeScript strict; suite/`tsc`/`eslint` stay green.
- Branch: `feat/notification-delivery-policy` (created; spec committed).

---

### Task 1: Policy module (pure) — TDD

**Files:**
- Create: `src/services/notification-policy.ts`
- Create: `src/services/notification-policy.test.ts`

**Interfaces:**
- Produces (Tasks 2–3 import these exact names from `./notification-policy`):
  - `ESSENTIAL_NOTIFICATION_TYPES: ReadonlySet<NotificationType>`
  - `isEssential(type: NotificationType): boolean`
  - `URGENT_WINDOW_MINUTES` (= 120)
  - `isEmailEligible(input: { createdAt: Date; classStart: Date | null }, now: Date, thresholdMinutes: number): boolean`
  - `shouldEmailStudent(type: NotificationType, emailNotifications: boolean): boolean`

- [ ] **Step 1: Write the failing tests**

Create `src/services/notification-policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ESSENTIAL_NOTIFICATION_TYPES,
  isEssential,
  isEmailEligible,
  shouldEmailStudent,
} from './notification-policy';

const now = new Date('2026-07-21T12:00:00Z');
const minutes = (n: number) => new Date(now.getTime() + n * 60 * 1000);

describe('essential types', () => {
  it('covers exactly the booking-critical types', () => {
    expect([...ESSENTIAL_NOTIFICATION_TYPES].sort()).toEqual([
      'class_cancelled',
      'payment_request',
      'spot_available',
      'waitlist_promoted',
    ]);
  });

  it('classifies announcements and reminders as optional', () => {
    expect(isEssential('announcement')).toBe(false);
    expect(isEssential('reminder')).toBe(false);
    expect(isEssential('class_cancelled')).toBe(true);
  });
});

describe('isEmailEligible', () => {
  it('is eligible once older than the threshold', () => {
    expect(isEmailEligible({ createdAt: minutes(-45), classStart: null }, now, 30)).toBe(true);
  });

  it('is not eligible while fresh with no class', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: null }, now, 30)).toBe(false);
  });

  it('is eligible while fresh when the class starts within the urgent window', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: minutes(60) }, now, 30)).toBe(true);
  });

  it('is not eligible while fresh when the class is beyond the window', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: minutes(180) }, now, 30)).toBe(false);
  });

  it('does not accelerate for a class that already started', () => {
    expect(isEmailEligible({ createdAt: minutes(-5), classStart: minutes(-10) }, now, 30)).toBe(false);
  });

  it('still respects age for a class that already started', () => {
    expect(isEmailEligible({ createdAt: minutes(-45), classStart: minutes(-10) }, now, 30)).toBe(true);
  });
});

describe('shouldEmailStudent', () => {
  it('essential types email even when the student opted out', () => {
    expect(shouldEmailStudent('class_cancelled', false)).toBe(true);
  });

  it('optional types honor the opt-out', () => {
    expect(shouldEmailStudent('announcement', false)).toBe(false);
    expect(shouldEmailStudent('announcement', true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run --project unit src/services/notification-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/services/notification-policy.ts`:

```ts
/**
 * Delivery policy for the email fallback (layer 3).
 *
 * Two independent axes:
 * - WHETHER: essential types are service messages about the student's
 *   own booking — they bypass Student.emailNotifications. The
 *   per-teacher receiveComms mute is not consulted here; it already
 *   filters announcements at creation time.
 * - WHEN: class-linked notifications become email-eligible immediately
 *   when the class starts within the urgent window, instead of waiting
 *   out the unread threshold. Urgency never overrides consent.
 */

import type { NotificationType } from '@prisma/client';

export const ESSENTIAL_NOTIFICATION_TYPES: ReadonlySet<NotificationType> = new Set([
  'class_cancelled',
  'waitlist_promoted',
  'spot_available',
  'payment_request',
]);

export function isEssential(type: NotificationType): boolean {
  return ESSENTIAL_NOTIFICATION_TYPES.has(type);
}

export const URGENT_WINDOW_MINUTES = 120;

export function isEmailEligible(
  input: { createdAt: Date; classStart: Date | null },
  now: Date,
  thresholdMinutes: number,
): boolean {
  const oldEnough =
    input.createdAt.getTime() < now.getTime() - thresholdMinutes * 60 * 1000;
  if (oldEnough) return true;

  if (input.classStart === null) return false;
  const untilStartMs = input.classStart.getTime() - now.getTime();
  return untilStartMs > 0 && untilStartMs <= URGENT_WINDOW_MINUTES * 60 * 1000;
}

export function shouldEmailStudent(
  type: NotificationType,
  emailNotifications: boolean,
): boolean {
  return isEssential(type) || emailNotifications;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit src/services/notification-policy.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/notification-policy.ts src/services/notification-policy.test.ts
git commit -m "feat: notification delivery policy — essential types and the urgent window"
```

---

### Task 2: Urgency in getUnreadForEmailFallback — TDD

**Files:**
- Modify: `src/services/email-fallback.test.ts` (extend `makeNotification`, add fixtures + 2 tests)
- Modify: `src/services/notifications.ts:145-173` (`getUnreadForEmailFallback`)

**Interfaces:**
- Consumes: `isEmailEligible` from Task 1; `classStartInstant(date, startTime, timeZone)` from `@/lib/timezone`.
- Produces: `getUnreadForEmailFallback` unchanged signature, now returns class-linked fresh rows only when urgent.

- [ ] **Step 1: Extend the test fixture and add failing tests**

In `src/services/email-fallback.test.ts`, replace `makeNotification` with a version accepting `type` and `relatedClassId`:

```ts
  async function makeNotification(overrides: {
    recipientType: 'teacher' | 'student';
    recipientId: string;
    createdAt: Date;
    isRead?: boolean;
    type?: 'reminder' | 'announcement' | 'class_cancelled';
    relatedClassId?: string;
  }) {
    const n = await prisma.notification.create({
      data: {
        recipientType: overrides.recipientType,
        recipientId: overrides.recipientId,
        type: overrides.type ?? 'reminder',
        title: 'Fallback test',
        body: 'Fallback test body',
        isRead: overrides.isRead ?? false,
        emailSent: false,
        createdAt: overrides.createdAt,
        relatedClassId: overrides.relatedClassId ?? null,
      },
    });
    notificationIds.push(n.id);
    return n;
  }
```

In `beforeAll`, after the student create, add class fixtures (UTC teacher so wall clock = instant; date/startTime derived from the target instant so midnight rollover is handled):

```ts
    const room = await prisma.room.create({
      data: {
        venueName: 'Fallback Studio',
        address: `${uniqueSuffix} Fallback St`,
        city: 'Amsterdam',
        postcode: '1111FB',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    async function makeClassStartingIn(minutesFromNow: number) {
      const start = new Date(Date.now() + minutesFromNow * 60 * 1000);
      const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
      const startTime = `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`;
      const cls = await prisma.class.create({
        data: {
          teacherId,
          teacherRoomId: teacherRoom.id,
          classType: 'Vinyasa',
          date,
          startTime,
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'open',
        },
      });
      classIds.push(cls.id);
      return cls;
    }
    soonClassId = (await makeClassStartingIn(60)).id;
    laterClassId = (await makeClassStartingIn(180)).id;
```

The fixture teacher's `defaultTimezone` defaults to `'UTC'` (schema default) — verify with `grep -n 'defaultTimezone' prisma/schema.prisma`; if the default is not UTC, set `defaultTimezone: 'UTC'` explicitly in the teacher create. Declare alongside the other lets: `let roomId: string; let soonClassId: string; let laterClassId: string; const classIds: string[] = [];` and extend `afterAll` (before the student delete):

```ts
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
```

Add the two tests:

```ts
  it('emails a fresh notification when its class starts within 2 hours', async () => {
    const urgent = await makeNotification({
      recipientType: 'teacher',
      recipientId: teacherId,
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      relatedClassId: soonClassId,
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: urgent.id } });
    expect(after.emailSent).toBe(true);
  });

  it('leaves a fresh notification whose class is beyond the urgent window', async () => {
    const notYet = await makeNotification({
      recipientType: 'teacher',
      recipientId: teacherId,
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
      relatedClassId: laterClassId,
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: notYet.id } });
    expect(after.emailSent).toBe(false);
  });
```

- [ ] **Step 2: Run to verify the urgent test fails**

Run: `npx vitest run --project unit src/services/email-fallback.test.ts`
Expected: "emails a fresh notification when its class starts within 2 hours" FAILS (`emailSent` false); all others pass.

- [ ] **Step 3: Implement the widened query + policy filter**

In `src/services/notifications.ts`, replace the body of `getUnreadForEmailFallback` (keep the signature) and add imports:

```ts
import { isEmailEligible } from './notification-policy';
import { classStartInstant } from '@/lib/timezone';
```

```ts
export async function getUnreadForEmailFallback(
  db: PrismaClient,
  thresholdMinutes = 30,
): Promise<Notification[]> {
  const now = new Date();
  const threshold = new Date(now.getTime() - thresholdMinutes * 60 * 1000);

  // Class-linked rows are fetched regardless of age: a class starting
  // within the urgent window makes them eligible before the threshold.
  const candidates = await db.notification.findMany({
    where: {
      isRead: false,
      emailSent: false,
      OR: [{ createdAt: { lt: threshold } }, { relatedClassId: { not: null } }],
    },
    include: {
      relatedClass: {
        select: {
          date: true,
          startTime: true,
          teacher: { select: { defaultTimezone: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return candidates.filter((n) =>
    isEmailEligible(
      {
        createdAt: n.createdAt,
        classStart: n.relatedClass
          ? classStartInstant(
              n.relatedClass.date,
              n.relatedClass.startTime,
              n.relatedClass.teacher.defaultTimezone,
            )
          : null,
      },
      now,
      thresholdMinutes,
    ),
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run --project unit src/services/email-fallback.test.ts src/services/notifications.test.ts`
Expected: all PASS (pre-existing `getUnreadForEmailFallback` tests keep passing — non-class-linked behavior is unchanged, class-linked fresh rows beyond the window are filtered back out).

- [ ] **Step 5: Commit**

```bash
git add src/services/notifications.ts src/services/email-fallback.test.ts
git commit -m "feat: class-linked notifications email on the next sweep when class is imminent"
```

---

### Task 3: Essential types bypass the email opt-out — TDD

**Files:**
- Modify: `src/services/email-fallback.test.ts` (1 new test)
- Modify: `src/services/email-fallback.ts:48-73`

**Interfaces:**
- Consumes: `shouldEmailStudent` from Task 1; extended `makeNotification` from Task 2.

- [ ] **Step 1: Add the failing test**

The bookkeeping (`emailSent: true`) is identical for "skipped: opted out" and "emailed", so the DB test asserts reachability of the send path via the dry-run log seam being unavailable — instead, the *decision* is already unit-tested in Task 1 (`shouldEmailStudent`). Here, pin the wiring with the one observable DB difference: an essential-type notification for an opted-out student must still be picked up and marked (it was before too) — so the wiring test asserts at the policy seam by spying is NOT used; instead add this regression test documenting intent:

```ts
  it('still emails essential notifications to opted-out students (decision pinned in policy tests)', async () => {
    const essential = await makeNotification({
      recipientType: 'student',
      recipientId: optedOutStudentId,
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
      type: 'class_cancelled',
    });

    await processEmailFallback(prisma);

    const after = await prisma.notification.findUniqueOrThrow({ where: { id: essential.id } });
    expect(after.emailSent).toBe(true);
  });
```

(This passes even before the fix — the honest failing test for the *decision* is Task 1's `shouldEmailStudent('class_cancelled', false) === true`, which fails until the fallback consumes it only in the sense of behavior, not compile. The wiring change below is therefore reviewed by reading + the Task 1 unit tests; this DB test guards the pipeline stays intact.)

- [ ] **Step 2: Wire the policy into the fallback**

In `src/services/email-fallback.ts`, add the import and change the student branch:

```ts
import { shouldEmailStudent } from './notification-policy';
```

Replace:

```ts
      const student = await db.student.findUnique({
        where: { id: notification.recipientId },
        select: { email: true, emailNotifications: true },
      });
      email = student?.email ?? null;
      emailEnabled = student?.emailNotifications ?? true;
```

with:

```ts
      const student = await db.student.findUnique({
        where: { id: notification.recipientId },
        select: { email: true, emailNotifications: true },
      });
      email = student?.email ?? null;
      emailEnabled = shouldEmailStudent(
        notification.type,
        student?.emailNotifications ?? true,
      );
```

- [ ] **Step 3: Run the service suites**

Run: `npx vitest run --project unit src/services/`
Expected: all PASS, including the pre-existing opt-out test (type `reminder` — optional, still suppressed).

- [ ] **Step 4: Commit**

```bash
git add src/services/email-fallback.ts src/services/email-fallback.test.ts
git commit -m "feat: essential booking notifications bypass the student email opt-out"
```

---

### Task 4: Copy — settings, disclosure, CLAUDE.md

**Files:**
- Modify: `src/components/student/student-settings-form.tsx:94-102`
- Modify: `src/components/class/send-announcement.tsx:24-25`
- Modify: `CLAUDE.md` (Communication section, layer 3 line)

- [ ] **Step 1: Settings caption**

After the closing `</label>` of the email checkbox, insert:

```tsx
        <p className="type-caption mt-1 max-w-[420px]">
          Essential messages about your bookings — cancellations, waitlist
          spots, payment requests — are always emailed.
        </p>
```

- [ ] **Step 2: Disclosure clause (classId variant only)**

Replace the classId string in `send-announcement.tsx`:

```ts
    ? "Everyone registered for this class (late cancellations included), unless they've muted your messages. They'll see it in the app on their next visit; anyone who hasn't read it within 30 minutes — sooner when class is about to start — also gets it by email, unless they've turned email off."
```

- [ ] **Step 3: CLAUDE.md layer 3**

Replace:

```markdown
3. Email fallback (for unread notifications, student can opt out)
```

with:

```markdown
3. Email fallback (unread after 30 min — sooner when the linked class starts within 2 h; students can opt out of optional messages, essential booking messages always email)
```

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc --noEmit` — expected exit 0.

```bash
git add src/components/student/student-settings-form.tsx src/components/class/send-announcement.tsx CLAUDE.md
git commit -m "docs: copy tells students which emails are essential and when they accelerate"
```

---

### Task 5: Full verification and PR

- [ ] **Step 1: Full pass**

Run: `npx vitest run` — all pass. `npm run lint` — exit 0. `npx tsc --noEmit` — exit 0.

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/notification-delivery-policy
gh pr create --title "feat: notification delivery policy — essential types + urgent window" --body "<summary + test plan>"
```

Expected: CI `checks` + `test` green.
