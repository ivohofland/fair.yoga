/**
 * `/(teacher)/class/[id]` and the offline owner marker (#725). The marker is
 * rendered by the page's own tree after the ownership check: a class the
 * signed-in teacher does not own answers 200 with an in-body redirect, and a
 * marker there would have the service worker store that body as the teacher's
 * page.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, teardownTeacher } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let ownerId: string | undefined;
let ownerAccountId: string | undefined;
let ownerToken: string;
let otherId: string | undefined;
let otherToken: string;
let roomId: string | undefined;
let classId: string;

const markers = (html: string) => html.match(/data-offline-owner="[^"]*"/g) ?? [];

const fetchPage = async (token: string) => {
  const res = await fetch(`${BASE_URL}/class/${classId}`, { headers: cookie(token) });
  expect(res.status).toBe(200);
  return res.text();
};

beforeAll(async () => {
  await prisma.$connect();
  try {
    const teacher = async (name: string) => {
      const email = `classpage-${name}-${suffix}@test.local`;
      return prisma.teacher.create({
        data: {
          firstName: name,
          lastName: 'Page',
          email,
          account: { create: { email } },
          bio: 'Class page marker fixture',
          pageSlug: `classpage-${name}-${suffix}`,
        },
        select: { id: true, accountId: true },
      });
    };
    const owner = await teacher('owner');
    ownerId = owner.id;
    ownerAccountId = owner.accountId;
    ownerToken = await seedSession(prisma, owner.accountId);
    const other = await teacher('other');
    otherId = other.id;
    otherToken = await seedSession(prisma, other.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Marker Studio',
        address: `${suffix} Marker St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: owner.id,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: owner.id, roomId: room.id, capacityOverride: 15, rentalRate: 25 },
    });
    const cls = await createClassFixture(prisma, {
      teacherId: owner.id,
      teacherRoomId: teacherRoom.id,
      classType: `Marker Class ${suffix}`,
      date: new Date('2099-08-05T00:00:00.000Z'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 10,
      status: 'draft',
    });
    classId = cls.id;
    // Warm the route: `next dev` compiles a page lazily on its first request.
    await fetch(`${BASE_URL}/class/${classId}`, { headers: cookie(ownerToken) }).catch(() => {});
  } catch (err) {
    await cleanup();
    throw err;
  }
}, 30_000);

async function cleanup() {
  if (ownerId) {
    await prisma.calendarEntry.deleteMany({ where: { teacherId: ownerId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: ownerId } });
  }
  if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
  await teardownTeacher(prisma, ownerId);
  await teardownTeacher(prisma, otherId);
}

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('the class page: the offline owner marker', () => {
  it('carries exactly one marker, naming the signed-in account', async () => {
    const html = await fetchPage(ownerToken);
    // Anchored: the class's own heading proves the real page rendered.
    expect(html).toContain(`Marker Class ${suffix}`);
    expect(markers(html)).toEqual([`data-offline-owner="${ownerAccountId}"`]);
  });

  it('carries no marker on the redirect a teacher gets for a class that is not theirs', async () => {
    const html = await fetchPage(otherToken);
    expect(html).not.toContain(`Marker Class ${suffix}`);
    expect(markers(html)).toEqual([]);
  });
});
