import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeSweep } from './scoped-sweep';

const prisma = new PrismaClient();
const suffix = Date.now();
let inId = '';
let outId = '';
// A second pair, scoped-deleted by the deleteMany case itself rather than
// surviving to the end of the file — afterAll cleans both ids and both
// accounts by their known (not re-queried) emails either way.
let throwInId = '';
let throwOutId = '';
const emails: string[] = [];

function teacherData(tag: string) {
  const email = `scoped-sweep-${tag}-${suffix}@test.local`;
  emails.push(email);
  return { firstName: 'Scoped', lastName: tag, email, bio: '', pageSlug: `scoped-sweep-${tag}-${suffix}`, account: { create: { email } } };
}

beforeAll(async () => {
  inId = (await prisma.teacher.create({ data: teacherData('in') })).id;
  outId = (await prisma.teacher.create({ data: teacherData('out') })).id;
  throwInId = (await prisma.teacher.create({ data: teacherData('throw-in') })).id;
  throwOutId = (await prisma.teacher.create({ data: teacherData('throw-out') })).id;
});

afterAll(async () => {
  await prisma.teacher.deleteMany({ where: { id: { in: [inId, outId, throwInId, throwOutId] } } });
  await prisma.account.deleteMany({ where: { email: { in: emails } } });
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
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId, throwInId] } } });
    const both = { id: { in: [inId, outId] } };
    expect(await s.db.teacher.count({ where: both })).toBe(1);
    const groups = await s.db.teacher.groupBy({ by: ['id'], where: both });
    expect(groups.map((g) => g.id)).toEqual([inId]);
    expect(s.rowsRead('Teacher')).toBe(1); // groupBy counted; count() is not a row read
    expect((await s.db.teacher.updateMany({ where: both, data: { bio: 'x' } })).count).toBe(1);
    const out = await prisma.teacher.findUniqueOrThrow({ where: { id: outId } });
    expect(out.bio).toBe('');
    expect((await s.db.teacher.deleteMany({ where: { id: { in: [throwInId, throwOutId] } } })).count).toBe(1);
    expect(await prisma.teacher.findUnique({ where: { id: throwOutId } })).not.toBeNull();
  });

  it('applies inside interactive transactions', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    const rows = await s.db.$transaction((tx) => tx.teacher.findMany({ where: { id: { in: [inId, outId] } } }));
    expect(rows.map((r) => r.id)).toEqual([inId]);
  });

  it('leaves unnamed models and single-row operations alone', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    expect(await s.db.teacher.findUnique({ where: { id: outId } })).not.toBeNull();
    // Account is not named in the scope, so an unscoped read reaches every
    // account this file has created so far, by email.
    const accounts = await s.db.account.findMany({ where: { email: { contains: `-${suffix}@` } } });
    expect(accounts.map((a) => a.email).sort()).toEqual([...emails].sort());
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
