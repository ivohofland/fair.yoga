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
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const BASE_URL = 'http://localhost:3000';

// Sessions
const ownerToken = crypto.randomBytes(32).toString('hex');
const otherTeacherToken = crypto.randomBytes(32).toString('hex');
const studentTokens = [
  crypto.randomBytes(32).toString('hex'),
  crypto.randomBytes(32).toString('hex'),
];

let ownerId: string;
let otherTeacherId: string;
let teacherRoomId: string;
let roomId: string;
const studentIds: string[] = [];
let unlinkedStudentId: string;
const classIds: string[] = [];

async function makeClass(maxStudents: number): Promise<string> {
  const cls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId,
      classType: 'Reg API',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents,
      status: 'open',
    },
  });
  classIds.push(cls.id);
  return cls.id;
}

function post(token: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/registrations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_session=${token}`,
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await prisma.$connect();

  const owner = await prisma.teacher.create({
    data: {
      firstName: 'Owner',
      lastName: 'Teacher',
      email: `regapi-owner-${uniqueSuffix}@test.local`,
      bio: 'Registration API tests',
      pageSlug: `regapi-owner-${uniqueSuffix}`,
    },
  });
  ownerId = owner.id;

  const other = await prisma.teacher.create({
    data: {
      firstName: 'Other',
      lastName: 'Teacher',
      email: `regapi-other-${uniqueSuffix}@test.local`,
      bio: 'Registration API tests',
      pageSlug: `regapi-other-${uniqueSuffix}`,
    },
  });
  otherTeacherId = other.id;

  const room = await prisma.room.create({
    data: {
      venueName: 'Reg API Studio',
      address: `${uniqueSuffix} Reg St`,
      city: 'Amsterdam',
      postcode: '1234RA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: ownerId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: ownerId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  teacherRoomId = teacherRoom.id;

  // Two students linked to the owner, one unlinked
  for (let i = 0; i < 2; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: `RegStudent${i}`,
        lastName: 'Test',
        email: `regapi-student-${uniqueSuffix}-${i}@test.local`,
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    await prisma.teacherStudent.create({ data: { teacherId: ownerId, studentId: student.id } });
    await prisma.session.create({
      data: {
        id: hashToken(studentTokens[i]!),
        userId: student.id,
        userType: 'student',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  }
  const unlinked = await prisma.student.create({
    data: {
      firstName: 'Unlinked',
      lastName: 'Test',
      email: `regapi-unlinked-${uniqueSuffix}@test.local`,
      incomeTier: 3,
    },
  });
  unlinkedStudentId = unlinked.id;

  await prisma.session.create({
    data: {
      id: hashToken(ownerToken),
      userId: ownerId,
      userType: 'teacher',
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  await prisma.session.create({
    data: {
      id: hashToken(otherTeacherToken),
      userId: otherTeacherId,
      userType: 'teacher',
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
});

afterAll(async () => {
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: ownerId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.teacherStudent.deleteMany({ where: { teacherId: ownerId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, otherTeacherId, ...studentIds] } } });
  await prisma.student.deleteMany({ where: { id: { in: [...studentIds, unlinkedStudentId] } } });
  await prisma.teacher.deleteMany({ where: { id: { in: [ownerId, otherTeacherId] } } });
  await prisma.$disconnect();
});

describe('POST /api/registrations', () => {
  it('rejects a teacher registering students into another teacher\'s class', async () => {
    const classId = await makeClass(5);
    const res = await post(otherTeacherToken, { classId, studentId: studentIds[0] });
    expect(res.status).toBe(403);

    // And the victim's class must NOT have been settings-locked
    const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(cls.settingsLocked).toBe(false);
  });

  it('rejects a teacher registering a student who is not in their roster', async () => {
    const classId = await makeClass(5);
    const res = await post(ownerToken, { classId, studentId: unlinkedStudentId });
    expect(res.status).toBe(403);
  });

  it('never exceeds capacity under concurrent registrations', async () => {
    const classId = await makeClass(1); // one spot, two students racing

    const [a, b] = await Promise.all([
      post(studentTokens[0]!, { classId }),
      post(studentTokens[1]!, { classId }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const count = await prisma.registration.count({
      where: { classId, status: 'registered' },
    });
    expect(count).toBe(1);
  });

  it('locks settings atomically with the first registration', async () => {
    const classId = await makeClass(5);
    const res = await post(studentTokens[0]!, { classId });
    expect(res.status).toBe(201);

    const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(cls.settingsLocked).toBe(true);
  });

  it('returns 409 (not 500) for a duplicate registration', async () => {
    const classId = await makeClass(5);
    const first = await post(studentTokens[0]!, { classId });
    expect(first.status).toBe(201);
    const dup = await post(studentTokens[0]!, { classId });
    expect(dup.status).toBe(409);
  });

  it('allows the owner to add a roster student as a walk-in beyond capacity', async () => {
    const classId = await makeClass(1);
    const fill = await post(studentTokens[0]!, { classId });
    expect(fill.status).toBe(201);

    // Class is full; the owner adds a walk-in anyway
    const walkIn = await post(ownerToken, { classId, studentId: studentIds[1] });
    expect(walkIn.status).toBe(201);
    const json = (await walkIn.json()) as { data: { isWalkIn: boolean } };
    expect(json.data.isWalkIn).toBe(true);
  });
});
