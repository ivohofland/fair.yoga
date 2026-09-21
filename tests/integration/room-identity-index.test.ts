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
  await prisma.room.deleteMany({ where: { address: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { pageSlug: `roomagree-${suffix}` } });
  // Issue 177: Account must be deleted after Teacher due to FK reference
  await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.$disconnect();
});

describe('sameRoomIdentity agrees with Room_public_identity_unique', () => {
  it('accepts as shared two rooms the predicate calls different', async () => {
    const addr1 = `${suffix} Agreement St A`;
    const addr2 = `${suffix} Agreement St B`;
    expect(
      sameRoomIdentity(
        { address: addr1, floor: '1', roomName: 'Hall' },
        { address: addr2, floor: '1', roomName: 'Hall' },
      ),
    ).toBe(false);

    await shared(addr1, '1', 'Hall');
    await expect(shared(addr2, '1', 'Hall')).resolves.toBeDefined();
  });

  it('refuses as shared a second room the predicate calls the same (identical fields)', async () => {
    expect(
      sameRoomIdentity(
        { address, floor: '2', roomName: 'Annex' },
        { address, floor: '2', roomName: 'Annex' },
      ),
    ).toBe(true);

    await shared(address, '2', 'Annex');

    const err = await shared(address, '2', 'Annex').catch((e: unknown) => e);
    expect(isUniqueConflictOn(err, ['address', 'floor', 'roomName'])).toBe(true);
  });

  it('refuses as shared a second room differing only by case (#260)', async () => {
    expect(
      sameRoomIdentity(
        { address, floor: '3', roomName: 'Studio A' },
        { address: variantAddress, floor: '3', roomName: 'studio a' },
      ),
    ).toBe(true);

    await shared(address, '3', 'Studio A');

    const err = await shared(variantAddress, '3', 'studio a').catch((e: unknown) => e);
    expect(isUniqueConflictOn(err, ['address', 'floor', 'roomName'])).toBe(true);
  });

  it('refuses as shared a second room differing only by whitespace (#260)', async () => {
    const paddedAddress = `  ${address}  `;
    expect(
      sameRoomIdentity(
        { address, floor: '4', roomName: 'Attic' },
        { address: paddedAddress, floor: ' 4 ', roomName: 'Attic ' },
      ),
    ).toBe(true);

    await shared(address, '4', 'Attic');

    const err = await shared(paddedAddress, ' 4 ', 'Attic ').catch((e: unknown) => e);
    expect(isUniqueConflictOn(err, ['address', 'floor', 'roomName'])).toBe(true);
  });
});
