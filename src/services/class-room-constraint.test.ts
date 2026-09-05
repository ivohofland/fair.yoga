import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type ClassStatus } from '@prisma/client';
import { isCheckViolationOn } from '@/lib/check-violation';
import { isRestrictViolationOn } from '@/lib/api-errors';
import { BLOCKING_CLASS_STATUSES } from './room-archive';

const prisma = new PrismaClient();
const suffix = `croom-${Date.now()}`;
const CHECK = 'Class_live_needs_open_room';
const ROOM_FK = 'Class_teacherRoomId_roomArchived_fkey';
const ENTRY_FK = 'Class_calendarEntryId_kind_entryLive_fkey';

let teacherId: string;
let openRoomId: string;
let shelvedRoomId: string;
const accountIds: string[] = [];

// Every row this file creates is tagged with `suffix`, so the file owns
// everything it touches and `afterAll` can delete by that tag. `makeRoom`
// follows `template-room-constraint.test.ts`'s helper of the same name.
async function makeRoom(tag: string, archived: boolean): Promise<string> {
  const room = await prisma.room.create({
    data: {
      venueName: `Venue ${tag}`, address: `${suffix} ${tag} Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: tag, maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  const link = await prisma.teacherRoom.create({
    data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12, isArchived: archived },
  });
  return link.id;
}

// A fresh date per call. Several cases below assert a class PERSISTS (a
// draft in an archived room, a cancelled-then-archived pair), so this file's
// fixtures deliberately outlive a single `makeClass` call — reusing one date
// would trip `CalendarEntry_teacher_slot_excl` (one teacher, one slot) on
// the SECOND surviving entry, a collision that has nothing to do with the
// constraint this file exists to test.
let slotOffset = 0;

/** Creates an entry and its class in one go, returning the class id. */
async function makeClass(teacherRoomId: string, status: ClassStatus): Promise<string> {
  const room = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: teacherRoomId } });
  const entry = await prisma.calendarEntry.create({
    data: {
      teacherId,
      kind: 'regular',
      classType: `c-${suffix}`,
      date: new Date(Date.UTC(2027, 0, 4 + slotOffset++)),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
    },
  });
  const cls = await prisma.class.create({
    data: {
      calendarEntryId: entry.id,
      kind: 'regular',
      teacherRoomId,
      // COPIED, not defaulted — the mirror is one column of a foreign key, so
      // a fixture that assumed `false` could not build a class in an archived
      // room at all, and half this file's cases need one.
      roomArchived: room.isArchived,
      roomCost: 0, minRate: 0, targetRate: 0, minStudents: 1, maxStudents: 10,
      status,
    },
  });
  return cls.id;
}

const entryIdOf = async (classId: string): Promise<string> =>
  (await prisma.class.findUniqueOrThrow({ where: { id: classId } })).calendarEntryId;

beforeAll(async () => {
  await prisma.$connect();
  const email = `owner-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Room', lastName: 'Guard', email, bio: 'room invariant fixture',
      pageSlug: `owner-${suffix}`, account: { create: { email } },
    },
  });
  teacherId = t.id; accountIds.push(t.accountId);
  openRoomId = await makeRoom('open', false);
  shelvedRoomId = await makeRoom('shelved', true);
});

afterAll(async () => {
  // Order matters: `Class_teacherRoomId_roomArchived_fkey` is ON DELETE
  // RESTRICT, so classes must go before the rooms they point at. Deleting the
  // entries cascades the classes away.
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { createdById: teacherId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('Class_live_needs_open_room', () => {
  it('refuses an open class in an archived room', async () => {
    await expect(makeClass(shelvedRoomId, 'open')).rejects.toSatisfy(
      (e: unknown) => isCheckViolationOn(e, CHECK),
    );
  });

  it('permits a draft in an archived room', async () => {
    const id = await makeClass(shelvedRoomId, 'draft');
    expect(id).toBeTruthy();
  });

  it('permits a cancelled open class in an archived room', async () => {
    // Liveness is status AND the entry's cancelledAt — this is the case a
    // status-only predicate would get wrong, and the one that keeps
    // "cancel the class, then archive the room" working.
    const id = await makeClass(openRoomId, 'open');
    await prisma.calendarEntry.update({
      where: { id: await entryIdOf(id) },
      data: { cancelledAt: new Date() },
    });
    await expect(
      prisma.teacherRoom.update({
        where: { id: openRoomId },
        data: { isArchived: true },
      }),
    ).resolves.toBeTruthy();

    // Restored rather than left archived: `openRoomId` is a fixture SHARED
    // by every later case in this file, each of which assumes it starts
    // open. Un-archiving is unconditional in the real app (CLAUDE.md's
    // "release valve"), so undoing it here costs nothing this test is
    // checking.
    await prisma.teacherRoom.update({
      where: { id: openRoomId },
      data: { isArchived: false },
    });
  });

  it('refuses archiving a room that holds a live class', async () => {
    await makeClass(openRoomId, 'open');
    await expect(
      prisma.teacherRoom.update({
        where: { id: openRoomId },
        data: { isArchived: true },
      }),
    ).rejects.toSatisfy((e: unknown) => isCheckViolationOn(e, CHECK));
  });

  it('refuses a mirror that disagrees with its room', async () => {
    // The mirrors cannot drift because each is one column of a composite
    // foreign key. Claiming a value the parent does not hold is 23503,
    // surfaced through Prisma's typed client as `P2003` — the code
    // `isRestrictViolationOn` matches. A raw query reports the same 23503
    // wrapped as `P2010` instead, which that matcher deliberately does not
    // read (see its docblock), so this goes through the typed `update`, not
    // `$executeRawUnsafe`.
    //
    // A fresh `draft` class, scoped to this test: `draft` can never trip
    // `Class_live_needs_open_room` regardless of `roomArchived`, so the FK is
    // the only constraint this update can hit — a shared-fixture row filtered
    // only by `teacherRoomId` could carry a live class from another case and
    // trip the CHECK instead.
    const id = await makeClass(openRoomId, 'draft');
    await expect(
      prisma.class.update({ where: { id }, data: { roomArchived: true } }),
    ).rejects.toSatisfy((e: unknown) => isRestrictViolationOn(e, [ROOM_FK]));
  });

  it('refuses a mirror that disagrees with its entry', async () => {
    const id = await makeClass(openRoomId, 'draft');
    await expect(
      prisma.class.update({ where: { id }, data: { entryLive: false } }),
    ).rejects.toSatisfy((e: unknown) => isRestrictViolationOn(e, [ENTRY_FK]));
  });

  it('a create that ASSERTS the room is open fails on the FK, not the CHECK (issue 339)', async () => {
    // This is the bug the two create paths (`api/classes/route.ts`,
    // `class-generator.ts`) exist to avoid: writing `roomArchived: false`
    // rather than copying the room's actual value. A `draft` never trips
    // `Class_live_needs_open_room` regardless of `roomArchived` (see "permits
    // a draft in an archived room" above), so an assertion like this can only
    // fail on the FK — which is exactly how a route that copied issue 272's
    // `ClassTemplate` pattern (assert `false`) instead of `Class`'s own (copy
    // the room) would be caught: a legal draft-in-an-archived-room create
    // would be refused rather than allowed.
    const entry = await prisma.calendarEntry.create({
      data: {
        teacherId,
        kind: 'regular',
        classType: `c-${suffix}`,
        date: new Date(Date.UTC(2027, 0, 4 + slotOffset++)),
        startTime: new Date('1970-01-01T10:00:00Z'),
        durationMinutes: 60,
      },
    });
    await expect(
      prisma.class.create({
        data: {
          calendarEntryId: entry.id,
          kind: 'regular',
          teacherRoomId: shelvedRoomId,
          roomArchived: false, // asserted, not copied — the bug this pins
          roomCost: 0, minRate: 0, targetRate: 0, minStudents: 1, maxStudents: 10,
          status: 'draft',
        },
      }),
    ).rejects.toSatisfy((e: unknown) => isRestrictViolationOn(e, [ROOM_FK]));
  });
});

describe('the CHECK and BLOCKING_CLASS_STATUSES agree', () => {
  // The SQL spells two literals the TypeScript constant also spells. A
  // database constraint cannot import a constant, so a TEST is the tether:
  // iterate the ENUM, not a hand-written list, so a new ClassStatus member
  // fails here until someone decides its side.
  const ALL: ClassStatus[] = ['draft', 'open', 'in_progress', 'completed'];

  // Compile-time tether: a new ClassStatus member makes this assignment fail,
  // which is the signal to add it to ALL above and decide its side.
  const _exhaustive: Record<ClassStatus, true> = {
    draft: true, open: true, in_progress: true, completed: true,
  };
  void _exhaustive;

  it.each(ALL)('status %s blocks iff it is in BLOCKING_CLASS_STATUSES', async (status) => {
    const blocks = BLOCKING_CLASS_STATUSES.includes(status);
    const attempt = makeClass(shelvedRoomId, status);
    if (blocks) {
      await expect(attempt).rejects.toSatisfy((e: unknown) => isCheckViolationOn(e, CHECK));
    } else {
      await expect(attempt).resolves.toBeTruthy();
    }
  });
});
