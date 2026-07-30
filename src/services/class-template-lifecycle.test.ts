import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { RegistrationStatus } from '@prisma/client';
import {
  updateClassTemplate,
  archiveOrUnarchiveTemplate,
  pauseOrResumeTemplate,
} from './class-template-lifecycle';
import { startOfLocalDay } from '@/lib/timezone';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

// Hoisted to module scope: a pure function of `label` (plus the module-scope
// `prisma`/`uniqueSuffix` above), so both describe blocks below can seed their
// own, separate teacher/room/teacherRoom fixtures from it.
const seedTeacher = async (label: string, defaultTimezone = 'UTC') => {
  const email = `tpl-${label}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: label,
      lastName: 'Teacher',
      email,
      account: { create: { email } },
      bio: `Teacher for ${label} template tests`,
      pageSlug: `tpl-${label}-${uniqueSuffix}`,
      defaultTimezone,
    },
  });
  const room = await prisma.room.create({
    data: {
      venueName: `${label} Venue`,
      address: `${uniqueSuffix} ${label} St`,
      city: 'Testville',
      postcode: '1234TP',
      floor: '1',
      roomName: 'Loft',
      maxCapacity: 10,
      createdById: teacher.id,
    },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
  });
  return {
    teacherId: teacher.id,
    accountId: teacher.accountId,
    roomId: room.id,
    teacherRoomId: teacherRoom.id,
  };
};

describe('updateClassTemplate (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;
  let otherTeacherRoomId: string;

  const makeTemplate = (classType: string) =>
    prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: '09:30',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

  beforeAll(async () => {
    await prisma.$connect();
    const mine = await seedTeacher('owner');
    teacherId = mine.teacherId;
    accountId = mine.accountId;
    roomId = mine.roomId;
    teacherRoomId = mine.teacherRoomId;

    const theirs = await seedTeacher('other');
    otherTeacherId = theirs.teacherId;
    otherAccountId = theirs.accountId;
    otherRoomId = theirs.roomId;
    otherTeacherRoomId = theirs.teacherRoomId;
  });

  afterAll(async () => {
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
    ] as const) {
      await prisma.class.deleteMany({ where: { teacherId: t } });
      await prisma.classTemplate.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await updateClassTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      { classType: 'Anything' },
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and writes nothing", async () => {
    const template = await makeTemplate('Not Yours');

    const result = await updateClassTemplate(prisma, template.id, otherTeacherId, {
      classType: 'Hijacked',
    });

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.classType).toBe('Not Yours');
  });

  it('returns no_fields for an empty payload, and writes nothing', async () => {
    const template = await makeTemplate('Empty Payload');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {});
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.classType).toBe('Empty Payload');
  });

  // Defined-value scan (class-template-lifecycle.ts:227): a key present with
  // value `undefined` is not an edit, unlike the key-count check this
  // replaced, which would have let this through as `ok: true` and run a
  // no-op update plus a full sync for nothing.
  it('returns no_fields for a payload of only undefined values, and writes nothing', async () => {
    const template = await makeTemplate('Undefined Only');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      description: undefined,
    });
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.classType).toBe('Undefined Only');
  });

  it('returns invalid_room for a room that does not exist', async () => {
    const template = await makeTemplate('Ghost Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it("returns invalid_room for another teacher's room, and writes nothing", async () => {
    const template = await makeTemplate('Someone Elses Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: otherTeacherRoomId,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it('applies the update and returns the sync result', async () => {
    const template = await makeTemplate('Editable');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      classType: 'Edited',
      durationMinutes: 75,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.classType).toBe('Edited');
    expect(result.template.durationMinutes).toBe(75);
    // These counts are deterministic here — a bare template has no
    // instances, so the sync can only be a hard zero — unlike the API test,
    // which cannot pin an exact number without risking clock flakiness.
    expect(result.sync).toEqual({ synced: 0, regenerated: 0, kept: 0 });
  });

  /**
   * #100. `updateClassTemplate`'s existing guard covers only its own
   * `update`. `syncTemplateInstances` runs after it, outside that `try`, and
   * opens with a `findUniqueOrThrow` — a P2025 source on Prisma 6.
   *
   * Note what this asserts: `not_found` for a write that *did* land. That is
   * deliberate. The row is gone before the caller is answered, so "no such
   * template" is the state their world is actually in; the alternative is
   * reporting a successful update of something that no longer exists.
   */
  it('maps a delete landing between the write and the sync to not_found', async () => {
    const t = await makeTemplate('P2025 Sync');

    let deleted = false;
    // `$extends` returns a `DynamicClientExtensionThis`, not a `PrismaClient`
    // — it is missing `$on`, which `PrismaClient` requires and this test
    // double has no need of. `updateClassTemplate`'s `db` parameter is typed
    // as the concrete class, not a structural subset, so nothing short of a
    // cast satisfies it here; the alternative, widening that parameter's
    // type, would be a production-code change to accommodate a test. Cast
    // to the same target the stub-client precedent in
    // `studio-class-generator.test.ts` already casts to, rather than
    // inventing a new one.
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async update({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.class.deleteMany({ where: { templateId: t.id } });
              await prisma.classTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await updateClassTemplate(interposing, t.id, teacherId, {
      classType: 'Renamed',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('archiveOrUnarchiveTemplate (DB)', () => {
  // Every case below is one row of the deletion rule. They are separate tests
  // rather than one sweep because when this breaks, which row broke is the
  // whole diagnosis.
  const DAY = 24 * 60 * 60 * 1000;
  const future = () => new Date(Date.now() + 5 * DAY);
  const past = () => new Date(Date.now() - 5 * DAY);
  const today = () => new Date();
  // `date` truncates to a calendar day and carries `@@unique([templateId,
  // date])`, so tests that put more than one class on the same template need
  // distinct days — plain `future()` called twice would collide.
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;
  type Seeded = Awaited<ReturnType<typeof seedTeacher>>;
  let east: Seeded;
  let west: Seeded;

  const makeTemplate = (classType: string) =>
    prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: '09:30',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

  // Closes over the block's own teacherId/teacherRoomId, like the sibling
  // block's makeTemplate does.
  const makeClass = async (
    templateId: string,
    opts: { date: Date; status?: 'draft' | 'open' | 'cancelled' },
  ) =>
    prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        templateId,
        classType: 'Archive Rule',
        date: opts.date,
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: opts.status ?? 'open',
      },
    });

  const register = (classId: string, studentId: string, status: RegistrationStatus) =>
    prisma.registration.create({ data: { classId, studentId, tierAtBooking: 3, status } });

  /**
   * Narrows to the archiving arm. `deleted`/`remaining` exist only there —
   * un-archiving reports no counts rather than two zeros that would read like
   * "archived, and nothing matched" — so every count assertion has to say
   * which direction it expected. That is the discriminant earning its keep.
   */
  const expectArchived = (result: Awaited<ReturnType<typeof archiveOrUnarchiveTemplate>>) => {
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    if (result.action !== 'archived') throw new Error('expected the archiving direction');
    return result;
  };

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('archive');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
    roomId = seeded.roomId;
    teacherRoomId = seeded.teacherRoomId;

    const other = await seedTeacher('archive-other');
    otherTeacherId = other.teacherId;
    otherAccountId = other.accountId;
    otherRoomId = other.roomId;

    // Two zones 25 hours apart, so their local calendar dates always differ by
    // exactly one day — whatever the clock says when this runs. See the
    // timezone test below for why that fixed gap is what makes it deterministic.
    east = await seedTeacher('archive-east', 'Pacific/Kiritimati');
    west = await seedTeacher('archive-west', 'Pacific/Niue');

    const student = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Student',
        email: `archive-student-${uniqueSuffix}@test.local`,
      },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    await prisma.student.delete({ where: { id: studentId } });
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
      [east.teacherId, east.roomId, east.accountId],
      [west.teacherId, west.roomId, west.accountId],
    ] as const) {
      await prisma.class.deleteMany({ where: { teacherId: t } });
      await prisma.classTemplate.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await archiveOrUnarchiveTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      'archived',
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and leaves it and its classes untouched", async () => {
    const t = await makeTemplate('Not Yours');
    const c = await makeClass(t.id, { date: future() });

    // The ownership check is the only thing stopping teacher B from
    // destroying teacher A's schedule — this is the function that deletes
    // rows, so it must refuse before touching anything.
    const result = await archiveOrUnarchiveTemplate(prisma, t.id, otherTeacherId, 'archived');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isArchived).toBe(false);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  /**
   * The guard order matters here specifically: `isArchived === archiving` is
   * true on this fresh (unarchived) row and the request names 'unarchived',
   * so this is the one case that distinguishes "ownership checked first" from
   * "unchanged checked first" — every other forbidden case in this file asks
   * for a state the row is NOT already in, so it would pass just as well with
   * the guards swapped. Reordering `unchanged` above `forbidden` would answer
   * this with a 200 `unchanged` instead — handing a non-owner the row.
   */
  it("returns forbidden for another teacher's template already in the requested state, and writes nothing", async () => {
    const t = await makeTemplate('Owner Unarchived, Foreign Request');

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, otherTeacherId, 'unarchived');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isArchived).toBe(false);
  });

  it('deletes a future class nobody booked', async () => {
    const t = await makeTemplate('Del Unbooked');
    const c = await makeClass(t.id, { date: future() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('deletes a future class whose only registration is cancelled', async () => {
    const t = await makeTemplate('Del Cancelled');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'cancelled');

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    // Nobody is affected and nothing is owed, so this is not "booked".
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('keeps a future class with a late_cancel registration — it is still charged', async () => {
    const t = await makeTemplate('Keep LateCancel');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'late_cancel');

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    // Assert the archive itself actually happened — a class surviving proves
    // nothing on its own if the function silently no-op'd or errored.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    // ACTIVE_REGISTRATION_STATUSES excludes late_cancel; CHARGED_STATUSES does
    // not. Deleting this would cascade away a registration the student owes
    // for. If this test ever fails, check which constant the rule is using.
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it('keeps a future class with a registered student', async () => {
    const t = await makeTemplate('Keep Registered');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'registered');

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it("keeps today's class — the date > now boundary", async () => {
    const t = await makeTemplate('Keep Today');
    const c = await makeClass(t.id, { date: today() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    const archived = expectArchived(result);
    expect(archived.template.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    // A `remaining` still keyed on the delete's own boundary would read 0 here
    // and tell the teacher nothing is scheduled while this exact class stays
    // open on their public page.
    expect(archived.remaining).toBe(1);
  });

  it("reports deleted: 0, remaining: 1 when today's class is the only one scheduled", async () => {
    const t = await makeTemplate('Today Only');
    await makeClass(t.id, { date: today() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    // Nothing was eligible for deletion (today is spared) and the one class
    // on the schedule is today's — the confirmation must say so, not "nothing
    // scheduled any more".
    const archived = expectArchived(result);
    expect(archived.deleted).toBe(0);
    expect(archived.remaining).toBe(1);
  });

  /**
   * The rule is "no CHARGED registration", deliberately *not* `settingsLocked`
   * — which answers whether the price may still change and, once set, never
   * resets. Every other fixture here leaves `settingsLocked` false (the test
   * helper writes `Registration` rows directly, bypassing the flip in
   * `api/registrations/route.ts`), so without this case a refactor to the
   * wrong-but-plausible `settingsLocked` check would pass the whole suite.
   */
  it('deletes a future class that is settingsLocked but carries no charged registration', async () => {
    const t = await makeTemplate('Locked But Unbooked');
    const c = await makeClass(t.id, { date: future() });
    await prisma.class.update({ where: { id: c.id }, data: { settingsLocked: true } });
    await register(c.id, studentId, 'cancelled');

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(0);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  /**
   * `SCHEDULED_STATUSES` is `['draft', 'open']`. A future class in any other
   * status is out of the archive rule's scope and must survive — pinning the
   * list against silent widening, which nothing else here does.
   */
  it.each(['in_progress', 'completed'] as const)(
    'keeps a future %s class — outside the draft/open scope',
    async (status) => {
      const t = await makeTemplate(`Scope ${status}`);
      const c = await makeClass(t.id, { date: future() });
      await prisma.class.update({ where: { id: c.id }, data: { status } });

      const archived = expectArchived(
        await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
      );

      expect(archived.deleted).toBe(0);
      expect(archived.remaining).toBe(0);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    },
  );

  it('deletes a future draft class, like an open one', async () => {
    const t = await makeTemplate('Draft Scope');
    const c = await makeClass(t.id, { date: future(), status: 'draft' });

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(1);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  /**
   * The boundary is the *teacher's* calendar day, not UTC's.
   *
   * Deterministic despite depending on the wall clock, because the two zones
   * are 25 hours apart: their local dates always differ by exactly one day.
   * Let U be UTC's date. Either Kiritimati is on U+1 and Niue on U, or
   * Kiritimati is on U and Niue on U-1 — and each case breaks a different
   * half of the old UTC-based logic:
   *
   *   - Kiritimati on U+1: `date > now` reads true for its today, so the
   *     class running that same evening is deleted.
   *   - Niue on U-1: `date >= startOfUtcToday` reads false for its today, so
   *     the surviving class is not counted and the teacher is told nothing is
   *     left while it is still open on their page.
   *
   * One of the two always fires, whichever hour CI runs at.
   */
  it("keys the boundary on the teacher's calendar day, not UTC's", async () => {
    for (const seeded of [east, west]) {
      const teacher = await prisma.teacher.findUniqueOrThrow({
        where: { id: seeded.teacherId },
        select: { defaultTimezone: true },
      });
      const localToday = startOfLocalDay(new Date(), teacher.defaultTimezone);

      const t = await prisma.classTemplate.create({
        data: {
          teacherId: seeded.teacherId,
          teacherRoomId: seeded.teacherRoomId,
          classType: `Zone ${teacher.defaultTimezone}`,
          dayOfWeek: 3,
          startTime: '09:30',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 8,
        },
      });
      const c = await prisma.class.create({
        data: {
          teacherId: seeded.teacherId,
          teacherRoomId: seeded.teacherRoomId,
          templateId: t.id,
          classType: 'Zone Boundary',
          date: localToday,
          startTime: '19:00',
          durationMinutes: 60,
          roomCost: 15,
          minRate: 10,
          targetRate: 20,
          minStudents: 1,
          maxStudents: 8,
          status: 'open',
        },
      });

      const archived = expectArchived(
        await archiveOrUnarchiveTemplate(prisma, t.id, seeded.teacherId, 'archived'),
      );

      expect(archived.deleted).toBe(0);
      expect(archived.remaining).toBe(1);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    }
  });

  it('keeps past classes', async () => {
    const t = await makeTemplate('Keep Past');
    const c = await makeClass(t.id, { date: past() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it('reports deleted and remaining counts', async () => {
    const t = await makeTemplate('Counts');
    const unbooked1 = await makeClass(t.id, { date: futureOn(5) });
    const unbooked2 = await makeClass(t.id, { date: futureOn(6) });
    const booked = await makeClass(t.id, { date: futureOn(7) });
    await register(booked.id, studentId, 'registered');
    await makeClass(t.id, { date: past() });
    // Future, unbooked, but already `cancelled` — out of the archive rule's
    // scope entirely (scope is `draft`/`open`), so it must be swept into
    // neither the deleted count nor the remaining one.
    const alreadyCancelled = await makeClass(t.id, { date: futureOn(8), status: 'cancelled' });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');

    const archived = expectArchived(result);
    expect(archived.deleted).toBe(2);
    expect(archived.remaining).toBe(1);
    expect(await prisma.class.count({ where: { id: unbooked1.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: unbooked2.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: booked.id } })).toBe(1);
    expect(await prisma.class.count({ where: { id: alreadyCancelled.id } })).toBe(1);
  });

  it('leaves the window untouched when un-archiving', async () => {
    const t = await makeTemplate('Archive Then Resume');
    const unbooked = await makeClass(t.id, { date: futureOn(5) });
    const booked = await makeClass(t.id, { date: futureOn(6) });
    await register(booked.id, studentId, 'registered');

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );
    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(1);

    const survivingIds = (
      await prisma.class.findMany({ where: { templateId: t.id }, select: { id: true } })
    ).map((c) => c.id);

    const resumed = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    // Reports the direction and nothing else. Previously this arm returned
    // `deleted: 0, remaining: 0` — indistinguishable from a real archive that
    // matched nothing, even though a booked class is still standing (asserted
    // by `stillSurviving` below).
    expect(resumed.action).toBe('unarchived');
    expect(resumed.template.isArchived).toBe(false);

    const stillSurviving = (
      await prisma.class.findMany({ where: { templateId: t.id }, select: { id: true } })
    ).map((c) => c.id);
    expect(new Set(stillSurviving)).toEqual(new Set(survivingIds));
    expect(await prisma.class.count({ where: { id: unbooked.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: booked.id } })).toBe(1);
  });

  /**
   * #97. The counts used to live only in the confirmation message, so closing
   * the tab lost them. `withdrawnCount` comes from the `deleteMany`'s own
   * returned count — not a separate query — so the record cannot claim a
   * different number from the one the delete actually removed.
   */
  it('records when it archived and how many classes it withdrew', async () => {
    const t = await makeTemplate('Records Withdrawal');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });

    const before = Date.now();
    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(2);
    expect(archived.template.withdrawnCount).toBe(2);
    expect(archived.template.archivedAt).not.toBeNull();
    expect(archived.template.archivedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(archived.template.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now());

    // The assertions above are all on the value the function *returned*.
    // Re-read the row so this test also proves the write reached the
    // database, not just the response — the two can diverge if the service
    // ever fabricates a return value instead of persisting it. Both columns
    // are checked against the returned value exactly, the timestamp included:
    // a fabricated timestamp is the hardest kind to spot, so `not.toBeNull()`
    // is the one assertion that would wave through the divergence this re-read
    // exists to catch.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.withdrawnCount).toBe(2);
    expect(after.archivedAt).not.toBeNull();
    expect(after.archivedAt!.getTime()).toBe(archived.template.archivedAt!.getTime());
  });

  /**
   * The count must equal what was deleted, not what was scheduled. Today's
   * class is spared by the delete's boundary, so the two numbers differ here —
   * which is exactly the case a `count()` written from the wrong query would
   * get wrong while looking right.
   */
  it('records the deleted count, not the scheduled count', async () => {
    const t = await makeTemplate('Withdrawal Excludes Today');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });
    await makeClass(t.id, { date: today() });

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.deleted).toBe(2);
    expect(archived.remaining).toBe(1);
    expect(archived.template.withdrawnCount).toBe(2);
  });

  /**
   * Zero is a real answer and must be distinguishable from "never archived".
   * That distinction is the entire reason both columns are nullable.
   *
   * Which makes it a claim about `0` versus `NULL` in the column, not about
   * the returned object — so the re-read is not decoration here, it is the
   * assertion. A service that returned `0` while leaving the column `NULL`
   * would satisfy every in-memory check and still lose the distinction this
   * test is named for.
   */
  it('records zero when there was nothing to withdraw', async () => {
    const t = await makeTemplate('Nothing To Withdraw');

    const archived = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(archived.template.withdrawnCount).toBe(0);
    expect(archived.template.archivedAt).not.toBeNull();

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.withdrawnCount).toBe(0);
    expect(after.archivedAt).not.toBeNull();
  });

  /**
   * "Cleared", not "never written". Asserting only the trailing nulls cannot
   * tell those two apart — replace the archive arm's record write with `data:
   * {}` and a test that jumps straight from archive to un-archive still
   * passes, having proved nothing.
   *
   * So the midpoint re-read is the load-bearing part: it establishes there was
   * a record in the column to clear. It is also what makes the fixture's future
   * class earn its place, since nothing else here reads what the delete
   * produced.
   */
  it('clears the record when un-archiving', async () => {
    const t = await makeTemplate('Cleared On Resume');
    await makeClass(t.id, { date: futureOn(5) });
    expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));

    const recorded = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(recorded.withdrawnCount).toBe(1);
    expect(recorded.archivedAt).not.toBeNull();

    const resumed = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');

    expect(resumed.template.archivedAt).toBeNull();
    expect(resumed.template.withdrawnCount).toBeNull();

    // As above: the assertions so far only prove what came back in the
    // response. Re-read the row to prove the clear reached the database.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.archivedAt).toBeNull();
    expect(after.withdrawnCount).toBeNull();
  });

  /**
   * The `unchanged` guard (`isArchived === archiving`, above) makes archiving
   * twice in a row unreachable — the only way back to the archiving arm is
   * through an un-archive first, and that un-archive already nulled both
   * columns. So what this test actually walks is archive → un-archive →
   * archive again, and what it defends is that the second archive's record
   * reflects what it just withdrew rather than carrying the un-archive's
   * `null` forward. It also rules out an accumulate-style write: `{
   * increment: deleted }` against a NULL column yields NULL in SQL, not a
   * wrong total, so that bug would fail here as `null !== 1` — never as "2".
   */
  it('overwrites the record when archiving a second time', async () => {
    const t = await makeTemplate('Archived Twice');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });
    expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');

    await makeClass(t.id, { date: futureOn(7) });
    const before = Date.now();
    const second = expectArchived(
      await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'),
    );

    expect(second.deleted).toBe(1);
    expect(second.template.withdrawnCount).toBe(1);
    expect(second.template.archivedAt).not.toBeNull();
    expect(second.template.archivedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(second.template.archivedAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  /**
   * The case the sequential idempotency tests structurally cannot reach. The
   * `isArchived === archiving` fast path reads a row fetched *before* the
   * transaction opens, so it is outside the row lock: two archives issued
   * close enough together both see `false` and both clear it. Before the
   * compare-and-swap, the loser then re-applied the whole archive — its
   * `deleteMany` matched nothing (the winner had already deleted those
   * classes) and it wrote `withdrawnCount: 0` over the winner's correct 2.
   * Display-only, but #97 makes that display the durable record.
   *
   * Deterministic by the same lever `class-generator.test.ts` uses for the
   * #95 races: a third transaction holds the template's row lock without
   * changing anything, and uncommitted work is invisible under READ
   * COMMITTED. That fixes both halves of the ordering the race needs — the
   * second call's pre-transaction read genuinely sees `isArchived: false`
   * (nothing has committed), and both calls' first write genuinely queue on
   * the same lock instead of running back to back.
   *
   * It is also the one test that exercises the Postgres behaviour the fix
   * rests on: the loser blocks inside its `UPDATE`, and when the winner
   * commits, READ COMMITTED re-evaluates the CAS predicate against the row
   * version the winner left (EvalPlanQual) and matches nothing.
   */
  it('two concurrent archives: the loser records nothing over the winner', async () => {
    const t = await makeTemplate('Concurrent Archive');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Holds the row lock and nothing else — no write, so neither archive can
    // observe it, only wait for it.
    const blocking = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ClassTemplate" WHERE "id" = ${t.id} FOR UPDATE`;
        await held;
      },
      { timeout: 15_000 },
    );

    await new Promise((r) => setTimeout(r, 100));

    let firstSettled = false;
    const first = archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived').then((r) => {
      firstSettled = true;
      return r;
    });

    // Staggered so the two contend in a known order. The assertions below do
    // not depend on which one wins — Postgres grants tuple-lock waiters FIFO,
    // so it is the first — but the *invariant* is "exactly one of them
    // archives", and asserting it that way is what makes this test about the
    // CAS rather than about lock scheduling.
    await new Promise((r) => setTimeout(r, 100));

    let secondSettled = false;
    const second = archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived').then((r) => {
      secondSettled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 300));
    // Both are blocked in their first write. If either had settled here, the
    // two never contended and the rest of this test would prove nothing.
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    release();
    await blocking;

    const settled = await Promise.all([first, second]);
    const won = settled.find((r) => r.ok && r.action === 'archived');
    const lost = settled.find((r) => r.ok && r.action === 'unchanged');
    if (!won || !lost) {
      throw new Error(
        `expected one archived and one unchanged, got ${settled
          .map((r) => (r.ok ? r.action : r.reason))
          .join(' + ')}`,
      );
    }

    const winner = expectArchived(won);
    expect(winner.deleted).toBe(2);
    expect(winner.template.withdrawnCount).toBe(2);

    if (!lost.ok) throw new Error('expected ok');
    // The loser reports the state the winner left, not the pre-race snapshot
    // it read at the top of its own call — that one still said `isArchived:
    // false`, which by then is exactly the value the winner had falsified.
    expect(lost.template.isArchived).toBe(true);
    expect(lost.template.withdrawnCount).toBe(2);

    // The durable record, which is what #97 is for: the winner's count and
    // the winner's timestamp, not the loser's `0` and `now`.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.withdrawnCount).toBe(2);
    expect(after.archivedAt).not.toBeNull();
    expect(after.archivedAt!.getTime()).toBe(winner.template.archivedAt!.getTime());
    expect(await prisma.class.count({ where: { templateId: t.id } })).toBe(0);
  });
});

describe('pauseOrResumeTemplate (DB)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;

  const makeTemplate = (classType: string) =>
    prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: '09:30',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

  const makeClass = (templateId: string, date: Date, startTime: string) =>
    prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        templateId,
        classType: 'Pause Rule',
        date,
        startTime,
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'open',
      },
    });

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('pause');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
    roomId = seeded.roomId;
    teacherRoomId = seeded.teacherRoomId;

    const other = await seedTeacher('pause-other');
    otherTeacherId = other.teacherId;
    otherAccountId = other.accountId;
    otherRoomId = other.roomId;
  });

  afterAll(async () => {
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
    ] as const) {
      await prisma.class.deleteMany({ where: { teacherId: t } });
      await prisma.classTemplate.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('pausing an active template deletes nothing and reports the furthest-out scheduled class', async () => {
    const t = await makeTemplate('Pause Active');
    const soon = await makeClass(t.id, futureOn(3), '08:00');
    const later = await makeClass(t.id, futureOn(10), '19:00');

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    if (result.action !== 'paused') throw new Error('expected the paused action');
    expect(result.template.isActive).toBe(false);
    expect(result.lastScheduled).not.toBeNull();
    if (!result.lastScheduled) throw new Error('expected lastScheduled');
    expect(result.lastScheduled.date.toISOString().slice(0, 10)).toBe(
      later.date.toISOString().slice(0, 10),
    );
    expect(result.lastScheduled.startTime).toBe('19:00');
    // Deletes nothing: pausing withdraws no already-generated class — that is
    // archiving's job, not pausing's.
    expect(await prisma.class.count({ where: { id: soon.id } })).toBe(1);
    expect(await prisma.class.count({ where: { id: later.id } })).toBe(1);
  });

  it('resuming a paused template regenerates its instance window', async () => {
    const t = await makeTemplate('Resume Regenerates');

    const paused = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');
    expect(paused.ok).toBe(true);
    if (!paused.ok) throw new Error('expected ok');
    expect(paused.template.isActive).toBe(false);
    expect(await prisma.class.count({ where: { templateId: t.id } })).toBe(0);

    const resumed = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    expect(resumed.template.isActive).toBe(true);
    // The rolling window materializes classes where a moment ago there were
    // none — the regeneration this test exists to prove wasn't silently
    // dropped when the PATCH route's logic was moved into this function.
    expect(await prisma.class.count({ where: { templateId: t.id } })).toBeGreaterThan(0);
  });

  it('pausing a template with no scheduled classes reports lastScheduled: null', async () => {
    const t = await makeTemplate('Pause Empty');

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    if (result.action !== 'paused') throw new Error('expected the paused action');
    expect(result.lastScheduled).toBeNull();
  });

  /**
   * A fresh template's `isActive` defaults `true`, so requesting 'active' as
   * a non-owner asks for the state the row is already in — the one case that
   * would let a swapped guard order answer `unchanged` (and hand a non-owner
   * the row) instead of `forbidden`. Every other case in this file requests a
   * state the row is NOT already in, so it cannot tell the two orderings
   * apart.
   */
  it("returns forbidden for another teacher's template already in the requested state, and writes nothing", async () => {
    const t = await makeTemplate('Owner Active, Foreign Request');

    const result = await pauseOrResumeTemplate(prisma, t.id, otherTeacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(true);
  });

  it("returns 'archived' for an archived template rather than toggling", async () => {
    const t = await makeTemplate('Pause Archived');
    const archived = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
  });

  /**
   * The guard order in `pauseOrResumeTemplate` is deliberate: `unchanged`
   * must be checked before the `archived` guard, because archiving forces
   * `isActive: false` — so `?state=paused` on an archived template is
   * already true and there is nothing to refuse. Swap the two guards and
   * every other test in this file still passes; only this one would start
   * seeing a 409 (`reason: 'archived'`) where it should see a 200
   * `unchanged` — reachable from exactly the stale-tab case #98 is about:
   * tab A archives, tab B still shows an active template and offers "Pause
   * recurring class".
   */
  it('an archived template is already paused — pausing it again is unchanged, not a 409', async () => {
    const t = await makeTemplate('Archived Then Paused');
    const archived = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
    expect(after.isArchived).toBe(true);
  });

  /**
   * #100. The read and the write are not one transaction, so a delete landing
   * between them surfaces as Prisma's P2025 rather than a clean `not_found`.
   *
   * Interposed rather than raced: the extension below performs the real read
   * and then deletes the row before returning it, which *is* the interleaving
   * the guard exists for. A two-connection race would only reach the same
   * state less reliably.
   */
  it('maps a delete landing between the read and the write to not_found', async () => {
    const t = await makeTemplate('P2025 Pause');
    await prisma.classTemplate.update({ where: { id: t.id }, data: { isActive: false } });

    let deleted = false;
    // Cast for the same reason as the sync test's `interposing` above: the
    // extended client is missing `$on`, so it is not assignable to
    // `pauseOrResumeTemplate`'s `PrismaClient`-typed `db` parameter, and
    // reusing the existing stub-client cast is the only accepted way past
    // that without loosening the parameter's type.
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.class.deleteMany({ where: { templateId: t.id } });
              await prisma.classTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
});
