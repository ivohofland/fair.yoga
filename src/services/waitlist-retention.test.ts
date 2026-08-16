import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ClassStatus, WaitlistStatus } from '@prisma/client';
import { log } from '@/lib/log';
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
let studentId2: string;
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

  /**
   * Not isolated from the suite above, and that is worth recording rather
   * than fixing quietly. The sweep's `groupBy` is not scoped to this suite's
   * fixtures — it sees every reapable row in the shared test database. The
   * isolation test above deliberately leaves its held class un-reaped (its
   * lock times out), and that class uses the fixed id
   * `00000000-0000-4000-8000-000000000001`, which sorts below every
   * `@default(uuid())` id under the candidate read's
   * `orderBy: { classId: 'asc' }`. So it is that stale class — not either of
   * the cap test's own two fixtures, immediately above — that fills the
   * `maxClasses: 1` batch there, leaving both of the cap test's fixtures
   * unprocessed and still eligible when this test runs. This test's own
   * `maxClasses: 50` sweep picks up all of them alongside its own single
   * fixture; the cap's behaviour is still asserted correctly, this test is
   * simply not isolated, and it passes today because the total stays well
   * under 50. `afterAll` cleans everything, so nothing leaks across runs —
   * this is an instance of issue #177 (test databases accumulate rows nothing
   * prunes), not a bug in the sweep itself. A future author adding more
   * reapable fixtures to this file should expect this test to become
   * fragile.
   */
  it('does not report being capped when it processed everything eligible', async () => {
    await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const summary = await reapClosedWaitlistEntries(prisma, { now: NOW, maxClasses: 50 });

    expect(summary.cappedOut).toBe(false);
  });
});
