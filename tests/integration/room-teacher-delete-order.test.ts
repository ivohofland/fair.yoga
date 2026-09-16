/**
 * Pins the delete order `TeacherRoom -> Room -> Teacher` against
 * `Room_createdById_fkey` (`ON DELETE RESTRICT`, non-cascading). #617:
 * `tests/e2e/visual.spec.ts`'s `afterAll` deleted `Teacher` before `Room`
 * and tripped this constraint, but its only regression coverage lives
 * inside a Playwright `describe` that self-skips on Linux CI (no
 * `-linux` baselines, #542's `hasBaselines` check) — so nothing in CI
 * caught it, and nothing catches its reintroduction. This file does,
 * unconditionally, in the `test-integration` job.
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
  return { teacherId: teacher.id, roomId: room.id, teacherRoomId: teacherRoom.id, accountEmail: email };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Room/TeacherRoom/Teacher delete order (Room_createdById_fkey)', () => {
  it('resolves when deleted in the app\'s order: teacherRoom -> room -> teacher', async () => {
    const f = await makeFixture();
    await expect(prisma.teacherRoom.delete({ where: { id: f.teacherRoomId } })).resolves.toBeDefined();
    await expect(prisma.room.delete({ where: { id: f.roomId } })).resolves.toBeDefined();
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).resolves.toBeDefined();
    await prisma.account.deleteMany({ where: { email: f.accountEmail } });
  });

  it('rejects on Room_createdById_fkey when teacher is deleted before room', async () => {
    const f = await makeFixture();
    await expect(prisma.teacher.delete({ where: { id: f.teacherId } })).rejects.toSatisfy((e: unknown) =>
      isRestrictViolationOn(e, ['Room_createdById_fkey']),
    );

    // The failed delete rolled back, so teacher/room/teacherRoom all still
    // exist — clean up in the order the test above just proved works.
    await prisma.teacherRoom.delete({ where: { id: f.teacherRoomId } });
    await prisma.room.delete({ where: { id: f.roomId } });
    await prisma.teacher.delete({ where: { id: f.teacherId } });
    await prisma.account.deleteMany({ where: { email: f.accountEmail } });
  });
});
