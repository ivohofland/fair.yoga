import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { isUniqueConflictOn } from '@/lib/unique-conflict';

const prisma = new PrismaClient();
const suffix = `live-profile-${Date.now()}`;
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

async function makeAccount(tag: string): Promise<string> {
  const account = await prisma.account.create({
    data: { email: `${tag}-${suffix}@test.local` },
  });
  accountIds.push(account.id);
  return account.id;
}

/**
 * These assert the DATABASE refuses the write. `liveProfile`
 * (`src/lib/live-profile.ts`) throws when a query hands it two LIVE rows for
 * one account — a state these indexes are what makes unreachable, so without
 * them that throw would be the only thing standing between a caller and it.
 *
 * `isUniqueConflictOn` rather than a message match: it is the predicate
 * `POST /api/account/teacher-profile` and `POST /api/account/student-profile`
 * use to turn this exact conflict into a coded 409, so asserting it here is
 * what proves those routes still work over a partial index rather than
 * falling through to their unrecognised-P2002 throw.
 */
describe('one live profile per account (#623)', () => {
  it('accepts a new live Student beside an erased one on the same account', async () => {
    const accountId = await makeAccount('student-restart');
    await prisma.student.create({
      data: {
        accountId,
        firstName: 'Deleted', lastName: 'Student',
        email: `erased-student-${suffix}@deleted.invalid`,
        claimedAt: new Date(), deletedAt: new Date(),
      },
    });

    const live = await prisma.student.create({
      data: {
        accountId,
        firstName: 'Fresh', lastName: 'Start',
        email: `live-student-${suffix}@test.local`,
        claimedAt: new Date(),
      },
    });
    expect(live.accountId).toBe(accountId);
  });

  it('refuses a second LIVE Student on one account', async () => {
    const accountId = await makeAccount('student-double');
    await prisma.student.create({
      data: {
        accountId,
        firstName: 'First', lastName: 'Live',
        email: `first-live-${suffix}@test.local`,
        claimedAt: new Date(),
      },
    });

    let caught: unknown;
    try {
      await prisma.student.create({
        data: {
          accountId,
          firstName: 'Second', lastName: 'Live',
          email: `second-live-${suffix}@test.local`,
          claimedAt: new Date(),
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConflictOn(caught, ['accountId'])).toBe(true);
  });

  it('accepts a new live Teacher beside an erased one on the same account', async () => {
    const accountId = await makeAccount('teacher-restart');
    await prisma.teacher.create({
      data: {
        accountId,
        firstName: 'Deleted', lastName: 'Teacher',
        email: `erased-teacher-${suffix}@deleted.invalid`,
        bio: '', pageSlug: `deleted-teacher-${suffix}`,
        deletedAt: new Date(),
      },
    });

    const live = await prisma.teacher.create({
      data: {
        accountId,
        firstName: 'Fresh', lastName: 'Teacher',
        email: `live-teacher-${suffix}@test.local`,
        bio: '', pageSlug: `live-teacher-${suffix}`,
      },
    });
    expect(live.accountId).toBe(accountId);
  });

  it('refuses a second LIVE Teacher on one account', async () => {
    const accountId = await makeAccount('teacher-double');
    await prisma.teacher.create({
      data: {
        accountId,
        firstName: 'First', lastName: 'Teacher',
        email: `first-teacher-${suffix}@test.local`,
        bio: '', pageSlug: `first-teacher-${suffix}`,
      },
    });

    let caught: unknown;
    try {
      await prisma.teacher.create({
        data: {
          accountId,
          firstName: 'Second', lastName: 'Teacher',
          email: `second-teacher-${suffix}@test.local`,
          bio: '', pageSlug: `second-teacher-${suffix}`,
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(isUniqueConflictOn(caught, ['accountId'])).toBe(true);
  });
});
