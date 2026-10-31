import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, freshIp, uniqueSuffix } from '../helpers';
import { createClassFixture, wallSlotAt } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { mintScheduleShareKey } from '@/services/schedule-share';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const slug = `public-page-${suffix}`;
const STARTED = `StartedFlow${suffix.replace(/\W/g, '')}`;
const UPCOMING = `UpcomingFlow${suffix.replace(/\W/g, '')}`;

describe('GET /[slug] (page) — the public class list', () => {
  let teacherId = '';

  beforeAll(async () => {
    const email = `public-page-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Public',
        lastName: 'Page',
        email,
        bio: 'Public page fixture teacher',
        pageSlug: slug,
        defaultTimezone: 'UTC',
        account: { create: { email } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: { venueName: 'Page Studio', address: 'a', city: 'Amsterdam', postcode: '1000AA', maxCapacity: 10, createdById: teacherId },
    });
    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 20 },
    });
    const own = { teacherId, teacherRoomId: tr.id, roomCost: 20, minRate: 10, targetRate: 30, minStudents: 2, maxStudents: 10, status: 'open' as const };
    const started = wallSlotAt(new Date(Date.now() - 10 * 60_000), 'UTC');
    await createClassFixture(prisma, { ...own, classType: STARTED, ...started, durationMinutes: 5 });
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
    await createClassFixture(prisma, {
      ...own,
      classType: UPCOMING,
      date: new Date(`${tomorrow.toISOString().slice(0, 10)}T00:00:00Z`),
      startTime: hhmmToTime('10:00'),
      durationMinutes: 60,
    });
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('lists an upcoming open class and not one that started ten minutes ago', async () => {
    const res = await fetch(`${BASE_URL}/${slug}`, { headers: freshIp() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes(UPCOMING), 'upcoming class listed').toBe(true);
    expect(html.includes(STARTED), 'started class listed').toBe(false);
  });

  it('links the calendar feed only while sharing is on, and the href holds the key', async () => {
    const before = await (await fetch(`${BASE_URL}/${slug}`, { headers: freshIp() })).text();
    expect(before).not.toContain('webcal://');
    const key = mintScheduleShareKey();
    await prisma.teacher.update({ where: { id: teacherId }, data: { scheduleShareKey: key } });
    const on = await (await fetch(`${BASE_URL}/${slug}`, { headers: freshIp() })).text();
    expect(on).toMatch(new RegExp(`href="webcal://[^"]+/feed/${key}\\.ics"`));
    expect(on.replace(/<!-- -->/g, '')).toMatch(/Subscribe to Public(&#x27;|')s schedule/);
    await prisma.teacher.update({ where: { id: teacherId }, data: { scheduleShareKey: null } });
    const off = await (await fetch(`${BASE_URL}/${slug}`, { headers: freshIp() })).text();
    expect(off).not.toContain('webcal://');
  });
});
