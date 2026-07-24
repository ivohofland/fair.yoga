import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, createSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let ownerToken: string;
let otherTeacherToken: string;

let ownerId: string;
let otherTeacherId: string;
let roomId: string;
let classId: string;
let cancelClassId: string;

const UNKNOWN_CLASS_ID = '00000000-0000-4000-8000-000000000000';

async function makeTeacher(tag: string): Promise<{ id: string; token: string }> {
  const email = `classesapi-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Classes',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Teacher for classes API tests',
      pageSlug: `classesapi-${tag}-${suffix}`,
    },
  });
  const token = await createSession(prisma, teacher.accountId);
  return { id: teacher.id, token };
}

beforeAll(async () => {
  await prisma.$connect();
  const owner = await makeTeacher('owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  const other = await makeTeacher('other');
  otherTeacherId = other.id;
  otherTeacherToken = other.token;

  const room = await prisma.room.create({
    data: {
      venueName: 'Classes API Studio',
      address: `${suffix} Classes St`,
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

  // Separate draft fixture for the /transition cancel-branch tests: cancelling
  // mutates status away from `draft`, which the tests above depend on staying
  // put. No registrations/waitlist entries here, so the cancel transaction's
  // notification fan-out has nothing to notify (see the cancel test below).
  const cancelCls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId: teacherRoom.id,
      classType: 'Classes API Cancel',
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
  cancelClassId = cancelCls.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({
    where: { relatedClassId: { in: [classId, cancelClassId] } },
  });
  await prisma.class.deleteMany({ where: { id: { in: [classId, cancelClassId] } } });
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
      headers: { ...(token ? cookie(token) : {}) },
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

    // Pin WHICH 409 fired — verbatim substring from validateTransition's
    // error in src/services/class-lifecycle.ts.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('cannot move from "draft" to "completed"');

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

    // Pin WHICH 409 fired — verbatim substring from validateTransition's
    // error in src/services/class-lifecycle.ts.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('cannot move from "draft" to "in_progress"');

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(unchanged.status).toBe('draft');
  });

  it('400s a transition to "completed" — the enum deliberately excludes it', async () => {
    // transitionClassSchema's status enum is ['draft','open','in_progress',
    // 'cancelled'] — completion only happens via /complete, never /transition.
    const res = await transition(ownerToken, classId, { status: 'completed' });
    expect(res.status).toBe(400);

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(unchanged.status).toBe('draft');
  });

  it('cancels a class (happy path)', async () => {
    const res = await transition(ownerToken, cancelClassId, { status: 'cancelled' });
    expect(res.status).toBe(200);

    const cancelled = await prisma.class.findUniqueOrThrow({ where: { id: cancelClassId } });
    expect(cancelled.status).toBe('cancelled');
  });

  it('409s cancelling an already-cancelled class', async () => {
    const res = await transition(ownerToken, cancelClassId, { status: 'cancelled' });
    expect(res.status).toBe(409);

    // Pin WHICH 409 fired — verbatim substring from the route's own guard
    // text in src/app/api/classes/[id]/transition/route.ts (the conditional
    // updateMany matched 0 rows because the class is already cancelled).
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Cannot cancel a class with status "cancelled"');

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: cancelClassId } });
    expect(unchanged.status).toBe('cancelled');
  });
});
