/**
 * Doors 2 and 3 of the room archive lifecycle (issue 76): an archived room
 * accepts no new commitments. Door 1 lives in `room-archive.test.ts`; door 4
 * is an HTTP-level guard and is pinned in `tests/integration/`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { transitionClass } from './class-lifecycle';
import { pauseOrResumeTemplate } from './class-template-lifecycle';

const prisma = new PrismaClient();
// `rad-` distinguishes this file's rows from `room-archive.test.ts`'s,
// so each file's cleanup sweeps only its own.
const fx = fixtureRun('rad');
const makeFixture = () => fx.makeFixture(prisma);
const addClass = (f: RoomFixture, status: ClassFixtureStatus) => fx.addClass(prisma, f, status);
const addTemplate = (f: RoomFixture, opts: { isActive: boolean; isArchived: boolean }) =>
  fx.addTemplate(prisma, f, opts);

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

describe('pauseOrResumeTemplate — door 3: resuming into an archived room', () => {
  it('refuses to resume a paused template whose room is archived', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await pauseOrResumeTemplate(prisma, tpl.id, f.teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'room_archived' });

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    expect(after.isActive).toBe(false);
    expect(await prisma.class.count({ where: { templateId: tpl.id } })).toBe(0);
  });

  // Pausing is the safe direction and must stay unguarded — otherwise a
  // teacher whose room is archived cannot even stop the template.
  it('still allows pausing a template whose room is archived', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: true, isArchived: false });
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await pauseOrResumeTemplate(prisma, tpl.id, f.teacherId, 'paused');

    expect(result).toMatchObject({ ok: true, action: 'paused' });
  });
});
