/**
 * A shared room's settings page shows `Room.notes` only to the teacher who
 * wrote them (#768). Teacher A creates and shares a room with notes; teacher B
 * links it and carries their own equipment notes on the link.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, teardownTeacher } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const SECRET = 'door code 4821';
const OWN_NOTES = `my own props ${suffix}`;

let creatorId = '';
let creatorAccountId = '';
let readerId = '';
let readerAccountId = '';
let creatorToken = '';
let readerToken = '';
let roomId = '';
let creatorLinkId = '';
let readerLinkId = '';

async function makeTeacher(tag: string) {
  const email = `roomnotes-${tag}-${suffix}@test.local`;
  return prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Room settings page notes tests',
      pageSlug: `roomnotes-${tag}-${suffix}`,
    },
  });
}

beforeAll(async () => {
  await prisma.$connect();
  const creator = await makeTeacher('creator');
  creatorId = creator.id;
  creatorAccountId = creator.accountId;
  const reader = await makeTeacher('reader');
  readerId = reader.id;
  readerAccountId = reader.accountId;
  creatorToken = await seedSession(prisma, creator.accountId);
  readerToken = await seedSession(prisma, reader.accountId);

  const room = await prisma.room.create({
    data: {
      venueName: `Notes Studio ${suffix}`,
      address: `${suffix} Notes St`,
      city: 'Testville',
      postcode: '1234NT',
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

  creatorLinkId = (
    await prisma.teacherRoom.create({ data: { teacherId: creator.id, roomId, capacityOverride: 10, rentalRate: 10 } })
  ).id;
  readerLinkId = (
    await prisma.teacherRoom.create({
      data: { teacherId: reader.id, roomId, capacityOverride: 8, rentalRate: 15, equipmentNotes: OWN_NOTES },
    })
  ).id;
});

afterAll(async () => {
  await prisma.teacherRoom.deleteMany({ where: { roomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await teardownTeacher(prisma, readerId, readerAccountId);
  await teardownTeacher(prisma, creatorId, creatorAccountId);
  await prisma.$disconnect();
});

async function pageHtml(token: string, teacherRoomId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/settings/rooms/${teacherRoomId}`, { headers: cookie(token) });
  expect(res.status).toBe(200);
  return res.text();
}

describe('the room settings page keeps a shared room notes to their writer (#768)', () => {
  it('a teacher who linked the room does not receive the creator notes, but sees props and their own notes', async () => {
    const html = await pageHtml(readerToken, readerLinkId);
    expect(html).not.toContain(SECRET);
    expect(html).toContain('Available props');
    expect(html).toContain('Mats, Bolsters');
    expect(html).toContain(OWN_NOTES);
  });

  it('the creator still sees their own notes', async () => {
    const html = await pageHtml(creatorToken, creatorLinkId);
    expect(html).toContain(SECRET);
  });
});
