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
const ownerToken = crypto.randomBytes(32).toString('hex');
const otherTeacherToken = crypto.randomBytes(32).toString('hex');

let ownerId: string;
let otherTeacherId: string;
let roomId: string;
let classId: string;

const BASE_URL = 'http://localhost:3000';
const cookie = (token: string) => ({ Cookie: `fair_yoga_session=${token}` });
const UNKNOWN_CLASS_ID = '00000000-0000-4000-8000-000000000000';

async function makeTeacher(tag: string, token: string): Promise<string> {
  const email = `classesapi-${tag}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Classes',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Teacher for classes API tests',
      pageSlug: `classesapi-${tag}-${uniqueSuffix}`,
    },
  });
  const account = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacher.id },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(token),
      accountId: account.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  return teacher.id;
}

beforeAll(async () => {
  await prisma.$connect();
  ownerId = await makeTeacher('owner', ownerToken);
  otherTeacherId = await makeTeacher('other', otherTeacherToken);

  const room = await prisma.room.create({
    data: {
      venueName: 'Classes API Studio',
      address: `${uniqueSuffix} Classes St`,
      city: 'Testville',
      postcode: '1234CA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 10,
      createdById: ownerId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: ownerId, roomId, capacityOverride: 8, rentalRate: 15 },
  });

  // Left in the default `draft` status deliberately: draft cannot transition
  // straight to `completed` or `in_progress`, so the state guard on both
  // routes is reachable here without any registrations/pricing fixtures.
  const cls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId: teacherRoom.id,
      classType: 'Classes API',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
    },
  });
  classId = cls.id;
});

afterAll(async () => {
  await prisma.class.deleteMany({ where: { id: classId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: ownerId } });
  await prisma.room.delete({ where: { id: roomId } });
  for (const id of [ownerId, otherTeacherId]) {
    const t = await prisma.teacher.findUniqueOrThrow({
      where: { id },
      select: { accountId: true, email: true },
    });
    await prisma.session.deleteMany({ where: { accountId: t.accountId } });
    await prisma.teacher.delete({ where: { id } });
    await prisma.account.deleteMany({ where: { email: t.email } });
  }
  await prisma.$disconnect();
});

describe('POST /api/classes/[id]/complete', () => {
  const complete = (token: string | null, id: string) =>
    fetch(`${BASE_URL}/api/classes/${id}/complete`, {
      method: 'POST',
      headers: token ? cookie(token) : undefined,
    });

  it('rejects a signed-out caller', async () => {
    const res = await complete(null, classId);
    expect(res.status).toBe(401);
  });

  it('404s an unknown class', async () => {
    const res = await complete(ownerToken, UNKNOWN_CLASS_ID);
    expect(res.status).toBe(404);
  });

  it("403s another teacher's class", async () => {
    const res = await complete(otherTeacherToken, classId);
    expect(res.status).toBe(403);

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(unchanged.status).toBe('draft');
  });

  it('409s completing a class straight from draft (invalid transition)', async () => {
    const res = await complete(ownerToken, classId);
    expect(res.status).toBe(409);

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(unchanged.status).toBe('draft');
  });
});

describe('POST /api/classes/[id]/transition', () => {
  const transition = (token: string | null, id: string, body: Record<string, unknown>) =>
    fetch(`${BASE_URL}/api/classes/${id}/transition`, {
      method: 'POST',
      headers: {
        ...(token ? cookie(token) : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('rejects a signed-out caller', async () => {
    const res = await transition(null, classId, { status: 'open' });
    expect(res.status).toBe(401);
  });

  it('404s an unknown class', async () => {
    const res = await transition(ownerToken, UNKNOWN_CLASS_ID, { status: 'open' });
    expect(res.status).toBe(404);
  });

  it("403s another teacher's class", async () => {
    const res = await transition(otherTeacherToken, classId, { status: 'open' });
    expect(res.status).toBe(403);

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(unchanged.status).toBe('draft');
  });

  it('409s an invalid transition (draft -> in_progress)', async () => {
    const res = await transition(ownerToken, classId, { status: 'in_progress' });
    expect(res.status).toBe(409);

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(unchanged.status).toBe('draft');
  });
});
