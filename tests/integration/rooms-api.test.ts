/**
 * /api/rooms/[id] — the public-room lock, on both mutating verbs.
 *
 * `isPublic` is checked BEFORE `createdById` in both PUT and DELETE, so a
 * public room is read-only AND undeletable for everyone — including its own
 * creator. Deliberate (#52/#60: public rooms are community property and the
 * creator may have left the platform; an admin surface will eventually mediate
 * changes), but surprising enough that a future reordering could look like a
 * bug fix while silently reversing that decision.
 *
 * Each describe block below carries its own note on which of its cases pins
 * the *ordering* versus which pins the *product decision* — they are not the
 * same case, and only one of them can detect a guard swap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let creatorId: string;
let creatorAccountId: string;
let creatorToken: string;
let otherTeacherId: string;
let otherAccountId: string;
let otherToken: string;
let roomId: string;

// DELETE fixtures — one room per case. A successful delete destroys its room,
// so these cannot share one room the way the PUT cases do; dedicated rooms
// also mean no DELETE case depends on another having run first.
let deletePublicRoomId: string;
let deletePrivateRoomId: string;
let deleteWithClassRoomId: string;
let deleteEmptyRoomId: string;
let deleteClassId: string;
// #77: a room carrying TWO TeacherRooms, where only the OTHER teacher's has a
// class. Every other fixture here gives a room exactly one TeacherRoom owned by
// the deleting teacher, which is what left the cross-teacher guard unpinned.
let deleteCrossTeacherRoomId: string;
let crossTeacherClassId: string;

function put(token: string, id: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/rooms/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...cookie(token),
    },
    body: JSON.stringify(body),
  });
}

function del(token: string, id: string) {
  return fetch(`${BASE_URL}/api/rooms/${id}`, {
    method: 'DELETE',
    headers: cookie(token),
  });
}

// Local fixture helper — of exactly the shape classes-api.test.ts's own
// makeTeacher(tag) already uses. Binds the email literal once instead of
// repeating it for the teacher and its nested account.
async function makeTeacher(
  tag: string,
): Promise<{ id: string; accountId: string; token: string }> {
  const email = `roomsapi-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Rooms API tests',
      pageSlug: `roomsapi-${tag}-${suffix}`,
    },
  });
  const token = await seedSession(prisma, teacher.accountId);
  return { id: teacher.id, accountId: teacher.accountId, token };
}

beforeAll(async () => {
  await prisma.$connect();

  const creator = await makeTeacher('creator');
  creatorId = creator.id;
  creatorAccountId = creator.accountId;
  creatorToken = creator.token;

  const other = await makeTeacher('other');
  otherTeacherId = other.id;
  otherAccountId = other.accountId;
  otherToken = other.token;

  // Local fixture helper — the five rooms below share every field except
  // roomName and isPublic. Declared here so it closes over the creator's id
  // rather than reading it back off a module-level let.
  function makeRoom(roomName: string, isPublic: boolean) {
    return prisma.room.create({
      data: {
        venueName: 'Rooms API Studio',
        address: `${suffix} Rooms St`,
        city: 'Testville',
        postcode: '1234RA',
        floor: '1',
        roomName,
        maxCapacity: 10,
        createdById: creator.id,
        isPublic,
      },
    });
  }

  // Room.isPublic defaults to true (the `isPublic` field in prisma/schema.prisma)
  // — passed explicitly throughout, since these fixtures depend on the value.
  const room = await makeRoom('Main', false);
  roomId = room.id;

  // -- DELETE fixtures ----------------------------------------------------
  // Public: serves BOTH public DELETE cases — neither one destroys it.
  const deletePublicRoom = await makeRoom('Delete Public', true);
  deletePublicRoomId = deletePublicRoom.id;

  // Private, no teacher-rooms: the non-creator 403. Kept separate from the
  // happy-path room, which gets destroyed.
  const deletePrivateRoom = await makeRoom('Delete Private', false);
  deletePrivateRoomId = deletePrivateRoom.id;

  // Private, with a TeacherRoom that has a class: the hasClasses 400.
  const deleteWithClassRoom = await makeRoom('Delete With Class', false);
  deleteWithClassRoomId = deleteWithClassRoom.id;
  const withClassTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: creator.id, roomId: deleteWithClassRoomId, capacityOverride: 8, rentalRate: 15 },
  });
  const blockingClass = await prisma.class.create({
    data: {
      teacherId: creator.id,
      teacherRoomId: withClassTeacherRoom.id,
      classType: 'Rooms API Delete Guard',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'draft',
    },
  });
  deleteClassId = blockingClass.id;

  // Private, with a TeacherRoom but NO classes: the 200. The TeacherRoom is
  // deliberate — a room with none would make the cleanup assertion vacuous.
  const deleteEmptyRoom = await makeRoom('Delete Empty', false);
  deleteEmptyRoomId = deleteEmptyRoom.id;
  await prisma.teacherRoom.create({
    data: { teacherId: creator.id, roomId: deleteEmptyRoomId, capacityOverride: 8, rentalRate: 15 },
  });

  // Private, created by `creator`, shared with `other` (#77). The creator's own
  // TeacherRoom is class-free; the other teacher's carries the only class. So
  // the ONLY thing that can block the creator's delete is a guard that looks
  // beyond their own teacher-rooms.
  const crossRoom = await makeRoom('Delete Cross Teacher', false);
  deleteCrossTeacherRoomId = crossRoom.id;
  await prisma.teacherRoom.create({
    data: { teacherId: creator.id, roomId: deleteCrossTeacherRoomId, capacityOverride: 8, rentalRate: 15 },
  });
  const otherTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: other.id, roomId: deleteCrossTeacherRoomId, capacityOverride: 8, rentalRate: 22 },
  });
  const crossClass = await prisma.class.create({
    data: {
      teacherId: other.id,
      teacherRoomId: otherTeacherRoom.id,
      classType: 'Rooms API Cross Teacher Guard',
      date: new Date('2099-06-01'),
      startTime: '10:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'draft',
    },
  });
  crossTeacherClassId = crossClass.id;
});

afterAll(async () => {
  // FK order: class -> teacher-rooms -> rooms. Class.teacherRoom is a required
  // relation defaulting to Restrict, so the class must go first or the
  // teacher-room delete throws.
  const classIds = [deleteClassId, crossTeacherClassId].filter(Boolean);
  if (classIds.length > 0) {
    await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  }
  const roomIds = [
    roomId,
    deletePublicRoomId,
    deletePrivateRoomId,
    deleteWithClassRoomId,
    deleteEmptyRoomId,
    deleteCrossTeacherRoomId,
  ].filter(Boolean);
  if (roomIds.length > 0) {
    await prisma.teacherRoom.deleteMany({ where: { roomId: { in: roomIds } } });
    // deleteMany, not delete: the happy-path case already removed one of these
    // rooms, and deleteMany no-ops over a missing row where delete would throw.
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  }
  const accountIds = [creatorAccountId, otherAccountId].filter(Boolean);
  if (accountIds.length > 0) {
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  }
  const teacherIds = [creatorId, otherTeacherId].filter(Boolean);
  if (teacherIds.length > 0) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  if (accountIds.length > 0) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

/**
 * These four cases cover the full 2x2 of {creator, non-creator} x {private,
 * public}, but they don't split evenly by what they prove:
 *   - creator+public pins the *product decision* — a public room is
 *     read-only even for its own creator (see #52/#60).
 *   - non-creator+public pins the *guard ordering*. It is the only
 *     combination whose message differs when the two guards are swapped:
 *     current order (isPublic first) says "Public rooms cannot be edited";
 *     swapped (createdById first) says "Only the room creator can update
 *     this room". The other three cases return the same message under either
 *     ordering — creator+private and non-creator+private never reach the
 *     isPublic guard's alternate message, and creator+public passes the
 *     createdById guard as a no-op either way it's ordered.
 *
 * All four cases share one room and run in declaration order — the isPublic
 * flip (third case) is one-way, so any case declared below it inherits a
 * public room.
 */
describe('PUT /api/rooms/[id]', () => {
  it('creator edits their own private room -> 200, the change persists', async () => {
    const res = await put(creatorToken, roomId, { venueName: 'Rooms API Studio (Updated)' });
    expect(res.status).toBe(200);

    const updated = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(updated.venueName).toBe('Rooms API Studio (Updated)');
    expect(updated.isPublic).toBe(false);
  });

  it('a non-creator is rejected from a private room — creator-only message', async () => {
    const before = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

    const res = await put(otherToken, roomId, { venueName: 'Should not apply' });
    expect(res.status).toBe(403);

    // The createdById guard's own message (rooms/[id]/route.ts:82).
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Only the room creator can update this room');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(after.venueName).toBe(before.venueName);
  });

  it('the same creator is rejected once the room is public — pins the product decision', async () => {
    // Fixture state, not the invariant under test — flipped directly so the
    // only thing that changes between this case and the first is isPublic.
    await prisma.room.update({ where: { id: roomId }, data: { isPublic: true } });
    const before = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

    const res = await put(creatorToken, roomId, { venueName: 'Should not apply either' });
    expect(res.status).toBe(403);

    // The isPublic guard (rooms/[id]/route.ts:78) fires before the createdById
    // guard (:82), even for the room's own creator. This alone doesn't pin the
    // guard *ordering* though — see the file header: with the creator as actor,
    // the createdById guard is a no-op under either ordering, so this case
    // would return the same message if the guards were swapped. What it pins
    // is the product decision that a public room is read-only for its creator.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Public rooms cannot be edited');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(after.venueName).toBe(before.venueName);
    expect(after.isPublic).toBe(true);
  });

  it('a non-creator is rejected from the same public room — this is what actually pins the ordering', async () => {
    // The room is already public from the previous case; declared after it
    // deliberately (see the file header — the isPublic flip is one-way). No
    // new fixture needed.
    const before = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(before.isPublic).toBe(true);

    const res = await put(otherToken, roomId, { venueName: 'Should not apply either' });
    expect(res.status).toBe(403);

    // Current order: the isPublic guard (route.ts:77-79) fires first, so this
    // is "Public rooms cannot be edited" — NOT the createdById guard's "Only
    // the room creator..." message. Swap the two guards and this message
    // flips, because unlike the creator, a non-creator doesn't pass the
    // createdById guard as a no-op. This is the only one of the four cases
    // whose outcome depends on guard order.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Public rooms cannot be edited');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(after.venueName).toBe(before.venueName);
  });
});

/**
 * DELETE has THREE ordered guards, not two: isPublic -> createdById ->
 * hasClasses. That is two adjacent pairs, and each needs its own
 * discriminating case. Both follow the same rule: a creator always *passes*
 * the createdById guard, so no creator-held case can detect a swap involving
 * it. Only a non-creator can.
 *
 *   - creator+public pins the *product decision* — a public room can't be
 *     deleted even by its creator. It cannot detect any swap.
 *   - non-creator+public pins the isPublic <-> createdById order. Current
 *     order says "Public rooms cannot be deleted"; swapped, it says "Only the
 *     room creator can delete this room".
 *   - non-creator+private+has-classes pins the createdById <-> hasClasses
 *     order. Current order says "Only the room creator can delete this room";
 *     swapped, it says "Cannot delete a room that has classes" with a 400 —
 *     which would leak to a stranger whether a room they don't own has
 *     classes on it.
 *
 * Both pairs were verified by mutation, not by argument: swapping each pair
 * in the handler fails exactly the one case named above and nothing else.
 * The second pair was found unpinned in review AFTER the first was fixed —
 * proof that reasoning about one pair says nothing about its neighbour.
 *
 * Unlike the PUT block, each case here owns its room — a successful delete
 * destroys one, so shared mutable state would make the cases order-dependent.
 * The two 403-only cases that share a room are safe: neither writes.
 */
describe('DELETE /api/rooms/[id]', () => {
  it('a non-creator is rejected from a public room — this is what actually pins the ordering', async () => {
    const res = await del(otherToken, deletePublicRoomId);
    expect(res.status).toBe(403);

    // The isPublic guard's message, NOT the createdById guard's. Swapping the
    // two guards in the handler flips this string — see the block comment.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Public rooms cannot be deleted');

    expect(await prisma.room.count({ where: { id: deletePublicRoomId } })).toBe(1);
  });

  it('the creator is rejected from their own public room — pins the product decision', async () => {
    const res = await del(creatorToken, deletePublicRoomId);
    expect(res.status).toBe(403);

    // This case can't detect a guard swap (the creator passes the createdById
    // guard either way). What it pins is that a public room is undeletable by
    // the person who created it — deliberate, see the file header.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Public rooms cannot be deleted');

    expect(await prisma.room.count({ where: { id: deletePublicRoomId } })).toBe(1);
  });

  it('a non-creator is rejected from a private room — creator-only message', async () => {
    const res = await del(otherToken, deletePrivateRoomId);
    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Only the room creator can delete this room');

    expect(await prisma.room.count({ where: { id: deletePrivateRoomId } })).toBe(1);
  });

  it('the creator cannot delete a room that still has classes -> 400, nothing removed', async () => {
    const res = await del(creatorToken, deleteWithClassRoomId);
    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Cannot delete a room that has classes');

    // Both counts are here for the same reason every non-200 case in this file
    // asserts the DB is unchanged — not because a missing guard could orphan
    // the teacher-room. It couldn't: the class that makes hasClasses true is
    // the same row whose Restrict relation makes the handler's
    // teacherRoom.deleteMany throw, and that throw is atomic, so the row
    // survives. Drop the guard and this is a 500 (withErrorHandler maps only
    // P2002 to a status of its own), which the assertion above catches first.
    expect(await prisma.room.count({ where: { id: deleteWithClassRoomId } })).toBe(1);
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteWithClassRoomId } })).toBe(1);
  });

  it('a non-creator is rejected from a private room that has classes — pins the second guard pair', async () => {
    // Reuses the has-classes room deliberately: it is the ONLY fixture whose
    // state can tell createdById-first from hasClasses-first apart. The two
    // cases either side of this one can't — the creator passes createdById as
    // a no-op, and a room with no classes never reaches hasClasses at all.
    const res = await del(otherToken, deleteWithClassRoomId);
    expect(res.status).toBe(403);

    // Ownership loses to nothing here. Swap createdById and hasClasses and
    // this becomes 400 "Cannot delete a room that has classes" — telling a
    // stranger something about a private room they have no business knowing.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Only the room creator can delete this room');

    expect(await prisma.room.count({ where: { id: deleteWithClassRoomId } })).toBe(1);
  });

  // #77. Every other fixture in this file gives a room exactly one TeacherRoom,
  // owned by whoever is deleting — so a narrowing "fix" like
  //
  //     const hasClasses = room.teacherRooms
  //       .filter((tr) => tr.teacherId === session.teacherId)
  //       .some((tr) => tr._count.classes > 0);
  //
  // would pass this entire suite while letting teacher A delete a room out from
  // under teacher B, cascading away B's TeacherRoom and orphaning B's classes.
  // (In practice Restrict turns that into a 500 rather than silent data loss —
  // still a production bug on a routine action.) This is the only case where
  // the blocking class belongs to someone other than the caller, so it is the
  // only one that can detect that change.
  it("another teacher's class blocks the creator's delete — the guard is deliberately cross-teacher", async () => {
    const res = await del(creatorToken, deleteCrossTeacherRoomId);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Cannot delete a room that has classes');

    // Nothing removed — including the other teacher's link and its class.
    expect(await prisma.room.count({ where: { id: deleteCrossTeacherRoomId } })).toBe(1);
    expect(
      await prisma.teacherRoom.count({ where: { roomId: deleteCrossTeacherRoomId } }),
    ).toBe(2);
    expect(await prisma.class.count({ where: { id: crossTeacherClassId } })).toBe(1);
  });

  it('the creator deletes a private, class-free room -> 200, room and teacher-rooms gone', async () => {
    // Premise: the room really does carry a teacher-room, or the cleanup
    // assertion below would pass vacuously.
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteEmptyRoomId } })).toBe(1);

    const res = await del(creatorToken, deleteEmptyRoomId);
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: { deleted: boolean } };
    expect(json.data.deleted).toBe(true);

    // TeacherRoom.room is declared onDelete: Cascade, so these rows would go
    // with the room even without the handler's explicit deleteMany. This pins
    // the observable outcome — no orphan teacher-rooms survive a room delete —
    // not that specific line of the handler.
    expect(await prisma.room.count({ where: { id: deleteEmptyRoomId } })).toBe(0);
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteEmptyRoomId } })).toBe(0);
  });
});

/**
 * `Room_public_identity_unique` on `(address, floor, roomName)` WHERE
 * `isPublic = true`, and `Room_private_identity_unique` on `(createdById,
 * address, floor, roomName)` WHERE `isPublic = false` (#196). Route change is
 * `src/app/api/rooms/route.ts`: a try/catch around `prisma.room.create` maps
 * a P2002 on either index to `DUPLICATE_ROOM`, same code and same message on
 * both branches as before. No `findFirst` pre-check in front of either — the
 * route's own comment explains why one would only make the catch reachable
 * under a race. That is also why this block carries its own sequential
 * public-duplicate case rather than leaning on the concurrent one alone: the
 * concurrent case can't tell "the catch fired" apart from "a guard resolved
 * it before either create ran", but a plain sequential duplicate can only
 * ever reach the catch.
 *
 * A distinct address/floor from every fixture above (`${suffix} Rooms St`,
 * floor '1') so this block's rows never share an index tuple with them.
 */
describe('POST /api/rooms dedupes both branches (#196)', () => {
  const slotAddress = `${suffix} Slot Street 1`;

  const roomBody = (over: Record<string, unknown> = {}) => ({
    venueName: 'Slot Venue',
    address: slotAddress,
    city: 'Amsterdam',
    postcode: '1011 AB',
    floor: '2',
    roomName: 'Back',
    maxCapacity: 12,
    equipment: [],
    isPublic: true,
    ...over,
  });
  const post = (body: unknown, token: string) =>
    fetch(`${BASE_URL}/api/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    });

  // Scoped to this block's own address, so it can run before the top-level
  // afterAll without touching any fixture declared in the outer beforeAll.
  afterAll(async () => {
    await prisma.room.deleteMany({ where: { address: slotAddress } });
  });

  it('rejects a second identical PRIVATE room from the same teacher', async () => {
    const body = roomBody({ isPublic: false, roomName: 'PrivateBack' });
    expect((await post(body, creatorToken)).status).toBe(201);
    const second = await post(body, creatorToken);
    expect(second.status).toBe(409);
    const json = (await second.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('DUPLICATE_ROOM');
    // The private and public 409s share a code — the message is the only
    // thing that tells them apart, and it also names the way out (#196 PR
    // review, D3): `floor`/`roomName` both default to `""`, so two genuinely
    // different rooms at one address, both left blank, land here too.
    expect(json.error.message).toBe(
      'You already have a room at this address. Add a floor or room name to tell them apart.',
    );
  });

  it('still lets a DIFFERENT teacher keep their own private room at that address', async () => {
    const body = roomBody({ isPublic: false, roomName: 'PrivateBack' });
    expect((await post(body, otherToken)).status).toBe(201);
  });

  // With no pre-check in front of the public branch, this is the only case
  // that pins the catch deterministically — the second create has nowhere
  // else to be rejected from.
  it('rejects a second identical PUBLIC room — sequential, no pre-check to catch it first', async () => {
    const body = roomBody({ roomName: 'SequentialPublic' });
    expect((await post(body, creatorToken)).status).toBe(201);
    const second = await post(body, creatorToken);
    expect(second.status).toBe(409);
    const json = (await second.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('DUPLICATE_ROOM');
    // Same message the pre-check used to return — deleting it must not
    // change a single byte a client sees.
    expect(json.error.message).toBe('A public room at this address already exists');
  });

  it('leaves one row when two identical PUBLIC creates are in flight at once', async () => {
    const body = roomBody({ roomName: 'RaceRoom' });
    const [a, b] = await Promise.all([post(body, creatorToken), post(body, creatorToken)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    // Either request can win the race, so the loser is identified rather
    // than assumed — this is what makes the assertion below able to fail
    // when a route branch is broken, unlike the status/row-count pair alone.
    const loser = a.status === 409 ? a : b;
    expect((await loser.json()).error.code).toBe('DUPLICATE_ROOM');

    const rows = await prisma.room.findMany({
      where: { isPublic: true, address: slotAddress, floor: '2', roomName: 'RaceRoom' },
    });
    expect(rows).toHaveLength(1);
  });
});

/**
 * Task 6b (#196). The six indexes constrain every write, not just creates:
 * `PUT /api/rooms/[id]` never touches a currently-public room (the guard
 * above already refuses it), but `updateRoomSchema` still accepts `isPublic`,
 * so a private room's own edit can collide on either identity index —
 * `Room_private_identity_unique` if it stays private, or
 * `Room_public_identity_unique` if the same edit flips it public.
 */
describe('PUT /api/rooms/[id] collides on the slot key (#196)', () => {
  const slotAddress = `${suffix} PUT Slot Street`;

  afterAll(async () => {
    await prisma.room.deleteMany({ where: { address: slotAddress } });
  });

  it("refuses an address/floor/roomName change onto a slot another of the creator's private rooms already holds", async () => {
    const occupied = await prisma.room.create({
      data: {
        venueName: 'PUT Slot Venue',
        address: slotAddress,
        city: 'Amsterdam',
        postcode: '1011 AB',
        floor: '3',
        roomName: 'Occupied',
        maxCapacity: 10,
        createdById: creatorId,
        isPublic: false,
      },
    });
    const mover = await prisma.room.create({
      data: {
        venueName: 'PUT Slot Venue',
        address: slotAddress,
        city: 'Amsterdam',
        postcode: '1011 AB',
        floor: '3',
        roomName: 'Mover',
        maxCapacity: 10,
        createdById: creatorId,
        isPublic: false,
      },
    });

    const res = await put(creatorToken, mover.id, { roomName: 'Occupied' });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('DUPLICATE_ROOM');
    // Same message the POST arm above pins — the PUT catch shares its wording.
    expect(json.error.message).toBe(
      'You already have a room at this address. Add a floor or room name to tell them apart.',
    );

    const after = await prisma.room.findUniqueOrThrow({ where: { id: mover.id } });
    expect(after.roomName).toBe('Mover');

    // The test's premise is that this row is the one occupying the slot the
    // rename collided on, and that it is untouched by the failed move —
    // assert that rather than discarding the reference, so a route that
    // clobbered the wrong row would fail this test.
    const stillOccupied = await prisma.room.findUniqueOrThrow({ where: { id: occupied.id } });
    expect(stillOccupied.roomName).toBe('Occupied');
  });

  // The two rows coexist fine at creation: `Room_private_identity_unique`
  // scopes on `createdById`, so a different creator's private room and a
  // public room can share an identity — it is only the flip to `isPublic:
  // true` that puts the private room in the same index as the public one.
  it('refuses flipping a private room public onto a slot a public room already holds', async () => {
    const publicRoom = await prisma.room.create({
      data: {
        venueName: 'PUT Slot Venue',
        address: slotAddress,
        city: 'Amsterdam',
        postcode: '1011 AB',
        floor: '4',
        roomName: 'PublicHolder',
        maxCapacity: 10,
        createdById: otherTeacherId,
        isPublic: true,
      },
    });
    const privateRoom = await prisma.room.create({
      data: {
        venueName: 'PUT Slot Venue',
        address: slotAddress,
        city: 'Amsterdam',
        postcode: '1011 AB',
        floor: '4',
        roomName: 'PublicHolder',
        maxCapacity: 10,
        createdById: creatorId,
        isPublic: false,
      },
    });

    const res = await put(creatorToken, privateRoom.id, { isPublic: true });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('DUPLICATE_ROOM');
    expect(json.error.message).toBe('A public room at this address already exists');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: privateRoom.id } });
    expect(after.isPublic).toBe(false);

    // The test's premise is that this row is the public room occupying the
    // slot the flip collided on, and that it is untouched by the failed
    // flip — assert that rather than discarding the reference, so a route
    // that clobbered the wrong row would fail this test.
    const stillPublic = await prisma.room.findUniqueOrThrow({ where: { id: publicRoom.id } });
    expect(stillPublic.isPublic).toBe(true);
  });
});
