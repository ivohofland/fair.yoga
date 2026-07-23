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

describe('PATCH /api/class-templates/[id]', () => {
  it('re-activation tops the window back up; archive and pause do not generate', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify(templateBody('Toggle Flow')),
    });
    expect(create.status).toBe(201);
    const { data: template } = (await create.json()) as { data: { id: string } };
    createdTemplateIds.push(template.id);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);

    // Simulate window drift: one instance vanishes (e.g. teacher-cancelled
    // long ago and pruned). Regeneration is what heals it.
    const first = await prisma.class.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    await prisma.class.delete({ where: { id: first.id } });

    const toggle = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
        method: 'PATCH',
        headers: { Cookie: sessionCookie },
      });

    // active → paused: no generation.
    const pause = await toggle();
    expect(pause.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);

    // paused → active: the missing instance comes back.
    const activate = await toggle();
    expect(activate.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);

    // Archive (forces inactive) after removing another instance: no generation,
    // and un-archive leaves the template paused — still no generation.
    const next = await prisma.class.findFirstOrThrow({
      where: { templateId: template.id },
      orderBy: { date: 'asc' },
    });
    await prisma.class.delete({ where: { id: next.id } });
    const archive = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?action=archive`, {
        method: 'PATCH',
        headers: { Cookie: sessionCookie },
      });
    expect((await archive()).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);
    expect((await archive()).status).toBe(200); // un-archive
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(3);

    // Explicit activation after un-archive is the "goes live" moment.
    expect((await toggle()).status).toBe(200);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(4);
  });
});
