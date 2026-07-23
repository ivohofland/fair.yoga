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

const studentToken = crypto.randomBytes(32).toString('hex');
const teacherToken = crypto.randomBytes(32).toString('hex'); // non-student session, for the 403 case

let teacherId: string;
let studentId: string;
let roomId: string;
let teacherRoomId: string;
let farFutureClassId: string;
let freedSpotClassId: string;

function claim(token: string | null, body: unknown) {
  return fetch(`${BASE_URL}/api/waitlist/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Cookie: `fair_yoga_session=${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await prisma.$connect();

  // UTC timezone pins the freed-spot fixture's window math below to plain
  // UTC arithmetic — no DST/offset guesswork.
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Waitlist',
      lastName: 'Teacher',
      email: `waitlistapi-teacher-${uniqueSuffix}@test.local`,
      account: { create: { email: `waitlistapi-teacher-${uniqueSuffix}@test.local` } },
      bio: 'Waitlist API tests',
      pageSlug: `waitlistapi-teacher-${uniqueSuffix}`,
      defaultTimezone: 'UTC',
    },
  });
  teacherId = teacher.id;
  const teacherAccount = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(teacherToken),
      accountId: teacherAccount.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });

  const room = await prisma.room.create({
    data: {
      venueName: 'Waitlist API Studio',
      address: `${uniqueSuffix} Waitlist St`,
      city: 'Testville',
      postcode: '1234WA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
  });
  teacherRoomId = teacherRoom.id;

  const student = await prisma.student.create({
    data: {
      firstName: 'Waitlist',
      lastName: 'Student',
      email: `waitlistapi-student-${uniqueSuffix}@test.local`,
      claimedAt: new Date(),
      account: { create: { email: `waitlistapi-student-${uniqueSuffix}@test.local` } },
      incomeTier: 3,
    },
  });
  studentId = student.id;
  const studentAccount = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(studentToken),
      accountId: studentAccount.accountId!,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });

  // --- 409 fixture -----------------------------------------------------
  // A class far in the future. getWaitlistWindow resolves this to
  // 'auto_promote' no matter when the suite runs (it's nowhere near the
  // cancel deadline), so claimSpot deterministically throws
  // WaitlistPromotionError('wrong_window') — the "outside the claim
  // window" 409 branch that only exists at the route layer.
  const farFutureClass = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType: 'Waitlist API Far Future',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 2,
      status: 'open',
    },
  });
  farFutureClassId = farFutureClass.id;
  await prisma.waitlistEntry.create({
    data: { classId: farFutureClassId, studentId, position: 1, status: 'waiting' },
  });

  // --- 201 fixture -------------------------------------------------------
  // A class whose start is computed relative to *now* so the request lands
  // inside the 1-hour first-come-first-claimed window (cutoff..deadline)
  // regardless of when the suite runs. cancelDeadline HOURS_6 + a class
  // starting ~6h15m from now puts "now" 15 minutes before the deadline —
  // comfortably inside the final-hour broadcast window, with a wide (15min
  // forward / 45min back) margin for suite runtime. Teacher timezone is UTC
  // (see above), so classStartInstant is plain Date.UTC arithmetic.
  const now = new Date();
  const classStart = new Date(now.getTime() + (6 * 60 + 15) * 60 * 1000);
  const freedSpotDate = new Date(
    Date.UTC(classStart.getUTCFullYear(), classStart.getUTCMonth(), classStart.getUTCDate()),
  );
  const freedSpotStartTime = `${String(classStart.getUTCHours()).padStart(2, '0')}:${String(
    classStart.getUTCMinutes(),
  ).padStart(2, '0')}`;

  const freedSpotClass = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType: 'Waitlist API Freed Spot',
      date: freedSpotDate,
      startTime: freedSpotStartTime,
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 1, // no active registrations below → the one spot reads as freed
      cancelDeadline: 'HOURS_6',
      status: 'open',
    },
  });
  freedSpotClassId = freedSpotClass.id;
  await prisma.waitlistEntry.create({
    data: { classId: freedSpotClassId, studentId, position: 1, status: 'waiting' },
  });
});

afterAll(async () => {
  const classIds = [farFutureClassId, freedSpotClassId];
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.delete({ where: { id: roomId } });

  const studentAccount = await prisma.student.findUniqueOrThrow({
    where: { id: studentId },
    select: { accountId: true, email: true },
  });
  await prisma.session.deleteMany({ where: { accountId: studentAccount.accountId! } });
  await prisma.student.delete({ where: { id: studentId } });
  await prisma.account.deleteMany({ where: { email: studentAccount.email } });

  const teacherAccount = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { accountId: true, email: true },
  });
  await prisma.session.deleteMany({ where: { accountId: teacherAccount.accountId } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { email: teacherAccount.email } });

  await prisma.$disconnect();
});

describe('POST /api/waitlist/claim', () => {
  it('rejects a signed-out caller', async () => {
    const res = await claim(null, { classId: farFutureClassId });
    expect(res.status).toBe(401);
  });

  it('rejects a teacher session — only students can claim', async () => {
    const res = await claim(teacherToken, { classId: farFutureClassId });
    expect(res.status).toBe(403);
  });

  it('400s a missing classId', async () => {
    const res = await claim(studentToken, {});
    expect(res.status).toBe(400);
  });

  it('400s a blank classId', async () => {
    const res = await claim(studentToken, { classId: '' });
    expect(res.status).toBe(400);
  });

  it('409s a claim outside the first-come-first-claimed window', async () => {
    const res = await claim(studentToken, { classId: farFutureClassId });
    expect(res.status).toBe(409);

    // No state change: the entry keeps waiting, no registration is created.
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId: farFutureClassId, studentId } },
    });
    expect(entry.status).toBe('waiting');
    expect(
      await prisma.registration.count({ where: { classId: farFutureClassId, studentId } }),
    ).toBe(0);
  });

  it('201s a claim inside the window on a freed spot', async () => {
    const res = await claim(studentToken, { classId: freedSpotClassId });
    expect(res.status).toBe(201);

    const json = (await res.json()) as {
      data: { id: string; status: string; registrationId: string | null };
    };
    expect(json.data.status).toBe('promoted');
    expect(json.data.registrationId).not.toBeNull();

    const registration = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId: freedSpotClassId, studentId } },
    });
    expect(registration.status).toBe('registered');
    expect(registration.id).toBe(json.data.registrationId);
  });
});
