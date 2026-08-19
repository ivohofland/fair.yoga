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

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`
 * once the counter below crosses 60. `startTime` is a plain `String` with no
 * CHECK constraint, occupancy is string equality, and
 * `Class_teacher_slot_unique` compares strings too — so a raw `09:${counter}`
 * literal would accept an out-of-range value silently instead of exercising
 * the constraint this file's counter exists to dodge collisions with.
 * Mirrors `class-template-lifecycle.test.ts`'s `slotTime`.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

// Every class this helper creates shares ownerId, the same 2099-06-01 date,
// and `status: 'open'` — none of that is what any test here cares about,
// it is just "a class far enough out that cancel-deadline logic never
// triggers". Class_teacher_slot_unique is (teacherId, date, startTime)
// WHERE status <> 'cancelled', though, and this file calls makeClass 23
// times, so a shared literal startTime would let only the first through.
// A counter-derived minute keeps every call on its own slot without any
// caller needing to know or care what time its class landed on.
let makeClassCounter = 0;

async function makeClass(maxStudents: number): Promise<string> {
  const startTime = slotTime(makeClassCounter++);
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
/**
 * A class close enough that its cancel deadline has already passed, so a
 * student's DELETE takes the `late_cancel` branch.
 *
 * `minuteOffset` is required and must differ per caller:
 * `Class_teacher_slot_unique` (#196 branch 1) forbids one teacher two live
 * classes at one `(date, startTime)`, and `startTime` here is truncated to
 * `HH:MM`, so two callers in the same minute collide on the index rather than
 * on anything the test is about. Any offset is safe — the deadline is hours
 * behind either way.
 */
async function makeLateCancelClass(maxStudents: number, minuteOffset: number): Promise<string> {
  const target = new Date(Date.now() + 3 * 60 * 60 * 1000 + minuteOffset * 60 * 1000);
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

  /**
   * Whole-branch review of #216/#182. `closeQueueOnStart` flips every
   * `waiting` row to `expired` in the same transaction as the class's
   * `in_progress` write — including the row of a student who is about to be
   * walked in at the door. The entry-resolution read a few lines above this
   * test's assertions used to match `status: 'waiting'` only, so it returned
   * null for that row, and the queued student kept a live, billed
   * `Registration` next to a `WaitlistEntry` stuck on `expired` with no
   * `registrationId` — which `exportStudentData` (`gdpr.ts`) would then
   * publish verbatim as "never got in", for a class the student attended and
   * paid for.
   */
  it('walks in a queued student whose entry was closed by the class starting — resolves to claimed, not left expired', async () => {
    const classId = await makeClass(1);
    const fill = await post(studentTokens[0]!, { classId });
    expect(fill.status).toBe(201);

    // Student 1 queues on the full class.
    await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[1]!, position: 1, status: 'waiting' },
    });

    // The class starts through the real production path —
    // `POST .../transition` → `transitionClass` (`class-lifecycle.ts`) — not
    // a direct prisma write, so this exercises the actual mechanism that
    // flips the entry to `expired`, the same one the sweep and
    // `completeClass` share.
    const transitioned = await fetch(`${BASE_URL}/api/classes/${classId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(transitioned.status).toBe(200);
    const expired = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
    });
    expect(expired.status).toBe('expired');

    // Student 1 turns up at the door; the teacher walks them in.
    const walkIn = await post(ownerToken, { classId, studentId: studentIds[1] });
    expect(walkIn.status).toBe(201);
    const walkInJson = (await walkIn.json()) as { data: { id: string } };

    // The entry must resolve to `claimed` with the new registration linked.
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
    });
    expect(entry.status).toBe('claimed');
    expect(entry.registrationId).toBe(walkInJson.data.id);
  });

  /**
   * The boundary of the set above, which nothing pinned: broadening the
   * resolver to include `removed` passed the entire suite.
   *
   * `removed` means a decision was already made ABOUT this student — they left
   * the queue themselves, or a cancel path (#195) closed it. Resolving that to
   * `claimed` would assert the opposite of what happened, in a status
   * `exportStudentData` publishes verbatim. `expired` is the only closed status
   * that means "never got in YET", which is the one story a walk-in can still
   * make true.
   *
   * The walk-in itself must still succeed — the teacher's decision at the door
   * is not the waitlist's to veto. What must not happen is the entry being
   * rewritten to say they claimed a spot they had already given up.
   */
  it('walks in a student who had LEFT the queue without rewriting their removed entry', async () => {
    const classId = await makeClass(1);
    const fill = await post(studentTokens[0]!, { classId });
    expect(fill.status).toBe(201);

    await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[1]!, position: 1, status: 'removed' },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    const walkIn = await post(ownerToken, { classId, studentId: studentIds[1] });
    expect(walkIn.status).toBe(201);

    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: studentIds[1]! } },
    });
    expect(entry.status).toBe('removed');
    expect(entry.registrationId).toBeNull();
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

  /**
   * #104. The booking path took an unbounded inline `FOR UPDATE` until this
   * change. It is the case the issue calls sharpest: a student clicking Book,
   * on a path with no bound on its wait.
   *
   * Asserted at the HTTP surface rather than the service, because the point is
   * the contract a student meets — a retryable 503, not a 500 and not a
   * request that occupies a pool connection for the holder's full duration.
   * `withErrorHandler` routes the `55P03` through `isTransientDbError`.
   *
   * The 3.5s hold sits above the 2s bound and below Prisma's 5s default
   * budget, so reverting the route to its inline statement makes this request
   * SUCCEED at 3.5s with a 201 — which is what makes this a guard rather than
   * a description. The status assertion is therefore the whole discriminator
   * between "gave up at 2s" and "waited the holder out": waiting it out does
   * not produce a slow 503, it produces the ordinary 201.
   *
   * `waited > 1_000` is the second half and is not decoration. The 503 body is
   * a fixed generic string, so the SQLSTATE is genuinely not observable over
   * HTTP — and `P2024` (pool timeout) is also in `TRANSIENT_PRISMA_CODES` and
   * also classifies 503, so without a lower bound any fast transient 503 would
   * satisfy this test.
   *
   * No upper bound. One was here (`toBeLessThan(3_400)`), and it had exactly
   * one sliver of unique coverage: a `lock_timeout` configured between 3.4s
   * and 3.5s — say 3.45s — still sits below the 3.5s hold, so the request is
   * still refused with a 503 well inside `waited > 1_000`, and the ceiling
   * was the only assertion here that would have caught it. Every other
   * timeout value, and every reordering inside `lockClassRow`, reddens the
   * status assertion first, because a wait that reaches 3.5s acquires the row
   * and succeeds with a 201. That one sliver is already pinned directly —
   * `db-locks.test.ts` asserts the literal `LOCK_TIMEOUT_SQL` value and
   * observes the effect via `SHOW lock_timeout` — so against a bound already
   * covered elsewhere, all the ceiling contributed was a ~1400ms overhead
   * budget on a 2-4 core CI box running three vitest projects, the one flake
   * surface in this guard: a wait that reads as "the bound didn't fire" when
   * the bound fired correctly. The timeout's VALUE is pinned by
   * `db-locks.test.ts`; a wall-clock ceiling here never pinned it.
   */
  it('answers 503 rather than blocking when another transaction holds the class row', async () => {
    const classId = await makeClass(5);

    let signalHeld!: () => void;
    const held = new Promise<void>((r) => {
      signalHeld = r;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
        signalHeld();
        await new Promise((r) => setTimeout(r, 3_500));
      },
      { timeout: 30_000 },
    );
    await held;

    const startedAt = Date.now();
    const res = await post(studentTokens[0]!, { classId });
    const waited = Date.now() - startedAt;

    await holder;

    expect(res.status).toBe(503);
    expect(waited).toBeGreaterThan(1_000);
  }, 20_000);
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

  /**
   * The stale-render case, which is the ordinary one rather than an edge: the
   * student's `/bookings` tab rendered while their entry was `waiting`, the
   * class then started, and `closeQueueOnStart` (#216) flipped the row to
   * `expired`. They tap "Leave waitlist" against a page that no longer matches
   * the database.
   *
   * 404 "Waitlist entry not found" would be a false statement about a row the
   * student is looking at and will find again in their own Article 15 export.
   * The write is still correctly refused — that part was never in doubt — but
   * the answer has to distinguish "gone" from "no longer yours to leave".
   */
  it('409s leaving a queue that closed under the student, without denying the entry exists', async () => {
    const classId = await makeClass(1);
    const entry = await prisma.waitlistEntry.create({
      data: { classId, studentId: studentIds[0]!, position: 1, status: 'expired' },
    });

    const res = await del(studentTokens[0]!, entry.id);

    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('no longer active');
    expect(json.error.message).not.toContain('not found');

    // Still refused, and still `expired` — "never got in" must not become
    // "withdrew" on the way to a better error message.
    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.status).toBe('expired');
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
    const classId = await makeLateCancelClass(5, 0);
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

describe('PUT /api/registrations/[id] — attendance is scoped by source status (#182)', () => {
  /**
   * The moves this endpoint refuses, and only while the class is still `open`.
   *
   * `late_cancel` is outside `ACTIVE_REGISTRATION_STATUSES`; `attended` AND
   * `no_show` are both inside it. So there are TWO schema-accepted transitions
   * that raise the seat count, not one — a fact worth pinning, because the
   * guard works by scoping the SOURCE and would silently lose half its coverage
   * if anyone re-keyed it on the target. A rise landing between
   * `autoCancelClasses`' count and its CAS cancels a class that had enough
   * students. That sweep selects `status: 'open'`, so `open` is the entire
   * window in which the race exists.
   */
  it('409s marking a late-cancelled student attended while the class is still open', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'late_cancel', tierAtBooking: 3 },
    });
    const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(409);
    // The MESSAGE, not just the code. The defect this replaced was a refusal
    // whose reason never reached the teacher, so a 409 with unhelpful copy
    // would be only half a fix — and swapping the two `respondError` bodies in
    // the route is otherwise green.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('once the class has started');
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('late_cancel');
  });

  /**
   * The second half of that pair, and the reason it is a separate test: keying
   * the guard on `parsed.data.status === 'attended'` — a natural-looking
   * simplification — passes every other test in this file while reopening the
   * `autoCancelClasses` race through this transition.
   */
  it('409s marking a late-cancelled student a no-show while the class is still open', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'late_cancel', tierAtBooking: 3 },
    });
    const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'no_show' }),
    });
    expect(res.status).toBe(409);
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('late_cancel');
  });

  /**
   * The other side of that boundary, and a REAL shipped flow rather than a
   * hypothetical: a student late-cancels, turns up anyway, and the teacher lets
   * them in. `activeRegistrations` (`class/[id]/page.tsx`) keeps `late_cancel`
   * rows deliberately, so the check-in list renders them with a live checkbox.
   *
   * Once the class is `in_progress`, `autoCancelClasses` no longer looks at it
   * — that sweep both selects and CASes on `status: 'open'` — so the count race
   * this scope exists to close cannot happen, and refusing the write would only
   * stop a teacher recording what actually happened in their own room. Nobody's
   * price moves either: `late_cancel` and `attended` are both in
   * `CHARGED_STATUSES`, so the pricing divisor is identical before and after.
   */
  it('allows a late-cancelled student to be marked attended once the class has started', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'late_cancel', tierAtBooking: 3 },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(200);
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('attended');
  });

  /**
   * Pins the OTHER half of the source scope. Written because the sibling half
   * was already known to be insufficient on its own: `registrations-api.test.ts`'s
   * "does not let a raced late cancel rewrite a free cancel into a charged one"
   * exists precisely because an earlier reviewer found `notIn: ['late_cancel']`
   * surviving on the DELETE branch. Narrowing this WHERE the same way would make
   * `cancelled -> attended` reachable — resurrecting a registration the student
   * or teacher already cancelled, and moving it INTO the counted set.
   *
   * On an `in_progress` class deliberately, so the refusal can only be about the
   * REGISTRATION's status: the class-status clause is satisfied here.
   */
  it('409s attendance on a cancelled registration', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'cancelled', tierAtBooking: 3 },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(409);
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('cancelled');
  });

  it('409s attendance on a cancelled class', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });
    // Cancelled AFTER the registration exists: a cancelled class cannot be booked.
    await prisma.class.update({ where: { id: classId }, data: { status: 'cancelled' } });

    const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(409);
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('registered');
  });

  /**
   * A PRODUCT requirement pinned as a test, not a defect guard.
   *
   * A teacher does attendance admin AFTER the class, not during it: someone
   * arrives a minute late, is let in, and nobody stops to tap a checkbox. This
   * assertion exists so a future lock-discipline pass cannot quietly reject
   * `completed` alongside `cancelled` on the grounds that both are terminal.
   *
   * It is safe because all three values `updateRegistrationSchema` accepts are
   * in `CHARGED_STATUSES` (`class-lifecycle.ts`), so a correction made after
   * completion cannot change who is billed or by how much.
   */
  it('allows attendance corrections on a completed class', async () => {
    const classId = await makeClass(4);
    const reg = await prisma.registration.create({
      data: { classId, studentId: studentIds[0]!, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'completed' } });

    const res = await fetch(`${BASE_URL}/api/registrations/${reg.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'no_show' }),
    });
    expect(res.status).toBe(200);
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: reg.id } });
    expect(after.status).toBe('no_show');
  });
});

describe('registration cancel is retry-safe against a concurrent duplicate (#196)', () => {
  // A dedicated UTC teacher so the window math is plain UTC arithmetic, the
  // same convention as the resolve describe in invitations-api.test.ts.
  // No teacher token: every request in this block is the student cancelling
  // their own registration, which is the path with the deadline branch.
  let raceTeacherId: string;
  let raceTeacherAccountId: string;
  let raceRoomId: string;
  let raceTeacherRoomId: string;

  const cancellerEmail = `race-canceller-${suffix}@test.local`;
  let cancellerId: string;
  let cancellerAccountId: string;
  let cancellerToken: string;

  const waiterEmail = `race-waiter-${suffix}@test.local`;
  let waiterId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Race', lastName: 'Cancel',
        email: `race-cancel-teacher-${suffix}@test.local`,
        account: { create: { email: `race-cancel-teacher-${suffix}@test.local` } },
        bio: 'Teacher for concurrent-cancel tests',
        pageSlug: `race-cancel-teacher-${suffix}`,
        defaultTimezone: 'UTC',
      },
    });
    raceTeacherId = teacher.id;
    raceTeacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Race Cancel Studio', address: `${suffix} Race Cancel St`,
        city: 'Testville', postcode: '1234RC', maxCapacity: 5, createdById: raceTeacherId,
      },
    });
    raceRoomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: raceTeacherId, roomId: raceRoomId, capacityOverride: 5, rentalRate: 20 },
    });
    raceTeacherRoomId = teacherRoom.id;

    const canceller = await prisma.student.create({
      data: {
        firstName: 'Race', lastName: 'Canceller', email: cancellerEmail,
        claimedAt: new Date(), account: { create: { email: cancellerEmail } }, incomeTier: 3,
      },
      select: { id: true, accountId: true },
    });
    cancellerId = canceller.id;
    cancellerAccountId = canceller.accountId as string;
    cancellerToken = await seedSession(prisma, cancellerAccountId);

    const waiter = await prisma.student.create({
      data: { firstName: 'Race', lastName: 'Waiter', email: waiterEmail, incomeTier: 3 },
      select: { id: true },
    });
    waiterId = waiter.id;
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: raceClassIds } } });
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [cancellerId, waiterId] } },
    });
    await prisma.registration.deleteMany({ where: { classId: { in: raceClassIds } } });
    await prisma.class.deleteMany({ where: { id: { in: raceClassIds } } });
    await prisma.teacherRoom.deleteMany({ where: { id: raceTeacherRoomId } });
    await prisma.room.deleteMany({ where: { id: raceRoomId } });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId: raceTeacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: raceTeacherId } });
    await prisma.invitation.deleteMany({ where: { teacherId: raceTeacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: raceTeacherId } });
    await prisma.session.deleteMany({ where: { accountId: cancellerAccountId } });
    await prisma.student.deleteMany({ where: { id: { in: [cancellerId, waiterId] } } });
    await prisma.account.deleteMany({ where: { id: cancellerAccountId } });
    await prisma.teacher.deleteMany({ where: { id: raceTeacherId } });
    await prisma.account.deleteMany({ where: { id: raceTeacherAccountId } });
  });

  // The classes each test creates, swept in the afterAll above.
  const raceClassIds: string[] = [];

  /**
   * A class with `now` half an hour inside the final-hour broadcast window,
   * a registration for the canceller, and a waitlist entry for the waiter.
   *
   * `target` = now + 48h30m with a HOURS_48 deadline puts `deadline` at
   * now + 30m and `cutoff` at now − 30m, so `now` sits inside
   * `first_come_first_claimed`, where `handleSpotFreed` broadcasts instead
   * of auto-promoting. Computed from the clock rather than hard-coded: the
   * window is relative, so a fixed date would drift out of it.
   *
   * `minuteOffset` is required, with no default, because every caller needs a
   * DIFFERENT one: `Class_teacher_slot_unique` (#196 branch 1) forbids one
   * teacher two live classes at the same `(date, startTime)`, and `startTime`
   * here is truncated to `HH:MM`, so two fixtures built in the same minute
   * would collide on the index rather than on anything this block is testing.
   * Same reasoning as the `startTime`-without-a-default rule the slot blocks
   * in `classes-api.test.ts` adopted.
   *
   * Valid offsets are `(−30, +30]` minutes: the window holds while
   * `cutoff ≤ now < deadline`, which works out to `offset ≤ 30` on one side
   * and `offset > −30` on the other.
   */
  async function makeBroadcastFixture(minuteOffset: number) {
    const target = new Date(Date.now() + 48 * 60 * 60 * 1000 + (30 + minuteOffset) * 60 * 1000);
    const date = target.toISOString().slice(0, 10);
    const startTime = target.toISOString().slice(11, 16);

    const cls = await prisma.class.create({
      data: {
        teacherId: raceTeacherId, teacherRoomId: raceTeacherRoomId,
        classType: 'Race Cancel', date: new Date(`${date}T00:00:00Z`), startTime,
        durationMinutes: 60, roomCost: 20, minRate: 30, targetRate: 60,
        minStudents: 1, maxStudents: 1, cancelDeadline: 'HOURS_48',
        autoCancelCheck: 'HOURS_2', status: 'open',
      },
    });
    raceClassIds.push(cls.id);
    const reg = await prisma.registration.create({
      data: { classId: cls.id, studentId: cancellerId, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiterId, position: 1, status: 'waiting' },
    });
    return { classId: cls.id, registrationId: reg.id };
  }

  it('broadcasts one spot_available set when the same cancel arrives twice at once', async () => {
    const { classId, registrationId } = await makeBroadcastFixture(0);

    // The two plain fetches in Promise.all serialised on the first run —
    // the second request landed after the first committed, so its PRE-CHECK
    // (not the guard under test) returned the 409 and the test passed green
    // against the bug. The deterministic lever from Task 1 fixes that: a
    // holder takes the registration row lock BEFORE either request runs, so
    // both pass the pre-check (uncommitted state is invisible under READ
    // COMMITTED) and both park on the lock at the write — the interleaving
    // a plain Promise.all cannot force.
    const holder = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    // The handshake, without which the lever is decorative: `$transaction`
    // returns before its callback has run, and a fresh PrismaClient has to
    // connect and start its engine first, so the requests below can finish
    // before the lock is ever taken.
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;
      locked();
      await released;
    }, { timeout: 20_000 });
    await parked;

    const del = () => fetch(`${BASE_URL}/api/registrations/${registrationId}`, {
      method: 'DELETE', headers: cookie(cancellerToken),
    });
    const both = Promise.all([del(), del()]);

    // Long enough that both requests have read `registered` and parked on
    // the holder's lock, short enough not to approach any timeout.
    let settled = false;
    void both.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));

    // The lever is asserted, not assumed. Without this, a slow route compile
    // or a loaded machine lets both requests finish BEFORE the release, the
    // second one 409s off its own pre-check instead of the guard under test,
    // and the whole test goes green against the bug — which is exactly how
    // this block's first draft passed before the fix existed.
    expect(settled).toBe(false);
    release();
    await holding;
    const [a, b] = await both;
    await holder.$disconnect();

    // Asserted before the status pair, deliberately: the doubled broadcast is
    // the defect — every waiting student notified twice for one freed seat —
    // and this is the assertion whose failure message names it. With the
    // statuses first, removing the guard fails on `[200, 200]`, which reports
    // that two cancels succeeded without saying what that cost anyone.
    const notifications = await prisma.notification.findMany({
      where: { relatedClassId: classId, recipientId: waiterId, type: 'spot_available' },
    });
    expect(notifications).toHaveLength(1);

    // Either request can win, so the loser is identified rather than assumed.
    expect([a.status, b.status].sort()).toEqual([200, 409]);
  });

  it('409s the loser when two late cancels race', async () => {
    // The late-cancel branch, which the fixture above cannot reach — it places
    // `now` BEFORE the deadline on purpose, so both its cases take the
    // full-cancel path. This branch shipped without its scope for exactly that
    // reason: the comment claimed a guard no test could observe.
    //
    // Scoped deliberately to the duplicate-cancel contract, and named for it.
    // An earlier version of this test was called "does not let a raced late
    // cancel rewrite a free cancel into a charged one" and could not fail
    // against that: narrowing the guard to `notIn: ['late_cancel']` leaves the
    // money bug live and still produces [200, 409] here, because both racers
    // start from `registered`. The money case needs a different starting
    // state, and it is the test below.
    const classId = await makeLateCancelClass(5, 20);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const holder = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${data.id} FOR UPDATE`;
      locked();
      await released;
    }, { timeout: 20_000 });
    await parked;   // see the case above for why this handshake is required

    const del = () => fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE', headers: cookie(studentTokens[0]!),
    });
    const both = Promise.all([del(), del()]);

    let settled = false;
    void both.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);
    release();
    await holding;
    const [a, b] = await both;
    await holder.$disconnect();

    // One cancel, one refusal — the contract the full-cancel branch already
    // honours, asserted here so the two branches cannot drift apart.
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    const after = await prisma.registration.findUniqueOrThrow({ where: { id: data.id } });
    expect(after.status).toBe('late_cancel');
  });

  it('does not let a raced late cancel rewrite a free cancel into a charged one', async () => {
    // The money case, and the reason the late-cancel scope lists BOTH
    // terminal statuses rather than just its own. `late_cancel` is in
    // CHARGED_STATUSES (`class-lifecycle.ts`) and `cancelled` is not, so a
    // late cancel landing on top of a free one bills a student for a class
    // someone had already let them out of.
    //
    // Two racing late cancels cannot show this — they both start from
    // `registered`, so a guard that only excludes `late_cancel` still answers
    // [200, 409]. The starting state has to be `cancelled`, and it has to
    // arrive while the student's write is already parked, or the pre-check
    // catches it and the CAS is never reached. So the holder takes the row,
    // lets the student's request park on it, and only then commits the free
    // cancel.
    const classId = await makeLateCancelClass(5, 40);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const holder = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = holder.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${data.id} FOR UPDATE`;
      locked();
      await released;
      // The free cancel — a teacher letting this student out — committing
      // underneath a late cancel that has already passed its pre-check.
      await tx.registration.update({
        where: { id: data.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
    }, { timeout: 20_000 });
    await parked;

    const lateCancel = fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE', headers: cookie(studentTokens[0]!),
    });

    let settled = false;
    void lateCancel.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 1000));
    expect(settled).toBe(false);
    release();
    await holding;
    const res = await lateCancel;
    await holder.$disconnect();

    // The money assertion first: this is the one whose failure names the harm.
    // Postgres re-checks a blocked UPDATE's WHERE against the newly committed
    // row, so the scope is what turns this into a no-op instead of a charge.
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: data.id } });
    expect(after.status).toBe('cancelled');

    expect(res.status).toBe(409);
  }, 20_000);

  it('409s a second cancel of a registration already cancelled', async () => {
    const { registrationId } = await makeBroadcastFixture(10);

    const first = await fetch(`${BASE_URL}/api/registrations/${registrationId}`, {
      method: 'DELETE', headers: cookie(cancellerToken),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${BASE_URL}/api/registrations/${registrationId}`, {
      method: 'DELETE', headers: cookie(cancellerToken),
    });
    expect(second.status).toBe(409);
  });
});
