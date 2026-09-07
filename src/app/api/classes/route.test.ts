import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';
import { POST } from './route';

/**
 * @serial-tier lock-contention — holds a transaction open on an uncommitted
 * `DELETE FROM "TeacherRoom"` for ~1s while a second connection's create
 * contends for the same row's `FOR KEY SHARE`, the same shape as
 * `roster-link.test.ts`.
 *
 * Issue 339, PR review. The route's `POST` handler is invoked DIRECTLY here —
 * `NextRequest`/`NextResponse` are plain Web-standard-based classes Next.js
 * exports for exactly this, and `getSessionToken` (`src/lib/auth/session.ts`)
 * reads the session off the request's own cookie jar rather than the
 * request-scoped `cookies()` helper from `next/headers` — so no live Next.js
 * server is needed to exercise this handler's own logic against the real test
 * database. This file exists because the alternative (the integration tier)
 * cannot run in a worktree with no dev server on `:3000` (`BASE_URL`'s own
 * docblock in `tests/helpers.ts` covers the override), and the race below
 * needs to actually run somewhere.
 */
const prisma = new PrismaClient();
const suffix = uniqueSuffix();

describe('POST /api/classes — room deleted between the ownership check and the transaction (#339)', () => {
  let teacherId: string;
  let accountId: string;
  let token: string;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `route-race-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Route', lastName: 'Race', email, bio: 'route race fixture',
        pageSlug: `route-race-${suffix}`, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  /**
   * The same race `tests/integration/classes-api.test.ts` writes over HTTP
   * (unexecuted there — no live app in this worktree), reproduced here as a
   * direct, executable call. A second client holds an uncommitted `DELETE`
   * on the room, so the handler's own unlocked ownership check (`:79`) sees
   * the room and passes, then the handler's transaction parks on its own
   * `FOR KEY SHARE` re-read until the delete commits and the row is gone —
   * discovering `{ ok: false, reason: 'room_not_found' }`, which must answer
   * 400 "Invalid teacher room", not the slot-conflict 409.
   */
  it('answers 400, not a false slot conflict, when the room is deleted while parked on it', async () => {
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Room', address: `${suffix} Race St`, city: 'Testville',
        postcode: '1234RC', floor: '1', roomName: 'Race', maxCapacity: 10, createdById: teacherId,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });

    const holder = new PrismaClient();
    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = holder.$transaction(
      async (tx) => {
        // No class exists on this room yet, so nothing RESTRICTs this delete.
        await tx.$executeRaw`DELETE FROM "TeacherRoom" WHERE id = ${teacherRoom.id}`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );

    const request = new NextRequest('http://localhost:3000/api/classes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({
        teacherRoomId: teacherRoom.id,
        classType: 'Route Race',
        date: '2028-12-13',
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
      }),
    });

    let pending: ReturnType<typeof POST> | undefined;
    try {
      await parked;

      pending = POST(request);

      // Asserted, not assumed: a call that answered without parking would
      // prove nothing about the race.
      let settled = false;
      void pending.then(() => { settled = true; }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
      expect(settled).toBe(false);

      release();
      await holding;
      const res = await pending;

      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('Invalid teacher room');
      // Discriminated from a genuine slot conflict, whose message would be misleading here.
      expect(json.error.message).not.toContain('overlaps that time');
    } finally {
      release();
      await holding.catch(() => {});
      if (pending) await pending.catch(() => undefined);
      await holder.$disconnect();

      await prisma.calendarEntry.deleteMany({ where: { teacherId, classType: 'Route Race' } });
      await prisma.teacherRoom.deleteMany({ where: { id: teacherRoom.id } });
      await prisma.room.deleteMany({ where: { id: room.id } });
    }
  }, 15_000);
});
