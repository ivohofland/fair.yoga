import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { createPrismaClient } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';
import { listPublicSchedule, type PublicScheduleInput } from './public-schedule';

const prisma = createPrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// 13:00 Amsterdam on a far-future Tuesday, before that year's clock change.
const NOW = new Date('2099-03-10T12:00:00Z');
const TZ = 'Europe/Amsterdam';
const day = (offset: number): Date => new Date(Date.UTC(2099, 2, 10 + offset));

const own = { roomCost: 20, minRate: 10, targetRate: 30, minStudents: 2, maxStudents: 10 };

function input(over: Partial<PublicScheduleInput> & Pick<PublicScheduleInput, 'mode'>): PublicScheduleInput {
  return { teacherId, timeZone: TZ, now: NOW, includeStudio: false, ...over };
}

let teacherId: string;
const ids: Record<string, string> = {};
let studioId: string;

describe('listPublicSchedule (DB)', () => {
  beforeAll(async () => {
    const email = `pubsched-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Pub', lastName: 'Sched', email,
        account: { create: { email } }, bio: 'x', pageSlug: `pubsched-${suffix}`,
      },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: { venueName: 'Pub Studio', address: 'a', city: 'Amsterdam', postcode: '1000AA', maxCapacity: 10, createdById: teacherId },
    });
    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 20 },
    });
    const mk = async (
      key: string, date: Date, time: string, extra: Record<string, unknown> = {},
    ): Promise<string> => {
      const c = await createClassFixture(prisma, {
        teacherId, teacherRoomId: tr.id, classType: key, date, startTime: hhmmToTime(time),
        durationMinutes: 30, ...own, status: 'open', ...extra,
      });
      ids[key] = c.id;
      return c.id;
    };
    await mk('open', day(1), '10:00');
    await mk('private', day(2), '10:00', { isPrivate: true });
    await mk('cancelled', day(3), '10:00', { cancelledAt: new Date('2099-03-01T00:00:00Z') });
    await mk('started', day(0), '12:50');
    await mk('completed', day(0), '09:00', { status: 'completed' });
    await mk('far', day(28), '10:00');
    const full = await mk('full', day(5), '10:00', { maxStudents: 1, minStudents: 1 });
    const lc = await mk('lateCancelOnly', day(6), '10:00', { maxStudents: 1, minStudents: 1 });
    const s1 = await prisma.student.create({
      data: { firstName: 'S', lastName: 'One', email: `pubsched-s1-${suffix}@test.local`, incomeTier: 2 },
    });
    const s2 = await prisma.student.create({
      data: { firstName: 'S', lastName: 'Two', email: `pubsched-s2-${suffix}@test.local`, incomeTier: 2 },
    });
    await prisma.registration.create({ data: { classId: full, studentId: s1.id, tierAtBooking: 2, status: 'registered' } });
    await prisma.registration.create({ data: { classId: lc, studentId: s2.id, tierAtBooking: 2, status: 'late_cancel' } });
    const online = await createClassFixture(prisma, {
      teacherId, format: 'online', videoUrl: 'https://meet.example/secret', classType: 'online',
      date: day(8), startTime: hhmmToTime('10:00'), durationMinutes: 30, ...own, roomCost: 0, status: 'open',
    });
    ids.online = online.id;
    const studio = await createStudioClassFixture(prisma, {
      teacherId, classType: 'studio', date: day(7), startTime: hhmmToTime('10:00'), durationMinutes: 30,
      location: 'Elsewhere', bookingUrl: 'https://studio.example/book', hourlyRate: 40,
    });
    studioId = studio.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.student.deleteMany({ where: { email: { endsWith: `-${suffix}@test.local` } } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  const idsOf = (list: { id: string }[]): string[] => list.map((e) => e.id);

  it('omits a private class in both modes', async () => {
    const b = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'bookable', weeks: null } })));
    const c = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'calendar', weeks: 4 } })));
    expect(b).not.toContain(ids.private);
    expect(c).not.toContain(ids.private);
    expect(b).toContain(ids.open);
  });

  it('drops a cancelled class when bookable and marks it in the calendar', async () => {
    const b = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'bookable', weeks: null } })));
    const c = await listPublicSchedule(prisma, input({ mode: { kind: 'calendar', weeks: 4 } }));
    expect(b).not.toContain(ids.cancelled);
    expect(c.find((e) => e.id === ids.cancelled)?.cancelled).toBe(true);
  });

  it('keeps a started or completed class out of bookable but in the calendar', async () => {
    const b = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'bookable', weeks: null } })));
    const c = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'calendar', weeks: 4 } })));
    expect(b).not.toContain(ids.started);
    expect(b).not.toContain(ids.completed);
    expect(c).toContain(ids.started);
    expect(c).toContain(ids.completed);
  });

  it('bounds the window by weeks, and null means unbounded', async () => {
    const four = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'bookable', weeks: 4 } })));
    const open = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'bookable', weeks: null } })));
    expect(four).not.toContain(ids.far);
    expect(open).toContain(ids.far);
  });

  it('returns studio classes only when asked, with the booking URL', async () => {
    const off = idsOf(await listPublicSchedule(prisma, input({ mode: { kind: 'calendar', weeks: 4 }, includeStudio: false })));
    const on = await listPublicSchedule(prisma, input({ mode: { kind: 'calendar', weeks: 4 }, includeStudio: true }));
    expect(off).not.toContain(studioId);
    const row = on.find((e) => e.id === studioId);
    expect(row).toMatchObject({ kind: 'studio', bookingUrl: 'https://studio.example/book', location: 'Elsewhere' });
  });

  it('reads waitlist when full, and ignores a late cancel', async () => {
    const list = await listPublicSchedule(prisma, input({ mode: { kind: 'bookable', weeks: null } }));
    const avail = (id: string) => {
      const e = list.find((x) => x.id === id);
      return e?.kind === 'class' ? e.availability : undefined;
    };
    expect(avail(ids.full!)).toBe('waitlist');
    expect(avail(ids.lateCancelOnly!)).toBe('open');
  });

  it('sorts by start and carries no videoUrl at any depth', async () => {
    const list = await listPublicSchedule(prisma, input({ mode: { kind: 'calendar', weeks: 4 }, includeStudio: true }));
    expect(idsOf(list)).toContain(ids.online);
    const starts = list.map((e) => e.start.getTime());
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const walk = (v: unknown): string[] => {
      if (v === null || typeof v !== 'object' || v instanceof Date) return [];
      return Object.entries(v).flatMap(([k, x]) => [k, ...walk(x)]);
    };
    expect(walk(list)).not.toContain('videoUrl');
    expect(JSON.stringify(list)).not.toContain('meet.example');
  });
});
