/**
 * PUT /api/rooms/[id] — the public-room lock.
 *
 * The `isPublic` guard (rooms/[id]/route.ts:77-79) precedes the `createdById`
 * guard (:81-83), so a public room is read-only for everyone — including its
 * own creator. Deliberate (#52/#60: public rooms are community property; an
 * admin surface will eventually mediate changes), but surprising enough that
 * a future reordering could look like a bug fix while silently reversing that
 * decision.
 *
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
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let creatorId: string;
let creatorAccountId: string;
let creatorToken: string;
let otherTeacherId: string;
let otherAccountId: string;
let otherToken: string;
let roomId: string;

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

beforeAll(async () => {
  await prisma.$connect();

  const creator = await prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: 'Creator',
      email: `roomsapi-creator-${suffix}@test.local`,
      account: { create: { email: `roomsapi-creator-${suffix}@test.local` } },
      bio: 'Rooms API tests',
      pageSlug: `roomsapi-creator-${suffix}`,
    },
  });
  creatorId = creator.id;
  creatorAccountId = creator.accountId;
  creatorToken = await seedSession(prisma, creatorAccountId);

  const other = await prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: 'Outsider',
      email: `roomsapi-other-${suffix}@test.local`,
      account: { create: { email: `roomsapi-other-${suffix}@test.local` } },
      bio: 'Rooms API tests',
      pageSlug: `roomsapi-other-${suffix}`,
    },
  });
  otherTeacherId = other.id;
  otherAccountId = other.accountId;
  otherToken = await seedSession(prisma, otherAccountId);

  // Room.isPublic defaults to true (the `isPublic` field, prisma/schema.prisma:226)
  // — explicit false here, since these cases start from a private room.
  const room = await prisma.room.create({
    data: {
      venueName: 'Rooms API Studio',
      address: `${suffix} Rooms St`,
      city: 'Testville',
      postcode: '1234RA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 10,
      createdById: creatorId,
      isPublic: false,
    },
  });
  roomId = room.id;
});

afterAll(async () => {
  if (roomId) {
    await prisma.room.delete({ where: { id: roomId } });
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
