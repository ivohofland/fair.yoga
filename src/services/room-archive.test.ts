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
import { pauseOrResumeTemplate } from './class-template-lifecycle';

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
    const cls = await prisma.class.findFirstOrThrow({ where: { teacherRoomId: f.linkId } });
    expect(cls.roomArchived).toBe(true);
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
  // (`class-template-lifecycle.ts:1174-1175`, `gdpr.ts:1139-1140`), so an
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

describe('setTeacherRoomArchived — the mid-request resume race (issue 272)', () => {
  // The counts are READ before the write, so a template paused in this room
  // when the counts ran can still be resumed in another tab before the
  // archive's own write. Pre-272 that was a wrong success — a live template
  // left sitting on an archived room, precisely the state door 1 exists to
  // refuse. Post-272 the refusal lives in `ClassTemplate_live_needs_open_room`,
  // and this is the service turning that 23514 into the SAME `in_use` answer
  // the counts would have given had they run a moment later. `blockers` is
  // re-counted after the rollback rather than reported as the pre-write counts
  // saw it, so the sentence a teacher reads names the template that blocked
  // them instead of nothing at all.
  it('answers in_use rather than throwing when the constraint refuses the archive', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });

    // The interposing-`$extends` lever, staged at the race's true boundary: a
    // PAUSED template counts as `templates: 0`, so the archive passes its
    // count gate; the interposed resume then lands on another connection
    // AFTER the count was read and BEFORE the archive's transaction starts.
    // The write's own cascade rewrites the now-LIVE child (the transaction's
    // pre-lock holds it, nothing contests it) and trips the CHECK, so the
    // refusal comes from the same 23514 the hook used to provoke from inside
    // the update.
    let interposed = false;
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async count({ args, query }) {
            const result = await query(args);
            if (interposed) return result;
            interposed = true;
            const resumed = await pauseOrResumeTemplate(prisma, tpl.id, f.teacherId, 'active');
            if (!resumed.ok) throw new Error(`interposed resume failed: ${resumed.reason}`);
            return result;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await setTeacherRoomArchived(interposing, f.linkId, f.teacherId, 'archived');

    expect(interposed).toBe(true);
    // `templates: 1`, not the zero the counts measured: the refusal is
    // re-counted after the rollback so `describeRoomBlockers` can name what
    // the teacher must clear. Zero rendered as the subjectless "This room is
    // still in use.", which is a 409 with nothing in it to act on.
    //
    // `classes: 4`, not 0 (#339). The resume's own CAS claims the template and
    // generates its rolling window synchronously (`DEFAULT_WEEKS`,
    // `entry-generation.ts`) before this transaction's write ever runs, so by
    // the time the catch re-counts, four real `open` classes already sit in
    // this room — invisible to the old catch, which re-counted only the
    // template half and hardcoded the class half at zero regardless of what
    // was actually there.
    //
    // Those same four classes mean this case can no longer be read as pinning
    // issue 272's `ClassTemplate_live_needs_open_room` specifically: the
    // archive's `UPDATE "TeacherRoom"` now has two live children to trip over
    // in the same transaction, and either constraint firing first produces
    // this identical `in_use` answer. Coverage of the template constraint on
    // its own is not lost — `template-room-constraint.test.ts` pins it
    // directly — but this test's assertion is agnostic to which of the two
    // fired.
    expect(result).toEqual({ ok: false, reason: 'in_use', blockers: { classes: 4, templates: 1 } });

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
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

  // "Already archived AND still blocked by a class" cannot be constructed any
  // more, by fixture or by any other write: `Class_live_needs_open_room`
  // (#339) refuses the write that would create that combination, which is
  // what `class-room-constraint.test.ts`'s "refuses archiving a room that
  // holds a live class" pins directly at the constraint. The ordering
  // between the idempotency check and the in-use check is no longer
  // independently observable through a CLASS blocker: with zero blockers
  // present, as in the case above, both orderings answer the same way, and
  // the state that would have told them apart can no longer be constructed.
  //
  // The release valve itself still needs its own case: nothing above calls
  // `setTeacherRoomArchived` with `'unarchived'` at all, and "unconditional"
  // is a claim about a branch this file would otherwise never run.
  it('un-archives a room, flipping the flag back', async () => {
    const f = await makeFixture();
    await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'archived');

    const result = await setTeacherRoomArchived(prisma, f.linkId, f.teacherId, 'unarchived');

    expect(result).toMatchObject({ ok: true, action: 'unarchived', isArchived: false });
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: f.linkId } });
    expect(after.isArchived).toBe(false);
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
