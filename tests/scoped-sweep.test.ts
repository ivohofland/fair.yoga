import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scopeSweep } from './scoped-sweep';

const prisma = new PrismaClient();
const suffix = Date.now();
let inId = '';
let outId = '';
// The deleteMany case's own pair: the scoped delete removes `delInId` and
// must leave `delOutId`. afterAll deletes every teacher id here, and every
// account by the emails `teacherData` recorded.
let delInId = '';
let delOutId = '';
const emails: string[] = [];

function teacherData(tag: string) {
  const email = `scoped-sweep-${tag}-${suffix}@test.local`;
  emails.push(email);
  return { firstName: 'Scoped', lastName: tag, email, bio: '', pageSlug: `scoped-sweep-${tag}-${suffix}`, account: { create: { email } } };
}

beforeAll(async () => {
  inId = (await prisma.teacher.create({ data: teacherData('in') })).id;
  outId = (await prisma.teacher.create({ data: teacherData('out') })).id;
  delInId = (await prisma.teacher.create({ data: teacherData('del-in') })).id;
  delOutId = (await prisma.teacher.create({ data: teacherData('del-out') })).id;
});

afterAll(async () => {
  try {
    await prisma.teacher.deleteMany({ where: { id: { in: [inId, outId, delInId, delOutId] } } });
  } finally {
    await prisma.account.deleteMany({ where: { email: { in: emails } } });
    await prisma.$disconnect();
  }
});

describe('scopeSweep', () => {
  it('ANDs the scope into findMany rather than replacing the caller’s where', async () => {
    // The scope admits `outId`, which the caller's own where excludes: a
    // scope that replaced the where would return it.
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId, outId] } } });
    const rows = await s.db.teacher.findMany({ where: { id: { in: [inId, delInId] } } });
    expect(rows.map((r) => r.id)).toEqual([inId]);
    expect(s.rowsRead('Teacher')).toBe(1);
  });

  it('scopes a findMany with no where of its own', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    expect((await s.db.teacher.findMany()).map((r) => r.id)).toEqual([inId]);
  });

  it('scopes findFirst and findFirstOrThrow, counting a miss as no row', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    expect(await s.db.teacher.findFirst({ where: { id: outId } })).toBeNull();
    expect(s.rowsRead('Teacher')).toBe(0);
    await expect(s.db.teacher.findFirstOrThrow({ where: { id: outId } })).rejects.toThrow();
    expect((await s.db.teacher.findFirstOrThrow({ where: { id: { in: [inId, outId] } } })).id).toBe(inId);
    expect(s.rowsRead('Teacher')).toBe(1);
  });

  it('scopes count, aggregate and groupBy; only groupBy counts as a read', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId, delInId] } } });
    const both = { id: { in: [inId, outId] } };
    expect(await s.db.teacher.count({ where: both })).toBe(1);
    expect((await s.db.teacher.aggregate({ where: both, _count: { _all: true } }))._count._all).toBe(1);
    expect(s.rowsRead('Teacher')).toBe(0);
    const groups = await s.db.teacher.groupBy({ by: ['id'], where: both });
    expect(groups.map((g) => g.id)).toEqual([inId]);
    expect(s.rowsRead('Teacher')).toBe(1);
  });

  it('scopes updateMany, updateManyAndReturn and deleteMany without counting them as reads', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId, delInId] } } });
    const both = { id: { in: [inId, outId] } };
    expect((await s.db.teacher.updateMany({ where: both, data: { bio: 'x' } })).count).toBe(1);
    const returned = await s.db.teacher.updateManyAndReturn({ where: both, data: { bio: 'y' } });
    expect(returned.map((t) => t.id)).toEqual([inId]);
    expect((await prisma.teacher.findUniqueOrThrow({ where: { id: outId } })).bio).toBe('');
    expect((await s.db.teacher.deleteMany({ where: { id: { in: [delInId, delOutId] } } })).count).toBe(1);
    expect(await prisma.teacher.findUnique({ where: { id: delOutId } })).not.toBeNull();
    expect(s.rowsRead('Teacher')).toBe(0);
  });

  it('sums rowsRead across calls', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    await s.db.teacher.findMany();
    await s.db.teacher.findMany();
    expect(s.rowsRead('Teacher')).toBe(2);
  });

  it('applies inside interactive transactions', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    const rows = await s.db.$transaction((tx) => tx.teacher.findMany({ where: { id: { in: [inId, outId] } } }));
    expect(rows.map((r) => r.id)).toEqual([inId]);
  });

  it('applies inside batch transactions', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    const [rows, count] = await s.db.$transaction([
      s.db.teacher.findMany({ where: { id: { in: [inId, outId] } } }),
      s.db.teacher.count({ where: { id: { in: [inId, outId] } } }),
    ]);
    expect(rows.map((r) => r.id)).toEqual([inId]);
    expect(count).toBe(1);
  });

  it('leaves unnamed models and single-row operations alone', async () => {
    const s = scopeSweep(prisma, { Teacher: { id: { in: [inId] } } });
    expect(await s.db.teacher.findUnique({ where: { id: outId } })).not.toBeNull();
    // Account is not named in the scope, so an unscoped read reaches every
    // account this file has created, by email.
    const accounts = await s.db.account.findMany({ where: { email: { contains: `-${suffix}@` } } });
    expect(accounts.map((a) => a.email).sort()).toEqual([...emails].sort());
    expect(() => s.rowsRead('Account')).toThrow(/does not name Account/);
  });

  it('refuses a scope that would silently narrow nothing', () => {
    expect(() => scopeSweep(prisma, {})).toThrow(/names no model/);
    expect(() => scopeSweep(prisma, { Teacher: {} })).toThrow(/Teacher is an empty filter/);
    expect(() => scopeSweep(prisma, { Teacher: { id: undefined } })).toThrow(/Teacher\.id is undefined/);
    expect(() => scopeSweep(prisma, { Teacher: { id: { in: [inId, undefined as unknown as string] } } })).toThrow(/Teacher\.id\.in\.1 is undefined/);
    const misspelt = { Teacher: { id: inId }, Teachr: { id: inId } };
    expect(() => scopeSweep(prisma, misspelt)).toThrow(/"Teachr" is not a model/);
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
