import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fixtureRun } from '../../tests/room-fixtures';
import { createPrismaClient } from '@/lib/prisma-client';
import {
  enableScheduleShare,
  disableScheduleShare,
  resetScheduleShareKey,
  updateScheduleShare,
  getScheduleShare,
  teacherByShareKey,
  ScheduleShareOffError,
} from './schedule-share';

const prisma = createPrismaClient();
const fx = fixtureRun('shr');

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

const teacher = async () => (await fx.makeFixture(prisma)).teacherId;

describe('schedule sharing key (#916)', () => {
  it('enable mints a 22-character key; a second enable keeps it and reports no change', async () => {
    const id = await teacher();
    const first = await enableScheduleShare(prisma, id);
    expect(first.changed).toBe(true);
    expect(first.state.key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const second = await enableScheduleShare(prisma, id);
    expect(second).toEqual({ state: first.state, changed: false });
  });

  it('concurrent enables land exactly one key and exactly one change', async () => {
    const id = await teacher();
    const results = await Promise.all([1, 2, 3, 4].map(() => enableScheduleShare(prisma, id)));
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.state.key)).size).toBe(1);
  });

  it('disable clears the key, a repeat changes nothing, and enabling again mints a different key', async () => {
    const id = await teacher();
    const on = await enableScheduleShare(prisma, id);
    const off = await disableScheduleShare(prisma, id);
    expect(off.changed).toBe(true);
    expect(off.state.key).toBeNull();
    expect((await disableScheduleShare(prisma, id)).changed).toBe(false);
    const again = await enableScheduleShare(prisma, id);
    expect(again.state.key).not.toBe(on.state.key);
  });

  it('reset replaces the key and the old one no longer resolves', async () => {
    const id = await teacher();
    const old = (await enableScheduleShare(prisma, id)).state.key as string;
    const fresh = (await resetScheduleShareKey(prisma, id)).key as string;
    expect(fresh).not.toBe(old);
    expect(await teacherByShareKey(prisma, old)).toBeNull();
    expect((await teacherByShareKey(prisma, fresh))?.id).toBe(id);
  });

  it('reset while sharing is off refuses and mints nothing', async () => {
    const id = await teacher();
    await expect(resetScheduleShareKey(prisma, id)).rejects.toBeInstanceOf(ScheduleShareOffError);
    expect((await getScheduleShare(prisma, id)).key).toBeNull();
  });

  it('teacherByShareKey is null for an unknown key and for an erased teacher whose key is still set', async () => {
    expect(await teacherByShareKey(prisma, 'no-such-key-0000000000')).toBeNull();
    const id = await teacher();
    const key = (await enableScheduleShare(prisma, id)).state.key as string;
    expect(await teacherByShareKey(prisma, key)).not.toBeNull();
    await prisma.teacher.update({ where: { id }, data: { deletedAt: new Date() } });
    expect(await teacherByShareKey(prisma, key)).toBeNull();
  });

  it('settings update only what the patch names', async () => {
    const id = await teacher();
    expect(await updateScheduleShare(prisma, id, { weeks: 2 })).toMatchObject({ weeks: 2, includeStudio: false });
    expect(await updateScheduleShare(prisma, id, { includeStudio: true })).toMatchObject({ weeks: 2, includeStudio: true });
    expect(await updateScheduleShare(prisma, id, {})).toMatchObject({ weeks: 2, includeStudio: true });
  });
});
