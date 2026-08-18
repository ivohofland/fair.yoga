/**
 * Doors 2 and 3 of the room archive lifecycle (issue 76): an archived room
 * accepts no new commitments. Door 1 lives in `room-archive.test.ts`; door 4
 * is an HTTP-level guard and is pinned in `tests/integration/`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { transitionClass } from './class-lifecycle';

const prisma = new PrismaClient();
// `rad-` distinguishes this file's rows from `room-archive.test.ts`'s,
// so each file's cleanup sweeps only its own.
const fx = fixtureRun('rad');
const makeFixture = () => fx.makeFixture(prisma);
const addClass = (f: RoomFixture, status: ClassFixtureStatus) => fx.addClass(prisma, f, status);

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('transitionClass — door 2: publishing into an archived room', () => {
  it('refuses to publish a draft whose room is archived', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'draft');
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ROOM_ARCHIVED');
    expect(result.error).toBe('This room is archived. Unarchive it to publish classes here.');

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('draft');
  });

  it('publishes a draft whose room is not archived', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'draft');

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(true);
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(after.status).toBe('open');
  });
});
