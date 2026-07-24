import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let ownerToken: string;
let otherTeacherToken: string;

let ownerId: string;
let otherTeacherId: string;
let roomId: string;
let teacherRoomId: string;
let classId: string;
let cancelClassId: string;

// Dedicated fixtures for the PUT /api/classes/[id] economic-lock tests —
// kept separate from classId/cancelClassId above, which the existing tests
// depend on staying in `draft`.
let economicsClassId: string;
let lockedClassId: string;
let lockStudentId: string;
let lockStudentAccountId: string | null;

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
  const token = await seedSession(prisma, teacher.accountId);
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
  teacherRoomId = teacherRoom.id;

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

  // -- PUT /api/classes/[id] economic-lock fixtures ------------------------
  // Both `open` (not `draft`): a real registration requires it, and PUT
  // itself doesn't gate on status, so this doesn't affect what's tested.
  const economicsCls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId,
      classType: 'Classes API Lock (unlocked)',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'open',
    },
  });
  economicsClassId = economicsCls.id;

  const lockedCls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId,
      classType: 'Classes API Lock (locked)',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'open',
    },
  });
  lockedClassId = lockedCls.id;

  // A student who books lockedClassId over HTTP — the same trigger path
  // registrations-api.test.ts uses (POST /api/registrations) — so the lock
  // comes from the app's own behaviour, never a direct `settingsLocked`
  // write.
  const lockStudentEmail = `classesapi-lockstudent-${suffix}@test.local`;
  const lockStudent = await prisma.student.create({
    data: {
      firstName: 'Lock',
      lastName: 'Student',
      email: lockStudentEmail,
      claimedAt: new Date(),
      account: { create: { email: lockStudentEmail } },
      incomeTier: 3,
    },
  });
  lockStudentId = lockStudent.id;
  lockStudentAccountId = lockStudent.accountId;
  const lockStudentToken = await seedSession(prisma, lockStudentAccountId!);

  const lockRes = await fetch(`${BASE_URL}/api/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(lockStudentToken) },
    body: JSON.stringify({ classId: lockedClassId }),
  });
  if (lockRes.status !== 201) {
    throw new Error(
      `Fixture setup: expected the locking registration to succeed (201), got ${lockRes.status}`,
    );
  }
});

afterAll(async () => {
  // registration -> class, per the lock fixtures' FK direction.
  if (lockedClassId) {
    await prisma.registration.deleteMany({ where: { classId: lockedClassId } });
  }
  const allClassIds = [classId, cancelClassId, economicsClassId, lockedClassId].filter(Boolean);
  if (allClassIds.length > 0) {
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: allClassIds } } });
    await prisma.class.deleteMany({ where: { id: { in: allClassIds } } });
  }
  await prisma.teacherRoom.deleteMany({ where: { teacherId: ownerId } });
  await prisma.room.delete({ where: { id: roomId } });
  if (lockStudentId) {
    // Self-booking upserts a TeacherStudent link (registrations route) —
    // clean it up before the teacher/student rows go.
    await prisma.teacherStudent.deleteMany({ where: { studentId: lockStudentId } });
    if (lockStudentAccountId) {
      await prisma.session.deleteMany({ where: { accountId: lockStudentAccountId } });
    }
    await prisma.student.delete({ where: { id: lockStudentId } });
  }
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

describe('PUT /api/classes/[id]', () => {
  const put = (token: string, id: string, body: Record<string, unknown>) =>
    fetch(`${BASE_URL}/api/classes/${id}`, {
      method: 'PUT',
      headers: {
        ...cookie(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('unlocked class: owner edits economic fields -> 200, the new values persist', async () => {
    const res = await put(ownerToken, economicsClassId, { roomCost: 42, minStudents: 2 });
    expect(res.status).toBe(200);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
    expect(Number(updated.roomCost)).toBe(42);
    expect(updated.minStudents).toBe(2);
  });

  it('locked class: economic edit is rejected with 409 naming the fields sent', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(before.settingsLocked).toBe(true); // sanity: the beforeAll fixture registration locked it

    const res = await put(ownerToken, lockedClassId, { roomCost: 999, minRate: 1 });
    expect(res.status).toBe(409);

    // route.ts:74 — names exactly the ECONOMIC_FIELDS sent, in ECONOMIC_FIELDS
    // order (route.ts:35-41), regardless of the order given in the request body.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('roomCost, minRate');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(Number(after.minRate)).toBe(Number(before.minRate));
  });

  it('locked class: a non-economic edit still succeeds — the lock is scoped to economics', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });

    const res = await put(ownerToken, lockedClassId, { description: 'Updated after lock' });
    expect(res.status).toBe(200);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(after.description).toBe('Updated after lock');
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(Number(after.minRate)).toBe(Number(before.minRate));
    expect(Number(after.targetRate)).toBe(Number(before.targetRate));
    expect(after.minStudents).toBe(before.minStudents);
    expect(after.maxStudents).toBe(before.maxStudents);
  });

  it("403s another teacher's cookie on a locked class with an economic body — proves the ownership guard fires before the lock check", async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });

    // An economic field, not `description`: a non-economic body can't tell
    // ownership-first from lock-first apart, because sentEconomicFields would
    // be empty either way and the lock branch (route.ts:72) would be
    // unreachable regardless of guard order. roomCost makes the two orderings
    // diverge: ownership-first -> 403 "Not your class"; lock-first -> 409
    // "Cannot update economic fields...".
    const res = await put(otherTeacherToken, lockedClassId, { roomCost: 999 });
    expect(res.status).toBe(403);

    // The bespoke ownership guard's own message (classes/[id]/route.ts:54),
    // which runs ahead of parseBody and the ECONOMIC_FIELDS lock check.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Not your class');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
  });
});
