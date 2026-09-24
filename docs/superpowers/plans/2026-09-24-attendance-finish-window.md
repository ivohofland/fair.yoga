# Attendance Finish Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the teacher a real attendance window. A class auto-completes at
end + 15 minutes instead of at its end. The teacher can finish it with a
confirm step from end − 15 minutes. Attendance stays correctable after
completion, behind "Edit attendance".

**Architecture:** One pure module, `src/lib/finish-window.ts`, owns the end
instant and both edges. `completeClass`'s `CompletionTiming` union states who
is finishing (`sweepAt` / `teacherAt` / `finishedEarly`) and checks the
matching edge under the class row lock it already takes. The class page reads
the same module to decide when to show the finish button and to caption the
auto-finish time.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL,
Vitest (unit / components / integration projects), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-24-attendance-finish-window-design.md`
— read it first. It carries the measured premise and the decisions (D1–D6)
that this plan does not re-argue.

## Global Constraints

- `FINISH_GRACE_MINUTES = 15`. It is the only place the number 15 appears for
  this feature. Every other site imports it or a function built on it.
- No new `ClassStatus`, no migration, no change to
  `src/app/api/registrations/[id]/route.ts`'s write guard.
- No auto-flip of `registered → no_show` anywhere (spec D6).
- A refusal is asserted by its registered code (`expectRefusal(res, 'CODE')`),
  never by a literal message string.
- `@/lib/log` is pino and server-only. `finish-window.ts` imports
  `classStartInstant` from `@/lib/timezone`, which imports the logger, so
  **`finish-window.ts` must never be imported by a `'use client'`
  component**. The page computes values and passes them as props.
- Comments state what is true now. Where a comment in a touched function
  described the old timing, replace it; don't annotate it (CLAUDE.md *Comment
  Discipline*).
- No browser `confirm()` / `alert()`. The finish confirm is inline React
  state.
- Stage exact paths, and quote any path containing `(teacher)`.

## Review Focus

1. **A teacher double-taps Finish on an already-completed class.** Expect 200
   `unchanged`, never `CLASS_NOT_ENDED_YET`, including for a class dated in the
   future (completed earlier by erasure or legacy data). Pinned in Task 2 by the
   status-before-clock ordering test.
2. **A class the start sweep never moved (`open`) reaches its finish window.**
   The teacher can still finish it, and its queue closes. Pinned in Task 2.
3. **A crafted POST on an `open` class weeks ahead.** Expect 409
   `CLASS_NOT_ENDED_YET`, with no `Payment` rows and no notifications written.
   Pinned in Task 2 (service and integration).
4. **A zero-student class reaches Finish.** The confirm copy must not say
   "Payment requests go to 0 students". Pinned in Task 3.
5. **A DST-day class.** The end is absolute (`start + duration` in instants,
   not wall-clock), so a class spanning the spring-forward hour ends 60 real
   minutes after it starts. Pinned in Task 1.

---

### Task 1: `finish-window` module

**Files:**
- Create: `src/lib/finish-window.ts`
- Test: `src/lib/finish-window.test.ts`

**Interfaces:**
- Consumes: `classStartInstant(cls: { date: Date; startTime: Date }, timeZone: string): Date` from `@/lib/timezone`.
- Produces:
  - `FINISH_GRACE_MINUTES: 15`
  - `classEndInstant(entry: { date: Date; startTime: Date; durationMinutes: number }, timeZone: string): Date`
  - `finishOpensAt(end: Date): Date`, which is end − grace
  - `autoFinishAt(end: Date): Date`, which is end + grace
  - `formatClockInZone(instant: Date, timeZone: string): string`, which gives `"HH:MM"` in the zone, or `"HH:MM (UTC)"` if the zone is unreadable

- [ ] **Step 1: Write the failing test** — `src/lib/finish-window.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import {
  FINISH_GRACE_MINUTES,
  classEndInstant,
  finishOpensAt,
  autoFinishAt,
  formatClockInZone,
} from './finish-window';

const MINUTE = 60_000;

describe('finish window', () => {
  it('ends a class durationMinutes after its start, in the teacher timezone', () => {
    // 2026-06-01 is CEST (UTC+2): 18:00 local is 16:00Z.
    const end = classEndInstant(
      { date: new Date('2026-06-01'), startTime: hhmmToTime('18:00'), durationMinutes: 75 },
      'Europe/Amsterdam',
    );
    expect(end.toISOString()).toBe('2026-06-01T17:15:00.000Z');
  });

  /**
   * Review Focus 5. 2026-03-29 springs forward at 02:00 local. A class at
   * 01:30 CET (00:30Z) for 60 minutes ends at 01:30Z: 60 real minutes, even
   * though the wall clock then reads 03:30. Wall-clock arithmetic would say
   * 02:30 local, a moment that does not exist that day.
   */
  it('measures duration in real minutes across a DST change', () => {
    const end = classEndInstant(
      { date: new Date('2026-03-29'), startTime: hhmmToTime('01:30'), durationMinutes: 60 },
      'Europe/Amsterdam',
    );
    expect(end.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('opens the finish window FINISH_GRACE_MINUTES before the end and auto-finishes as long after', () => {
    const end = new Date('2026-06-01T17:15:00Z');
    expect(finishOpensAt(end).getTime()).toBe(end.getTime() - FINISH_GRACE_MINUTES * MINUTE);
    expect(autoFinishAt(end).getTime()).toBe(end.getTime() + FINISH_GRACE_MINUTES * MINUTE);
  });

  it('pins the grace at 15 minutes', () => {
    // The product decision (spec D1/D2). Changing it is a product change,
    // and this line is where that change has to be made on purpose.
    expect(FINISH_GRACE_MINUTES).toBe(15);
  });

  it('formats an instant as a 24h wall-clock time in the zone', () => {
    expect(formatClockInZone(new Date('2026-06-01T17:30:00Z'), 'Europe/Amsterdam')).toBe('19:30');
  });

  it('falls back to UTC, and says so, on an unreadable zone', () => {
    expect(formatClockInZone(new Date('2026-06-01T17:30:00Z'), 'Not/AZone')).toBe('17:30 (UTC)');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm exec vitest run src/lib/finish-window.test.ts`
Expected: FAIL. Cannot resolve `./finish-window`.

- [ ] **Step 3: Implement** — `src/lib/finish-window.ts`

```ts
import { classStartInstant } from '@/lib/timezone';

/**
 * How long before its end a teacher may finish a class, and how long after its
 * end the sweep finishes it for them. One number for both edges: the window is
 * symmetric around the end. See
 * `docs/superpowers/specs/2026-09-24-attendance-finish-window-design.md`.
 */
export const FINISH_GRACE_MINUTES = 15;

const GRACE_MS = FINISH_GRACE_MINUTES * 60_000;

/** The instant a class ends: its start plus its duration, in real minutes. */
export function classEndInstant(
  entry: { date: Date; startTime: Date; durationMinutes: number },
  timeZone: string,
): Date {
  const start = classStartInstant(entry, timeZone);
  return new Date(start.getTime() + entry.durationMinutes * 60_000);
}

/** The earliest instant a teacher may finish the class. */
export function finishOpensAt(end: Date): Date {
  return new Date(end.getTime() - GRACE_MS);
}

/** The instant the sweep finishes the class if the teacher has not. */
export function autoFinishAt(end: Date): Date {
  return new Date(end.getTime() + GRACE_MS);
}

/** `HH:MM` in `timeZone`; an unreadable zone formats in UTC and says so. */
export function formatClockInZone(instant: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: zone,
    }).format(instant);
  try {
    return format(timeZone);
  } catch {
    return `${format('UTC')} (UTC)`;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `pnpm exec vitest run src/lib/finish-window.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation check (prove it bites)**

Change `end.getTime() - GRACE_MS` to `end.getTime() + GRACE_MS` in
`finishOpensAt`, run the test, and record the failing assertion in the task
report. Restore the line and re-run until green. Confirm with
`git status --short` that only the two new files are present.

- [ ] **Step 6: Commit**

```bash
git add src/lib/finish-window.ts src/lib/finish-window.test.ts
git commit -m "feat(class): finish-window module — one end instant, both edges (#234)"
```

---

### Task 2: `completeClass` checks the finish window under the lock

This task changes a union type that three callers name, so every caller
changes in the same commit, or the compiler fails. Do the service first,
then the callers.

**Files:**
- Modify: `src/services/class-lifecycle.ts`: `CompletionTiming` (≈:670-687) and `completeClass`'s timing block (≈:735-779)
- Modify: `src/services/class-transitions.ts`: header item 3 (≈:7), `autoCompleteClasses` (≈:656-760), and the comment at ≈:505-512 that names `requireEndedBy`
- Modify: `src/app/api/classes/[id]/complete/route.ts`: pass `teacherAt`, and fix the `COMPLETE_REFUSAL` docblock and the `finishedEarly` comment
- Modify: `src/app/api/classes/[id]/shared.ts`: `CLASS_NOT_ENDED_YET` copy
- Modify: `src/services/gdpr.ts` ≈:1102 (comment only, if it names the teacher route)
- Modify: `src/app/api/account/route.ts` ≈:51 (docblock, only if it names the teacher route)
- Modify: `src/lib/timezone.ts` ≈:358 and `src/lib/timezone.test.ts` ≈:317 (comments naming `requireEndedBy`)
- Modify: `docs/lock-order.md` ≈:2566-2571 and `docs/technical-architecture.md` (≈:382, ≈:794)
- Test: `src/services/class-lifecycle.test.ts` (the `completeClass` timing block, ≈:1159-1275)
- Test: `src/services/class-transitions.test.ts` (≈:1246)
- Test: `tests/integration/classes-api.test.ts` (the `POST /api/classes/[id]/complete` describe, ≈:377-460)
- Test: `tests/class-fixtures.ts` (a new `wallSlotAt` helper)

**Interfaces:**
- Consumes (Task 1): `classEndInstant`, `finishOpensAt`, `autoFinishAt`, `FINISH_GRACE_MINUTES`.
- Produces:
  ```ts
  export type CompletionTiming =
    | { sweepAt: Date }
    | { teacherAt: Date }
    | { finishedEarly: true };
  ```
  `completeClass`'s result union is unchanged: `NOT_ENDED_YET` is still the
  refusal for both clock variants.
- Produces (test helper): `wallSlotAt(instant: Date, timeZone: string): { date: Date; startTime: Date }` in `tests/class-fixtures.ts`.

**The ordering change, and why.** Today `completeClass` checks the clock
before the status. With `teacherAt`, that answers a double-tap on an
*already completed* class dated in the future with `NOT_ENDED_YET` instead of
`unchanged`. That violates CLAUDE.md's rule that "already done" answers 200,
with the unchanged check placed after any refusal that makes the goal moot, and
a clock refusal does not. The new order under the lock:

1. cancelled
2. status validation, with no writes
3. clock
4. writes

Two existing tests use 2099 fixtures and pass only in this order:

- `route-lock-order.test.ts`'s double-click case. The loser meets a
  `completed` class.
- `classes-api.test.ts`'s "refuses completing a class straight from draft
  with ILLEGAL_TRANSITION". In the old order a future-dated draft would answer
  `NOT_ENDED_YET`.

That is the realistic regression, and Step 8's first mutation breaks it that
way.

- [ ] **Step 1: Write the failing service tests** — in `src/services/class-lifecycle.test.ts`, in the `completeClass` timing block

Replace the three `requireEndedBy` tests ("refuses to complete a class that has
not ended when requireEndedBy is given", "throws rather than completing when
requireEndedBy is not a real date", "completes a class at exactly its end
instant, not one tick later"), and the `requireEndedBy` in "completes a class
rescheduled EARLIER", with the tests below. Keep "still completes early for a
teacher, who passes no requireEndedBy". Rename it "erasure's finishedEarly
checks no clock", and update its comment to say the option exists for
`deleteTeacherAccount`. Add `import { classEndInstant, autoFinishAt, finishOpensAt } from '@/lib/finish-window';`.

```ts
  /** The row's own end, so a counter-derived fixture time never goes stale. */
  async function endOf(cls: { calendarEntryId: string }): Promise<Date> {
    const row = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: cls.calendarEntryId } });
    return classEndInstant(row, 'Europe/Amsterdam');
  }

  /**
   * The sweep's edge. `autoFinishAt` is end + grace; one millisecond before it
   * the class is still inside the teacher's attendance window and must stay
   * `in_progress`. Exactly at it, the class completes, because the sweep's
   * 60-second tick can land on that instant.
   */
  it('keeps a class in progress until autoFinishAt under sweepAt', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    const edge = autoFinishAt(await endOf(cls));

    const early = await completeClass(prisma, cls.id, { sweepAt: new Date(edge.getTime() - 1) });
    expect(early.ok).toBe(false);
    // The REASON: `autoCompleteClasses` branches on it to log at `warn`.
    if (!early.ok) expect(early.reason).toBe('NOT_ENDED_YET');
    expect((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe('in_progress');

    const onTime = await completeClass(prisma, cls.id, { sweepAt: edge });
    expect(onTime.ok).toBe(true);
    expect((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe('completed');
  });

  /** The teacher's edge: finishOpensAt, end − grace. */
  it('lets a teacher finish from finishOpensAt and not a millisecond before', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    const edge = finishOpensAt(await endOf(cls));

    const early = await completeClass(prisma, cls.id, { teacherAt: new Date(edge.getTime() - 1) });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe('NOT_ENDED_YET');

    const onTime = await completeClass(prisma, cls.id, { teacherAt: edge });
    expect(onTime.ok).toBe(true);
  });

  /**
   * Review Focus 3: the pre-start billing hole. An `open` class completed by a
   * teacher outside the window writes nothing — no status flip, no queue
   * close, no Payment, no notification — because the clock is checked before
   * the first write.
   */
  it('refuses a teacher finish on an open class outside the window and writes nothing', async () => {
    const cls = await makeClass({ status: 'open' });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: studentIds[1]!, position: 1, status: 'waiting' },
    });
    // An hour before the window opens: before the class has even started.
    const tooEarly = new Date(finishOpensAt(await endOf(cls)).getTime() - 60 * 60_000);

    const result = await completeClass(prisma, cls.id, { teacherAt: tooEarly });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_ENDED_YET');
    expect((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe('open');
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('waiting');
    expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
    expect(await prisma.notification.count({ where: { relatedClassId: cls.id } })).toBe(0);
  });

  /** Review Focus 2: an `open` class the start sweep never reached, inside the window. */
  it('finishes an open class inside the window and closes its queue', async () => {
    const cls = await makeClass({ status: 'open' });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: studentIds[1]!, position: 1, status: 'waiting' },
    });
    try {
      const result = await completeClass(prisma, cls.id, { teacherAt: finishOpensAt(await endOf(cls)) });
      expect(result.ok).toBe(true);
      expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('expired');
    } finally {
      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
    }
  });

  /**
   * Review Focus 1: status before clock. A class already completed and dated
   * after `teacherAt` answers `ILLEGAL_TRANSITION` from `completed` to
   * `completed` — which the route turns into 200 unchanged — never
   * `NOT_ENDED_YET`, a red error for a goal that already holds.
   */
  it('answers an already-completed class by its status, not by the clock', async () => {
    const cls = await makeClass({ status: 'completed' });
    const before = new Date((await endOf(cls)).getTime() - 24 * 60 * 60_000);

    const result = await completeClass(prisma, cls.id, { teacherAt: before });

    expect(result).toMatchObject({ ok: false, reason: 'ILLEGAL_TRANSITION', from: 'completed', to: 'completed' });
  });

  it.each([
    ['sweepAt', (d: Date) => ({ sweepAt: d })],
    ['teacherAt', (d: Date) => ({ teacherAt: d })],
  ] as const)('throws rather than completing when %s is not a real date', async (_name, timing) => {
    const cls = await makeClass({ status: 'in_progress' });
    await expect(completeClass(prisma, cls.id, timing(new Date('not-a-date')))).rejects.toThrow(TypeError);
    expect((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe('in_progress');
  });
```

In "completes a class rescheduled EARLIER", replace `requireEndedBy:` with
`sweepAt:` and leave the rest as it is. Its instant is a week past the moved
class's `autoFinishAt`.

Check `makeClass({ status: 'completed' })` against the block's `makeClass`
signature. If it rejects `completed` (for example, a DB guard that wants the
completion marker), create it `in_progress` and complete it with
`completeClass(prisma, cls.id, { finishedEarly: true })` first. Say which you
used in the task report.

- [ ] **Step 2: Write the failing sweep test** — `src/services/class-transitions.test.ts`

Rename "auto-completes an in-progress class after its local end time" to
"auto-completes an in-progress class at autoFinishAt, not at its end". Its
existing sweep instant (17:30Z, which is end + 30 minutes) still completes it.
Add this test beside it:

```ts
  it('leaves a class in progress through the grace after its end', async () => {
    const cls = await makeClass({ status: 'in_progress', minStudents: 1 });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 },
    });

    // Ends 17:00Z (16:00Z start + 60 min). 17:05Z is inside the grace.
    const scoped = scopeSweep(prisma, { Class: { id: { in: [cls.id] } } });
    expect(await autoCompleteClasses(scoped.db, new Date('2026-07-20T17:05:00Z'))).toBe(0);
    expect((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).status).toBe('in_progress');
  });
```

Use the same `makeClass` / `studentId` fixtures as the neighbouring test.
Check that its 16:00Z / 60-minute comment holds for this block's fixture. If
it doesn't, derive the instant from `classEndInstant` as Step 1 does.

- [ ] **Step 3: Run and confirm the tests fail**

Run: `pnpm exec vitest run --project integration src/services/class-lifecycle.test.ts src/services/class-transitions.test.ts`
Expected: the compile fails on `sweepAt` / `teacherAt`, or the new tests fail. The file's other tests are unaffected.

(These are DB tests. In a worktree, run `pnpm run worktree:setup` once and
`pnpm run worktree:up` before any `--project integration` run. See the
solve-issue skill's hazard list. If the project name is wrong for these files,
use the project the file already runs under: check `vitest.config` or
`pnpm test`'s output.)

- [ ] **Step 4: Implement the service** — `src/services/class-lifecycle.ts`

Replace `CompletionTiming` and its docblock:

```ts
/**
 * Who is finishing the class, which decides which clock edge applies.
 *
 * REQUIRED, and a union rather than an optional field, because the dangerous
 * mode is the one you get by saying nothing (#182): a caller that forgot to
 * pass a clock must not silently skip it.
 *
 * - `sweepAt`: `autoCompleteClasses`. Refused before `autoFinishAt`.
 * - `teacherAt`: `POST /api/classes/[id]/complete`. Refused before
 *   `finishOpensAt`.
 * - `finishedEarly`: `deleteTeacherAccount` closing in-flight classes during
 *   erasure. No clock.
 *
 * Both edges come from `@/lib/finish-window`.
 */
export type CompletionTiming =
  | { sweepAt: Date }
  | { teacherAt: Date }
  | { finishedEarly: true };
```

In `completeClass`, after the cancellation check, **move the status
validation up** and make it write nothing, then do the clock, then the
writes. The block from the #182 comment through the open/in_progress branch
becomes:

```ts
    // Status before clock: a class that is already `completed` is a goal that
    // holds, and must reach the route as ILLEGAL_TRANSITION(completed →
    // completed) — its "unchanged" answer — not as NOT_ENDED_YET. Validation
    // only; nothing is written until the clock has passed.
    const validation =
      cls.status === 'open'
        ? validateTransition('open', 'in_progress')
        : validateTransition(cls.status, 'completed');
    if (!validation.ok) return validation;

    // The clock, decided from THIS locked row (#182): a caller's snapshot can
    // predate a reschedule, and completion runs the pricing engine and writes
    // `Payment` rows.
    const at = 'sweepAt' in timing ? timing.sweepAt : 'teacherAt' in timing ? timing.teacherAt : null;
    if (at !== null) {
      // Not a truthiness test: an `Invalid Date` is truthy and compares false
      // against everything, so it would slip past the edge below.
      if (Number.isNaN(at.getTime())) {
        throw new TypeError('completeClass: the completion instant is not a valid Date');
      }
      const end = classEndInstant(cls.calendarEntry, cls.calendarEntry.teacher.defaultTimezone);
      const edge = 'sweepAt' in timing ? autoFinishAt(end) : finishOpensAt(end);
      if (at < edge) {
        return { ok: false, reason: 'NOT_ENDED_YET', error: `Class ${classId} is not finishable yet` };
      }
    }

    if (cls.status === 'open') {
      await tx.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
      // #216, third of the three `open -> in_progress` exits. The other two go
      // through `transitionClass` and `autoTransitionToInProgress`; this one
      // does not, so it needs its own call. Inside the lock this function
      // already holds, so it is atomic with the status flip above.
      await closeQueueOnStart(tx, classId);
    }
```

Remove the now-unused `classStartInstant` import if nothing else in the file
uses it (check with `grep -n classStartInstant src/services/class-lifecycle.ts`).
Add `import { classEndInstant, autoFinishAt, finishOpensAt } from '@/lib/finish-window';`.

- [ ] **Step 5: Implement the callers**

`src/services/class-transitions.ts`, `autoCompleteClasses`:

```ts
      const entry = cls.calendarEntry;
      const end = classEndInstant(entry, entry.teacher.defaultTimezone);

      if (currentTime >= autoFinishAt(end)) {
        // `sweepAt` is what makes the decision the locked row's, not this
        // snapshot's: a class rescheduled after the read above is judged
        // against its new end under the lock.
        const result = await completeClass(db, cls.id, { sweepAt: currentTime });
```

Leave the `NOT_ENDED_YET` / `CANCELLED` → `warn` branch as it is. Correct its
comment where it says `requireEndedBy`. Update header item 3 to "Auto-complete:
in_progress → completed once `autoFinishAt` (end + `FINISH_GRACE_MINUTES`) has
passed", and update the `autoCompleteClasses` docblock to match. The comment
near ≈:505-512 that names `requireEndedBy` now names `sweepAt`.

`src/app/api/classes/[id]/complete/route.ts`:

```ts
  // `teacherAt`: the teacher may finish from `finishOpensAt` (end − grace).
  // Earlier is refused under the lock as NOT_ENDED_YET → CLASS_NOT_ENDED_YET.
  const result = await completeClass(prisma, id, { teacherAt: new Date() });
```

Change `COMPLETE_REFUSAL`'s docblock: delete "`NOT_ENDED_YET` cannot reach this
route, which passes `finishedEarly`." and write that `NOT_ENDED_YET` is the
teacher finishing before the window opens.

`src/app/api/classes/[id]/shared.ts`:

```ts
export const CLASS_NOT_ENDED_YET = codedRefusal(
  'CLASS_NOT_ENDED_YET',
  `You can finish this class from ${FINISH_GRACE_MINUTES} minutes before it ends.`,
);
```

Import `FINISH_GRACE_MINUTES` from `@/lib/finish-window`. First check that no
other route imports `CLASS_NOT_ENDED_YET` with the old meaning:
`grep -rn "CLASS_NOT_ENDED_YET" src`. If one does, report it and don't change
its copy silently.

`src/services/gdpr.ts` ≈:1102 and `src/app/api/account/route.ts` ≈:51: update
any wording that describes `finishedEarly` as shared with the teacher route.
The call itself stays as it is.

`src/lib/timezone.ts` ≈:358 and `src/lib/timezone.test.ts` ≈:317 refer to
`completeClass`'s NaN guard on `requireEndedBy`. Make them name the completion
instant (`sweepAt`/`teacherAt`).

- [ ] **Step 6: Integration route tests** — `tests/integration/classes-api.test.ts` and `tests/class-fixtures.ts`

Add to `tests/class-fixtures.ts`:

```ts
/**
 * The `(date, startTime)` pair whose `classStartInstant` in `timeZone` is
 * `instant`, truncated to the minute. For a fixture that has to sit at a
 * given distance from now: a finish-window test cannot use a far-future date.
 */
export function wallSlotAt(instant: Date, timeZone: string): { date: Date; startTime: Date } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`),
    startTime: hhmmToTime(`${parts.hour}:${parts.minute}`),
  };
}
```

(Import `hhmmToTime` from `@/lib/time-of-day` if the file doesn't already.)

In `classes-api.test.ts`, give `isolatedClass` an optional slot override so a
test can place a class near now. The owner teacher is on the schema-default
`Europe/Amsterdam`. Check this in the teacher fixture, and pass whatever zone
it actually uses.

```ts
function isolatedClass(
  classType: string,
  date: string,
  status: ClassStatus,
  cancelled = false,
  slot?: { date: Date; startTime: Date },
) {
  return createClassFixture(prisma, {
    teacherId: ownerId,
    teacherRoomId,
    classType,
    date: slot?.date ?? new Date(date),
    startTime: slot?.startTime ?? hhmmToTime('09:00'),
    durationMinutes: 60,
    // …unchanged
  });
}
```

In "answers a repeat completion unchanged, and bills nobody twice", create the
class inside the teacher's window: it started 50 minutes ago and runs 60, so
`finishOpensAt` was 5 minutes ago and `autoFinishAt` is 25 minutes away. A
locally running scheduler (worktree dev servers run it; CI sets
`CRON_SCHEDULER=off`) can move it to `in_progress` within a minute. The test
tolerates that, because the route completes either status.

```ts
    const cls = await isolatedClass(
      'Complete Twice', '', 'open', false,
      wallSlotAt(new Date(Date.now() - 50 * 60_000), 'Europe/Amsterdam'),
    );
```

Add these tests to the same describe:

```ts
  // Review Focus 3, at the door: a crafted POST on a class weeks ahead.
  it('refuses finishing before the window opens with CLASS_NOT_ENDED_YET, and bills nobody', async () => {
    const cls = await isolatedClass('Complete Too Early', '2099-10-06', 'open');
    try {
      await prisma.registration.create({
        data: { classId: cls.id, studentId: waitStudentId, status: 'registered', tierAtBooking: 3 },
      });

      await expectRefusal(await complete(ownerToken, cls.id), 'CLASS_NOT_ENDED_YET');

      const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(after.status).toBe('open');
      expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);
      expect(await prisma.notification.count({ where: { relatedClassId: cls.id } })).toBe(0);
    } finally {
      await removeIsolatedClass(cls);
    }
  });
```

Check that `2099-10-06` is unused in this file (`grep -n "2099-10-06" tests/integration/classes-api.test.ts`).
If it's taken, pick an unused date.

In `src/app/api/classes/[id]/complete/route.test.ts` (unit, service mocked),
assert that the route passes a `teacherAt` Date:

```ts
  it('asks the service to judge the teacher’s own finish window', async () => {
    completeClass.mockResolvedValueOnce({ ok: true, newStatus: 'completed' });

    await complete();

    const timing = completeClass.mock.calls[0]?.[2] as { teacherAt?: unknown } | undefined;
    expect(timing?.teacherAt).toBeInstanceOf(Date);
  });
```

- [ ] **Step 7: Run and confirm everything passes, including lock-order**

Run: `pnpm run typecheck`, then
`pnpm exec vitest run --project integration src/services/class-lifecycle.test.ts src/services/class-transitions.test.ts "src/app/api/classes/[id]/complete" tests/integration/classes-api.test.ts`,
then `pnpm exec vitest run src/lib/finish-window.test.ts "src/app/api/classes/[id]/complete/route.test.ts"`.
Expected: all PASS, including `route-lock-order.test.ts`'s double-click case.

- [ ] **Step 8: Mutation checks (prove each guard bites)**

Commit first (Step 9), then do each mutation separately against the committed
tree. Record the failing test and its assertion text in the task report,
restore with `git checkout -- <file>`, and check that `git status --short` is
clean after each one. Warm the route with a curl before scoring an integration
mutation.

1. Clock before status: move the new status-validation block below the clock
   block. Expected RED: "answers an already-completed class by its status" and
   `route-lock-order.test.ts`'s double-click case.
2. Sweep edge: in `completeClass`, use `finishOpensAt(end)` for `sweepAt`.
   Expected RED: "keeps a class in progress until autoFinishAt".
3. Teacher edge off by one: change `at < edge` to `at <= edge`. Expected RED:
   both "…exactly at the edge" assertions.
4. Writes before clock: move the `if (cls.status === 'open') { update;
   closeQueueOnStart }` block above the clock. Expected RED: "refuses a teacher
   finish on an open class outside the window and writes nothing"
   (status/queue assertions).
5. Route: pass `{ finishedEarly: true }` again. Expected RED: the route unit
   test and the integration `CLASS_NOT_ENDED_YET` test.
6. Sweep pre-filter: compare against `end` instead of `autoFinishAt(end)` in
   `autoCompleteClasses`. Expected: "leaves a class in progress through the
   grace" stays GREEN, because the locked check still refuses. Record this as
   the proof that the pre-filter is an optimisation and the lock decides. It
   is not a failure.

- [ ] **Step 9: Docs, then commit**

- `docs/lock-order.md` ≈:2566-2571: the passage about `requireEndedBy` being
  compared against the recomputed end now describes `sweepAt`/`teacherAt`
  compared against `autoFinishAt`/`finishOpensAt` of the locked row.
- `docs/technical-architecture.md` ≈:382: "`in_progress → completed`: when
  the teacher finishes the class (from 15 min before its end), or
  automatically 15 min after its end". ≈:794: the same timing for the sweep.
- CLAUDE.md, Class Lifecycle, first bullet list: add one line. "A class
  completes 15 minutes after its end (`FINISH_GRACE_MINUTES`,
  `src/lib/finish-window.ts`), or earlier when the teacher finishes it,
  which they may from 15 minutes before the end. Completion is when prices are
  calculated and payment requests go out."

```bash
git add src/services/class-lifecycle.ts src/services/class-transitions.ts \
  "src/app/api/classes/[id]/complete/route.ts" "src/app/api/classes/[id]/complete/route.test.ts" \
  "src/app/api/classes/[id]/shared.ts" src/services/gdpr.ts src/app/api/account/route.ts \
  src/lib/timezone.ts src/lib/timezone.test.ts \
  src/services/class-lifecycle.test.ts src/services/class-transitions.test.ts \
  tests/integration/classes-api.test.ts tests/class-fixtures.ts \
  docs/lock-order.md docs/technical-architecture.md CLAUDE.md
git commit -m "feat(class): finish window checked under the lock — sweep at end+15, teacher from end−15 (#234)"
```

Stage only the files you actually changed. Drop any path from this list that
turned out to need no edit.

---

### Task 3: Finish confirm, attendance labels and edit mode, page wiring

**Files:**
- Modify: `src/components/class/complete-class-button.tsx`
- Modify: `src/components/class/attendance-list.tsx`
- Modify: `src/app/(teacher)/class/[id]/page.tsx`
- Modify: `tests/e2e/teacher-journey.spec.ts` (≈:30-35 `checkinSlot`, ≈:325-363)
- Modify: `docs/information-architecture.md` (≈:115, ≈:119), `docs/design-brief.md` (≈:118), `docs/teacher-screens.md` (6.1, 7.1)
- Test: `src/components/class/complete-class-button.test.tsx`, `src/components/class/attendance-list.test.tsx`

**Interfaces:**
- Consumes (Task 1): `classEndInstant`, `finishOpensAt`, `autoFinishAt`, `formatClockInZone`. **Server-side only, in `page.tsx`.**
- Produces:
  - `CompleteClassButton({ classId, chargedCount }: { classId: string; chargedCount: number })`
  - `AttendanceList({ items, locked }: { items: AttendanceItem[]; locked?: boolean })`. `locked` defaults to `false` (check-in behaviour).

- [ ] **Step 1: Write the failing component tests**

`complete-class-button.test.tsx`: every existing test now renders
`<CompleteClassButton classId="c-9" chargedCount={2} />`, and needs **two**
clicks (Finish class, then Finish) before `fetch`. Replace
`screen.getByRole('button')` with named queries. Add:

```ts
  it('asks before finishing, and posts nothing until confirmed', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));

    screen.getByText('Finish class? Payment requests go to 2 students now.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the class open when the teacher backs out', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep open' }));

    expect(fetchMock).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Finish class' });
  });

  it('says one student, not one students', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    screen.getByText('Finish class? A payment request goes to 1 student now.');
  });

  // Review Focus 4.
  it('does not promise payment requests when nobody is charged', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    screen.getByText('Finish class? No one is charged for this class.');
  });
```

The existing success test becomes:

```ts
  it('posts the completion once confirmed and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" chargedCount={2} />);

    fireEvent.click(screen.getByRole('button', { name: 'Finish class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/classes/c-9/complete', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });
```

`attendance-list.test.tsx`: add the following. Also update any existing
assertion that expects "No-show" for a `registered` item.

```ts
  const untouched: AttendanceItem = { registrationId: 'reg-1', studentName: 'Grace Hopper', status: 'registered' };

  it('labels an untouched registration "Not marked", never "No-show"', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[untouched]} />);
    screen.getByText('Not marked');
    expect(screen.queryByText('No-show')).toBeNull();
  });

  it('labels a recorded no-show as such', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[{ ...untouched, status: 'no_show' }]} />);
    screen.getByText('No-show');
  });

  it('shows locked rows without controls until "Edit attendance" is chosen', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[untouched]} locked />);

    screen.getByText('Not marked');
    expect(screen.queryByRole('button', { name: 'Mark Grace Hopper as present' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit attendance' }));

    screen.getByRole('button', { name: 'Mark Grace Hopper as present' });
    screen.getByText('Corrections update the record — the payment request already sent stays as it is.');
  });

  it('shows no edit affordance during check-in', () => {
    vi.stubGlobal('fetch', fetchMock);
    render(<AttendanceList items={[untouched]} />);
    expect(screen.queryByRole('button', { name: 'Edit attendance' })).toBeNull();
  });
```

- [ ] **Step 2: Run and confirm the tests fail**

Run: `pnpm exec vitest run src/components/class/complete-class-button.test.tsx src/components/class/attendance-list.test.tsx`
Expected: FAIL on the new tests (no confirm, no "Not marked", no `locked`).

- [ ] **Step 3: Implement `CompleteClassButton`**

Add a `confirming` state. When it's false, render the existing pill button
labelled **Finish class** (and "Finishing…" while submitting). When it's true,
render in its place:

- the confirm text in a `<p className="type-caption text-right">`:
  - `chargedCount === 0`: "Finish class? No one is charged for this class."
  - `chargedCount === 1`: "Finish class? A payment request goes to 1 student now."
  - otherwise: "Finish class? Payment requests go to {n} students now."
- two buttons in a row: **Keep open** (text button, `type-label text-teal`)
  sets `confirming` back to false, and **Finish** (the existing pill style)
  runs the existing `handleComplete`.

Change the fallback error text to "Could not finish the class. Please try
again." and leave the rest of `handleComplete` unchanged. Keep the existing
comment about why a failure must say something.

- [ ] **Step 4: Implement `AttendanceList`**

- Add a `locked?: boolean` prop (default `false`) and an `editing` state
  initialised to `!locked`.
- Label: `attended` → "Present", `late_cancel` → "Late cancel", `no_show` →
  "No-show", `registered` → "Not marked". Replace the stale comment above
  `statusLabel` (the one that refers to `classIsOpen`, "Shown, but not yet
  actionable…") with one line that says an untouched row is not recorded, so
  it must not read as a no-show (spec D5; #234).
- When `!editing`, render each row's label with no toggle button, and under
  the heading render a text button **Edit attendance**
  (`type-label text-teal`) that sets `editing` to true.
- When `editing && locked`, render the caption "Corrections update the record —
  the payment request already sent stays as it is." (`type-caption`) under the
  heading.
- The toggle logic and aria-labels are unchanged. An untouched row's
  aria-label is already "Mark X as present".
- The empty state ("No registered students.") shows no edit button.

- [ ] **Step 5: Wire the page** — `src/app/(teacher)/class/[id]/page.tsx`

Replace the comment block above `showCheckin` (the one naming #234 and "within
60 seconds of its scheduled end") and add the finish-window reads beside it:

```ts
  // Check-in: `in_progress`, or `open` within 15 minutes of the start. A class
  // stays `in_progress` until `autoFinishAt` (end + FINISH_GRACE_MINUTES), so
  // the list stays up through the grace after the end.
  const tz = cls.calendarEntry.teacher.defaultTimezone;
  const classStart = classStartInstant(cls.calendarEntry, tz);
  const minutesToStart = (classStart.getTime() - now) / 60_000;
  const showCheckin = !cancelled
    && (cls.status === 'in_progress' || (cls.status === 'open' && minutesToStart <= 15));

  // The finish button follows the window `completeClass` enforces under its
  // lock; both read `@/lib/finish-window`.
  const classEnd = classEndInstant(cls.calendarEntry, tz);
  const canFinish = !cancelled
    && (cls.status === 'in_progress' || cls.status === 'open')
    && now >= finishOpensAt(classEnd).getTime();
```

- Header `action`: draft gives `PublishClassButton`, `canFinish` gives
  `<CompleteClassButton classId={cls.id} chargedCount={attendanceItems.length} />`,
  and anything else gives `undefined`. `attendanceItems` is every
  non-cancelled registration, which is exactly the charged set. Put that as a
  short comment at the prop.
- Directly under `ClassInfo`, when `canFinish`, add
  `<p className="type-caption py-2">Payment requests go out automatically at {formatClockInZone(autoFinishAt(classEnd), tz)}.</p>`.
- Completed view:
  ```tsx
  {!cancelled && cls.status === 'completed' && (
    <>
      <AttendanceList items={attendanceItems} locked />
      <PricingBreakdown cls={cls} tierPrices={tierPrices} />
      <PaymentChecklist items={paymentItems} />
    </>
  )}
  ```
- Import `classEndInstant`, `finishOpensAt`, `autoFinishAt` and
  `formatClockInZone` from `@/lib/finish-window`.

- [ ] **Step 6: Run the component tests and typecheck**

Run: `pnpm exec vitest run src/components/class/complete-class-button.test.tsx src/components/class/attendance-list.test.tsx && pnpm run typecheck`
Expected: PASS.

- [ ] **Step 7: e2e** — `tests/e2e/teacher-journey.spec.ts`

`checkinSlot` currently starts the class 5 minutes ago, which is outside the
finish window. Put the start `duration − 10` minutes ago, reading the class's
real duration, so check-in and finishing both work. The payments-overview test
reads `slot` for its label, so keep the same return shape.

```ts
/** A class slot whose finish window is open: it ends in ten minutes, in the teacher's UTC clock. */
function checkinSlot(durationMinutes: number): { date: Date; startTime: string } {
  const t = new Date(Date.now() - (durationMinutes - 10) * 60 * 1000);
  const startTime = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const date = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  return { date, startTime };
}
```

In the check-in test, read the entry's `durationMinutes` first (extend the
`findUniqueOrThrow` select to `{ calendarEntryId: true, calendarEntry: { select: { durationMinutes: true } } }`)
and pass it in. Correct the test's own comment ("Move the class to 'now'…") to
say where the slot now sits. Update the `slot` variable's type annotation if
the signature change requires it.

In "completing runs pricing…":

```ts
    await page.getByRole('button', { name: 'Finish class' }).click();
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(page.getByText('Completed', { exact: true })).toBeVisible({ timeout: 10_000 });
```

Then, after the existing Pricing/Payments assertions, add:

```ts
    // Attendance survives completion, read-only until the teacher asks to correct it.
    await expect(page.getByRole('heading', { name: 'Attendance' })).toBeVisible();
    await page.getByRole('button', { name: 'Edit attendance' }).click();
    await expect(page.getByRole('button', { name: 'Mark Journey s. as no-show' })).toBeVisible();
```

Run: `pnpm exec playwright test tests/e2e/teacher-journey.spec.ts` (against the
worktree app, after `pnpm run worktree:up`).
Expected: PASS. If `getByText('Completed', { exact: true })` matches more
than one element, scope it to the status badge the way neighbouring
assertions scope theirs, and say so in the report.

- [ ] **Step 8: Mutation checks**

Commit first, then run each mutation against the committed tree. Record the
RED test, restore, and check `git status --short` is clean after each one.

1. Label conflation: make `registered` render "No-show" again. Expected RED:
   "labels an untouched registration 'Not marked'".
2. Confirm bypass: have the first click call `handleComplete` directly.
   Expected RED: "asks before finishing…" and "keeps the class open…".
3. Locked ignored: initialise `editing` to `true` regardless of `locked`.
   Expected RED: "shows locked rows without controls…".
4. Zero-count copy: drop the `chargedCount === 0` branch. Expected RED:
   "does not promise payment requests when nobody is charged".

- [ ] **Step 9: Docs, then commit**

- `docs/information-architecture.md` ≈:115: the Completed row lists
  "Attendance (read-only; Edit attendance to correct), pricing breakdown,
  payment checklist". ≈:119: the transition to completed happens when the
  teacher finishes (from 15 min before the end) or automatically 15 min after
  the end.
- `docs/design-brief.md` ≈:118: the completed view's contents, as above.
- `docs/teacher-screens.md` 6.1 (Class Day View): the finish button appears
  15 min before the end, with a confirm step and the auto-finish caption.
  7.1: attendance correction on a completed class.

```bash
git add src/components/class/complete-class-button.tsx src/components/class/complete-class-button.test.tsx \
  src/components/class/attendance-list.tsx src/components/class/attendance-list.test.tsx \
  "src/app/(teacher)/class/[id]/page.tsx" tests/e2e/teacher-journey.spec.ts \
  docs/information-architecture.md docs/design-brief.md docs/teacher-screens.md
git commit -m "feat(class): finish confirm, Not marked label, attendance editable after completion (#234)"
```

---

## After the tasks

- Whole-branch review (3 tasks): the cross-task risk is that the page's
  `canFinish` and `completeClass`'s `teacherAt` edge disagree. Both must come
  from `finishOpensAt`. Also check the name sweep:
  `grep -rn "requireEndedBy" src tests docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v docs/superpowers`
  must return nothing. Every hit outside `docs/superpowers` is a stale
  reference to the removed variant.
- `pnpm run verify` before pushing. The PR body names the integration files
  touched: `tests/integration/classes-api.test.ts` and the DB-backed
  `src/services/class-lifecycle.test.ts` / `class-transitions.test.ts`.
- #234's acceptance list: attendance editable on `completed` through the UI
  (Task 3), label disambiguated (Task 3), no auto-flip (nothing adds one), and
  the window question answered and recorded (the spec, D4).
