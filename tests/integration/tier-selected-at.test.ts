import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const studentToken = crypto.randomBytes(32).toString('hex');
const teacherToken = crypto.randomBytes(32).toString('hex');
const BASE_URL = 'http://localhost:3000';

let studentId: string;
let teacherId: string;
let crmStudentId: string;

async function putStudent(
  id: string,
  body: Record<string, unknown>,
  token: string,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/students/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fair_yoga_session=${token}`,
    },
    body: JSON.stringify(body),
  });
}

describe('tierSelectedAt stamping', () => {
  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Chooser',
        lastName: 'Student',
        email: `tiersel-student-${uniqueSuffix}@test.local`,
        account: { create: { email: `tiersel-student-${uniqueSuffix}@test.local` } },
        claimedAt: new Date(),
        // Deliberately unstamped despite the claim: the backfill only
        // covers pre-migration students; this fixture simulates a student
        // who claimed but has not yet chosen.
        tierSelectedAt: null,
      },
    });
    studentId = student.id;

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tiersel',
        lastName: 'Teacher',
        email: `tiersel-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `tiersel-teacher-${uniqueSuffix}@test.local` } },
        bio: 'tierSelectedAt fixtures',
        pageSlug: `tiersel-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const crm = await prisma.student.create({
      data: {
        firstName: 'Roster',
        lastName: 'Student',
        email: `tiersel-crm-${uniqueSuffix}@test.local`,
      },
    });
    crmStudentId = crm.id;
    await prisma.teacherStudent.create({ data: { teacherId, studentId: crmStudentId } });

    await prisma.session.createMany({
      data: [
        {
          id: hashToken(studentToken),
          accountId: student.accountId!,
          expiresAt: new Date(Date.now() + 86400000),
        },
        {
          id: hashToken(teacherToken),
          accountId: teacher.accountId,
          expiresAt: new Date(Date.now() + 86400000),
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({
      where: { id: { in: [hashToken(studentToken), hashToken(teacherToken)] } },
    });
    if (teacherId) await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    const studentIds = [studentId, crmStudentId].filter(Boolean);
    if (studentIds.length) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${uniqueSuffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  it('a self-edit without incomeTier does not stamp', async () => {
    const res = await putStudent(studentId, { reminderPref: 'morning' }, studentToken);
    expect(res.status).toBe(200);
    const row = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect(row.tierSelectedAt).toBeNull();
  });

  it('a self-selected tier stamps tierSelectedAt', async () => {
    const res = await putStudent(studentId, { incomeTier: 4 }, studentToken);
    expect(res.status).toBe(200);
    const row = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect(row.incomeTier).toBe(4);
    expect(row.tierSelectedAt).not.toBeNull();
  });

  it('a teacher edit of an unclaimed CRM student can neither set the tier nor stamp', async () => {
    const res = await putStudent(
      crmStudentId,
      {
        firstName: 'Renamed',
        lastName: 'Student',
        email: `tiersel-crm-${uniqueSuffix}@test.local`,
        incomeTier: 5,
      },
      teacherToken,
    );
    expect(res.status).toBe(200);
    const row = await prisma.student.findUniqueOrThrow({ where: { id: crmStudentId } });
    expect(row.firstName).toBe('Renamed');
    expect(row.incomeTier).toBe(3); // teacher branch strips incomeTier — default untouched
    expect(row.tierSelectedAt).toBeNull();
  });
});
