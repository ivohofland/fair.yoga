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
const uniqueSuffix = Date.now();
const rawSessionToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
const studentIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'CRM',
      lastName: 'Teacher',
      email: `crm-teacher-${uniqueSuffix}@test.local`,
      account: { create: { email: `crm-teacher-${uniqueSuffix}@test.local` } },
      bio: 'Teacher for CRM tests',
      pageSlug: `crm-teacher-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;

  // Create 25 students linked to this teacher
  for (let i = 0; i < 25; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: `Student${String(i).padStart(2, '0')}`,
        lastName: 'Test',
        email: `crm-student-${uniqueSuffix}-${i}@test.local`,
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
      email: `crm-unlinked-${uniqueSuffix}@test.local`,
    },
  });
  studentIds.push(unlinked.id);

  // Create a session for the teacher
  const teacherAccount = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(rawSessionToken),
      accountId: teacherAccount.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
});

afterAll(async () => {
  await prisma.teacherStudent.deleteMany({
    where: { teacherId },
  });
  await prisma.session.deleteMany({
    where: { id: hashToken(rawSessionToken) },
  });
  await prisma.student.deleteMany({
    where: { id: { in: studentIds } },
  });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=${rawSessionToken}`;

describe('GET /api/students', () => {
  it('returns paginated students for the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=1&pageSize=10`, {
      headers: { Cookie: sessionCookie },
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
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(5);
    expect(json.data.total).toBe(25);
    expect(json.data.page).toBe(3);
  });

  it('filters by search term (name)', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Student00`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(1);
    expect(json.data.students[0].firstName).toBe('Student00');
  });

  it('filters by search term (email)', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students?search=crm-student-${uniqueSuffix}-1@`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students.length).toBeGreaterThanOrEqual(1);
  });

  it('does not return students not linked to the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Unlinked`, {
      headers: { Cookie: sessionCookie },
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
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${uniqueSuffix}@test.local`,
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
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${uniqueSuffix}@test.local`,
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
        email: `crm-teacher2-${uniqueSuffix}@test.local`,
        account: { create: { email: `crm-teacher2-${uniqueSuffix}@test.local` } },
        bio: 'Second teacher',
        pageSlug: `crm-teacher2-${uniqueSuffix}`,
      },
    });
    const rawToken2 = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({
      data: {
        id: hashToken(rawToken2),
        accountId: teacher2.accountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    // Teacher 2 adds the same student by email
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_session=${rawToken2}`,
      },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${uniqueSuffix}@test.local`,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(createdStudentId); // Same student, no duplicate

    // Cleanup teacher2
    await prisma.teacherStudent.deleteMany({ where: { teacherId: teacher2.id } });
    await prisma.session.delete({ where: { id: hashToken(rawToken2) } });
    await prisma.teacher.delete({ where: { id: teacher2.id } });
  });

  it('returns 400 for invalid input', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
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
  const dualSuffix = `${Date.now()}-dual`;
  const dualToken = crypto.randomBytes(32).toString('hex');
  const rosterToken = crypto.randomBytes(32).toString('hex');

  let dualTeacherId: string;
  let dualOwnStudentId: string;
  let dualAccountId: string;
  let rosterStudentId: string;
  let rosterAccountId: string;

  const as = (token: string, path: string, init?: RequestInit) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
        Cookie: `fair_yoga_session=${token}`,
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
    await prisma.session.create({
      data: {
        id: hashToken(dualToken),
        accountId: dualAccountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

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
    await prisma.session.create({
      data: {
        id: hashToken(rosterToken),
        accountId: rosterAccountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
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
