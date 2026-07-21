import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { resolveOrClaimAccount } from './account';

const db = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherAccountId: string;
let teacherId: string;
let claimedAccountId: string;
let claimedStudentId: string;
let unclaimedStudentId: string;

const teacherEmail = `account-teacher-${uniqueSuffix}@test.local`;
const claimedEmail = `account-claimed-${uniqueSuffix}@test.local`;
const unclaimedEmail = `account-unclaimed-${uniqueSuffix}@test.local`;

beforeAll(async () => {
  await db.$connect();

  const teacher = await db.teacher.create({
    data: {
      firstName: 'Resolve',
      lastName: 'Teacher',
      email: teacherEmail,
      bio: 'Account resolution fixtures',
      pageSlug: `account-teacher-${uniqueSuffix}`,
      account: { create: { email: teacherEmail } },
    },
    include: { account: true },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;

  const claimed = await db.student.create({
    data: {
      firstName: 'Resolve',
      lastName: 'Claimed',
      email: claimedEmail,
      claimedAt: new Date(),
      account: { create: { email: claimedEmail } },
    },
  });
  claimedStudentId = claimed.id;
  claimedAccountId = claimed.accountId!;

  // CRM-created, never signed in: no account yet.
  const unclaimed = await db.student.create({
    data: {
      firstName: 'Resolve',
      lastName: 'Unclaimed',
      email: unclaimedEmail,
    },
  });
  unclaimedStudentId = unclaimed.id;
});

afterAll(async () => {
  await db.student.deleteMany({
    where: { id: { in: [claimedStudentId, unclaimedStudentId] } },
  });
  await db.teacher.delete({ where: { id: teacherId } });
  await db.account.deleteMany({ where: { email: { contains: `${uniqueSuffix}` } } });
  await db.$disconnect();
});

describe('resolveOrClaimAccount', () => {
  it('resolves an existing teacher account with its profile ids', async () => {
    const resolved = await resolveOrClaimAccount(db, teacherEmail);

    expect(resolved).not.toBeNull();
    expect(resolved!.accountId).toBe(teacherAccountId);
    expect(resolved!.teacherId).toBe(teacherId);
    expect(resolved!.studentId).toBeNull();
  });

  it('resolves a claimed student through its account', async () => {
    const resolved = await resolveOrClaimAccount(db, claimedEmail);

    expect(resolved!.accountId).toBe(claimedAccountId);
    expect(resolved!.studentId).toBe(claimedStudentId);
    expect(resolved!.teacherId).toBeNull();
  });

  it('claims an unclaimed student: creates the account, links, stamps claimedAt', async () => {
    const resolved = await resolveOrClaimAccount(db, unclaimedEmail);

    expect(resolved).not.toBeNull();
    expect(resolved!.studentId).toBe(unclaimedStudentId);
    expect(resolved!.teacherId).toBeNull();

    const student = await db.student.findUnique({ where: { id: unclaimedStudentId } });
    expect(student!.accountId).toBe(resolved!.accountId);
    expect(student!.claimedAt).not.toBeNull();

    // Second resolution goes through the account path, same identity.
    const again = await resolveOrClaimAccount(db, unclaimedEmail);
    expect(again!.accountId).toBe(resolved!.accountId);
  });

  it('does not resolve soft-deleted profiles', async () => {
    await db.student.update({
      where: { id: claimedStudentId },
      data: { deletedAt: new Date() },
    });

    const resolved = await resolveOrClaimAccount(db, claimedEmail);

    // The account resolves, but the erased profile does not come back.
    expect(resolved).not.toBeNull();
    expect(resolved!.studentId).toBeNull();
    await db.student.update({ where: { id: claimedStudentId }, data: { deletedAt: null } });
  });

  it('returns null for an unknown email', async () => {
    expect(await resolveOrClaimAccount(db, `nobody-${uniqueSuffix}@test.local`)).toBeNull();
  });
});
