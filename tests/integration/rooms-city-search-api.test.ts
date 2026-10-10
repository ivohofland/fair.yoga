/**
 * GET /api/rooms?city=…&q=… — browsing shared rooms by city (#805).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
// Unique per run; the accented spelling is what is stored.
const city = `Zürich-${suffix}`;
const otherCity = `Bern-${suffix}`;

let searcherToken: string;

async function makeTeacher(tag: string): Promise<{ id: string; token: string }> {
  const email = `roomcity-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Room', lastName: tag, email,
      account: { create: { email } },
      bio: 'Room city search tests',
      pageSlug: `roomcity-${tag}-${suffix}`,
    },
  });
  return { id: teacher.id, token: await seedSession(prisma, teacher.accountId) };
}

function makeRoom(over: { venueName: string; address: string; city: string; isPublic?: boolean }, createdById: string) {
  return prisma.room.create({
    data: {
      venueName: over.venueName,
      address: `${over.address} ${suffix}`,
      city: over.city,
      postcode: '8001',
      floor: '',
      roomName: '',
      maxCapacity: 12,
      createdById,
      isPublic: over.isPublic ?? true,
    },
  });
}

function search(params: Record<string, string>) {
  return fetch(`${BASE_URL}/api/rooms?${new URLSearchParams(params)}`, { headers: cookie(searcherToken) });
}

async function venues(params: Record<string, string>): Promise<string[]> {
  const res = await search(params);
  expect(res.status).toBe(200);
  const { data } = (await res.json()) as { data: { rooms: { venueName: string }[]; truncated: boolean } };
  expect(data.truncated).toBe(false);
  return data.rooms.map((r) => r.venueName);
}

beforeAll(async () => {
  await prisma.$connect();
  searcherToken = (await makeTeacher('searcher')).token;
  const creator = await makeTeacher('creator');
  await makeRoom({ venueName: 'Bahnhof Yoga', address: 'Bahnhofstrasse 1', city }, creator.id);
  await makeRoom({ venueName: 'Altstadt Studio', address: 'Niederdorfstraße 5', city }, creator.id);
  await makeRoom({ venueName: 'Studio_1', address: 'Seestrasse 9', city }, creator.id);
  await makeRoom({ venueName: 'Hidden Room', address: 'Privatweg 2', city, isPublic: false }, creator.id);
  await makeRoom({ venueName: 'Bern Loft', address: 'Marktgasse 3', city: otherCity }, creator.id);
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { address: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { pageSlug: { contains: suffix } } });
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

describe('GET /api/rooms?city=', () => {
  it('lists the shared rooms in a city, by venue name, without private ones', async () => {
    expect(await venues({ city })).toEqual(['Altstadt Studio', 'Bahnhof Yoga', 'Studio_1']);
  });

  it('matches without the accent, in any case, with surrounding spaces', async () => {
    expect(await venues({ city: `  zurich-${suffix} ` })).toHaveLength(3);
  });

  it('matches a city by its start, not its middle', async () => {
    // The stem keeps this run's suffix (minus its last character), so other
    // runs' rows cannot reach it; the middle search drops the leading "Zü".
    const stem = city.slice(0, -1);
    expect(await venues({ city: stem })).toEqual(['Altstadt Studio', 'Bahnhof Yoga', 'Studio_1']);
    expect(await venues({ city: `rich-${suffix}` })).toEqual([]);
  });

  it('narrows by street or venue, accent-insensitively', async () => {
    expect(await venues({ city, q: 'niederdorfstrasse' })).toEqual(['Altstadt Studio']);
    expect(await venues({ city, q: 'bahnhof yoga' })).toEqual(['Bahnhof Yoga']);
  });

  it('treats % and _ as literal characters', async () => {
    expect(await venues({ city, q: 'Studio_' })).toEqual(['Studio_1']);
    expect(await venues({ city, q: '%' })).toEqual([]);
  });

  it('returns only RoomResult columns', async () => {
    const res = await search({ city });
    const { data } = (await res.json()) as { data: { rooms: Record<string, unknown>[] } };
    expect(Object.keys(data.rooms[0] ?? {}).sort()).toEqual(
      ['address', 'city', 'floor', 'id', 'maxCapacity', 'postcode', 'roomName', 'venueName'],
    );
  });

  it('refuses a blank city instead of listing everything', async () => {
    expect((await search({ city: '   ' })).status).toBe(400);
  });

  it('caps the list and says more exist', async () => {
    const capCity = `Capville-${suffix}`;
    const creator = await makeTeacher('cap');
    await prisma.room.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        venueName: `Cap ${String(i).padStart(2, '0')}`,
        address: `Capweg ${i} ${suffix}`,
        city: capCity, postcode: '1000', floor: '', roomName: '',
        maxCapacity: 10, createdById: creator.id, isPublic: true,
      })),
    });
    const res = await search({ city: capCity });
    const { data } = (await res.json()) as { data: { rooms: unknown[]; truncated: boolean } };
    expect(data.rooms).toHaveLength(50);
    expect(data.truncated).toBe(true);
  });
});
