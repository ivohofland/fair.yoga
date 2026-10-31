import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, freshIp, uniqueSuffix, teardownTeacher } from '../helpers';
import { createClassFixture, createStudioClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { mintScheduleShareKey } from '@/services/schedule-share';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const clean = suffix.replace(/\W/g, '');
const slug = `pub-sched-${suffix}`;
const OPEN = `OpenFlow${clean}`;
const PRIVATE = `PrivateFlow${clean}`;
const CANCELLED = `CancelledFlow${clean}`;
const STUDIO = `StudioFlow${clean}`;

const url = (key: string) => `${BASE_URL}/api/public/v1/schedule/${key}`;
const get = (key: string, ip = freshIp()) => fetch(url(key), { headers: ip });

function dayFromNow(days: number): Date {
  const d = new Date(Date.now() + days * 24 * 60 * 60_000);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

describe('GET /api/public/v1/schedule/[key]', () => {
  let teacherId = '';
  let key = '';
  const extraTeacherIds: string[] = [];

  async function makeTeacher(data: { scheduleShareKey: string | null; deletedAt?: Date | null; pageSlug: string }) {
    const email = `${data.pageSlug}@test.local`;
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Pub', lastName: 'Sched', bio: 'Fixture', email, pageSlug: data.pageSlug, defaultTimezone: 'UTC',
        scheduleShareKey: data.scheduleShareKey, deletedAt: data.deletedAt ?? null,
        account: { create: { email } },
      },
      select: { id: true },
    });
    extraTeacherIds.push(t.id);
    return t.id;
  }

  beforeAll(async () => {
    key = mintScheduleShareKey();
    const email = `${slug}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Pub', lastName: 'Sched', bio: 'Fixture', email, pageSlug: slug, defaultTimezone: 'UTC',
        scheduleShareKey: key, scheduleShareWeeks: 4, scheduleShareStudio: false,
        account: { create: { email } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: { venueName: 'Pub Studio', address: 'a', city: 'Amsterdam', postcode: '1000AA', maxCapacity: 10, createdById: teacherId },
    });
    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 20 },
    });
    const own = {
      teacherId, teacherRoomId: tr.id, roomCost: 20, minRate: 10, targetRate: 30, minStudents: 2,
      maxStudents: 10, status: 'open' as const, durationMinutes: 60, startTime: hhmmToTime('10:00'),
    };
    await createClassFixture(prisma, { ...own, classType: OPEN, date: dayFromNow(2) });
    await createClassFixture(prisma, { ...own, classType: PRIVATE, date: dayFromNow(3), isPrivate: true });
    await createClassFixture(prisma, { ...own, classType: CANCELLED, date: dayFromNow(4), cancelledAt: new Date() });
    await createStudioClassFixture(prisma, {
      teacherId, classType: STUDIO, date: dayFromNow(5), startTime: hhmmToTime('10:00'),
      durationMinutes: 30, location: 'The Loft', hourlyRate: 40,
    });
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await teardownTeacher(prisma, teacherId);
    for (const id of extraTeacherIds) if (id !== teacherId) await teardownTeacher(prisma, id);
    await prisma.$disconnect();
  });

  it('answers 200 with CORS and a minute of cache, listing only what is public', async () => {
    const res = await get(key);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = await res.json() as { timezone: string; classes: { classType: string; bookingUrl: string | null }[] };
    expect(body.timezone).toBe('UTC');
    const types = body.classes.map((c) => c.classType);
    expect(types).toContain(OPEN);
    expect(types).not.toContain(PRIVATE);
    expect(types).not.toContain(CANCELLED);
    expect(types).not.toContain(STUDIO);
    expect(body.classes.find((c) => c.classType === OPEN)!.bookingUrl).toMatch(new RegExp(`/${slug}/book/`));
  });

  it('shows studio classes at once when the teacher turns them on', async () => {
    await prisma.teacher.update({ where: { id: teacherId }, data: { scheduleShareStudio: true } });
    const body = await (await get(key)).json() as { classes: { classType: string; kind: string }[] };
    expect(body.classes.find((c) => c.classType === STUDIO)?.kind).toBe('studio');
    await prisma.teacher.update({ where: { id: teacherId }, data: { scheduleShareStudio: false } });
    const off = await (await get(key)).json() as { classes: { classType: string }[] };
    expect(off.classes.map((c) => c.classType)).not.toContain(STUDIO);
  });

  it('answers 404 with CORS for an unknown key', async () => {
    const res = await get(mintScheduleShareKey());
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers 404 once sharing is off, and for an erased teacher', async () => {
    const offKey = mintScheduleShareKey();
    const offId = await makeTeacher({ scheduleShareKey: offKey, pageSlug: `${slug}-off` });
    expect((await get(offKey)).status).toBe(200);
    await prisma.teacher.update({ where: { id: offId }, data: { scheduleShareKey: null } });
    const off = await get(offKey);
    expect(off.status).toBe(404);
    expect(off.headers.get('access-control-allow-origin')).toBe('*');

    const erasedKey = mintScheduleShareKey();
    await makeTeacher({ scheduleShareKey: erasedKey, deletedAt: new Date(), pageSlug: `${slug}-erased` });
    expect((await get(erasedKey)).status).toBe(404);
  });

  it('answers 404 for the old key after a reset', async () => {
    const oldKey = mintScheduleShareKey();
    const id = await makeTeacher({ scheduleShareKey: oldKey, pageSlug: `${slug}-reset` });
    expect((await get(oldKey)).status).toBe(200);
    await prisma.teacher.update({ where: { id }, data: { scheduleShareKey: mintScheduleShareKey() } });
    expect((await get(oldKey)).status).toBe(404);
  });

  it('refuses the eleventh distinct key from one address with a 429 that still carries CORS', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await get(mintScheduleShareKey(), ip)).status).toBe(404);
    const res = await get(mintScheduleShareKey(), ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
