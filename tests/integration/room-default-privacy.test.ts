/**
 * The column default, pinned on its own.
 *
 * This is deliberately NOT tested through the API. `createRoomSchema` also
 * defaults `isPublic` to false (Task 5), so an end-to-end assertion would
 * pass with either layer removed and certify neither. The two layers are
 * belt and braces; each gets its own test at its own level.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

describe('Room.isPublic column default', () => {
  afterAll(async () => {
    await prisma.room.deleteMany({ where: { address: `${suffix} Default St` } });
    await prisma.teacher.deleteMany({ where: { pageSlug: `roomdefault-${suffix}` } });
    await prisma.$disconnect();
  });

  it('creates a private room when isPublic is omitted', async () => {
    // Fixture shape copied verbatim from rooms-api.test.ts's makeTeacher
    // (tests/integration/rooms-api.test.ts:65-81). Teacher owns the email and
    // nests its Account; there is no top-level `accountId` on create.
    const email = `roomdefault-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Room',
        lastName: 'Default',
        email,
        account: { create: { email } },
        bio: 'Room default privacy test',
        pageSlug: `roomdefault-${suffix}`,
      },
    });

    const room = await prisma.room.create({
      data: {
        venueName: 'Default Studio',
        address: `${suffix} Default St`,
        city: 'Amsterdam',
        postcode: '1234DP',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 10,
        createdById: teacher.id,
        // isPublic deliberately omitted — the column default is what is under test
      },
    });

    expect(room.isPublic).toBe(false);
  });
});
