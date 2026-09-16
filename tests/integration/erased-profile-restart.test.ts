import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, freshIp, seedSession, uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

/**
 * Returns the id AND the address, because a live profile's `email` is a
 * denormalised copy of the account's, set at link time. Fixtures below keep
 * them equal: the liveness reasoning this change rests on interlocks with
 * that agreement, so a fixture that let them drift would not be the state
 * under test.
 */
async function account(tag: string): Promise<{ id: string; email: string }> {
  const row = await prisma.account.create({
    data: { email: `${tag}-${suffix}@test.local` },
  });
  accountIds.push(row.id);
  return { id: row.id, email: row.email };
}

function liveTeacher(acct: { id: string; email: string }, slugTag: string) {
  return prisma.teacher.create({
    data: {
      accountId: acct.id,
      firstName: 'Live', lastName: 'Teacher',
      email: acct.email,
      bio: '', pageSlug: `${slugTag}-${suffix}`,
    },
  });
}

/**
 * Exactly what `deleteStudentAccount` (services/gdpr.ts) leaves behind: the
 * name anonymised, the address tombstoned, `deletedAt` set — and `accountId`
 * and `claimedAt` both RETAINED. The retention is the whole point; a fixture
 * that cleared them would not reproduce the state under test.
 */
function erasedStudent(accountId: string, tag: string) {
  return prisma.student.create({
    data: {
      accountId,
      firstName: 'Deleted', lastName: 'Student',
      email: `${tag}-erased-${suffix}@deleted.invalid`,
      claimedAt: new Date(), deletedAt: new Date(),
    },
  });
}

describe('an erased profile no longer bars its account (#623)', () => {
  it('gives a live teacher with an erased student side a NEW student side', async () => {
    const acct = await account('student-restart');
    await liveTeacher(acct, 'student-restart-teacher');
    const erased = await erasedStudent(acct.id, 'student-restart');
    const token = await seedSession(prisma, acct.id);

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });

    // 201, not the 409 ALREADY_STUDENT that `SetUpStudentSide` read as
    // success before navigating to a page this session could not open.
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.studentId).not.toBe(erased.id);
  });

  it('opens /account/privacy for that session instead of bouncing it', async () => {
    const acct = await account('privacy-opens');
    await liveTeacher(acct, 'privacy-opens-teacher');
    await erasedStudent(acct.id, 'privacy-opens');
    const token = await seedSession(prisma, acct.id);

    await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });

    const page = await fetch(`${BASE_URL}/account/privacy`, {
      headers: { ...cookie(token), ...freshIp() },
    });

    // Acceptance criterion 3. Before this change the `(student)` layout found
    // no `session.studentId` and redirected to `/schedule` saying nothing.
    expect(page.status).toBe(200);
    expect(new URL(page.url).pathname).toBe('/account/privacy');
  });

  it('gives a live student with an erased teacher side a NEW teacher side', async () => {
    const acct = await account('teacher-restart');
    await prisma.student.create({
      data: {
        accountId: acct.id,
        firstName: 'Live', lastName: 'Student',
        email: acct.email,
        claimedAt: new Date(),
      },
    });
    await prisma.teacher.create({
      data: {
        accountId: acct.id,
        firstName: 'Deleted', lastName: 'Teacher',
        email: `teacher-restart-erased-${suffix}@deleted.invalid`,
        bio: '', pageSlug: `teacher-restart-erased-${suffix}`,
        deletedAt: new Date(),
      },
    });
    const token = await seedSession(prisma, acct.id);

    const res = await fetch(`${BASE_URL}/api/account/teacher-profile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
      body: JSON.stringify({
        firstName: 'Second', lastName: 'Innings', bio: '',
        pageSlug: `teacher-restart-new-${suffix}`,
      }),
    });

    expect(res.status).toBe(201);
  });

  it('still answers ALREADY_STUDENT when the student side is genuinely live', async () => {
    const acct = await account('already-live');
    await liveTeacher(acct, 'already-live-teacher');
    await prisma.student.create({
      data: {
        accountId: acct.id,
        firstName: 'Already', lastName: 'Live',
        email: acct.email,
        claimedAt: new Date(),
      },
    });
    const token = await seedSession(prisma, acct.id);

    const res = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });

    // This exercises the route's PRE-CHECK (`if (session.studentId)`), which
    // returns before the create is attempted — not the catch. Worth pinning
    // in its own right: the pre-check is what keeps `ALREADY_STUDENT` meaning
    // "you already have a live student side" now that an erased one no longer
    // produces that code. The proof that `isUniqueConflictOn(err,
    // ['accountId'])` still matches over a PARTIAL index is Task 2's
    // constraint test, which asserts that predicate on a real violation.
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ALREADY_STUDENT');
  });
});
