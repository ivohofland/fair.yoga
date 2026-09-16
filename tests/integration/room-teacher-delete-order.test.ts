/**
 * Pins the delete order `TeacherRoom -> Room -> Teacher` against
 * `Room_createdById_fkey` (`ON DELETE RESTRICT`, non-cascading).
 *
 * `TeacherRoom -> Teacher` and `TeacherRoom -> Room` are both `ON DELETE
 * CASCADE` (`prisma/schema.prisma`), so only `Room.createdById -> Teacher`
 * can refuse a delete here — which is why the wrong-order case below
 * deletes `teacher` directly rather than needing a separate cascade case.
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
  accountEmail: string;
}

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
  const teacherRoom = await prisma.teacherRoom.create({
    data: {
      teacherId: teacher.id,
      roomId: room.id,
      capacityOverride: 10,
      rentalRate: new Prisma.Decimal(20),
    },
  });
  teacherIds.push(teacher.id);
  roomIds.push(room.id);
  teacherRoomIds.push(teacherRoom.id);
  accountEmails.push(email);
  return { teacherId: teacher.id, roomId: room.id, teacherRoomId: teacherRoom.id, accountEmail: email };
}

afterAll(async () => {
  // Delete in correct order to respect foreign key constraints:
  // TeacherRoom has CASCADE to both Teacher and Room, so delete it first.
  // Room.createdById has RESTRICT, so delete Room before Teacher.
  // Then delete Account.
  await prisma.teacherRoom.deleteMany({ where: { id: { in: teacherRoomIds } } });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { email: { in: accountEmails } } });
  await prisma.$disconnect();
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
