import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { RegistrationStatus } from '@prisma/client';
import {
  updateClassTemplate,
  archiveOrUnarchiveTemplate,
  pauseOrResumeTemplate,
} from './class-template-lifecycle';
import { startOfLocalDay, classStartInstant } from '@/lib/timezone';
import { getNextOccurrences } from './class-generator';
import { formatDayHeader } from '@/lib/format';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/**
 * Turns a running total-minutes-from-9am into a valid `HH:MM`, wrapping into
 * the next hour rather than ever emitting an invalid minute like `'09:60'`
 * once a block's fixture counter crosses 30. `totalMinutes % 60` is always
 * 0-59 by construction, so the assertion below is a cheap, self-checking
 * proof of that invariant rather than a defence this formula can actually
 * fail — but a fixed-width literal (`` `09:${30 + counter}` ``) can't make
 * the same guarantee: Task 6d's review found `archiveOrUnarchiveTemplate`'s
 * `makeTemplate` counter reaching its old ceiling at exactly its own call
 * count (29 calls, `'09:59'`), one call short of `'09:60'` — a value that a
 * plain `String` column, a string-equality occupancy check, and a
 * string-comparing partial index would all have accepted silently, with
 * the test no longer exercising the constraint this branch exists for.
 */
function slotTime(totalMinutesFrom9am: number): string {
  const hour = 9 + Math.floor(totalMinutesFrom9am / 60);
  const minute = totalMinutesFrom9am % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

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

  // Counter-derived startTime: this block calls makeTemplate 8 times for one
  // teacher/dayOfWeek, and none of its tests read or assert the created
  // template's literal startTime — so a distinct minute per call is enough
  // to keep every create legal under ClassTemplate_teacher_slot_unique
  // (none of these templates ever gets archived, which is the only thing
  // that would otherwise free the slot).
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    return prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: slotTime(30 + makeTemplateCounter),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });
  };

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

  // Defined-value scan (`updateClassTemplate`'s own `hasEdit` check,
  // `class-template-lifecycle.ts`): a key present with value `undefined` is
  // not an edit, unlike the key-count check this replaced, which would have
  // let this through as `ok: true` and run a no-op update plus a full sync
  // for nothing.
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
    // `toEqual`, not `toMatchObject`, deliberately: a whole-shape assertion is
    // what caught the three fields #204's review added to `TemplateSyncResult`,
    // and it is the reason the form could not silently keep reading a stale
    // shape. Keep it exhaustive.
    expect(result.sync).toEqual({
      synced: 0,
      regenerated: 0,
      refilled: 0,
      blockedByCancelled: 0,
      slotTaken: 0,
      kept: 0,
    });
  });

  /**
   * #100, the first of the two windows the one `catch` covers: the read at the
   * top of `updateClassTemplate` and the `update` are not one transaction, so
   * a delete landing between them raises P2025 at the write. Before #100 that
   * escaped as a 500 — the bug this issue exists to close.
   *
   * The sync test below cannot stand in for this one. Hoist the `update` out
   * of the `try` and it still passes (its P2025 comes from the sync call,
   * which stays inside), while this one starts throwing — so this is the test
   * that holds the write inside the guard.
   *
   * Interposed rather than raced, like the pause guard's twin: the extension
   * performs the real read and then deletes the row before returning it, which
   * *is* the interleaving the guard exists for. The payload is `classType`
   * alone, deliberately — no `teacherRoomId`, so the room lookup is skipped
   * and nothing at all runs between the hooked read and the write.
   */
  it('maps a delete landing between the read and the write to not_found', async () => {
    const t = await makeTemplate('P2025 Write');

    let deleted = false;
    // Cast for the same reason as the sync test's `interposing` below: the
    // extended client is missing `$on`, so it is not assignable to
    // `updateClassTemplate`'s `PrismaClient`-typed `db` parameter, and reusing
    // the existing stub-client cast is the only accepted way past that without
    // loosening the parameter's type.
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

    const result = await updateClassTemplate(interposing, t.id, teacherId, {
      classType: 'Renamed',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  /**
   * #100. `syncTemplateInstances` runs after the `update` and opens with a
   * `findUniqueOrThrow` — a P2025 source on Prisma 6 — so it had a window of
   * its own. It now sits *inside* the same `try` as the write, which is what
   * this pins; before #100 it sat outside and the P2025 escaped as a 500.
   *
   * Note what this asserts: `not_found` for a write that *did* land. That is
   * deliberate. The row is gone before the caller is answered, so "no such
   * template" is the state their world is actually in; the alternative is
   * reporting a successful update of something that no longer exists.
   *
   * "Did land" is asserted, not just claimed. `{ ok: false, reason:
   * 'not_found' }` on its own is byte-identical to what the update-half of the
   * same `catch` produces — the test above — so the reason code alone cannot
   * say which window this is. `writtenClassType` below is what pins it: it is
   * read off the row the `UPDATE … RETURNING` handed back, so it is only set
   * if the write reached the database before the delete did.
   *
   * `string | undefined` rather than a `ClassTemplate`: an extension's `query`
   * callback is typed for a caller that may have passed a `select`, so every
   * field on the result it hands back is optional.
   */
  it('maps a delete landing between the write and the sync to not_found', async () => {
    const t = await makeTemplate('P2025 Sync');

    let writtenClassType: string | undefined;
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
            writtenClassType = row.classType;
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
    // The write reached the database before the delete did — which is what
    // makes this the sync half of the guard and not the update half.
    expect(writtenClassType).toBe('Renamed');
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
  let waiterId: string;
  let secondWaiterId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;
  type Seeded = Awaited<ReturnType<typeof seedTeacher>>;
  let east: Seeded;
  let west: Seeded;

  // Counter-derived startTime: this block calls makeTemplate 29 times at
  // runtime (28 call sites, one of them an `it.each` over 2 statuses) for
  // one teacher/dayOfWeek — the tightest counter in this repair, landing on
  // `slotTime(59)` = `'09:59'` exactly, which is why this block's
  // `makeTemplate` uses `slotTime` (see its docblock) rather than a raw
  // template literal: a 30th call here would have silently produced
  // `'09:60'` under the old formula. Most tests here do archive their own
  // template by the end (which flips isArchived and would free the slot on
  // its own), but several deliberately don't (the two 'forbidden' cases, and
  // the "does not tell a waiting student when the class was spared" case,
  // whose whole point is that the archive matches nothing) — and once any
  // one template is left behind unarchived, every later makeTemplate call in
  // the block collides with it before it even gets a row created, which is
  // what turned into a near-total cascade here. No test reads or asserts a
  // created template's literal startTime, so a distinct minute per call
  // removes the collision without touching any assertion.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string) => {
    makeTemplateCounter += 1;
    return prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: slotTime(30 + makeTemplateCounter),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });
  };

  // Closes over the block's own teacherId/teacherRoomId, like the sibling
  // block's makeTemplate does.
  //
  // Counter-derived startTime: this block calls makeClass ~30 times across
  // many tests, and several recurring `date` values (`future()` especially)
  // are reused across tests whose class deliberately survives the archive
  // (a kept/registered/late_cancel class, or a forbidden request that
  // touches nothing) — so under Class_teacher_slot_unique a later test's
  // create at the same date collided with an earlier test's still-open
  // leftover. This was masked in the original baseline: those tests never
  // even reached this call, because the template-level collision fixed
  // above threw first. `startTime` can be overridden per call for the one
  // test whose notification-body assertion pins the literal value.
  let makeClassCounter = 0;
  const makeClass = async (
    templateId: string,
    opts: {
      date: Date;
      status?: 'draft' | 'open' | 'cancelled';
      classType?: string;
      startTime?: string;
    },
  ) => {
    makeClassCounter += 1;
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        templateId,
        classType: opts.classType ?? 'Archive Rule',
        date: opts.date,
        startTime: opts.startTime ?? `09:${String(makeClassCounter).padStart(2, '0')}`,
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: opts.status ?? 'open',
      },
    });
  };

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

    // #112. A second student who only ever waits — the spared-class test needs
    // a registrant and a waiter who are different people, or "the waiter was
    // not notified" is indistinguishable from "the registrant was not".
    const waiter = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Waiter',
        email: `archive-waiter-${uniqueSuffix}@test.local`,
      },
    });
    waiterId = waiter.id;

    // A third, for the mixed-batch test: one archive, two classes, and the
    // assertion is that the spared class's waiter hears nothing WHILE the
    // withdrawn class's waiter hears. One student on both queues could not
    // tell those two apart.
    const secondWaiter = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Waiter Two',
        email: `archive-waiter2-${uniqueSuffix}@test.local`,
      },
    });
    secondWaiterId = secondWaiter.id;
  });

  afterAll(async () => {
    // Archive notifications outlive their class: `Notification.relatedClass`
    // is `onDelete: SetNull` (`schema.prisma:563`), so the class deletes below
    // do NOT reap them. Delete by recipient, before the students go.
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [studentId, waiterId, secondWaiterId] } },
    });
    await prisma.waitlistEntry.deleteMany({
      where: { studentId: { in: [studentId, waiterId, secondWaiterId] } },
    });
    await prisma.registration.deleteMany({
      where: { studentId: { in: [studentId, waiterId, secondWaiterId] } },
    });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, waiterId, secondWaiterId] } } });
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

  /**
   * #86 (`2026-07-25-template-archive-withdraws-window-design.md:231`) asked
   * for this and it was never written. The archive path's whole notification
   * design (#112) rests on the cascade being real: it READS its recipients
   * before the delete precisely because these rows do not survive it, and
   * decides who to notify after. (It does not notify before — notifying from
   * the candidate read is the bug the race test below exists to catch.) A
   * migration that changed `onDelete` would silently turn that read's ordering
   * from necessary into merely early, and nothing else in the suite would
   * notice.
   */
  it('cascade-deletes waitlist entries when the class row goes', async () => {
    const t = await makeTemplate('Cascade Pin');
    const c = await makeClass(t.id, { date: future() });
    const entry = await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId, position: 1, status: 'waiting' },
    });

    // Delete the class directly rather than through archiving: this pins the
    // schema property itself, not the one caller that happens to rely on it.
    await prisma.class.delete({ where: { id: c.id } });

    expect(await prisma.waitlistEntry.count({ where: { id: entry.id } })).toBe(0);
  });

  /**
   * #112. The archive's recipients are destroyed by the same statement that
   * withdraws their class, so they have to be READ before the delete — and
   * `Notification.relatedClass` being `SetNull` means the notice survives with
   * a null link. The body therefore has to name the class itself; a student
   * opening their inbox has nothing else left to identify it by.
   */
  it('tells a waiting student when archiving withdraws their class', async () => {
    const t = await makeTemplate('Withdraw Notice');
    // startTime pinned explicitly: the notification-body assertion below
    // checks for this literal, so it can't take the counter-derived default.
    const c = await makeClass(t.id, {
      date: future(),
      classType: 'Withdraw Notice',
      startTime: '09:00',
    });
    await register(c.id, studentId, 'cancelled'); // not charged — class is deletable
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    // `finally`, not a trailing statement — the convention `gdpr.test.ts:108`
    // records after round 1's M5. Every test below asserting a zero count for
    // `waiterId` depends on this running, and cleaning up only on the happy
    // path would turn one real failure here into several, most of them in the
    // very tests a reader would open to understand the first.
    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(1);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);

      const note = await prisma.notification.findFirstOrThrow({
        where: { recipientType: 'student', recipientId: waiterId, type: 'class_cancelled' },
      });
      // The link is gone with the class; the body is the only durable record,
      // so it has to carry all three identifying fields. Derived from the
      // fixture rather than hard-coded — a literal '16 Aug' would rot in five
      // days, since `future()` is relative to the run. `formatDayHeader`, the
      // whole rendering including the weekday: asserting only `12 Jun` would
      // pass against any formatter that contains it, which is how the earlier
      // version of this test could not have caught a swap.
      expect(note.relatedClassId).toBeNull();
      expect(note.body).toContain('Withdraw Notice');
      expect(note.body).toContain(formatDayHeader(c.date));
      expect(note.body).toContain('09:00'); // makeClass's startTime

      // Waiters, and ONLY waiters. `studentId` holds a `cancelled`
      // registration on this class and is deliberately not told: they left the
      // class themselves, or their teacher removed them, and either way the
      // withdrawal is not news they are owed. Widening the archive recipient
      // list to registrations would otherwise pass this whole file.
      expect(
        await prisma.notification.count({ where: { recipientId: studentId, type: 'class_cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: { in: [waiterId, studentId] } } });
    }
  });

  /**
   * The complement: a class the delete SPARED must not generate a notice.
   *
   * This kills `withdrawn = candidates` — but only because the candidate read
   * is deliberately WIDER than the delete (no registration predicate), so this
   * spared class IS a candidate and the survivor filter is what removes it.
   * Narrow the candidate read to mirror the delete and this test stops being
   * able to fail, because `candidates` comes back empty and notifying from it
   * produces the same zero. That is not hypothetical: it is what the first
   * implementation did, and PR review measured this test passing against the
   * mutation it was written to catch.
   */
  it('does not tell a waiting student when the class was spared', async () => {
    const t = await makeTemplate('Spared Notice');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'registered'); // charged — class survives
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(0);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);

      expect(
        await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
      ).toBe(0);
      // And the entry is untouched — the class is still on, the queue with it.
      const entry = await prisma.waitlistEntry.findFirstOrThrow({ where: { classId: c.id } });
      expect(entry.status).toBe('waiting');
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: waiterId } });
    }
  });

  /**
   * One archive, several classes, mixed outcomes — the ordinary case, since a
   * template generates instances on a rolling 4-week basis.
   *
   * The two tests above each archive a template carrying exactly one class, so
   * "filter by class id" and "all-or-nothing across the batch" produce
   * identical output and nothing distinguishes them. PR review measured
   * `withdrawn = survived.size === 0 ? candidates : []` passing the entire
   * file. Under that mutation this test notifies nobody: one spared class
   * silences every withdrawn one, which is #112 reintroduced through its own
   * fix.
   */
  it('notifies only the waiters of the classes it actually withdrew', async () => {
    const t = await makeTemplate('Mixed Batch');
    const kept = await makeClass(t.id, { date: futureOn(6), classType: 'Mixed Kept' });
    const gone = await makeClass(t.id, { date: futureOn(13), classType: 'Mixed Gone' });
    await register(kept.id, studentId, 'registered'); // charged — spares `kept`
    await prisma.waitlistEntry.create({
      data: { classId: kept.id, studentId: waiterId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: gone.id, studentId: secondWaiterId, position: 1, status: 'waiting' },
    });

    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(1);
      expect(await prisma.class.count({ where: { id: kept.id } })).toBe(1);
      expect(await prisma.class.count({ where: { id: gone.id } })).toBe(0);

      // The withdrawn class's waiter hears, and the body names THAT class.
      const note = await prisma.notification.findFirstOrThrow({
        where: { recipientId: secondWaiterId, type: 'class_cancelled' },
      });
      expect(note.body).toContain('Mixed Gone');
      // The spared class's waiter hears nothing, in the same transaction.
      expect(
        await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.notification.deleteMany({
        where: { recipientId: { in: [waiterId, secondWaiterId] } },
      });
    }
  });

  /**
   * The `status: 'waiting'` filter on the candidate read, which nothing else
   * pins: every waitlist fixture in this file writes `waiting`, so dropping
   * the filter changes no other test's outcome.
   *
   * It matters because `class_cancelled` is in `ESSENTIAL_NOTIFICATION_TYPES`
   * and bypasses the student's email preference. Without the filter, someone
   * who left the queue months ago is emailed about a class they are not
   * waiting for and cannot act on.
   */
  it('does not notify a student who had already left the queue', async () => {
    const t = await makeTemplate('Removed Entry');
    const c = await makeClass(t.id, { date: future() });
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'removed' },
    });

    try {
      const result = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
      expect(result.deleted).toBe(1); // the class still goes — nothing charged
      expect(
        await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
      ).toBe(0);
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: waiterId } });
    }
  });

  /**
   * #112. The one guard in this change that needs real concurrency to bite.
   *
   * Without this test, notifying from the candidate read and notifying from
   * the survivor filter are indistinguishable — every non-concurrent case
   * produces identical output, so the filter could be deleted and the suite
   * would stay green while students were told their live classes had been
   * withdrawn.
   *
   * The archive transaction locks the TEMPLATE row, not these classes, so the
   * registration below commits from outside it. Under READ COMMITTED the
   * `deleteMany` re-evaluates its predicate when it runs, sees a charged
   * registration, and spares the class — #86's whole reason for keeping that
   * delete a single statement.
   */
  it('does not notify a waiter whose class was booked after the candidate read', async () => {
    const t = await makeTemplate('Race Spare');
    const c = await makeClass(t.id, { date: future() });
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    let calls = 0;
    let candidateRows = -1;
    const interposing = prisma.$extends({
      query: {
        waitlistEntry: {
          async findMany({ args, query }) {
            calls++;
            const rows = await query(args);
            // Once, and only after the candidate read has returned: commit a
            // charged registration from outside the archive transaction.
            if (calls === 1) {
              candidateRows = rows.length;
              await prisma.registration.create({
                data: { classId: c.id, studentId, tierAtBooking: 3, status: 'registered' },
              });
            }
            return rows;
          },
        },
      },
    }) as unknown as typeof prisma;

    const result = expectArchived(
      await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived'),
    );

    // Exactly one — no more, no fewer, the same pin `gdpr.test.ts:1046` and
    // the sibling interposition at `class-transitions.test.ts` carry.
    //
    // A bare "it fired at all" flag is not enough here, and PR review proved
    // it: with the survivor filter deleted AND one extra `waitlistEntry`
    // read added anywhere earlier in the archive branch, this test passed.
    // The race landed on the wrong read, the candidate read then came back
    // empty, and every assertion below was satisfied while students were
    // being told live classes had been withdrawn. What the test actually
    // needs is that the read it raced against WAS the candidate read — so
    // pin the count, and pin that the read it interposed on saw the waiter.
    expect(calls).toBe(1);
    expect(candidateRows).toBe(1);
    // The delete re-evaluated and spared the class.
    expect(result.deleted).toBe(0);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
    // So the waiter must NOT have been told it was withdrawn.
    expect(
      await prisma.notification.count({ where: { recipientId: waiterId, type: 'class_cancelled' } }),
    ).toBe(0);
  });

  /**
   * The mirror of the test above, and the regression guard for the candidate
   * read being WIDER than the delete.
   *
   * There the class became un-deletable in the gap and its waiter must not be
   * told. Here it becomes deletable in the gap — the last charged registration
   * is cancelled between the candidate read and the `deleteMany` — and the
   * waiter MUST be told.
   *
   * Narrow the candidate read to mirror the delete's predicate and this class
   * is not a candidate when it is read, is deleted anyway when the predicate is
   * re-evaluated, and its waiter is cascade-deleted in silence. PR review
   * reproduced exactly that against the first implementation. Every other test
   * in this file passes under that mutation; only this one fails.
   *
   * The trigger is ordinary: a queue only forms at `maxStudents`, so a class
   * with waiters normally DOES hold a charged registration, and a student's own
   * before-deadline cancel writes plain `cancelled` (`registrations/[id]`).
   */
  it('notifies a waiter whose class became deletable after the candidate read', async () => {
    const t = await makeTemplate('Race Delete');
    const c = await makeClass(t.id, { date: future(), classType: 'Race Delete' });
    const reg = await register(c.id, studentId, 'registered'); // charged — spared, for now
    await prisma.waitlistEntry.create({
      data: { classId: c.id, studentId: waiterId, position: 1, status: 'waiting' },
    });

    let calls = 0;
    const interposing = prisma.$extends({
      query: {
        waitlistEntry: {
          async findMany({ args, query }) {
            calls++;
            const rows = await query(args);
            if (calls === 1) {
              // Commit the cancellation from OUTSIDE the archive transaction,
              // after the candidate read has returned. `cancelled` is not in
              // `CHARGED_STATUSES`, so the delete's predicate now matches.
              await prisma.registration.update({
                where: { id: reg.id },
                data: { status: 'cancelled', cancelledAt: new Date() },
              });
            }
            return rows;
          },
        },
      },
    }) as unknown as typeof prisma;

    try {
      const result = expectArchived(
        await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived'),
      );

      expect(calls).toBe(1);
      // The delete re-evaluated and took the class.
      expect(result.deleted).toBe(1);
      expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
      // So the waiter must have been told, even though the class did not match
      // the delete's predicate at the moment they were read.
      const note = await prisma.notification.findFirstOrThrow({
        where: { recipientId: waiterId, type: 'class_cancelled' },
      });
      expect(note.body).toContain('Race Delete');
      expect(note.relatedClassId).toBeNull();
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: waiterId } });
    }
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

  /**
   * #100. `archiveOrUnarchiveTemplate` carries no P2025 guard, and the comment
   * on its compare-and-swap justifies that with "the zero-count branch below
   * already answers `not_found` by re-reading". Until now nothing exercised
   * that re-read: the only other archive `not_found` assertion in this file
   * passes a ghost id, which the guard at the *top* of the function answers
   * without ever opening the transaction.
   *
   * This is the path where the row is real when the function starts and gone
   * when the CAS runs, so `updateMany` matches nothing, `count` is 0, and the
   * inner `findUnique` legitimately returns `null` — the only way that null
   * branch is reachable at all. Two mutants live here without it: turning the
   * inner read into a `findUniqueOrThrow` (its P2025 would escape the
   * transaction as a 500), and dropping the null check to report the
   * pre-transaction snapshot as `unchanged` (a 200 describing a template that
   * no longer exists).
   *
   * Interposed on `classTemplate.findUnique`, which both reads go through: the
   * latch fires on the outer one, deleting the row after it has been read, and
   * no-ops on the inner one, which then sees the delete for real.
   */
  it('answers not_found when the row disappears between the read and the compare-and-swap', async () => {
    const t = await makeTemplate('P2025 Archive CAS');

    let deleted = false;
    // Same cast, same reason as the `interposing` clients in the
    // `updateClassTemplate` block above.
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

    const result = await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
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

  // Counter-derived startTime: this block calls makeTemplate 9 times for one
  // teacher/dayOfWeek, and pausing (unlike archiving) never sets
  // isArchived, so a merely-paused template keeps occupying its slot for
  // the rest of the run — only the two tests that go on to archive their
  // template free theirs. No test reads or asserts a created template's
  // literal startTime *except* "reports what the window holds when a slot
  // is already taken" below, which hardcodes '09:30' three times to match
  // a manually-inserted "occupied" class against the template's own
  // generated occurrences — that one call takes an explicit override
  // instead of the counter-derived default.
  let makeTemplateCounter = 0;
  const makeTemplate = (classType: string, startTime?: string) => {
    makeTemplateCounter += 1;
    return prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: startTime ?? slotTime(30 + makeTemplateCounter),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });
  };

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

  // The generator's occupancy check is per-teacher (#196), so one test's
  // generated window occupies the next test's slots: several tests here resume
  // templates on the same `dayOfWeek`/`startTime`, and without this a resume
  // that used to create four would create nothing.
  beforeEach(async () => {
    await prisma.class.deleteMany({ where: { teacherId } });
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

  /**
   * A manually created class (templateId null) occupies one of the resume's
   * candidate slots, so the resume creates three and reports the occupied date
   * as `slotTaken`. `scheduled` counts the three it created for this template —
   * the manual class belongs to no template, so it is not counted here.
   */
  it('reports what the window holds when a slot is already taken', async () => {
    // Explicit '09:30' override: the candidate/manual-class computation
    // below hardcodes '09:30' to match what this template will generate, so
    // it can't take the counter-derived default the other calls in this
    // block use.
    const t = await makeTemplate('Slot Taken Report', '09:30');
    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');

    const candidates = getNextOccurrences(3, new Date(), 5)
      .filter((d) => classStartInstant(d, '09:30', 'UTC') > new Date())
      .slice(0, 4);
    await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        templateId: null,
        classType: 'Manual',
        date: candidates[0]!,
        startTime: '09:30',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        cancelDeadline: 'HOURS_24',
        autoCancelCheck: 'HOURS_2',
        status: 'open',
      },
    });

    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toMatchObject({ ok: true, action: 'active', added: 3, slotTaken: 1 });
    if (result.ok && result.action === 'active') {
      expect(result.scheduled).toBe(3);
      expect(result.blockedByCancelled).toBe(0);
    }
  });

  /**
   * The mirror of the case above, and the reason it has to exist: until this
   * test, `blockedByCancelled` was only ever asserted at **zero**, in a window
   * whose skips were all `slot_taken`. Re-pointing its filter to
   * `already_generated` therefore passed every test in the repo — while telling
   * a teacher resuming a perfectly healthy template "4 classes on your
   * schedule. 4 cancelled classes still hold those dates.", because a resumed
   * window whose four dates are already generated is the *common* case (pausing
   * deletes nothing).
   *
   * Three of four cancelled, not two: with two, `blocked_by_cancelled` and
   * `already_generated` are both 2, so the mis-wired filter returns the right
   * number by coincidence and the test passes against the bug. Measured — the
   * first version of this test did exactly that. Three and one cannot collide.
   */
  it('counts cancelled dates separately from taken slots', async () => {
    const t = await makeTemplate('Blocked By Cancelled Report');
    // Generate the window, then cancel two of the four dates it created.
    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');
    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');
    const made = await prisma.class.findMany({
      where: { templateId: t.id },
      orderBy: { date: 'asc' },
      select: { id: true },
    });
    expect(made).toHaveLength(4);
    await prisma.class.updateMany({
      where: { id: { in: [made[0]!.id, made[1]!.id, made[2]!.id] } },
      data: { status: 'cancelled' },
    });

    await pauseOrResumeTemplate(prisma, t.id, teacherId, 'paused');
    const result = await pauseOrResumeTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toMatchObject({ ok: true, action: 'active', added: 0, blockedByCancelled: 3 });
    if (result.ok && result.action === 'active') {
      // One survivor, still draft/open — cancelled rows are excluded from
      // `scheduled` by SCHEDULED_STATUSES. Also the `already_generated` count,
      // which is what a mis-wired filter would report instead of 3.
      expect(result.scheduled).toBe(1);
      expect(result.slotTaken).toBe(0);
    }
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
   * between them raises Prisma's P2025 at the write. The guard maps it to
   * `not_found`; before #100 it escaped as a 500, which is what this pins.
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
