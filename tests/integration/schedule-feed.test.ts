import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, freshIp, uniqueSuffix, teardownTeacher } from '../helpers';
import { createClassFixture, createStudioClassFixture, wallSlotAt } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { mintScheduleShareKey } from '@/services/schedule-share';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const clean = suffix.replace(/\W/g, '');
const slug = `feed-${suffix}`;
const OPEN = `OpenFlow${clean}`;
const STARTED = `StartedFlow${clean}`;
const PRIVATE = `PrivateFlow${clean}`;
const CANCELLED = `CancelledFlow${clean}`;
const ONLINE = `OnlineFlow${clean}`;
const STUDIO = `StudioFlow${clean}`;
const VIDEO = `https://video.example/room-${clean}`;

const feed = (name: string, ip = freshIp()) => fetch(`${BASE_URL}/feed/${name}`, { headers: ip });

function dayFromNow(days: number): Date {
  const d = new Date(Date.now() + days * 24 * 60 * 60_000);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

/** The VEVENT block whose SUMMARY is `type`, unfolded. */
function eventFor(body: string, type: string): string | undefined {
  const unfolded = body.replace(/\r\n[ \t]/g, '');
  return unfolded.split('BEGIN:VEVENT').find((b) => b.includes(`SUMMARY:${type}`));
}

describe('GET /feed/[key].ics', () => {
  let teacherId = '';
  let key = '';

  beforeAll(async () => {
    key = mintScheduleShareKey();
    const email = `${slug}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Feed', lastName: 'Teacher', bio: 'Fixture', email, pageSlug: slug, defaultTimezone: 'UTC',
        scheduleShareKey: key, scheduleShareWeeks: 4, scheduleShareStudio: true,
        account: { create: { email } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: { venueName: 'Feed Studio', address: 'a', city: 'Amsterdam', postcode: '1000AA', maxCapacity: 10, createdById: teacherId },
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
    await createClassFixture(prisma, { ...own, classType: CANCELLED, date: dayFromNow(1), cancelledAt: new Date() });
    await createClassFixture(prisma, {
      teacherId, classType: ONLINE, date: dayFromNow(4), startTime: hhmmToTime('10:00'), durationMinutes: 60,
      format: 'online', roomCost: 0, minRate: 10, targetRate: 30, minStudents: 2, maxStudents: 10,
      status: 'open', videoUrl: VIDEO,
    });
    const started = wallSlotAt(new Date(Date.now() - 60 * 60_000), 'UTC');
    await createClassFixture(prisma, { ...own, classType: STARTED, ...started, durationMinutes: 30, status: 'in_progress' });
    await createStudioClassFixture(prisma, {
      teacherId, classType: STUDIO, date: dayFromNow(5), startTime: hhmmToTime('10:00'),
      durationMinutes: 30, location: 'The Loft', hourlyRate: 40, bookingUrl: 'https://studio.example/book',
    });
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await teardownTeacher(prisma, teacherId);
    await prisma.$disconnect();
  });

  it('answers 200 as text/calendar with a minute of cache', async () => {
    const res = await feed(`${key}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const body = await res.text();
    expect(body.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    const open = eventFor(body, OPEN)!;
    expect(open).toContain('LOCATION:Feed Studio');
    expect(open).toContain('DESCRIPTION:Income-based');
    expect(open).toMatch(new RegExp(`URL:http://localhost:\\d+/${slug}/book/`));
    expect(open).toContain('@fair.yoga');
    expect(open).toContain('DTSTAMP:');
  });

  it('carries a studio class with its own location and booking link', async () => {
    const studio = eventFor(await (await feed(`${key}.ics`)).text(), STUDIO)!;
    expect(studio).toContain('LOCATION:The Loft');
    expect(studio).toContain('URL:https://studio.example/book');
  });

  it('keeps a cancelled class, marked STATUS:CANCELLED', async () => {
    const ev = eventFor(await (await feed(`${key}.ics`)).text(), CANCELLED)!;
    expect(ev).toContain('STATUS:CANCELLED');
  });

  it('keeps a class that started an hour ago today', async () => {
    const ev = eventFor(await (await feed(`${key}.ics`)).text(), STARTED);
    expect(ev).toBeDefined();
    expect(ev).toContain('STATUS:CONFIRMED');
  });

  it('never carries a private class or a video link', async () => {
    const body = await (await feed(`${key}.ics`)).text();
    expect(body).not.toContain(PRIVATE);
    expect(body).not.toContain(VIDEO);
    expect(eventFor(body, ONLINE)).toBeDefined();
    expect(eventFor(body, ONLINE)).not.toContain('LOCATION');
  });

  it('does not apply the distinct-key limit: twenty different keys answer 404, not 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      const res = await feed(`${i === 0 ? key : mintScheduleShareKey()}.ics`, ip);
      expect(res.status, `request ${i}`).toBe(i === 0 ? 200 : 404);
    }
  });

  it('answers 404 to a name that is not <key>.ics', async () => {
    expect((await feed('bad.txt')).status).toBe(404);
    expect((await feed(`${key}.ical`)).status).toBe(404);
  });

  it('answers 404 once sharing is off', async () => {
    const offKey = mintScheduleShareKey();
    const email = `${slug}-off@test.local`;
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Off', lastName: 'Teacher', bio: 'Fixture', email, pageSlug: `${slug}-off`, defaultTimezone: 'UTC',
        scheduleShareKey: offKey, account: { create: { email } },
      },
      select: { id: true },
    });
    try {
      expect((await feed(`${offKey}.ics`)).status).toBe(200);
      await prisma.teacher.update({ where: { id: t.id }, data: { scheduleShareKey: null } });
      expect((await feed(`${offKey}.ics`)).status).toBe(404);
    } finally {
      await teardownTeacher(prisma, t.id);
    }
  });
});
