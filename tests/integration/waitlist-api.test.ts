import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { promoteNext } from '@/services/waitlist';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let studentToken: string;
let teacherToken: string; // non-student session, for the 403 case

let teacherId: string;
let studentId: string;
let roomId: string;
let teacherRoomId: string;
let farFutureClassId: string;
let freedSpotClassId: string;

// Shared anchor for freedSpotClassId (below) and claimClassId (in the
// nested describe further down) — see the comment where each is derived
// for why they must share one `new Date()` read rather than each taking
// their own.
let baseNow: Date;

function claim(token: string | null, body: unknown) {
  return fetch(`${BASE_URL}/api/waitlist/claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? cookie(token) : {}),
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
      email: `waitlistapi-teacher-${suffix}@test.local`,
      account: { create: { email: `waitlistapi-teacher-${suffix}@test.local` } },
      bio: 'Waitlist API tests',
      pageSlug: `waitlistapi-teacher-${suffix}`,
      defaultTimezone: 'UTC',
    },
  });
  teacherId = teacher.id;
  teacherToken = await seedSession(prisma, teacher.accountId);

  const room = await prisma.room.create({
    data: {
      venueName: 'Waitlist API Studio',
      address: `${suffix} Waitlist St`,
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
      email: `waitlistapi-student-${suffix}@test.local`,
      claimedAt: new Date(),
      account: { create: { email: `waitlistapi-student-${suffix}@test.local` } },
      incomeTier: 3,
    },
  });
  studentId = student.id;
  studentToken = await seedSession(prisma, student.accountId!);

  // --- 409 fixture -----------------------------------------------------
  // A class far in the future. getWaitlistWindow resolves this to
  // 'auto_promote' no matter when the suite runs (it's nowhere near the
  // cancel deadline), so claimSpot deterministically throws
  // WaitlistPromotionError('wrong_window') — the "outside the claim
  // window" 409 branch. The window/state guard itself lives in
  // claimSpot/getWaitlistWindow (service); only the exception → 409
  // mapping is route-level.
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
  // The claim window is exactly one hour wide (cutoff = deadline − 1h), and
  // the route calls claimSpot with no injected clock, so an HTTP test of the
  // success path has to place the class relative to real time. The only
  // freedom is how that hour is split between "budget for the suite to reach
  // this test" and "slack against clock skew".
  //
  // classStart = baseNow + 6h50m with a HOURS_6 deadline gives deadline
  // baseNow+50m, cutoff baseNow−10m: a 50-minute budget and 10 minutes of
  // skew slack. It was 15/45, which is the wrong way round — the test
  // process and the server are the same machine on localhost, so skew is
  // effectively zero, while the budget is the thing that actually fails (the
  // window flips to `frozen` past it). The suite runs in ~20s locally and
  // ~3m in CI.
  //
  // baseNow (module scope) rather than a locally-scoped `now`: claimClassId
  // in the nested describe below derives from this same instant, at a fixed
  // one-minute-less offset, so the two classes land on guaranteed-distinct
  // minutes without either one giving up budget — see that comment for why.
  //
  // #66 unit-covered claimSpot's whole window matrix deterministically, which
  // is why this no longer needs to prove anything about *windows*. It stays
  // because it is the only test pinning what the ROUTE adds on success —
  // 201 rather than 200, and the response shape — which no service test can
  // reach. Teacher timezone is UTC (see above), so classStartInstant is plain
  // Date.UTC arithmetic.
  baseNow = new Date();
  const classStart = new Date(baseNow.getTime() + (6 * 60 + 50) * 60 * 1000);
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

  // claimSpot writes a booking_confirmed notification (recipientId = studentId,
  // no FK — nothing else cascades it). Clean it before the student delete so
  // it doesn't orphan in the shared dev DB and later trip processEmailFallback
  // into logging `recipient-missing`.
  await prisma.notification.deleteMany({ where: { recipientId: studentId } });

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

    // Pin WHICH 409 fired — claimSpot has five distinct reasons; matching
    // only the status would also pass for the wrong branch. Substring is
    // verbatim from claimSpot's `wrong_window` throw in src/services/waitlist.ts.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/final hour|window/i);

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

  it('409s a second claim on the same now-filled spot (class_full)', async () => {
    // freedSpotClassId now holds 1 active registration against
    // maxStudents: 1 (from the 201 test above) and is still inside the
    // claim window, so this repeat claim hits claimSpot's `class_full`
    // branch — the entire point of first-come-first-claimed.
    const res = await claim(studentToken, { classId: freedSpotClassId });
    expect(res.status).toBe(409);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/already been claimed/i);
  });
});

describe('promotion and claim repair a missing teacher-roster link (#166)', () => {
  // The link is created at the JOIN now (`addToWaitlist`, services/waitlist.ts)
  // — joining is the student's own act aimed at one named teacher, where a
  // promotion fires at a moment the teacher picks. Both fixtures below write
  // their `waiting` entry directly, so what these cases exercise is the
  // `teacherStudent.upsert` `promoteNext`/`claimSpot` keep as a backstop for
  // rows the join never touched: entries written before that change, or by
  // hand. The consequence is the same either way, and it is the third case
  // here: without the link, PUT /privacy answers TEACHER_NOT_LINKED and the
  // student cannot mute a teacher whose announcements still reach them
  // through the registration.
  //
  // Dedicated students and classes rather than reusing studentId /
  // freedSpotClassId above: those are already consumed (registered,
  // promoted, or asserted-full) by the describe block above, and this one
  // needs a clean waiting entry in each of the two promotion windows.
  let waitlistStudentId: string;
  let waitlistStudentToken: string;
  let claimStudentId: string;
  let claimStudentToken: string;
  let promoteClassId: string;
  let claimClassId: string;

  beforeAll(async () => {
    const waitlistStudent = await prisma.student.create({
      data: {
        firstName: 'Roster',
        lastName: 'Promoted',
        email: `waitlistapi-roster-promoted-${suffix}@test.local`,
        claimedAt: new Date(),
        account: { create: { email: `waitlistapi-roster-promoted-${suffix}@test.local` } },
        incomeTier: 3,
      },
    });
    waitlistStudentId = waitlistStudent.id;
    waitlistStudentToken = await seedSession(prisma, waitlistStudent.accountId!);

    const claimStudent = await prisma.student.create({
      data: {
        firstName: 'Roster',
        lastName: 'Claimed',
        email: `waitlistapi-roster-claimed-${suffix}@test.local`,
        claimedAt: new Date(),
        account: { create: { email: `waitlistapi-roster-claimed-${suffix}@test.local` } },
        incomeTier: 3,
      },
    });
    claimStudentId = claimStudent.id;
    claimStudentToken = await seedSession(prisma, claimStudent.accountId!);

    // auto_promote window — same "far in the future" trick as
    // farFutureClassId above, so promoteNext's own window check never
    // trips: nowhere near the cancel deadline. Distinct date from
    // farFutureClassId: same teacher, and Class_teacher_slot_unique is
    // (teacherId, date, startTime) — reusing farFutureClassId's slot would
    // collide with that still-open class.
    const promoteClass = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Waitlist API Roster Promote',
        date: new Date('2099-06-02'),
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
    promoteClassId = promoteClass.id;
    await prisma.waitlistEntry.create({
      data: { classId: promoteClassId, studentId: waitlistStudentId, position: 1, status: 'waiting' },
    });

    // first_come_first_claimed window — same style as freedSpotClassId above
    // (HOURS_6 deadline), derived from that same `baseNow` (module scope)
    // rather than a fresh `new Date()` here. Both classes share `teacherId`,
    // so a fresh read would only be *probably* distinct from
    // freedSpotClassId's — floored to the minute, two independent reads
    // this close together (this beforeAll runs right after the
    // describe-block-1 tests that consume freedSpotClassId) could land in
    // the same minute and collide on Class_teacher_slot_unique; that this
    // never fired in practice was luck, not a guarantee. Anchoring both to
    // one instant makes it a guarantee instead: 6h49m here vs
    // freedSpotClassId's 6h50m is a fixed one-minute difference from a
    // shared clock read, so the two floored minutes are exactly one apart
    // regardless of any real delay — deadline baseNow+49m, cutoff
    // baseNow−11m, a 49/11 split essentially matching freedSpotClassId's
    // 50/10 rather than sacrificing budget for separation.
    const classStart = new Date(baseNow.getTime() + (6 * 60 + 49) * 60 * 1000);
    const claimDate = new Date(
      Date.UTC(classStart.getUTCFullYear(), classStart.getUTCMonth(), classStart.getUTCDate()),
    );
    const claimStartTime = `${String(classStart.getUTCHours()).padStart(2, '0')}:${String(
      classStart.getUTCMinutes(),
    ).padStart(2, '0')}`;

    const claimClass = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Waitlist API Roster Claim',
        date: claimDate,
        startTime: claimStartTime,
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        cancelDeadline: 'HOURS_6',
        status: 'open',
      },
    });
    claimClassId = claimClass.id;
    await prisma.waitlistEntry.create({
      data: { classId: claimClassId, studentId: claimStudentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    const classIds = [promoteClassId, claimClassId];
    const studentIds = [waitlistStudentId, claimStudentId];
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
    await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    // claimSpot/promoteNext each write a notification with no FK to clean up
    // via cascade — same reasoning as the outer afterAll above.
    await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId, studentId: { in: studentIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId, studentId: { in: studentIds } } });
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });

    for (const id of studentIds) {
      const record = await prisma.student.findUniqueOrThrow({
        where: { id },
        select: { accountId: true, email: true },
      });
      await prisma.session.deleteMany({ where: { accountId: record.accountId! } });
      await prisma.student.delete({ where: { id } });
      await prisma.account.deleteMany({ where: { email: record.email } });
    }
  });

  it('creates the TeacherStudent link when a linkless waiting student is promoted', async () => {
    await promoteNext(prisma, promoteClassId);

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: waitlistStudentId } },
    });
    expect(link).not.toBeNull();
  });

  it('creates the link when a linkless waiting student claims an open spot', async () => {
    const res = await fetch(`${BASE_URL}/api/waitlist/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(claimStudentToken) },
      body: JSON.stringify({ classId: claimClassId }),
    });
    expect(res.status).toBe(201);

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: claimStudentId } },
    });
    expect(link).not.toBeNull();
  });

  it('lets a promoted student set per-teacher privacy', async () => {
    // The consequence that makes this a bug and not a tidiness issue:
    // announcements reach them through the registration regardless, and the
    // opt-out needs the TeacherStudent row this describe block proves gets
    // created — PUT rejects with TEACHER_NOT_LINKED without it.
    const res = await fetch(`${BASE_URL}/api/students/${waitlistStudentId}/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(waitlistStudentToken) },
      body: JSON.stringify({
        teacherId,
        shareFullName: false, shareEmail: false, sharePhone: false,
        shareBirthday: false, shareAddress: false, receiveComms: false,
      }),
    });
    expect(res.status).toBe(200);
  });
});
