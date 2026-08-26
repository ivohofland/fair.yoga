import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';

/**
 * `CalendarEntry`'s database-level guarantees, asserted against the real
 * database through raw SQL.
 *
 * RAW SQL THROUGHOUT for every `CalendarEntry`, `Class` and `StudioClass`
 * write, and that is the point rather than an inconvenience: three of the four
 * objects under test here — the exclusion constraint and the two `UPDATE`
 * triggers — exist to reach a client that bypasses the services. A typed
 * `prisma.calendarEntry.update` would exercise the Prisma client's own
 * validation on the way in; `$executeRawUnsafe` hands the statement to
 * PostgreSQL and lets the database answer.
 *
 * Every case is a MUTATION with a verdict. A guard that cannot be observed
 * failing certifies nothing.
 *
 * Fixture spacing: range overlap is a change of KIND, not of degree, so the
 * fixtures below are spaced by a whole teacher — each `freshTeacher()` gets a
 * calendar nobody else writes to — EXCEPT inside the exclusion describe, where
 * the tight spacing IS the test.
 */
const prisma = new PrismaClient();

const suffix = `entry-${Date.now()}`;
const teacherIds: string[] = [];
const accountIds: string[] = [];
let roomId: string;
let teacherSeq = 0;

async function freshTeacher(): Promise<string> {
  const tag = `t${teacherSeq++}`;
  const email = `${tag}-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Entry', lastName: tag, email, bio: 'calendar entry constraint fixture',
      pageSlug: `${tag}-${suffix}`, account: { create: { email } },
    },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return t.id;
}

beforeAll(async () => {
  await prisma.$connect();
  const roomOwner = await freshTeacher();
  const room = await prisma.room.create({
    data: {
      venueName: 'Entry Venue', address: `${suffix} Entry Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: roomOwner,
    },
  });
  roomId = room.id;
});

afterAll(async () => {
  // Entries first, and they take their children with them
  // (`Class_calendarEntryId_kind_fkey` / the `StudioClass` twin are
  // `ON DELETE CASCADE`). Must precede `teacherRoom.deleteMany`:
  // `Class_teacherRoomId_fkey` is `ON DELETE RESTRICT`, so a surviving class
  // blocks the room link's delete.
  const ids = teacherIds.map((_, i) => `$${i + 1}`).join(',');
  await prisma.$executeRawUnsafe(
    `DELETE FROM "CalendarEntry" WHERE "teacherId" IN (${ids})`, ...teacherIds,
  );
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.room.deleteMany({ where: { createdById: { in: teacherIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  // `Teacher.accountId` has no `onDelete: Cascade` (prisma/schema.prisma), so
  // the Account row each freshTeacher() created survives the teacher delete
  // above and must be removed separately, only after it — Account is what
  // Teacher.accountId references.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

const EXCL = 'CalendarEntry_teacher_slot_excl';

/** Asserts the DATABASE refused, and that it was THIS constraint that did. */
async function expectSlotRefusal(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toSatisfy((e: unknown) => isExclusionConflictOn(e, EXCL));
}

/**
 * A regular entry with its `Class` child, on a teacher of its own.
 *
 * Its own teacher, deliberately: every caller below mutates the entry's
 * schedule or its liveness, and a shared teacher would make those mutations
 * visible to each other through `CalendarEntry_teacher_slot_excl` — a slot
 * refusal where the case is about the freeze.
 */
async function regularEntryWithClass(): Promise<{ entryId: string; classId: string }> {
  const teacherId = await freshTeacher();
  const teacherRoom = await prisma.teacherRoom.create({
    // `capacityOverride` is required and has no default (prisma/schema.prisma).
    data: { teacherId, roomId, rentalRate: 20, capacityOverride: 12 },
  });
  const entryId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","createdAt","updatedAt")
     VALUES ($1,$2,'regular','Vinyasa','2027-10-01','09:00',75,now(),now())`,
    entryId, teacherId,
  );
  const classId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Class" (id,"calendarEntryId",kind,"teacherRoomId","roomCost","minRate","targetRate","minStudents","maxStudents","createdAt","updatedAt")
     VALUES ($1,$2,'regular',$3,35,15,25,4,12,now(),now())`,
    classId, entryId, teacherRoom.id,
  );
  return { entryId, classId };
}

/** The studio twin. No `teacherRoom`: `StudioClass` has never had one. */
async function studioEntryWithClass(): Promise<{ entryId: string; studioClassId: string }> {
  const teacherId = await freshTeacher();
  const entryId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","createdAt","updatedAt")
     VALUES ($1,$2,'studio','Vinyasa','2027-10-01','09:00',75,now(),now())`,
    entryId, teacherId,
  );
  const studioClassId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
     VALUES ($1,$2,'studio','Yoga Studio Centrum',35,now(),now())`,
    studioClassId, entryId,
  );
  return { entryId, studioClassId };
}

describe('CalendarEntry_teacher_slot_excl', () => {
  let teacherId: string;
  beforeEach(async () => { teacherId = await freshTeacher(); });

  const entry = (o: Partial<{ date: string; start: string; mins: number; cancelled: boolean }> = {}) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","cancelledAt","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','Vinyasa',$2::date,$3::time,$4,$5::timestamp,now(),now())`,
      teacherId, o.date ?? '2027-09-01', o.start ?? '19:00', o.mins ?? 90,
      o.cancelled ? new Date() : null,
    );

  it('refuses an entry overlapping the tail of another', async () => {
    await entry();                                   // 19:00-20:30
    await expectSlotRefusal(() => entry({ start: '19:30', mins: 60 }));
  });

  it('ALLOWS back-to-back — the half-open boundary', async () => {
    await entry();                                   // 19:00-20:30
    await expect(entry({ start: '20:30', mins: 60 })).resolves.toBeDefined();
  });

  it('refuses one minute before that boundary', async () => {
    await entry();                                   // 19:00-20:30
    await expectSlotRefusal(() => entry({ start: '20:29', mins: 60 }));
  });

  it('catches a collision ACROSS MIDNIGHT, which no per-date key could', async () => {
    await entry({ date: '2027-09-03', start: '23:30', mins: 60 });   // ends 00:30 on the 4th
    await expectSlotRefusal(() => entry({ date: '2027-09-04', start: '00:15', mins: 30 }));
  });

  it('a cancelled entry releases its slot', async () => {
    await entry({ cancelled: true });
    await expect(entry()).resolves.toBeDefined();
  });

  it('refuses un-cancelling back into an occupied slot', async () => {
    await entry({ cancelled: true });
    await entry();
    await expectSlotRefusal(() => prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "cancelledAt" = NULL WHERE "teacherId" = $1 AND "cancelledAt" IS NOT NULL`,
      teacherId,
    ));
  });

  it('refuses a DURATION edit that creates an overlap', async () => {
    await entry();                                   // 19:00-20:30
    await entry({ start: '21:00', mins: 30 });       // 21:00-21:30
    await expectSlotRefusal(() => prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "durationMinutes" = 150 WHERE "teacherId" = $1 AND "startTime" = '19:00'`,
      teacherId,
    ));
  });

  it('does not constrain a different teacher', async () => {
    await entry();
    const other = await freshTeacher();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','Vinyasa','2027-09-01','19:30',60,now(),now())`, other,
    )).resolves.toBeDefined();
  });
});

describe('disjoint occupancy — one entry, one child', () => {
  it('refuses a studio child on a regular entry (composite FK)', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'studio','Probe',50,now(),now())`, entryId,
    )).rejects.toThrow(/foreign key/i);
  });

  it('refuses forging the child kind to satisfy that FK (CHECK)', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','Probe',50,now(),now())`, entryId,
    )).rejects.toThrow(/check constraint/i);
  });

  // NOT /foreign key/i. Both composite FKs carry ON UPDATE CASCADE, so flipping
  // the parent's kind cascades into the child's kind column FIRST and the
  // child's own CHECK raises. The FK never gets a chance to reject anything.
  // Measured at stage A, on the twin structure over `ScheduleRule`
  // (`schedule-rule-constraints.test.ts`), where the parent design had
  // recorded 23503 and was corrected.
  it('refuses flipping the parent kind while a child is attached', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET kind = 'studio' WHERE id = $1`, entryId,
    )).rejects.toThrow(/check constraint/i);
  });
});

describe('the freeze: a trigger maintains the marker, the guard reads its own row', () => {
  it('sets classCompletedAt when the owning class completes', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    const [e] = await prisma.$queryRawUnsafe<Array<{ m: Date | null }>>(
      `SELECT "classCompletedAt" AS m FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.m).toBeInstanceOf(Date);
  });

  it('then refuses moving the date, the startTime, and the duration', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    for (const set of [`date='2027-12-01'`, `"startTime"='07:00'`, `"durationMinutes"=45`]) {
      await expect(prisma.$executeRawUnsafe(
        `UPDATE "CalendarEntry" SET ${set} WHERE id=$1`, entryId,
      )).rejects.toThrow(/frozen/i);
    }
  });

  it('freezes a CANCELLED regular entry without any marker', async () => {
    const { entryId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "CalendarEntry" SET "cancelledAt"=now() WHERE id=$1`, entryId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date='2027-12-01' WHERE id=$1`, entryId,
    )).rejects.toThrow(/frozen/i);
  });

  // The asymmetry, pinned. A studio cancellation is reversible and its
  // un-cancel path is live, so a cancelled studio entry must stay editable.
  it('does NOT freeze a cancelled STUDIO entry', async () => {
    const { entryId } = await studioEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "CalendarEntry" SET "cancelledAt"=now() WHERE id=$1`, entryId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date='2027-12-01' WHERE id=$1`, entryId,
    )).resolves.toBeDefined();
  });

  it('leaves a frozen entry editable on columns the guard does not name', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "classType"='Hatha' WHERE id=$1`, entryId,
    )).resolves.toBeDefined();
  });
});
