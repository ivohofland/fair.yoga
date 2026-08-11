import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { formatDayHeader } from '@/lib/format';

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

// #200. A second cancel fixture, this one WITH a recipient — the notice body
// is what this pins, and the sibling fixture above deliberately has nobody to
// notify.
let noticeClassId: string;

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

  // Local fixture helper — the four class creates below share every field
  // except classType and status. teacherRoom.id is already in scope here, so
  // this closes over it directly rather than reading it back off a
  // module-level let.
  function makeClass(classType: string, status: 'draft' | 'open' = 'draft') {
    return prisma.class.create({
      data: {
        teacherId: ownerId,
        teacherRoomId: teacherRoom.id,
        classType,
        date: new Date('2099-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status,
      },
    });
  }

  // Left in the default `draft` status deliberately: draft cannot transition
  // straight to `completed` or `in_progress`, so the state guard on both
  // routes is reachable here without any registrations/pricing fixtures.
  const cls = await makeClass('Classes API');
  classId = cls.id;

  // Separate draft fixture for the /transition cancel-branch tests: cancelling
  // mutates status away from `draft`, which the tests above depend on staying
  // put. No registrations/waitlist entries here, so the cancel transaction's
  // notification fan-out has nothing to notify (see the cancel test below).
  const cancelCls = await makeClass('Classes API Cancel');
  cancelClassId = cancelCls.id;

  // -- PUT /api/classes/[id] economic-lock fixtures ------------------------
  // Both `open` (not `draft`), but for different reasons. `lockedCls` needs
  // `open` because a real registration requires it (see below — the lock
  // fixture is set by an actual HTTP registration, not a direct write).
  // `economicsCls` is `open` so that it is otherwise IDENTICAL to `lockedCls`
  // — same status, room, rates — differing only in the lock. That identity is
  // what makes the 200-vs-409 pair between them a meaningful contrast, rather
  // than two differently-shaped fixtures that happen to land on different
  // status codes for unrelated reasons.
  const economicsCls = await makeClass('Classes API Lock (unlocked)', 'open');
  economicsClassId = economicsCls.id;

  const lockedCls = await makeClass('Classes API Lock (locked)', 'open');
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

  // `open`, not the file's `draft` default: `registrations/route.ts:126` sets
  // `allowedStatuses = isTeacher ? ['open','in_progress'] : ['open']`, so a
  // student booking a draft class gets a ClassStatusError. Registered over HTTP
  // by the same student the lock fixture uses — `Registration` is unique on
  // (classId, studentId), so a second class is fine, and reusing the student
  // avoids a second account/session/teardown chain.
  const noticeCls = await makeClass('Classes API Notice', 'open');
  noticeClassId = noticeCls.id;

  const noticeRes = await fetch(`${BASE_URL}/api/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(lockStudentToken) },
    body: JSON.stringify({ classId: noticeClassId }),
  });
  if (noticeRes.status !== 201) {
    throw new Error(
      `Fixture setup: expected the notice registration to succeed (201), got ${noticeRes.status}`,
    );
  }
});

afterAll(async () => {
  // registration -> class, per the lock fixtures' FK direction.
  for (const id of [lockedClassId, noticeClassId].filter(Boolean)) {
    await prisma.registration.deleteMany({ where: { classId: id } });
  }
  const allClassIds = [
    classId,
    cancelClassId,
    economicsClassId,
    lockedClassId,
    noticeClassId,
  ].filter(Boolean);
  if (allClassIds.length > 0) {
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: allClassIds } } });
    await prisma.class.deleteMany({ where: { id: { in: allClassIds } } });
  }
  // Guarded like every other delete in this function: an undefined
  // `teacherId` turns `deleteMany` into an unfiltered delete-all across the
  // whole table (not a no-op like `delete` would give you), and a `beforeAll`
  // that throws before `ownerId` is assigned still runs this `afterAll` with
  // it `undefined`. `room.delete` would only throw on an undefined id rather
  // than mass-delete, but that throw aborts the rest of this function before
  // the student cleanup below — guarding it too keeps teardown running to
  // completion instead of stopping partway.
  if (ownerId) {
    await prisma.teacherRoom.deleteMany({ where: { teacherId: ownerId } });
  }
  if (roomId) {
    await prisma.room.delete({ where: { id: roomId } });
  }
  if (lockStudentId) {
    // Self-booking upserts a TeacherStudent link (registrations route) —
    // clean it up before the teacher/student rows go.
    await prisma.teacherStudent.deleteMany({ where: { studentId: lockStudentId } });
    if (lockStudentAccountId) {
      await prisma.session.deleteMany({ where: { accountId: lockStudentAccountId } });
    }
    await prisma.student.delete({ where: { id: lockStudentId } });
    if (lockStudentAccountId) {
      // Student.accountId is the FK — deleting the Student doesn't take the
      // linked Account with it, so this must be explicit or the account
      // (classesapi-lockstudent-*@test.local) leaks every run. Mirrors
      // waitlist-api.test.ts / privacy-api.test.ts / registrations-api.test.ts.
      await prisma.account.deleteMany({ where: { id: lockStudentAccountId } });
    }
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

  /**
   * #200. The body is the only thing that identifies the class to the student.
   * `studentNotificationHref` (`lib/notification-links.ts`) returns a URL only
   * while the class is `open`, so a cancelled class's inbox row is inert even
   * though `relatedClassId` is set — and if the recipient had been on the
   * waitlist, this same transaction closes their entry to `removed`, dropping
   * the class off `/bookings` too.
   *
   * Reachable only over HTTP: the transaction, the recipient fan-out and the
   * body string all live inline in the route handler, so there is no service
   * to call from a unit test.
   */
  it('names the class in the cancellation notice it sends', async () => {
    const res = await transition(ownerToken, noticeClassId, { status: 'cancelled' });
    expect(res.status).toBe(200);

    const note = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'student',
        recipientId: lockStudentId,
        relatedClassId: noticeClassId,
        type: 'class_cancelled',
      },
    });

    // Derived from the fixture, not hard-coded: `makeClass` dates every class
    // 2099-06-01 at 09:00, and `formatDayHeader` is the renderer the other
    // three cancellation bodies use.
    expect(note.body).toContain('Classes API Notice');
    expect(note.body).toContain(formatDayHeader(new Date('2099-06-01')));
    expect(note.body).toContain('09:00');
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
    const before = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
    expect(before.settingsLocked).toBe(false); // sanity: the control fixture for the locked-class cases below

    const res = await put(ownerToken, economicsClassId, { roomCost: 42, minStudents: 2 });
    expect(res.status).toBe(200);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
    expect(Number(updated.roomCost)).toBe(42);
    expect(updated.minStudents).toBe(2);
  });

  it('locked class: economic edit is rejected with 409 naming the fields sent', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(before.settingsLocked).toBe(true); // sanity: the beforeAll fixture registration locked it

    // Body order deliberately reversed from the `ECONOMIC_FIELDS` constant's
    // own declaration order (src/services/class-lifecycle.ts — roomCost
    // before minRate), so the "regardless of the order given in the request
    // body" claim below is actually exercised rather than accidentally true
    // because the two orders match.
    const res = await put(ownerToken, lockedClassId, { minRate: 1, roomCost: 999 });
    expect(res.status).toBe(409);

    // The `locked` branch's 409 message in the route's `PUT` names every sent
    // field, in ECONOMIC_FIELDS order regardless of request-body order. Two
    // separate toContain checks rather than one 'roomCost, minRate' string, so
    // this doesn't depend on ECONOMIC_FIELDS' own declaration order —
    // alphabetizing that array is cosmetic and shouldn't fail this test. Each
    // check still distinguishes this 409 from withErrorHandler's unrelated
    // 'Resource already exists' 409 (src/lib/api-utils.ts) just as well.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('roomCost');
    expect(json.error.message).toContain('minRate');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(Number(after.minRate)).toBe(Number(before.minRate));
  });

  it('locked class: a mixed economic + non-economic body is rejected atomically', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });

    // The lock check inside `updateClass` rejects before any write happens.
    // Nothing pinned that the rejection is all-or-nothing until this case — a
    // future "strip the locked fields and apply the rest" refactor could pass
    // every other case here while quietly changing the contract from atomic
    // rejection to partial apply.
    const res = await put(ownerToken, lockedClassId, { description: 'x', roomCost: 999 });
    expect(res.status).toBe(409);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(after.description).toBe(before.description);
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
    // be empty either way and the `ECONOMIC_FIELDS` lock in `updateClass`
    // would be unreachable regardless of guard order. roomCost makes the two
    // orderings diverge: ownership-first -> 403 "Not your class"; lock-first
    // -> 409 "Cannot update economic fields...".
    const res = await put(otherTeacherToken, lockedClassId, { roomCost: 999 });
    expect(res.status).toBe(403);

    // The ownership guard's own message, in the route's `PUT` ahead of
    // parseBody and the ECONOMIC_FIELDS lock check.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Not your class');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
  });
});

describe('POST /api/classes', () => {
  // otherTeacherId's TeacherRoom and ClassTemplate, playing the victim in the
  // cross-tenant tests below. Created once here rather than inside one `it`
  // because two tests need the room: the templateId test and the
  // teacherRoomId test.
  let victimRoomId: string;
  let victimTemplateId: string;

  beforeAll(async () => {
    const victimRoom = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacherId, roomId, capacityOverride: 8, rentalRate: 15 },
    });
    victimRoomId = victimRoom.id;
    const victimTemplate = await prisma.classTemplate.create({
      data: {
        teacherId: otherTeacherId,
        teacherRoomId: victimRoom.id,
        classType: 'Victim Recurring',
        dayOfWeek: 3,
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
      },
    });
    victimTemplateId = victimTemplate.id;
  });

  // The tests below create real Class rows against `teacherRoomId` (the
  // owner's fixture from the top-level beforeAll) and the beforeAll above
  // creates a dedicated TeacherRoom/ClassTemplate for otherTeacherId to play
  // the victim. None of that is covered by `allClassIds` or the top-level
  // afterAll above, so left behind it FK-blocks that afterAll's own
  // `teacherRoom.deleteMany({ where: { teacherId: ownerId } })` (still
  // referenced by the Class rows here) and, transitively, the room delete and
  // otherTeacherId's teardown (still referenced by the victim TeacherRoom).
  // Cleaned up here by the deterministic values the tests below set — not by
  // capturing ids — so the `it` bodies stay exactly as specified.
  //
  // Each delete is isolated for the same reason the top-level afterAll guards
  // every one of its deletes (see its comment, "keeps teardown running to
  // completion instead of stopping partway"): a throw in the first would skip
  // the other two, and the top-level hook would then FK-violate on
  // `teacherRoom.deleteMany` — the exact failure this hook exists to prevent.
  afterAll(async () => {
    const failures: unknown[] = [];
    const steps: Array<() => Promise<unknown>> = [
      // Both rooms, not just the owner's: if the teacherRoomId guard ever
      // regresses, the test that catches it will have left a Class bound to
      // the victim room, and a filter on the owner's room alone would miss it
      // and FK-block the victim TeacherRoom delete two steps down. Measured
      // that exact leak while proving the guard bites.
      () => {
        const roomIds = [teacherRoomId, victimRoomId].filter(Boolean);
        return roomIds.length > 0
          ? prisma.class.deleteMany({
              where: { teacherRoomId: { in: roomIds }, classType: 'Create Route' },
            })
          : Promise.resolve();
      },
      () =>
        otherTeacherId
          ? prisma.classTemplate.deleteMany({
              where: { teacherId: otherTeacherId, classType: 'Victim Recurring' },
            })
          : Promise.resolve(),
      () =>
        otherTeacherId && roomId
          ? prisma.teacherRoom.deleteMany({ where: { teacherId: otherTeacherId, roomId } })
          : Promise.resolve(),
    ];
    for (const step of steps) {
      try {
        await step();
      } catch (err) {
        failures.push(err);
      }
    }
    // Reported, not swallowed — a teardown that fails silently leaves the next
    // run's fixtures to collide with rows nobody knows are there.
    if (failures.length > 0) {
      throw new AggregateError(failures, 'POST /api/classes teardown left rows behind');
    }
  });

  const baseBody = () => ({
    teacherRoomId,
    classType: 'Create Route',
    date: '2099-08-01',
    startTime: '10:00',
    durationMinutes: 60,
    roomCost: 15,
    minRate: 10,
    targetRate: 20,
    minStudents: 1,
    maxStudents: 8,
  });

  const post = (token: string, body: unknown) =>
    fetch(`${BASE_URL}/api/classes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    });

  it('creates a class against the calling teacher', async () => {
    const res = await post(ownerToken, baseBody());
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.class.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.teacherId).toBe(ownerId);
    expect(created.templateId).toBeNull();
  });

  // #146. templateId is server-set — class-generator.ts writes it when a
  // template materialises an instance, and no creation UI renders it. Sending
  // another teacher's template id used to squat the (templateId, date) unique
  // pair, which silently stops the victim's generator from ever filling that
  // date.
  it("ignores another teacher's templateId instead of attaching it", async () => {
    const res = await post(ownerToken, { ...baseBody(), templateId: victimTemplateId });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.class.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.templateId).toBeNull();

    // The victim's own generation window is untouched. Both assertions here
    // rest on an absence, and `Class.templateId` is `onDelete: SetNull` — so a
    // cascaded template delete would produce the same null and the same zero
    // count. Not reachable today; this removes the ambiguity anyway.
    expect(
      await prisma.classTemplate.findUnique({ where: { id: victimTemplateId } }),
    ).not.toBeNull();
    expect(await prisma.class.count({ where: { templateId: victimTemplateId } })).toBe(0);
  });

  // The route's `teacherRoom.teacherId !== session.teacherId` check is this
  // endpoint's only ownership guard, and the server-owned-fields register
  // explicitly disclaims `teacherRoomId` — so nothing else covers it. Weakened
  // to `if (!teacherRoom)` every other test in this file still passed, while a
  // teacher could bind a class to another teacher's TeacherRoom, whose
  // `rentalRate` is never shared between teachers and which
  // `class/[id]/page.tsx` renders via `teacherRoom → room`.
  it("refuses another teacher's teacherRoomId", async () => {
    const res = await post(ownerToken, { ...baseBody(), teacherRoomId: victimRoomId });
    expect(res.status).toBe(400);
    expect(await prisma.class.count({ where: { teacherRoomId: victimRoomId } })).toBe(0);
  });

  // The sibling route treats the two arms as distinct
  // (class-templates-api.test.ts), and so does this one: an unknown id and a
  // known id owned by someone else fail on different halves of the same
  // condition.
  it('refuses an unknown teacherRoomId', async () => {
    const res = await post(ownerToken, { ...baseBody(), teacherRoomId: UNKNOWN_CLASS_ID });
    expect(res.status).toBe(400);
  });
});
