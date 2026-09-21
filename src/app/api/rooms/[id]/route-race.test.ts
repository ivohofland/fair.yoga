/**
 * @serial-tier lock-contention — each case holds an uncommitted write on a
 * room row until this route's own statement is waiting on it, then commits,
 * so the route meets the row as that write left it.
 *
 * The handlers are called directly, as `src/app/api/classes/route.test.ts`
 * does: `getSessionToken` reads the session off the request's own cookie jar,
 * so no Next.js server is involved.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';
import { DELETE } from './route';
import { POST as PUBLISH } from './publish/route';

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

/**
 * Runs `write` in a transaction on its own connection, sends `request` once
 * that write is in, and commits only after `request` is waiting on it.
 */
async function behindUncommitted(
  write: (tx: Prisma.TransactionClient) => Promise<unknown>,
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
          await write(tx);
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

describe('rooms/[id] against a write that lands while the request waits on the room', () => {
  let teacherId: string;
  let accountId: string;
  let token: string;
  let seq = 0;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `room-race-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Room', lastName: 'Race', email, bio: 'room race fixture',
        pageSlug: `room-race-${suffix}`, account: { create: { email } },
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

  /** A private room of this teacher's, linked to them, with nothing else on it. */
  async function makeLinkedRoom(): Promise<string> {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Venue', address: `${suffix} Room Race St`, city: 'Testville',
        postcode: '1234RR', floor: '1', roomName: `Race ${seq++}`, maxCapacity: 10,
        createdById: teacherId, isPublic: false,
      },
    });
    await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    return room.id;
  }

  const deleteRoom = (id: string) =>
    DELETE(
      new NextRequest(`http://localhost:3000/api/rooms/${id}`, {
        method: 'DELETE',
        headers: cookie(token),
      }),
      { params: Promise.resolve({ id }) },
    );

  const shareRoom = (id: string) =>
    PUBLISH(
      new NextRequest(`http://localhost:3000/api/rooms/${id}/publish`, {
        method: 'POST',
        headers: cookie(token),
      }),
      { params: Promise.resolve({ id }) },
    );

  // A double-click: both deletes pass the existence read, and this one waits
  // on the other's row locks until that delete commits.
  it('answers NOT_FOUND to the second of two deletes that both passed the read', async () => {
    const roomId = await makeLinkedRoom();

    const res = await behindUncommitted(
      (tx) => tx.$executeRaw`DELETE FROM "Room" WHERE id = ${roomId}`,
      () => deleteRoom(roomId),
    );

    await expectRefusal(res, 'NOT_FOUND');
    expect(await prisma.room.count({ where: { id: roomId } })).toBe(0);
    expect(await prisma.teacherRoom.count({ where: { roomId } })).toBe(0);
  }, 15_000);

  // The share's second site: its guarded write matches no row because a twin
  // share committed first.
  it('answers unchanged to a share whose write finds the room already shared', async () => {
    const roomId = await makeLinkedRoom();

    const res = await behindUncommitted(
      (tx) => tx.$executeRaw`UPDATE "Room" SET "isPublic" = true WHERE id = ${roomId}`,
      () => shareRoom(roomId),
    );

    const data = (await expectUnchanged(res)) as { id: string; isPublic: boolean };
    expect(data).toMatchObject({ id: roomId, isPublic: true });
  }, 15_000);
});
