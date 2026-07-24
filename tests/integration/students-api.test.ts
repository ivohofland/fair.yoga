import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, createSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
const studentIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'CRM',
      lastName: 'Teacher',
      email: `crm-teacher-${suffix}@test.local`,
      account: { create: { email: `crm-teacher-${suffix}@test.local` } },
      bio: 'Teacher for CRM tests',
      pageSlug: `crm-teacher-${suffix}`,
    },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;

  // Create 25 students linked to this teacher
  for (let i = 0; i < 25; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: `Student${String(i).padStart(2, '0')}`,
        lastName: 'Test',
        email: `crm-student-${suffix}-${i}@test.local`,
      },
    });
    studentIds.push(student.id);
    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });
  }

  // Create a student NOT linked to this teacher (should not appear)
  const unlinked = await prisma.student.create({
    data: {
      firstName: 'Unlinked',
      lastName: 'Student',
      email: `crm-unlinked-${suffix}@test.local`,
    },
  });
  studentIds.push(unlinked.id);

  teacherToken = await createSession(prisma, teacherAccountId);
});

afterAll(async () => {
  await prisma.teacherStudent.deleteMany({
    where: { teacherId },
  });
  await prisma.session.deleteMany({
    where: { accountId: teacherAccountId },
  });
  await prisma.student.deleteMany({
    where: { id: { in: studentIds } },
  });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

describe('GET /api/students', () => {
  it('returns paginated students for the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=1&pageSize=10`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(10);
    expect(json.data.total).toBe(25);
    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(10);
  });

  it('returns page 3 with remaining students', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=3&pageSize=10`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(5);
    expect(json.data.total).toBe(25);
    expect(json.data.page).toBe(3);
  });

  it('filters by search term (name)', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Student00`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(1);
    expect(json.data.students[0].firstName).toBe('Student00');
  });

  it('filters by search term (email)', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students?search=crm-student-${suffix}-1@`,
      { headers: cookie(teacherToken) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students.length).toBeGreaterThanOrEqual(1);
  });

  it('does not return students not linked to the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Unlinked`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(0);
  });

  it('returns 401 without session', async () => {
    const res = await fetch(`${BASE_URL}/api/students`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/students', () => {
  let createdStudentId: string;

  it('creates a new student and TeacherStudent link', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${suffix}@test.local`,
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.firstName).toBe('New');
    createdStudentId = json.data.id;

    // Verify TeacherStudent link was created
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: createdStudentId } },
    });
    expect(link).not.toBeNull();
  });

  it('returns 409 when student already in contacts', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${suffix}@test.local`,
      }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('ALREADY_LINKED');
  });

  it('links existing student to teacher without creating duplicate', async () => {
    // Create a second teacher
    const teacher2 = await prisma.teacher.create({
      data: {
        firstName: 'Second',
        lastName: 'Teacher',
        email: `crm-teacher2-${suffix}@test.local`,
        account: { create: { email: `crm-teacher2-${suffix}@test.local` } },
        bio: 'Second teacher',
        pageSlug: `crm-teacher2-${suffix}`,
      },
    });
    const rawToken2 = await createSession(prisma, teacher2.accountId);

    // Teacher 2 adds the same student by email
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookie(rawToken2),
      },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${suffix}@test.local`,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(createdStudentId); // Same student, no duplicate

    // Cleanup teacher2
    await prisma.teacherStudent.deleteMany({ where: { teacherId: teacher2.id } });
    await prisma.session.deleteMany({ where: { accountId: teacher2.accountId } });
    await prisma.teacher.delete({ where: { id: teacher2.id } });
  });

  it('returns 400 for invalid input', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: '', lastName: '', email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without session', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'No',
        lastName: 'Auth',
        email: 'noauth@test.local',
      }),
    });
    expect(res.status).toBe(401);
  });

  // Cleanup the created student
  afterAll(async () => {
    if (createdStudentId) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: createdStudentId } });
      await prisma.student.delete({ where: { id: createdStudentId } });
    }
  });
});

describe('GET/PUT /api/students/[id] — profile-presence authorization', () => {
  const dualSuffix = `${uniqueSuffix()}-dual`;

  let dualTeacherId: string;
  let dualOwnStudentId: string;
  let dualAccountId: string;
  let dualToken: string;
  let rosterStudentId: string;
  let rosterAccountId: string;
  let rosterToken: string;

  const as = (token: string, path: string, init?: RequestInit) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
        ...cookie(token),
      },
    });

  beforeAll(async () => {
    const dualEmail = `stuapi-dual-${dualSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Dual',
        lastName: 'Matrix',
        email: dualEmail,
        bio: 'Authorization matrix fixtures',
        pageSlug: `stuapi-dual-${dualSuffix}`,
        account: { create: { email: dualEmail } },
      },
    });
    dualTeacherId = teacher.id;
    dualAccountId = teacher.accountId;
    const ownStudent = await prisma.student.create({
      data: {
        firstName: 'Dual',
        lastName: 'Matrix',
        email: dualEmail,
        claimedAt: new Date(),
        account: { connect: { id: dualAccountId } },
      },
    });
    dualOwnStudentId = ownStudent.id;
    dualToken = await createSession(prisma, dualAccountId);

    const rosterEmail = `stuapi-roster-${dualSuffix}@test.local`;
    const roster = await prisma.student.create({
      data: {
        firstName: 'Rostered',
        lastName: 'Privately',
        email: rosterEmail,
        claimedAt: new Date(),
        account: { create: { email: rosterEmail } },
      },
    });
    rosterStudentId = roster.id;
    rosterAccountId = roster.accountId!;
    await prisma.teacherStudent.create({
      data: { teacherId: dualTeacherId, studentId: rosterStudentId },
    });
    rosterToken = await createSession(prisma, rosterAccountId);
  });

  afterAll(async () => {
    await prisma.session.deleteMany({
      where: { accountId: { in: [dualAccountId, rosterAccountId] } },
    });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: dualTeacherId } });
    await prisma.student.deleteMany({
      where: { id: { in: [dualOwnStudentId, rosterStudentId] } },
    });
    await prisma.teacher.deleteMany({ where: { id: dualTeacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [dualAccountId, rosterAccountId] } },
    });
  });

  it('a dual account reading its OWN student row takes the self path — full profile', async () => {
    const res = await as(dualToken, `/api/students/${dualOwnStudentId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email?: string; lastName: string } };
    // Full profile, not the privacy-filtered teacher view.
    expect(body.data.email).toBeDefined();
    expect(body.data.lastName).toBe('Matrix');
  });

  it('a dual account reading a roster student gets the privacy-filtered view', async () => {
    const res = await as(dualToken, `/api/students/${rosterStudentId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { lastName: string; email?: string } };
    // Default privacy: last initial only, no email.
    expect(body.data.lastName).toBe('P');
    expect(body.data.email).toBeUndefined();
  });

  it('a student-only session reading another student is denied', async () => {
    const res = await as(rosterToken, `/api/students/${dualOwnStudentId}`);
    expect(res.status).toBe(403);
  });

  it('a teacher cannot edit a claimed student', async () => {
    const res = await as(dualToken, `/api/students/${rosterStudentId}`, {
      method: 'PUT',
      body: JSON.stringify({ firstName: 'Hijacked', lastName: 'Name', email: 'x@y.test' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/students — overduePayments', () => {
  let otherTeacherId: string;
  let roomId: string;
  const overdueClassIds: string[] = [];

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        venueName: 'Overdue Studio',
        address: `${suffix} Overdue St`,
        city: 'Amsterdam',
        postcode: '1111OD',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    const otherTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `crm-other-${suffix}@test.local`,
        account: { create: { email: `crm-other-${suffix}@test.local` } },
        bio: 'Scoping fixture for overdue counts',
        pageSlug: `crm-other-${suffix}`,
      },
    });
    otherTeacherId = otherTeacher.id;
    const otherTeacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacher.id, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    async function createCompletedClass(
      ownerTeacherId: string,
      ownerTeacherRoomId: string,
      daysBack: number,
    ) {
      const date = new Date();
      date.setDate(date.getDate() - daysBack);
      date.setHours(0, 0, 0, 0);
      const cls = await prisma.class.create({
        data: {
          teacherId: ownerTeacherId,
          teacherRoomId: ownerTeacherRoomId,
          classType: 'Vinyasa',
          date,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'completed',
          settingsLocked: true,
        },
      });
      overdueClassIds.push(cls.id);
      return cls;
    }

    async function createChargedRegistration(
      classId: string,
      studentId: string,
      paymentStatus: 'overdue' | 'pending' | 'paid',
    ) {
      const reg = await prisma.registration.create({
        data: {
          classId,
          studentId,
          status: 'attended',
          tierAtBooking: 3,
          price: 6.11,
          tierRatio: 1.0,
        },
      });
      await prisma.payment.create({
        data: { registrationId: reg.id, amount: 6.11, status: paymentStatus },
      });
    }

    const clsA = await createCompletedClass(teacherId, teacherRoom.id, 9);
    const clsB = await createCompletedClass(teacherId, teacherRoom.id, 11);
    const clsC = await createCompletedClass(teacherId, teacherRoom.id, 15);
    const clsOther = await createCompletedClass(otherTeacherId, otherTeacherRoom.id, 13);

    // Student00: two overdue payments with the requesting teacher, plus a
    // paid one that must not widen the count.
    await createChargedRegistration(clsA.id, studentIds[0]!, 'overdue');
    await createChargedRegistration(clsB.id, studentIds[0]!, 'overdue');
    await createChargedRegistration(clsC.id, studentIds[0]!, 'paid');
    // Student01: overdue payment with the OTHER teacher only.
    await createChargedRegistration(clsOther.id, studentIds[1]!, 'overdue');
    // Student02: pending (not overdue) with the requesting teacher.
    await createChargedRegistration(clsA.id, studentIds[2]!, 'pending');
  });

  afterAll(async () => {
    // Guards: on a failed beforeAll roomId/otherTeacherId are undefined —
    // an undefined filter turns deleteMany into delete-all, and delete()
    // throws. overdueClassIds is safe unguarded: `in: []` matches nothing.
    await prisma.class.deleteMany({ where: { id: { in: overdueClassIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (otherTeacherId) {
      await prisma.teacher.delete({ where: { id: otherTeacherId } });
    }
    await prisma.account.deleteMany({
      where: { email: `crm-other-${suffix}@test.local` },
    });
  });

  async function fetchSingleStudent(search: string) {
    const res = await fetch(`${BASE_URL}/api/students?search=${search}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(1);
    return json.data.students[0];
  }

  it('counts overdue payments for the requesting teacher', async () => {
    const student = await fetchSingleStudent('Student00');
    expect(student.overduePayments).toBe(2);
  });

  it('ignores overdue payments owed to other teachers', async () => {
    const student = await fetchSingleStudent('Student01');
    expect(student.overduePayments).toBe(0);
  });

  it('does not count pending payments', async () => {
    const student = await fetchSingleStudent('Student02');
    expect(student.overduePayments).toBe(0);
  });

  it('maps counts to the right rows across a full page', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=1&pageSize=10`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const byName = new Map<string, number>(
      json.data.students.map(
        (s: { firstName: string; overduePayments: number }) => [s.firstName, s.overduePayments],
      ),
    );
    expect(byName.get('Student00')).toBe(2);
    expect(byName.get('Student01')).toBe(0);
    expect(byName.get('Student02')).toBe(0);
    // Student03 has no registrations at all.
    expect(byName.get('Student03')).toBe(0);
  });
});
