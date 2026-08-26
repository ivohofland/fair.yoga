import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { hhmmToTime } from '@/lib/time-of-day';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const suffix = `slot-${Date.now()}`;
let teacherId: string;
let otherTeacherId: string;
const accountIds: string[] = [];

async function makeTeacher(tag: string): Promise<string> {
  const email = `${tag}-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Slot', lastName: tag, email, bio: 'slot constraint fixture',
      pageSlug: `${tag}-${suffix}`, account: { create: { email } },
    },
  });
  accountIds.push(t.accountId);
  return t.id;
}

let roomId: string;
let teacherRoomId: string;

/**
 * One date per case, handed out by hand rather than by a counter: several
 * cases below need TWO dates that must not be each other's, and a shared
 * counter would make which date a case gets depend on how many the cases above
 * it consumed.
 */
const day = (n: number) => new Date(Date.UTC(2027, 5, n));

const studio = (teacher: string, date: Date, start = '09:00') => ({
  teacherId: teacher, classType: 'Yoga', date,
  startTime: hhmmToTime(start), durationMinutes: 60, location: 'Studio', hourlyRate: 40,
});

const cls = (teacher: string, date: Date, start = '09:00') => ({
  teacherId: teacher, teacherRoomId, classType: 'Yoga',
  date, startTime: hhmmToTime(start), durationMinutes: 60,
  roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
});

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner');
  otherTeacherId = await makeTeacher('other');
  const room = await prisma.room.create({
    data: {
      venueName: 'Slot Venue', address: `${suffix} Slot Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  roomId = room.id;
  const tr = await prisma.teacherRoom.create({
    // `capacityOverride` is required and has no default (schema.prisma).
    data: { teacherId, roomId, rentalRate: 20, capacityOverride: 12 },
  });
  teacherRoomId = tr.id;
});

afterAll(async () => {
  const teachers = [teacherId, otherTeacherId];
  // Entries first, and they take both families' children with them
  // (`Class_calendarEntryId_kind_fkey` and its `StudioClass` twin are
  // `ON DELETE CASCADE`). Must precede `teacherRoom.deleteMany`:
  // `Class_teacherRoomId_fkey` is `ON DELETE RESTRICT`, so a surviving class
  // blocks the room link's delete.
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teachers } } });
  // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
  // `ScheduleRule` (issue 298), so deleting the rules removes both
  // families' templates with them.
  await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.room.deleteMany({ where: { createdById: { in: teachers } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teachers } } });
  // `Teacher.accountId` has no `onDelete: Cascade` (prisma/schema.prisma),
  // so the Account row each makeTeacher() created survives the teacher
  // delete above and must be removed separately, only after it — Account
  // is what Teacher.accountId references.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

const EXCL = 'CalendarEntry_teacher_slot_excl';

/** Asserts the DATABASE refused, and that it was THIS constraint that did. */
async function expectSlotRefusal(fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toSatisfy((e: unknown) => isExclusionConflictOn(e, EXCL));
}

/**
 * One teacher, one slot, across both families (#296) — asserted at the layer a
 * caller actually writes through.
 *
 * These assert the DATABASE rejects the write. The route-level 409s in
 * tests/integration only prove a route's own branch; with the constraint absent
 * they would still pass on a sequential retry and fail only under a race, which
 * is the case that motivated #196.
 *
 * WHAT THIS FILE ADDS OVER `calendar-entry.test.ts`. That file drives
 * `CalendarEntry_teacher_slot_excl` with raw inserts of bare entries, which is
 * the right way to pin the constraint's own shape — the half-open boundary,
 * the midnight span, the duration edit. Every case here goes through
 * `createClassFixture` / `createStudioClassFixture` instead, i.e. through an
 * entry AND its child in the family a caller would create, which is what makes
 * the cross-family half of #296 observable at all: an entry with no child
 * belongs to no family.
 *
 * The assertions name the exclusion constraint by NAME
 * (`isExclusionConflictOn`) rather than by `meta.target`, because a 23P01
 * exclusion violation carries no `meta.target`: `code` and `meta` are both
 * `undefined` on the Prisma error (`src/lib/exclusion-conflict.ts`), which is
 * the whole reason that matcher exists rather than reusing `isUniqueConflictOn`.
 *
 * LOAD-BEARING PROPERTY THIS WHOLE DESCRIBE DEPENDS ON:
 * `CalendarEntry_teacher_slot_excl` keys on `(teacherId, span)` only — `kind`
 * is not part of it (`20260826080000_calendar_entry/migration.sql`). That is
 * why the cases below mix `regular` and `studio` freely rather than writing a
 * same-family and a cross-family variant of each: with `kind` absent from the
 * key, a same-family collision and a cross-family one compile to
 * byte-identical work against this constraint, so one case proves both. The
 * four refusal cases that DO spell out the 2x2 are the exception, and
 * deliberate — that matrix is #296's acceptance criterion stated directly.
 * If `kind` is ever added to the constraint's key, every case that relies on
 * the stand-in needs its same-family twin written back in.
 *
 * TWO CASES THIS FILE NO LONGER CARRIES, both from the trigger era:
 * - "leaves a pre-existing violating pair editable on unrelated columns", in
 *   both families. The pair was built by disabling the triggers around an
 *   insert; a constraint is not a trigger and cannot be disabled that way, and
 *   an exclusion constraint cannot be `NOT VALID` either, so the state is
 *   unconstructible by design (parent design doc §7.2).
 * - "un-cancelling a class into an occupied cross-family slot". Un-cancelling
 *   a REGULAR entry is refused outright now, whatever the slot holds —
 *   `entry_terminal_liveness_guard`, pinned in `calendar-entry.test.ts`. The
 *   studio half survives below, because that un-cancel path is live.
 */
describe('CalendarEntry_teacher_slot_excl, through both families', () => {
  it('refuses a second live class on an occupied slot', async () => {
    await createClassFixture(prisma, cls(teacherId, day(1)));
    await expectSlotRefusal(() => createClassFixture(prisma, cls(teacherId, day(1))));
  });

  it('refuses a second live studio class on an occupied slot', async () => {
    await createStudioClassFixture(prisma, studio(teacherId, day(2)));
    await expectSlotRefusal(() => createStudioClassFixture(prisma, studio(teacherId, day(2))));
  });

  it('refuses a live studio class on a live class\'s slot', async () => {
    await createClassFixture(prisma, cls(teacherId, day(3)));
    await expectSlotRefusal(() => createStudioClassFixture(prisma, studio(teacherId, day(3))));
  });

  it('refuses a live class on a live studio class\'s slot', async () => {
    await createStudioClassFixture(prisma, studio(teacherId, day(4)));
    await expectSlotRefusal(() => createClassFixture(prisma, cls(teacherId, day(4))));
  });

  // The two boundary cases, at the layer the fixtures write. The raw-SQL file
  // pins the constraint's half-open range directly; these pin that a fixture's
  // `durationMinutes` actually reaches `span` — a builder that dropped the
  // column would leave every exact-slot case above green.
  it('refuses a studio class overlapping the tail of a class', async () => {
    await createClassFixture(prisma, cls(teacherId, day(5), '09:00'));   // 09:00-10:00
    await expectSlotRefusal(() =>
      createStudioClassFixture(prisma, studio(teacherId, day(5), '09:30')));
  });

  it('ALLOWS back-to-back across the two families', async () => {
    await createClassFixture(prisma, cls(teacherId, day(6), '09:00'));   // 09:00-10:00
    await expect(createStudioClassFixture(prisma, studio(teacherId, day(6), '10:00')))
      .resolves.toBeTruthy();
  });

  // Cancellation releases the slot — the constraint is partial on
  // `cancelledAt IS NULL`. Families mixed on purpose (see the docblock): the
  // resident's family is what varies, because that is the row whose liveness
  // decides.
  it('a cancelled class releases its slot to a studio class', async () => {
    await createClassFixture(prisma, { ...cls(teacherId, day(7)), cancelledAt: new Date() });
    await expect(createStudioClassFixture(prisma, studio(teacherId, day(7))))
      .resolves.toBeTruthy();
  });

  it('a cancelled studio class releases its slot to a class', async () => {
    await createStudioClassFixture(prisma, { ...studio(teacherId, day(8)), cancelledAt: new Date() });
    await expect(createClassFixture(prisma, cls(teacherId, day(8)))).resolves.toBeTruthy();
  });

  // `teacherId WITH =` scopes the constraint. Both pairings, because the
  // resident and the mover are not symmetric here: each case seeds its own
  // colliding row rather than relying on a preceding test's, so neither can
  // pass vacuously if `teacherId` is ever dropped from the key.
  it('does not block another teacher from a class\'s slot', async () => {
    await createClassFixture(prisma, cls(teacherId, day(9)));
    await expect(createClassFixture(prisma, cls(otherTeacherId, day(9)))).resolves.toBeTruthy();
  });

  it('does not block a class from another teacher\'s studio class at the same slot', async () => {
    await createStudioClassFixture(prisma, studio(otherTeacherId, day(10)));
    await expect(createClassFixture(prisma, cls(teacherId, day(10)))).resolves.toBeTruthy();
  });

  // The constraint re-checks on UPDATE, not only on INSERT — and `span` is
  // generated from `date` and `startTime` both, so one case per field. Which
  // family moves is the stand-in the docblock names; the field is not.
  it('refuses moving a class by DATE into an occupied slot', async () => {
    await createStudioClassFixture(prisma, studio(teacherId, day(11)));       // resident
    const c = await createClassFixture(prisma, cls(teacherId, day(12)));      // mover
    await expectSlotRefusal(() => prisma.calendarEntry.update({
      where: { id: c.calendarEntryId },
      data: { date: day(11) },
    }));
  });

  it('refuses moving a studio class by startTime into an occupied slot', async () => {
    await createClassFixture(prisma, cls(teacherId, day(13), '09:00'));       // resident
    const s = await createStudioClassFixture(prisma, studio(teacherId, day(13), '07:00'));
    await expectSlotRefusal(() => prisma.calendarEntry.update({
      where: { id: s.calendarEntryId },
      data: { startTime: hhmmToTime('09:00') },
    }));
  });

  // Reviving a cancelled row is the third way into the constraint, after
  // create and move. Studio only — see the docblock's second missing case.
  it('refuses un-cancelling a studio class into an occupied slot', async () => {
    const s = await createStudioClassFixture(
      prisma, { ...studio(teacherId, day(14)), cancelledAt: new Date() },
    );
    await createClassFixture(prisma, cls(teacherId, day(14)));
    await expectSlotRefusal(() => prisma.calendarEntry.update({
      where: { id: s.calendarEntryId },
      data: { cancelledAt: null },
    }));
  });
});

describe('Room identity indexes', () => {
  const room = (creator: string, isPublic: boolean, name: string) => ({
    venueName: 'V', address: `${suffix} Identity Street`, city: 'Amsterdam',
    postcode: '1011AB', floor: '3', roomName: name, maxCapacity: 10,
    isPublic, createdById: creator,
  });

  it('rejects a second public room with the same address/floor/roomName', async () => {
    await prisma.room.create({ data: room(teacherId, true, 'PubA') });
    const err = await prisma.room.create({ data: room(otherTeacherId, true, 'PubA') })
      .catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['address', 'floor', 'roomName']);
  });

  it('scopes private rooms per creator: same teacher twice is rejected', async () => {
    await prisma.room.create({ data: room(teacherId, false, 'PrivA') });
    const err = await prisma.room.create({ data: room(teacherId, false, 'PrivA') })
      .catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['createdById', 'address', 'floor', 'roomName']);
  });

  it('scopes private rooms per creator: a different teacher is allowed', async () => {
    // Seeds its own colliding row ('PrivB', distinct from the 'PrivA' row
    // above) rather than relying on the preceding test's row: under the
    // Step 9 mutation that drops `createdById` from the index, this is what
    // makes the assertion actually exercise the guard instead of vacuously
    // passing when run in isolation.
    await prisma.room.create({ data: room(teacherId, false, 'PrivB') });
    await expect(prisma.room.create({ data: room(otherTeacherId, false, 'PrivB') }))
      .resolves.toBeTruthy();
  });

  // PR #208 review, E1. `Room_private_identity_unique`'s `WHERE isPublic =
  // false` predicate was pinned by nothing: nothing proved a public and a
  // private room could share an identity. One creator, both arms, same
  // address/floor/roomName — each row enters only its own partial index
  // (`Room_public_identity_unique` needs `isPublic = true`,
  // `Room_private_identity_unique` needs `isPublic = false`), so neither
  // collides with the other. Delete the predicate from either index and this
  // goes red.
  it('lets one creator hold a public and a private room at the same address/floor/roomName', async () => {
    await prisma.room.create({ data: room(teacherId, true, 'DualScope') });
    await expect(prisma.room.create({ data: room(teacherId, false, 'DualScope') }))
      .resolves.toBeTruthy();
  });
});
