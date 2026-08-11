import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { syncTemplateInstances } from './template-sync';
import { getNextOccurrences, generateInstancesForTemplate } from './class-generator';
import { classStartInstant } from '@/lib/timezone';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
let templateId: string;

/** Next occurrence of `dayOfWeek` at least `weeksOut` weeks ahead (UTC midnight). */
function futureDate(dayOfWeek: number, weeksOut: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 7 * weeksOut);
  while (d.getUTCDay() !== dayOfWeek) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

async function mkInstance(date: Date, opts: { locked?: boolean; status?: 'draft' | 'open' | 'in_progress' } = {}) {
  return prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      templateId,
      classType: 'Sync Flow',
      date,
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: new Prisma.Decimal(20),
      minRate: new Prisma.Decimal(15),
      targetRate: new Prisma.Decimal(25),
      minStudents: 2,
      maxStudents: 10,
      status: opts.status ?? 'open',
      settingsLocked: opts.locked ?? false,
    },
  });
}

describe('syncTemplateInstances', () => {
  beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Sync',
        lastName: 'Teacher',
        email: `sync-${uniqueSuffix}@test.local`,
        account: { create: { email: `sync-${uniqueSuffix}@test.local` } },
        bio: 'template sync tests',
        pageSlug: `sync-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: {
        venueName: 'Sync Studio',
        address: `${uniqueSuffix} Sync St`,
        city: 'Amsterdam',
        postcode: '1234SY',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 20 },
    });
    teacherRoomId = teacherRoom.id;

    const template = await prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Sync Flow',
        dayOfWeek: 1, // Tuesday (schema convention: 0 = Monday)
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: new Prisma.Decimal(20),
        minRate: new Prisma.Decimal(15),
        targetRate: new Prisma.Decimal(25),
        minStudents: 2,
        maxStudents: 10,
        isActive: false, // keep the generator out of these tests
      },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.classTemplate.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('updates mutable future instances, keeps locked and started ones', async () => {
    const tpl = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const day = tpl.dayOfWeek;

    const mutable = await mkInstance(futureDate(dayInstanceWeekday(day), 1));
    const locked = await mkInstance(futureDate(dayInstanceWeekday(day), 2), { locked: true });
    const started = await mkInstance(futureDate(dayInstanceWeekday(day), 3), {
      status: 'in_progress',
    });

    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { startTime: '10:30', targetRate: new Prisma.Decimal(30), classType: 'Sync Flow II' },
    });

    const result = await syncTemplateInstances(prisma, templateId);
    expect(result.synced).toBe(1);
    expect(result.kept).toBe(2);
    expect(result.regenerated).toBe(0);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: mutable.id } });
    expect(updated.startTime).toBe('10:30');
    expect(Number(updated.targetRate)).toBe(30);
    expect(updated.classType).toBe('Sync Flow II');

    const keptRow = await prisma.class.findUniqueOrThrow({ where: { id: locked.id } });
    expect(keptRow.startTime).toBe('09:00'); // bookings freeze settings
    const startedRow = await prisma.class.findUniqueOrThrow({ where: { id: started.id } });
    expect(startedRow.startTime).toBe('09:00');
  });

  it('a day change deletes mutable wrong-day instances and keeps locked ones', async () => {
    // Move the template to a different weekday than every existing instance.
    const tpl = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const newDay = (tpl.dayOfWeek + 3) % 7;
    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { dayOfWeek: newDay },
    });

    const before = await prisma.class.findMany({ where: { templateId } });
    const mutableBefore = before.filter(
      (c) => !c.settingsLocked && (c.status === 'draft' || c.status === 'open'),
    );
    expect(mutableBefore.length).toBeGreaterThanOrEqual(1);

    const result = await syncTemplateInstances(prisma, templateId);
    expect(result.regenerated).toBe(mutableBefore.length);
    expect(result.kept).toBe(2); // locked + in_progress survive on the old day

    const after = await prisma.class.findMany({ where: { templateId } });
    // Template inactive → no refill; only the untouchable rows remain.
    expect(after.length).toBe(2);
    expect(after.every((c) => c.settingsLocked || c.status === 'in_progress')).toBe(true);
    // A paused template skips the refill entirely, so nothing was added and
    // nothing was blocked — `regenerated` above is a delete count on its own.
    expect(result.refilled).toBe(0);
    expect(result.blockedByCancelled).toBe(0);
    expect(result.slotTaken).toBe(0);
  });

  /**
   * The reason `refilled` exists as a separate number from `regenerated`.
   *
   * `regenerated` counts instances DELETED from the old day. Until #196's slot
   * pre-check, the refill created one row per deleted one, so rendering the
   * delete count as "N rescheduled to the new day" happened to be true. It is
   * not any more: if the teacher already has a class at that time on the new
   * day, every candidate date is `slot_taken` and the refill creates nothing —
   * four classes destroyed, four waitlists cascaded, and the old message said
   * they had moved.
   */
  it('reports deletes and refills separately when the new day is already occupied', async () => {
    // Self-contained: the preceding test leaves this template with no mutable
    // instances, so this one generates its own window before moving it. A test
    // that depends on a sibling's leftovers is how the first draft of this
    // asserted `regenerated > 0` against a zero.
    await prisma.classTemplate.update({ where: { id: templateId }, data: { isActive: true } });
    const seed = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
    const seeded = await generateInstancesForTemplate(prisma, seed);
    expect(seeded.created).toBeGreaterThan(0);

    const template = await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } });
    const newDay = (template.dayOfWeek + 2) % 7;

    // Occupy every candidate slot on the new day with classes of no template.
    const targets = getNextOccurrences(newDay, new Date(), 5)
      .filter((d) => classStartInstant(d, template.startTime, 'UTC') > new Date())
      .slice(0, 4);
    for (const date of targets) {
      await prisma.class.create({
        data: {
          teacherId: template.teacherId,
          teacherRoomId: template.teacherRoomId,
          templateId: null,
          classType: 'Occupier',
          date,
          startTime: template.startTime,
          durationMinutes: 60,
          roomCost: 10,
          minRate: 5,
          targetRate: 10,
          minStudents: 1,
          maxStudents: 5,
          cancelDeadline: 'HOURS_24',
          autoCancelCheck: 'HOURS_2',
          status: 'open',
        },
      });
    }

    await prisma.classTemplate.update({
      where: { id: templateId },
      data: { dayOfWeek: newDay, isActive: true },
    });

    const result = await syncTemplateInstances(prisma, templateId);

    expect(result.regenerated).toBeGreaterThan(0); // deleted from the old day
    expect(result.refilled).toBe(0); // and none created on the new one
    expect(result.slotTaken).toBe(targets.length);
    expect(result.blockedByCancelled).toBe(0);
  });
});

/** Schema dayOfWeek (0=Monday) → JS getUTCDay (0=Sunday). */
function dayInstanceWeekday(templateDay: number): number {
  return (templateDay + 1) % 7;
}
