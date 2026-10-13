import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../../tests/helpers';
import { findReservedSlugHolders } from './reserved-slug-holders';

const db = new PrismaClient();
const suffix = uniqueSuffix();
const teacherIds: string[] = [];
const accountIds: string[] = [];

async function teacherWithSlug(pageSlug: string): Promise<string> {
  const email = `reserved-slug-${pageSlug}@test.local`;
  const t = await db.teacher.create({
    data: { firstName: 'Slug', lastName: 'Holder', email, bio: '', pageSlug, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return t.id;
}

afterAll(async () => {
  // Teacher → Account does not cascade, so the teachers go first.
  if (teacherIds.length > 0) {
    await db.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await db.$disconnect();
});

describe('findReservedSlugHolders', () => {
  it('names each teacher holding a reserved name, ordered by slug, and no one else', async () => {
    const b = await teacherWithSlug(`zz-b-${suffix}`);
    const a = await teacherWithSlug(`zz-a-${suffix}`);
    await teacherWithSlug(`zz-free-${suffix}`);
    const holders = await findReservedSlugHolders(db, [`zz-b-${suffix}`, `zz-a-${suffix}`, `zz-unheld-${suffix}`]);
    expect(holders).toEqual([
      { teacherId: a, pageSlug: `zz-a-${suffix}` },
      { teacherId: b, pageSlug: `zz-b-${suffix}` },
    ]);
  });

  it('answers empty for an empty list', async () => {
    expect(await findReservedSlugHolders(db, [])).toEqual([]);
  });
});
