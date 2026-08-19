/**
 * Door 1 of the room archive lifecycle (issue 76).
 *
 * The guard is an OR of two independent predicates — a blocking class OR an
 * active template. A fixture that trips both at once certifies NEITHER: the
 * class clause short-circuits, so the template clause could be deleted
 * outright with this file green. Every case below therefore isolates one
 * clause and leaves the other empty. See the mutation record at the foot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { setTeacherRoomArchived, describeRoomBlockers } from './room-archive';

const prisma = new PrismaClient();
// `ra-` distinguishes this file's rows from `room-archive-doors.test.ts`'s,
// so each file's cleanup sweeps only its own.
const fx = fixtureRun('ra');
const makeFixture = () => fx.makeFixture(prisma);
const addClass = (f: RoomFixture, status: ClassFixtureStatus) => fx.addClass(prisma, f, status);
const addTemplate = (f: RoomFixture, opts: { isActive: boolean; isArchived: boolean }) =>
  fx.addTemplate(prisma, f, opts);

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('setTeacherRoomArchived — door 1, class clause (no template on any fixture)', () => {
  it.each(['open', 'in_progress'] as const)('refuses to archive a room with a %s class', async (status) => {
    const f = await makeFixture();
    await addClass(f, status);

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('in_use');
    if (result.reason !== 'in_use') throw new Error('unreachable');
    expect(result.blockers).toEqual({ classes: 1, templates: 0 });

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
  });

  it('archives a room whose only class is a draft', async () => {
    const f = await makeFixture();
    await addClass(f, 'draft');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived', isArchived: true });
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(true);
  });

  // The issue's actual ask: history must stop blocking.
  it('archives a room whose classes are all completed or cancelled', async () => {
    const f = await makeFixture();
    await addClass(f, 'completed');
    await addClass(f, 'cancelled');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived', isArchived: true });
  });
});

describe('setTeacherRoomArchived — door 1, template clause (no blocking class on any fixture)', () => {
  it('refuses to archive a room with an active template', async () => {
    const f = await makeFixture();
    await addTemplate(f, { isActive: true, isArchived: false });

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('in_use');
    if (result.reason !== 'in_use') throw new Error('unreachable');
    expect(result.blockers).toEqual({ classes: 0, templates: 1 });

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
  });

  // Stops the clause being written as "any template exists", which would
  // re-block the room permanently and reintroduce issue 76 one layer up.
  it('archives a room whose only template is paused', async () => {
    const f = await makeFixture();
    await addTemplate(f, { isActive: false, isArchived: false });

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived' });
  });

  // `isActive: true` here, deliberately, not `false` like the paused case
  // above. Every real write pairs `isArchived: true` with `isActive: false`
  // (`class-template-lifecycle.ts:1053-1054`, `gdpr.ts:1139-1140`), so an
  // `isActive: false` fixture would already be excluded by the `isActive`
  // half of `ACTIVE_TEMPLATE_WHERE` and could never isolate the `isArchived`
  // half — dropping it from the constant would leave this case green. This
  // combination is the defense-in-depth state the constant's `isArchived`
  // clause exists to catch if that pairing invariant ever slips.
  it('archives a room whose only template is archived', async () => {
    const f = await makeFixture();
    await addTemplate(f, { isActive: true, isArchived: true });

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'archived' });
  });
});

describe('setTeacherRoomArchived — ownership, idempotency, release valve', () => {
  it('reports not_found for an unknown link', async () => {
    const f = await makeFixture();
    const result = await setTeacherRoomArchived(
      prisma, '00000000-0000-0000-0000-000000000000', f.teacherId, 'archived',
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('reports forbidden for another teacher’s link', async () => {
    const mine = await makeFixture();
    const theirs = await makeFixture();
    const result = await setTeacherRoomArchived(prisma, theirs.linkId, mine.teacherId, 'archived');
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
  });

  // Issue 98's rule: a retry after a lost response must not undo the first attempt.
  it('reports unchanged without writing when already in the target state', async () => {
    const f = await makeFixture();
    await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
    const before = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });

    const again = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(again).toMatchObject({ ok: true, action: 'unchanged', isArchived: true });
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  // Pins the ORDER of the two checks, which is not visible from either alone.
  // The already-in-state check sits BEFORE the in-use check, so an archived
  // room that has since acquired an open class — reachable through the
  // accepted race in spec section 8 — reports `unchanged` rather than
  // refusing on a state it is already in. Move the in-use check above it and
  // this case turns into an `in_use` refusal that no other test would catch.
  it('reports unchanged for an already-archived room that is now in use', async () => {
    const f = await makeFixture();
    await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
    await addClass(f, 'open');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    expect(result).toMatchObject({ ok: true, action: 'unchanged', isArchived: true });
  });

  // The release valve. Every refusal above is recoverable only because of this.
  it('un-archives unconditionally, even while the room is in use', async () => {
    const f = await makeFixture();
    await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');
    await addClass(f, 'open');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'unarchived');

    expect(result).toMatchObject({ ok: true, action: 'unarchived', isArchived: false });
  });
});

describe('describeRoomBlockers', () => {
  it.each([
    [{ classes: 1, templates: 0 }, '1 unfinished class still uses this room.'],
    [{ classes: 2, templates: 0 }, '2 unfinished classes still use this room.'],
    [{ classes: 0, templates: 1 }, '1 recurring class still uses this room.'],
    [{ classes: 0, templates: 3 }, '3 recurring classes still use this room.'],
    [{ classes: 2, templates: 1 }, '2 unfinished classes and 1 recurring class still use this room.'],
    // The state the type admits and the service never produces. Pinned so the
    // empty-subject sentence (" still use this room.") cannot come back.
    [{ classes: 0, templates: 0 }, 'This room is still in use.'],
  ])('renders %j', (blockers, expected) => {
    expect(describeRoomBlockers(blockers)).toBe(expected);
  });
});
