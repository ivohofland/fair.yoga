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
    await prisma.teacher.deleteMany({
      where: { pageSlug: { in: [`roomdefault-${suffix}`, `roomrawdefault-${suffix}`] } },
    });
    await prisma.$disconnect();
  });

  it('creates a private room when isPublic is omitted', async () => {
    // Fixture shape copied verbatim from rooms-api.test.ts's makeTeacher
    // (tests/integration/rooms-api.test.ts:75-91). Teacher owns the email and
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
        // isPublic deliberately omitted — the SCHEMA default is what this
        // assertion reaches. See the test below for why that is not the same
        // thing as the column default.
      },
    });

    expect(room.isPublic).toBe(false);
  });

  /**
   * The COLUMN default, which the test above does not reach.
   *
   * Prisma Client materialises a scalar `@default(false)` on the client side
   * and sends the column explicitly — the emitted INSERT names `isPublic` in
   * its column list with `false` in its parameters, so Postgres never
   * consults its own default. That makes the assertion above a test of
   * `schema.prisma`, and it would stay green if migration
   * `20260818135425_room_is_public_defaults_private` were reverted or never
   * applied.
   *
   * That matters because spec §4 justifies the column default for exactly the
   * writer Prisma Client is not: "a future script creating a `Room` without
   * the field". A raw INSERT is that writer. This is the only assertion on
   * this branch that touches the database layer of the belt-and-braces pair.
   */
  it('creates a private room when a raw INSERT omits the column entirely', async () => {
    const email = `roomrawdefault-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Room',
        lastName: 'RawDefault',
        email,
        account: { create: { email } },
        bio: 'Room default privacy test',
        pageSlug: `roomrawdefault-${suffix}`,
      },
    });

    const address = `${suffix} Default St`;
    // No `isPublic` in the column list — Postgres has to supply it.
    await prisma.$executeRaw`
      INSERT INTO "Room" ("id", "venueName", "address", "city", "postcode", "floor", "roomName", "maxCapacity", "createdById", "updatedAt")
      VALUES (gen_random_uuid(), 'Raw Studio', ${address}, 'Amsterdam', '1234DP', '2', 'Raw', 10, ${teacher.id}, now())
    `;

    const room = await prisma.room.findFirstOrThrow({
      where: { address, roomName: 'Raw' },
    });
    expect(room.isPublic).toBe(false);
  });
});
