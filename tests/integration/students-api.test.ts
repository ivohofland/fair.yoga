import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherId: string;
let studentIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'CRM',
      lastName: 'Teacher',
      email: `crm-teacher-${uniqueSuffix}@test.local`,
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
  await prisma.session.create({
    data: {
      id: `crm-session-${uniqueSuffix}`,
      userId: teacherId,
      userType: 'teacher',
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
});

afterAll(async () => {
  await prisma.teacherStudent.deleteMany({
    where: { teacherId },
  });
  await prisma.session.deleteMany({
    where: { id: `crm-session-${uniqueSuffix}` },
  });
  await prisma.student.deleteMany({
    where: { id: { in: studentIds } },
  });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=crm-session-${uniqueSuffix}`;

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
