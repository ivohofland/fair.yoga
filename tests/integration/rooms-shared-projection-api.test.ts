/**
 * The room reads exercised below answer the shared projection (#768): the
 * creator's `notes`, `createdById` and timestamps never reach a teacher who did
 * not create the room.
 *
 * One fixture: teacher A writes a room with notes and shares it; teacher B
 * links it and has a class template on that link. Each case reads as B.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, teardownTeacher } from '../helpers';
import { SHARED_ROOM_SELECT } from '@/lib/room-projection';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const SECRET = 'door code 4821';

let creatorId = '';
let creatorAccountId = '';
let readerId = '';
let readerAccountId = '';
let readerToken = '';
let roomId = '';
let privateRoomId = '';
let creatorToken = '';
let teacherRoomId = '';
let templateId = '';

async function makeTeacher(tag: string) {
  const email = `roomproj-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Shared room projection tests',
      pageSlug: `roomproj-${tag}-${suffix}`,
    },
  });
  return teacher;
}

beforeAll(async () => {
  await prisma.$connect();
  const creator = await makeTeacher('creator');
  creatorId = creator.id;
  creatorAccountId = creator.accountId;
  const reader = await makeTeacher('reader');
  readerId = reader.id;
  readerAccountId = reader.accountId;
  readerToken = await seedSession(prisma, reader.accountId);

  const room = await prisma.room.create({
    data: {
      venueName: `Projection Studio ${suffix}`,
      address: `${suffix} Projection St`,
      city: 'Testville',
      postcode: '1234PR',
      floor: '1',
      roomName: 'Shared',
      maxCapacity: 10,
      equipment: ['mats', 'bolsters'],
      notes: SECRET,
      isPublic: true,
      createdById: creator.id,
    },
  });
  roomId = room.id;

  creatorToken = await seedSession(prisma, creator.accountId);
  const privateRoom = await prisma.room.create({
    data: {
      venueName: `Private Studio ${suffix}`,
      address: `${suffix} Private St`,
      city: 'Testville',
      postcode: '1234PR',
      floor: '2',
      roomName: 'Private',
      maxCapacity: 6,
      equipment: ['blocks'],
      notes: SECRET,
      isPublic: false,
      createdById: creator.id,
    },
  });
  privateRoomId = privateRoom.id;

  const link = await prisma.teacherRoom.create({
    data: { teacherId: reader.id, roomId, capacityOverride: 8, rentalRate: 15 },
  });
  teacherRoomId = link.id;

  const template = await prisma.classTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId: reader.id,
          kind: 'regular',
          classType: 'Projection Template',
          dayOfWeek: 3,
          startTime: hhmmToTime('19:00'),
          durationMinutes: 60,
        },
      },
      teacherRoom: { connect: { id: link.id } },
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
    },
  });
  templateId = template.id;
});

afterAll(async () => {
  await prisma.scheduleRule.deleteMany({ where: { teacherId: readerId } });
  await prisma.teacherRoom.deleteMany({ where: { roomId } });
  await prisma.room.deleteMany({ where: { id: { in: [roomId, privateRoomId].filter(Boolean) } } });
  await teardownTeacher(prisma, readerId, readerAccountId);
  await teardownTeacher(prisma, creatorId, creatorAccountId);
  await prisma.$disconnect();
});

async function readAsReader(path: string): Promise<{ text: string; data: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: cookie(readerToken) });
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, data: (JSON.parse(text) as { data: unknown }).data };
}

function expectProjection(room: Record<string, unknown>, text: string) {
  expect(text).not.toContain(SECRET);
  expect(room).not.toHaveProperty('notes');
  expect(room).not.toHaveProperty('createdById');
  expect(room).not.toHaveProperty('createdAt');
  expect(room).not.toHaveProperty('updatedAt');
  expect(room).not.toHaveProperty('isPublic');
  expect(room.roomName).toBe('Shared');
  expect(room.venueName).toBe(`Projection Studio ${suffix}`);
  expect(room.equipment).toEqual(['mats', 'bolsters']);
}

describe('a teacher who did not create a shared room reads only its shared projection (#768)', () => {
  it('GET /api/rooms (default branch)', async () => {
    const { text, data } = await readAsReader('/api/rooms');
    const rooms = data as Record<string, unknown>[];
    const room = rooms.find((r) => r.id === roomId);
    expect(room).toBeDefined();
    expectProjection(room!, text);
  });

  it('GET /api/rooms/[id]', async () => {
    const { text, data } = await readAsReader(`/api/rooms/${roomId}`);
    expectProjection(data as Record<string, unknown>, text);
  });

  it('GET /api/teacher-rooms', async () => {
    const { text, data } = await readAsReader('/api/teacher-rooms');
    const link = (data as { id: string; room: Record<string, unknown> }[]).find(
      (l) => l.id === teacherRoomId,
    );
    expect(link).toBeDefined();
    expectProjection(link!.room, text);
  });

  it('GET /api/teacher-rooms/[id]', async () => {
    const { text, data } = await readAsReader(`/api/teacher-rooms/${teacherRoomId}`);
    expectProjection((data as { room: Record<string, unknown> }).room, text);
  });

  it('GET /api/class-templates', async () => {
    const { text, data } = await readAsReader('/api/class-templates');
    const template = (
      data as { id: string; teacherRoom: { room: Record<string, unknown> } }[]
    ).find((t) => t.id === templateId);
    expect(template).toBeDefined();
    expectProjection(template!.teacherRoom.room, text);
  });

  it('GET /api/class-templates/[id]', async () => {
    const { text, data } = await readAsReader(`/api/class-templates/${templateId}`);
    expectProjection((data as { teacherRoom: { room: Record<string, unknown> } }).teacherRoom.room, text);
  });
});

describe('GET /api/rooms/[id] access (#768)', () => {
  it('refuses another teacher a private room and leaks none of it', async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${privateRoomId}`, { headers: cookie(readerToken) });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('answers 404 for an unknown id', async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${crypto.randomUUID()}`, { headers: cookie(readerToken) });
    expect(res.status).toBe(404);
  });

  it("answers the creator's own private room with the projection only", async () => {
    const res = await fetch(`${BASE_URL}/api/rooms/${privateRoomId}`, { headers: cookie(creatorToken) });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const room = (JSON.parse(text) as { data: Record<string, unknown> }).data;
    expect(Object.keys(room).sort()).toEqual(Object.keys(SHARED_ROOM_SELECT).sort());
  });
});
