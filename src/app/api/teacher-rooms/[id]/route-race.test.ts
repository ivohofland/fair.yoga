/**
 * @serial-tier lock-contention — each case holds an uncommitted delete of a
 * teacher's room link until this route's own write is waiting on it, then
 * commits, so the route's write finds the row gone.
 *
 * The handlers are called directly, as `src/app/api/classes/route.test.ts`
 * does: `getSessionToken` reads the session off the request's own cookie jar,
 * so no Next.js server is involved. PATCH is not here: its service bounds
 * every wait at 2 s, and `room-archive.test.ts` stages the same interleaving
 * without a lock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { DELETE, PUT } from './route';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

/** Resolves once some backend is waiting on a lock `holderPid` holds. */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`nothing waited behind backend ${holderPid} within 1500ms`);
}

/** Deletes `linkId` on its own connection, and commits once `request` waits on it. */
async function behindUncommittedDelete(
  linkId: string,
  request: () => Promise<Response>,
): Promise<Response> {
  const holder = new PrismaClient();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let holding!: Promise<unknown>;
  let holderPid = 0;
  let pending: Promise<Response> | undefined;
  try {
    await new Promise<void>((parked, failed) => {
      holding = holder
        .$transaction(async (tx) => {
          // No class or template is on the link, so nothing RESTRICTs this delete.
          await tx.$executeRaw`DELETE FROM "TeacherRoom" WHERE id = ${linkId}`;
          holderPid = await ownPid(tx);
          parked();
          await released;
        }, { timeout: 20_000 })
        .catch((err: unknown) => { failed(err); throw err; });
    });

    pending = request();
    // Asserted, not assumed: a request that answered without waiting raced nothing.
    await waitUntilBlockedBy(holderPid);

    release();
    await holding;
    return await pending;
  } finally {
    release();
    await Promise.allSettled([holding, pending]);
    await holder.$disconnect();
  }
}

describe('teacher-rooms/[id] on a link deleted while the request waits on it', () => {
  let teacherId: string;
  let accountId: string;
  let token: string;
  let seq = 0;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `link-race-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Link', lastName: 'Race', email, bio: 'teacher-room race fixture',
        pageSlug: `link-race-${suffix}`, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
  });

  afterAll(async () => {
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  async function makeLink(): Promise<string> {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Venue', address: `${suffix} Link Race St`, city: 'Testville',
        postcode: '1234LR', floor: '1', roomName: `Race ${seq++}`, maxCapacity: 10,
        createdById: teacherId, isPublic: false,
      },
    });
    const link = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    return link.id;
  }

  const putLink = (id: string, body: unknown) =>
    PUT(
      new NextRequest(`http://localhost:3000/api/teacher-rooms/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(token) },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );

  const deleteLink = (id: string) =>
    DELETE(
      new NextRequest(`http://localhost:3000/api/teacher-rooms/${id}`, {
        method: 'DELETE',
        headers: cookie(token),
      }),
      { params: Promise.resolve({ id }) },
    );

  it('answers NOT_FOUND when an edit finds the link gone at its write', async () => {
    const linkId = await makeLink();

    const res = await behindUncommittedDelete(linkId, () => putLink(linkId, { rentalRate: 20 }));

    await expectRefusal(res, 'NOT_FOUND');
    expect(await prisma.teacherRoom.count({ where: { id: linkId } })).toBe(0);
  }, 15_000);

  // A double-click on Unlink: both requests pass the read and the blocker
  // count, and this one waits on the other's row lock.
  it('answers NOT_FOUND to the second of two deletes that both passed the read', async () => {
    const linkId = await makeLink();

    const res = await behindUncommittedDelete(linkId, () => deleteLink(linkId));

    await expectRefusal(res, 'NOT_FOUND');
    expect(await prisma.teacherRoom.count({ where: { id: linkId } })).toBe(0);
  }, 15_000);
});
