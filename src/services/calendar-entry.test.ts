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
  // Guarded because `beforeAll` can fail before it creates anyone: an empty
  // list builds `IN ()`, and that syntax error would surface here instead of
  // the failure actually worth reading.
  if (teacherIds.length > 0) {
    // Entries first, and they take their children with them
    // (`Class_calendarEntryId_kind_fkey` / the `StudioClass` twin are
    // `ON DELETE CASCADE`). Must precede `teacherRoom.deleteMany`:
    // `Class_teacherRoomId_fkey` is `ON DELETE RESTRICT`, so a surviving class
    // blocks the room link's delete.
    const ids = teacherIds.map((_, i) => `$${i + 1}`).join(',');
    await prisma.$executeRawUnsafe(
      `DELETE FROM "CalendarEntry" WHERE "teacherId" IN (${ids})`, ...teacherIds,
    );
    await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.room.deleteMany({ where: { createdById: { in: teacherIds } } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    // `Teacher.accountId` has no `onDelete: Cascade` (prisma/schema.prisma), so
    // the Account row each freshTeacher() created survives the teacher delete
    // above and must be removed separately, only after it — Account is what
    // Teacher.accountId references.
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
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
 *
 * `classStatus` is the status the `Class` row is INSERTED with, which is not
 * the same question as the status it ends up in: `class_sync_entry_completed`
 * hangs off both events since #327 and the two are pinned separately.
 */
async function regularEntryWithClass(
  classStatus: 'draft' | 'completed' = 'draft',
): Promise<{ entryId: string; classId: string }> {
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
    `INSERT INTO "Class" (id,"calendarEntryId",kind,"teacherRoomId","roomCost","minRate","targetRate","minStudents","maxStudents",status,"createdAt","updatedAt")
     VALUES ($1,$2,'regular',$3,35,15,25,4,12,$4::"ClassStatus",now(),now())`,
    classId, entryId, teacherRoom.id, classStatus,
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

  const entry = (
    o: Partial<{ date: string; start: string; mins: number; cancelled: boolean; kind: string }> = {},
  ) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","cancelledAt","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,$6::"ClassFamily",'Vinyasa',$2::date,$3::time,$4,$5::timestamp,now(),now())`,
      teacherId, o.date ?? '2027-09-01', o.start ?? '19:00', o.mins ?? 90,
      o.cancelled ? new Date() : null, o.kind ?? 'regular',
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

  // STUDIO entries, and that is not incidental: un-cancelling is a studio-only
  // move. `entry_terminal_liveness_guard` refuses it outright on a regular
  // entry, and would answer here with its own `23514` before the constraint
  // was ever consulted — a pass for the wrong reason.
  it('refuses un-cancelling back into an occupied slot', async () => {
    await entry({ cancelled: true, kind: 'studio' });
    await entry({ kind: 'studio' });
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

describe('CalendarEntry_duration_positive', () => {
  const withDuration = (teacherId: string, mins: number) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','Vinyasa','2027-11-01','09:00',$2,now(),now())`,
      teacherId, mins,
    );

  // Two probes, refused by DIFFERENT objects — which is the fact worth
  // pinning rather than asserting one error twice.
  //
  // Zero is the CHECK's own boundary and the CHECK answers it. A NEGATIVE
  // duration never reaches the CHECK at all: `span` is a STORED generated
  // column, so PostgreSQL computes it first, and `tsrange` refuses a lower
  // bound above its upper bound outright with 22000. Measured — the first
  // version of this case asserted the constraint name for both and failed on
  // the negative probe.
  //
  // Both probes are kept because only zero is at the boundary: relaxing the
  // CHECK to `>= 0` leaves a negative-only case green.
  it('refuses a non-positive duration', async () => {
    const teacherId = await freshTeacher();
    await expect(withDuration(teacherId, 0))
      .rejects.toThrow(/CalendarEntry_duration_positive/);
    await expect(withDuration(teacherId, -30))
      .rejects.toThrow(/range lower bound must be less than or equal to range upper bound/);
  });
});

describe('CalendarEntry_scheduleRuleId_date_key', () => {
  const onRule = (teacherId: string, scheduleRuleId: string, start: string, cancelled: boolean) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","scheduleRuleId","cancelledAt","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','Vinyasa','2027-11-08',$2::time,60,$3,$4::timestamp,now(),now())`,
      teacherId, start, scheduleRuleId, cancelled ? new Date() : null,
    );

  // The key is TOTAL, not partial on liveness, and that asymmetry against
  // `CalendarEntry_teacher_slot_excl` is the whole point: a cancelled entry
  // releases its SLOT (the describe above proves it) and goes on holding its
  // DATE, so the hourly sweep does not refill a date a teacher cancelled.
  it('a cancelled entry goes on holding its rule-date', async () => {
    const teacherId = await freshTeacher();
    const rule = await prisma.scheduleRule.create({
      data: {
        teacherId, kind: 'regular', classType: 'Vinyasa', dayOfWeek: 1,
        startTime: new Date('1970-01-01T09:00:00Z'), durationMinutes: 60,
      },
    });
    await onRule(teacherId, rule.id, '09:00', true);
    // A different start time, so the slot exclusion cannot be what refuses —
    // the cancelled entry released that slot. Only the (rule, date) key is
    // left to raise, which is what makes this case about the key.
    //
    // Asserted on the SQLSTATE and the key COLUMNS, not the index name:
    // Prisma surfaces only PostgreSQL's DETAIL line for a raw 23505, and that
    // line carries no constraint name. The columns are what say which unique
    // key answered.
    await expect(onRule(teacherId, rule.id, '14:00', false))
      .rejects.toThrow(/Code: `23505`[\s\S]*Key \("scheduleRuleId", date\)/);
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

/**
 * The refusal wording every case below matches on.
 *
 * Not `/frozen/i`. `isTerminalStatusViolation` (`src/lib/api-errors.ts`)
 * requires the literal clause `which is terminal` alongside SQLSTATE `23514`
 * before `classifyApiError` will answer 409 rather than 500, so the clause is
 * part of these guards' contract rather than prose — and matching on it is
 * what makes a reworded message fail here instead of surfacing as an
 * "Internal server error" to a caller.
 */
const TERMINAL_REFUSAL = /which is terminal/;

describe('the freeze: a trigger maintains the marker, the guard reads its own row', () => {
  it('sets classCompletedAt when the owning class completes', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    const [e] = await prisma.$queryRawUnsafe<Array<{ m: Date | null }>>(
      `SELECT "classCompletedAt" AS m FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.m).toBeInstanceOf(Date);
  });

  // The INSERT half of the same marker. `class_sync_entry_completed_guard` is
  // `AFTER UPDATE OF status`, so a raw
  // `INSERT INTO "Class" (…, status) VALUES (…, 'completed')` produced a
  // completed class with no marker at all — an entry whose schedule stayed
  // editable, which is the guarantee `waitlist-retention.ts` rests on before
  // it permanently deletes a class's queue.
  // `class_sync_entry_completed_insert_guard` is the second trigger on the
  // same function that closes it.
  it('sets classCompletedAt when a class is INSERTED already completed', async () => {
    const { entryId } = await regularEntryWithClass('completed');
    const [e] = await prisma.$queryRawUnsafe<Array<{ m: Date | null }>>(
      `SELECT "classCompletedAt" AS m FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.m).toBeInstanceOf(Date);
    // The marker is not the point on its own — the freeze it enables is.
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date='2027-12-01' WHERE id=$1`, entryId,
    )).rejects.toThrow(TERMINAL_REFUSAL);
  });

  it('then refuses moving the date, the startTime, and the duration', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    for (const set of [`date='2027-12-01'`, `"startTime"='07:00'`, `"durationMinutes"=45`]) {
      await expect(prisma.$executeRawUnsafe(
        `UPDATE "CalendarEntry" SET ${set} WHERE id=$1`, entryId,
      )).rejects.toThrow(TERMINAL_REFUSAL);
    }
  });

  // The other half of the guard's decision, and the half a trigger cannot
  // state: `BEFORE UPDATE OF date, …` fires on a column's presence in the SET
  // list, not on its value changing. Without the early return the guard
  // refuses a writer that carries the unchanged date alongside a column it
  // does mean to change — and tells it "cannot change its date, start time or
  // duration" about a statement changing none of them.
  //
  // All three columns at their current values in one statement, so a
  // reintroduced defect on any one of them lands here.
  it('allows a write that repeats a frozen entry\'s own schedule alongside another column', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry"
          SET date='2027-10-01'::date, "startTime"='09:00'::time, "durationMinutes"=75,
              "classType"='Unchanged schedule'
        WHERE id=$1`, entryId,
    )).resolves.toBeDefined();
    const [e] = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
      `SELECT "classType" AS t FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.t).toBe('Unchanged schedule');
  });

  it('freezes a CANCELLED regular entry without any marker', async () => {
    const { entryId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "CalendarEntry" SET "cancelledAt"=now() WHERE id=$1`, entryId);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date='2027-12-01' WHERE id=$1`, entryId,
    )).rejects.toThrow(TERMINAL_REFUSAL);
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

/**
 * Liveness on a terminal REGULAR entry, which is a different column list from
 * the freeze above and therefore a different trigger.
 *
 * One predicate used to cover all of this: before #327 cancellation was a
 * `ClassStatus` and `class_reject_terminal_status_change` refused a status
 * change on `OLD.status IN ('completed','cancelled')`. Both of its arms landed
 * on a column no trigger guarded once liveness moved to the entry — a
 * cancelled class could be un-cancelled, and a completed one could be
 * cancelled, leaving its `Payment` rows attached to a class the app then
 * renders as cancelled.
 *
 * The `kind` conjunct is the same asymmetry the freeze guard carries:
 * cancelling a `StudioClass` is reversible and `PUT /api/studio-classes/[id]`
 * is a live door onto it, so a studio entry's liveness stays writable in both
 * directions.
 */
describe('entry_terminal_liveness_guard', () => {
  const setCancelled = (entryId: string, value: string) =>
    prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "cancelledAt"=${value} WHERE id=$1`, entryId,
    );

  it('refuses un-cancelling a cancelled regular entry', async () => {
    const { entryId } = await regularEntryWithClass();
    await setCancelled(entryId, 'now()');
    await expect(setCancelled(entryId, 'NULL')).rejects.toThrow(TERMINAL_REFUSAL);
  });

  it('refuses cancelling a COMPLETED regular class', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    await expect(setCancelled(entryId, 'now()')).rejects.toThrow(TERMINAL_REFUSAL);
  });

  // The pass-cases, without which a predicate mutated to refuse every write to
  // the column would still satisfy both cases above. Cancelling a live class
  // is the whole of `POST /api/classes/[id]/cancel`.
  it('allows cancelling a live regular entry', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(setCancelled(entryId, 'now()')).resolves.toBeDefined();
  });

  // The actual-change half, which `BEFORE UPDATE OF "cancelledAt"` cannot
  // state on its own — it fires on the column's presence in the SET list. A
  // writer re-asserting the value it already holds is not a liveness change.
  it('allows a write that repeats a cancelled regular entry\'s own cancelledAt', async () => {
    const { entryId } = await regularEntryWithClass();
    await setCancelled(entryId, 'now()');
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" e SET "cancelledAt"=e."cancelledAt", "classType"='Re-asserted' WHERE id=$1`,
      entryId,
    )).resolves.toBeDefined();
  });

  // The live studio path this guard sits directly beside: the same statement
  // `PUT /api/studio-classes/[id]` issues when a teacher un-cancels.
  it('lets a cancelled STUDIO entry be un-cancelled', async () => {
    const { entryId } = await studioEntryWithClass();
    await setCancelled(entryId, 'now()');
    await expect(setCancelled(entryId, 'NULL')).resolves.toBeDefined();
    const [e] = await prisma.$queryRawUnsafe<Array<{ c: Date | null }>>(
      `SELECT "cancelledAt" AS c FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.c).toBeNull();
  });
});
