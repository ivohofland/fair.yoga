/**
 * `switchToSharedRoom` (issue 259). Spec:
 * `docs/superpowers/specs/2026-09-26-switch-to-shared-room-design.md`.
 *
 * Real database, fresh fixture per case (`tests/room-fixtures.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { switchToSharedRoom } from './room-switch';

const prisma = new PrismaClient();
const fx = fixtureRun('rsw');
const makeFixture = () => fx.makeFixture(prisma);
const addClass = (f: RoomFixture, status: ClassFixtureStatus, daysAhead: number) =>
  fx.addClass(prisma, f, status, { daysAhead });
const addTemplate = (
  f: RoomFixture,
  opts: { isActive: boolean; isArchived: boolean; dayOfWeek?: number },
) => fx.addTemplate(prisma, f, opts);
const addSharedTwin = (
  f: RoomFixture,
  opts?: { maxCapacity?: number; twinCase?: boolean; roomName?: string },
) => fx.addSharedTwin(prisma, f, opts);

const run = (f: RoomFixture, sharedRoomId: string) =>
  switchToSharedRoom(prisma, { teacherId: f.teacherId, teacherRoomId: f.linkId, sharedRoomId });

const linkOn = (teacherId: string, roomId: string) =>
  prisma.teacherRoom.findUnique({ where: { teacherId_roomId: { teacherId, roomId } } });

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  // The fixture cleanup sweeps rooms by creator, which includes the twins.
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('switchToSharedRoom — what moves and what stays', () => {
  // Fails under option A (moves all four) and option C (moves none).
  it('moves draft and open classes, and leaves completed and cancelled ones', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const draft = await addClass(f, 'draft', 14);
    const open = await addClass(f, 'open', 15);
    const completed = await addClass(f, 'completed', 16);
    const cancelled = await addClass(f, 'cancelled', 17);

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', moved: { classes: 2 } });
    if (!result.ok || result.action !== 'switched') throw new Error('unreachable');
    const after = await prisma.class.findMany({
      where: { id: { in: [draft.id, open.id, completed.id, cancelled.id] } },
      select: { id: true, teacherRoomId: true, roomArchived: true },
    });
    const byId = new Map(after.map((c) => [c.id, c]));
    expect(byId.get(draft.id)).toMatchObject({ teacherRoomId: result.teacherRoomId, roomArchived: false });
    expect(byId.get(open.id)).toMatchObject({ teacherRoomId: result.teacherRoomId, roomArchived: false });
    expect(byId.get(completed.id)).toMatchObject({ teacherRoomId: f.linkId, roomArchived: true });
    expect(byId.get(cancelled.id)).toMatchObject({ teacherRoomId: f.linkId, roomArchived: true });

    const priv = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(priv.isArchived).toBe(true);
  });

  it('moves every template, whatever its rule state', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const active = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    const paused = await addTemplate(f, { isActive: false, isArchived: false, dayOfWeek: 2 });
    const archived = await addTemplate(f, { isActive: false, isArchived: true, dayOfWeek: 3 });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', moved: { templates: 3 } });
    if (!result.ok) throw new Error('unreachable');
    const onShared = await prisma.classTemplate.findMany({
      where: { id: { in: [active.id, paused.id, archived.id] } },
      select: { teacherRoomId: true, roomArchived: true },
    });
    expect(onShared).toHaveLength(3);
    for (const t of onShared) expect(t).toEqual({ teacherRoomId: result.teacherRoomId, roomArchived: false });
  });

  it('refuses while a class is in progress, and changes nothing', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const open = await addClass(f, 'open', 14);
    const running = await addClass(f, 'in_progress', 15);
    const tpl = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });

    const result = await run(f, shared.id);

    expect(result).toEqual({ ok: false, reason: 'class_in_progress' });
    const classes = await prisma.class.findMany({
      where: { id: { in: [open.id, running.id] } },
      select: { teacherRoomId: true },
    });
    for (const c of classes) expect(c.teacherRoomId).toBe(f.linkId);
    const t = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id } });
    expect(t.teacherRoomId).toBe(f.linkId);
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
    expect(await linkOn(f.teacherId, shared.id)).toBeNull();
  });

  it('writes no economic field on a moved class or template', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { maxCapacity: 5 });
    const open = await addClass(f, 'open', 14);
    const tpl = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    const pick = { roomCost: true, minRate: true, targetRate: true, minStudents: true, maxStudents: true } as const;
    const clsBefore = await prisma.class.findUniqueOrThrow({ where: { id: open.id }, select: pick });
    const tplBefore = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id }, select: pick });

    await run(f, shared.id);

    expect(await prisma.class.findUniqueOrThrow({ where: { id: open.id }, select: pick })).toEqual(clsBefore);
    expect(await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id }, select: pick })).toEqual(tplBefore);
  });
});

describe('switchToSharedRoom — the shared link', () => {
  it('creates a link carrying the private rate, clamped to the shared maximum', async () => {
    const f = await makeFixture(); // private link: capacity 15, rate 30
    const shared = await addSharedTwin(f, { maxCapacity: 10 });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({
      ok: true, action: 'switched', reusedLink: false, capacityClamped: { from: 15, to: 10 },
    });
    const link = await linkOn(f.teacherId, shared.id);
    expect(link?.capacityOverride).toBe(10);
    expect(link?.rentalRate.equals(new Prisma.Decimal(30))).toBe(true);
    expect(link?.isArchived).toBe(false);
  });

  it('does not clamp when the private capacity fits', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { maxCapacity: 24 });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', capacityClamped: null });
    expect((await linkOn(f.teacherId, shared.id))?.capacityOverride).toBe(15);
  });

  it('reuses an existing link and keeps its values', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const existing = await prisma.teacherRoom.create({
      data: {
        teacherId: f.teacherId, roomId: shared.id,
        capacityOverride: 12, rentalRate: new Prisma.Decimal(55),
      },
    });

    const result = await run(f, shared.id);

    expect(result).toMatchObject({
      ok: true, action: 'switched', teacherRoomId: existing.id, reusedLink: true, capacityClamped: null,
    });
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: existing.id } });
    expect(after.capacityOverride).toBe(12);
    expect(after.rentalRate.equals(new Prisma.Decimal(55))).toBe(true);
  });

  it('un-archives an archived existing link before moving live rows onto it', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const existing = await prisma.teacherRoom.create({
      data: {
        teacherId: f.teacherId, roomId: shared.id,
        capacityOverride: 12, rentalRate: new Prisma.Decimal(55), isArchived: true,
      },
    });
    const open = await addClass(f, 'open', 14);

    const result = await run(f, shared.id);

    expect(result).toMatchObject({ ok: true, action: 'switched', teacherRoomId: existing.id, reusedLink: true });
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: existing.id } })).isArchived).toBe(false);
    expect(await prisma.class.findUniqueOrThrow({ where: { id: open.id } }))
      .toMatchObject({ teacherRoomId: existing.id, roomArchived: false });
  });
});

describe('switchToSharedRoom — refusals and the unchanged answer', () => {
  it('answers not_found for a missing link and forbidden for another teacher\'s', async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    const shared = await addSharedTwin(f);

    expect(await switchToSharedRoom(prisma, {
      teacherId: f.teacherId, teacherRoomId: crypto.randomUUID(), sharedRoomId: shared.id,
    })).toEqual({ ok: false, reason: 'not_found' });
    expect(await switchToSharedRoom(prisma, {
      teacherId: other.teacherId, teacherRoomId: f.linkId, sharedRoomId: shared.id,
    })).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('answers now_shared when the private link\'s room has been shared', async () => {
    const f = await makeFixture();
    const other = await makeFixture();
    // Ruling R1: give the room a run-unique roomName before publishing it, or
    // the fixture identity (empty floor and roomName) could collide with
    // another public room on `Room_public_identity_unique`.
    await prisma.room.update({ where: { id: f.roomId }, data: { roomName: `Now shared ${fx.suffix}` } });
    await prisma.room.update({ where: { id: f.roomId }, data: { isPublic: true } });
    const shared = await addSharedTwin(other);

    expect(await run(f, shared.id)).toEqual({ ok: false, reason: 'now_shared' });
  });

  it('answers shared_room_not_found for a private or missing target', async () => {
    const f = await makeFixture();
    const other = await makeFixture(); // a PRIVATE room

    expect(await run(f, other.roomId)).toEqual({ ok: false, reason: 'shared_room_not_found' });
    expect(await run(f, crypto.randomUUID())).toEqual({ ok: false, reason: 'shared_room_not_found' });
  });

  it('refuses a shared room that is not the same room', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { roomName: `Other ${fx.suffix}` });

    expect(await run(f, shared.id)).toEqual({ ok: false, reason: 'not_same_room' });
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
  });

  // Mirrors `Room_public_identity_unique`'s lower(trim(...)).
  it('treats case and whitespace differences as the same room', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f, { twinCase: true });

    expect(await run(f, shared.id)).toMatchObject({ ok: true, action: 'switched' });
  });

  it('answers unchanged on a repeat, with the shared link and no write', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    await addClass(f, 'open', 14);
    const first = await run(f, shared.id);
    if (!first.ok) throw new Error('first switch failed');
    const linkBefore = await linkOn(f.teacherId, shared.id);

    const second = await run(f, shared.id);

    expect(second).toEqual({ ok: true, action: 'unchanged', teacherRoomId: first.teacherRoomId });
    expect((await linkOn(f.teacherId, shared.id))?.updatedAt).toEqual(linkBefore?.updatedAt);
  });
});

describe('switchToSharedRoom — atomicity', () => {
  // A failure after the classes have moved (spec §6 item 3). The injection is
  // a trigger scoped to this one link id, so parallel files cannot hit it, and
  // it is dropped in `finally`.
  it('leaves everything where it was when the final archive fails', async () => {
    const f = await makeFixture();
    const shared = await addSharedTwin(f);
    const open = await addClass(f, 'open', 14);
    const tpl = await addTemplate(f, { isActive: true, isArchived: false, dayOfWeek: 1 });
    if (!/^[0-9a-f-]{36}$/.test(f.linkId)) throw new Error('link id is not a uuid');
    const fn = `rsw_fail_${f.linkId.replace(/-/g, '')}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER ${fn} BEFORE UPDATE ON "TeacherRoom" FOR EACH ROW
      WHEN (NEW.id = '${f.linkId}' AND NEW."isArchived") EXECUTE FUNCTION ${fn}()`);
    try {
      await expect(run(f, shared.id)).rejects.toThrow(/injected failure/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON "TeacherRoom"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }

    expect((await prisma.class.findUniqueOrThrow({ where: { id: open.id } })).teacherRoomId).toBe(f.linkId);
    expect((await prisma.classTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).teacherRoomId).toBe(f.linkId);
    expect((await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } })).isArchived).toBe(false);
    expect(await linkOn(f.teacherId, shared.id)).toBeNull();
  });
});
