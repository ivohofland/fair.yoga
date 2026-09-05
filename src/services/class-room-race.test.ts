import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';
import { setTeacherRoomArchived } from './room-archive';
import { transitionClass } from './class-lifecycle';

/**
 * @serial-tier lock-contention — each of its two cases holds a real row lock
 * for the length of a staged race (~1s), the same shape as
 * `room-archive-lock-order.test.ts`.
 *
 * Door 1's TRUE concurrent races (#339) — as opposed to the sequential unit
 * cases in `room-archive-doors.test.ts` and `room-archive.test.ts`, which
 * cannot stage the actual interleaving a real race needs. Two clients,
 * because one connection cannot hold a transaction open for another
 * (`template-room-race.test.ts`, this file's model).
 */
const a = new PrismaClient();
const b = new PrismaClient();
const suffix = `croom-race-${Date.now()}`;
let teacherId: string;
let accountId: string;
let seq = 0;

beforeAll(async () => {
  await Promise.all([a.$connect(), b.$connect()]);
  const email = `${suffix}@test.local`;
  const t = await a.teacher.create({
    data: {
      firstName: 'Race', lastName: 'Fixture', email, bio: 'race fixture',
      pageSlug: suffix, account: { create: { email } },
    },
  });
  teacherId = t.id;
  accountId = t.accountId;
});

afterAll(async () => {
  // Order matters: `Class_teacherRoomId_roomArchived_fkey` is ON DELETE
  // RESTRICT, so classes must go before the rooms they point at. Deleting the
  // entries cascades the classes away (`class-room-constraint.test.ts`).
  await a.calendarEntry.deleteMany({ where: { teacherId } });
  await a.teacherRoom.deleteMany({ where: { teacherId } });
  await a.room.deleteMany({ where: { createdById: teacherId } });
  await a.teacher.deleteMany({ where: { id: teacherId } });
  await a.account.deleteMany({ where: { id: accountId } });
  await Promise.all([a.$disconnect(), b.$disconnect()]);
});

/**
 * A FRESH room per case, deliberately, not one shared across both tests. Each
 * race ends with a cascade-wide write on `TeacherRoom.isArchived` — the first
 * case's own published class would sit there live afterward, and the second
 * case's archive-then-hold would trip `Class_live_needs_open_room` on THAT
 * leftover the moment its own transaction started, before the race it means
 * to stage ever began.
 */
async function makeOpenRoom(): Promise<string> {
  const tag = `${suffix}-${seq++}`;
  const room = await a.room.create({
    data: {
      venueName: `Venue ${tag}`, address: `${tag} Race Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  const link = await a.teacherRoom.create({
    data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12 },
  });
  return link.id;
}

/** Always future-dated, and a fresh date per call: a past-dated draft would
 * hit `transitionClass`'s `STARTS_IN_PAST` pre-check before the room-archived
 * one ever runs, and two drafts on the same date would collide on
 * `CalendarEntry_teacher_slot_excl` (one teacher, one slot). */
async function makeDraft(teacherRoomId: string): Promise<string> {
  const cls = await createClassFixture(a, {
    teacherId,
    teacherRoomId,
    classType: 'Race Yoga',
    date: slotDate(new Date(), 14 + seq++),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 15,
    minRate: 10,
    targetRate: 20,
    minStudents: 2,
    maxStudents: 8,
    status: 'draft',
  });
  return cls.id;
}

describe('the archive race door 1 used to lose (#339)', () => {
  // The counts in `setTeacherRoomArchived` are read before its write, so a
  // class published in another tab between them was invisible to them —
  // the KNOWN-OPEN this issue closed: without the constraint, the archive
  // succeeded and left an archived room holding an `open` class.
  it('refuses an archive when a class is published mid-request', async () => {
    const linkId = await makeOpenRoom();
    const classId = await makeDraft(linkId);

    // A: publish the class, then hold the transaction open.
    let publishCommittedAt = 0;
    const publishing = a
      .$transaction(async (tx) => {
        await tx.class.updateMany({ where: { id: classId }, data: { status: 'open' } });
        await new Promise((r) => setTimeout(r, 1500));
      })
      .then(() => { publishCommittedAt = Date.now(); });

    // B: archive the room from the other connection, mid-flight.
    await new Promise((r) => setTimeout(r, 500));
    let archiveSettledAt = 0;
    const archive = setTeacherRoomArchived(b, linkId, teacherId, 'archived').finally(() => {
      archiveSettledAt = Date.now();
    });

    const [, result] = await Promise.all([publishing, archive]);

    expect(result).toMatchObject({ ok: false, reason: 'in_use' });
    expect(result).toMatchObject({ blockers: { classes: 1 } });
    // The archive WAITED for the publish rather than racing past it. Without
    // the wait this is what fails, and the wait is the whole property: a
    // check that merely read the room would have passed and then been wrong.
    expect(archiveSettledAt).toBeGreaterThanOrEqual(publishCommittedAt);

    // The one that matters: the archive rolled back, not merely reported.
    const room = await a.teacherRoom.findUniqueOrThrow({ where: { id: linkId } });
    expect(room.isArchived).toBe(false);
  }, 20_000);
});

describe("the publish race door 2's catch had never been driven through (#339)", () => {
  // The mirror image: there the class moved under the archive, here the room
  // moves under the publish. `transitionClass` reads `teacherRoom.isArchived`
  // outside its transaction, so an archive committing after that read and
  // before the CAS was invisible to it — until `Class_live_needs_open_room`
  // closed the window from the database side.
  it('refuses a publish when the room archives mid-transition', async () => {
    const linkId = await makeOpenRoom();
    const classId = await makeDraft(linkId);

    // A: archive the room, then hold the transaction open.
    let archiveCommittedAt = 0;
    const archiving = a
      .$transaction(async (tx) => {
        await tx.teacherRoom.update({ where: { id: linkId }, data: { isArchived: true } });
        await new Promise((r) => setTimeout(r, 1500));
      })
      .then(() => { archiveCommittedAt = Date.now(); });

    // B: publish the class from the other connection, mid-flight.
    await new Promise((r) => setTimeout(r, 500));
    let publishSettledAt = 0;
    const publish = transitionClass(b, classId, 'open').finally(() => {
      publishSettledAt = Date.now();
    });

    const [, result] = await Promise.all([archiving, publish]);

    expect(result).toMatchObject({ ok: false, reason: 'ROOM_ARCHIVED' });
    // The publish WAITED for the archive rather than racing past it — proof
    // that this ran the CAS's own catch (`class-lifecycle.ts`), not the
    // pre-check, which would have read the room's pre-archive value and
    // answered immediately instead of blocking on the archive's held lock.
    expect(publishSettledAt).toBeGreaterThanOrEqual(archiveCommittedAt);

    // The one that matters: never actually published.
    const cls = await a.class.findUniqueOrThrow({ where: { id: classId } });
    expect(cls.status).toBe('draft');
  }, 20_000);
});
