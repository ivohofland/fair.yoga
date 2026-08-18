/**
 * POST /api/rooms/[id]/publish — the only door into `isPublic: true`.
 *
 * GUARD ORDER IS THE INVERSE OF PUT's AND DELETE's, AND THAT IS DELIBERATE.
 * Those two ask `isPublic?` before `createdById?`, because a shared room is
 * community property no matter who asks. This route asks `createdById?`
 * first, because only the creator may donate. "Make it consistent with its
 * neighbours" is the plausible future edit that breaks it.
 *
 * Which case pins WHICH property matters, and they are not the same case:
 *   - non-creator on a PRIVATE room answers 403 under BOTH orderings. It
 *     pins the product decision and is blind to the order.
 *   - non-creator on an ALREADY-SHARED room is the only case that separates
 *     them: creator-first answers NOT_ROOM_CREATOR, isPublic-first answers
 *     ALREADY_SHARED.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const address = `${suffix} Publish St`;

let creatorId: string;
let creatorToken: string;
let otherToken: string;

// `cookie(token)` returns `{ Cookie: string }` — an object to spread or pass
// as `headers` directly, NOT a string. See tests/helpers.ts:75.
function publish(token: string, id: string) {
  return fetch(`${BASE_URL}/api/rooms/${id}/publish`, {
    method: 'POST',
    headers: cookie(token),
  });
}

function makeRoom(roomName: string, isPublic: boolean, createdById = creatorId) {
  return prisma.room.create({
    data: {
      venueName: 'Publish Studio',
      address,
      city: 'Amsterdam',
      postcode: '1234PB',
      floor: '1',
      roomName,
      maxCapacity: 10,
      createdById,
      isPublic,
    },
  });
}

// `seedSession(db, accountId)` takes an ACCOUNT ID and returns the raw token
// STRING (tests/helpers.ts:170). The caller creates the Teacher and its nested
// Account itself — this helper is the same shape as rooms-api.test.ts:65-81.
async function makeTeacher(tag: string): Promise<{ id: string; token: string }> {
  const email = `roompublish-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Rooms publish API tests',
      pageSlug: `roompublish-${tag}-${suffix}`,
    },
  });
  return { id: teacher.id, token: await seedSession(prisma, teacher.accountId) };
}

beforeAll(async () => {
  await prisma.$connect();
  const creator = await makeTeacher('creator');
  creatorId = creator.id;
  creatorToken = creator.token;
  otherToken = (await makeTeacher('other')).token;
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { address } });
  await prisma.teacher.deleteMany({ where: { bio: 'Rooms publish API tests' } });
  await prisma.$disconnect();
});

describe('POST /api/rooms/[id]/publish', () => {
  it('shares the creator\'s own private room', async () => {
    const room = await makeRoom('Happy', false);
    const res = await publish(creatorToken, room.id);
    expect(res.status).toBe(200);

    const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(after.isPublic).toBe(true);
  });

  it('answers 404 for a room that does not exist', async () => {
    const res = await publish(creatorToken, '00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  // PRODUCT DECISION — blind to guard order by construction.
  it('refuses a non-creator, and leaves the room private', async () => {
    const room = await makeRoom('NotYours', false);
    const res = await publish(otherToken, room.id);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('NOT_ROOM_CREATOR');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect(after.isPublic).toBe(false);
  });

  // GUARD ORDER — the only case that can detect a swap.
  it('answers a non-creator on an already-shared room with NOT_ROOM_CREATOR, not ALREADY_SHARED', async () => {
    const room = await makeRoom('SharedNotYours', true);
    const res = await publish(otherToken, room.id);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('NOT_ROOM_CREATOR');
  });

  it('refuses the creator re-sharing an already-shared room', async () => {
    const room = await makeRoom('AlreadyShared', true);
    const res = await publish(creatorToken, room.id);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('ALREADY_SHARED');
  });

  it('refuses when a shared room already holds that identity, and leaves both rows alone', async () => {
    const holder = await makeRoom('Contested', true);
    const mine = await prisma.room.create({
      data: {
        venueName: 'Publish Studio',
        address,
        city: 'Amsterdam',
        postcode: '1234PB',
        floor: '1',
        roomName: 'Contested',
        maxCapacity: 10,
        createdById: creatorId,
        isPublic: false,
      },
    });

    const res = await publish(creatorToken, mine.id);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('DUPLICATE_ROOM');
    expect(json.error.message).toBe('A shared room at this address already exists');

    const after = await prisma.room.findUniqueOrThrow({ where: { id: mine.id } });
    expect(after.isPublic).toBe(false);
    const stillShared = await prisma.room.findUniqueOrThrow({ where: { id: holder.id } });
    expect(stillShared.isPublic).toBe(true);
  });
});
