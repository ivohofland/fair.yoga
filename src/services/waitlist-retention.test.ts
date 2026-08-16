import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ClassStatus, WaitlistStatus } from '@prisma/client';
import { log } from '@/lib/log';
import { FULFILLED_WAITLIST_STATUSES } from '@/lib/waitlist-status';
import {
  reapClosedWaitlistEntries,
  RetentionFailedError,
  retentionCutoff,
  WAITLIST_RETENTION_DAYS,
} from './waitlist-retention';

/**
 * A pure DB-invariant suite — nothing here calls the app on `:3000` — so it
 * lives in the `unit` project. The same reasoning `class-terminal-status.test.ts`'s
 * header sets out: an `integration` file would run against the DEV database by
 * design (`docs/test-database.md` §3.4), and this file DELETES rows.
 *
 * BUT THE `unit` PROJECT IS NOT A GUARANTEE. `tests/setup/unit-db.ts`
 * PROVISIONS `DATABASE_URL_TEST`; it does not force this project onto it. When
 * that variable is absent the setup logs "CI mode" and returns, and
 * `vitest.config.ts` resolves this project's `DATABASE_URL` to
 * `testUrl ?? devUrl` — the DEV database. Isolation here is a value in `.env`,
 * which is configuration and not a guard.
 *
 * THIS IS THE DESTRUCTIVE ONE of the two files that share that wording. Unlike
 * every other unit suite, this one calls `reapClosedWaitlistEntries`, whose
 * `groupBy` and `deleteMany` are deliberately NOT scoped to the fixtures below
 * — that is the function's whole job. Pointed at dev it would permanently
 * delete every unfulfilled entry on every terminal class past the cutoff.
 * `unit-db.ts`'s own docblock records that database-wide sweep tests have
 * already caused one real incident: clock-injected sweeps completed the seed's
 * future classes AND MAILED THEIR PAYMENT REQUESTS — a sent email is no more
 * recoverable than a deleted row, so the comparison is between two bad
 * outcomes, not between a recoverable one and this.
 * `class-terminal-status.test.ts` carries the same sentence and none of the
 * blast radius: it only creates and updates rows it made itself.
 *
 * Hence the `beforeAll` guard below, which asks the connected database its own
 * name rather than trusting the environment — and the teardown's own
 * fail-closed bail, since a guard that throws in `beforeAll` still runs
 * `afterAll`.
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

/**
 * Fixture ids, initialised to `''` rather than left `undefined` — and that is a
 * safety property, not tidiness.
 *
 * `afterAll` runs even when `beforeAll` throws, and Prisma DROPS an `undefined`
 * field filter rather than rejecting it, so `deleteMany({ where: { id: undefined } })`
 * is `deleteMany({ where: {} })` — a whole-table wipe. Four of the statements
 * below are of exactly that shape (`TeacherRoom`, `Room`, `Teacher`, `Account`),
 * and the path that gets there is this file's OWN guard: it refuses a
 * non-`_test` database — i.e. dev — and the teardown then asks that same
 * database to empty those tables.
 *
 * `''` matches nothing, so every statement below is a no-op before assignment.
 * `afterAll`'s own early return is the second half; see there for why both.
 */
let teacherId = '';
let accountId = '';
let roomId = '';
let teacherRoomId = '';
let studentId = '';
let studentId2 = '';
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

/**
 * Adds a second entry to an EXISTING class, for a different student.
 *
 * `makeClassWithEntry` above puts exactly one entry on one class, so for
 * every fixture built from it alone, a mutation that only weakens the
 * PER-CLASS delete's own predicate — as opposed to weakening which classes
 * enter the `groupBy` batch — has nothing to catch it: the one entry present
 * is always either the thing being proven deleted or the thing being proven
 * kept, never both at once. A real terminal class realistically holds a MIXED
 * population — some entries reapable, some not — and this is the fixture
 * shape that requires: call it beside `makeClassWithEntry` to add a second
 * entry, for a second student (`@@unique([classId, studentId])` forbids two
 * for the same one), to a class that already has an entry putting it in the
 * batch.
 */
async function addEntry(
  classId: string,
  opts: { studentId: string; status: WaitlistStatus; withRegistration?: boolean },
): Promise<string> {
  let registrationId: string | null = null;
  if (opts.withRegistration) {
    const reg = await prisma.registration.create({
      data: { classId, studentId: opts.studentId, tierAtBooking: 3 },
    });
    registrationId = reg.id;
  }

  const entry = await prisma.waitlistEntry.create({
    data: {
      classId,
      studentId: opts.studentId,
      position: 2,
      status: opts.status,
      ...(registrationId ? { registrationId } : {}),
    },
  });
  return entry.id;
}

beforeAll(async () => {
  await prisma.$connect();

  // BEFORE any fixture is written, and before anything calls the sweep.
  //
  // Asked of the connection, not of `process.env.DATABASE_URL_TEST`: that
  // variable is read from the `.env` FILE by `loadEnv` in `vitest.config.ts`
  // and need not exist in this process at all, so its absence proves nothing
  // either way. The only answer that cannot be wrong is the one the server
  // gives about the database this client is actually connected to.
  // Fails CLOSED: `noUncheckedIndexedAccess` makes the row possibly-undefined,
  // and the fallback is the empty string rather than a skip, so a query that
  // somehow returns nothing throws the refusal below instead of proceeding.
  const [row] =
    await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  const dbName = row?.current_database ?? '';
  if (!/_test$/.test(dbName)) {
    throw new Error(
      `[waitlist-retention.test] refusing to run an unscoped DELETE sweep against "${dbName}" — ` +
        'this suite calls reapClosedWaitlistEntries, which is not scoped to its own fixtures. ' +
        'Set DATABASE_URL_TEST to a database whose name ends in _test.',
    );
  }

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

  // A second student, needed only by `addEntry`'s callers: two entries on one
  // class means two students, since `@@unique([classId, studentId])` forbids
  // a student holding two entries on the same class.
  const student2 = await prisma.student.create({
    data: {
      firstName: 'Retention',
      lastName: 'Student2',
      email: `retention-student2-${uniqueSuffix}@test.local`,
      incomeTier: 3,
    },
  });
  studentId2 = student2.id;
});

afterAll(async () => {
  // FAIL CLOSED, on the same principle as the `beforeAll` guard: if setup did
  // not get far enough to create a teacher, there are no fixtures to clean and
  // this function has no business issuing DELETEs at all.
  //
  // Belt and braces with the `''` initialisers above, deliberately. Either one
  // alone is sufficient today; each covers the other's failure mode. The
  // initialisers stop a whole-table wipe if a future edit adds a statement
  // ABOVE this return or reorders the teardown; this return stops one if a
  // future id is added without an initialiser. What made the wipe merely
  // latent before was neither — it was that `student.deleteMany` happened to
  // sit above the four unguarded statements and threw `PrismaClientValidationError`
  // on `in: [undefined, undefined]` first. That is an accident of ordering,
  // and "fixing" it with a `.filter(Boolean)` would have removed the shield.
  if (!teacherId) {
    await prisma.$disconnect();
    return;
  }

  // Ordered children-first. #177 is about test databases accumulating rows
  // nothing prunes; a retention suite that leaks its own fixtures would be a
  // poor joke.
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.payment.deleteMany({ where: { registration: { classId: { in: classIds } } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.student.deleteMany({ where: { id: { in: [studentId, studentId2] } } });
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
  });

  /**
   * The policy number itself, pinned in its own named test.
   *
   * It was buried inside the UTC-normalisation test above, where a failure
   * would have reported "the cutoff is not UTC-normalised" for what is actually
   * "someone changed the retention period". This is a product/legal decision
   * (#238 parked it as one) and an irreversible one in the shortening
   * direction — it deserves a line that says so when it goes red.
   */
  it('keeps the retention window at the decided 365 days', () => {
    expect(WAITLIST_RETENTION_DAYS).toBe(365);
  });
});

describe('reapClosedWaitlistEntries', () => {
  /**
   * `summary.deleted` counted against reality, not against a floor.
   *
   * `toBeGreaterThanOrEqual(1)` left `deleted += count` mutable to
   * `deleted += 1` — per CLASS instead of per ENTRY — with the entire suite
   * still green, including the mixed-population test below, which deletes one
   * of two entries on one class and so agrees with both readings.
   *
   * Bracketing the call with a whole-table `count()` is what makes the number
   * mean something, and it is true regardless of what else is in the shared
   * test database: the sweep is not scoped to this suite's fixtures, so the
   * DIFFERENCE across the call is exactly what the sweep deleted, whoever
   * created the rows. A count of this suite's own fixtures would not be —
   * it would silently ignore anything the sweep removed from elsewhere.
   *
   * TWO reapable entries on ONE class, which is what actually kills the
   * mutation. The bracket alone does not: with one entry on one class, per-class
   * and per-entry counting agree at 1. Two entries under one `deleteMany` make
   * them disagree — 2 against 1 — and the fixture is realistic besides, since a
   * real closed queue holds several people, not one.
   */
  it('deletes every unfulfilled entry on a terminal class past the window', async () => {
    const { classId, entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });
    const secondEntryId = await addEntry(classId, {
      studentId: studentId2,
      status: 'expired',
    });

    const before = await prisma.waitlistEntry.count();
    const summary = await reapClosedWaitlistEntries(prisma, { now: NOW });
    const after = await prisma.waitlistEntry.count();

    // Two entries, one class: the figure below distinguishes counting entries
    // from counting classes.
    expect(summary.deleted).toBeGreaterThanOrEqual(2);
    expect(before - after).toBe(summary.deleted);
    expect(await entryExists(entryId)).toBe(false);
    expect(await entryExists(secondEntryId)).toBe(false);
  });

  /**
   * The two clauses this test isolates that no other test in this file does.
   *
   * Every other fixture puts exactly one entry on its class, so for each of
   * them the per-class delete's own predicate (`{ classId, ...reapable }`)
   * and a naive `{ classId }` select IDENTICAL rows — a class that enters the
   * `groupBy` batch has nothing on it BUT what the batch predicate already
   * found, so nothing distinguishes "the predicate is re-applied under the
   * lock" from "the write set is just `classId`". This fixture is the shape
   * that distinguishes them: two entries, two different students
   * (`@@unique([classId, studentId])` forbids two for one), on ONE class:
   *
   *  - the unfulfilled entry is what puts the class in the `groupBy` batch
   *  - the fulfilled sibling — `registrationId` set, status left at `expired`
   *    rather than a `FULFILLED_WAITLIST_STATUSES` member, exactly the
   *    "somehow disagree" case the belt-and-braces clause exists for — must
   *    survive the SAME class's delete
   *
   * Two mutations go red here, and only here:
   *  - `where: { classId, ...reapable }` → `where: { classId }` in the
   *    per-class delete: nothing then stops the sibling being swept up by the
   *    same statement that deletes its neighbour.
   *  - dropping `registrationId: null` from `reapable`: the sibling's own
   *    status (`expired`) is not in `FULFILLED_WAITLIST_STATUSES`, so the
   *    status clause alone does not protect it — only `registrationId: null`
   *    does.
   */
  it('deletes an unfulfilled entry while a fulfilled sibling on the same class survives', async () => {
    const { classId, entryId: unfulfilledEntryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });
    const fulfilledEntryId = await addEntry(classId, {
      studentId: studentId2,
      status: 'expired',
      withRegistration: true,
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(unfulfilledEntryId)).toBe(false);
    expect(await entryExists(fulfilledEntryId)).toBe(true);
  });

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
   * and this goes red, which is the whole point: a guard that cannot fail
   * certifies nothing.
   *
   * PARAMETRISED OVER THE SET, not written once for `promoted`, and that is
   * what pins MEMBERSHIP rather than just the clause. With a single `promoted`
   * case, moving `claimed` out of `FULFILLED_WAITLIST_STATUSES` — say to
   * `withdrawn` in `QUEUE_ROLE` — left the whole suite green: `CLAIMABLE` is
   * unchanged either way, and the only other `claimed` fixture in this file
   * carries a registration, so `registrationId: null` covered for it.
   *
   * That is not hypothetical belt-and-braces. `WaitlistEntry.registration`
   * declares no `onDelete`, so Prisma's default is `SetNull` — a future hard
   * delete of a `Registration` produces exactly a `claimed` row with
   * `registrationId: null`, and the status clause would be the only thing
   * standing between it and permanent deletion.
   *
   * `it.each` over the constant is self-extending: a sixth fulfilled status
   * gets a case for free, and one removed from the set stops being asserted
   * here at the same moment it stops being protected there.
   */
  it.each([...FULFILLED_WAITLIST_STATUSES])(
    'keeps a %s entry whose registrationId is somehow null',
    async (entryStatus) => {
      const { entryId } = await makeClassWithEntry({
        classStatus: 'completed',
        date: daysBeforeCutoff(400),
        entryStatus,
      });

      await reapClosedWaitlistEntries(prisma, { now: NOW });

      expect(await entryExists(entryId)).toBe(true);
    },
  );

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

  /**
   * Per-class isolation, broken the way it actually breaks.
   *
   * Not a stubbed throw: a second connection holds the class row's `FOR UPDATE`
   * lock for longer than `lockClassRow`'s 2s `SET LOCAL lock_timeout`, so the
   * sweep's own transaction fails with `55P03` — the realistic failure for this
   * code, and the one `classifyApiError` already models as transient.
   *
   * THE TWO CLASS IDS ARE ORDERED, because the candidate read is
   * `orderBy: { classId: 'asc' }` (pinned by its own test below), and the held
   * class must sort FIRST. What that buys is NOT what an earlier version of
   * this docblock claimed. It said that with the held class second, "removing
   * the try/catch would still leave the first class reaped and the test would
   * pass against the bug" — false: with no try/catch the `55P03` propagates out
   * of `reapClosedWaitlistEntries`, the `await` below rejects, and the test
   * fails in EITHER order.
   *
   * Two real things follow from held-first. The assertion `free` was reaped
   * DEMONSTRATES continuation past a failure rather than holding vacuously —
   * with the held class last, "the ones after it" is the empty set and the test
   * asserts nothing about continuation. And it is what catches a catch that
   * STOPS the loop (`break`, or an early `return summary`), which propagating
   * would not: that mutation leaves the sweep returning normally, having reaped
   * nothing after the failure.
   *
   * The ids are derived from `uniqueSuffix` rather than hard-coded. They must
   * still sort below every `@default(uuid())` id — hence the all-zero prefix —
   * but `unit-db.ts` never truncates, so a fixed id left behind by an
   * interrupted run would fail every later run with a P2002 until someone
   * cleaned it out by hand.
   */
  it('skips a class whose lock it cannot take, and reaps the ones after it', async () => {
    // The sort-first property lives in the leading groups — `00000000-0000-…`
    // is below any random uuid at the first character that differs — so the
    // final group is free to carry `uniqueSuffix` for uniqueness. `n` is the
    // last character, which is what orders HELD before FREE.
    const lowId = (n: number): string =>
      `00000000-0000-4000-8000-${String(uniqueSuffix).slice(-11).padStart(11, '0')}${n}`;
    const HELD = lowId(1);
    const FREE = lowId(2);

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
    // `warn`, not `error`, and that is the assertion. A lock timeout is
    // `isTransientDbError`, and the sweep classifies its per-class failures on
    // exactly that — `error` is reserved for what should page someone, and this
    // failure is the system doing what `lockClassRow` configured it to do.
    // Spying on `error` too proves the split bites rather than just that
    // something was logged.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
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

      // Named, not merely "something was logged". A bare
      // `expect(warn).toHaveBeenCalled()` is satisfied by any `log.warn` in the
      // run — the cap warning, for instance — so it would survive the per-class
      // line being deleted outright.
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ classId: HELD, transient: true }),
        expect.stringContaining('lost a lock race'),
      );
      // A transient failure must NOT page: `error` is the all-failed branch's
      // level, and this run had a success in it.
      expect(error).not.toHaveBeenCalled();

      await holder;
    } finally {
      warn.mockRestore();
      error.mockRestore();
      await holderDb.$disconnect();
    }
  }, 30_000);

  /**
   * The cap, exercised through the injected `maxClasses` rather than by
   * creating 501 classes. The seam exists for this reason and mirrors
   * `reconcileWaitlists(db, { now })`.
   *
   * `cappedOut` AND the log line, because `isolatedSweeps` discards sweep
   * return values — the log is the only channel an operator has, so a flag
   * nobody reads is not a report.
   *
   * `eligibleAtLeast` is asserted against a count this test takes ITSELF, which
   * is what distinguishes a measurement from a constant. The reported figure
   * used to be `candidates.length`, and because the candidate read is
   * `take: maxClasses + 1` that is always exactly `maxClasses + 1` whenever
   * `cappedOut` — it would print 2 here however many classes were really
   * waiting. Restoring that mutation makes the equality below fail as long as
   * more than two classes are eligible, which the fixtures guarantee.
   */
  it('reports being capped, with the real eligible count, and says so in the log', async () => {
    // THREE of its own, not two: the assertion below needs the real eligible
    // count to exceed `maxClasses + 1` (= 2) for the difference between a
    // measurement and that constant to be visible at all. Built here rather
    // than relying on what earlier tests happened to leave behind.
    for (let i = 0; i < 3; i += 1) {
      await makeClassWithEntry({
        classStatus: 'completed',
        date: daysBeforeCutoff(1),
        entryStatus: 'expired',
      });
    }

    // Independently of the sweep, and before it runs.
    const eligibleBefore = (
      await prisma.waitlistEntry.groupBy({
        by: ['classId'],
        where: {
          registrationId: null,
          status: { notIn: ['promoted', 'claimed'] },
          class: { status: { in: ['completed', 'cancelled'] }, date: { lt: CUTOFF } },
        },
      })
    ).length;
    expect(eligibleBefore).toBeGreaterThan(2);

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const summary = await reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 1 });

      expect(summary.cappedOut).toBe(true);
      expect(summary.classes).toBe(1);
      expect(summary.eligibleAtLeast).toBe(eligibleBefore);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ cap: 1, eligible: eligibleBefore, drainDays: eligibleBefore }),
        expect.stringContaining('per-run class cap'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * TWO successful per-class transactions in one run, and the only test that
   * observes them.
   *
   * That is what kills `break` (or an early `return`) after the first
   * successful delete — a mutation that survived the entire rest of the suite.
   * Every other test here reaps its own single fixture, so by the time the next
   * one runs exactly one class is eligible and one iteration is
   * indistinguishable from all of them. The isolation test above does have two
   * classes, but its first one FAILS, so it constrains the catch rather than the
   * loop's continuation after a success.
   *
   * ORDER-INDEPENDENT BY CONSTRUCTION, which also retires the fragility an
   * earlier version of this docblock recorded at length. It no longer asserts
   * anything about how many classes the world contains — it asserts that the
   * queue was DRAINED: sweep, then sweep again and find nothing left. Whatever
   * else the shared test database holds is swept up by the first call and
   * absent from the second, so a future author adding reapable fixtures to this
   * file cannot break it. (The un-isolated version asserted `cappedOut === false`
   * under `maxClasses: 50` and depended on the total staying under 50, with the
   * previous test's stale held class filling its batch — an accident, and #177
   * territory rather than a bug in the sweep.)
   *
   * The second sweep is also the only idempotency assertion in the file: a
   * permanent delete that finds work on a second pass over the same data would
   * mean the first pass did not do what it reported.
   */
  it('reaps every eligible class in one run, and finds nothing left on the next', async () => {
    const first = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });
    const second = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const summary = await reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 50 });

    expect(summary.cappedOut).toBe(false);
    expect(summary.classes).toBeGreaterThanOrEqual(2);
    expect(summary.failed).toBe(0);
    expect(await entryExists(first.entryId)).toBe(false);
    expect(await entryExists(second.entryId)).toBe(false);

    // Drained, not merely "small". Nothing eligible remains, so a loop that
    // stopped after one class has nowhere to hide.
    const again = await reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 50 });
    expect(again.classes).toBe(0);
    expect(again.deleted).toBe(0);
    expect(again.cappedOut).toBe(false);
  });

  /**
   * The all-failed run throws rather than returning a clean-looking summary.
   *
   * Without this, `{classes: N, failed: N, deleted: 0}` returns normally,
   * `makeTick` stamps `lastSuccessAt` and nulls `lastError`, and `/api/health`
   * reports the job healthy — the field `DEPLOYMENT.md` tells operators to
   * monitor. `isolatedSweeps` cannot cover for it: it only ever sees errors that
   * ESCAPE the sweep, and the per-class catch guarantees none do.
   *
   * The failure is provoked the same way the isolation test provokes it — a real
   * held lock — but with only ONE eligible class, so every class fails and the
   * `failed === classes` branch is the one under test. `maxClasses: 1` keeps the
   * batch to that class whatever else the database holds.
   */
  it('throws when it attempted classes and every one failed', async () => {
    const HELD = `00000000-0000-4000-8000-${String(uniqueSuffix).slice(-11).padStart(11, '0')}9`;
    await makeClassWithEntry({
      id: HELD,
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const holderDb = new PrismaClient();
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const holder = holderDb.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${HELD} FOR UPDATE`;
          await tx.$queryRaw`SELECT pg_sleep(4)::text`;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 300));

      await expect(
        reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 1 }),
      ).rejects.toBeInstanceOf(RetentionFailedError);

      // The run-level line, at `error` — distinct from the per-class line,
      // which is at `warn` because a lock timeout is transient. A run that
      // accomplished nothing is a different statement at any N.
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ classes: 1, failed: 1, deleted: 0 }),
        expect.stringContaining('every class it tried failed'),
      );

      await holder;
    } finally {
      error.mockRestore();
      warn.mockRestore();
      await holderDb.$disconnect();
    }
  }, 30_000);

  /**
   * The candidate read's sort direction, pinned.
   *
   * `orderBy: { classId: 'asc' }` → `'desc'` passed the entire suite while
   * inverting the property the isolation test's validity rests on: its held
   * class is built to sort FIRST, and under `desc` it would sort last, quietly
   * making that test's continuation assertion vacuous. A guard whose premise is
   * unpinned degrades unnoticed.
   *
   * Asserted through `maxClasses: 1`, which is the only externally visible
   * consequence of the direction: with two eligible classes and a batch of one,
   * the sweep reaps the LOWER id under `asc` and the higher under `desc`.
   */
  it('takes candidate classes in ascending id order', async () => {
    const lowId = `00000000-0000-4000-8000-${String(uniqueSuffix).slice(-11).padStart(11, '0')}3`;
    const highId = `ffffffff-ffff-4fff-8fff-${String(uniqueSuffix).slice(-11).padStart(11, '0')}4`;

    const low = await makeClassWithEntry({
      id: lowId,
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });
    const high = await makeClassWithEntry({
      id: highId,
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      await reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 1 });
    } finally {
      warn.mockRestore();
    }

    // `asc` reaps the low id and leaves the high one for the next run.
    expect(await entryExists(low.entryId)).toBe(false);
    expect(await entryExists(high.entryId)).toBe(true);
  });
});
