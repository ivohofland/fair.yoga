/**
 * `/api/teacher-rooms` — the first HTTP coverage this route group has had (#53).
 *
 * `TeacherRoom` holds the teacher's private rental rate, which CLAUDE.md says is
 * "never shared between teachers", so the ownership chain on `[id]` is
 * money-adjacent and cross-tenant rather than a routine guard. That, plus the
 * two state guards (the create-side answer to an existing link and the
 * delete-side class history 409), is what earns tests here: per
 * `docs/technical-architecture.md`,
 * a route gets its own HTTP guard test when its authorization is *bespoke* or it
 * carries a *business invariant*, not for re-testing the shared
 * `requireTeacher` helper on every verb.
 *
 * Deliberately NOT covered: that any authenticated teacher may create a
 * `TeacherRoom` for a room they neither created nor can see. That is the open
 * half of #77 — the issue calls it "plausibly intentional" and asks whether
 * attaching to a private room should be allowed at all. Pinning it now would
 * dress an undecided question as settled behaviour; it gets a test with the
 * decision, in whichever direction that goes.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let ownerId: string;
let ownerAccountId: string;
let ownerToken: string;
let otherId: string;
let otherAccountId: string;
let otherToken: string;

let roomId: string;
/** The owner's link — the subject of the ownership and update cases. */
let linkId: string;
/** A second link, with a class on it, for the delete guard. */
let linkWithClassId: string;
let blockingClassId: string;
/**
 * A third link, with an `open` class — `blockingClassId`'s class is `draft`,
 * which does not block archiving (see `BLOCKING_CLASS_STATUSES`), so it can't
 * stand in for the archive-guard tests.
 */
let linkWithOpenClassId: string;
/** Free PRIVATE room owned by `owner`, with no link yet — the create cases claim it. */
let freeRoomId: string;
/** Public room: usable by anyone, which is the whole point of public. */
let publicRoomId: string;
/** Private room owned by `other` — the one `owner` must not be able to claim. */
let othersPrivateRoomId: string;
/** A link whose only reference is an ARCHIVED template — the 500 reproducer. */
let linkWithArchivedTemplateId: string;
/** A link whose only reference is a LIVE template. */
let linkWithLiveTemplateId: string;

const ORIGINAL_RATE = 25;

async function makeTeacher(tag: string) {
  const email = `trapi-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Link',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Teacher-rooms API tests',
      pageSlug: `trapi-${tag}-${suffix}`,
    },
  });
  return {
    id: teacher.id,
    accountId: teacher.accountId,
    token: await seedSession(prisma, teacher.accountId),
  };
}

const create = (token: string, body: unknown) =>
  fetch(`${BASE_URL}/api/teacher-rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    body: JSON.stringify(body),
  });

const send = (method: string, token: string, id: string, body?: unknown) =>
  fetch(`${BASE_URL}/api/teacher-rooms/${id}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/**
 * A private room of the owner's with no link on it, one per case, so no
 * create case depends on another's link. `roomName` keeps the private
 * identity key distinct.
 */
async function freshRoom(roomName: string): Promise<string> {
  const room = await prisma.room.create({
    data: {
      venueName: 'Teacher Rooms API Studio',
      address: `${suffix} Retry St`,
      city: 'Testville',
      postcode: '1234TR',
      floor: '1',
      roomName,
      maxCapacity: 10,
      createdById: ownerId,
      isPublic: false,
    },
  });
  return room.id;
}

beforeAll(async () => {
  await prisma.$connect();

  const owner = await makeTeacher('owner');
  ownerId = owner.id;
  ownerAccountId = owner.accountId;
  ownerToken = owner.token;

  const other = await makeTeacher('other');
  otherId = other.id;
  otherAccountId = other.accountId;
  otherToken = other.token;

  const makeRoom = (roomName: string) =>
    prisma.room.create({
      data: {
        venueName: 'Teacher Rooms API Studio',
        address: `${suffix} Link St`,
        city: 'Testville',
        postcode: '1234TR',
        floor: '1',
        roomName,
        maxCapacity: 10,
        createdById: owner.id,
        isPublic: false,
      },
    });

  roomId = (await makeRoom('Main')).id;
  freeRoomId = (await makeRoom('Unclaimed')).id;

  publicRoomId = (
    await prisma.room.create({
      data: {
        venueName: 'Teacher Rooms API Studio',
        address: `${suffix} Public St`,
        city: 'Testville',
        postcode: '1234TP',
        floor: '1',
        roomName: 'Community Hall',
        maxCapacity: 20,
        createdById: owner.id,
        isPublic: true,
      },
    })
  ).id;

  othersPrivateRoomId = (
    await prisma.room.create({
      data: {
        venueName: 'Other Teacher Studio',
        address: `${suffix} Other St`,
        city: 'Testville',
        postcode: '5678TR',
        floor: '2',
        roomName: 'Private Back Room',
        maxCapacity: 10,
        createdById: other.id,
        isPublic: false,
      },
    })
  ).id;

  linkId = (
    await prisma.teacherRoom.create({
      data: { teacherId: ownerId, roomId, capacityOverride: 8, rentalRate: ORIGINAL_RATE },
    })
  ).id;

  const roomWithClass = await makeRoom('With Class');
  const linkWithClass = await prisma.teacherRoom.create({
    data: { teacherId: ownerId, roomId: roomWithClass.id, capacityOverride: 8, rentalRate: 15 },
  });
  linkWithClassId = linkWithClass.id;
  blockingClassId = (
    await createClassFixture(prisma, {
        teacherId: ownerId,
        teacherRoomId: linkWithClass.id,
        classType: 'Teacher Rooms API Delete Guard',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'draft',
      })
  ).id;

  const roomWithOpenClass = await makeRoom('With Open Class');
  const linkWithOpenClass = await prisma.teacherRoom.create({
    data: {
      teacherId: ownerId,
      roomId: roomWithOpenClass.id,
      capacityOverride: 8,
      rentalRate: 15,
    },
  });
  linkWithOpenClassId = linkWithOpenClass.id;
  await createClassFixture(prisma, {
      teacherId: ownerId,
      teacherRoomId: linkWithOpenClass.id,
      classType: 'Teacher Rooms API Archive Guard',
      date: new Date('2099-06-01'),
      startTime: hhmmToTime('11:00'),
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'open',
    });

  const archivedTemplateRoom = await makeRoom('Archived Template');
  const archivedTemplateLink = await prisma.teacherRoom.create({
    data: { teacherId: ownerId, roomId: archivedTemplateRoom.id, capacityOverride: 8, rentalRate: 15 },
  });
  linkWithArchivedTemplateId = archivedTemplateLink.id;
  await prisma.classTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId: ownerId,
          kind: 'regular',
          classType: 'Teacher Rooms Delete Guard',
          dayOfWeek: 2,
          startTime: hhmmToTime('18:00'),
          durationMinutes: 60,
          isActive: false,
          isArchived: true,
        },
      },
      teacherRoom: { connect: { id: archivedTemplateLink.id } },
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
    },
  });

  const liveTemplateRoom = await makeRoom('Live Template');
  const liveTemplateLink = await prisma.teacherRoom.create({
    data: { teacherId: ownerId, roomId: liveTemplateRoom.id, capacityOverride: 8, rentalRate: 15 },
  });
  linkWithLiveTemplateId = liveTemplateLink.id;
  await prisma.classTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId: ownerId,
          kind: 'regular',
          classType: 'Teacher Rooms Delete Guard Live',
          dayOfWeek: 3,
          startTime: hhmmToTime('19:00'),
          durationMinutes: 60,
          isActive: true,
          isArchived: false,
        },
      },
      teacherRoom: { connect: { id: liveTemplateLink.id } },
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
    },
  });
});

afterAll(async () => {
  // FK order: class → classTemplate → teacherRoom → room. Both Class and
  // ClassTemplate.teacherRoom are Restrict, so both must go first.
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: [ownerId, otherId] } } });
  // `ClassTemplate` is `onDelete: Cascade` from `ScheduleRule` (issue 298),
  // so deleting the rules removes the templates before the teacher-room
  // delete below — same ordering requirement, re-pointed.
  await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: [ownerId, otherId] } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: [ownerId, otherId] } } });
  await prisma.room.deleteMany({ where: { createdById: { in: [ownerId, otherId] } } });
  await prisma.session.deleteMany({
    where: { accountId: { in: [ownerAccountId, otherAccountId] } },
  });
  await prisma.teacher.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await prisma.account.deleteMany({ where: { id: { in: [ownerAccountId, otherAccountId] } } });
  await prisma.$disconnect();
});

describe('POST /api/teacher-rooms', () => {
  // Ride-along, not a ladder: the shared guard is covered once in
  // src/lib/api-utils.test.ts.
  it('rejects an unauthenticated create', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-rooms`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('links a teacher to a room, and answers an identical second request as unchanged', async () => {
    const body = { roomId: freeRoomId, capacityOverride: 6, rentalRate: 18 };

    const created = (await expectApplied(await create(ownerToken, body), 201)) as {
      id: string;
      rentalRate: string;
    };
    expect(created.id).toBeTruthy();
    const before = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });

    // A retry after a lost response: the link it asked for is already there,
    // holding these values.
    const unchanged = (await expectUnchanged(await create(ownerToken, body))) as { id: string };
    expect(unchanged.id).toBe(created.id);

    expect(await prisma.teacherRoom.count({ where: { roomId: freeRoomId } })).toBe(1);
    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  // The uniqueness is per (teacher, room), so two teachers CAN hold the same
  // room — but only where they are both entitled to it. #77 settled that as
  // public rooms only: this assertion used to live on a private room, which
  // the visibility guard now forbids.
  it('two teachers can hold the same PUBLIC room, each with their own rate', async () => {
    const first = await create(ownerToken, {
      roomId: publicRoomId,
      capacityOverride: 10,
      rentalRate: 20,
    });
    expect(first.status).toBe(201);

    const second = await create(otherToken, {
      roomId: publicRoomId,
      capacityOverride: 10,
      rentalRate: 99,
    });
    expect(second.status).toBe(201);

    // It is the rate that is private, not the association.
    const links = await prisma.teacherRoom.findMany({ where: { roomId: publicRoomId } });
    expect(links).toHaveLength(2);
    expect(new Set(links.map((l) => Number(l.rentalRate)))).toEqual(new Set([20, 99]));
  });

  // #77's second half. The rule is not new — `GET /api/rooms/[id]` already
  // reads "public, or created by you"; the create route simply never applied
  // it, so any teacher could attach to a private room whose id they knew and,
  // by adding a class, permanently block its creator from deleting it.
  it("refuses to link a teacher to another teacher's private room", async () => {
    const res = await create(ownerToken, {
      roomId: othersPrivateRoomId,
      capacityOverride: 5,
      rentalRate: 10,
    });

    expect(res.status).toBe(403);
    expect(await prisma.teacherRoom.count({ where: { roomId: othersPrivateRoomId } })).toBe(0);
  });

  it('answers NOT_FOUND for a room that does not exist, instead of failing on the foreign key', async () => {
    const res = await create(ownerToken, {
      roomId: '00000000-0000-0000-0000-000000000000',
      capacityOverride: 5,
      rentalRate: 10,
    });
    await expectRefusal(res, 'NOT_FOUND');
  });

  it('answers a retry whose rate carries more decimals than the column keeps as unchanged', async () => {
    const roomId = await freshRoom('Retry Decimals');
    const body = { roomId, capacityOverride: 6, rentalRate: 12.344 };

    const created = (await expectApplied(await create(ownerToken, body), 201)) as {
      rentalRate: string;
    };
    // The column is Decimal(10, 2): what it stores is the rounded rate.
    expect(created.rentalRate).toBe('12.34');

    await expectUnchanged(await create(ownerToken, body));
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  it('answers a null note as the same request as an absent one', async () => {
    const roomId = await freshRoom('Retry Null Notes');
    await expectApplied(
      await create(ownerToken, { roomId, capacityOverride: 6, rentalRate: 18 }),
      201,
    );

    await expectUnchanged(
      await create(ownerToken, { roomId, capacityOverride: 6, rentalRate: 18, equipmentNotes: null }),
    );
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  // Not a retry: the teacher typed different values, and answering unchanged
  // would discard them.
  it.each([
    ['rate', { rentalRate: 19 }],
    ['capacity', { capacityOverride: 7 }],
    ['note', { equipmentNotes: 'Bring blocks' }],
  ] as const)('refuses a second request with a different %s, and keeps the stored link', async (field, change) => {
    const roomId = await freshRoom(`Differs ${field}`);
    const body = { roomId, capacityOverride: 6, rentalRate: 18, equipmentNotes: 'Mats provided' };
    const created = (await expectApplied(await create(ownerToken, body), 201)) as { id: string };

    await expectRefusal(await create(ownerToken, { ...body, ...change }), 'ROOM_ALREADY_LISTED');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });
    expect({
      capacityOverride: after.capacityOverride,
      rentalRate: Number(after.rentalRate),
      equipmentNotes: after.equipmentNotes,
    }).toEqual({ capacityOverride: 6, rentalRate: 18, equipmentNotes: 'Mats provided' });
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  it('refuses a request for a link the teacher has archived, even with identical values', async () => {
    const roomId = await freshRoom('Retry Archived');
    const body = { roomId, capacityOverride: 6, rentalRate: 18 };
    const created = (await expectApplied(await create(ownerToken, body), 201)) as { id: string };
    await expectApplied(await send('PATCH', ownerToken, `${created.id}?state=archived`));

    await expectRefusal(await create(ownerToken, body), 'ROOM_ARCHIVED');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.isArchived).toBe(true);
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(1);
  });

  // THE ORDERING CASE. The unchanged condition holds here (an identical live
  // link exists), so only the room access gate running first keeps this a
  // 403. Such a link can only predate #77; it is written directly because the
  // route refuses to create it.
  it("refuses a link to another teacher's private room even when an identical link already exists", async () => {
    const theirs = await prisma.room.create({
      data: {
        venueName: 'Other Teacher Studio',
        address: `${suffix} Legacy St`,
        city: 'Testville',
        postcode: '5678TR',
        floor: '1',
        roomName: 'Legacy Back Room',
        maxCapacity: 10,
        createdById: otherId,
        isPublic: false,
      },
    });
    await prisma.teacherRoom.create({
      data: { teacherId: ownerId, roomId: theirs.id, capacityOverride: 5, rentalRate: 10 },
    });

    const res = await create(ownerToken, { roomId: theirs.id, capacityOverride: 5, rentalRate: 10 });

    // The access refusal carries no code. Its status is what separates it
    // from the unchanged 200.
    expect(res.status).toBe(403);
    expect(await prisma.teacherRoom.count({ where: { roomId: theirs.id } })).toBe(1);
  });
});

describe('/api/teacher-rooms/[id] — the ownership chain', () => {
  // One case, four verbs: this is a single bespoke guard repeated, so four
  // near-identical tests would say the same thing four times. What makes it
  // worth pinning at all is the rental rate — per-teacher and, per CLAUDE.md,
  // never shared — so a hole here leaks or overwrites another teacher's
  // commercial terms rather than merely being untidy.
  it("another teacher cannot read, edit, archive or delete the owner's link", async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      // PATCH now validates `state` before the ownership lookup, so a bare
      // PATCH would 400 before ever reaching the 403 this test is pinning.
      // A valid state keeps this exercising ownership, not parsing.
      const res = await send(
        method,
        otherToken,
        method === 'PATCH' ? `${linkId}?state=archived` : linkId,
        method === 'PUT' ? { rentalRate: 1 } : undefined,
      );
      expect(res.status, `${method} should be 403`).toBe(403);
    }

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkId } });
    expect(Number(after.rentalRate)).toBe(ORIGINAL_RATE);
    expect(after.isArchived).toBe(false);
  });

  // Run before anything else in this file archives `linkId` (it starts
  // unarchived): the PATCH route reads the row by id, then checks
  // `teacherId !== session.teacherId`, THEN checks `isArchived === archiving`
  // — so this is the one request that would tell the two guards apart if
  // they were ever reordered. `?state=unarchived` names the state the row is
  // already in; every other ownership case in this file asks for a state the
  // row is NOT already in, so it cannot distinguish "ownership first" from
  // "unchanged first". Swap the two guards in the route and this becomes a
  // 200 `unchanged` that hands a non-owner the row.
  it('refuses a PATCH from another teacher even when the requested state matches what the row already is', async () => {
    const res = await send('PATCH', otherToken, `${linkId}?state=unarchived`);
    expect(res.status).toBe(403);

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(false);
  });

  it('404s an id that does not exist, before any ownership check can leak its absence', async () => {
    const res = await send('GET', ownerToken, '00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('answers NOT_FOUND to an edit, archive or delete of a link that does not exist', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await expectRefusal(await send('PUT', ownerToken, missing, { rentalRate: 1 }), 'NOT_FOUND');
    await expectRefusal(await send('PATCH', ownerToken, `${missing}?state=archived`), 'NOT_FOUND');
    await expectRefusal(await send('DELETE', ownerToken, missing), 'NOT_FOUND');
  });
});

describe('PUT /api/teacher-rooms/[id]', () => {
  it('rejects an empty payload rather than issuing a no-op write', async () => {
    const res = await send('PUT', ownerToken, linkId, {});
    expect(res.status).toBe(400);
  });

  it('updates the rate, and the change persists', async () => {
    const res = await send('PUT', ownerToken, linkId, { rentalRate: 30, capacityOverride: 9 });
    expect(res.status).toBe(200);

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkId } });
    expect(Number(after.rentalRate)).toBe(30);
    expect(after.capacityOverride).toBe(9);
  });
});

describe('PATCH /api/teacher-rooms/[id]', () => {
  it('rejects a missing state rather than falling back to a toggle', async () => {
    const res = await send('PATCH', ownerToken, linkId);
    expect(res.status).toBe(400);

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(false);
  });

  it('rejects an unrecognised state', async () => {
    const res = await send('PATCH', ownerToken, `${linkId}?state=nonsense`);
    expect(res.status).toBe(400);
  });

  it('sets the state it names, and repeating it is a no-op that reports unchanged', async () => {
    const first = await send('PATCH', ownerToken, `${linkId}?state=archived`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { isArchived: boolean; action: string } };
    expect(firstBody.data.isArchived).toBe(true);
    expect(firstBody.data.action).toBe('archived');

    const second = await send('PATCH', ownerToken, `${linkId}?state=archived`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { isArchived: boolean; action: string } };
    expect(secondBody.data.isArchived).toBe(true);
    expect(secondBody.data.action).toBe('unchanged');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(true);
  });

  // The un-archive arm of the same toggle, live at `/settings/rooms/archived`
  // — nothing until now asserted that `?state=unarchived` actually reverses
  // the archive rather than merely accepting the request.
  it('un-archives, and repeating it is a no-op that reports unchanged', async () => {
    const archive = await send('PATCH', ownerToken, `${linkId}?state=archived`);
    expect(archive.status).toBe(200);

    const first = await send('PATCH', ownerToken, `${linkId}?state=unarchived`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { isArchived: boolean; action: string } };
    expect(firstBody.data.isArchived).toBe(false);
    expect(firstBody.data.action).toBe('unarchived');

    const second = await send('PATCH', ownerToken, `${linkId}?state=unarchived`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { isArchived: boolean; action: string } };
    expect(secondBody.data.isArchived).toBe(false);
    expect(secondBody.data.action).toBe('unchanged');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(false);
  });

  // Issue 76. The room-archive lifecycle: a room in use cannot be shelved.
  it('refuses to archive a link that still carries an open class, and names what blocks it', async () => {
    const res = await send('PATCH', ownerToken, `${linkWithOpenClassId}?state=archived`);
    expect(res.status).toBe(409);

    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('ROOM_IN_USE');
    expect(body.error.message).toBe('1 unfinished class still uses this room.');

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkWithOpenClassId } });
    expect(after.isArchived).toBe(false);
  });

  // "Archived AND still carrying an open class" cannot be constructed any
  // more, by raw write or otherwise: `Class_live_needs_open_room` (#339)
  // refuses the write that would create that combination — the same state
  // `class-room-constraint.test.ts`'s "refuses archiving a room that holds a
  // live class" pins directly at the constraint. The release valve's own
  // unconditional behaviour is still covered above ("un-archives, and
  // repeating it is a no-op that reports unchanged"), which needs no blocker
  // at all to prove it.
});

// The list endpoint feeds both scheduling pickers, and both filter on
// `isArchived` client-side. PR review proved that field unpinned: swapping
// `include: { room: true }` for a `select` that omits it left the whole
// components project green — 41 files, 235 tests — while both pickers silently
// stopped filtering, because `!undefined` is truthy. The picker tests cannot
// see it: they stub `fetch`, so they assert against a payload they invent.
// This is the one place the real shape is observable.
describe('GET /api/teacher-rooms', () => {
  it('returns isArchived on every link, because the pickers filter on it', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-rooms`, {
      headers: cookie(ownerToken),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{ id: string; isArchived: boolean; room: { venueName: string } }>;
    };
    expect(data.length).toBeGreaterThan(0);
    for (const link of data) {
      expect(link).toHaveProperty('isArchived');
      expect(typeof link.isArchived).toBe('boolean');
      // The picker also needs the joined room to render a label at all.
      expect(link.room).toBeTruthy();
    }
  });
});

describe('DELETE /api/teacher-rooms/[id]', () => {
  it('refuses to unlink a link that still carries class history', async () => {
    const res = await send('DELETE', ownerToken, linkWithClassId);
    await expectRefusal(res, 'ROOM_IN_USE');

    // The class is why the guard exists — Class.teacherRoom is Restrict, so
    // deleting the link would fail at the database rather than cascade.
    expect(await prisma.teacherRoom.count({ where: { id: linkWithClassId } })).toBe(1);
    expect(await prisma.class.count({ where: { id: blockingClassId } })).toBe(1);
  });

  it('deletes a link with no class history', async () => {
    const res = await send('DELETE', ownerToken, linkId);
    expect(res.status).toBe(200);
    expect(await prisma.teacherRoom.count({ where: { id: linkId } })).toBe(0);
  });

  it('answers NOT_FOUND to a second delete of the same link', async () => {
    const roomId = await freshRoom('Delete Twice');
    const link = await prisma.teacherRoom.create({
      data: { teacherId: ownerId, roomId, capacityOverride: 6, rentalRate: 18 },
    });

    await expectApplied(await send('DELETE', ownerToken, link.id));
    // A retry after a lost response: the link is already gone, which the
    // Unlink button reads as done.
    await expectRefusal(await send('DELETE', ownerToken, link.id), 'NOT_FOUND');
    expect(await prisma.teacherRoom.count({ where: { id: link.id } })).toBe(0);
  });

  it("refuses another teacher's link before it reveals whether it is in use", async () => {
    // Ownership must lose to nothing. Swap the ownership check at `:154` with
    // the blocker count at `:161-162` and this becomes a 409 naming the
    // room's state — telling a stranger whether a link id they do not own is
    // in use.
    // The sibling route pins the same ordering (`rooms-api.test.ts`). The
    // ownership GUARD long predates this branch; this block simply had no case
    // covering its position relative to the blocker count until now.
    const res = await send('DELETE', otherToken, linkWithArchivedTemplateId);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Access denied');
    expect(await prisma.teacherRoom.count({ where: { id: linkWithArchivedTemplateId } })).toBe(1);
  });

  it('answers without waiting on the template row — pinning the pre-check, not the backstop', async () => {
    // THE ONLY TEST THAT CAN TELL THE TWO GUARDS APART, and the reason it
    // exists: PR review measured that mutating the pre-check to
    // `if (false && ...)` in BOTH routes leaves every test in the integration
    // project green, because the FK backstop answers with a byte-identical
    // status and body. Status alone cannot see the difference. Lock behaviour
    // can — and since this wave, so can `error.code`, which the pre-check
    // cases below assert. This case remains the only one that observes the
    // statement was never ISSUED, which is the part that orders the locks.
    //
    // The pre-check's real job is that the DELETE is never issued. Hold
    // `FOR UPDATE` on the very ClassTemplate row the RESTRICT trigger would
    // need `FOR KEY SHARE` on, then delete:
    //   - pre-check present: 409 straight away, the held row never touched
    //   - pre-check gone:    the DELETE blocks on the trigger until this
    //                        transaction ends, and the race below times out
    //
    // That wait edge is the one `docs/lock-order.md` says reopens the AB-BA
    // cycle against the generator sweep. This case is what keeps the "the
    // pre-check is not redundant with the catch" comment in both handlers
    // from being an unenforced claim.
    const template = await prisma.classTemplate.findFirstOrThrow({
      where: { teacherRoomId: linkWithArchivedTemplateId },
    });

    const settled = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "ClassTemplate" WHERE id = ${template.id} FOR UPDATE`;
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            send('DELETE', ownerToken, linkWithArchivedTemplateId).then((r) => r.status),
            new Promise<'blocked'>((resolve) => {
              timer = setTimeout(() => resolve('blocked'), 3_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      { timeout: 20_000 },
    );

    // 'blocked' means the handler issued the DELETE and is waiting on the row
    // this transaction holds — i.e. the pre-check did not stop it.
    expect(settled).toBe(409);
    // 3 s sentinel inside a 15 s `it` budget, and the two numbers must stay
    // apart. Vitest's DEFAULT testTimeout is 5 000 ms; the first version of
    // this case used a 5 000 ms sentinel, so vitest's deadline always won by
    // ~25 ms and the failure read "Test timed out in 5000ms" — which looks
    // like flake, the one reading this case must never invite — instead of
    // the diagnosis above. Prisma's interactive-transaction default is also
    // 5 000 ms, which is what `{ timeout: 20_000 }` keeps out of the way.
    // Measured margin: 16-20 ms across four full-project runs, worst observed
    // 44 ms under a deliberately overloaded machine. The sentinel is ~70x that.
  }, 15_000);

  it('refuses a link referenced only by an ARCHIVED template -> 409, not a 500', async () => {
    // The exact state that reproduced `500 {"error":{"message":"Internal
    // server error"}}` before this branch: zero Class rows, one archived
    // ClassTemplate. Both delete routes did it; `rooms-api.test.ts` covers the
    // other. The status assertion is the whole test — 409 vs 500 is the bug.
    expect(await prisma.class.count({ where: { teacherRoomId: linkWithArchivedTemplateId } })).toBe(0);

    const res = await send('DELETE', ownerToken, linkWithArchivedTemplateId);
    // ROOM_IN_USE, not ROOM_IN_USE_RACE: this asserts the PRE-CHECK answered.
    // Disabling it makes the backstop reply with the race code and reddens
    // every case carrying this line — the cheap, deterministic half of the
    // guard the lock-ordering case above pins the expensive half of.
    await expectRefusal(res, 'ROOM_IN_USE');

    // Nothing removed. The template is what RESTRICTs the delete, and a
    // teacher cannot delete it either — there is no DELETE verb on
    // /api/class-templates/[id] — so this room is permanently undeletable,
    // which is why the message points at archiving rather than at clearing.
    expect(await prisma.teacherRoom.count({ where: { id: linkWithArchivedTemplateId } })).toBe(1);
    expect(await prisma.classTemplate.count({ where: { teacherRoomId: linkWithArchivedTemplateId } })).toBe(1);
  });

  it('refuses a link referenced only by a LIVE template', async () => {
    // Premise, asserted rather than assumed — the archived sibling above does
    // the same. This is the ONLY fixture in the file matching
    // ACTIVE_TEMPLATE_WHERE, which is what `generateClassInstances` selects
    // on, and the dev server runs that sweep every 60 minutes. If a tick lands
    // inside this file's lifetime the link gains real Class rows and the case
    // starts passing on the CLASSES blocker — still green, no longer testing
    // the template half.
    expect(await prisma.class.count({ where: { teacherRoomId: linkWithLiveTemplateId } })).toBe(0);

    const res = await send('DELETE', ownerToken, linkWithLiveTemplateId);
    // ROOM_IN_USE, not ROOM_IN_USE_RACE: this asserts the PRE-CHECK answered.
    // Disabling it makes the backstop reply with the race code and reddens
    // every case carrying this line — the cheap, deterministic half of the
    // guard the lock-ordering case above pins the expensive half of.
    await expectRefusal(res, 'ROOM_IN_USE');
    expect(await prisma.teacherRoom.count({ where: { id: linkWithLiveTemplateId } })).toBe(1);
  });
});

/**
 * The pre-check in `POST /api/teacher-rooms` is a plain `findUnique`, so under
 * READ COMMITTED a concurrent attach to the same (teacher, room) passes it and
 * loses on `TeacherRoom_teacherId_roomId_key` (#161). The loser re-reads the
 * link that won and answers exactly as the pre-check would have for it.
 *
 * The lever is an UNCOMMITTED HOLDER, the one worked out in
 * `signup-api.test.ts` for the same shape: a second client inserts the
 * conflicting row inside an open transaction, the request sails past its
 * pre-check (uncommitted rows are invisible), parks on the pending unique
 * index entry, and the holder commits so the request loses. Deterministic —
 * the interleaving is forced, not raced for.
 */
describe('POST /api/teacher-rooms decides a raced duplicate from the link that won (#161)', () => {
  let raceRoomId: string;

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Venue',
        address: `${suffix} Race Street 1`,
        city: 'Amsterdam',
        postcode: '1011AB',
        floor: '1',
        roomName: 'Race Room',
        maxCapacity: 10,
        equipment: [],
        isPublic: true,
        createdById: ownerId,
      },
    });
    raceRoomId = room.id;
  });

  afterEach(async () => {
    await prisma.teacherRoom.deleteMany({ where: { roomId: raceRoomId } });
  });

  afterAll(async () => {
    await prisma.teacherRoom.deleteMany({ where: { roomId: raceRoomId } });
    await prisma.room.deleteMany({ where: { id: raceRoomId } });
  });

  /** Sends `body` while `holderLink` is inserted but uncommitted, and commits it once the request has parked. */
  async function raceAgainst(
    holderLink: { rentalRate: number; capacityOverride: number; isArchived?: boolean },
    body: { capacityOverride: number; rentalRate: number },
  ): Promise<Response> {
    const holder = new PrismaClient();
    let release!: () => void;
    let holding!: Promise<unknown>;
    const released = new Promise<void>((r) => { release = r; });

    try {
      await new Promise<void>((parked, failed) => {
        holding = holder.$transaction(async (tx) => {
          await tx.teacherRoom.create({
            data: { teacherId: ownerId, roomId: raceRoomId, ...holderLink },
          });
          parked();
          await released;
        }, { timeout: 20_000 }).catch((err: unknown) => { failed(err); throw err; });
      });

      const pending = fetch(`${BASE_URL}/api/teacher-rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
        body: JSON.stringify({ roomId: raceRoomId, ...body }),
      });

      // Asserted, not assumed: the holder's insert proves the index entry
      // exists, not that the request reached it. A request that answered inside
      // this second skipped the create on a committed row and raced nothing.
      let settled = false;
      void pending.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 1000));
      expect(settled).toBe(false);

      release();
      await holding;
      return await pending;
    } finally {
      release();
      await Promise.allSettled([holding]);
      await holder.$disconnect();
    }
  }

  it('refuses with ROOM_ALREADY_LISTED when the link that won carries a different rate', async () => {
    const res = await raceAgainst(
      { rentalRate: 25, capacityOverride: 10 },
      { capacityOverride: 10, rentalRate: 30 },
    );

    await expectRefusal(res, 'ROOM_ALREADY_LISTED');
    // One link, and it is the holder's — proof the request lost the insert
    // rather than serialising past it.
    const links = await prisma.teacherRoom.findMany({ where: { roomId: raceRoomId } });
    expect(links.map((l) => Number(l.rentalRate))).toEqual([25]);
  });

  it('answers unchanged when the link that won is the one this request asked for', async () => {
    const res = await raceAgainst(
      { rentalRate: 25, capacityOverride: 10 },
      { capacityOverride: 10, rentalRate: 25 },
    );

    const data = (await expectUnchanged(res)) as { id: string };
    const links = await prisma.teacherRoom.findMany({ where: { roomId: raceRoomId } });
    expect(links.map((l) => l.id)).toEqual([data.id]);
  });

  it('refuses with ROOM_ARCHIVED when the link that won is archived', async () => {
    const res = await raceAgainst(
      { rentalRate: 25, capacityOverride: 10, isArchived: true },
      { capacityOverride: 10, rentalRate: 25 },
    );

    await expectRefusal(res, 'ROOM_ARCHIVED');
    const links = await prisma.teacherRoom.findMany({ where: { roomId: raceRoomId } });
    expect(links.map((l) => l.isArchived)).toEqual([true]);
  });
});
