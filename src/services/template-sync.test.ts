import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { syncTemplateInstances } from './template-sync';

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
  });
});

/** Schema dayOfWeek (0=Monday) → JS getUTCDay (0=Sunday). */
function dayInstanceWeekday(templateDay: number): number {
  return (templateDay + 1) % 7;
}
