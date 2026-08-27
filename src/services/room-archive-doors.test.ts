/**
 * Doors 2 and 3 of the room archive lifecycle (issue 76): an archived room
 * accepts no new commitments. Door 1 lives in `room-archive.test.ts`. Door 4
 * is a route-level guard (`POST /api/class-templates`); door 5's refusal used
 * to live in `updateClassTemplate`, and the wire paths for both are pinned in
 * `tests/integration/class-templates-api.test.ts` — plus the ownership-ordering
 * case below, which needs no HTTP.
 *
 * (272) Door 3's refusal is the constraint itself:
 * `ClassTemplate_live_needs_open_room` fires on the resume's CAS, so instead
 * of the old typed `room_archived` refusal this file pins the service's THROW
 * and its post-state (nothing committed), and the route's 409 is pinned at
 * the wire.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun, type RoomFixture, type ClassFixtureStatus } from '../../tests/room-fixtures';
import { transitionClass } from './class-lifecycle';
import { pauseOrResumeTemplate, updateClassTemplate } from './class-template-lifecycle';
import { isCheckViolationOn } from '@/lib/check-violation';

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

    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(after.status).toBe('draft');
  });

  it('publishes a draft whose room is not archived', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'draft');

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(true);
    const after = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(after.status).toBe('open');
  });
});

describe('pauseOrResumeTemplate — door 3: resuming into an archived room', () => {
  // (272) The refusal is the CHECK, not a service read. The resume's CAS flips
  // `isActive` to true, which recomputes `live` — and `live` on an archived
  // room violates `ClassTemplate_live_needs_open_room`, so the statement
  // throws mid-transaction and the whole thing rolls back. The route turns
  // this SQLSTATE into the 409 the pre-272 guard used to answer.
  it('refuses to resume a paused template whose room is archived — the CHECK throws', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    await expect(pauseOrResumeTemplate(prisma, tpl.id, f.teacherId, 'active')).rejects.toSatisfy(
      (e: unknown) => isCheckViolationOn(e, 'ClassTemplate_live_needs_open_room'),
    );

    // Nothing committed: the CAS matched-no-row-free, so the rollback leaves
    // the template paused with no window generated.
    const after = await prisma.classTemplate.findUniqueOrThrow({
      where: { id: tpl.id },
      include: { scheduleRule: true },
    });
    expect(after.scheduleRule.isActive).toBe(false);
    expect(await prisma.class.count({ where: { calendarEntry: { scheduleRule: { classTemplates: { some: { id: tpl.id } } } } } })).toBe(0);
  });

  // Pausing is the safe direction and stayed unguarded — but under 272 a
  // template on an archived room is paused BY CONSTRUCTION (the CHECK allows
  // archiving a room only while none of its templates is live), so the
  // reachable shape of "pausing still works" is a no-op that answers ok. A
  // teacher whose room was archived out from under a paused template is never
  // locked out of the pause verb.
  it('still answers ok when pausing a template whose room is archived', async () => {
    const f = await makeFixture();
    const tpl = await addTemplate(f, { isActive: false, isArchived: false });
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await pauseOrResumeTemplate(prisma, tpl.id, f.teacherId, 'paused');

    expect(result).toMatchObject({ ok: true, action: 'unchanged' });
  });
});

// Both cases below pin ORDERING, not the guard itself. PR review proved each
// by mutation: door 2's guard could be moved below the past-start check, or
// stripped of its status clause, and the whole unit project stayed green. The
// guard's docblock argues for both placements; nothing enforced either.
describe('transitionClass — door 2: what the refusal must lose to', () => {
  // The comment at the guard says it sits before the past-start check
  // "deliberately", because the archived room is the condition a teacher can
  // clear and `STARTS_IN_PAST` is permanent. Swap the two and this reddens.
  it('reports the clearable room condition, not the permanent past-start one', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'draft');
    // `addClass` hard-codes today+14; a draft is not terminal, so its `date`
    // is not frozen by the #247 trigger and can be moved into the past here.
    await prisma.calendarEntry.update({
      where: { id: cls.calendarEntryId },
      data: { date: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ROOM_ARCHIVED');
  });

  // The guard is scoped by `sourceStatesFor(targetStatus).includes(cls.status)`
  // — its `STARTS_IN_PAST` sibling carries the identical clause and IS pinned.
  // Without it, republishing a cancelled class in an archived room tells the
  // teacher to unarchive the room, when the transition is illegal regardless.
  // `completed`, not `cancelled`: since #327 a cancelled class keeps a live
  // status, so `ILLEGAL_TRANSITION` is no longer the refusal it earns — that
  // case is the one below, and it earns `CANCELLED`. `completed` is what is
  // left that cannot reach `open` through the state machine at all.
  it('yields to ILLEGAL_TRANSITION for a class that cannot reach open at all', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'completed');
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ILLEGAL_TRANSITION');
  });

  /**
   * The cancelled half of the same precedence question (#327). A cancelled
   * class carries a live `draft` status, so the state machine calls the move
   * legal and the CAS's own liveness conjunct is what refuses — reported as
   * `CANCELLED` rather than as the archived room, which is the same ordering
   * this block's other cases assert: the permanent reason outranks the
   * clearable one.
   */
  it('yields to CANCELLED for a cancelled class in an archived room', async () => {
    const f = await makeFixture();
    const cls = await addClass(f, 'cancelled');
    await prisma.teacherRoom.update({ where: { id: f.linkId }, data: { isArchived: true } });

    const result = await transitionClass(prisma, cls.id, 'open');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('CANCELLED');
  });
});

describe('updateClassTemplate — door 5: ownership still outranks the room state', () => {
  // (272) Door 5's refusal moved to the route pre-check (`PUT`), which probes
  // ownership BEFORE the archived state — so `invalid_room` still answers for
  // a FOREIGN room, archived or not, and the merged outcome stays
  // "same 400 for doesn't-exist and isn't-yours", leaking no existence oracle.
  // This service-level case pins that the SERVICE itself kept the ordering.
  it('answers invalid_room, not the archived answer, for another teacher archived room', async () => {
    const mine = await makeFixture();
    const theirs = await makeFixture();
    await prisma.teacherRoom.update({
      where: { id: theirs.linkId },
      data: { isArchived: true },
    });
    const tpl = await addTemplate(mine, { isActive: true, isArchived: false });

    const result = await updateClassTemplate(prisma, tpl.id, mine.teacherId, {
      teacherRoomId: theirs.linkId,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
  });
});
