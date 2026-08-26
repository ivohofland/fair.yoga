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

  // THE SHAPE OF THE KEY, not only that it fires. Both inserts above share a
  // date, so a key mutated down to `UNIQUE ("scheduleRuleId")` refuses them
  // exactly the same way — and a template would then get ONE class ever
  // instead of one per week, which is the whole rolling window. This is the
  // case that goes red for that mutation.
  //
  // `08:00`, clear of the 09:00 row's own hour, so the slot exclusion cannot
  // be what admits it: the point is that the DATE is what differs.
  it('lets one rule hold a second date', async () => {
    const teacherId = await freshTeacher();
    const rule = await prisma.scheduleRule.create({
      data: {
        teacherId, kind: 'regular', classType: 'Vinyasa', dayOfWeek: 1,
        startTime: new Date('1970-01-01T09:00:00Z'), durationMinutes: 60,
      },
    });
    await onRule(teacherId, rule.id, '09:00', false);
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","scheduleRuleId","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','Vinyasa','2027-11-15','08:00',60,$2,now(),now())`,
      teacherId, rule.id,
    )).resolves.toBeDefined();
  });
});

describe('disjoint occupancy — one entry, one child', () => {
  /**
   * EVERY REFUSAL BELOW NAMES ITS OBJECT, and three of them used to match on
   * the object's CLASS instead — `/foreign key/i`, `/check constraint/i`. Those
   * cannot tell `Class_kind_check` from `StudioClass_kind_check`, nor either
   * from `CalendarEntry_duration_positive` next door, so a fixture that started
   * tripping a different constraint of the same class would keep passing while
   * testing something else. The exclusion cases above already name theirs via
   * `isExclusionConflictOn`; this brings the rest into line.
   *
   * The two `@unique` keys are the exception and the reason is PostgreSQL's,
   * not a preference: Prisma surfaces only the DETAIL line for a raw `23505`
   * and that line carries no constraint name. The SQLSTATE and the key COLUMNS
   * are what identify it, the same way `CalendarEntry_scheduleRuleId_date_key`
   * is pinned above.
   */
  it('refuses a studio child on a regular entry (composite FK)', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'studio','Probe',50,now(),now())`, entryId,
    )).rejects.toThrow(/StudioClass_calendarEntryId_kind_fkey/);
  });

  it('refuses forging the child kind to satisfy that FK (CHECK)', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular','Probe',50,now(),now())`, entryId,
    )).rejects.toThrow(/StudioClass_kind_check/);
  });

  // NOT the FK, and now the assertion says so by name. Both composite FKs carry
  // ON UPDATE CASCADE, so flipping the parent's kind cascades into the CHILD's
  // kind column first and `Class_kind_check` — the child's own — raises. The FK
  // never gets a chance to reject anything. Measured at stage A on the twin
  // structure over `ScheduleRule` (`schedule-rule-constraints.test.ts`), where
  // the parent design had recorded 23503 and was corrected; matching on
  // `/check constraint/i` could not have shown which of the two tables answered.
  it('refuses flipping the parent kind while a child is attached', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET kind = 'studio' WHERE id = $1`, entryId,
    )).rejects.toThrow(/Class_kind_check/);
  });

  /**
   * ONE CHILD, which is the half of "one entry, one child" that had no case at
   * all. Everything above pins DISJOINTNESS — that the wrong FAMILY's child
   * cannot attach. Nothing inserted a second child of the RIGHT family, so
   * dropping `@unique` from either `calendarEntryId` left the whole suite
   * green — while `prisma/seed.ts` cites the constraint as its licence to write
   * `created.classes[0]!`, and `schema.prisma` says of both relations that
   * "Runtime cardinality is still 0-or-1, enforced by that single-column
   * constraint".
   *
   * Raw SQL, like everything else here: `prisma.class.create` would be refused
   * by the client's own relation typing before PostgreSQL saw it, which is the
   * layer these cases exist to bypass.
   */
  it('refuses a second Class on one entry', async () => {
    const { entryId } = await regularEntryWithClass();
    const teacherRoom = await prisma.teacherRoom.findFirstOrThrow({
      where: { classes: { some: { calendarEntryId: entryId } } },
      select: { id: true },
    });
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "Class" (id,"calendarEntryId",kind,"teacherRoomId","roomCost","minRate","targetRate","minStudents","maxStudents",status,"createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'regular',$2,35,15,25,4,12,'draft',now(),now())`,
      entryId, teacherRoom.id,
    )).rejects.toThrow(/Code: `23505`[\s\S]*Key \("calendarEntryId"\)/);
  });

  it('refuses a second StudioClass on one entry', async () => {
    const { entryId } = await studioEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO "StudioClass" (id,"calendarEntryId",kind,location,"hourlyRate","createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,'studio','Second',50,now(),now())`, entryId,
    )).rejects.toThrow(/Code: `23505`[\s\S]*Key \("calendarEntryId"\)/);
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

/**
 * The completion marker is write-once, which is what makes the freeze above
 * hold across TWO statements rather than only within one.
 *
 * `entry_frozen_schedule_guard` is `BEFORE UPDATE OF date, "startTime",
 * "durationMinutes"` and reads `OLD."classCompletedAt"`. `UPDATE OF` fires on
 * a column's PRESENCE IN THE SET LIST, so
 * `UPDATE "CalendarEntry" SET "classCompletedAt" = NULL` fired nothing, and the
 * next statement's `OLD` then read NULL and the date moved. Measured before
 * `20260826182710_entry_completion_marker_guard`: the two statements below
 * left the row dated 2027-12-01. Measured after: 2027-10-01.
 *
 * Why that mattered enough to spend a migration on. `waitlist-retention.ts`
 * permanently DELETES a terminal class's unfulfilled queue rows once the class
 * is more than 365 days past its date, and it says so on the premise that the
 * date is immovable from every client. The symmetric hole on `cancelledAt` was
 * closed by `20260826140000_entry_guard_restorations`; this was the arm left
 * open beside it.
 *
 * Not raw-SQL-only, unlike most of this file's threat model:
 * `classCompletedAt` is a plain nullable `DateTime` in the generated client,
 * so `prisma.calendarEntry.update({ data: { classCompletedAt: null } })`
 * type-checks. That call is what the fixture in `src/lib/api-errors.test.ts`
 * was transcribed from.
 */
describe('entry_completion_marker_guard', () => {
  const setMarker = (entryId: string, value: string) =>
    prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "classCompletedAt"=${value} WHERE id=$1`, entryId,
    );

  /** Completes the class, so the sync trigger stamps the marker. */
  async function completedEntry(): Promise<string> {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(`UPDATE "Class" SET status='completed' WHERE id=$1`, classId);
    return entryId;
  }

  it('refuses clearing the marker', async () => {
    const entryId = await completedEntry();
    await expect(setMarker(entryId, 'NULL')).rejects.toThrow(TERMINAL_REFUSAL);
  });

  it('refuses moving the marker to a different timestamp', async () => {
    const entryId = await completedEntry();
    await expect(setMarker(entryId, `'2020-01-01 00:00:00'`)).rejects.toThrow(TERMINAL_REFUSAL);
  });

  // The whole point of the guard, as the attack rather than as a predicate:
  // without it these two statements together move a frozen entry's date, and
  // neither of them on its own looks like a schedule write.
  it('leaves the freeze standing across the two-statement attempt', async () => {
    const entryId = await completedEntry();
    await expect(setMarker(entryId, 'NULL')).rejects.toThrow(TERMINAL_REFUSAL);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET date='2027-12-01' WHERE id=$1`, entryId,
    )).rejects.toThrow(TERMINAL_REFUSAL);
    const [e] = await prisma.$queryRawUnsafe<Array<{ d: Date }>>(
      `SELECT date AS d FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.d.toISOString().slice(0, 10)).toBe('2027-10-01');
  });

  // The pass-cases, without which a predicate mutated to refuse every write to
  // the column would still satisfy all three cases above.
  it('allows the first stamp — which is the sync trigger\'s own write', async () => {
    const { entryId } = await regularEntryWithClass();
    await expect(setMarker(entryId, 'now()')).resolves.toBeDefined();
  });

  // The actual-change half, which `BEFORE UPDATE OF "classCompletedAt"` cannot
  // state on its own: it fires on the column's presence in the SET list.
  it('allows a write that repeats a completed entry\'s own marker', async () => {
    const entryId = await completedEntry();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" e
          SET "classCompletedAt"=e."classCompletedAt", "classType"='Re-asserted'
        WHERE id=$1`, entryId,
    )).resolves.toBeDefined();
  });

  // A studio entry never carries a marker (only a `Class` has a `status`), so
  // this guard needs no `kind` conjunct — its `OLD IS NOT NULL` scopes it to
  // the regular family for free, unlike its two siblings whose asymmetry is
  // real. What refuses the studio write is the CHECK next door, and the
  // difference in WHICH object answers is the point: this guard would have let
  // the stamp through.
  it('does not stand in the way of a studio entry — the CHECK is what refuses', async () => {
    const { entryId } = await studioEntryWithClass();
    await expect(setMarker(entryId, 'now()'))
      .rejects.toThrow(/CalendarEntry_completion_marker_regular_only/);
  });
});

/**
 * The two static CHECKs on the completion marker
 * (`20260826200000_entry_marker_exclusivity`).
 *
 * WHY THEY ARE NOT TRIGGERS, and why the trigger next door is not enough.
 * `entry_completion_marker_guard` is `BEFORE UPDATE OF "classCompletedAt"`
 * with `IF OLD."classCompletedAt" IS NOT NULL THEN RAISE`, so it enforces
 * MONOTONICITY, not authorship: `NULL -> NOT NULL` passes for every client, and
 * an INSERT carrying a marker is not an UPDATE and fires nothing at all.
 * `schema.prisma` says the column is "Written ONLY by
 * `class_sync_entry_completed`" and that "THAT IS ENFORCED, not conventional",
 * and before these two constraints it was neither.
 *
 * Every case below is a MUTATION with a verdict, and each pass-case is what
 * stops a constraint mutated to refuse everything from satisfying the
 * refusals.
 *
 * These raise a PLAIN `23514` with no `USING ERRCODE` override and no
 * `which is terminal` clause, deliberately — they are not terminality guards
 * and `classifyApiError` must not read them as one. `api-errors.test.ts`'s
 * contract sweep is scoped to `RAISE EXCEPTION ... USING ERRCODE = '23514'`
 * and so does not see them, which is correct: nothing reaches these from a
 * route, because no writer in `src/` sets `classCompletedAt` at all.
 */
describe('the completion marker CHECKs', () => {
  /** Both raise a plain check violation, so the name is what says which. */
  const REGULAR_ONLY = /CalendarEntry_completion_marker_regular_only/;
  const NOT_BOTH = /CalendarEntry_not_cancelled_and_completed/;

  const insertEntry = (
    teacherId: string,
    kind: 'regular' | 'studio',
    columns: string,
    values: string,
  ) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "CalendarEntry" (id,"teacherId",kind,"classType",date,"startTime","durationMinutes","createdAt","updatedAt"${columns})
       VALUES (gen_random_uuid()::text,$1,'${kind}','Vinyasa','2027-10-01','09:00',75,now(),now()${values})`,
      teacherId,
    );

  // THE INSERT EVENT, which the trigger structurally cannot reach: it is
  // `BEFORE UPDATE OF`, and a row born with a marker never fires it.
  it('refuses a studio entry INSERTED with a marker', async () => {
    const teacherId = await freshTeacher();
    await expect(
      insertEntry(teacherId, 'studio', ',"classCompletedAt"', ",now()"),
    ).rejects.toThrow(REGULAR_ONLY);
  });

  it('admits a regular entry INSERTED with a marker — the writer this scopes to', async () => {
    const teacherId = await freshTeacher();
    await expect(
      insertEntry(teacherId, 'regular', ',"classCompletedAt"', ",now()"),
    ).resolves.toBeDefined();
  });

  // The `kind` flip, which no trigger on `classCompletedAt` sees at all: the
  // marker column is not in the SET list, so `BEFORE UPDATE OF
  // "classCompletedAt"` does not fire.
  it('refuses turning a marked regular entry into a studio one', async () => {
    const teacherId = await freshTeacher();
    await insertEntry(teacherId, 'regular', ',"classCompletedAt"', ",now()");
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET kind='studio' WHERE "teacherId" = $1`, teacherId,
    )).rejects.toThrow(REGULAR_ONLY);
  });

  it('refuses an entry INSERTED both cancelled and completed', async () => {
    const teacherId = await freshTeacher();
    await expect(
      insertEntry(teacherId, 'regular', ',"classCompletedAt","cancelledAt"', ",now(),now()"),
    ).rejects.toThrow(NOT_BOTH);
  });

  it('admits either marker alone', async () => {
    const withMarker = await freshTeacher();
    await expect(
      insertEntry(withMarker, 'regular', ',"classCompletedAt"', ",now()"),
    ).resolves.toBeDefined();
    const withCancel = await freshTeacher();
    await expect(
      insertEntry(withCancel, 'regular', ',"cancelledAt"', ",now()"),
    ).resolves.toBeDefined();
  });

  /**
   * P17, RETIRED — the state `class-lifecycle.ts` carried as known-open.
   *
   * `class_reject_terminal_status_change` refuses only a class LEAVING
   * `completed`, and cancellation stopped being a `ClassStatus` with #327, so
   * nothing refused raw SQL walking a cancelled class up to `completed`. It
   * still does not: the `UPDATE "Class"` is unguarded. What refuses is
   * `class_sync_entry_completed`'s OWN `UPDATE "CalendarEntry"`, which violates
   * the CHECK and aborts the completing transaction — the refusal lands on the
   * statement that reached for the state.
   *
   * The row is re-read afterwards because "the statement threw" and "the state
   * did not happen" are different claims, and only the second is the one this
   * constraint exists to make.
   */
  it('refuses completing a CANCELLED class, which the status guard cannot see', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await prisma.$executeRawUnsafe(
      `UPDATE "CalendarEntry" SET "cancelledAt"=now() WHERE id=$1`, entryId,
    );

    await expect(prisma.$executeRawUnsafe(
      `UPDATE "Class" SET status='completed' WHERE id=$1`, classId,
    )).rejects.toThrow(NOT_BOTH);

    const [row] = await prisma.$queryRawUnsafe<Array<{ s: string; m: Date | null }>>(
      `SELECT c.status::text AS s, e."classCompletedAt" AS m
         FROM "Class" c JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
        WHERE c.id = $1`, classId);
    expect(row?.s).toBe('draft');
    expect(row?.m).toBeNull();
  });

  // The pass-case for the same path: an UNcancelled class completes, the sync
  // trigger stamps, and the CHECK stands aside. Without this a constraint
  // mutated to refuse every completion would satisfy the case above.
  it('leaves an uncancelled completion alone', async () => {
    const { entryId, classId } = await regularEntryWithClass();
    await expect(prisma.$executeRawUnsafe(
      `UPDATE "Class" SET status='completed' WHERE id=$1`, classId,
    )).resolves.toBeDefined();
    const [e] = await prisma.$queryRawUnsafe<Array<{ m: Date | null }>>(
      `SELECT "classCompletedAt" AS m FROM "CalendarEntry" WHERE id=$1`, entryId);
    expect(e?.m).toBeInstanceOf(Date);
  });
});
