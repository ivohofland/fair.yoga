import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const rawSessionToken = crypto.randomBytes(32).toString('hex');
const teacherEmail = `tmpl-teacher-${uniqueSuffix}@test.local`;

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
const createdTemplateIds: string[] = [];

const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=${rawSessionToken}`;

/**
 * Schema convention (0=Monday, ..., 6=Sunday) — 3 is Thursday. Any fixed
 * weekday works; the assertion below converts to JS's getUTCDay() (0=Sunday)
 * the same way class-generator.ts does: jsDay = (dayOfWeek + 1) % 7.
 */
const DAY_OF_WEEK = 3;
const EXPECTED_JS_DAY = (DAY_OF_WEEK + 1) % 7;

function templateBody(classType: string) {
  return {
    teacherRoomId,
    classType,
    dayOfWeek: DAY_OF_WEEK,
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 15,
    minRate: 10,
    targetRate: 20,
    minStudents: 2,
    maxStudents: 8,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Template',
      lastName: 'Teacher',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: 'Teacher for template API tests',
      pageSlug: `tmpl-teacher-${uniqueSuffix}`,
      defaultTimezone: 'UTC',
    },
  });
  teacherId = teacher.id;

  const room = await prisma.room.create({
    data: {
      venueName: 'Template Venue',
      address: `${uniqueSuffix} Template St`,
      city: 'Testville',
      postcode: '1234TP',
      floor: '1',
      roomName: 'Loft',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
  });
  teacherRoomId = teacherRoom.id;

  const account = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(rawSessionToken),
      accountId: account.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
});

afterAll(async () => {
  await prisma.class.deleteMany({ where: { templateId: { in: createdTemplateIds } } });
  await prisma.classTemplate.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.session.deleteMany({ where: { id: hashToken(rawSessionToken) } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { email: teacherEmail } });
  await prisma.$disconnect();
});

describe('POST /api/class-templates', () => {
  it('creates the template and its four-week instance window in one request', async () => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify(templateBody('Instant Flow')),
    });
    expect(res.status).toBe(201);
    const { data: template } = (await res.json()) as { data: { id: string } };
    createdTemplateIds.push(template.id);

    // The whole point: no cron ran, yet the schedule is populated.
    const instances = await prisma.class.findMany({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    expect(instances.length).toBe(4);
    for (const instance of instances) {
      expect(instance.status).toBe('open');
      expect(instance.startTime).toBe('09:30');
      expect(instance.date.getUTCDay()).toBe(EXPECTED_JS_DAY);
    }
  });
});
