import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, teardownTeacher } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
let token: string;

const send = (method: string, path: string, body: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  const email = `currency-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Currency',
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: 'Currency stamping tests',
      pageSlug: `currency-${suffix}`,
      defaultTimezone: 'UTC',
      currency: 'GBP',
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  const room = await prisma.room.create({
    data: {
      venueName: 'Currency Venue',
      address: `${suffix} Currency St`,
      city: 'Testville',
      postcode: '1234TP',
      floor: '1',
      roomName: 'Loft',
      maxCapacity: 10,
      createdById: teacher.id,
    },
  });
  roomId = room.id;
  teacherRoomId = (
    await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
    })
  ).id;
  token = await seedSession(prisma, accountId);
});

afterAll(async () => {
  // An unset id would reach Prisma as `undefined`, which is no filter at all.
  if (teacherId) {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await teardownTeacher(prisma, teacherId, accountId);
  }
  await prisma.$disconnect();
});

describe('currency snapshots are stamped from the teacher', () => {
  it('POST /api/classes stamps the teacher currency', async () => {
    const res = await send('POST', '/api/classes', {
      teacherRoomId,
      classType: 'Stamped Class',
      date: '2099-01-05',
      startTime: '10:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 2,
      maxStudents: 8,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const cls = await prisma.class.findUniqueOrThrow({ where: { id: data.id } });
    expect(cls.currency).toBe('GBP');
  });

  it('POST /api/studio-classes stamps the teacher currency', async () => {
    const res = await send('POST', '/api/studio-classes', {
      classType: 'Stamped Studio',
      date: '2099-07-01',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const sc = await prisma.studioClass.findUniqueOrThrow({ where: { id: data.id } });
    expect(sc.currency).toBe('GBP');
  });

  it('a class template generates classes in the teacher currency', async () => {
    const res = await send('POST', '/api/class-templates', {
      teacherRoomId,
      classType: 'Stamped Recurring',
      dayOfWeek: 1,
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 2,
      maxStudents: 8,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const classes = await prisma.class.findMany({
      where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: data.id } } } } },
    });
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.map((c) => c.currency)).toEqual(classes.map(() => 'GBP'));
  });

  it('a studio template generates studio classes in the teacher currency', async () => {
    const res = await send('POST', '/api/studio-class-templates', {
      classType: 'Stamped Studio Recurring',
      dayOfWeek: 3,
      startTime: '14:00',
      durationMinutes: 60,
      location: 'Generating Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const rows = await prisma.studioClass.findMany({
      where: {
        calendarEntry: { scheduleRule: { studioClassTemplates: { some: { id: data.id } } } },
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.currency)).toEqual(rows.map(() => 'GBP'));
  });

  it('PUT /api/teachers/[id] refuses a currency outside the enum', async () => {
    const res = await send('PUT', `/api/teachers/${teacherId}`, { currency: 'XYZ' });
    expect(res.status).toBe(400);
    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(t.currency).toBe('GBP');
  });

  it('PUT /api/teachers/[id] accepts a currency in the enum', async () => {
    const res = await send('PUT', `/api/teachers/${teacherId}`, { currency: 'CHF' });
    expect(res.status).toBe(200);
    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(t.currency).toBe('CHF');
  });
});
