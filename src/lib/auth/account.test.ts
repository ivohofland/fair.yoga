import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { resolveOrClaimAccount } from './account';
import { uniqueSuffix } from '../../../tests/helpers';
import { createPrismaClient } from '@/lib/prisma-client';
import { pgCause, typedCallError } from '../../../tests/adapter-errors';

const db = createPrismaClient();

function uniqueViolationOn(index: string) {
  return typedCallError(
    pgCause('23505', `duplicate key value violates unique constraint "${index}"`, { constraint: { index } }),
    'Account',
  );
}
const suffix = uniqueSuffix();

let teacherAccountId: string;
let teacherId: string;
let claimedAccountId: string;
let claimedStudentId: string;
let unclaimedStudentId: string;

const teacherEmail = `account-teacher-${suffix}@test.local`;
const claimedEmail = `account-claimed-${suffix}@test.local`;
const unclaimedEmail = `account-unclaimed-${suffix}@test.local`;

beforeAll(async () => {
  await db.$connect();

  const teacher = await db.teacher.create({
    data: {
      firstName: 'Resolve',
      lastName: 'Teacher',
      email: teacherEmail,
      bio: 'Account resolution fixtures',
      pageSlug: `account-teacher-${suffix}`,
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
  await db.account.deleteMany({
    where: { email: { in: [teacherEmail, claimedEmail, unclaimedEmail] } },
  });
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

  it('signs in through the account a racing claim created, on a violation of Account_email_key', async () => {
    const email = `account-race-${suffix}@test.local`;
    const student = await db.student.create({ data: { firstName: 'Resolve', lastName: 'Race', email } });
    // The racer's account lands first, then this call's create loses on the key.
    let racerId: string | undefined;
    const create = vi.spyOn(db.account, 'create').mockImplementationOnce((async () => {
      const racer = await db.account.create({ data: { email } });
      racerId = racer.id;
      await db.student.update({ where: { id: student.id }, data: { claimedAt: new Date(), accountId: racer.id } });
      throw uniqueViolationOn('Account_email_key');
    }) as never);
    try {
      const resolved = await resolveOrClaimAccount(db, email);
      expect(resolved?.studentId).toBe(student.id);
      expect(resolved?.accountId).toBe(racerId);
      expect(await db.account.count({ where: { email } })).toBe(1);
    } finally {
      create.mockRestore();
      await db.student.delete({ where: { id: student.id } });
      await db.account.deleteMany({ where: { email } });
    }
  });

  it('rethrows a unique violation on an index other than Account_email_key', async () => {
    const email = `account-otherkey-${suffix}@test.local`;
    const student = await db.student.create({ data: { firstName: 'Resolve', lastName: 'OtherKey', email } });
    const other = uniqueViolationOn('Account_other_key');
    const create = vi.spyOn(db.account, 'create').mockRejectedValueOnce(other);
    try {
      await expect(resolveOrClaimAccount(db, email)).rejects.toBe(other);
    } finally {
      create.mockRestore();
      await db.student.delete({ where: { id: student.id } });
      await db.account.deleteMany({ where: { email } });
    }
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

  it('does not resolve a soft-deleted teacher profile', async () => {
    await db.teacher.update({
      where: { id: teacherId },
      data: { deletedAt: new Date() },
    });

    const resolved = await resolveOrClaimAccount(db, teacherEmail);

    // The account resolves, but the erased profile does not come back.
    expect(resolved).not.toBeNull();
    expect(resolved!.teacherId).toBeNull();
    await db.teacher.update({ where: { id: teacherId }, data: { deletedAt: null } });
  });

  it('returns null for an unknown email', async () => {
    expect(await resolveOrClaimAccount(db, `nobody-${suffix}@test.local`)).toBeNull();
  });
});
