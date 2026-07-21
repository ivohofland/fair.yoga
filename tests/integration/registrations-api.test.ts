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
let ownerAccountIdForCleanup: string;
let otherAccountIdForCleanup: string;
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
      account: { create: { email: `regapi-owner-${uniqueSuffix}@test.local` } },
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
      account: { create: { email: `regapi-other-${uniqueSuffix}@test.local` } },
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
        claimedAt: new Date(),
        account: { create: { email: `regapi-student-${uniqueSuffix}-${i}@test.local` } },
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    await prisma.teacherStudent.create({ data: { teacherId: ownerId, studentId: student.id } });
    await prisma.session.create({
      data: {
        id: hashToken(studentTokens[i]!),
        accountId: student.accountId!,
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

  const ownerAccount = await prisma.teacher.findUniqueOrThrow({
    where: { id: ownerId },
    select: { accountId: true },
  });
  ownerAccountIdForCleanup = ownerAccount.accountId;
  await prisma.session.create({
    data: {
      id: hashToken(ownerToken),
      accountId: ownerAccount.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const otherAccount = await prisma.teacher.findUniqueOrThrow({
    where: { id: otherTeacherId },
    select: { accountId: true },
  });
  otherAccountIdForCleanup = otherAccount.accountId;
  await prisma.session.create({
    data: {
      id: hashToken(otherTeacherToken),
      accountId: otherAccount.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
});

afterAll(async () => {
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: ownerId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.teacherStudent.deleteMany({ where: { teacherId: ownerId } });
  const studentAccounts = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    select: { accountId: true },
  });
  await prisma.session.deleteMany({
    where: {
      accountId: {
        in: [
          ownerAccountIdForCleanup,
          otherAccountIdForCleanup,
          ...studentAccounts.map((a) => a.accountId!),
        ],
      },
    },
  });
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

  it('rejects a student session smuggling a studentId — no registering others by UUID', async () => {
    const classId = await makeClass(5);
    const victim = studentIds[1]!;
    const res = await post(studentTokens[0]!, { classId, studentId: victim });

    expect(res.status).toBe(403);
    expect(
      await prisma.registration.count({
        where: { classId, studentId: victim },
      }),
    ).toBe(0);
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

  it('teacher adds before class respect capacity — not walk-ins', async () => {
    const classId = await makeClass(1); // class is in 2099, far before start
    const fill = await post(studentTokens[0]!, { classId });
    expect(fill.status).toBe(201);

    // Full class + far from start: the owner's add is a normal registration
    // and must NOT silently bypass capacity.
    const add = await post(ownerToken, { classId, studentId: studentIds[1] });
    expect(add.status).toBe(409);
  });

  it('allows the owner to add a walk-in beyond capacity during class', async () => {
    const classId = await makeClass(1);
    const fill = await post(studentTokens[0]!, { classId });
    expect(fill.status).toBe(201);

    // The class starts: walk-ins happen at the door.
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    const walkIn = await post(ownerToken, { classId, studentId: studentIds[1] });
    expect(walkIn.status).toBe(201);
    const json = (await walkIn.json()) as { data: { isWalkIn: boolean } };
    expect(json.data.isWalkIn).toBe(true);

    // Students still cannot register into a running class.
    const student = await post(studentTokens[0]!, { classId });
    expect(student.status).toBe(409);
  });

  it('rebooking after a cancellation reactivates the old registration row', async () => {
    const classId = await makeClass(5);
    const first = await post(studentTokens[0]!, { classId });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as { data: { id: string } };

    const cancel = await fetch(`${BASE_URL}/api/registrations/${firstJson.data.id}`, {
      method: 'DELETE',
      headers: { Cookie: `fair_yoga_session=${studentTokens[0]!}` },
    });
    expect(cancel.status).toBe(200);

    // Booking the same class again must not 409 on the unique constraint.
    const rebook = await post(studentTokens[0]!, { classId });
    expect(rebook.status).toBe(201);
    const rebookJson = (await rebook.json()) as { data: { id: string; status: string } };
    expect(rebookJson.data.id).toBe(firstJson.data.id); // same row, reactivated
    expect(rebookJson.data.status).toBe('registered');

    const rows = await prisma.registration.count({
      where: { classId, studentId: studentIds[0]! },
    });
    expect(rows).toBe(1);
  });

  it('booking directly resolves the caller\'s waiting waitlist entry', async () => {
    const classId = await makeClass(1);
    const fill = await post(studentTokens[0]!, { classId });
    expect(fill.status).toBe(201);

    // Student 1 waits on the full class.
    await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[1]!, position: 1, status: 'waiting' },
    });

    // The spot frees without the waitlist hook running (e.g. GDPR erasure
    // path before the fix, or a crashed hook) — student 1 books directly.
    await prisma.registration.updateMany({
      where: { classId, studentId: studentIds[0]! },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    const book = await post(studentTokens[1]!, { classId });
    expect(book.status).toBe(201);
    const bookJson = (await book.json()) as { data: { id: string } };

    // The waiting entry must be resolved, not left to poison promotions.
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
    });
    expect(entry.status).toBe('claimed');
    expect(entry.registrationId).toBe(bookJson.data.id);
  });
});

describe('DELETE /api/waitlist/[id] — profile-presence authorization', () => {
  const del = (token: string, id: string) =>
    fetch(`${BASE_URL}/api/waitlist/${id}`, {
      method: 'DELETE',
      headers: { Cookie: `fair_yoga_session=${token}` },
    });

  async function makeEntry(classId: string, studentId: string) {
    return prisma.waitlistEntry.create({
      data: { classId, studentId, position: 1, status: 'waiting' },
    });
  }

  it('the class teacher can remove any entry', async () => {
    const classId = await makeClass(1);
    const entry = await makeEntry(classId, studentIds[0]!);

    const res = await del(ownerToken, entry.id);

    expect(res.status).toBe(200);
    const gone = await prisma.waitlistEntry.findUnique({ where: { id: entry.id } });
    expect(gone?.status ?? 'removed').not.toBe('waiting');
  });

  it('a different teacher is denied', async () => {
    const classId = await makeClass(1);
    const entry = await makeEntry(classId, studentIds[0]!);

    const res = await del(otherTeacherToken, entry.id);
    expect(res.status).toBe(403);
  });

  it('a student cannot remove someone else’s entry', async () => {
    const classId = await makeClass(1);
    const entry = await makeEntry(classId, studentIds[0]!);

    const res = await del(studentTokens[1]!, entry.id);
    expect(res.status).toBe(403);
  });
});
