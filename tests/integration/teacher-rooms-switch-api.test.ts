import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { BASE_URL, cookie, freshIp, uniqueSuffix, seedSession } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const SLUG = `trsw-${suffix}`;

async function makeTeacher(tag: string) {
  const email = `${SLUG}-${tag}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Switch', lastName: tag, email, account: { create: { email } },
      bio: 'Room switch API tests', pageSlug: `${SLUG}-${tag}`,
    },
  });
  return { id: teacher.id, token: await seedSession(prisma, teacher.accountId) };
}

/** A private room + link for `teacherId`, and its shared twin, identity unique to this case. */
async function makePair(teacherId: string, tag: string) {
  const identity = { address: `${tag} ${suffix} Street`, floor: '1', roomName: 'Studio' };
  const priv = await prisma.room.create({
    data: { ...identity, venueName: 'Mine', city: 'Amsterdam', postcode: '1011AB', maxCapacity: 20, createdById: teacherId },
  });
  const link = await prisma.teacherRoom.create({
    data: { teacherId, roomId: priv.id, capacityOverride: 15, rentalRate: new Prisma.Decimal(30) },
  });
  const shared = await prisma.room.create({
    data: { ...identity, venueName: 'Shared', city: 'Amsterdam', postcode: '1011AB', maxCapacity: 24, isPublic: true, createdById: teacherId },
  });
  return { priv, link, shared };
}

const post = (token: string, linkId: string, body: unknown) =>
  fetch(`${BASE_URL}/api/teacher-rooms/${linkId}/switch`, {
    method: 'POST',
    headers: { ...cookie(token), ...freshIp(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let owner: { id: string; token: string };
let other: { id: string; token: string };

beforeAll(async () => {
  owner = await makeTeacher('owner');
  other = await makeTeacher('other');
});

afterAll(async () => {
  const mine = { teacher: { pageSlug: { startsWith: SLUG } } };
  await prisma.calendarEntry.deleteMany({ where: mine });
  await prisma.scheduleRule.deleteMany({ where: mine });
  await prisma.teacherRoom.deleteMany({ where: mine });
  await prisma.room.deleteMany({ where: { createdBy: { pageSlug: { startsWith: SLUG } } } });
  await prisma.teacher.deleteMany({ where: { pageSlug: { startsWith: SLUG } } });
  await prisma.account.deleteMany({ where: { email: { startsWith: SLUG } } });
  await prisma.$disconnect();
});

describe('POST /api/teacher-rooms/[id]/switch', () => {
  it('switches, then answers unchanged on a repeat', async () => {
    const { link, shared } = await makePair(owner.id, 'happy');
    const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() + 14);
    const cls = await createClassFixture(prisma, {
      teacherId: owner.id, teacherRoomId: link.id, classType: 'Hatha', date,
      startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: new Prisma.Decimal(20),
      minRate: new Prisma.Decimal(15), targetRate: new Prisma.Decimal(25),
      minStudents: 2, maxStudents: 10, status: 'open', cancelledAt: null,
    });

    const first = await post(owner.token, link.id, { roomId: shared.id });
    const body = (await expectApplied(first, 200)) as { sharedTeacherRoomId: string; moved: { classes: number } };
    expect(body.moved.classes).toBe(1);
    expect((await prisma.class.findUniqueOrThrow({ where: { id: cls.id } })).teacherRoomId).toBe(body.sharedTeacherRoomId);

    await expectUnchanged(await post(owner.token, link.id, { roomId: shared.id }));
  });

  it('refuses another teacher\'s link with 403', async () => {
    const { link, shared } = await makePair(owner.id, 'forbid');
    const res = await post(other.token, link.id, { roomId: shared.id });
    expect(res.status).toBe(403);
  });

  it('answers 404 NOT_FOUND for a missing link and for a private target', async () => {
    const { link, shared } = await makePair(owner.id, 'nf');
    await expectRefusal(await post(owner.token, crypto.randomUUID(), { roomId: shared.id }), 'NOT_FOUND');
    const { priv: othersPrivate } = await makePair(other.id, 'nf-other');
    await expectRefusal(await post(owner.token, link.id, { roomId: othersPrivate.id }), 'NOT_FOUND');
  });

  // Guard 4 (the link's own room is shared) comes before guard 5 (the target),
  // so any shared target reaches it. The twin itself must be removed first:
  // sharing `priv` would otherwise collide with it on the public identity index.
  it('answers NOW_SHARED when the private room has been shared', async () => {
    const { priv, link, shared } = await makePair(owner.id, 'nowshared');
    const { shared: target } = await makePair(other.id, 'nowshared-other');
    await prisma.room.delete({ where: { id: shared.id } });
    await prisma.room.update({ where: { id: priv.id }, data: { isPublic: true } });
    await expectRefusal(await post(owner.token, link.id, { roomId: target.id }), 'NOW_SHARED');
  });

  it('answers NOT_SAME_ROOM for a shared room with another identity', async () => {
    const { link } = await makePair(owner.id, 'notsame');
    const { shared: unrelated } = await makePair(other.id, 'notsame-other');
    await expectRefusal(await post(owner.token, link.id, { roomId: unrelated.id }), 'NOT_SAME_ROOM');
  });

  it('answers ROOM_IN_USE while a class is in progress', async () => {
    const { link, shared } = await makePair(owner.id, 'running');
    const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() + 15);
    await createClassFixture(prisma, {
      teacherId: owner.id, teacherRoomId: link.id, classType: 'Hatha', date,
      startTime: hhmmToTime('10:00'), durationMinutes: 60, roomCost: new Prisma.Decimal(20),
      minRate: new Prisma.Decimal(15), targetRate: new Prisma.Decimal(25),
      minStudents: 2, maxStudents: 10, status: 'in_progress', cancelledAt: null,
    });
    await expectRefusal(await post(owner.token, link.id, { roomId: shared.id }), 'ROOM_IN_USE');
  });

  it('answers 400 for a body without a uuid roomId', async () => {
    const { link } = await makePair(owner.id, 'badbody');
    expect((await post(owner.token, link.id, { roomId: 'nope' })).status).toBe(400);
  });
});
