/**
 * `/api/teacher-rooms` — the first HTTP coverage this route group has had (#53).
 *
 * `TeacherRoom` holds the teacher's private rental rate, which CLAUDE.md says is
 * "never shared between teachers", so the ownership chain on `[id]` is
 * money-adjacent and cross-tenant rather than a routine guard. That, plus the
 * two state guards (the create-side duplicate 409 and the delete-side class
 * history 409), is what earns tests here: per `docs/technical-architecture.md`,
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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

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
    await prisma.class.create({
      data: {
        teacherId: ownerId,
        teacherRoomId: linkWithClass.id,
        classType: 'Teacher Rooms API Delete Guard',
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
  await prisma.class.create({
    data: {
      teacherId: ownerId,
      teacherRoomId: linkWithOpenClass.id,
      classType: 'Teacher Rooms API Archive Guard',
      date: new Date('2099-06-01'),
      startTime: '11:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'open',
    },
  });

  const archivedTemplateRoom = await makeRoom('Archived Template');
  const archivedTemplateLink = await prisma.teacherRoom.create({
    data: { teacherId: ownerId, roomId: archivedTemplateRoom.id, capacityOverride: 8, rentalRate: 15 },
  });
  linkWithArchivedTemplateId = archivedTemplateLink.id;
  await prisma.classTemplate.create({
    data: {
      teacherId: ownerId,
      teacherRoomId: archivedTemplateLink.id,
      classType: 'Teacher Rooms Delete Guard',
      dayOfWeek: 2,
      startTime: '18:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      isActive: false,
      isArchived: true,
    },
  });

  const liveTemplateRoom = await makeRoom('Live Template');
  const liveTemplateLink = await prisma.teacherRoom.create({
    data: { teacherId: ownerId, roomId: liveTemplateRoom.id, capacityOverride: 8, rentalRate: 15 },
  });
  linkWithLiveTemplateId = liveTemplateLink.id;
  await prisma.classTemplate.create({
    data: {
      teacherId: ownerId,
      teacherRoomId: liveTemplateLink.id,
      classType: 'Teacher Rooms Delete Guard Live',
      dayOfWeek: 3,
      startTime: '19:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      isActive: true,
      isArchived: false,
    },
  });
});

afterAll(async () => {
  // FK order: class → classTemplate → teacherRoom → room. Both Class and
  // ClassTemplate.teacherRoom are Restrict, so both must go first.
  await prisma.class.deleteMany({ where: { teacherId: { in: [ownerId, otherId] } } });
  await prisma.classTemplate.deleteMany({ where: { teacherId: { in: [ownerId, otherId] } } });
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

  it('links a teacher to a room, then refuses a second link for the same pair', async () => {
    const body = { roomId: freeRoomId, capacityOverride: 6, rentalRate: 18 };

    const first = await create(ownerToken, body);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { data: { id: string; rentalRate: string } };
    expect(created.data.id).toBeTruthy();

    // The uniqueness is on (teacherId, roomId), and the route reports it as a
    // machine-readable 409 rather than letting the constraint surface as a 500.
    const second = await create(ownerToken, body);
    expect(second.status).toBe(409);
    const err = (await second.json()) as { error: { code?: string } };
    expect(err.error.code).toBe('DUPLICATE');

    expect(await prisma.teacherRoom.count({ where: { roomId: freeRoomId } })).toBe(1);
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

  it('404s a room that does not exist, instead of failing on the foreign key', async () => {
    const res = await create(ownerToken, {
      roomId: '00000000-0000-0000-0000-000000000000',
      capacityOverride: 5,
      rentalRate: 10,
    });
    expect(res.status).toBe(404);
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

  // The release valve, over HTTP. Un-archiving must never acquire a guard.
  it('un-archives a link that is in use', async () => {
    await prisma.teacherRoom.update({
      where: { id: linkWithOpenClassId },
      data: { isArchived: true },
    });

    const res = await send('PATCH', ownerToken, `${linkWithOpenClassId}?state=unarchived`);
    expect(res.status).toBe(200);

    const after = await prisma.teacherRoom.findUniqueOrThrow({ where: { id: linkWithOpenClassId } });
    expect(after.isArchived).toBe(false);
  });
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
  it('refuses to delete a link that still carries class history, and says to archive instead', async () => {
    const res = await send('DELETE', ownerToken, linkWithClassId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('Archive it instead');

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

  it('refuses a link referenced only by an ARCHIVED template -> 409, not a 500', async () => {
    // The exact state that reproduced `500 {"error":{"message":"Internal
    // server error"}}` before this branch: zero Class rows, one archived
    // ClassTemplate. Both delete routes did it; `rooms-api.test.ts` covers the
    // other. The status assertion is the whole test — 409 vs 500 is the bug.
    expect(await prisma.class.count({ where: { teacherRoomId: linkWithArchivedTemplateId } })).toBe(0);

    const res = await send('DELETE', ownerToken, linkWithArchivedTemplateId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Cannot delete a room with class history. Archive it instead.');

    // Nothing removed. The template is what RESTRICTs the delete, and a
    // teacher cannot delete it either — there is no DELETE verb on
    // /api/class-templates/[id] — so this room is permanently undeletable,
    // which is why the message points at archiving rather than at clearing.
    expect(await prisma.teacherRoom.count({ where: { id: linkWithArchivedTemplateId } })).toBe(1);
    expect(await prisma.classTemplate.count({ where: { teacherRoomId: linkWithArchivedTemplateId } })).toBe(1);
  });

  it('refuses a link referenced only by a LIVE template', async () => {
    const res = await send('DELETE', ownerToken, linkWithLiveTemplateId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Cannot delete a room with class history. Archive it instead.');
    expect(await prisma.teacherRoom.count({ where: { id: linkWithLiveTemplateId } })).toBe(1);
  });
});
