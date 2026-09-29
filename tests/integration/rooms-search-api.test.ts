/**
 * GET /api/rooms?postcode=…&street=… — the shared-room search.
 *
 * The rooms it returns belong to other teachers, so the first case pins the
 * exact keys on the wire rather than only the ones a client reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const street = `${suffix} Search St`;

let searcherToken: string;
let publicRoomId: string;

async function makeTeacher(tag: string): Promise<{ id: string; token: string }> {
  const email = `roomsearch-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Rooms search API tests',
      pageSlug: `roomsearch-${tag}-${suffix}`,
    },
  });
  return { id: teacher.id, token: await seedSession(prisma, teacher.accountId) };
}

function makeRoom(roomName: string, isPublic: boolean, createdById: string) {
  return prisma.room.create({
    data: {
      venueName: 'Search Studio',
      address: `${street} 1`,
      city: 'Amsterdam',
      postcode: '1015DX',
      floor: '2',
      roomName,
      maxCapacity: 12,
      notes: 'The creator keeps the key code here',
      createdById,
      isPublic,
    },
  });
}

function search(postcode: string) {
  const params = new URLSearchParams({ postcode, street });
  return fetch(`${BASE_URL}/api/rooms?${params}`, { headers: cookie(searcherToken) });
}

beforeAll(async () => {
  await prisma.$connect();
  searcherToken = (await makeTeacher('searcher')).token;
  const creator = await makeTeacher('creator');
  publicRoomId = (await makeRoom('Shared', true, creator.id)).id;
  await makeRoom('Private', false, creator.id);
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { address: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { pageSlug: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

describe('GET /api/rooms (search)', () => {
  it('returns only the RoomResult columns of another teacher\'s shared room', async () => {
    const res = await search('1015DX');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown>[] };
    expect(data).toHaveLength(1);
    const [row] = data;
    expect(row?.id).toBe(publicRoomId);
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ['address', 'city', 'floor', 'id', 'maxCapacity', 'postcode', 'roomName', 'venueName'],
    );
  });

  it('leaves out a private room at the same address', async () => {
    const res = await search('1015DX');
    const { data } = (await res.json()) as { data: { roomName: string }[] };
    expect(data.map((r) => r.roomName)).toEqual(['Shared']);
  });

  it('matches a postcode typed with a space', async () => {
    const res = await search('1015 DX');
    const { data } = (await res.json()) as { data: { id: string }[] };
    expect(data.map((r) => r.id)).toEqual([publicRoomId]);
  });
});
