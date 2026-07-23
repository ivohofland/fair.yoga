import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { getNextOccurrences, generateClassInstances } from './class-generator';

// ===========================================================================
// Pure logic tests — getNextOccurrences
// ===========================================================================

describe('getNextOccurrences', () => {
  it('returns 4 dates for dayOfWeek=1 (Tuesday) starting from Monday 2026-04-06', () => {
    // Monday 2026-04-06, looking for Tuesdays (dayOfWeek=1 in schema)
    const from = new Date('2026-04-06T00:00:00.000Z');
    const dates = getNextOccurrences(1, from, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]!.toISOString()).toBe('2026-04-07T00:00:00.000Z');
    expect(dates[1]!.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(dates[2]!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
    expect(dates[3]!.toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });

  it('includes today if today matches the day (Tuesday 2026-04-07, dayOfWeek=1)', () => {
    // Tuesday 2026-04-07, looking for Tuesdays (dayOfWeek=1 in schema)
    const from = new Date('2026-04-07T00:00:00.000Z');
    const dates = getNextOccurrences(1, from, 4);

    expect(dates).toHaveLength(4);
    expect(dates[0]!.toISOString()).toBe('2026-04-07T00:00:00.000Z');
    expect(dates[1]!.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(dates[2]!.toISOString()).toBe('2026-04-21T00:00:00.000Z');
    expect(dates[3]!.toISOString()).toBe('2026-04-28T00:00:00.000Z');
  });
});

// ===========================================================================
// Integration tests — generateClassInstances
// ===========================================================================

const prisma = new PrismaClient();
const uniqueSuffix = `gen-${Date.now()}`;

describe('generateClassInstances (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let templateId: string;
  /** IDs of other active templates deactivated during setup, restored in teardown. */
  let deactivatedTemplateIds: string[] = [];

  beforeAll(async () => {
    // Deactivate any pre-existing active templates so they don't interfere
    const existingActive = await prisma.classTemplate.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    deactivatedTemplateIds = existingActive.map((t) => t.id);
    if (deactivatedTemplateIds.length > 0) {
      await prisma.classTemplate.updateMany({
        where: { id: { in: deactivatedTemplateIds } },
        data: { isActive: false },
      });
    }

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Generator',
        lastName: 'Teacher',
        email: `generator-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `generator-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for generator tests',
        pageSlug: `generator-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Generator Studio',
        address: `${uniqueSuffix} Generator St`,
        city: 'Amsterdam',
        postcode: '1234GN',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId,
        capacityOverride: 15,
        rentalRate: 40,
      },
    });
    teacherRoomId = teacherRoom.id;

    const template = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Vinyasa',
        description: 'Tuesday morning flow',
        dayOfWeek: 1, // Tuesday in schema convention
        startTime: '09:00',
        durationMinutes: 75,
        roomCost: 40,
        minRate: 15,
        targetRate: 30,
        minStudents: 4,
        maxStudents: 12,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        isActive: true,
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    // Clean up in dependency order
    await prisma.class.deleteMany({ where: { templateId } });
    await prisma.classTemplate.delete({ where: { id: templateId } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });

    // Restore previously active templates
    if (deactivatedTemplateIds.length > 0) {
      await prisma.classTemplate.updateMany({
        where: { id: { in: deactivatedTemplateIds } },
        data: { isActive: true },
      });
    }

    await prisma.$disconnect();
  });

  it('generates 4 class instances from a template', async () => {
    // Use Monday 2026-04-06 as the starting date
    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(4);

    const classes = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });

    expect(classes).toHaveLength(4);

    for (const cls of classes) {
      expect(cls.classType).toBe('Vinyasa');
      expect(cls.status).toBe('open');
      expect(Number(cls.roomCost)).toBe(40);
      expect(Number(cls.minRate)).toBe(15);
      expect(Number(cls.targetRate)).toBe(30);
      expect(cls.minStudents).toBe(4);
      expect(cls.maxStudents).toBe(12);
      expect(cls.teacherId).toBe(teacherId);
      expect(cls.teacherRoomId).toBe(teacherRoomId);
      expect(cls.templateId).toBe(templateId);
      expect(cls.description).toBe('Tuesday morning flow');
      expect(cls.startTime).toBe('09:00');
      expect(cls.durationMinutes).toBe(75);
      expect(cls.cancelDeadline).toBe('HOURS_24');
      expect(cls.autoCancelCheck).toBe('HOURS_2');
    }
  });

  it('is idempotent — running again creates no duplicates', async () => {
    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(0);

    const classes = await prisma.class.findMany({
      where: { templateId },
    });
    expect(classes).toHaveLength(4);
  });

  it('skips inactive templates', async () => {
    // Deactivate template and delete existing classes
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: false },
    });
    await prisma.class.deleteMany({ where: { templateId } });

    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(0);

    const classes = await prisma.class.findMany({
      where: { templateId },
    });
    expect(classes).toHaveLength(0);

    // Re-activate for potential further tests
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true },
    });
  });

  it('skips archived templates even when isActive is stale-true', async () => {
    // Defense in depth: the routes keep archived templates inactive, but
    // a slipped invariant must not let the sweep materialize classes for
    // something the teacher shelved.
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: true },
    });
    await prisma.class.deleteMany({ where: { templateId } });

    const from = new Date('2026-04-06T00:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(0);
    expect(await prisma.class.count({ where: { templateId } })).toBe(0);

    // Restore for the tests that follow
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { isActive: true, isArchived: false },
    });
  });

  it("skips today's occurrence when its start has already passed", async () => {
    // Tuesday 2026-04-07 at 18:00 UTC — hours after the template's 09:00
    // Amsterdam start. The run must not create a class earlier the same
    // day; the window slides to the next four Tuesdays instead.
    await prisma.class.deleteMany({ where: { templateId } });
    const from = new Date('2026-04-07T18:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(4);
    const classes = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });
    expect(classes.map((c) => c.date.toISOString())).toEqual([
      '2026-04-14T00:00:00.000Z',
      '2026-04-21T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
      '2026-05-05T00:00:00.000Z',
    ]);
  });

  it("includes today's occurrence while its start is still ahead", async () => {
    // Tuesday 2026-04-07 at 05:00 UTC — before the 09:00 Amsterdam start.
    await prisma.class.deleteMany({ where: { templateId } });
    const from = new Date('2026-04-07T05:00:00.000Z');
    const count = await generateClassInstances(prisma, from);

    expect(count).toBe(4);
    const classes = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });
    expect(classes.map((c) => c.date.toISOString())).toEqual([
      '2026-04-07T00:00:00.000Z',
      '2026-04-14T00:00:00.000Z',
      '2026-04-21T00:00:00.000Z',
      '2026-04-28T00:00:00.000Z',
    ]);
  });
});

// ===========================================================================
// Per-template isolation — stubbed db, no real DB
// ===========================================================================

describe('generateClassInstances (per-template isolation)', () => {
  function tmpl(id: string, teacherId: string) {
    return {
      id, teacherId, teacherRoomId: 'tr', dayOfWeek: 0, startTime: '09:00',
      classType: 'Flow', description: null, durationMinutes: 60,
      roomCost: 10, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 8,
      cancelDeadline: 120, autoCancelCheck: 120,
      teacher: { defaultTimezone: 'UTC' },
    };
  }

  it('a failing template does not abort the others, and the error is rethrown', async () => {
    const created: string[] = [];
    const from = new Date('2099-01-05T00:00:00Z'); // deterministic future window
    const stub = {
      classTemplate: { findMany: async () => [tmpl('A', 't1'), tmpl('B', 't1'), tmpl('C', 't1')] },
      class: {
        findFirst: async () => null,
        create: async ({ data }: { data: { templateId: string } }) => {
          if (data.templateId === 'A') throw new Error('boom-A');
          if (data.templateId === 'C') throw new Error('boom-C');
          created.push(data.templateId);
          return {};
        },
      },
    } as unknown as import('@prisma/client').PrismaClient;

    await expect(generateClassInstances(stub, from)).rejects.toThrow('boom-A');
    expect(created).toContain('B'); // B generated despite A failing before and C failing after
  });
});
