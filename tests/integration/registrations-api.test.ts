import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, PROJECTED_STUDENT_KEYS } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

// Sessions
let ownerToken: string;
let otherTeacherToken: string;
const studentTokens: string[] = [];

let ownerId: string;
let ownerAccountIdForCleanup: string;
let otherAccountIdForCleanup: string;
let otherTeacherId: string;
let teacherRoomId: string;
let otherTeacherRoomId: string;
let roomId: string;
const studentIds: string[] = [];
let unlinkedStudentId: string;
const classIds: string[] = [];

// Every class this helper creates shares ownerId, the same 2099-06-01 date,
// and `status: 'open'` — none of that is what any test here cares about,
// it is just "a class far enough out that cancel-deadline logic never
// triggers". Class_teacher_slot_unique is (teacherId, date, startTime)
// WHERE status <> 'cancelled', though, and this file calls makeClass ~25
// times, so a shared literal startTime would let only the first through.
// A counter-derived minute keeps every call on its own slot without any
// caller needing to know or care what time its class landed on.
let makeClassCounter = 0;

async function makeClass(maxStudents: number): Promise<string> {
  const startTime = `09:${String(makeClassCounter++).padStart(2, '0')}`;
  const cls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId,
      classType: 'Reg API',
      date: new Date('2099-06-01'),
      startTime,
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

/**
 * A class starting a few hours from now — inside the default 24h cancel
 * deadline (`Class.cancelDeadline` defaults to `HOURS_24`) — so `DELETE`
 * takes the late-cancel branch instead of the before-deadline branch every
 * `makeClass` fixture takes (those sit in 2099). `date`/`startTime` are
 * derived from the *wall-clock* date and time in the owner teacher's
 * timezone (Europe/Amsterdam — `Teacher.defaultTimezone`'s default, unset
 * here), because `classStartInstant` interprets them as local wall time in
 * that zone: building them from UTC getters directly would skew the
 * resulting instant by the zone's UTC offset.
 */
async function makeLateCancelClass(maxStudents: number): Promise<string> {
  const target = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(target)
    .reduce<Record<string, string>>((acc, { type, value }) => {
      if (type !== 'literal') acc[type] = value;
      return acc;
    }, {});

  const cls = await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId,
      classType: 'Reg API Late Cancel',
      date: new Date(`${parts.year}-${parts.month}-${parts.day}`),
      startTime: `${parts.hour}:${parts.minute}`,
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

// For the cross-teacher ownership test: a class the *other* teacher owns, so
// an owner-roster student and an owner-teacher session can still collide with
// it via studentId.
async function makeOtherTeacherClass(maxStudents: number): Promise<string> {
  const cls = await prisma.class.create({
    data: {
      teacherId: otherTeacherId,
      teacherRoomId: otherTeacherRoomId,
      classType: 'Reg API (other teacher)',
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
      ...cookie(token),
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
      email: `regapi-owner-${suffix}@test.local`,
      account: { create: { email: `regapi-owner-${suffix}@test.local` } },
      bio: 'Registration API tests',
      pageSlug: `regapi-owner-${suffix}`,
    },
  });
  ownerId = owner.id;
  ownerAccountIdForCleanup = owner.accountId;

  const other = await prisma.teacher.create({
    data: {
      firstName: 'Other',
      lastName: 'Teacher',
      email: `regapi-other-${suffix}@test.local`,
      account: { create: { email: `regapi-other-${suffix}@test.local` } },
      bio: 'Registration API tests',
      pageSlug: `regapi-other-${suffix}`,
    },
  });
  otherTeacherId = other.id;
  otherAccountIdForCleanup = other.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Reg API Studio',
      address: `${suffix} Reg St`,
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

  // Same physical room, rented separately by the other teacher — lets
  // makeOtherTeacherClass build a class that teacher owns.
  const otherTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: otherTeacherId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  otherTeacherRoomId = otherTeacherRoom.id;

  // Two students linked to the owner, one unlinked
  for (let i = 0; i < 2; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: `RegStudent${i}`,
        lastName: 'Test',
        email: `regapi-student-${suffix}-${i}@test.local`,
        claimedAt: new Date(),
        account: { create: { email: `regapi-student-${suffix}-${i}@test.local` } },
        incomeTier: 3,
      },
    });
    studentIds.push(student.id);
    await prisma.teacherStudent.create({ data: { teacherId: ownerId, studentId: student.id } });
    studentTokens.push(await seedSession(prisma, student.accountId!));
  }
  const unlinked = await prisma.student.create({
    data: {
      firstName: 'Unlinked',
      lastName: 'Test',
      email: `regapi-unlinked-${suffix}@test.local`,
      incomeTier: 3,
    },
  });
  unlinkedStudentId = unlinked.id;

  ownerToken = await seedSession(prisma, owner.accountId);
  otherTeacherToken = await seedSession(prisma, other.accountId);
});

afterAll(async () => {
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: [ownerId, otherTeacherId] } } });
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
  it('rejects a cross-teacher registration at the roster-link check, before the class loads', async () => {
    const classId = await makeClass(5);
    const res = await post(otherTeacherToken, { classId, studentId: studentIds[0] });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe('Student is not in your roster');

    // And the victim's class must NOT have been settings-locked
    const cls = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(cls.settingsLocked).toBe(false);
  });

  /**
   * The test above no longer reaches the ownership check: otherTeacherToken
   * has no roster link to studentIds[0] (only the owner does), so it now dies
   * at the roster-link 403 instead. This test uses a student who IS on the
   * acting teacher's own roster, so that guard passes and the ownership check
   * inside the transaction is the only one left to fire — the realistic case
   * of two teachers sharing a student.
   */
  it('rejects the owner posting their own roster student into another teacher\'s class', async () => {
    const classId = await makeOtherTeacherClass(5);
    const res = await post(ownerToken, { classId, studentId: studentIds[0] });
    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe('Not your class');
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
    const { data } = (await walkIn.json()) as { data: { id: string } };

    // POST's response is narrowed to { id, status } (#167) — isWalkIn is
    // still on the row, just no longer echoed back here. Confirm it via the
    // teacher-facing read instead, which still carries it.
    const read = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      headers: cookie(ownerToken),
    });
    const readJson = (await read.json()) as { data: { isWalkIn: boolean } };
    expect(readJson.data.isWalkIn).toBe(true);

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
      headers: cookie(studentTokens[0]!),
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

  /**
   * #107. The route took the class row lock and then decided from a row read
   * before the lock existed, so a class cancelled in the gap was still booked.
   *
   * Deterministic by the lever #95 and #102 used, adapted to HTTP: an
   * uncommitted write is invisible under READ COMMITTED, and the dev server
   * holds its own connection, so a transaction held open here genuinely blocks
   * the request.
   */
  it('refuses a booking for a class cancelled while the request waited for the lock', async () => {
    const classId = await makeClass(5);

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });

    // Cancel, uncommitted. Holds the class row lock; invisible to the server.
    const cancelling = prisma.$transaction(
      async (tx) => {
        await tx.class.update({ where: { id: classId }, data: { status: 'cancelled' } });
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let settled = false;
    const booking = post(studentTokens[0]!, { classId }).then((res) => {
      settled = true;
      return res;
    });

    // Liveness, not teeth: this holds before and after the fix, because the
    // pre-fix route also reaches the FOR UPDATE and blocks — it has just
    // already read the class by then. It is here to prove the request is
    // genuinely waiting on the lock, which is what makes the assertion below
    // mean something.
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    commit();
    await cancelling;
    const res = await booking;

    // Pre-fix: 201. The server read `status: 'open'` before the lock, could not
    // see the uncommitted cancellation, and booked a cancelled class.
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe('Cannot register for a class with status "cancelled"');
    expect(await prisma.registration.count({ where: { classId } })).toBe(0);
  });

  it('refuses a booking that exceeds a cap lowered while the request waited', async () => {
    const classId = await makeClass(2);

    const first = await post(studentTokens[0]!, { classId });
    expect(first.status).toBe(201);

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });

    // Lower the cap to 1, uncommitted — the one existing registration now
    // fills the class.
    const capping = prisma.$transaction(
      async (tx) => {
        await tx.class.update({ where: { id: classId }, data: { maxStudents: 1 } });
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let settled = false;
    const booking = post(studentTokens[1]!, { classId }).then((res) => {
      settled = true;
      return res;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);

    commit();
    await capping;
    const res = await booking;

    // Pre-fix: 201. The count was fresh (1) but was compared against the stale
    // cap of 2, so the second booking fit a class that now holds one.
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Class is full');
    expect(await prisma.registration.count({ where: { classId } })).toBe(1);
  });
});

describe('DELETE /api/waitlist/[id] — profile-presence authorization', () => {
  const del = (token: string, id: string) =>
    fetch(`${BASE_URL}/api/waitlist/${id}`, {
      method: 'DELETE',
      headers: cookie(token),
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

/**
 * `GET /api/classes/[id]/registrations` had no ownership test at all until the
 * PR review of #167, and this branch is what made that expensive: the route
 * used to select `{ firstName, lastName }` and now selects email, phone,
 * birthday and address as well. The guard it relies on is the same
 * `cls.teacherId !== session.teacherId` shape the payment routes use, so these
 * two copy the idiom from `payments-api.test.ts:199,206` verbatim.
 */
describe('GET /api/classes/[id]/registrations — ownership', () => {
  it("403s another teacher's class", async () => {
    const classId = await makeClass(5);
    const res = await fetch(`${BASE_URL}/api/classes/${classId}/registrations`, {
      headers: cookie(otherTeacherToken),
    });
    expect(res.status).toBe(403);
  });

  it('404s an unknown class', async () => {
    const res = await fetch(
      `${BASE_URL}/api/classes/00000000-0000-4000-8000-000000000000/registrations`,
      { headers: cookie(ownerToken) },
    );
    expect(res.status).toBe(404);
  });
});

/**
 * All three access guards on `api/registrations/[id]` — one per method.
 *
 * #167 edited that file (it added the projection to the GET) and added
 * ownership tests for the roster route above and for both payment routes, and
 * skipped this one. A reviewer then deleted each of the three in turn and every
 * suite stayed green: registrations-api 26/26, full-flow 17/17, classes-api
 * 20/20, waitlist-api 10/10, payments-api 22/22. Two of the three are writes.
 *
 * One test per guard, deliberately, and each was mutation-checked on its own —
 * a single passing test does not vouch for the other two, because each method
 * reaches its check by a different route (PUT rejects a non-teacher before it
 * ever loads the row; DELETE's check is an OR over student-or-teacher).
 */
describe('api/registrations/[id] — a non-owning teacher is refused on every method', () => {
  /** A registration on the owner's class, which `otherTeacher` has no claim to. */
  async function othersRegistration(): Promise<string> {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };
    return data.id;
  }

  it('GET 403s: reading it would disclose the projected student', async () => {
    const res = await fetch(`${BASE_URL}/api/registrations/${await othersRegistration()}`, {
      headers: cookie(otherTeacherToken),
    });
    expect(res.status).toBe(403);
  });

  // Attendance drives pricing and payment creation, so without this guard any
  // teacher can bill another teacher's students.
  it('PUT 403s: marking attendance on a class you do not teach', async () => {
    const res = await fetch(`${BASE_URL}/api/registrations/${await othersRegistration()}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(otherTeacherToken) },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(403);
  });

  // The class sits in 2099, so it is before the cancel deadline: without this
  // guard the request would not merely be refused for some other reason, it
  // would succeed and cancel a stranger's booking.
  it('DELETE 403s: cancelling a booking that is neither yours nor your class', async () => {
    const res = await fetch(`${BASE_URL}/api/registrations/${await othersRegistration()}`, {
      method: 'DELETE',
      headers: cookie(otherTeacherToken),
    });
    expect(res.status).toBe(403);
  });
});

describe('teacher-facing registration reads honour StudentPrivacy', () => {
  // `PROJECTED_STUDENT_KEYS` (tests/helpers.ts) carries the rationale. It moved
  // there in #167's round-two review: this file had it as a local const, and
  // the payments family — which returns the same projection from three routes —
  // asserted only values, so the exact spread this constant exists to catch
  // went undetected there.

  it('the class roster withholds a surname the student did not share', async () => {
    const classId = await makeClass(5);
    await post(studentTokens[0]!, { classId });

    const res = await fetch(`${BASE_URL}/api/classes/${classId}/registrations`, {
      headers: cookie(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        student: Record<string, unknown> & { displayName: string; email: string | null };
        tierAtBooking?: number;
        tierRatio?: string;
      }[];
    };
    expect(body.data[0]!.student.displayName).toBe('RegStudent0 t.');
    expect(body.data[0]!.student.email).toBeNull();
    expect(Object.keys(body.data[0]!.student).sort()).toEqual(PROJECTED_STUDENT_KEYS);
    expect(body.data[0]!.tierAtBooking).toBeUndefined();
    expect(body.data[0]!.tierRatio).toBeUndefined();
  });

  it('a teacher reading one registration gets the gated student', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      headers: cookie(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        student: Record<string, unknown> & { displayName: string; email: string | null };
        tierAtBooking?: number;
      };
    };
    expect(body.data.student.displayName).toBe('RegStudent0 t.');
    expect(body.data.student.email).toBeNull();
    expect(Object.keys(body.data.student).sort()).toEqual(PROJECTED_STUDENT_KEYS);
    expect(body.data.tierAtBooking).toBeUndefined();
  });

  it('a student reading their OWN registration is not gated', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tierAtBooking: number } };
    // Their own tier is theirs to see — the gate is a teacher boundary, not a
    // blanket filter. This test is what stops the fix over-reaching.
    expect(body.data.tierAtBooking).toBeDefined();
  });

  /**
   * The three tests above authorize `isStudent` first, so a defect that
   * checks the teacher branch first instead — routing a dual-role account
   * into the projected view of its OWN booking, in a class it happens to
   * teach — would slip past them silently: `isStudent` is still true, so
   * every assertion above still holds. This fixture is the one case where
   * `isTeacher` and `isStudent` are BOTH true for the same request, which is
   * the only way to tell the two orderings apart. Mirrors the dual-role
   * fixture at `students-api.test.ts:556-596`.
   */
  describe('a dual-role account reading its own booking in a class it teaches', () => {
    let dualTeacherId: string;
    let dualStudentId: string;
    let dualAccountId: string;
    let dualToken: string;
    let dualRoomId: string;
    let dualTeacherRoomId: string;
    let dualClassId: string;
    let dualRegistrationId: string;

    beforeAll(async () => {
      const dualEmail = `regapi-dual-${suffix}@test.local`;
      const teacher = await prisma.teacher.create({
        data: {
          firstName: 'Dual',
          lastName: 'Booker',
          email: dualEmail,
          bio: 'Registration API dual-role fixture',
          pageSlug: `regapi-dual-${suffix}`,
          account: { create: { email: dualEmail } },
        },
      });
      dualTeacherId = teacher.id;
      dualAccountId = teacher.accountId;

      const student = await prisma.student.create({
        data: {
          firstName: 'Dual',
          lastName: 'Booker',
          email: dualEmail,
          claimedAt: new Date(),
          account: { connect: { id: dualAccountId } },
        },
      });
      dualStudentId = student.id;
      dualToken = await seedSession(prisma, dualAccountId);

      const room = await prisma.room.create({
        data: {
          venueName: 'Reg API Dual Studio',
          address: `${suffix} Dual St`,
          city: 'Amsterdam',
          postcode: '1234RB',
          floor: '1',
          roomName: 'Dual Room',
          maxCapacity: 20,
          createdById: dualTeacherId,
        },
      });
      dualRoomId = room.id;

      const teacherRoom = await prisma.teacherRoom.create({
        data: {
          teacherId: dualTeacherId,
          roomId: dualRoomId,
          capacityOverride: 15,
          rentalRate: 30,
        },
      });
      dualTeacherRoomId = teacherRoom.id;

      const cls = await prisma.class.create({
        data: {
          teacherId: dualTeacherId,
          teacherRoomId: dualTeacherRoomId,
          classType: 'Reg API (dual)',
          date: new Date('2099-06-01'),
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents: 5,
          status: 'open',
        },
      });
      dualClassId = cls.id;

      // No studentId in the body: the dual account books itself, through the
      // student path, into the class it also teaches.
      const created = await post(dualToken, { classId: dualClassId });
      const { data } = (await created.json()) as { data: { id: string } };
      dualRegistrationId = data.id;
    });

    afterAll(async () => {
      await prisma.registration.deleteMany({ where: { classId: dualClassId } });
      await prisma.class.deleteMany({ where: { id: dualClassId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: dualTeacherId } });
      await prisma.room.deleteMany({ where: { id: dualRoomId } });
      await prisma.session.deleteMany({ where: { accountId: dualAccountId } });
      await prisma.student.deleteMany({ where: { id: dualStudentId } });
      await prisma.teacher.deleteMany({ where: { id: dualTeacherId } });
      // Not cascaded from the student/teacher deletes above — the account
      // itself must be reclaimed explicitly or it leaks across runs.
      await prisma.account.deleteMany({ where: { id: dualAccountId } });
    });

    it('is a self-read, not the teacher-gated view, even though the account teaches this class', async () => {
      const res = await fetch(`${BASE_URL}/api/registrations/${dualRegistrationId}`, {
        headers: cookie(dualToken),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { tierAtBooking: number } };
      expect(body.data.tierAtBooking).toBeDefined();
    });
  });
});

describe('registration writes return no stored income tier', () => {
  it('POST returns the id and status, and nothing else', async () => {
    const classId = await makeClass(5);
    const res = await post(studentTokens[0]!, { classId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['id', 'status']);
  });

  it('PUT returns the id and status, and nothing else', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['id', 'status']);
  });

  it('DELETE before the deadline returns the id and status, and nothing else', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE',
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['id', 'status']);
    expect(body.data.status).toBe('cancelled');
  });

  it('DELETE past the deadline (late cancel) returns the id and status, and nothing else', async () => {
    const classId = await makeLateCancelClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE',
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['id', 'status']);
    expect(body.data.status).toBe('late_cancel');
  });
});
