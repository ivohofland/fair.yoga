import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';

const prisma = new PrismaClient();
const suffix = `slot-${Date.now()}`;
let teacherId: string;
let otherTeacherId: string;
const accountIds: string[] = [];

async function makeTeacher(tag: string): Promise<string> {
  const email = `${tag}-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Slot', lastName: tag, email, bio: 'slot constraint fixture',
      pageSlug: `${tag}-${suffix}`, account: { create: { email } },
    },
  });
  accountIds.push(t.accountId);
  return t.id;
}

let roomId: string;
let teacherRoomId: string;

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner');
  otherTeacherId = await makeTeacher('other');
  const room = await prisma.room.create({
    data: {
      venueName: 'Slot Venue', address: `${suffix} Slot Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    // `capacityOverride` is required and has no default (schema.prisma).
    data: { teacherId, roomId, rentalRate: 20, capacityOverride: 12 },
  });
  teacherRoomId = teacherRoom.id;
});

afterAll(async () => {
  const teachers = [teacherId, otherTeacherId];
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teachers } } });
  // Deletes both `ClassTemplate` and `StudioClassTemplate` rows via
  // `onDelete: Cascade` on their composite FK to `ScheduleRule` — neither
  // child carries `teacherId` any more (prisma/schema.prisma). Must precede
  // `teacherRoom.deleteMany`: `ClassTemplate_teacherRoomId_fkey` is
  // `ON DELETE RESTRICT`, and a surviving template blocks the room delete.
  await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.room.deleteMany({ where: { createdById: { in: teachers } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teachers } } });
  // `Teacher.accountId` has no `onDelete: Cascade` (prisma/schema.prisma),
  // so the Account row each makeTeacher() created survives the teacher
  // delete above and must be removed separately, only after it — Account
  // is what Teacher.accountId references.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

const EXCL = 'ScheduleRule_teacher_slot_excl';
const at = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

const rule = (teacher: string, over: Record<string, unknown> = {}) => ({
  teacherId: teacher, kind: 'regular' as const, classType: 'Yoga',
  dayOfWeek: 1, startTime: at('19:00'), durationMinutes: 90, ...over,
});

/** Asserts the DATABASE refused, and that it was THIS constraint that did. */
async function expectSlotRefusal(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toSatisfy((e: unknown) => isExclusionConflictOn(e, EXCL));
}

/**
 * These assert the DATABASE rejects the write, not a route-level 409 — with
 * the exclusion constraint absent these would still pass on a sequential
 * retry and fail only under a race, which is the case that motivated #196.
 *
 * The assertions name the exclusion constraint by NAME (`isExclusionConflictOn`)
 * rather than by `meta.target`, because a 23P01 exclusion violation carries no
 * `meta.target`: `code` and `meta` are both `undefined` on the Prisma error
 * (`src/lib/exclusion-conflict.ts`), which is the whole reason that matcher
 * exists rather than reusing `isUniqueConflictOn`.
 *
 * LOAD-BEARING PROPERTY THIS WHOLE DESCRIBE DEPENDS ON:
 * `ScheduleRule_teacher_slot_excl` keys on `(teacherId, dayOfWeek, slot)` only
 * — `kind` is not part of it (the migration's `EXCLUDE USING gist` clause,
 * `prisma/migrations/20260825061213_schedule_rule/migration.sql`). That is
 * why most cases below mix `regular` and `studio` freely rather than writing
 * a same-family and a cross-family variant of each: with `kind` absent from
 * the key, a same-family collision and a cross-family one compile to
 * byte-identical SQL against this constraint, so one case proves both. If
 * `kind` is ever added to the constraint's key, every case here that relies
 * on that stand-in — this file's own comment beside the unarchive/move cases
 * below names which — needs its same-family twin written back in.
 */
describe('ScheduleRule slot exclusion', () => {
  it('refuses an overlapping rule in the other family', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId) });
    await expectSlotRefusal(() => prisma.scheduleRule.create({
      data: rule(teacherId, { kind: 'studio', startTime: at('19:30'), durationMinutes: 60 }),
    }));
  });

  it('refuses a same-start rule in the other family', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 2 }) });
    await expectSlotRefusal(() => prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 2, kind: 'studio', durationMinutes: 60 }),
    }));
  });

  it('allows a rule starting exactly when the first ends', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 3 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 3, kind: 'studio', startTime: at('20:30'), durationMinutes: 60 }),
    })).resolves.toBeDefined();
  });

  it('allows the same slot on a different weekday', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 4 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 5, startTime: at('19:30') }),
    })).resolves.toBeDefined();
  });

  it('lets an ARCHIVED rule sit on an occupied slot — archiving frees it', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 6 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 6, isArchived: true, archivedAt: new Date(), startTime: at('19:30') }),
    })).resolves.toBeDefined();
  });

  it('does NOT free the slot when a rule is merely PAUSED', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 0, isActive: false }) });
    await expectSlotRefusal(() => prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 0, startTime: at('19:30') }),
    }));
  });

  it('does not block another teacher', async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 2, startTime: at('07:00') }) });
    await expect(prisma.scheduleRule.create({
      data: rule(otherTeacherId, { dayOfWeek: 2, startTime: at('07:30') }),
    })).resolves.toBeDefined();
  });

  it('does NOT catch a rule spilling past midnight into the next weekday', async () => {
    // A deliberate blind spot, pinned so it is recorded rather than discovered.
    // A (dayOfWeek, slot) key cannot see Monday 23:30+60 reaching Tuesday
    // 00:30; the ENTRY-level constraint catches it when the two rules
    // generate. Design doc §4.4, "What this does not reach".
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 3, startTime: at('23:30'), durationMinutes: 60 }) });
    await expect(prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 4, startTime: at('00:15'), durationMinutes: 30 }),
    })).resolves.toBeDefined();
  });

  // Ported from slot-constraints.test.ts (issue 298): the cases above only
  // ever exercise the constraint via CREATE. None of them prove it also
  // fires on UPDATE — unarchiving a rule, or moving its dayOfWeek/startTime,
  // into a slot another live rule already holds. A single rule-vs-rule case
  // stands in for what the old trigger-based tests had to write once per
  // template family — this describe's own docblock above names the property
  // that makes that stand-in valid.
  it('refuses unarchiving a rule into an occupied slot', async () => {
    const archived = await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 1, startTime: at('05:00'), isArchived: true, archivedAt: new Date() }),
    });
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 1, startTime: at('05:00') }) });
    await expectSlotRefusal(() => prisma.scheduleRule.update({
      where: { id: archived.id },
      data: { isArchived: false },
    }));
  });

  it("refuses moving a rule's dayOfWeek into an occupied slot", async () => {
    await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 2, startTime: at('05:00') }) });
    const mover = await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 3, startTime: at('05:00') }),
    });
    await expectSlotRefusal(() => prisma.scheduleRule.update({
      where: { id: mover.id },
      data: { dayOfWeek: 2 },
    }));
  });

  it("refuses moving a rule's startTime into an occupied slot", async () => {
    await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 4, startTime: at('05:00'), durationMinutes: 30 }),
    });
    const mover = await prisma.scheduleRule.create({
      data: rule(teacherId, { dayOfWeek: 4, startTime: at('05:30'), durationMinutes: 30 }),
    });
    await expectSlotRefusal(() => prisma.scheduleRule.update({
      where: { id: mover.id },
      data: { startTime: at('05:15') },
    }));
  });
});

describe('ScheduleRule composite foreign key', () => {
  it('refuses a studio template on a regular rule', async () => {
    const r = await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 5, startTime: at('06:00') }) });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "StudioClassTemplate" ("id","scheduleRuleId","kind","location","hourlyRate","createdAt","updatedAt")
         VALUES (gen_random_uuid()::text, $1, 'studio', 'Probe', 40, now(), now())`,
        r.id,
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it('refuses flipping a rule kind while a child is attached', async () => {
    // startTime '08:00', not '06:30': the previous case's rule occupies
    // dayOfWeek 5 06:00-07:30 (default durationMinutes: 90), and 06:30 would
    // overlap it under ScheduleRule_teacher_slot_excl.
    const r = await prisma.scheduleRule.create({ data: rule(teacherId, { dayOfWeek: 5, startTime: at('08:00') }) });
    // teacherRoomId is required on ClassTemplate and does NOT move to the rule.
    await prisma.classTemplate.create({
      data: {
        scheduleRuleId: r.id, kind: 'regular', teacherRoomId,
        roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
      },
    });
    // Not /foreign key/i: both composite FKs carry ON UPDATE CASCADE (the
    // migration's block 3, matching Prisma's own convention), so flipping the
    // parent's kind cascades into the attached child's own kind column FIRST
    // — and it is that child's `ClassTemplate_kind_check` CHECK, not the FK
    // itself, that raises. Measured, not assumed: the FK never gets a chance
    // to reject anything here because the cascade already satisfies it.
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "ScheduleRule" SET "kind"='studio' WHERE "id"=$1`, r.id),
    ).rejects.toThrow(/check constraint/i);
  });
});
