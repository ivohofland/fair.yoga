/**
 * PUT /api/rooms/[id] — the public-room lock.
 *
 * `if (room.isPublic) return 403` fires BEFORE the creator-ownership check
 * (src/app/api/rooms/[id]/route.ts:77-83), so a public room is read-only for
 * everyone — including its own creator. Deliberate (#52/#60: public rooms are
 * community property; an admin surface will eventually mediate changes), but
 * surprising enough that a future reordering could look like a bug fix while
 * silently reversing that decision. These tests pin the ordering: same actor,
 * same room, only `isPublic` differs between the first two cases — and the
 * two 403s assert their *distinct* messages, so a swap in guard order fails.
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

  // Room.isPublic defaults to true (prisma/schema.prisma:226) — explicit
  // false here, since these cases start from a private room.
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

    // route.ts:82 — the creator-ownership guard's own message.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Only the room creator can update this room');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(after.venueName).toBe(before.venueName);
  });

  it('the same creator is rejected once the room is public — distinct message', async () => {
    // Fixture state, not the invariant under test — flipped directly so the
    // only thing that changes between this case and the first is isPublic.
    await prisma.room.update({ where: { id: roomId }, data: { isPublic: true } });
    const before = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

    const res = await put(creatorToken, roomId, { venueName: 'Should not apply either' });
    expect(res.status).toBe(403);

    // route.ts:78 — fires BEFORE the creator check (route.ts:82), even for
    // the room's own creator. That ordering is the point of this file.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Public rooms cannot be edited');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });
    expect(after.venueName).toBe(before.venueName);
    expect(after.isPublic).toBe(true);
  });
});
