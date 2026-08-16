# Waitlist Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily sweep that deletes `WaitlistEntry` rows which never became a
booking, on classes that can never change again, once those classes are more
than 365 days old.

**Architecture:** One new framework-agnostic service,
`src/services/waitlist-retention.ts`, registered as a second sweep in the
existing 24-hour scheduler job. It processes **one class per transaction** —
`db.$transaction` + `lockClassRow` — which is what makes it structurally unable
to deadlock against `deleteStudentAccount`'s unscoped `waitlistEntry.deleteMany`.
The reap predicate is built from two derived constants rather than hand-written
status lists, and the terminal-class set is pinned against the Postgres trigger
that actually enforces it.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma + PostgreSQL,
Vitest (three projects: `unit`, `components`, `integration`), pino.

**Spec:** `docs/superpowers/specs/2026-08-16-waitlist-retention-design.md` —
read §2.1 (the predicate), §2.3 (why one class per transaction) and §3 (the
mutation table) before Task 2.

**Issue:** #238.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `noUncheckedIndexedAccess`
  is on: indexing an array yields `T | undefined`.
- **Test-first.** Write the failing test, run it, see it fail *for the stated
  reason*, then implement. A test that passes before the implementation exists
  is not a test.
- **Every guard gets a mutation.** Break it, record the **exact error text** in
  the task's commit message or the PR body, restore, re-verify. A guard that
  compiles but cannot fail certifies nothing.
- **Commit per task.** The PR is rebase-merged, never squashed — the
  commit-per-task history is the record.
- **Stage exact paths.** Never `git add -A` or `git add .`.
- **Never start or restart the dev server on :3000.** The user runs it; the
  `integration` project talks to it over HTTP.
- **Never edit an applied migration.** This branch adds none (§2.5 of the spec).
- **`@/lib/log` is pino and server-only.** Safe in every file this branch
  touches (all server-side), but check the transitive chain before adding an
  import to anything a `'use client'` component value-imports.
- **Retention period:** `WAITLIST_RETENTION_DAYS = 365`. **Cap:**
  `MAX_CLASSES_PER_RUN = 500`. Both exported constants, both with the rationale
  in their docblock.
- **Test database only.** Seeding and mutation work goes to `DATABASE_URL_TEST`,
  never dev. The `unit` project is forced onto it by `tests/setup/unit-db.ts`.

## Measured baseline (2026-08-16, at `abca62a`)

Run and recorded, not inherited:

```
npm test
  Test Files  120 passed (120)
       Tests  1393 passed (1393)
    Duration  213.78s
```

Per project, and the arithmetic reconciles:

| project | files |
|---|---|
| `unit` | 54 |
| `components` | 38 |
| `integration` | 28 |
| **total** | **120** ✓ |

**Predicted after: 122 files** (two new: the retention service test, plus no new
test file for the extended suites) — in fact **121**, since only
`waitlist-retention.test.ts` is new and Tasks 1/5 extend existing files.
**Measure it anyway.** #212's handover predicted 1294 tests and the real figure
was 1296, because that branch's own review added tests the prediction could not
have known about.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/services/waitlist-retention.ts` | The sweep: cutoff arithmetic, candidate read, per-class locked delete, summary. |
| **Create** `src/services/waitlist-retention.test.ts` | T1–T10. Unit project (DB-invariant, no HTTP surface). |
| **Modify** `src/services/class-lifecycle.ts` | Export `TERMINAL_CLASS_STATUSES`, derived from `VALID_TRANSITIONS`. |
| **Modify** `src/lib/waitlist-status.ts` | Export `FULFILLED_WAITLIST_STATUSES`, derived from `QUEUE_ROLE`. |
| **Modify** `src/services/class-terminal-status.test.ts` | T11 — the derived set is pinned to the trigger. |
| **Modify** `src/lib/scheduler.ts` | Rename `auth-cleanup` → `daily-cleanup`; add the second sweep. |
| **Modify** `src/lib/scheduler.test.ts` | T12, T13. |
| **Move** `src/app/api/cron/auth-cleanup/` → `src/app/api/cron/daily-cleanup/` | Route runs both sweeps. |
| **Modify** `src/services/gdpr.ts`, `src/services/waitlist-reconciliation.ts` | Correct the two comments this branch falsifies. |
| **Modify** `docs/lock-order.md`, `docs/data-model.md`, `CLAUDE.md`, `DEPLOYMENT.md` | Live reference docs (spec §4). |

**Task order is load-bearing in two places.** Task 1 must precede Task 2 (the
service imports `TERMINAL_CLASS_STATUSES`). Task 3 must precede Task 6, because
its measurement decides whether the "no index" claim the docs will carry is
true. Everything else is order-independent.

---

### Task 1: The two derived status sets, and the pin that stops one drifting

**Files:**
- Modify: `src/services/class-lifecycle.ts` (after `VALID_TRANSITIONS`, ~line 40)
- Modify: `src/lib/waitlist-status.ts` (at the end, after `CLAIMABLE_WAITLIST_STATUSES`)
- Test: `src/services/class-terminal-status.test.ts` (add one `it.each`)

**Interfaces:**
- Produces: `TERMINAL_CLASS_STATUSES: readonly ClassStatus[]` from
  `@/services/class-lifecycle`; `FULFILLED_WAITLIST_STATUSES: readonly WaitlistStatus[]`
  from `@/lib/waitlist-status`. Task 2 consumes both.

- [ ] **Step 1: Write the failing test**

Append to the `describe('class terminal status trigger', …)` block in
`src/services/class-terminal-status.test.ts`. Add
`import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';` to the imports.

```ts
  /**
   * The pin between the reaper's safety predicate and the thing that actually
   * enforces it (#238).
   *
   * `waitlist-retention.ts` deletes rows on a class whose status is in
   * `TERMINAL_CLASS_STATUSES`, and its whole safety argument is "no writer can
   * ever touch those rows again". That argument rests on this trigger, whose
   * SQL hard-codes `('completed','cancelled')` and cannot be edited — it is an
   * applied migration. The constant, meanwhile, is DERIVED from
   * `VALID_TRANSITIONS`. Widen that table and the constant widens silently
   * while the trigger does not, and the reaper would then delete rows on a
   * class whose immutability nothing enforces.
   *
   * So this iterates the derived set rather than restating it. The two tests
   * above stay as they are: they assert the trigger's error SHAPE end to end
   * (the Prisma error class, `classifyApiError`'s 409). This one asserts only
   * membership, which is the property that can drift.
   */
  it.each(TERMINAL_CLASS_STATUSES)(
    'has a DB-enforced terminal %s, so the reaper may treat it as unwritable',
    async (status) => {
      const { classId } = await makeClass({ status });

      let caught: unknown;
      try {
        await prisma.class.update({ where: { id: classId }, data: { status: 'open' } });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
      expect(String(caught)).toMatch(/23514/);
      expect(String(caught)).toMatch(/which is terminal/);

      const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
      expect(after.status).toBe(status);
    },
  );
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/services/class-terminal-status.test.ts`

Expected: FAIL at import — `TERMINAL_CLASS_STATUSES` is not exported from
`./class-lifecycle`. The exact message will name the missing export.

- [ ] **Step 3: Add the derived constant to `class-lifecycle.ts`**

Insert directly after the `VALID_TRANSITIONS` object (which ends at line 40):

```ts
/**
 * The statuses a class can never leave, derived rather than listed.
 *
 * Terminal means "no outgoing transition", which is exactly `[]` in the table
 * above — so this cannot disagree with `VALID_TRANSITIONS` the way a
 * hand-written pair would. `waitlist-retention.ts` (#238) is the consumer, and
 * its entire safety argument is that a row on such a class has no possible
 * writer.
 *
 * That argument rests on the DB trigger `class_terminal_status_guard`
 * (`prisma/migrations/20260805120000_class_terminal_status_trigger/`), whose
 * SQL hard-codes `('completed','cancelled')` and cannot be edited. Deriving
 * from a TABLE while depending on a TRIGGER is the one hazard here: widen the
 * table and this widens silently while the trigger does not.
 * `class-terminal-status.test.ts` iterates this constant for exactly that
 * reason — adding a terminal status the trigger does not cover fails there,
 * not in production.
 *
 * Annotated and frozen, NOT `as const satisfies` — the same shape and reason as
 * `CLAIMABLE_WAITLIST_STATUSES` (`lib/waitlist-status.ts`, which explains it at
 * length): `as const` narrows `Array.prototype.includes`' parameter to the
 * literal members, forcing call sites to widen it back with a cast that
 * accepts any string.
 */
export const TERMINAL_CLASS_STATUSES: readonly ClassStatus[] = Object.freeze(
  (Object.keys(VALID_TRANSITIONS) as ClassStatus[]).filter(
    (status) => VALID_TRANSITIONS[status].length === 0,
  ),
);
```

- [ ] **Step 4: Add the sibling constant to `lib/waitlist-status.ts`**

Append after `CLAIMABLE_WAITLIST_STATUSES`:

```ts
/**
 * The statuses that mean the student got a seat.
 *
 * `fulfilled` from the role table above, so it cannot drift from it — the same
 * derivation as `CLAIMABLE_WAITLIST_STATUSES`.
 *
 * Used by `waitlist-retention.ts` (#238) as the SECOND of two independent
 * discriminators for "this entry never became a booking". The first, and the
 * primary one, is `registrationId IS NULL`: a foreign key to a `Registration`
 * — and through it to a `Payment` — is what actually makes a row bookkeeping,
 * where a status is only a label. No writer can produce a row where the two
 * disagree; all three fulfilment sites write `registrationId` in the same
 * statement as the status (`waitlist.ts`'s `promoteNext` and `claimSpot`, and
 * the walk-in resolver in `POST /api/registrations`).
 *
 * It is there anyway because deleting is irreversible, and two independently
 * derived discriminators intersected are conservative: if they ever disagree,
 * the row survives.
 */
export const FULFILLED_WAITLIST_STATUSES: readonly WaitlistStatus[] = Object.freeze(
  (Object.keys(QUEUE_ROLE) as WaitlistStatus[]).filter(
    (status) => QUEUE_ROLE[status] === 'fulfilled',
  ),
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run --project unit src/services/class-terminal-status.test.ts`
Expected: PASS, with two new cases (`completed`, `cancelled`).

- [ ] **Step 6: Prove the pin bites — mutate `VALID_TRANSITIONS`**

Temporarily change line 37 of `src/services/class-lifecycle.ts`:

```ts
  in_progress: [],          // was: ['completed']
```

Run: `npx vitest run --project unit src/services/class-terminal-status.test.ts`

Expected: the new `it.each` gains an `in_progress` case and **that case fails** —
`caught` stays `undefined` because the trigger permits `in_progress -> open`, so
`expect(caught).toBeInstanceOf(...)` fails with `expected undefined to be an
instance of PrismaClientUnknownRequestError`.

**Record the exact message in the commit body.** Note that
`class-lifecycle.test.ts` will also go red under this mutation — that is
expected and is not the proof; the proof is the specific case above.

Restore line 37 to `in_progress: ['completed']` and re-run both files to confirm
green.

- [ ] **Step 7: Commit**

```bash
git add src/services/class-lifecycle.ts src/lib/waitlist-status.ts src/services/class-terminal-status.test.ts
git commit -m "feat: derive the terminal-class and fulfilled-waitlist status sets

Both derived from the tables that already define them rather than listed
beside them, so neither can drift. TERMINAL_CLASS_STATUSES is pinned to the
trigger that actually enforces terminality: mutating in_progress to [] widens
the derived set and the new it.each fails on that case, because the trigger
permits in_progress -> open.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The reap predicate

**Files:**
- Create: `src/services/waitlist-retention.ts`
- Test: `src/services/waitlist-retention.test.ts`

**Interfaces:**
- Consumes: `TERMINAL_CLASS_STATUSES` (Task 1), `FULFILLED_WAITLIST_STATUSES`
  (Task 1), `lockClassRow(tx: TransactionClientOnly, classId: string)` from
  `@/lib/db-locks`.
- Produces:
  ```ts
  export const WAITLIST_RETENTION_DAYS: 365;
  export const MAX_CLASSES_PER_RUN: 500;
  export interface ReapSummary { deleted: number; classes: number; failed: number; cappedOut: boolean }
  export function retentionCutoff(now: Date): Date;
  export function reapClosedWaitlistEntries(
    db: PrismaClient,
    opts?: { now?: Date; maxClasses?: number },
  ): Promise<ReapSummary>;
  ```
  Task 4 extends the behaviour behind `failed` and `cappedOut`; Task 5 wires
  `reapClosedWaitlistEntries` into the scheduler.

- [ ] **Step 1: Write the failing test**

Create `src/services/waitlist-retention.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ClassStatus, WaitlistStatus } from '@prisma/client';
import {
  reapClosedWaitlistEntries,
  retentionCutoff,
  WAITLIST_RETENTION_DAYS,
} from './waitlist-retention';

/**
 * A pure DB-invariant suite — nothing here calls the app on `:3000` — so it
 * lives in the `unit` project, where `tests/setup/unit-db.ts` forces it onto
 * `DATABASE_URL_TEST`. The same reasoning `class-terminal-status.test.ts`'s
 * header sets out: an `integration` file would run against the DEV database by
 * design (`docs/test-database.md` §3.4), and this file DELETES rows.
 */
const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/** Fixed "today" so every date below is computed, not guessed. */
const NOW = new Date('2026-08-16T12:00:00.000Z');
const CUTOFF = retentionCutoff(NOW);

/** A UTC-midnight date `days` before the cutoff. Negative = after it. */
function daysBeforeCutoff(days: number): Date {
  const d = new Date(CUTOFF);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
let studentId: string;
const classIds: string[] = [];

/**
 * Distinct `startTime` per class. `Class_teacher_slot_unique` compares
 * (teacherId, date, startTime) as strings, and several classes here share a
 * date. Routed through a wrapping helper rather than a raw `09:${counter}`
 * literal, which would emit `09:60` once the counter crosses 60 — the same
 * trap `class-terminal-status.test.ts`'s `slotTime` documents.
 */
let slotCounter = 0;
function slotTime(): string {
  slotCounter += 1;
  const hour = 9 + Math.floor(slotCounter / 60);
  const minute = slotCounter % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

/**
 * One class in a given status on a given date, with one waitlist entry on it.
 *
 * One entry per class, never two: `@@unique([classId, studentId])` allows only
 * one entry per student per class, and every case here uses the same student.
 * Distinct classes is also what makes the sweep's per-class loop observable.
 */
async function makeClassWithEntry(opts: {
  classStatus: ClassStatus;
  date: Date;
  entryStatus: WaitlistStatus;
  withRegistration?: boolean;
  id?: string;
}): Promise<{ classId: string; entryId: string }> {
  const cls = await prisma.class.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      teacherId,
      teacherRoomId,
      classType: 'Retention Test',
      date: opts.date,
      startTime: slotTime(),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 8,
      status: opts.classStatus,
    },
  });
  classIds.push(cls.id);

  let registrationId: string | null = null;
  if (opts.withRegistration) {
    const reg = await prisma.registration.create({
      data: { classId: cls.id, studentId, tierAtBooking: 3 },
    });
    registrationId = reg.id;
  }

  const entry = await prisma.waitlistEntry.create({
    data: {
      classId: cls.id,
      studentId,
      position: 1,
      status: opts.entryStatus,
      ...(registrationId ? { registrationId } : {}),
    },
  });
  return { classId: cls.id, entryId: entry.id };
}

async function entryExists(entryId: string): Promise<boolean> {
  return (await prisma.waitlistEntry.count({ where: { id: entryId } })) === 1;
}

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Retention',
      lastName: 'Sweep',
      email: `retention-${uniqueSuffix}@test.local`,
      account: { create: { email: `retention-${uniqueSuffix}@test.local` } },
      bio: 'Waitlist retention tests',
      pageSlug: `retention-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Retention Studio',
      address: `${uniqueSuffix} Sweep St`,
      city: 'Amsterdam',
      postcode: '1234RA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacherId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  teacherRoomId = teacherRoom.id;

  const student = await prisma.student.create({
    data: {
      firstName: 'Retention',
      lastName: 'Student',
      email: `retention-student-${uniqueSuffix}@test.local`,
      incomeTier: 3,
    },
  });
  studentId = student.id;
});

afterAll(async () => {
  // Ordered children-first. #177 is about test databases accumulating rows
  // nothing prunes; a retention suite that leaks its own fixtures would be a
  // poor joke.
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.payment.deleteMany({ where: { registration: { classId: { in: classIds } } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('retentionCutoff', () => {
  it('is the UTC midnight of today minus the retention window, whatever hour it is called at', () => {
    // Both times of day must land on the same date, or the sweep's behaviour
    // depends on the hour the scheduler happens to tick — the exact shape of
    // trap `prisma/seed.ts` carries a standing warning about.
    const morning = retentionCutoff(new Date('2026-08-16T00:30:00.000Z'));
    const evening = retentionCutoff(new Date('2026-08-16T23:30:00.000Z'));

    expect(morning.toISOString()).toBe('2025-08-16T00:00:00.000Z');
    expect(evening.toISOString()).toBe(morning.toISOString());
    expect(WAITLIST_RETENTION_DAYS).toBe(365);
  });
});

describe('reapClosedWaitlistEntries', () => {
  it('deletes an unfulfilled entry on a terminal class past the window', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const summary = await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(summary.deleted).toBeGreaterThanOrEqual(1);
    expect(await entryExists(entryId)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/services/waitlist-retention.test.ts`
Expected: FAIL — `Failed to resolve import "./waitlist-retention"`.

- [ ] **Step 3: Write the service**

Create `src/services/waitlist-retention.ts`:

```ts
/**
 * Waitlist retention (#238) — deletes queue entries that never became a
 * booking, on classes that can never change again, once those classes are
 * older than the window.
 *
 * WHY THIS EXISTS. Nothing else removes a `WaitlistEntry`. The only other
 * production remover is `deleteStudentAccount` (`gdpr.ts`), which runs once per
 * account at that account's request; `onDelete: Cascade` from `Class` fires
 * only from two deleters, both scoped to FUTURE instances
 * (`template-sync.ts`'s wrong-day cleanup and `archiveOrUnarchiveTemplate`'s
 * `date > today`), so neither can reach a terminal class. `Student`'s cascade
 * never fires at all, because erasure anonymises rather than deletes. So
 * without this sweep the population grows for the life of each account.
 *
 * That growth is what made the erasure's `Class` lock set unbounded — see the
 * budget rationale in `deleteStudentAccount` — and it is a storage-limitation
 * problem in its own right (GDPR Art. 5(1)(e)): an entry for a class that ran
 * two years ago, which never became a booking, has no remaining purpose, and
 * the Article 15 export publishes every one of them verbatim.
 *
 * WHY IT IS SAFE. Two independent arguments, and both are enforced rather than
 * asserted:
 *
 *  - `TERMINAL_CLASS_STATUSES` is derived from `VALID_TRANSITIONS`, and the DB
 *    trigger `class_terminal_status_guard` makes a terminal class's status
 *    physically unchangeable from any client, raw SQL included.
 *    `class-terminal-status.test.ts` pins the derived set against that trigger.
 *  - Eleven of the fourteen `WaitlistEntry` write sites require the class to be
 *    `open` (or `open`/`in_progress` for the walk-in resolver), or run inside
 *    the CAS that makes the class terminal. The three that do not —
 *    `removeFromWaitlist`, `withdrawWaitingEntriesForTeacher` and
 *    `reorderWaitingEntries` — are all scoped to `status: 'waiting'`, which on
 *    a terminal class exists only as pre-#216 legacy. Reaping is what removes
 *    that legacy population.
 *    To re-derive the roster:
 *    `grep -rnE 'waitlistEntry\.(create|update|delete|upsert)' src`, excluding
 *    tests.
 *
 * ONE CLASS PER TRANSACTION, and that is structural rather than stylistic.
 * `deleteStudentAccount` deletes waitlist entries with an UNSCOPED
 * `deleteMany({ where: { studentId } })` — every status, terminal classes
 * included — so its write set and this one overlap. Two multi-row deletes
 * taking row locks in different plan orders is an AB-BA cycle, and Postgres
 * picks the victim: it can be the erasure, which means a student's Art. 17
 * request failing because a background sweep raced it. `docs/lock-order.md`
 * classifies lock sites by MULTIPLICITY — a transaction that can hold two
 * `Class` row locks carries an ordering obligation, one that holds a single row
 * lock carries none. Holding one at a time removes the cycle instead of
 * ordering around it, and it keeps that document's "five sites lock more than
 * one `Class` row" count true. The shape is `autoCancelClasses`'
 * (`class-transitions.ts`), whose own docblock argues it on the axis that
 * matters here: a slow lock wait on one class costs only that class's
 * transaction.
 */

import type { PrismaClient } from '@prisma/client';
import { TERMINAL_CLASS_STATUSES } from './class-lifecycle';
import { FULFILLED_WAITLIST_STATUSES } from '@/lib/waitlist-status';
import { lockClassRow } from '@/lib/db-locks';
import { log } from '@/lib/log';

/**
 * How long a closed, unfulfilled entry is kept after its class ran.
 *
 * 365 days, decided rather than defaulted (#238 parked it as a product/legal
 * call). A full annual cycle of a teacher's schedule is straightforwardly
 * defensible under Art. 5(1)(e), and the asymmetry decided the number: a period
 * can be tightened later by editing this line, while data deleted early cannot
 * be recovered.
 *
 * In code, not in an environment variable, because it is a policy someone
 * should be able to review in a diff.
 */
export const WAITLIST_RETENTION_DAYS = 365;

/**
 * How many classes one run will process.
 *
 * At steady state the daily volume is "classes that turned 366 days old today",
 * a handful, so this is unreachable in normal operation. It exists so a first
 * run against accumulated history cannot wedge the daily job: `scheduler.ts`'s
 * `running` guard drops every tick while one is in flight, so an unbounded loop
 * here would stop the job for ever rather than merely take a while. A backlog
 * drains at this rate per day.
 */
export const MAX_CLASSES_PER_RUN = 500;

export interface ReapSummary {
  /** Entries actually deleted. */
  deleted: number;
  /** Classes this run attempted, after the cap. */
  classes: number;
  /** Classes whose own transaction threw and were skipped. */
  failed: number;
  /** True when more classes were eligible than the cap allowed. */
  cappedOut: boolean;
}

/**
 * The UTC midnight of `now` minus the retention window.
 *
 * UTC midnight on BOTH sides, deliberately. `Class.date` is `@db.Date` — a
 * calendar day pinned to midnight UTC — so comparing it against a bare
 * `now - 365 days` would carry the caller's time of day into the comparison and
 * make the boundary depend on the hour the scheduler happened to tick.
 * `prisma/seed.ts` carries a standing warning about exactly that window: a
 * check run at the wrong UTC hour passes for the wrong reason.
 *
 * The comparison is `date < cutoff`, so a class dated exactly
 * `WAITLIST_RETENTION_DAYS` ago is RETAINED and one dated a day earlier is
 * reaped — the entry is reaped on day 366. Both sides of that boundary have a
 * test.
 */
export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  cutoff.setUTCDate(cutoff.getUTCDate() - WAITLIST_RETENTION_DAYS);
  return cutoff;
}

export async function reapClosedWaitlistEntries(
  db: PrismaClient,
  opts: { now?: Date; maxClasses?: number } = {},
): Promise<ReapSummary> {
  const now = opts.now ?? new Date();
  const maxClasses = opts.maxClasses ?? MAX_CLASSES_PER_RUN;
  const cutoff = retentionCutoff(now);

  const reapable = {
    registrationId: null,
    status: { notIn: [...FULFILLED_WAITLIST_STATUSES] },
    class: {
      status: { in: [...TERMINAL_CLASS_STATUSES] },
      date: { lt: cutoff },
    },
  } as const;

  // `groupBy`, not `findMany({ distinct })`, for the reason
  // `waitlist-reconciliation.ts` records at its own opening statement: Prisma
  // does not compile `distinct` into SQL. It would select one row per matching
  // ENTRY and dedupe in the query engine to produce one id per CLASS.
  //
  // `maxClasses + 1` rather than `maxClasses`, so `cappedOut` is exact rather
  // than "possibly": at exactly the cap a plain `take` cannot tell a full run
  // from a truncated one.
  const candidates = await db.waitlistEntry.groupBy({
    by: ['classId'],
    where: reapable,
    orderBy: { classId: 'asc' },
    take: maxClasses + 1,
  });

  const cappedOut = candidates.length > maxClasses;
  const batch = candidates.slice(0, maxClasses);

  let deleted = 0;
  const summary: ReapSummary = {
    deleted: 0,
    classes: batch.length,
    failed: 0,
    cappedOut,
  };

  for (const { classId } of batch) {
    // One transaction per class — see this module's header for why that is
    // the whole deadlock argument and not a style choice.
    const count = await db.$transaction(async (tx) => {
      await lockClassRow(tx, classId);
      // The predicate is re-applied under the lock rather than trusting the
      // candidate read: that read took no lock, and a delete scoped only by
      // `classId` would widen the write set past what was actually selected.
      const result = await tx.waitlistEntry.deleteMany({
        where: { classId, ...reapable },
      });
      return result.count;
    });
    deleted += count;
  }

  summary.deleted = deleted;
  log.info(summary, 'waitlist retention swept');
  return summary;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit src/services/waitlist-retention.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the rest of the predicate tests**

Append inside `describe('reapClosedWaitlistEntries', …)`:

```ts
  it('keeps an entry that became a registration, however old the class', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(400),
      entryStatus: 'claimed',
      withRegistration: true,
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(true);
  });

  /**
   * The belt-and-braces clause, and the reason it is testable at all.
   *
   * No production writer can make this row: all three fulfilment sites write
   * `registrationId` in the same statement as the status. A fixture can, and
   * that is enough — the clause exists because deleting is irreversible and the
   * two discriminators are derived independently, so their intersection is the
   * conservative one. Drop `status: { notIn: FULFILLED }` from the predicate
   * and this test goes red, which is the whole point: a guard that cannot fail
   * certifies nothing.
   */
  it('keeps a promoted entry whose registrationId is somehow null', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(400),
      entryStatus: 'promoted',
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(true);
  });

  it.each<ClassStatus>(['draft', 'open', 'in_progress'])(
    'keeps an entry on a %s class, which is not terminal',
    async (classStatus) => {
      const { entryId } = await makeClassWithEntry({
        classStatus,
        date: daysBeforeCutoff(400),
        entryStatus: 'waiting',
      });

      await reapClosedWaitlistEntries(prisma, { now: NOW });

      expect(await entryExists(entryId)).toBe(true);
    },
  );

  /**
   * All three unfulfilled statuses, not just the common one. `waiting` on a
   * terminal class is the pre-#216 legacy population this sweep exists to
   * finish off; `expired` is what `closeQueueOnStart` writes when a class
   * starts; `removed` is what the three cancel paths write.
   */
  it.each<WaitlistStatus>(['waiting', 'expired', 'removed'])(
    'deletes a %s entry on a terminal class past the window',
    async (entryStatus) => {
      const { entryId } = await makeClassWithEntry({
        classStatus: 'cancelled',
        date: daysBeforeCutoff(1),
        entryStatus,
      });

      await reapClosedWaitlistEntries(prisma, { now: NOW });

      expect(await entryExists(entryId)).toBe(false);
    },
  );

  it('keeps an entry on a class dated exactly at the cutoff', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(0),
      entryStatus: 'expired',
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(true);
  });

  it('deletes an entry on a class dated one day before the cutoff', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(false);
  });
```

- [ ] **Step 6: Run and verify all pass**

Run: `npx vitest run --project unit src/services/waitlist-retention.test.ts`
Expected: PASS, 11 tests (1 cutoff + 1 + 1 + 1 + 3 + 3 + 1 + 1).

- [ ] **Step 7: Prove all four clauses bite**

Four mutations, one at a time, each restored before the next. **Record the exact
failing assertion text for each** — the PR body must carry them.

| Mutate in `waitlist-retention.ts`'s `reapable` | Must fail |
|---|---|
| drop `registrationId: null` | "keeps an entry that became a registration" |
| drop `status: { notIn: [...FULFILLED_WAITLIST_STATUSES] }` | "keeps a promoted entry whose registrationId is somehow null" |
| `status: { in: [...] }` → drop the class-status clause | the three "keeps an entry on a %s class" cases |
| `date: { lt: cutoff }` → `date: { lte: cutoff }` | "keeps an entry on a class dated exactly at the cutoff" |

- [ ] **Step 8: Commit**

```bash
git add src/services/waitlist-retention.ts src/services/waitlist-retention.test.ts
git commit -m "feat: reap unfulfilled waitlist entries on terminal classes past a year

One class per transaction under lockClassRow, which is what stops this
deadlocking against deleteStudentAccount's unscoped deleteMany rather than
merely ordering around it.

The clock runs on Class.date, not on the entry's createdAt as #238 specifies:
createdAt is when the student joined the queue, so an entry for a class
scheduled far ahead is already past a year-long window the day that class
completes, and would be reaped the day after the class ran.

All four predicate clauses mutation-proved; exact failures in the PR body.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Measure the query plan, and decide the index on evidence

**Files:**
- Create (scratchpad, **not committed**): a seeding + `EXPLAIN` script
- Modify: nothing, unless the measurement says otherwise

**Why this is a task and not an assumption.** #238 asserts the sweep "carries a
**migration**". The spec argues it does not: a daily sweep is the weakest case
for an index there is, and this project has already added an index for a query
that then went away (#222). The roadmap's standing rule for this family (#223,
#224, #205) is *measure before adding*. This task produces the number.

- [ ] **Step 1: Capture the SQL Prisma actually generates**

Write `/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/f3ffc88f-dd57-4925-9bf9-9753617285dc/scratchpad/explain-retention.ts`:

```ts
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
db.$on('query', (e) => console.log(e.query, '\n--- params:', e.params, '\n'));

async function main() {
  const { reapClosedWaitlistEntries } = await import('../../../../Users/ivohofland/Projects/fair.yoga/src/services/waitlist-retention');
  await reapClosedWaitlistEntries(db, { maxClasses: 1 });
  await db.$disconnect();
}
void main();
```

Simpler in practice: run the existing test file with
`DEBUG='prisma:query'`, or add a one-off `log: ['query']` client inside a
throwaway test. **Either route is acceptable — what matters is that the SQL in
the PR body is the SQL Prisma emitted, not SQL written by hand.** #224 captured
its query the same way and says so.

- [ ] **Step 2: Seed a volume far past anything this app will see**

Against `DATABASE_URL_TEST` **only**. Confirm the target first:

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test -c '\conninfo'
```

Then seed 5,000 terminal classes and 50,000 entries with plain SQL, reusing the
teacher/room the retention suite's fixtures leave behind, or a fresh pair.
Record the exact statements used in the PR body.

- [ ] **Step 3: `EXPLAIN ANALYZE` the candidate query**

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
  -c 'EXPLAIN ANALYZE <the SQL captured in step 1, with literal params>'
```

Record: the plan nodes, the total execution time, and the row estimates.

- [ ] **Step 4: Decide, and write the decision down**

- If execution time at 50,000 entries is comfortably sub-second: **no index**,
  and the PR body carries the plan and the timing as the evidence. This is the
  expected outcome.
- If it is not: **do not add an index on this branch.** Post the measurement to
  #224 as an update — that issue already owns the question and already says
  "worth benchmarking against realistic volumes before adding anything". A
  surprise here is a finding, not a licence to grow this branch.

- [ ] **Step 5: Clean up the seeded rows**

Delete every row seeded in step 2. #177 exists because test databases accumulate
rows nothing prunes; a retention branch that leaves 50,000 behind would be
embarrassing. Verify:

```bash
docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test \
  -c 'SELECT count(*) FROM "WaitlistEntry";'
```

- [ ] **Step 6: Commit (nothing, or a note)**

No code change is expected. If the measurement changed nothing, there is nothing
to commit — carry the numbers forward to the PR body and to Task 6's doc edits.

---

### Task 4: Per-class isolation, and the cap

**Files:**
- Modify: `src/services/waitlist-retention.ts`
- Test: `src/services/waitlist-retention.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: no signature change — `failed` and `cappedOut` gain their behaviour.

- [ ] **Step 1: Write the failing isolation test**

Add to `src/services/waitlist-retention.test.ts`. Add
`import { log } from '@/lib/log';` and `vi` to the vitest imports.

```ts
  /**
   * Per-class isolation, broken the way it actually breaks.
   *
   * Not a stubbed throw: a second connection holds the class row's `FOR UPDATE`
   * lock for longer than `lockClassRow`'s 2s `SET LOCAL lock_timeout`, so the
   * sweep's own transaction fails with `55P03` — the realistic failure for this
   * code, and the one `classifyApiError` already models as transient.
   *
   * The two class ids are FIXED and ordered, because the candidate read is
   * `orderBy: { classId: 'asc' }`. With the held class sorting SECOND, removing
   * the try/catch would still leave the first class reaped and the test would
   * pass against the bug. Held class first is what makes the assertion mean
   * "the sweep continued past a failure".
   */
  it('skips a class whose lock it cannot take, and reaps the ones after it', async () => {
    const HELD = '00000000-0000-4000-8000-000000000001';
    const FREE = '00000000-0000-4000-8000-000000000002';

    const held = await makeClassWithEntry({
      id: HELD,
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });
    const free = await makeClassWithEntry({
      id: FREE,
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const holderDb = new PrismaClient();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    try {
      const holder = holderDb.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${HELD} FOR UPDATE`;
          // Longer than lockClassRow's 2s bound. Cast to ::text so the result
          // shape does not reject with P2010 — the same fix f25a1ad applied to
          // the erasure's holder transactions.
          await tx.$queryRaw`SELECT pg_sleep(4)::text`;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );

      // The holder must be sitting on the row before the sweep asks for it, or
      // the sweep sails through and this test reports nothing.
      await new Promise((r) => setTimeout(r, 300));

      const summary = await reapClosedWaitlistEntries(prisma, { now: NOW });

      expect(summary.failed).toBe(1);
      expect(await entryExists(held.entryId)).toBe(true);
      expect(await entryExists(free.entryId)).toBe(false);
      expect(error).toHaveBeenCalled();

      await holder;
    } finally {
      error.mockRestore();
      await holderDb.$disconnect();
    }
  }, 30_000);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project unit src/services/waitlist-retention.test.ts -t 'skips a class whose lock'`

Expected: FAIL — the sweep throws the `55P03` out of `reapClosedWaitlistEntries`
rather than returning, so the assertion is never reached. The failure message
will name `lock_not_available` / `55P03`.

- [ ] **Step 3: Add the per-class catch**

Replace the `for` loop body in `reapClosedWaitlistEntries`:

```ts
  for (const { classId } of batch) {
    // One transaction per class — see this module's header for why that is
    // the whole deadlock argument and not a style choice.
    //
    // Swallowed PER CLASS, and rethrown by nobody: one contended class must
    // not abandon the classes behind it, which is the same trade
    // `reconcileWaitlists` makes. Unlike that sweep this does NOT rethrow when
    // every class failed, because `isolatedSweeps` (`scheduler.ts`) is the
    // caller and it already logs and rethrows the first error it sees — and
    // because a retention sweep repairing nothing for one day is not the
    // affirmative false statement a reconciliation sweep repairing nothing is.
    try {
      const count = await db.$transaction(async (tx) => {
        await lockClassRow(tx, classId);
        // The predicate is re-applied under the lock rather than trusting the
        // candidate read: that read took no lock, and a delete scoped only by
        // `classId` would widen the write set past what was actually selected.
        const result = await tx.waitlistEntry.deleteMany({
          where: { classId, ...reapable },
        });
        return result.count;
      });
      deleted += count;
    } catch (err) {
      log.error({ err, classId }, 'waitlist retention could not reap a class');
      summary.failed += 1;
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit src/services/waitlist-retention.test.ts -t 'skips a class whose lock'`
Expected: PASS.

- [ ] **Step 5: Write the failing cap test**

```ts
  /**
   * The cap, exercised through the injected `maxClasses` rather than by
   * creating 501 classes. The seam exists for this reason and mirrors
   * `reconcileWaitlists(db, { now })`.
   *
   * `cappedOut` AND the log line, because `isolatedSweeps` discards sweep
   * return values — the log is the only channel an operator has, so a flag
   * nobody reads is not a report.
   */
  it('reports being capped, and says so in the log', async () => {
    await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });
    await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const summary = await reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 1 });

      expect(summary.cappedOut).toBe(true);
      expect(summary.classes).toBe(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('does not report being capped when it processed everything eligible', async () => {
    await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const summary = await reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 50 });

    expect(summary.cappedOut).toBe(false);
  });
```

- [ ] **Step 6: Run to verify the cap test fails**

Run: `npx vitest run --project unit src/services/waitlist-retention.test.ts -t 'reports being capped'`
Expected: FAIL at `expect(warn).toHaveBeenCalled()` — `cappedOut` is already
computed correctly by Task 2, but nothing logs it. The message will read
"expected \"warn\" to be called at least once".

- [ ] **Step 7: Add the cap's log line**

Insert immediately after `const batch = candidates.slice(0, maxClasses);`:

```ts
  if (cappedOut) {
    // Logged, not merely returned. A sweep that silently processes 500 of 900
    // eligible classes reads as "covered everything" in every downstream
    // report, and `isolatedSweeps` throws the return value away.
    log.warn(
      { cap: maxClasses, eligibleAtLeast: candidates.length },
      'waitlist retention hit its per-run class cap; the remainder waits for the next run',
    );
  }
```

- [ ] **Step 8: Run the whole file**

Run: `npx vitest run --project unit src/services/waitlist-retention.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 9: Prove both guards bite**

| Mutation | Must fail with |
|---|---|
| remove the `try`/`catch` around the per-class transaction | "skips a class whose lock it cannot take" — the sweep rejects with `55P03` instead of returning |
| remove the `log.warn` in the `cappedOut` branch | "reports being capped, and says so in the log" — `expected "warn" to be called at least once` |

Record both exact messages.

- [ ] **Step 10: Commit**

```bash
git add src/services/waitlist-retention.ts src/services/waitlist-retention.test.ts
git commit -m "feat: per-class isolation and a bounded run for the retention sweep

The isolation test holds the first class's row lock from a second connection
so lockClassRow's 2s bound fires for real, rather than stubbing a throw. Its
two class ids are fixed and the held one sorts first, because with it second
the test passes against the bug.

The cap logs as well as returns: isolatedSweeps discards sweep return values,
so a silently truncated run would read as a complete one everywhere downstream.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire it into the daily job, and rename the job

**Files:**
- Modify: `src/lib/scheduler.ts` (`SchedulerSweeps`, the dynamic imports, `buildJobs`)
- Modify: `src/lib/scheduler.test.ts:118` and `:155`
- Move: `src/app/api/cron/auth-cleanup/route.ts` → `src/app/api/cron/daily-cleanup/route.ts`
- Modify: `DEPLOYMENT.md:73`

**Interfaces:**
- Consumes: `reapClosedWaitlistEntries` (Task 2/4).
- Produces: scheduler job `daily-cleanup`, route `POST /api/cron/daily-cleanup`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/scheduler.test.ts`, three edits. First add the sweep to
`SWEEP_NAMES` (the `as const` array at `:24-34`), which is the single list
`buildStubs` and the two `type-pins` assertions all derive from:

```ts
  'reconcileWaitlists',
  'reapClosedWaitlistEntries',
] as const;
```

Its docblock at `:38-53` says the stub list and `SchedulerSweeps` "must name the
same **nine**". That count becomes **ten** — fix the word in the same edit. It
is exactly the class of stale claim Task 6 exists for, and it happens to sit in
the file this task is already editing.

Then the name/interval table (currently line 118):

```ts
      ['daily-cleanup', 24 * 60 * MINUTE],
```

Then the job → sweeps map (currently line 155):

```ts
      // Two sweeps, and the ORDER here is pinned without being load-bearing.
      // `isolatedSweeps` order is meaningful for `class-transitions` — a class
      // must transition to in-progress before it can be completed — and this
      // assertion is a whole-map equality, so it pins order everywhere. Nothing
      // couples auth cleanup to waitlist retention; do not read a dependency
      // into this line.
      'daily-cleanup': ['cleanupExpiredAuth', 'reapClosedWaitlistEntries'],
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit src/lib/scheduler.test.ts`

Expected: FAIL twice — the name table reports `auth-cleanup` where
`daily-cleanup` is expected, and the sweep map reports a one-element array where
two are expected.

Then run `npm run typecheck`, which should also fail: `_stubsHaveNoExtras` is
`NoneOf<Exclude<StubbedName, keyof SchedulerSweeps>>`, so adding
`'reapClosedWaitlistEntries'` to `SWEEP_NAMES` before the interface has that
field fails as `Type 'true' is not assignable to type
'"reapClosedWaitlistEntries"'`. That pin naming the offender is the point of
this ordering — do not skip the typecheck and assume vitest is the whole
signal.

- [ ] **Step 3: Update `scheduler.ts`**

Add to the `SchedulerSweeps` interface, after `reconcileWaitlists`:

```ts
  reapClosedWaitlistEntries: (db: PrismaClient) => Promise<unknown>;
```

Add to the dynamic imports in `startScheduler`, after the
`waitlist-reconciliation` line:

```ts
  const { reapClosedWaitlistEntries } = await import('@/services/waitlist-retention');
```

Add `reapClosedWaitlistEntries,` to the `buildJobs({ … })` argument object and
to the destructuring at the top of `buildJobs`.

Replace the `auth-cleanup` job entry:

```ts
    {
      // Renamed from `auth-cleanup` when waitlist retention joined it (#238):
      // the job is the daily retention slot now, not the auth one. Two sweeps
      // through `isolatedSweeps` rather than a seventh job, so there is one
      // daily timer and one obvious slot for the next retention policy (#223
      // poses the same question for `Notification`).
      //
      // The cost, recorded rather than glossed: `/api/health` reports one
      // `lastRunAt` for both sweeps instead of one each. Acceptable here and
      // not for `waitlist-reconciliation`, which took its own job name
      // deliberately — a 60-second correctness sweep needs its own health
      // signal in a way a daily retention sweep does not.
      name: 'daily-cleanup',
      intervalMs: 24 * 60 * MINUTE,
      run: isolatedSweeps('daily-cleanup', [cleanupExpiredAuth, reapClosedWaitlistEntries]),
    },
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --project unit src/lib/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Move and update the cron route**

```bash
git mv src/app/api/cron/auth-cleanup src/app/api/cron/daily-cleanup
```

Rewrite `src/app/api/cron/daily-cleanup/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { respondOk, withErrorHandler } from '@/lib/api-utils';
import { requireCronAuth } from '@/lib/cron-auth';
import { prisma } from '@/lib/db';
import { cleanupExpiredAuth } from '@/services/auth-cleanup';
import { reapClosedWaitlistEntries } from '@/services/waitlist-retention';

/**
 * One route per JOB, not per sweep — the existing shape, since
 * `/api/cron/transition-classes` already runs three. Renamed from
 * `auth-cleanup` with the scheduler job it mirrors (#238).
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  // Sequential, not `Promise.all`: these share one connection pool of three
  // (one vCPU), and neither is urgent.
  const auth = await cleanupExpiredAuth(prisma);
  const waitlistRetention = await reapClosedWaitlistEntries(prisma);

  return respondOk({ auth, waitlistRetention });
});
```

- [ ] **Step 6: Update `DEPLOYMENT.md:73`**

Change `/api/cron/auth-cleanup` to `/api/cron/daily-cleanup` in the comment
listing the cron endpoints.

- [ ] **Step 7: Verify the route by hand — nothing automated covers it**

**No test in `tests/integration/` touches any `/api/cron/*` route.** Confirmed
by `grep -rn "auth-cleanup" tests/` returning nothing. So the rename's only
guards are the build and this manual check. Do it, and record the result in the
PR body:

```bash
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/daily-cleanup
# expect: 200 with {"auth":{...},"waitlistRetention":{"deleted":0,...}}

curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3000/api/cron/auth-cleanup
# expect: 404 — the old path is gone
```

`CRON_SECRET` is in `.env`. If the dev server has not picked up the new route,
**do not restart it** — ask the user.

- [ ] **Step 8: Commit**

```bash
git add src/lib/scheduler.ts src/lib/scheduler.test.ts DEPLOYMENT.md
git add src/app/api/cron/daily-cleanup/route.ts
git commit -m "feat: the daily job runs waitlist retention beside auth cleanup

Renamed auth-cleanup to daily-cleanup, job and route together, because the
job is the daily retention slot now and #223 will want the same one. One
route per job is the existing shape — /api/cron/transition-classes already
runs three sweeps.

No test covers any /api/cron/* route, so the rename was verified by hand
against the running app; both results are in the PR body.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Correct every artifact this branch falsifies

**Files:**
- Modify: `src/services/gdpr.ts:646-651`
- Modify: `src/services/waitlist-reconciliation.ts:180-190`
- Modify: `docs/lock-order.md` ("Known conformance")
- Modify: `docs/data-model.md` (`### WaitlistEntry (overflow)`)
- Modify: `CLAUDE.md` (**Waitlist (Hybrid Promotion)**)

**Why this is its own task.** A claim fixed in one place while its twin stands is
this project's most repeated failure. Spec §4 enumerates the artifacts; this
task discharges them **with one verdict per location**, because "is §4 done?" is
unanswerable when §4 names five files.

- [ ] **Step 1: `gdpr.ts` — the budget rationale's premise changed**

The sentence at `:646-651` reads "it is a handful that only grows, because
nothing reaps a closed, unfulfilled `WaitlistEntry`. #238 is the root fix for
that". Replace the "only grows" clause. The ceiling's *rationale* survives — it
is still a ceiling on damage rather than a forecast of need — but the axis is now
bounded by the retention window rather than by account age. Say which, and name
the window:

```
    // that lock set is a handful of classes — and since #238 it is a handful
    // bounded by the retention window rather than by account age:
    // `reapClosedWaitlistEntries` (`waitlist-retention.ts`) deletes closed,
    // unfulfilled entries once their class is more than
    // `WAITLIST_RETENTION_DAYS` old. That bounds the axis; it does not make it
    // small, and the number below is still a ceiling on damage rather than a
    // forecast of need — a student queuing weekly for classes they never get
    // into still accumulates ~52 of them inside the window.
```

Verify by re-reading the whole paragraph afterwards: the surrounding argument
about `Math.min` and #240 must still parse.

- [ ] **Step 2: `waitlist-reconciliation.ts` — a second hard deleter exists**

At `:180-190` the comment says every closure "either writes a terminal status
(`removed` or `expired`) or deletes the row outright (`deleteStudentAccount`,
`gdpr.ts`, is a hard delete rather than a status write)", and then gives a grep
to re-derive the roster. Add the reaper:

```
    // ... or deletes the row outright — `deleteStudentAccount` (`gdpr.ts`) and,
    // since #238, `reapClosedWaitlistEntries` (`waitlist-retention.ts`) are
    // both hard deletes rather than status writes. The reaper cannot affect
    // THIS query's candidate set: it only touches classes in a terminal status,
    // and this reads `status: 'waiting'` on `open` ones. It does drain the
    // pre-#216 legacy `waiting` rows on terminal classes, which are the last
    // rows that could still make the join below do any work.
```

The grep recipe stays; note in the same edit that it now returns two production
deleters, not one.

- [ ] **Step 3: `docs/lock-order.md` — add the reaper to "Known conformance"**

Add an entry alongside the others, and make the single-row-lock classification
explicit, because that is the whole safety argument:

```markdown
- **`reapClosedWaitlistEntries`** (`src/services/waitlist-retention.ts`) —
  `Class`, then `WaitlistEntry`, one class per `db.$transaction` via
  `lockClassRow`. **Deliberately a single-row-lock site**, like
  `autoCancelClasses` and unlike the five above: it never holds a second
  `Class` row lock, so it carries no ordering obligation and cannot be half of
  an AB-BA cycle. That matters because its write set overlaps
  `deleteStudentAccount`'s — that function's `waitlistEntry.deleteMany` is
  keyed on `studentId` with no class-status scope, so it deletes entries on
  terminal classes too, which is exactly what this sweep deletes. Two multi-row
  `WaitlistEntry` deletes taking rows in different plan orders is a cycle whose
  victim Postgres chooses, and it can choose the erasure. One class at a time
  removes the cycle rather than ordering it away.
```

Do **not** change the "**five** sites lock more than one `Class` row" count at
`:59`, and do not change `gdpr.ts:418`'s "All five such sites" — the reaper is
not one of them. Confirm the `FOR UPDATE OF` grep at `:64-74` still returns
exactly one line:

```bash
grep -rn 'FOR UPDATE OF' --include="*.ts" src/ \
  | grep -v '\.test\.ts' \
  | grep -vE ':[0-9]+: *(//|\*|/\*)'
```

- [ ] **Step 4: `docs/data-model.md` — state the retention policy**

Under `### WaitlistEntry (overflow)`, add:

```markdown
**Retention (#238):** an entry that never became a registration
(`registration_id IS NULL`) is deleted once its class is terminal
(`completed`/`cancelled`) and more than 365 days past its `date`. An entry that
did become a registration is joined to a financial record and is kept.
Swept daily by `reapClosedWaitlistEntries` (`services/waitlist-retention.ts`).
```

- [ ] **Step 5: `CLAUDE.md` — one line under Waitlist**

Append to the **Waitlist (Hybrid Promotion)** bullet list:

```markdown
- Retention: an entry that never became a registration is reaped 365 days after
  its class ran, once that class is terminal — a daily sweep, no migration
```

- [ ] **Step 6: Reconcile against the diff, not against a keyword**

**This step is the one that has failed before.** Do not grep for a phrase from
one of the edits above and call §4 discharged — a keyword sweep scoped to one
correction cannot see another's twin. Instead:

```bash
git diff --name-only main...HEAD
```

List the files the branch changed. List the five files §4 of the spec says it
must change. Reconcile the two, and state any difference out loud.

Then verify the two claims §4 deliberately leaves alone are still there and
still make sense as dated records:

```bash
grep -n "#238" docs/superpowers/specs/2026-08-16-erasure-budget-design.md
grep -n "auth-cleanup" docs/superpowers/specs/2026-08-11-retry-safe-endpoints-design.md
```

Both must still be present and unedited. If either was edited, revert it — a
dated spec is a historical record.

- [ ] **Step 7: Commit**

```bash
git add src/services/gdpr.ts src/services/waitlist-reconciliation.ts
git add docs/lock-order.md docs/data-model.md CLAUDE.md
git commit -m "docs: five artifacts asserted nothing reaps a waitlist entry

gdpr.ts's budget rationale rested on the axis being unbounded; it is now
bounded by the retention window without becoming small, and the ceiling's
argument survives that unchanged.

lock-order.md gains the reaper as a deliberate single-row-lock site — the
'five sites lock more than one Class row' count is unchanged, because it is
not one of them, and that is the point.

Two dated specs under docs/superpowers/specs/ still say the old thing and are
left alone on purpose: a dated design record is not a live reference doc.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Before pushing

- [ ] **Run the whole gate.** `npm run verify` — typecheck, lint, and all three
  vitest projects. It needs the app running on :3000; without it you get a wall
  of `ECONNREFUSED`. **Do not start or restart the dev server** — ask the user.

- [ ] **Measure the after-figures; do not predict them.** Record files and tests
  per project with totals that reconcile against the baseline above
  (120 = 54 + 38 + 28, 1393 tests).

- [ ] **Green `verify` is not CI.** CI additionally runs `prisma validate`, a
  migration-drift check, `npm run build` and Playwright. This branch adds no
  migration, so drift should be clean — but a build-only defect passes `verify`
  and fails CI. Run `npm run build` locally before pushing.

- [ ] **The PR body must record**, per the project's standing rule:
  - Which of #238's claims were checked and which held — including the two that
    did not (§1.3 of the spec: the `createdAt` axis, and `reconcileWaitlists`'
    join already being belt-and-braces since #216), and the one that could not
    be substantiated (the "weakened deadlock test").
  - The four mutations from Task 2 and the two from Task 4, with **exact error
    text**.
  - Task 3's `EXPLAIN ANALYZE` plan and timing, as the evidence for shipping no
    index against an issue that asserts a migration.
  - The manual cron-route curl results from Task 5 step 7, and the fact that no
    automated test covers that route.
  - The arithmetic proving every `integration` file ran — `npm run verify` runs
    all three projects, so a green run **is** the whole integration suite. Say
    so with the file counts. **This branch changes no `integration` file**;
    distinguish "runs" from "changes" explicitly.
  - What the PR does not do: no index, no migration, no export change, no
    notification, no backfill. Write "**#224 is unaffected**", "**#223 is
    unaffected**" — **never** the word `close`/`fixes`/`resolves` immediately
    before a `#N` you do not intend to close. GitHub's parser does not
    understand a negation in front of it, and this project has closed an issue
    that way twice.

---

## Self-review of this plan

**Spec coverage.** Every spec section maps to a task: §2.1 → Task 2 steps 3/5;
§2.2 → Task 1; §2.3 → Task 2 step 3 and Task 4; §2.4 → Task 2 (`retentionCutoff`
and the boundary tests); §2.5 → Task 3; §2.6 → Task 2 (the service and its
constants) and Task 5 (placement, rename, cap); §3's T1–T13 → Tasks 1, 2, 4, 5;
§4 → Task 6; §5 (out of scope) → the "Before pushing" PR-body checklist.

**Type consistency.** `reapClosedWaitlistEntries(db, opts)` has one signature
throughout, and it satisfies `SchedulerSweeps`' `(db: PrismaClient) =>
Promise<unknown>` because both option fields are optional. `ReapSummary`'s four
fields — `deleted`, `classes`, `failed`, `cappedOut` — are the same four in the
service, the tests, and the route's response. `TERMINAL_CLASS_STATUSES` and
`FULFILLED_WAITLIST_STATUSES` are both `readonly T[]`, so both spread with
`[...]` at every Prisma `in:`/`notIn:` call site.

**Placeholder scan: clean.** Every code step carries the actual code. The one
step that is deliberately open-ended is Task 3 step 2 (seeding SQL), and it is
open-ended because the volume is a judgement call, not because the content is
missing — it names the target database, the row counts, and what must be
recorded.

**Two things this plan asserts that its author did not verify**, listed so a
reviewer can attack them first rather than discover them:

1. **`git mv` on `src/app/api/cron/auth-cleanup`** (Task 5 step 5). The path has
   no parentheses, so the project's quote-the-path hazard does not apply — but
   Next.js route directories are also build inputs, and a stale `.next` is a
   known cause of phantom 404s here. If the curl in step 7 404s on the NEW path,
   that is the likely cause, and the fix is wiping `.next` — not restarting the
   dev server, which is the user's.
2. **`vi.spyOn(log, 'warn')` on a pino instance** (Task 4). Established in this
   repo — `tiers.server.test.ts:16` and `scheduler.test.ts:83` both do it — so
   this is inference from two working precedents rather than a run. If it fails,
   the fallback is `vi.mock('@/lib/log', …)`, the shape `api-utils.test.ts:19`
   uses.
