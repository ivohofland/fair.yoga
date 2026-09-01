import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type ClassStatus } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { formatDayHeader } from '@/lib/format';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

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
// notify. Two recipients, in fact: the route fans out to
// `[...registrations, ...waiting]`, and the waiting half was reachable by no
// test in the repo before this one.
let noticeClassId: string;
let waitStudentId: string;

// Dedicated fixtures for the PUT /api/classes/[id] economic-lock tests —
// kept separate from classId/cancelClassId above, which the existing tests
// depend on staying in `draft`.
let economicsClassId: string;
let lockedClassId: string;
let lockStudentId: string;
let lockStudentAccountId: string | null;

// #247: a terminal fixture for the PUT freeze. `completed` is written directly
// because it is an INPUT precondition, not the behaviour under test — driving
// it through POST …/complete would need registrations and pricing fixtures to
// prove something this test does not claim.
let completedClassId: string;
let cancelledTerminalClassId: string;

// #249. Live, and dated behind every clock this suite will run under. The
// sibling fixtures are 2099; this is the other side of "now".
let pastDraftClassId: string;

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

  // Local fixture helper — the class creates below share every field except
  // classType, status and startTime. teacherRoom.id is already in scope
  // here, so this closes over it directly rather than reading it back off a
  // module-level let.
  //
  // startTime has no default: all five calls below land on the same ownerId
  // + date, and the slot constraint rejects a second live entry whose span
  // overlaps — `CalendarEntry_teacher_slot_excl` since #327, where "live" is
  // `"cancelledAt" IS NULL` and every status counts. Measured under its
  // predecessor: five calls at a shared default collide on the second one,
  // throwing before a single test in this file runs. A required parameter is
  // what stops a forgetful sixth caller reopening that collision — the
  // sibling helpers in this directory (`templateBody` in
  // class-templates-api.test.ts, `makeTemplate` in studio-api.test.ts)
  // dropped their own defaults for the same reason.
  // `state` is `ClassStatus` plus `'cancelled'` (#327): a cancelled class
  // keeps a live status and carries `cancelledAt` on its entry, so the fixture
  // takes the freeze the test wants and decides which row holds it.
  function makeClass(classType: string, state: ClassStatus | 'cancelled', startTime: string) {
    return createClassFixture(prisma, {
        teacherId: ownerId,
        teacherRoomId: teacherRoom.id,
        classType,
        date: new Date('2099-06-01'),
        startTime: hhmmToTime(startTime),
        // 15 minutes, matching the spacing callers use (09:00, 09:15, 09:30
        // …): `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since
        // #327, where the key it replaced refused only an identical start
        // time. Nothing here reads the duration.
        durationMinutes: 15,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: state === 'cancelled' ? 'open' : state,
        cancelledAt: state === 'cancelled' ? new Date() : null,
      });
  }

  // Left in the default `draft` status deliberately: draft cannot transition
  // straight to `completed` or `in_progress`, so the state guard on both
  // routes is reachable here without any registrations/pricing fixtures.
  const cls = await makeClass('Classes API', 'draft', '09:00');
  classId = cls.id;

  // Separate draft fixture for the `POST …/cancel` tests. Cancellation is a
  // column on the entry since #327 and leaves `status` at `draft`, but every
  // status writer's CAS carries `calendarEntry: { cancelledAt: null }` — so a
  // cancelled class refuses every transition, which is what the tests above
  // need `classId` to stay available for. No registrations/waitlist entries
  // here, so the cancel transaction's notification fan-out has nothing to
  // notify (see the cancel test below).
  const cancelCls = await makeClass('Classes API Cancel', 'draft', '09:15');
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
  const economicsCls = await makeClass('Classes API Lock (unlocked)', 'open', '09:30');
  economicsClassId = economicsCls.id;

  const lockedCls = await makeClass('Classes API Lock (locked)', 'open', '09:45');
  lockedClassId = lockedCls.id;

  const completedCls = await makeClass('Classes API Terminal (#247)', 'completed', '10:15');
  completedClassId = completedCls.id;

  // The cancelled side of the freeze. `updateClass` answers `reason:
  // 'terminal'` carrying a `TerminalClassState` (`class-lifecycle.ts`) —
  // `ClassStatus | 'cancelled'` rather than a `ClassStatus` since #327,
  // because a cancelled class keeps whatever live status it had and carries
  // `cancelledAt` on its entry — and the route interpolates that value
  // straight into the 409. `frozenStateOf` picks between a
  // `TERMINAL_CLASS_STATUSES` member and `'cancelled'`; one fixture per side
  // of that choice, so neither half of the rendered message goes unasserted.
  const cancelledCls = await makeClass('Classes API Terminal cancelled (#247)', 'cancelled', '10:30');
  cancelledTerminalClassId = cancelledCls.id;

  // #249. Past-dated draft for the publish-guard test.
  const pastLive = await createClassFixture(prisma, {
      teacherId: ownerId,
      teacherRoomId: teacherRoom.id,
      classType: 'Past Live',
      date: new Date('2020-01-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'draft',
    });
  pastDraftClassId = pastLive.id;

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

  // `open`, not the file's `draft` default: `registrations/route.ts`'s
  // `allowedStatuses = isTeacher ? ['open','in_progress'] : ['open']`, so a
  // student booking a draft class gets a ClassStatusError. Registered over HTTP
  // by the same student the lock fixture uses — `Registration` is unique on
  // (classId, studentId), so a second class is fine, and reusing the student
  // avoids a second account/session/teardown chain.
  const noticeCls = await makeClass('Classes API Notice', 'open', '10:00');
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

  // A second recipient, on the waitlist rather than registered. Written
  // directly rather than through `POST /api/waitlist`: the route under test
  // only reads the row, and `addToWaitlist` would refuse to queue anyone on a
  // class that is not full (`maxStudents` is 8 here). No session needed —
  // this student never makes a request, they only receive a notification.
  const waitStudentEmail = `classesapi-waitstudent-${suffix}@test.local`;
  const waitStudent = await prisma.student.create({
    data: { firstName: 'Wait', lastName: 'Student', email: waitStudentEmail, incomeTier: 3 },
  });
  waitStudentId = waitStudent.id;
  await prisma.waitlistEntry.create({
    data: { classId: noticeClassId, studentId: waitStudentId, position: 1, status: 'waiting' },
  });
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
    completedClassId,
    cancelledTerminalClassId,
    pastDraftClassId,
  ].filter(Boolean);
  if (allClassIds.length > 0) {
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: allClassIds } } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: allClassIds } } } } });
  }
  // Guarded like every other delete in this function: an undefined
  // `teacherId` turns `deleteMany` into an unfiltered delete-all across the
  // whole table (not a no-op like `delete` would give you), and a `beforeAll`
  // that throws before `ownerId` is assigned still runs this `afterAll` with
  // it `undefined`. `room.delete` would only throw on an undefined id rather
  // than mass-delete, but that throw aborts the rest of this function before
  // the student cleanup below — guarding it too keeps teardown running to
  // completion instead of stopping partway.
  //
  // The waitlist-entry and class sweep below is the same guard applied to a
  // teacher-scoped backstop rather than a single id: the queue-close test
  // above (#216) creates its own class + waitlist entry outside
  // `allClassIds`, cleaning up after itself on the happy path — but a failing
  // run (mutation-tested ones included) can exit before reaching that inline
  // cleanup, leaving a class that still references `teacherRoomId` and would
  // fail the `teacherRoom.deleteMany` below on an FK violation. Same shape as
  // `class-lifecycle.test.ts`'s `transitionClass (DB)` afterAll guards
  // against. The waitlist entries are deleted too, but not because they
  // FK-reference the class: `WaitlistEntry.class` is `onDelete: Cascade`
  // (`prisma/schema.prisma`), so a queue row disappears with its class
  // whether or not this line runs — and the `calendarEntry.deleteMany` below
  // takes the classes with it. It is harmless and mildly defensive,
  // nothing more — the actual FK risk below is the surviving `Class` row
  // against `teacherRoom`/`room`, which is what the ordering above guards.
  if (ownerId) {
    await prisma.waitlistEntry.deleteMany({ where: { class: { calendarEntry: { teacherId: ownerId } } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId: ownerId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: ownerId } });
  }
  if (roomId) {
    await prisma.room.delete({ where: { id: roomId } });
  }
  if (waitStudentId) {
    // `WaitlistEntry.class` cascades, so the entry goes with the class delete
    // above — but the notification does not (it is keyed on recipient, and its
    // `relatedClassId` is covered by `allClassIds`), and the student row never
    // would. No account/session: this fixture never authenticates.
    await prisma.student.deleteMany({ where: { id: waitStudentId } });
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

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(unchanged.status).toBe('draft');
  });

  it('409s completing a class straight from draft (invalid transition)', async () => {
    const res = await complete(ownerToken, classId);
    expect(res.status).toBe(409);

    // Pin WHICH 409 fired — verbatim substring from validateTransition's
    // error in src/services/class-lifecycle.ts.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('cannot move from "draft" to "completed"');

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
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

  /**
   * Cancellation moved to its own door in #327 and is no longer a transition:
   * `cancelled` left `ClassStatus`, so there is no target status to name and
   * `transitionClassSchema` rejects the word. The duty of care moved with it
   * — registered students are still notified and the waitlist still closes —
   * which is why the cases below stayed in this block rather than being
   * rewritten: they are the same behaviour, one URL over, and two of them
   * depend on running in this order against the shared `cancelClassId`.
   *
   * No body: the URL is the whole request.
   */
  const cancel = (token: string | null, id: string) =>
    fetch(`${BASE_URL}/api/classes/${id}/cancel`, {
      method: 'POST',
      headers: { ...(token ? cookie(token) : {}) },
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

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(unchanged.status).toBe('draft');
  });

  it('409s an invalid transition (draft -> in_progress)', async () => {
    const res = await transition(ownerToken, classId, { status: 'in_progress' });
    expect(res.status).toBe(409);

    // Pin WHICH 409 fired — verbatim substring from validateTransition's
    // error in src/services/class-lifecycle.ts.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('cannot move from "draft" to "in_progress"');

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(unchanged.status).toBe('draft');
  });

  it('400s a transition to "completed" — the enum deliberately excludes it', async () => {
    // `transitionClassSchema` (`lib/schemas.ts`) does not accept `completed`:
    // completion happens through `/complete`, never through `/transition`. The
    // 400 below is the pin. The enum's membership is not restated here — a
    // roster in a comment cannot fail when the enum it copies changes.
    const res = await transition(ownerToken, classId, { status: 'completed' });
    expect(res.status).toBe(400);

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: classId }, include: { calendarEntry: true } });
    expect(unchanged.status).toBe('draft');
  });

  it('publishing a draft whose start has passed is refused with 409 (#249)', async () => {
    const res = await transition(ownerToken, pastDraftClassId, { status: 'open' });
    expect(res.status).toBe(409);

    // The CODE, not just the status. A bare 409 cannot tell STARTS_IN_PAST
    // from an illegal transition or a concurrent modification, so this test
    // would have stayed green if the publish were refused for an unrelated
    // reason — which it nearly was, since a past-dated draft is exactly the
    // kind of fixture other guards also dislike. This route used to answer
    // every reason but NOT_FOUND with a bare 409 and no code at all, and the
    // earlier version of this comment recorded that as a limitation to live
    // with; #249's review made the case for fixing it instead.
    //
    // The same code the PUT door answers with, deliberately — one condition,
    // one code, whichever door refuses it.
    const json = (await res.json()) as { error: { message: string; code?: string } };
    expect(json.error.code).toBe('CLASS_STARTS_IN_PAST');
    expect(json.error.message).toMatch(/already passed/i);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: pastDraftClassId }, include: { calendarEntry: true } });
    expect(after.status).toBe('draft');
  });

  it('cancels a class (happy path)', async () => {
    const res = await cancel(ownerToken, cancelClassId);
    expect(res.status).toBe(200);

    // The ENTRY carries it since #327; the class keeps its `draft` status,
    // asserted alongside so a regression that wrote neither reads as what it
    // is rather than as a missing cancellation.
    const cancelled = await prisma.class.findUniqueOrThrow({ where: { id: cancelClassId }, include: { calendarEntry: true } });
    expect(cancelled.status).toBe('draft');
    expect(cancelled.calendarEntry.cancelledAt).not.toBeNull();
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
    const res = await cancel(ownerToken, noticeClassId);
    expect(res.status).toBe(200);

    const note = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'student',
        recipientId: lockStudentId,
        relatedClassId: noticeClassId,
        type: 'class_cancelled',
      },
    });

    // Read the stored row rather than restating `makeClass`'s literals. Two
    // reasons, and the second is the one that matters:
    //
    // - Change `makeClass`'s date — `2099-06-01` is arbitrary — and hard-coded
    //   copies here fail on the day assertion while the route is perfectly
    //   correct, sending the next reader to the wrong file.
    // - `formatDayHeader` reads with `getUTC*` accessors, so rendering the
    //   value the database actually returned is what would catch the route
    //   drifting off UTC midnight. Two independent literals agree with each
    //   other no matter what came back from the column.
    const stored = await prisma.class.findUniqueOrThrow({ where: { id: noticeClassId }, select: { calendarEntry: { select: { classType: true, date: true, startTime: true } } } });
    expect(note.body).toContain(stored.calendarEntry.classType);
    expect(note.body).toContain(formatDayHeader(stored.calendarEntry.date));
    expect(note.body).toContain(timeToHHmm(stored.calendarEntry.startTime));

    // The sentence carrying those three, not just the three. Without this the
    // student body could be replaced wholesale by the teacher's — "was
    // cancelled — only 0 of 1 minimum students registered" — and every
    // assertion above still passes, telling every manually-cancelled student a
    // reason that is false. PR review demonstrated exactly that mutation
    // passing 21/21. The sibling teacher test pins its own distinguishing
    // clause the same way (`class-transitions.test.ts`, "only N of M").
    expect(note.body).toContain('has been cancelled by your teacher');

    // The waitlisted recipient. The route fans out to
    // `[...registrations, ...waiting]` and nothing in the repo covered the
    // second half: PR review dropped `...waiting` and the whole integration
    // project stayed green (27 files, 348 tests). That is #112's defect — a
    // queued student told nothing — surviving in the one path #112 used as its
    // reference implementation.
    const waitNote = await prisma.notification.findFirstOrThrow({
      where: {
        recipientType: 'student',
        recipientId: waitStudentId,
        relatedClassId: noticeClassId,
        type: 'class_cancelled',
      },
    });
    expect(waitNote.body).toBe(note.body); // one body, both audiences

    // …and their entry is closed, not left pointing at a cancelled class.
    const entry = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: noticeClassId, studentId: waitStudentId },
    });
    expect(entry.status).toBe('removed');
  });

  it('names the class as it stands when cancelled, not as first read', async () => {
    const cls = await createClassFixture(prisma, {
        teacherId: ownerId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2099-01-01'),
        startTime: hhmmToTime('10:00'),
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 4,
        status: 'open',
      });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: waitStudentId, status: 'registered', tierAtBooking: 3 },
    });
    // CORRECTED after the first implementation attempt proved this test could
    // not fail. The original line here was:
    //     await prisma.class.update({ ..., data: { classType: 'Vinyasa' } });
    // fully awaited BEFORE the request. That cannot exercise anything: the
    // handler's own top-of-handler read (`src/app/api/classes/[id]/transition/route.ts`'s
    // `prisma.class.findUnique` call) then sees 'Vinyasa'
    // too, so `cls` and the in-transaction re-read are identical and switching
    // the interpolation between them is unobservable. The mutation in Step 5
    // stayed green, and the implementer correctly refused to commit.
    //
    // A window is REQUIRED, and one is reachable. The handler reads `cls`,
    // then awaits `parseBody`, then opens its transaction and CASes — so a
    // write that lands after the read but before the CAS commits is exactly
    // what `fresh` sees and `cls` does not.
    //
    // The deterministic lever is this suite's established one, not a new
    // technique: a second client holds the `Class` row `FOR UPDATE` so the
    // handler's CAS parks, and the rewrite lands while it is parked. Copy
    // `announcements-api.test.ts` (~`:240-290`), which does this on a `Class`
    // row; see also `payments-api.test.ts:361`, `registrations-api.test.ts:700`
    // and `account-api.test.ts:615`. It appears in eight integration files.
    const holder = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    // The handshake, without which the lever is decorative: `$transaction`
    // returns before its callback has run, and a fresh client must connect and
    // start its engine first (50-200ms, measured in `announcements-api`), so
    // the request could finish before the lock was ever taken.
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        locked();
        await released;
        // Lands while the handler is parked on its lock: after the
        // top-of-handler read, before the in-transaction re-read. On
        // `CalendarEntry` since #327 — `classType` left `Class` with the rest
        // of the calendar identity — reached through the child's
        // `calendarEntryId`. The row the handler parks on is still `Class`,
        // which is the one held above: `lockClassRow` takes it first.
        await tx.$executeRaw`
          UPDATE "CalendarEntry" SET "classType" = 'Vinyasa'
           WHERE id = (SELECT "calendarEntryId" FROM "Class" WHERE id = ${cls.id})`;
      },
      { timeout: 20_000 },
    );

    // PR review, Task 7 fix round. Everything below used to run only on the
    // happy path — release/await/disconnect/cleanup all sat after every
    // `expect`, so a failure at either assertion skipped them. At `settled`,
    // the holder parks until its own 20s timeout and its `Vinyasa` write (and
    // the `Notification` it produces once released) is never cleaned up; at
    // `toContain('Vinyasa')`, the request has already completed and its
    // `Notification` is orphaned outright. `Notification.relatedClass` is
    // `onDelete: SetNull`, not Cascade (`prisma/schema.prisma`) — deleting the
    // class does not take it with it — and the file's `afterAll` notification
    // sweep only covers the fixed `allClassIds` array, which can't know about
    // a class this test creates dynamically. Reproduced twice for real during
    // this task's own required mutation runs. `try/finally` is this suite's
    // house fix for the same concern (`account-api.test.ts:626-640`).
    let pending: ReturnType<typeof transition> | undefined;
    try {
      await parked;

      pending = cancel(ownerToken, cls.id);

      // The lever is asserted, not assumed. If the request answered inside this
      // second it never parked, the rewrite never interleaved, and a green run
      // would prove nothing — which is precisely how the first version of this
      // test passed against both the fix and its mutation.
      let settled = false;
      void pending.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 1000));
      expect(settled).toBe(false);

      release();
      await holding;
      const res = await pending;
      expect(res.status).toBe(200);

      const notice = await prisma.notification.findFirstOrThrow({
        where: { relatedClassId: cls.id, type: 'class_cancelled', recipientType: 'student' },
      });
      expect(notice.body).toContain('Vinyasa');
      expect(notice.body).not.toContain('Hatha');
    } finally {
      // Idempotent on every exit path: `release()` is a no-op if the happy
      // path already called it, and awaiting `holding`/`pending` again just
      // resolves immediately if they already have. Lets the holder's
      // transaction and the in-flight request both finish before anything is
      // deleted, regardless of which assertion above threw or whether none did.
      release();
      await holding;
      if (pending) await pending.catch(() => undefined);
      await holder.$disconnect();

      // Notifications first — SetNull means deleting the class first would
      // orphan them, the exact failure mode this block exists to close.
      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      await prisma.registration.deleteMany({ where: { classId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    }
  });

  /**
   * The refusal's OTHER branch, which nothing could test before.
   *
   * When the cancel CAS matches nothing, this transaction holds no lock on the
   * row — an `UPDATE` that matched nothing locked nothing — so the row is
   * freely deletable in that window. Archiving a recurring template
   * hard-deletes its future `draft`/`open` instances, the same status set the
   * CAS matches on, so the window is reachable through the product rather than
   * only in theory.
   *
   * The old code fell back to `cls.status`, the handler's top-of-function
   * snapshot, and answered `409 "Cannot cancel a class with status "open""`
   * about a class that no longer existed — reintroducing, on the failure path,
   * exactly the staleness the sibling test above fixed on the success path.
   *
   * The existing "409s cancelling an already-cancelled class" cannot cover
   * this: its class is already `cancelled` at the top-of-handler read, so the
   * snapshot and the re-read are the same string and swapping one for the other
   * is unobservable. This needs the row to CHANGE while the request is parked,
   * which is what the lever provides.
   */
  it('404s when the class is deleted while the cancel is parked on its row', async () => {
    const cls = await createClassFixture(prisma, {
        teacherId: ownerId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2099-01-02'),
        startTime: hhmmToTime('11:00'),
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 4,
        status: 'open',
      });
    // No registrations, deliberately: this class has to be deletable, which is
    // also what makes the scenario real — the archive path only hard-deletes
    // instances carrying no charged registration.

    const holder = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        locked();
        await released;
        // Lands while the handler is parked on its CAS: after the
        // top-of-handler read that proved the class existed, before the
        // in-transaction re-read that has to notice it no longer does.
        await tx.$executeRaw`DELETE FROM "Class" WHERE id = ${cls.id}`;
      },
      { timeout: 20_000 },
    );

    let pending: ReturnType<typeof transition> | undefined;
    try {
      await parked;

      pending = cancel(ownerToken, cls.id);

      // Asserted, not assumed — the same reason as the sibling above. A request
      // that answered without parking would prove nothing.
      let settled = false;
      void pending.then(() => { settled = true; }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
      expect(settled).toBe(false);

      release();
      await holding;
      const res = await pending;

      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('Class not found');
      // The specific lie the fallback used to tell.
      expect(json.error.message).not.toContain('status "open"');
    } finally {
      release();
      await holding;
      if (pending) await pending.catch(() => undefined);
      await holder.$disconnect();

      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      // By the entry's OWN id, not through the `Class` relation: on the happy
      // path the holder already deleted the `Class` row, which orphans this
      // entry rather than cascading to it (cascade runs the other way). A
      // `classes: { some: { id: cls.id } } }` filter would then match nothing
      // and silently leave the orphan for the file's teacher-scoped `afterAll`
      // to reclaim instead. `deleteMany`, not `delete`: still defensive
      // against a path where the row is already gone.
      await prisma.calendarEntry.deleteMany({ where: { id: cls.calendarEntry.id } });
    }
    // Explicit: this test sleeps 1s by design and then makes a full Next.js
    // round trip, against a 5s default that the suite has already been observed
    // to exceed under cross-project Postgres contention.
  }, 15_000);

  it('409s cancelling an already-cancelled class', async () => {
    const res = await cancel(ownerToken, cancelClassId);
    expect(res.status).toBe(409);

    // Pin WHICH 409 fired — verbatim substring from the route's own guard text
    // in src/app/api/classes/[id]/cancel/route.ts. That route's CAS has TWO
    // conjuncts a teacher can hit since #327 (already cancelled, or past the
    // point where cancelling is the right verb), and they answer with
    // different sentences; this is the first.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('This class is already cancelled.');

    const unchanged = await prisma.class.findUniqueOrThrow({ where: { id: cancelClassId }, include: { calendarEntry: true } });
    expect(unchanged.calendarEntry.cancelledAt).not.toBeNull();
  });

  /**
   * #216. Covers the route, not just `transitionClass` — the unit tests in
   * `class-lifecycle.test.ts`'s `transitionClass (DB)` block never reach
   * `POST /api/classes/[id]/transition`. A fresh class, not `classId` or
   * `noticeClassId`: both are asserted against by other tests in this file.
   * Cleaned up inline on the happy path; the file-level `afterAll`'s
   * teacher-scoped sweep is the backstop for a run that fails before reaching
   * this tail.
   */
  it('closes the waitlist when a teacher moves a class to in_progress', async () => {
    const cls = await createClassFixture(prisma, {
        teacherId: ownerId,
        teacherRoomId,
        classType: 'Queue Close',
        date: new Date('2099-01-01'),
        startTime: hhmmToTime('10:00'),
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 4,
        status: 'open',
      });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waitStudentId, position: 1, status: 'waiting' },
    });

    const res = await transition(ownerToken, cls.id, { status: 'in_progress' });
    expect(res.status).toBe(200);

    const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(after.status).toBe('expired');

    await prisma.waitlistEntry.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
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
    const before = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId }, include: { calendarEntry: true } });
    expect(before.settingsLocked).toBe(false); // sanity: the control fixture for the locked-class cases below

    const res = await put(ownerToken, economicsClassId, { roomCost: 42, minStudents: 2 });
    expect(res.status).toBe(200);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId }, include: { calendarEntry: true } });
    expect(Number(updated.roomCost)).toBe(42);
    expect(updated.minStudents).toBe(2);
  });

  it('locked class: economic edit is rejected with 409 naming the fields sent', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
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

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(Number(after.minRate)).toBe(Number(before.minRate));
  });

  it('locked class: a mixed economic + non-economic body is rejected atomically', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });

    // The lock check inside `updateClass` rejects before any write happens.
    // Nothing pinned that the rejection is all-or-nothing until this case — a
    // future "strip the locked fields and apply the rest" refactor could pass
    // every other case here while quietly changing the contract from atomic
    // rejection to partial apply.
    const res = await put(ownerToken, lockedClassId, { description: 'x', roomCost: 999 });
    expect(res.status).toBe(409);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(after.description).toBe(before.description);
  });

  it('locked class: a non-economic edit still succeeds — the lock is scoped to economics', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });

    const res = await put(ownerToken, lockedClassId, { description: 'Updated after lock' });
    expect(res.status).toBe(200);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
    expect(after.description).toBe('Updated after lock');
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
    expect(Number(after.minRate)).toBe(Number(before.minRate));
    expect(Number(after.targetRate)).toBe(Number(before.targetRate));
    expect(after.minStudents).toBe(before.minStudents);
    expect(after.maxStudents).toBe(before.maxStudents);
  });

  it("403s another teacher's cookie on a locked class with an economic body — proves the ownership guard fires before the lock check", async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });

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

    const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
    expect(Number(after.roomCost)).toBe(Number(before.roomCost));
  });

  it('open class: a date edit into the past is refused with 409, not 500 (#249)', async () => {
    const target = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId }, include: { calendarEntry: true } });
    expect(target.status).toBe('open'); // sanity: a LIVE class, so #247's freeze is not what refuses

    const res = await put(ownerToken, economicsClassId, { date: '2020-01-01' });
    expect(res.status).toBe(409);

    const json = (await res.json()) as { error: { code: string; message: string } };
    // Coded distinctly from CLASS_TERMINAL: a client has to tell "already
    // started" from "frozen" without matching on English.
    expect(json.error.code).toBe('CLASS_STARTS_IN_PAST');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId }, include: { calendarEntry: true } });
    expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-06-01');
  });

  // Task 6b (#196). `CalendarEntry_teacher_slot_excl` constrains every write,
  // not just creates, so a reschedule that moves `date`/`startTime` onto a
  // span another of the teacher's live entries already covers collides here
  // exactly as a `POST` into that slot does.
  describe('PUT /api/classes/[id] collides on the slot key (#196)', () => {
    afterAll(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: ownerId, classType: 'Reschedule Slot' } });
    });

    it('refuses a reschedule onto a slot another live class already holds', async () => {
      const makeSlotClass = (startTime: string) =>
        createClassFixture(prisma, {
            teacherId: ownerId,
            teacherRoomId,
            classType: 'Reschedule Slot',
            date: new Date('2099-08-01'),
            startTime: hhmmToTime(startTime),
            // 15 minutes, matching the two callers' spacing below:
            // `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since
            // #327, so the pair could not be planted at all with a wider one.
            // The move under test lands on an IDENTICAL start time, so it
            // still collides.
            durationMinutes: 15,
            roomCost: 15,
            minRate: 10,
            targetRate: 20,
            minStudents: 1,
            maxStudents: 8,
            status: 'draft',
          });
      const occupied = await makeSlotClass('08:00');
      const mover = await makeSlotClass('08:15');

      const res = await put(ownerToken, mover.id, { startTime: '08:00' });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string } };
      expect(json.error.code).toBe('DUPLICATE_CLASS_SLOT');

      const after = await prisma.class.findUniqueOrThrow({ where: { id: mover.id }, include: { calendarEntry: true } });
      expect(timeToHHmm(after.calendarEntry.startTime)).toBe('08:15');

      // The test's premise is that this row is the one occupying the slot
      // the reschedule collided on, and that it is untouched by the failed
      // move — assert that rather than discarding the reference, so a route
      // that clobbered the wrong row would fail this test.
      const stillOccupied = await prisma.class.findUniqueOrThrow({ where: { id: occupied.id }, include: { calendarEntry: true } });
      expect(timeToHHmm(stillOccupied.calendarEntry.startTime)).toBe('08:00');
    });
  });

  // PR #208 review, D1. `CalendarEntry` carries two slot-shaped constraints:
  // `CalendarEntry_scheduleRuleId_date_key` and
  // `CalendarEntry_teacher_slot_excl`. The slot coverage above always leaves
  // `startTime` identical between the two rows, which collides on the
  // exclusion constraint and can never exercise the rule-date key.
  //
  // So this block gives its two instances NON-OVERLAPPING spans, and that has
  // to be arranged deliberately since #327. Where the dropped
  // `Class_teacher_slot_unique` was an exact `(teacherId, date, startTime)`
  // match — so any distinct minute kept it quiet — the exclusion constraint is
  // a RANGE overlap, and two 60-minute instances a quarter-hour apart violate
  // BOTH constraints. Which one Postgres then reports is decided by index OID
  // order, i.e. by the order the DDL happened to run, and that is NOT stable
  // across databases: measured 2026-08-26, `ethical_yoga` has the rule-date
  // key at the lower OID and `ethical_yoga_test` has the exclusion constraint
  // there, so the identical move reports a different code in each. Disjoint
  // spans are what make this case about the rule-date key on any database
  // rather than about which migration ran first.
  describe("PUT /api/classes/[id] collides on the rule's own (scheduleRuleId, date) key (#196)", () => {
    let templateDateTemplateId: string;
    let templateDateScheduleRuleId: string;

    beforeAll(async () => {
      const template = await prisma.classTemplate.create({
        data: {
          scheduleRule: {
            create: {
              teacherId: ownerId,
              kind: 'regular',
              classType: 'Template Date Clash',
              dayOfWeek: 2,
              startTime: hhmmToTime('07:00'),
              durationMinutes: 60,
            },
          },
          teacherRoom: { connect: { id: teacherRoomId } },
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 1,
          maxStudents: 8,
        },
      });
      templateDateTemplateId = template.id;
      templateDateScheduleRuleId = template.scheduleRuleId;
    });

    afterAll(async () => {
      await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateDateTemplateId } } } },
    });
      // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
      // 298) — deleting the child directly here would orphan its rule row.
      await prisma.scheduleRule.delete({ where: { id: templateDateScheduleRuleId } });
    });

    it("refuses moving one instance onto a sibling instance's date, naming the recurring class rather than a generic conflict", async () => {
      const makeInstance = (date: string, startTime: string) =>
        createClassFixture(prisma, {
            teacherId: ownerId,
            teacherRoomId,
            scheduleRuleId: templateDateScheduleRuleId,
            classType: 'Template Date Clash',
            date: new Date(date),
            startTime: hhmmToTime(startTime),
            durationMinutes: 60,
            roomCost: 15,
            minRate: 10,
            targetRate: 20,
            minStudents: 1,
            maxStudents: 8,
            status: 'open',
          });
      const sibling = await makeInstance('2099-09-02', '07:00');
      // FOUR HOURS clear of `sibling`, not the fifteen minutes this used to
      // carry: `CalendarEntry_teacher_slot_excl` must NOT also fire when the
      // move lands, and at 60 minutes a side only a gap wider than the
      // duration guarantees that. This test exists to prove the
      // `(scheduleRuleId, date)` key is reachable on its own, with no help
      // from the slot constraint — see the block comment for what a
      // double violation would leave this asserting instead.
      const mover = await makeInstance('2099-09-09', '11:00');

      const res = await put(ownerToken, mover.id, { date: '2099-09-02' });
      expect(res.status).toBe(409);
      const json = (await res.json()) as { error: { code: string; message: string } };
      expect(json.error.code).toBe('TEMPLATE_INSTANCE_DATE_CONFLICT');
      expect(json.error.message).toBe('That recurring class already has a class on that date.');

      const after = await prisma.class.findUniqueOrThrow({ where: { id: mover.id }, include: { calendarEntry: true } });
      expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-09-09');

      // The test's premise is that this row is the one occupying the date
      // the move collided on, and that it is untouched by the failed move.
      const stillThere = await prisma.class.findUniqueOrThrow({ where: { id: sibling.id }, include: { calendarEntry: true } });
      expect(stillThere.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-09-02');
    });
  });

  it('completed class: the edit is refused with 409 and the stored date does not move (#247)', async () => {
    const before = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId }, include: { calendarEntry: true } });
    expect(before.status).toBe('completed'); // sanity: the fixture is the state under test

    // The exact payload from the issue. `isoDate` has no range bound, so this
    // passes schema validation and reaches the service — the refusal has to
    // come from the guard, not from parsing.
    const res = await put(ownerToken, completedClassId, { date: '2020-01-01' });
    expect(res.status).toBe(409);

    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.message).toContain('completed');
    expect(json.error.code).toBe('CLASS_TERMINAL');

    // The whole point: a refusal that still wrote the column would leave
    // waitlist-retention's sweep with a class dated 2020 to reap.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId }, include: { calendarEntry: true } });
    expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-06-01');
  });

  it('cancelled class: the edit is refused with 409 naming cancelled, not completed (#247)', async () => {
    const before = await prisma.class.findUniqueOrThrow({
      where: { id: cancelledTerminalClassId }, include: { calendarEntry: true } });
    // The premise, on the row that carries it since #327: the class keeps a
    // live status and the ENTRY holds the cancellation.
    expect(before.calendarEntry.cancelledAt).not.toBeNull();

    // Not a duplicate of the `completed` case above. The route builds its
    // message by interpolating `result.state`, and the two states render two
    // different sentences from one branch — of which only one was pinned. That
    // `state` is `ClassStatus | 'cancelled'` rather than `ClassStatus` is
    // exactly because this sentence still has to say "cancelled".
    // A regression that hard-coded "completed" into that string — the obvious
    // way to write it if only the completed fixture exists — would have passed
    // the whole suite while telling half of the affected teachers their class
    // is in a state it is not.
    const res = await put(ownerToken, cancelledTerminalClassId, { date: '2020-01-01' });
    expect(res.status).toBe(409);

    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.message).toContain('cancelled');
    expect(json.error.message).not.toContain('completed');
    // Coded, like the two conflict 409s in the same handler, so a client can
    // distinguish "frozen" from "slot taken" without matching on English.
    expect(json.error.code).toBe('CLASS_TERMINAL');

    const after = await prisma.class.findUniqueOrThrow({
      where: { id: cancelledTerminalClassId }, include: { calendarEntry: true } });
    expect(after.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-06-01');
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
        scheduleRule: {
          create: {
            teacherId: otherTeacherId,
            kind: 'regular',
            classType: 'Victim Recurring',
            dayOfWeek: 3,
            startTime: hhmmToTime('18:00'),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: victimRoom.id } },
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
          ? prisma.calendarEntry.deleteMany({
              where: { classType: 'Create Route', classes: { some: { teacherRoomId: { in: roomIds } } } },
            })
          : Promise.resolve();
      },
      // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue
      // 298) — deleting the child directly here would orphan its rule row.
      () =>
        otherTeacherId
          ? prisma.scheduleRule.deleteMany({
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
    const created = await prisma.class.findUniqueOrThrow({ where: { id: data.id }, include: { calendarEntry: true } });
    expect(created.calendarEntry.teacherId).toBe(ownerId);
    expect(created.calendarEntry.scheduleRuleId).toBeNull();
  });

  // #146. The rule link is server-set — class-generator.ts writes the entry's
  // `scheduleRuleId` when a template materialises an instance, and no creation
  // UI renders it. Sending another teacher's template id used to squat the
  // `(scheduleRuleId, date)` unique pair, which silently stops the victim's
  // generator from ever filling that date.
  //
  // startTime overridden away from baseBody()'s '10:00': the previous test
  // ('creates a class against the calling teacher') already created a real row
  // at ownerId/2099-08-01/10:00, and `CalendarEntry_teacher_slot_excl` refuses
  // a second live entry whose span overlaps it. Not the concern this test
  // pins, so it moves to a slot of its own rather than sharing one.
  it("ignores another teacher's templateId instead of attaching it", async () => {
    const res = await post(ownerToken, {
      ...baseBody(),
      templateId: victimTemplateId,
      // 12:00, not 10:15: `baseBody`'s own 10:00 create earlier in this block
      // is 60 minutes long and still standing, and
      // `CalendarEntry_teacher_slot_excl` refuses an OVERLAP since #327 where
      // the key it replaced refused only an identical start time. The hour is
      // arbitrary to what this test asserts.
      startTime: '12:00',
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.class.findUniqueOrThrow({ where: { id: data.id }, include: { calendarEntry: true } });
    expect(created.calendarEntry.scheduleRuleId).toBeNull();

    // The victim's own generation window is untouched. Both assertions here
    // rest on an absence, and `CalendarEntry.scheduleRuleId` is
    // `onDelete: SetNull` — so a cascaded rule delete would produce the same
    // null and the same zero count. Not reachable today; this removes the
    // ambiguity anyway.
    expect(
      await prisma.classTemplate.findUnique({ where: { id: victimTemplateId } }),
    ).not.toBeNull();
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: victimTemplateId } } } } } })).toBe(0);
  });

  // #327 stage B, Task 1: `startTime` becomes a `@db.Time` column. The wire
  // format is unchanged — this pins that boundary at the create route, and
  // reads the column directly to prove the type actually changed rather than
  // trusting the route's own round trip.
  it('accepts and returns startTime as "HH:MM" while the column is time', async () => {
    const res = await post(ownerToken, {
      ...baseBody(),
      date: '2027-03-01',
      startTime: '19:00',
      durationMinutes: 90,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; startTime: string } };
    expect(data.startTime).toBe('19:00');

    // The column, not the wire: a text column would come back as a string
    // here. On `CalendarEntry` since #327 — `Class` has no `startTime` of its
    // own any more — reached through the child's `calendarEntryId`.
    const [row] = await prisma.$queryRaw<Array<{ t: Date }>>`
      SELECT e."startTime" AS t
        FROM "Class" c
        JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
       WHERE c.id = ${data.id}`;
    expect(row?.t).toBeInstanceOf(Date);
  });

  // The read direction of the same guarantee. The test above only pins the
  // create route's own round trip — GET /api/classes/[id] carries its own,
  // separate `timeToHHmm(cls.startTime)` call, and nothing else in this file
  // reads a class back by id at all. Delete that call and this fails with the
  // stored column's own wire shape (an ISO timestamp) while every other test
  // in the suite stays green.
  it('returns startTime as "HH:MM" on GET /api/classes/[id]', async () => {
    const created = await post(ownerToken, {
      ...baseBody(),
      date: '2027-03-03',
      startTime: '20:15',
      durationMinutes: 60,
    });
    expect(created.status).toBe(201);
    const { data: createdData } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/classes/${createdData.id}`, {
      headers: cookie(ownerToken),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { startTime: string } };
    expect(data.startTime).toBe('20:15');
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

  describe('POST /api/classes is retry-safe on the slot key (#196)', () => {
    // The parent describe's own afterAll (above) only clears `classType:
    // 'Create Route'` from `teacherRoomId`, so the 'Slot Yoga' rows this
    // block creates would otherwise survive it and FK-block the top-level
    // afterAll's `teacherRoom.deleteMany({ where: { teacherId: ownerId } })`
    // — the same failure mode that comment documents for its own rows.
    // Nested `afterAll`s run before their parent's, so this clears the way
    // in time.
    afterAll(async () => {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: ownerId, classType: 'Slot Yoga' } });
    });

    // The three cases below each override `startTime`, and they must land
     // clear of ONE ANOTHER'S SPANS since #327 —
    // `CalendarEntry_teacher_slot_excl` refuses an overlap where the key it
    // replaced refused only an identical start time, and every row planted
    // here survives until this block's `afterAll`. Hence 07:00 / 09:00 /
    // 11:00 rather than the quarter-hours they used to use.
    const slotBody = () => ({
      teacherRoomId, classType: 'Slot Yoga', date: '2027-04-05', startTime: '07:00',
      durationMinutes: 60, roomCost: 20, minRate: 30, targetRate: 60,
      minStudents: 3, maxStudents: 10,
    });
    const post = (body: unknown) =>
      fetch(`${BASE_URL}/api/classes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
        body: JSON.stringify(body),
      });

    it('answers a repeated identical create with 409 and leaves exactly one class', async () => {
      const first = await post(slotBody());
      expect(first.status).toBe(201);

      const second = await post(slotBody());
      expect(second.status).toBe(409);
      expect((await second.json()).error.code).toBe('DUPLICATE_CLASS_SLOT');

      const rows = await prisma.class.findMany({ where: { calendarEntry: { teacherId: ownerId, date: new Date('2027-04-05'), startTime: hhmmToTime('07:00') } }, include: { calendarEntry: true } });
      expect(rows).toHaveLength(1);
    });

    it('leaves exactly one class when two identical creates are in flight at once', async () => {
      const body = { ...slotBody(), startTime: '09:00' };
      const [a, b] = await Promise.all([post(body), post(body)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);

      const loser = a.status === 409 ? a : b;
      expect((await loser.json()).error.code).toBe('DUPLICATE_CLASS_SLOT');

      const rows = await prisma.class.findMany({ where: { calendarEntry: { teacherId: ownerId, date: new Date('2027-04-05'), startTime: hhmmToTime('09:00') } }, include: { calendarEntry: true } });
      expect(rows).toHaveLength(1);
    });

    it('answers 409 rather than 503 when two identical creates are in flight at once (issue 331)', async () => {
      // A plain `INSERT` against `CalendarEntry_teacher_slot_excl` inserts its
      // tuple and only then checks the constraint, so two concurrent
      // conflicting inserts wait on each other and Postgres breaks the cycle
      // with `40P01` — the loser answering 503 where a 409 belongs. TEN
      // RACES, NOT ONE: one pair passes against that bug most of the time, so
      // a single race does not catch a regression here reliably — same shape
      // as the template families' own race loop
      // (`tests/integration/class-templates-api.test.ts`,
      // `tests/integration/studio-api.test.ts`).
      //
      // `slotBody()`'s own date ('2027-04-05') is shared with the sibling
      // tests in this block, so this loop uses its own ('2031-05-12')
      // instead — ten non-overlapping 45-minute slots, 02:00 through 11:00,
      // one per race.
      for (let i = 0; i < 10; i++) {
        const body = {
          ...slotBody(),
          date: '2031-05-12',
          startTime: `${String(2 + i).padStart(2, '0')}:00`,
          durationMinutes: 45,
        };
        const [a, b] = await Promise.all([post(body), post(body)]);
        expect([a.status, b.status].sort(), `race ${i}`).toEqual([201, 409]);

        const loser = a.status === 409 ? a : b;
        expect((await loser.json()).error.code).toBe('DUPLICATE_CLASS_SLOT');

        const rows = await prisma.class.findMany({ where: { calendarEntry: { teacherId: ownerId, date: new Date('2031-05-12'), startTime: hhmmToTime(body.startTime) } }, include: { calendarEntry: true } });
        expect(rows, `race ${i}`).toHaveLength(1);
      }
    });

    // PR #208 review, E4. `CalendarEntry_teacher_slot_excl`'s partial
    // predicate (`WHERE "cancelledAt" IS NULL`) is what frees a cancelled
    // class's slot — proven at the DB layer by `slot-constraints.test.ts` and
    // at the route layer by the two tests above that a live slot is refused.
    // Neither proves the two compose: that cancelling through the app and then
    // POSTing again actually round-trips through this route to a 201.
    it('lets a freed slot be re-used once the occupying class is cancelled', async () => {
      const body = { ...slotBody(), startTime: '11:00' };
      const first = await post(body);
      expect(first.status).toBe(201);
      const { data: created } = (await first.json()) as { data: { id: string } };

      // Direct write, not `POST …/cancel`: this test is about the slot
      // constraint's predicate, not the cancel route, and the column it sets
      // is the one that route sets.
      await prisma.calendarEntry.updateMany({ where: { classes: { some: { id: created.id } } }, data: { cancelledAt: new Date() } });

      const second = await post(body);
      expect(second.status).toBe(201);

      const rows = await prisma.class.findMany({ where: { calendarEntry: { teacherId: ownerId, date: new Date('2027-04-05'), startTime: hhmmToTime('11:00') } }, include: { calendarEntry: true } });
      expect(rows).toHaveLength(2);
      // Read off the ENTRY: the cancelled row keeps its `draft` status.
      expect(rows.find((r) => r.id === created.id)?.calendarEntry.cancelledAt).not.toBeNull();
    });
  });

  describe('whitespace trimming and validation on POST /api/classes (#311)', () => {
    it('rejects whitespace-only classType with 400', async () => {
      const body = {
        teacherRoomId,
        classType: '   ',
        date: '2099-08-01',
        startTime: '10:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 10,
      };
      const res = await fetch(`${BASE_URL}/api/classes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    });

    it('persists trimmed classType on create', async () => {
      const body = {
        teacherRoomId,
        classType: '  Padded Hatha  ',
        date: '2099-08-02',
        startTime: '10:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 10,
      };
      const res = await fetch(`${BASE_URL}/api/classes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { data: { id: string } };
      const saved = await prisma.class.findUniqueOrThrow({
        where: { id: json.data.id },
        include: { calendarEntry: true },
      });
      expect(saved.calendarEntry.classType).toBe('Padded Hatha');
    });
  });
});
