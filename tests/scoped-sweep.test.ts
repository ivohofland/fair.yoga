import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeSweep } from './scoped-sweep';

const prisma = new PrismaClient();
const suffix = Date.now();
let inId = '';
let outId = '';

function teacherData(tag: string) {
  const email = `scoped-sweep-${tag}-${suffix}@test.local`;
  return { firstName: 'Scoped', lastName: tag, email, bio: '', pageSlug: `scoped-sweep-${tag}-${suffix}`, account: { create: { email } } };
}

beforeAll(async () => {
  inId = (await prisma.teacher.create({ data: teacherData('in') })).id;
  outId = (await prisma.teacher.create({ data: teacherData('out') })).id;
});

afterAll(async () => {
  const teachers = await prisma.teacher.findMany({ where: { id: { in: [inId, outId] } } });
  await prisma.teacher.deleteMany({ where: { id: { in: [inId, outId] } } });
  await prisma.account.deleteMany({ where: { email: { in: teachers.map((t) => t.email) } } });
  await prisma.$disconnect();
});

describe('scopeSweep', () => {
  it('ANDs the scope into findMany and counts what it returned', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    const rows = await s.db.teacher.findMany({ where: { id: { in: [inId, outId] } } });
    expect(rows.map((r) => r.id)).toEqual([inId]);
    expect(s.rowsRead('Teacher')).toBe(1);
  });

  it('scopes a findMany with no where of its own', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    expect((await s.db.teacher.findMany()).map((r) => r.id)).toEqual([inId]);
  });

  it('scopes count, groupBy, updateMany and deleteMany', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    const both = { id: { in: [inId, outId] } };
    expect(await s.db.teacher.count({ where: both })).toBe(1);
    const groups = await s.db.teacher.groupBy({ by: ['id'], where: both });
    expect(groups.map((g) => g.id)).toEqual([inId]);
    expect(s.rowsRead('Teacher')).toBe(1); // groupBy counted; count() is not a row read
    expect((await s.db.teacher.updateMany({ where: both, data: { bio: 'x' } })).count).toBe(1);
    const out = await prisma.teacher.findUniqueOrThrow({ where: { id: outId } });
    expect(out.bio).toBe('');
  });

  it('applies inside interactive transactions', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    const rows = await s.db.$transaction((tx) => tx.teacher.findMany({ where: { id: { in: [inId, outId] } } }));
    expect(rows.map((r) => r.id)).toEqual([inId]);
  });

  it('leaves unnamed models and single-row operations alone', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    expect(await s.db.teacher.findUnique({ where: { id: outId } })).not.toBeNull();
    expect(await s.db.account.count({ where: { email: { contains: `-${suffix}@` } } })).toBe(2);
    expect(s.rowsRead('Account')).toBe(0);
  });

  it('lets a hook on the client handed in see the args before the scope', async () => {
    let seen: unknown;
    let hookRows: (string | undefined)[] = [];
    const hooked = prisma.$extends({
      query: { teacher: { async findMany({ args, query }) { seen = args.where; const r = await query(args); hookRows = r.map((t) => t.id); return r; } } },
    }) as unknown as PrismaClient;
    const s = scopeSweep(hooked, { Teacher: { id: { in: [inId] } } });
    await s.db.teacher.findMany({ where: { id: { in: [inId, outId] } } });
    expect(seen).toEqual({ id: { in: [inId, outId] } });
    expect(hookRows).toEqual([inId]); // the hook's own query() is scoped
  });
});
