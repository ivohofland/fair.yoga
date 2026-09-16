/**
 * Pins the delete order `TeacherRoom -> Room -> Teacher` against
 * `Room_createdById_fkey` (`ON DELETE RESTRICT`, non-cascading) (#619).
 *
 * `TeacherRoom -> Teacher` is `ON DELETE CASCADE` (`prisma/schema.prisma`),
 * so only `Room.createdById -> Teacher` can refuse a delete here — which is
 * why the wrong-order case below deletes `teacher` directly rather than
 * needing a separate cascade case.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { uniqueSuffix } from '../helpers';
import { isRestrictViolationOn } from '@/lib/api-errors';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
let seq = 0;

const teacherIds: string[] = [];
const roomIds: string[] = [];
const teacherRoomIds: string[] = [];
const accountEmails: string[] = [];

interface Fixture {
  teacherId: string;
  roomId: string;
  teacherRoomId: string;
}

// Each id is pushed onto its cleanup array immediately after its own
// `create` resolves — not batched at the end — so a fixture that fails
// partway through (e.g. `teacherRoom.create` throws after `teacher` and
// `room` already committed) still leaves `afterAll` tracking every row that
// actually landed in the database, rather than orphaning it untracked.
async function makeFixture(): Promise<Fixture> {
  const tag = `roomorder-${suffix}-${seq++}`;
  const email = `${tag}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Order',
      lastName: 'Fixture',
      email,
      account: { create: { email } },
      bio: 'room delete order fixture',
      pageSlug: tag,
    },
  });
  teacherIds.push(teacher.id);
  accountEmails.push(email);
  const room = await prisma.room.create({
    data: {
      venueName: `Venue ${tag}`,
      address: `${tag} Street`,
      city: 'Amsterdam',
      postcode: '1011AB',
      maxCapacity: 10,
      createdById: teacher.id,
    },
  });
  roomIds.push(room.id);
  const teacherRoom = await prisma.teacherRoom.create({
    data: {
      teacherId: teacher.id,
      roomId: room.id,
      capacityOverride: 10,
      rentalRate: new Prisma.Decimal(20),
    },
  });
  teacherRoomIds.push(teacherRoom.id);
  return { teacherId: teacher.id, roomId: room.id, teacherRoomId: teacherRoom.id };
}

afterAll(async () => {
  // Room.createdById -> Teacher is ON DELETE RESTRICT (pinned by the test
  // below), so Room must go before Teacher. deleteMany is a no-op on
  // whatever a test already deleted inline.
  try {
    await prisma.teacherRoom.deleteMany({ where: { id: { in: teacherRoomIds } } });
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await prisma.account.deleteMany({ where: { email: { in: accountEmails } } });
  } finally {
    await prisma.$disconnect();
  }
});

describe('Room/TeacherRoom/Teacher delete order (Room_createdById_fkey)', () => {
  it('resolves when deleted in the app\'s order: teacherRoom -> room -> teacher', async () => {
    const f = await makeFixture();
    await expect(prisma.teacherRoom.delete({ where: { id: f.teacherRoomId } })).resolves.toBeDefined();
    await expect(prisma.room.delete({ where: { id: f.roomId } })).resolves.toBeDefined();
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).resolves.toBeDefined();
  });

  it('rejects on Room_createdById_fkey when teacher is deleted before room', async () => {
    const f = await makeFixture();
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).rejects.toSatisfy((e: unknown) =>
      isRestrictViolationOn(e, ['Room_createdById_fkey']),
    );
    // The failed delete rolled back, so teacher/room/teacherRoom all still exist.
    // afterAll will clean them up in the correct order.
  });
});
