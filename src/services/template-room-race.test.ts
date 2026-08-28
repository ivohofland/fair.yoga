import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { isCheckViolationOn } from '@/lib/check-violation';

/** Two clients, because one connection cannot hold a transaction open for another. */
const a = new PrismaClient();
const b = new PrismaClient();
const suffix = `race-${Date.now()}`;
let teacherId: string;
let accountId: string;
let teacherRoomId: string;
let ruleId: string;

beforeAll(async () => {
  await Promise.all([a.$connect(), b.$connect()]);
  const email = `race-${suffix}@test.local`;
  const t = await a.teacher.create({
    data: {
      firstName: 'Race', lastName: 'Fixture', email, bio: 'race fixture',
      pageSlug: `race-${suffix}`, account: { create: { email } },
    },
  });
  teacherId = t.id; accountId = t.accountId;
  const room = await a.room.create({
    data: {
      venueName: 'Race Venue', address: `${suffix} Race Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  const link = await a.teacherRoom.create({
    data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
  });
  teacherRoomId = link.id;
  // A PAUSED template on an OPEN room — the state door 3's race starts from.
  const rule = await a.scheduleRule.create({
    data: {
      teacherId, kind: 'regular', classType: 'Yoga', dayOfWeek: 4,
      startTime: new Date('1970-01-01T19:00:00Z'), durationMinutes: 90, isActive: false,
    },
  });
  ruleId = rule.id;
  await a.classTemplate.create({
    data: {
      scheduleRuleId: rule.id, kind: 'regular', teacherRoomId,
      ruleLive: false, roomArchived: false,
      roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
    },
  });
});

afterAll(async () => {
  await a.scheduleRule.deleteMany({ where: { teacherId } });
  await a.teacherRoom.deleteMany({ where: { teacherId } });
  await a.room.deleteMany({ where: { createdById: teacherId } });
  await a.teacher.deleteMany({ where: { id: teacherId } });
  await a.account.deleteMany({ where: { id: accountId } });
  await Promise.all([a.$disconnect(), b.$disconnect()]);
});

describe('the room archive that used to slip past door 3', () => {
  it('refuses the archive that commits while a resume is in flight', async () => {
    let archiveError: unknown;
    let archiveSettledAt = 0;
    let resumeCommittedAt = 0;

    // A: resume the template, then hold the transaction open.
    const resume = a.$transaction(async (tx) => {
      await tx.scheduleRule.update({ where: { id: ruleId }, data: { isActive: true } });
      await new Promise((r) => setTimeout(r, 1500));
    }).then(() => { resumeCommittedAt = Date.now(); });

    // B: archive the room from the other connection, mid-flight.
    await new Promise((r) => setTimeout(r, 500));
    const archive = b.teacherRoom
      .update({ where: { id: teacherRoomId }, data: { isArchived: true } })
      .catch((e: unknown) => { archiveError = e; })
      .finally(() => { archiveSettledAt = Date.now(); });

    await Promise.all([resume, archive]);

    // The archive was refused...
    expect(archiveError).toBeDefined();
    // The matcher, not a substring of the stringified error: `toContain` here
    // asserted neither the SQLSTATE nor that Postgres was the one naming the
    // constraint, which is the whole discrimination `isCheckViolationOn` makes.
    expect(isCheckViolationOn(archiveError, 'ClassTemplate_live_needs_open_room')).toBe(true);
    // ...and it WAITED for the resume rather than racing past it. Without the
    // wait this assertion is what fails, and the wait is the whole property:
    // a check that merely read the room would have passed and then been wrong.
    expect(archiveSettledAt).toBeGreaterThanOrEqual(resumeCommittedAt);

    // The resume stands; the room is still open.
    const room = await a.teacherRoom.findUniqueOrThrow({ where: { id: teacherRoomId } });
    expect(room.isArchived).toBe(false);
    const rule = await a.scheduleRule.findUniqueOrThrow({ where: { id: ruleId } });
    expect(rule.isActive).toBe(true);
  }, 20_000);
});