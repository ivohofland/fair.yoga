/**
 * `sameRoomIdentity` and `Room_public_identity_unique` must agree.
 *
 * The unit tests in src/lib/room-identity.test.ts pin the predicate against
 * its own docblock. This pins it against Postgres: two rooms the predicate
 * calls DIFFERENT must both be insertable as shared, and two it calls the
 * SAME must not. If either the predicate or the index changes without the
 * other, exactly one of these fails.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix } from '../helpers';
import { sameRoomIdentity } from '@/lib/room-identity';
import { isUniqueConflictOn } from '@/lib/unique-conflict';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const address = `${suffix} Agreement St`;
const variantAddress = address.toLowerCase();

let teacherId: string;

function shared(addr: string, floor: string, roomName: string) {
  return prisma.room.create({
    data: {
      venueName: 'Agreement Studio',
      address: addr,
      city: 'Amsterdam',
      postcode: '1234AG',
      floor,
      roomName,
      maxCapacity: 10,
      createdById: teacherId,
      isPublic: true,
    },
  });
}

beforeAll(async () => {
  // Fixture shape copied verbatim from rooms-api.test.ts:75-91.
  const email = `roomagree-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Room',
      lastName: 'Agreement',
      email,
      account: { create: { email } },
      bio: 'Room identity agreement test',
      pageSlug: `roomagree-${suffix}`,
    },
  });
  teacherId = teacher.id;
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { address: { in: [address, variantAddress] } } });
  await prisma.teacher.deleteMany({ where: { pageSlug: `roomagree-${suffix}` } });
  await prisma.$disconnect();
});

describe('sameRoomIdentity agrees with Room_public_identity_unique', () => {
  it('accepts as shared two rooms the predicate calls different', async () => {
    // Guard the test's own premise: if the predicate ever starts calling
    // these the same, this assertion says so before Postgres is consulted.
    expect(
      sameRoomIdentity(
        { address, floor: '1', roomName: 'Hall' },
        { address: variantAddress, floor: '1', roomName: 'Hall' },
      ),
    ).toBe(false);

    await shared(address, '1', 'Hall');
    await expect(shared(variantAddress, '1', 'Hall')).resolves.toBeDefined();
  });

  it('refuses as shared a second room the predicate calls the same', async () => {
    expect(
      sameRoomIdentity(
        { address, floor: '2', roomName: 'Annex' },
        { address, floor: '2', roomName: 'Annex' },
      ),
    ).toBe(true);

    await shared(address, '2', 'Annex');

    // Asserted on the error's IDENTITY, not merely that one was thrown. A
    // bare `rejects.toThrow()` passes on any failure at all — a missing
    // column, a bad foreign key, a typo in the fixture — so a broken fixture
    // would read as the index doing its job, which is the one thing this test
    // exists to observe.
    //
    // Via the repo's own helper rather than a hand-written shape, for the
    // reason its docblock gives: a partial index Prisma cannot see still
    // reports `meta.target` as the COLUMN-NAME ARRAY, not the index name. So
    // this also pins that the collision is the three-column public shape —
    // `Room_public_identity_unique`, the index the predicate mirrors — and
    // not the four-column private one the row just left.
    const err = await shared(address, '2', 'Annex').catch((e: unknown) => e);
    expect(isUniqueConflictOn(err, ['address', 'floor', 'roomName'])).toBe(true);
  });
});
